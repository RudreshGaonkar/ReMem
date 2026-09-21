import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { ErrorLedgerEntry, FileSummary } from '../types/index.js';

/**
 * Manages the SQLite database for relational and ledger state via sql.js (WASM).
 */
export class SqliteLedger {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private dbFilePath: string;

  constructor(dbFilePath: string) {
    this.dbFilePath = dbFilePath;
  }

  /**
   * Initializes the SQL.js WASM runtime and opens or creates the SQLite database.
   */
  public async initialize(): Promise<void> {
    const init = (initSqlJs as unknown as { default?: typeof initSqlJs }).default || initSqlJs;
    this.SQL = await init();

    if (fs.existsSync(this.dbFilePath)) {
      const fileBuffer = fs.readFileSync(this.dbFilePath);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      const dir = path.dirname(this.dbFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new this.SQL.Database();
      this.createSchema();
      this.exportDatabaseToDisk();
    }

    this.createSchema();
  }

  /**
   * Creates required tables if they don't already exist.
   */
  private createSchema(): void {
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }

    // Table: File Summaries
    this.db.run(`
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
    this.db.run(`
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
  }

  /**
   * Saves or updates a file summary in SQLite.
   */
  public saveFileSummary(summary: FileSummary): void {
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
  }

  /**
   * Retrieves a file summary by full file path.
   */
  public getFileSummary(filePath: string): FileSummary | null {
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }

    const stmt = this.db.prepare(`SELECT * FROM file_summaries WHERE filePath = ?`);
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
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }

    const results: FileSummary[] = [];
    const stmt = this.db.prepare(`SELECT * FROM file_summaries`);

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
  public deleteFileSummary(filePath: string): void {
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }

    this.db.run(`DELETE FROM file_summaries WHERE filePath = ?`, [filePath]);
  }

  /**
   * Counts the total number of indexed file summaries.
   */
  public getFileSummariesCount(): number {
    if (!this.db) {
      return 0;
    }

    const res = this.db.exec(`SELECT COUNT(*) as count FROM file_summaries`);
    if (res.length > 0 && res[0].values.length > 0) {
      return Number(res[0].values[0][0]);
    }
    return 0;
  }

  /**
   * Adds a post-mortem error note to the ledger.
   */
  public addErrorNote(entry: ErrorLedgerEntry): number {
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
  }

  /**
   * Retrieves error notes associated with a specific file path.
   */
  public getErrorNotesForFile(filePath: string): ErrorLedgerEntry[] {
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }

    const results: ErrorLedgerEntry[] = [];
    const stmt = this.db.prepare(`
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
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }

    const results: ErrorLedgerEntry[] = [];
    const stmt = this.db.prepare(`
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
    if (!this.db) {
      return 0;
    }

    const res = this.db.exec(`SELECT COUNT(*) as count FROM error_ledger`);
    if (res.length > 0 && res[0].values.length > 0) {
      return Number(res[0].values[0][0]);
    }
    return 0;
  }

  /**
   * Exports the in-memory SQLite database binary to the disk file in .antigravityMem/.
   */
  public exportDatabaseToDisk(): void {
    if (!this.db) {
      return;
    }

    const data = this.db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(this.dbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbFilePath, buffer);
  }

  /**
   * Closes the database handle after ensuring everything is flushed to disk.
   */
  public close(): void {
    if (this.db) {
      this.exportDatabaseToDisk();
      this.db.close();
      this.db = null;
    }
  }
}
