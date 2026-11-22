import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { publishAtomic, fileVersion, withAsyncFileLock } from '../core/files.js';
import { StorageWorkerClient } from './storageWorkerClient.js';
import { ErrorLedgerEntry, FileSummary } from '../types/index.js';

/**
 * Manages the SQLite database for relational and ledger state via sql.js (WASM).
 */
export class SqliteLedger {
  private database: Database | null = null;
  private version = '';
  private writing = false;

  private get db(): Database | null {
    if (!this.writing && this.SQL) this.reload();
    return this.database;
  }

  private reload(): void {
    let version = fileVersion(this.dbFilePath);
    if (this.database && this.version === version) return;
    let bytes: Buffer | undefined;
    if (version) {
      try {
        bytes = fs.readFileSync(this.dbFilePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        version = '';
      }
    }
    const next = new this.SQL!.Database(bytes);
    this.database?.close();
    this.database = next;
    this.version = version;
    if (!version) this.createSchema(next);
  }

  private readonly shutdown = new AbortController();
  private worker?: StorageWorkerClient;
  private jobs: { mutation: SqliteMutation; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  private draining = false;
  private idle: Promise<void> = Promise.resolve();

  private async write<T>(method: SqliteMutation['method'], args: unknown[], action: () => T): Promise<T> {
    if (this.writing) return action();
    this.shutdown.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ mutation: { method, args }, resolve: (value) => resolve(value as T), reject });
      if (!this.draining) {
        this.draining = true;
        this.idle = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drainWrites());
      }
    });
  }

  private async drainWrites(): Promise<void> {
    try {
      while (this.jobs.length) {
        const jobs = this.jobs.splice(0, 64);
        try {
          const values = await withAsyncFileLock(this.dbFilePath, async (assertOwner) => {
            const mutations = jobs.map((job) => job.mutation);
            const result = this.worker
              ? await this.worker.call<SqliteBatchResult>('applyBatch', [mutations])
              : await new SqliteLedger(this.dbFilePath, true).applyBatch(mutations);
            const bytes = result.bytes!;
            const snapshot = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const beforePublish = async () => {
              this.shutdown.signal.throwIfAborted();
              await assertOwner();
            };
            if (result.damaged) {
              // Keep the original in place until the replacement is ready.
              const damaged = await fs.promises.readFile(this.dbFilePath);
              await publishAtomic(this.dbFilePath + '.corrupted-' + randomUUID() + '.bak', damaged, beforePublish);
              console.error('[Cuttlehawk SQLite] Recovered a damaged ledger at', this.dbFilePath);
            }
            await publishAtomic(this.dbFilePath, snapshot, beforePublish);
            try {
              await publishAtomic(this.dbFilePath + '.bak', snapshot, beforePublish);
            } catch (error) {
              if (!this.shutdown.signal.aborted) console.error('[Cuttlehawk SQLite] Could not update the recovery copy:', error);
            }
            return result.values;
          }, this.shutdown.signal);
          jobs.forEach((job, index) => job.resolve(values[index]));
        } catch (error) {
          for (const job of jobs) job.reject(error);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.draining = false;
    }
  }

  /** Runs inside the storage worker. The caller holds the publication lock. */
  public async applyBatch(mutations: SqliteMutation[]): Promise<SqliteBatchResult> {
    const read = (file: string) => fs.promises.readFile(file).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const bytes = await read(this.dbFilePath);
    const result = await this.computeBatch(mutations, bytes);
    return result.bytes ? result : this.computeBatch(mutations, bytes, await read(this.dbFilePath + '.bak') ?? Buffer.alloc(0));
  }

  private async computeBatch(mutations: SqliteMutation[], bytes?: Uint8Array, backup?: Uint8Array): Promise<SqliteBatchResult> {
    await this.initializeWasm();
    let damaged = false;
    let database: Database | undefined;
    try {
      if (bytes) {
        try {
          if (!bytes.length) throw new Error('Empty SQLite snapshot');
          database = new this.SQL!.Database(bytes);
          this.validate(database);
        } catch (error) {
          if (!/not a database|malformed|integrity check|disk image|empty sqlite/i.test(String(error))) throw error;
          database?.close();
          database = undefined;
          damaged = true;
          if (backup === undefined) return { values: [], damaged };
          if (backup.length) {
            try {
              database = new this.SQL!.Database(backup);
              this.validate(database);
            } catch {
              database?.close();
              database = undefined;
            }
          }
        }
      }
      this.database = database ?? new this.SQL!.Database();
      this.writing = true;
      if (!database || damaged) this.createSchema(this.database);
      const values: unknown[] = [];
      for (const { method, args } of mutations) {
        const mutate = this[method] as (...parameters: any[]) => Promise<unknown>;
        values.push(await mutate.apply(this, args));
      }
      return { bytes: this.database.export(), values, damaged };
    } finally {
      this.writing = false;
      this.database?.close();
      this.database = null;
    }
  }

  public async query<K extends SqliteQuery>(method: K, ...args: Parameters<SqliteLedger[K]>): Promise<ReturnType<SqliteLedger[K]>> {
    this.shutdown.signal.throwIfAborted();
    if (this.worker) return this.worker.call<ReturnType<SqliteLedger[K]>>('querySqlite', [method, args]);
    await this.initializeWasm();
    const read = this[method] as (...parameters: Parameters<SqliteLedger[K]>) => ReturnType<SqliteLedger[K]>;
    return read.apply(this, args);
  }

  private validate(database: Database): void {
    const result = database.exec('PRAGMA quick_check(1)');
    if (result[0]?.values[0]?.[0] !== 'ok') throw new Error('SQLite integrity check failed');
  }

  private SQL: SqlJsStatic | null = null;
  private dbFilePath: string;

  constructor(dbFilePath: string, private readonly inWorker = false) {
    this.dbFilePath = dbFilePath;
  }

  /**
   * Initializes the SQL.js WASM runtime and opens or creates the SQLite database.
   */
  public async initialize(): Promise<void> {
    await this.initializeWasm();
    this.shutdown.signal.throwIfAborted();
    if (!this.inWorker && fs.existsSync(path.join(__dirname, 'storage-worker.js'))) {
      this.worker = new StorageWorkerClient({ kind: 'sqlite', file: this.dbFilePath });
    }
    const intact = this.worker ? await this.worker.call<boolean>('inspectSqlite') : await this.inspectSnapshot();
    if (!intact) await this.verifyAndRepairSchema();
  }

  public async inspectSnapshot(): Promise<boolean> {
    if (!fileVersion(this.dbFilePath)) return false;
    await this.initializeWasm();
    try {
      const db = this.db;
      if (!db || !this.version || !this.isSchemaIntact()) return false;
      this.validate(db);
      return db.exec('PRAGMA table_info(file_summaries)')[0]?.values.some((column) => column[1] === 'isEncrypted') ?? false;
    } catch {
      return false;
    }
  }

  private async initializeWasm(): Promise<void> {
    if (this.SQL) return;
    const init = (initSqlJs as unknown as { default?: typeof initSqlJs }).default || initSqlJs;
    // `locateFile` tells sql.js where to find sql-wasm.wasm at runtime.
    // esbuild copies the file to out/sql-wasm.wasm alongside out/extension.js.
    this.SQL = await init({
      locateFile: (file: string) => path.join(__dirname, file),
    });
  }

  /**
   * Creates required tables if they don't already exist.
   */
  private createSchema(db: Database): void {

    // Table: File Summaries
    db.run(`
      CREATE TABLE IF NOT EXISTS file_summaries (
        filePath TEXT PRIMARY KEY,
        relativePath TEXT NOT NULL,
        summary TEXT NOT NULL,
        hash TEXT NOT NULL,
        lastModified INTEGER NOT NULL,
        tokenCountEstimate INTEGER NOT NULL,
        isEncrypted INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Table: Git Branch & Rollback Error Ledger
    db.run(`
      CREATE TABLE IF NOT EXISTS error_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT NOT NULL,
        commitHash TEXT,
        filePath TEXT,
        postMortemNote TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Table: Lean Traceability File Dependencies
    db.run(`
      CREATE TABLE IF NOT EXISTS file_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceFile TEXT NOT NULL,
        importedFile TEXT NOT NULL,
        importStatement TEXT,
        timestamp INTEGER NOT NULL,
        UNIQUE(sourceFile, importedFile)
      );
      CREATE INDEX IF NOT EXISTS idx_dep_imported ON file_dependencies(importedFile);
      CREATE INDEX IF NOT EXISTS idx_dep_source ON file_dependencies(sourceFile);
    `);

    // Table: File Exports
    db.run(`
      CREATE TABLE IF NOT EXISTS file_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filePath TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT,
        timestamp INTEGER NOT NULL,
        UNIQUE(filePath, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_exp_file ON file_exports(filePath);
    `);

    // Table: Universal Session State (Cross-Model Resume)
    db.run(`
      CREATE TABLE IF NOT EXISTS current_session_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        activeTask TEXT,
        completedTasks TEXT,
        pendingTasks TEXT,
        lastPlanSnapshot TEXT,
        activeFilePath TEXT,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  /**
   * Public alias: ensures all required tables exist and adds any missing columns
   * introduced in later schema versions.  Safe to call on every startup.
   */
  public async verifyAndRepairSchema(): Promise<void> {
    return this.write('verifyAndRepairSchema', [], () => {
      // Re-run CREATE TABLE IF NOT EXISTS for all tables
      this.createSchema(this.database!);

      // Guard: add `isEncrypted` column if loading a very old DB that predates it
      if (this.db) {
        try {
          this.db.run(`ALTER TABLE file_summaries ADD COLUMN isEncrypted INTEGER NOT NULL DEFAULT 0`);
        } catch {
          // Column already exists – ignore the error
        }
      }
    });
  }

  /**
   * Returns `true` when required tables are present in the loaded database.
   */
  public isSchemaIntact(): boolean {
    const db = this.db;
    if (!db) {
      return false;
    }
    try {
      const res = db.exec(`
        SELECT COUNT(*) as c FROM sqlite_master
        WHERE type='table' AND name IN ('file_summaries', 'error_ledger', 'file_dependencies', 'file_exports', 'current_session_state')
      `);
      const count = Number(res?.[0]?.values?.[0]?.[0] ?? 0);
      return count === 5;
    } catch {
      return false;
    }
  }

  /**
   * Saves or updates a file summary in SQLite.
   */
  public async saveFileSummary(summary: FileSummary): Promise<void> {
    return this.write('saveFileSummary', [summary], () => {
      if (!this.db) {
        throw new Error('Database is not initialized.');
      }

      const query = `
        INSERT INTO file_summaries (filePath, relativePath, summary, hash, lastModified, tokenCountEstimate, isEncrypted)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filePath) DO UPDATE SET
          relativePath = excluded.relativePath,
          summary = excluded.summary,
          hash = excluded.hash,
          lastModified = excluded.lastModified,
          tokenCountEstimate = excluded.tokenCountEstimate,
          isEncrypted = excluded.isEncrypted;
      `;

      this.db.run(query, [
        summary.filePath,
        summary.relativePath,
        summary.summary,
        summary.hash,
        summary.lastModified,
        summary.tokenCountEstimate,
        summary.isEncrypted ? 1 : 0,
      ]);
    });
  }

  /**
   * Retrieves a file summary by full file path.
   */
  public getFileSummary(filePath: string): FileSummary | null {
    const db = this.db;
    if (!db) {
      throw new Error('Database is not initialized.');
    }

    const stmt = db.prepare(`SELECT * FROM file_summaries WHERE filePath = ?`);
    stmt.bind([filePath]);

    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return {
        filePath: row.filePath as string,
        relativePath: row.relativePath as string,
        summary: row.summary as string,
        hash: row.hash as string,
        lastModified: Number(row.lastModified),
        tokenCountEstimate: Number(row.tokenCountEstimate),
        isEncrypted: Boolean(row.isEncrypted),
      };
    }

    stmt.free();
    return null;
  }

  /**
   * Returns all stored file summaries.
   */
  public getAllFileSummaries(): FileSummary[] {
    const db = this.db;
    if (!db) {
      throw new Error('Database is not initialized.');
    }

    const results: FileSummary[] = [];
    const stmt = db.prepare(`SELECT * FROM file_summaries`);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        filePath: row.filePath as string,
        relativePath: row.relativePath as string,
        summary: row.summary as string,
        hash: row.hash as string,
        lastModified: Number(row.lastModified),
        tokenCountEstimate: Number(row.tokenCountEstimate),
        isEncrypted: Boolean(row.isEncrypted),
      });
    }

    stmt.free();
    return results;
  }

  /**
   * Deletes a file summary from the database.
   */
  public async deleteFileSummary(filePath: string): Promise<void> {
    return this.write('deleteFileSummary', [filePath], () => {
      if (!this.db) {
        throw new Error('Database is not initialized.');
      }

      this.db.run(`DELETE FROM file_summaries WHERE filePath = ?`, [filePath]);
      this.clearDependencyRows(filePath);
    });
  }

  /**
   * Counts the total number of indexed file summaries.
   */
  public getFileSummariesCount(): number {
    const db = this.db;
    if (!db) {
      return 0;
    }

    const res = db.exec(`SELECT COUNT(*) as count FROM file_summaries`);
    if (res.length > 0 && res[0].values.length > 0) {
      return Number(res[0].values[0][0]);
    }
    return 0;
  }

  /**
   * Adds a post-mortem error note to the ledger.
   */
  public async addErrorNote(entry: ErrorLedgerEntry): Promise<number> {
    return this.write('addErrorNote', [entry], () => {
      if (!this.db) {
        throw new Error('Database is not initialized.');
      }

      const query = `
        INSERT INTO error_ledger (branch, commitHash, filePath, postMortemNote, timestamp, resolved)
        VALUES (?, ?, ?, ?, ?, ?);
      `;

      this.db.run(query, [
        entry.branch,
        entry.commitHash || null,
        entry.filePath || null,
        entry.postMortemNote,
        entry.timestamp || Date.now(),
        entry.resolved ? 1 : 0,
      ]);

      const res = this.db.exec(`SELECT last_insert_rowid() as id`);
      return Number(res[0].values[0][0]);
    });
  }

  /**
   * Retrieves error notes associated with a specific file path.
   */
  public getErrorNotesForFile(filePath: string): ErrorLedgerEntry[] {
    const db = this.db;
    if (!db) {
      throw new Error('Database is not initialized.');
    }

    const results: ErrorLedgerEntry[] = [];
    const stmt = db.prepare(`
      SELECT * FROM error_ledger
      WHERE filePath = ? OR filePath IS NULL
      ORDER BY timestamp DESC
    `);
    stmt.bind([filePath]);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: Number(row.id),
        branch: row.branch as string,
        commitHash: row.commitHash as string | undefined,
        filePath: row.filePath as string | undefined,
        postMortemNote: row.postMortemNote as string,
        timestamp: Number(row.timestamp),
        resolved: Boolean(row.resolved),
      });
    }

    stmt.free();
    return results;
  }

  /**
   * Retrieves error notes associated with a specific branch.
   */
  public getErrorNotesForBranch(branch: string): ErrorLedgerEntry[] {
    const db = this.db;
    if (!db) {
      throw new Error('Database is not initialized.');
    }

    const results: ErrorLedgerEntry[] = [];
    const stmt = db.prepare(`
      SELECT * FROM error_ledger
      WHERE branch = ?
      ORDER BY timestamp DESC
    `);
    stmt.bind([branch]);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: Number(row.id),
        branch: row.branch as string,
        commitHash: row.commitHash as string | undefined,
        filePath: row.filePath as string | undefined,
        postMortemNote: row.postMortemNote as string,
        timestamp: Number(row.timestamp),
        resolved: Boolean(row.resolved),
      });
    }

    stmt.free();
    return results;
  }

  /**
   * Counts the total number of ledger entries.
   */
  public getErrorNotesCount(): number {
    const db = this.db;
    if (!db) {
      return 0;
    }

    const res = db.exec(`SELECT COUNT(*) as count FROM error_ledger`);
    if (res.length > 0 && res[0].values.length > 0) {
      return Number(res[0].values[0][0]);
    }
    return 0;
  }

  // ─── Lean Traceability Dependency & Export Ledger ────────────────────────

  public async recordFileGraph(
    filePath: string,
    dependencies: { importedFile: string; importStatement?: string }[],
    exports: string[],
  ): Promise<void> {
    return this.write('recordFileGraph', [filePath, dependencies, exports], () => {
      const db = this.database!;
      db.run('DELETE FROM file_dependencies WHERE sourceFile = ?', [filePath]);
      db.run('DELETE FROM file_exports WHERE filePath = ?', [filePath]);
      const dependency = db.prepare(`
        INSERT OR REPLACE INTO file_dependencies (sourceFile, importedFile, importStatement, timestamp)
        VALUES (?, ?, ?, ?)
      `);
      const exported = db.prepare(`
        INSERT OR REPLACE INTO file_exports (filePath, symbol, timestamp)
        VALUES (?, ?, ?)
      `);
      const now = Date.now();
      try {
        for (const entry of dependencies) {
          dependency.run([filePath, entry.importedFile, entry.importStatement ?? null, now]);
        }
        for (const symbol of exports) exported.run([filePath, symbol, now]);
      } finally {
        dependency.free();
        exported.free();
      }
    });
  }

  /**
   * Returns all source files that depend on (import) the target file path.
   */
  public getDependentsForFile(targetFilePath: string): string[] {
    const db = this.db;
    if (!db) {
      return [];
    }

    const dependents: string[] = [];
    const stmt = db.prepare(`
      SELECT DISTINCT sourceFile FROM file_dependencies WHERE importedFile = ?
    `);
    stmt.bind([targetFilePath]);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      dependents.push(row.sourceFile as string);
    }
    stmt.free();
    return dependents;
  }

  /**
   * Returns all files imported by the source file.
   */
  public getDependenciesForFile(sourceFile: string): string[] {
    const db = this.db;
    if (!db) {
      return [];
    }

    const imports: string[] = [];
    const stmt = db.prepare(`
      SELECT DISTINCT importedFile FROM file_dependencies WHERE sourceFile = ?
    `);
    stmt.bind([sourceFile]);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      imports.push(row.importedFile as string);
    }
    stmt.free();
    return imports;
  }

  /**
   * Returns all exported symbols for a file from the SQLite ledger.
   */
  public getExportsForFile(filePath: string): string[] {
    const db = this.db;
    if (!db) {
      return [];
    }

    const symbols: string[] = [];
    const stmt = db.prepare(`
      SELECT symbol FROM file_exports WHERE filePath = ?
    `);
    stmt.bind([filePath]);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      symbols.push(row.symbol as string);
    }
    stmt.free();
    return symbols;
  }

  /**
   * Returns all recorded dependencies across the workspace.
   */
  public getAllDependencies(): { sourceFile: string; importedFile: string; importStatement?: string }[] {
    const db = this.db;
    if (!db) {
      return [];
    }

    const dependencies: { sourceFile: string; importedFile: string; importStatement?: string }[] = [];
    const stmt = db.prepare(`
      SELECT sourceFile, importedFile, importStatement FROM file_dependencies ORDER BY sourceFile ASC
    `);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      dependencies.push({
        sourceFile: row.sourceFile as string,
        importedFile: row.importedFile as string,
        importStatement: (row.importStatement as string) || undefined,
      });
    }
    stmt.free();
    return dependencies;
  }

  /**
   * Returns all recorded exported symbols across the workspace.
   */
  public getAllExports(): { filePath: string; symbol: string; kind?: string }[] {
    const db = this.db;
    if (!db) {
      return [];
    }

    const exports: { filePath: string; symbol: string; kind?: string }[] = [];
    const stmt = db.prepare(`
      SELECT filePath, symbol, kind FROM file_exports ORDER BY filePath ASC
    `);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      exports.push({
        filePath: row.filePath as string,
        symbol: row.symbol as string,
        kind: (row.kind as string) || undefined,
      });
    }
    stmt.free();
    return exports;
  }

  /**
   * Clears dependency records for a file (e.g. when deleted).
   */
  public async clearDependenciesForFile(filePath: string): Promise<void> {
    return this.write('clearDependenciesForFile', [filePath], () => this.clearDependencyRows(filePath));
  }

  private clearDependencyRows(filePath: string): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM file_dependencies WHERE sourceFile = ?`, [filePath]);
    this.db.run(`DELETE FROM file_exports WHERE filePath = ?`, [filePath]);
  }

  /**
   * Persists the current session state into SQLite for cross-model resumption.
   */
  public async saveSessionState(state: {
    activeTask?: string;
    completedTasks?: string[];
    pendingTasks?: string[];
    lastPlanSnapshot: string;
    activeFilePath?: string;
    timestamp?: number;
  }, overwriteSameTimestamp = true): Promise<void> {
    return this.write('saveSessionState', [state, overwriteSameTimestamp], () => {
      if (!this.db) {
        throw new Error('Database is not initialized.');
      }

      const now = state.timestamp || Date.now();
      const completedJson = JSON.stringify(state.completedTasks || []);
      const pendingJson = JSON.stringify(state.pendingTasks || []);

      const stmt = this.db.prepare(`
        INSERT INTO current_session_state (id, activeTask, completedTasks, pendingTasks, lastPlanSnapshot, activeFilePath, timestamp)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          activeTask = excluded.activeTask,
          completedTasks = excluded.completedTasks,
          pendingTasks = excluded.pendingTasks,
          lastPlanSnapshot = excluded.lastPlanSnapshot,
          activeFilePath = excluded.activeFilePath,
          timestamp = excluded.timestamp
        WHERE excluded.timestamp > current_session_state.timestamp
          OR (? AND excluded.timestamp = current_session_state.timestamp)
      `);

      stmt.run([
        state.activeTask || null,
        completedJson,
        pendingJson,
        state.lastPlanSnapshot,
        state.activeFilePath || null,
        now,
        Number(overwriteSameTimestamp),
      ]);
      stmt.free();
    });
  }

  /**
   * Retrieves the latest persisted session state from SQLite.
   */
  public getCurrentSessionState(): {
    activeTask?: string;
    completedTasks: string[];
    pendingTasks: string[];
    lastPlanSnapshot: string;
    activeFilePath?: string;
    timestamp: number;
  } | null {
    if (!this.db) {
      return null;
    }

    const stmt = this.db.prepare(`
      SELECT activeTask, completedTasks, pendingTasks, lastPlanSnapshot, activeFilePath, timestamp
      FROM current_session_state WHERE id = 1
    `);

    if (stmt.step()) {
      const row = stmt.getAsObject();
      let completedTasks: string[] = [];
      let pendingTasks: string[] = [];

      try {
        completedTasks = JSON.parse((row.completedTasks as string) || '[]');
      } catch {
        completedTasks = [];
      }

      try {
        pendingTasks = JSON.parse((row.pendingTasks as string) || '[]');
      } catch {
        pendingTasks = [];
      }

      const result = {
        activeTask: (row.activeTask as string) || undefined,
        completedTasks,
        pendingTasks,
        lastPlanSnapshot: (row.lastPlanSnapshot as string) || '',
        activeFilePath: (row.activeFilePath as string) || undefined,
        timestamp: Number(row.timestamp) || Date.now(),
      };
      stmt.free();
      return result;
    }

    stmt.free();
    return null;
  }

  /**
   * Clears the current session state.
   */
  public async clearSessionState(): Promise<void> {
    return this.write('clearSessionState', [], () => {
      if (!this.db) {
        return;
      }
      this.db.run(`DELETE FROM current_session_state WHERE id = 1`);
    });
  }

  /**
   * Exports the in-memory SQLite database binary to the disk file in .antigravityMem/.
   */
  public exportDatabaseToDisk(): void {
    // Writes already persist before releasing the file lock.
  }

  public async close(): Promise<void> {
    this.shutdown.abort();
    await this.worker?.close();
    await this.idle;
    this.database?.close();
    this.database = null;
    this.SQL = null;
  }
}

type SqliteMutation = {
  method: 'verifyAndRepairSchema' | 'saveFileSummary' | 'deleteFileSummary' | 'addErrorNote' |
    'recordFileGraph' | 'clearDependenciesForFile' | 'saveSessionState' | 'clearSessionState';
  args: unknown[];
};

type SqliteBatchResult = { bytes?: Uint8Array; values: unknown[]; damaged: boolean };

type SqliteQuery = 'getFileSummary' | 'getCurrentSessionState' | 'getAllFileSummaries' |
  'getAllDependencies' | 'getAllExports' | 'getDependenciesForFile' | 'getDependentsForFile' |
  'getExportsForFile' | 'getErrorNotesForFile' | 'getErrorNotesForBranch' |
  'getFileSummariesCount' | 'getErrorNotesCount' | 'isSchemaIntact';
