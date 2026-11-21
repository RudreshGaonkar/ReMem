import * as path from 'path';
import { isWorkspacePath } from '../core/files.js';
import { SecretShield } from '../core/ignore.js';
import { CONFIG, getDbFilePath, getMemoryDirPath } from '../config.js';
import { ASTChunk, ErrorLedgerEntry, FileSummary } from '../types/index.js';
import { SqliteLedger } from './sqlite.js';
import { ASTChunkSearchResult, SearchHitResult, VectorSearchEngine } from './vector.js';

export { SqliteLedger } from './sqlite.js';
export { ASTChunkSearchResult, SearchHitResult, VectorSearchEngine } from './vector.js';

/**
 * Unified DatabaseManager orchestrating SQLite relational ledger and Orama search index.
 */
export class DatabaseManager {
  private sqliteLedger: SqliteLedger | null = null;
  private vectorEngine: VectorSearchEngine | null = null;
  private workspaceRoot: string = '';
  private isInitialized: boolean = false;
  private closed = false;

  /**
   * Initializes both the SQLite and Vector database instances inside .antigravityMem/.
   *
   * Session recovery behaviour:
   *  • If `remem_ledger.sqlite` already exists on disk it is loaded as-is so all
   *    previously indexed summaries survive an IDE restart.
   *  • If `orama_index.json` already exists on disk the Orama vector index is
   *    re-hydrated from the persisted snapshot (handled inside VectorSearchEngine.initialize).
   *  • Schema integrity is verified via verifySchemaIntegrity() after load.
   */
  public async initialize(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    const memDir = getMemoryDirPath(workspaceRoot);
    const dbPath = getDbFilePath(workspaceRoot);
    const vectorIndexPath = path.join(memDir, CONFIG.VECTOR_INDEX_FILE_NAME);
    if (![dbPath, vectorIndexPath].every((file) => isWorkspacePath(workspaceRoot, file))) {
      throw new Error('Unsafe workspace database path.');
    }
    SecretShield.getInstance(workspaceRoot);

    // Initialize SQLite (re-opens existing DB if file is present on disk)
    this.sqliteLedger = new SqliteLedger(dbPath);
    await this.sqliteLedger.initialize();
    if (this.closed) throw new Error('Database manager is closed');

    // Initialize Vector / Orama engine (restores from disk snapshot if present)
    this.vectorEngine = new VectorSearchEngine(vectorIndexPath);
    await this.vectorEngine.initialize(workspaceRoot);
    if (this.closed) throw new Error('Database manager is closed');

    this.isInitialized = true;
  }

  // ─── Session recovery ──────────────────────────────────────────────────────

  /**
   * Re-hydrates the Orama vector index from the persisted SQLite summaries.
   *
   * Useful when the Orama JSON snapshot is corrupted or missing but SQLite is
   * intact.  Iterates all stored file summaries and re-inserts them into a
   * freshly created Orama instance.
   */
  public async rehydrateVectorIndexFromSqlite(): Promise<number> {
    if (!this.sqliteLedger || !this.vectorEngine) {
      return 0;
    }

    const summaries = await this.sqliteLedger.query('getAllFileSummaries');
    let rehydrated = 0;

    for (let offset = 0; offset < summaries.length; offset += 32) {
      const batch = summaries.slice(offset, offset + 32).filter((summary) => !summary.isEncrypted);
      await Promise.all(batch.map((summary) => this.vectorEngine!.indexSummary(summary, true)));
      rehydrated += batch.length;
    }

    return rehydrated;
  }

  /**
   * Checks the SQLite schema for expected tables.  If any required table is
   * missing, SqliteLedger.verifyAndRepairSchema() will have already re-created
   * it.  Returns `true` when schema is fully intact.
   */
  public async verifySchemaIntegrity(): Promise<boolean> {
    if (!this.sqliteLedger) {
      return false;
    }
    return this.sqliteLedger.query('isSchemaIntact');
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  public get isReady(): boolean {
    return this.isInitialized;
  }

  public get rootPath(): string {
    return this.workspaceRoot;
  }

  public get sqlite(): SqliteLedger {
    if (!this.sqliteLedger) {
      throw new Error('DatabaseManager is not initialized.');
    }
    return this.sqliteLedger;
  }

  public get vector(): VectorSearchEngine {
    if (!this.vectorEngine) {
      throw new Error('DatabaseManager is not initialized.');
    }
    return this.vectorEngine;
  }

  // ─── File summaries ────────────────────────────────────────────────────────

  /**
   * Stores a file summary in SQLite and updates the vector search index simultaneously.
   */
  public async saveFileSummary(summary: FileSummary, chunks: ASTChunk[] = []): Promise<void> {
    await this.vector.replaceFile(summary.filePath, summary.isEncrypted ? undefined : summary, chunks);
    await this.sqlite.saveFileSummary(summary);
  }

  /**
   * Retrieves a file summary from the relational store.
   */
  public getFileSummary(filePath: string): FileSummary | null {
    return this.sqlite.getFileSummary(filePath);
  }

  /**
   * Removes a file summary from both SQLite and vector search, clearing chunks and dependencies.
   */
  public async deleteFileSummary(filePath: string): Promise<void> {
    await this.vector.replaceFile(filePath, undefined, []);
    await this.sqlite.deleteFileSummary(filePath);
  }

  /**
   * Performs semantic / full-text search across indexed summaries.
   */
  public async searchSummaries(term: string, limit: number = 5): Promise<SearchHitResult[]> {
    return this.vector.searchSummaries(term, limit);
  }

  /**
   * Performs semantic search across indexed AST chunks (functions, interfaces, classes).
   */
  public async searchChunks(term: string, limit: number = 5): Promise<ASTChunkSearchResult[]> {
    return this.vector.searchChunks(term, limit);
  }

  /**
   * Indexes a single AST chunk into Orama.
   */
  public async indexChunk(chunk: ASTChunk): Promise<void> {
    await this.vector.indexChunk(chunk);
  }

  // ─── Error ledger ──────────────────────────────────────────────────────────

  /**
   * Adds an error / post-mortem note to the branch ledger.
   */
  public addErrorNote(entry: ErrorLedgerEntry): Promise<number> {
    return this.sqlite.addErrorNote(entry);
  }

  /**
   * Gets error notes for a specific file.
   */
  public getErrorNotesForFile(filePath: string): ErrorLedgerEntry[] {
    return this.sqlite.getErrorNotesForFile(filePath);
  }

  /**
   * Gets error notes for a specific git branch.
   */
  public getErrorNotesForBranch(branch: string): ErrorLedgerEntry[] {
    return this.sqlite.getErrorNotesForBranch(branch);
  }

  /**
   * Retrieves all recorded file dependencies across the workspace from SQLite.
   */
  public getAllDependencies(): { sourceFile: string; importedFile: string; importStatement?: string }[] {
    return this.sqliteLedger ? this.sqliteLedger.getAllDependencies() : [];
  }

  /**
   * Retrieves all recorded file exports across the workspace from SQLite.
   */
  public getAllExports(): { filePath: string; symbol: string; kind?: string }[] {
    return this.sqliteLedger ? this.sqliteLedger.getAllExports() : [];
  }

  // ─── Universal Session State (Cross-Model Resume) ──────────────────────────

  /**
   * Persists the active session state and plan progress to SQLite.
   */
  public async saveSessionState(state: {
    activeTask?: string;
    completedTasks?: string[];
    pendingTasks?: string[];
    lastPlanSnapshot: string;
    activeFilePath?: string;
    timestamp?: number;
  }): Promise<void> {
    if (this.sqliteLedger) {
      await this.sqliteLedger.saveSessionState(state);
    }
  }

  /**
   * Retrieves the current session state from SQLite.
   */
  public getCurrentSessionState(): {
    activeTask?: string;
    completedTasks: string[];
    pendingTasks: string[];
    lastPlanSnapshot: string;
    activeFilePath?: string;
    timestamp: number;
  } | null {
    return this.sqliteLedger ? this.sqliteLedger.getCurrentSessionState() : null;
  }

  /**
   * Clears the persisted session state from SQLite.
   */
  public async clearSessionState(): Promise<void> {
    if (this.sqliteLedger) {
      await this.sqliteLedger.clearSessionState();
    }
  }

  // ─── Stats & persistence ───────────────────────────────────────────────────

  /**
   * Returns current statistics across both databases.
   */
  public async getStats(): Promise<{
    fileSummariesCount: number;
    errorNotesCount: number;
    vectorIndexedCount: number;
  }> {
    const [fileSummariesCount, errorNotesCount, vectorIndexedCount] = await Promise.all([
      this.sqliteLedger?.query('getFileSummariesCount') ?? 0,
      this.sqliteLedger?.query('getErrorNotesCount') ?? 0,
      this.vectorEngine?.getCount() ?? 0,
    ]);
    return { fileSummariesCount, errorNotesCount, vectorIndexedCount };
  }

  /**
   * Retains the existing explicit flush API. Mutations already persist under their locks.
   */
  public async flushToDisk(): Promise<void> {
    if (this.sqliteLedger) {
      this.sqliteLedger.exportDatabaseToDisk();
    }
    if (this.vectorEngine) {
      await this.vectorEngine.saveToDisk();
    }
  }

  /**
   * Closes database instances and persists everything to disk.
   */
  public async close(): Promise<void> {
    this.closed = true;
    this.isInitialized = false;
    const sqlite = this.sqliteLedger;
    const vector = this.vectorEngine;
    this.sqliteLedger = null;
    this.vectorEngine = null;
    await Promise.all([sqlite?.close(), vector?.close()]);
  }
}
