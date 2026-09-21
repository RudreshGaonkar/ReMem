import * as fs from 'fs';
import * as path from 'path';

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

// Holds dynamically loaded Orama module functions (compatible with CommonJS runtime)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oramaModule: any = null;

async function getOramaModule() {
  if (!oramaModule) {
    oramaModule = await import('@orama/orama');
  }
  return oramaModule;
}

/**
 * Manages local embedded semantic and full-text search using @orama/orama.
 */
export class VectorSearchEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private orama: any = null;
  private indexPath: string;
  private fileIdMap: Map<string, string> = new Map(); // filePath -> orama internal ID

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  /**
   * Initializes the Orama search database and restores index from disk if present.
   */
  public async initialize(): Promise<void> {
    const { create, load } = await getOramaModule();

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

    const { insert } = await getOramaModule();

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

    const { remove } = await getOramaModule();
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

    const { search } = await getOramaModule();

    const searchResults = await search(this.orama, {
      term,
      limit,
      properties: ['summary', 'relativePath', 'filePath'],
      threshold: 0.2,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return searchResults.hits.map((hit: any) => ({
      id: hit.id,
      score: hit.score,
      document: hit.document as {
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
    const { count } = await getOramaModule();
    return count(this.orama);
  }

  /**
   * Persists the in-memory Orama index to disk in .antigravityMem/.
   */
  public async saveToDisk(): Promise<void> {
    if (!this.orama) {
      return;
    }

    const { save } = await getOramaModule();
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
