import * as fs from 'fs';
import * as path from 'path';
import { publishAtomic, fileVersion, withAsyncFileLock } from '../core/files.js';
import { StorageWorkerClient } from './storageWorkerClient.js';
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
  private version: string | undefined;

  private readonly shutdown = new AbortController();
  private worker?: StorageWorkerClient;
  private applying = false;
  private idle: Promise<void> = Promise.resolve();
  private jobs: { mutation: VectorMutation; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }[] = [];
  private draining = false;
  private reads: Promise<unknown> = Promise.resolve();
  private reader?: VectorSearchEngine;
  private damaged = false;

  private async write<T>(method: VectorMutation['method'], args: unknown[], action: () => Promise<T>): Promise<T> {
    if (this.applying) return action();
    this.shutdown.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let result: T;
      this.jobs.push({ mutation: { method, args }, run: async () => { result = await action(); }, resolve: () => resolve(result), reject });
      if (!this.draining) {
        this.draining = true;
        this.idle = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drainWrites());
      }
    });
  }

  private async drainWrites(): Promise<void> {
    try {
      while (this.jobs.length) {
        const jobs = this.jobs.splice(0, 32);
        try {
          await withAsyncFileLock(this.indexPath, async (assertOwner) => {
            let serialized: string | Buffer;
            if (this.worker) {
              const bytes = await this.worker.call<Uint8Array>('applyVectorBatch', [jobs.map((job) => job.mutation)]);
              serialized = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            } else {
              await this.reload();
              for (const job of jobs) {
                this.shutdown.signal.throwIfAborted();
                await job.run();
              }
              serialized = await this.serialize();
            }
            await publishAtomic(this.indexPath, serialized, async () => {
              this.shutdown.signal.throwIfAborted();
              await assertOwner();
            });
            this.version = fileVersion(this.indexPath);
            await this.worker?.call('acceptVectorSnapshot', [this.version]);
          }, this.shutdown.signal);
          for (const job of jobs) job.resolve();
        } catch (error) {
          this.version = undefined;
          for (const job of jobs) job.reject(error);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.draining = false;
    }
  }

  private read<T>(action: (index: VectorSearchEngine) => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    const reader = this.reader ??= new VectorSearchEngine(this.indexPath);
    const result = this.reads.then(async () => {
      this.shutdown.signal.throwIfAborted();
      await reader.reload();
      return action(reader);
    });
    this.reads = result.catch(() => {});
    return result;
  }

  private fileIdMap: Map<string, string> = new Map(); // filePath -> orama internal ID
  private chunkIdMap: Map<string, string> = new Map(); // chunkId -> orama internal ID
  private fileChunksMap: Map<string, Set<string>> = new Map(); // filePath -> Set<chunkId>

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  /**
   * Initializes the Orama search database and restores index from disk if present.
   */
  public async initialize(root?: string): Promise<void> {
    if (root && fs.existsSync(path.join(__dirname, 'storage-worker.js'))) {
      this.worker = new StorageWorkerClient({ kind: 'vector', file: this.indexPath, root });
      this.damaged = await this.worker.call<boolean>('initializeVector');
    } else {
      this.damaged = await this.read(async (index) => index.damaged);
    }
  }

  public get needsRebuild(): boolean {
    return this.damaged;
  }

  public async applyVectorBatch(mutations: VectorMutation[]): Promise<string> {
    await this.reload();
    // Invalidate until the host confirms publication.
    this.version = undefined;
    this.applying = true;
    try {
      for (const { method, args } of mutations) {
        const mutate = this[method] as (...parameters: any[]) => Promise<void>;
        await mutate.apply(this, args);
      }
      return this.serialize();
    } finally {
      this.applying = false;
    }
  }

  public acceptVectorSnapshot(version: string): void {
    this.version = version;
  }

  private async reload(): Promise<void> {
    const version = fileVersion(this.indexPath);
    if (this.orama && version === this.version) return;
    this.fileIdMap.clear();
    this.chunkIdMap.clear();
    this.fileChunksMap.clear();
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

    this.damaged = !version;
    if (version) {
      try {
        const raw = await fs.promises.readFile(this.indexPath, 'utf8');
        const parsed = JSON.parse(raw);
        const { oramaData, fileIdMap = {}, chunkIdMap = {}, fileChunksMap = {} } = parsed ?? {};
        const isMap = (value: unknown): value is Record<string, unknown> =>
          Boolean(value && typeof value === 'object' && !Array.isArray(value));
        if (!isMap(oramaData) || ![fileIdMap, chunkIdMap].every((map) =>
            isMap(map) && Object.values(map).every((id) => typeof id === 'string')) ||
            !isMap(fileChunksMap) || !Object.values(fileChunksMap).every((ids) =>
              Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
          throw new Error('Invalid Orama snapshot');
        }
        await load(this.orama, oramaData);
        this.fileIdMap = new Map(Object.entries(fileIdMap));
        this.chunkIdMap = new Map(Object.entries(chunkIdMap));
        this.fileChunksMap = new Map(
          Object.entries(fileChunksMap).map(([key, ids]) => [key, new Set(ids as string[])])
        );
      } catch (err) {
        this.damaged = true;
        this.orama = await create({ schema });
        this.fileIdMap.clear();
        this.chunkIdMap.clear();
        this.fileChunksMap.clear();
        console.error('[Cuttlehawk Vector] Failed to restore index, starting fresh:', err);
      }
    }
    this.version = version;
  }

  /**
   * Inserts or updates a file summary in the vector/text index.
   */
  public async indexSummary(doc: OramaSummaryDoc, onlyIfMissing = false): Promise<void> {
    return this.write('indexSummary', [doc, onlyIfMissing], async () => {
      if (!onlyIfMissing || !this.fileIdMap.has(doc.filePath)) await this.indexSummaryInIndex(doc);
    });
  }

  public async finishRecovery(): Promise<void> {
    if (this.damaged && this.version === undefined) await this.write('finishRecovery', [], async () => {});
    this.damaged = false;
  }

  private async indexSummaryInIndex(doc: { filePath: string; relativePath: string; summary: string }): Promise<void> {
    if (!this.orama) {
      throw new Error('Vector index is not initialized.');
    }

    // Bulletproof Secret Shield: Never index ignored or sensitive secret files
    if (SecretShield.getInstance().isIgnored(doc.filePath)) {
      return;
    }

    const { insert } = await getOramaModule();

    // Remove previous version if indexed
    await this.removeSummaryFromIndex(doc.filePath);

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
    return this.write('removeSummary', [filePath], () => this.removeSummaryFromIndex(filePath));
  }

  private async removeSummaryFromIndex(filePath: string): Promise<void> {
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
    return this.write('indexChunk', [chunk], () => this.indexChunkInIndex(chunk));
  }

  private async indexChunkInIndex(chunk: ASTChunk): Promise<void> {
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
  public async replaceFile(
    filePath: string,
    summary: { filePath: string; relativePath: string; summary: string } | undefined,
    chunks: ASTChunk[],
  ): Promise<void> {
    await this.write('replaceFile', [filePath, summary, chunks], async () => {
      await this.removeChunksForFileInIndex(filePath);
      await this.indexChunksInIndex(chunks);
      if (summary) await this.indexSummaryInIndex(summary);
      else await this.removeSummaryFromIndex(filePath);
    });
  }

  public async hasSummary(filePath: string): Promise<boolean> {
    if (this.worker) return this.worker.call<boolean>('hasSummary', [filePath]);
    return this.read(async (index) => index.fileIdMap.has(filePath));
  }

  public async indexChunks(chunks: ASTChunk[]): Promise<void> {
    return this.write('indexChunks', [chunks], () => this.indexChunksInIndex(chunks));
  }

  private async indexChunksInIndex(chunks: ASTChunk[]): Promise<void> {
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
    return this.write('removeChunksForFile', [filePath], () => this.removeChunksForFileInIndex(filePath));
  }

  private async removeChunksForFileInIndex(filePath: string): Promise<void> {
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
    if (this.worker) return this.worker.call<SearchHitResult[]>('searchSummaries', [term, limit]);
    return this.read((index) => index.searchSummariesInIndex(term, limit));
  }

  private async searchSummariesInIndex(term: string, limit: number = 5): Promise<SearchHitResult[]> {
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
    if (this.worker) return this.worker.call<ASTChunkSearchResult[]>('searchChunks', [term, limit]);
    return this.read((index) => index.searchChunksInIndex(term, limit));
  }

  private async searchChunksInIndex(term: string, limit: number = 5): Promise<ASTChunkSearchResult[]> {
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
  public async getChunkIdsForFile(filePath: string): Promise<string[]> {
    if (this.worker) return this.worker.call<string[]>('getChunkIdsForFile', [filePath]);
    return this.read(async (index) => Array.from(index.fileChunksMap.get(filePath) ?? []));
  }

  /**
   * Returns total number of indexed entries (file summaries + AST chunks).
   */
  public async getCount(): Promise<number> {
    if (this.worker) return this.worker.call<number>('getCount', []);
    return this.read((index) => index.getCountInIndex());
  }

  private async getCountInIndex(): Promise<number> {
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
    // Mutations persist before releasing the file lock.
  }

  private async serialize(): Promise<string> {
    if (!this.orama) throw new Error('Vector index is not initialized');

    const { save } = await getOramaModule();
    const oramaData = await save(this.orama);
    return JSON.stringify({
      oramaData,
      fileIdMap: Object.fromEntries(this.fileIdMap.entries()),
      chunkIdMap: Object.fromEntries(this.chunkIdMap.entries()),
      fileChunksMap: Object.fromEntries(
        Array.from(this.fileChunksMap.entries()).map(([k, set]) => [k, Array.from(set)])
      ),
      savedAt: Date.now(),
    });

  }

  /**
   * Closes and saves the index.
   */
  public async close(): Promise<void> {
    this.shutdown.abort();
    await this.worker?.close();
    await this.idle;
    this.reader = undefined;
  }
}

type VectorMutation = {
  method: 'finishRecovery' | 'indexSummary' | 'removeSummary' | 'indexChunk' | 'replaceFile' | 'indexChunks' | 'removeChunksForFile';
  args: unknown[];
};
