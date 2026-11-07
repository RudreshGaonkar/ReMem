import * as fs from 'fs';
import * as path from 'path';
import { ASTChunk } from '../types/index.js';
import { SecretShield } from '../core/ignore.js';

export const ORAMA_BATCH_SIZE = 500;
export const MAX_RAM_BUDGET_BYTES = 100 * 1024 * 1024; // 100MB RAM Expansion limit

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

export interface ASTChunkSearchResult {
  id: string;
  score: number;
  document: {
    chunkId: string;
    filePath: string;
    relativePath: string;
    name: string;
    kind: string;
    signature: string;
    summary: string;
    content: string;
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
 * Supports both high-level file summaries and granular AST code chunks.
 */
export class VectorSearchEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private orama: any = null;
  private indexPath: string;
  private fileIdMap: Map<string, string> = new Map(); // filePath -> orama internal ID
  private chunkIdMap: Map<string, string> = new Map(); // chunkId -> orama internal ID
  private fileChunksMap: Map<string, Set<string>> = new Map(); // filePath -> Set<chunkId>

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
      chunkId: 'string',
      name: 'string',
      kind: 'string',
      signature: 'string',
      summary: 'string',
      content: 'string',
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
          if (parsed.chunkIdMap) {
            this.chunkIdMap = new Map(Object.entries(parsed.chunkIdMap));
          }
          if (parsed.fileChunksMap) {
            this.fileChunksMap = new Map(
              Object.entries(parsed.fileChunksMap).map(([k, v]) => [k, new Set(v as string[])])
            );
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

    // Bulletproof Secret Shield: Never index ignored or sensitive secret files
    if (SecretShield.getInstance().isIgnored(doc.filePath)) {
      return;
    }

    const { insert } = await getOramaModule();

    // Remove previous version if indexed
    await this.removeSummary(doc.filePath);

    const id = await insert(this.orama, {
      filePath: doc.filePath,
      relativePath: doc.relativePath,
      chunkId: `file:${doc.filePath}`,
      name: path.basename(doc.filePath),
      kind: 'file',
      signature: path.basename(doc.filePath),
      summary: doc.summary,
      content: doc.summary,
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
   * Inserts or updates an individual AST chunk (function, interface, class) in Orama.
   */
  public async indexChunk(chunk: ASTChunk): Promise<void> {
    if (!this.orama) {
      throw new Error('Vector index is not initialized.');
    }

    // Bulletproof Secret Shield: Never index chunks from ignored or sensitive secret files
    if (SecretShield.getInstance().isIgnored(chunk.filePath)) {
      return;
    }

    const { insert, remove } = await getOramaModule();

    // Remove old chunk instance if already mapped
    const existingInternalId = this.chunkIdMap.get(chunk.id);
    if (existingInternalId) {
      try {
        await remove(this.orama, existingInternalId);
      } catch {
        // ignore
      }
      this.chunkIdMap.delete(chunk.id);
    }

    const id = await insert(this.orama, {
      filePath: chunk.filePath,
      relativePath: chunk.relativePath,
      chunkId: chunk.id,
      name: chunk.name,
      kind: chunk.kind,
      signature: chunk.signature || chunk.name,
      summary: `${chunk.kind} ${chunk.name}: ${chunk.signature}`,
      content: chunk.content,
    });

    this.chunkIdMap.set(chunk.id, id);

    if (!this.fileChunksMap.has(chunk.filePath)) {
      this.fileChunksMap.set(chunk.filePath, new Set());
    }
    this.fileChunksMap.get(chunk.filePath)!.add(chunk.id);
  }

  /**
   * Indexes multiple AST chunks in batch using @orama/orama insertMultiple
   * tuned for high throughput with up to 100MB RAM budget.
   */
  public async indexChunks(chunks: ASTChunk[]): Promise<void> {
    if (!this.orama || chunks.length === 0) {
      return;
    }

    // Filter out ignored / sensitive files before indexing
    const validChunks = chunks.filter((c) => !SecretShield.getInstance().isIgnored(c.filePath));
    if (validChunks.length === 0) {
      return;
    }

    const { insertMultiple, remove } = await getOramaModule();

    // Remove old chunk mappings
    for (const chunk of validChunks) {
      const existingInternalId = this.chunkIdMap.get(chunk.id);
      if (existingInternalId) {
        try {
          await remove(this.orama, existingInternalId);
        } catch {
          // ignore
        }
        this.chunkIdMap.delete(chunk.id);
      }
    }

    // Batch insert up to ORAMA_BATCH_SIZE (500 chunks) per batch
    for (let i = 0; i < validChunks.length; i += ORAMA_BATCH_SIZE) {
      const batch = validChunks.slice(i, i + ORAMA_BATCH_SIZE);
      const docs = batch.map((chunk) => ({
        filePath: chunk.filePath,
        relativePath: chunk.relativePath,
        chunkId: chunk.id,
        name: chunk.name,
        kind: chunk.kind,
        signature: chunk.signature || chunk.name,
        summary: `${chunk.kind} ${chunk.name}: ${chunk.signature}`,
        content: chunk.content,
      }));

      const ids: string[] = await insertMultiple(this.orama, docs);
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const id = ids[j];
        if (id) {
          this.chunkIdMap.set(chunk.id, id);
          if (!this.fileChunksMap.has(chunk.filePath)) {
            this.fileChunksMap.set(chunk.filePath, new Set());
          }
          this.fileChunksMap.get(chunk.filePath)!.add(chunk.id);
        }
      }
    }
  }

  /**
   * Removes all AST chunks associated with a specific file.
   */
  public async removeChunksForFile(filePath: string): Promise<void> {
    if (!this.orama) {
      return;
    }

    const chunkIds = this.fileChunksMap.get(filePath);
    if (!chunkIds) {
      return;
    }

    const { remove } = await getOramaModule();
    for (const chunkId of chunkIds) {
      const internalId = this.chunkIdMap.get(chunkId);
      if (internalId) {
        try {
          await remove(this.orama, internalId);
        } catch {
          // ignore
        }
        this.chunkIdMap.delete(chunkId);
      }
    }

    this.fileChunksMap.delete(filePath);
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
      where: {
        kind: 'file',
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return searchResults.hits.map((hit: any) => ({
      id: hit.id,
      score: hit.score,
      document: {
        filePath: hit.document.filePath,
        relativePath: hit.document.relativePath,
        summary: hit.document.summary,
      },
    }));
  }

  /**
   * Searches AST chunks (functions, classes, interfaces) matching a query term.
   */
  public async searchChunks(term: string, limit: number = 5): Promise<ASTChunkSearchResult[]> {
    if (!this.orama) {
      return [];
    }

    const { search } = await getOramaModule();

    const searchResults = await search(this.orama, {
      term,
      limit,
      properties: ['name', 'signature', 'summary', 'content', 'relativePath'],
      threshold: 0.2,
    });

    // Filter out top-level file summary docs to return actual AST chunks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return searchResults.hits
      .filter((hit: any) => hit.document.kind !== 'file')
      .map((hit: any) => ({
        id: hit.id,
        score: hit.score,
        document: {
          chunkId: hit.document.chunkId,
          filePath: hit.document.filePath,
          relativePath: hit.document.relativePath,
          name: hit.document.name,
          kind: hit.document.kind,
          signature: hit.document.signature,
          summary: hit.document.summary,
          content: hit.document.content,
        },
      }));
  }

  /**
   * Returns all chunk IDs currently tracked for a file.
   */
  public getChunkIdsForFile(filePath: string): string[] {
    const set = this.fileChunksMap.get(filePath);
    return set ? Array.from(set) : [];
  }

  /**
   * Returns total number of indexed entries (file summaries + AST chunks).
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
      chunkIdMap: Object.fromEntries(this.chunkIdMap.entries()),
      fileChunksMap: Object.fromEntries(
        Array.from(this.fileChunksMap.entries()).map(([k, set]) => [k, Array.from(set)])
      ),
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
    this.chunkIdMap.clear();
    this.fileChunksMap.clear();
  }
}
