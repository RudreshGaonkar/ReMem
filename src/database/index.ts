import * as path from 'path';
import { CONFIG, getDbFilePath, getMemoryDirPath } from '../config.js';
import { ErrorLedgerEntry, FileSummary } from '../types/index.js';
import { SqliteLedger } from './sqlite.js';
import { SearchHitResult, VectorSearchEngine } from './vector.js';

export { SqliteLedger } from './sqlite.js';
export { SearchHitResult, VectorSearchEngine } from './vector.js';

/**
 * Unified DatabaseManager orchestrating SQLite relational ledger and Orama search index.
 */
export class DatabaseManager {
  private sqliteLedger: SqliteLedger | null = null;
  private vectorEngine: VectorSearchEngine | null = null;
  private workspaceRoot: string = '';
  private isInitialized: boolean = false;

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

    // Initialize SQLite (re-opens existing DB if file is present on disk)
    this.sqliteLedger = new SqliteLedger(dbPath);
    await this.sqliteLedger.initialize();

    // Verify the on-disk schema is complete and up-to-date
    this.sqliteLedger.verifyAndRepairSchema();

    // Initialize Vector / Orama engine (restores from disk snapshot if present)
    this.vectorEngine = new VectorSearchEngine(vectorIndexPath);
    await this.vectorEngine.initialize();

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

    const summaries = this.sqliteLedger.getAllFileSummaries();
    let rehydrated = 0;

    for (const summary of summaries) {
      if (!summary.isEncrypted) {
        await this.vectorEngine.indexSummary({
          filePath: summary.filePath,
          relativePath: summary.relativePath,
          summary: summary.summary,
        });
        rehydrated++;
      }
    }

    if (rehydrated > 0) {
      await this.vectorEngine.saveToDisk();
    }

    return rehydrated;
  }

  /**
   * Checks the SQLite schema for expected tables.  If any required table is
   * missing, SqliteLedger.verifyAndRepairSchema() will have already re-created
   * it.  Returns `true` when schema is fully intact.
   */
  public verifySchemaIntegrity(): boolean {
    if (!this.sqliteLedger) {
      return false;
    }
    return this.sqliteLedger.isSchemaIntact();
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
  public async saveFileSummary(summary: FileSummary): Promise<void> {
    this.sqlite.saveFileSummary(summary);

    if (!summary.isEncrypted) {
      await this.vector.indexSummary({
        filePath: summary.filePath,
        relativePath: summary.relativePath,
        summary: summary.summary,
      });
    } else {
      // If encrypted, remove from plain vector search index
      await this.vector.removeSummary(summary.filePath);
    }
  }

  /**
   * Retrieves a file summary from the relational store.
   */
  public getFileSummary(filePath: string): FileSummary | null {
    return this.sqlite.getFileSummary(filePath);
  }

  /**
   * Removes a file summary from both SQLite and vector search.
   */
  public async deleteFileSummary(filePath: string): Promise<void> {
    this.sqlite.deleteFileSummary(filePath);
    await this.vector.removeSummary(filePath);
  }

  /**
   * Performs semantic / full-text search across indexed summaries.
   */
  public async searchSummaries(term: string, limit: number = 5): Promise<SearchHitResult[]> {
    return this.vector.searchSummaries(term, limit);
  }

  // ─── Error ledger ──────────────────────────────────────────────────────────

  /**
   * Adds an error / post-mortem note to the branch ledger.
   */
  public addErrorNote(entry: ErrorLedgerEntry): number {
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

  // ─── Stats & persistence ───────────────────────────────────────────────────

  /**
   * Returns current statistics across both databases.
   */
  public async getStats(): Promise<{
    fileSummariesCount: number;
    errorNotesCount: number;
    vectorIndexedCount: number;
  }> {
    return {
      fileSummariesCount: this.sqliteLedger ? this.sqliteLedger.getFileSummariesCount() : 0,
      errorNotesCount: this.sqliteLedger ? this.sqliteLedger.getErrorNotesCount() : 0,
      vectorIndexedCount: this.vectorEngine ? await this.vectorEngine.getCount() : 0,
    };
  }

  /**
   * Synchronously flushes both SQLite and Orama data to disk.
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
    if (this.sqliteLedger) {
      this.sqliteLedger.close();
      this.sqliteLedger = null;
    }
    if (this.vectorEngine) {
      await this.vectorEngine.close();
      this.vectorEngine = null;
    }
    this.isInitialized = false;
  }
}
