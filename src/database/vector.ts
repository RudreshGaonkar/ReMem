import * as fs from 'fs';
import * as path from 'path';
import {
  create,
  insert,
  search,
  remove,
  save,
  load,
  count,
  AnyOrama,
} from '@orama/orama';

export interface OramaSummaryDoc {
  id?: string;
  filePath: string;
  relativePath: string;
  summary: string;
}

export interface SearchHitResult {
  id: string;
  score: number;
  document: {
    filePath: string;
    relativePath: string;
    summary: string;
  };
}

/**
 * Manages local embedded semantic and full-text search using @orama/orama.
 */
export class VectorSearchEngine {
  private orama: AnyOrama | null = null;
  private indexPath: string;
  private fileIdMap: Map<string, string> = new Map(); // filePath -> orama internal ID

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  /**
   * Initializes the Orama search database and restores index from disk if present.
   */
  public async initialize(): Promise<void> {
    const schema = {
      filePath: 'string',
      relativePath: 'string',
      summary: 'string',
    } as const;

    this.orama = await create({ schema });

    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = fs.readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.oramaData) {
          await load(this.orama, parsed.oramaData);
          if (parsed.fileIdMap) {
            this.fileIdMap = new Map(Object.entries(parsed.fileIdMap));
          }
        }
      } catch (err) {
        // Corrupted index file, start fresh
        console.error('[ReMem Vector] Failed to restore index, starting fresh:', err);
      }
    }
  }

  /**
   * Inserts or updates a file summary in the vector/text index.
   */
  public async indexSummary(doc: { filePath: string; relativePath: string; summary: string }): Promise<void> {
    if (!this.orama) {
      throw new Error('Vector index is not initialized.');
    }

    // Remove previous version if indexed
    await this.removeSummary(doc.filePath);

    const id = await insert(this.orama, {
      filePath: doc.filePath,
      relativePath: doc.relativePath,
      summary: doc.summary,
    });

    this.fileIdMap.set(doc.filePath, id);
  }

  /**
   * Removes a file summary from the search index.
   */
  public async removeSummary(filePath: string): Promise<void> {
    if (!this.orama) {
      return;
    }

    const existingId = this.fileIdMap.get(filePath);
    if (existingId) {
      try {
        await remove(this.orama, existingId);
      } catch {
        // Doc might not exist, ignore
      }
      this.fileIdMap.delete(filePath);
    }
  }

  /**
   * Searches indexed summaries matching a query string.
   */
  public async searchSummaries(term: string, limit: number = 5): Promise<SearchHitResult[]> {
    if (!this.orama) {
      return [];
    }

    const searchResults = await search(this.orama, {
      term,
      limit,
      properties: ['summary', 'relativePath', 'filePath'],
      threshold: 0.2,
    });

    return searchResults.hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      document: hit.document as unknown as {
        filePath: string;
        relativePath: string;
        summary: string;
      },
    }));
  }

  /**
   * Returns total number of indexed summaries.
   */
  public async getCount(): Promise<number> {
    if (!this.orama) {
      return 0;
    }
    return count(this.orama);
  }

  /**
   * Persists the in-memory Orama index to disk in .antigravityMem/.
   */
  public async saveToDisk(): Promise<void> {
    if (!this.orama) {
      return;
    }

    const oramaData = await save(this.orama);
    const serialized = JSON.stringify({
      oramaData,
      fileIdMap: Object.fromEntries(this.fileIdMap.entries()),
      savedAt: Date.now(),
    });

    const dir = path.dirname(this.indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.indexPath, serialized, 'utf8');
  }

  /**
   * Closes and saves the index.
   */
  public async close(): Promise<void> {
    await this.saveToDisk();
    this.orama = null;
    this.fileIdMap.clear();
  }
}
