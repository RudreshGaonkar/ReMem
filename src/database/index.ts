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
   */
  public async initialize(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    const memDir = getMemoryDirPath(workspaceRoot);
    const dbPath = getDbFilePath(workspaceRoot);
    const vectorIndexPath = path.join(memDir, CONFIG.VECTOR_INDEX_FILE_NAME);

    // Initialize SQLite
    this.sqliteLedger = new SqliteLedger(dbPath);
    await this.sqliteLedger.initialize();

    // Initialize Vector / Orama engine
    this.vectorEngine = new VectorSearchEngine(vectorIndexPath);
    await this.vectorEngine.initialize();

    this.isInitialized = true;
  }

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
