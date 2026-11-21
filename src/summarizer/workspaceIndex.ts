import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getMemoryDirPath, shouldIgnorePath } from '../config.js';
import { isWorkspacePath, readWorkspaceText, withAsyncFileLock } from '../core/files.js';
import { DatabaseManager } from '../database/index.js';
import { LeanTraceabilityTracker } from '../task/traceability.js';
import { computeFileHash } from './hasher.js';
import { SummarizerPipeline } from './pipeline.js';

export async function* workspaceFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const deadline = performance.now() + 30_000;
  let directories = 0;
  let entries = 0;
  async function* walk(directory: string, depth: number): AsyncGenerator<string> {
    if (depth > 40 || ++directories > 4096) return;
    const handle = await fs.promises.opendir(directory).catch((error) => {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return undefined;
      throw error;
    });
    if (!handle) return;
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (++entries > 50_000 || performance.now() >= deadline) return;
      if (entries % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const file = path.join(directory, entry.name);
      if (shouldIgnorePath(file + (entry.isDirectory() ? path.sep : ''))) continue;
      if (entry.isDirectory()) yield* walk(file, depth + 1);
      if (entry.isFile()) yield file;
    }
  }
  yield* walk(root, 0);
}

export async function refreshIndexedFile(
  db: DatabaseManager,
  pipeline: SummarizerPipeline,
  file: string,
  tracker?: LeanTraceabilityTracker,
  signal?: AbortSignal,
): Promise<boolean> {
  const root = db.rootPath;
  if (!isWorkspacePath(root, file) || shouldIgnorePath(file)) return false;
  const fileKey = createHash('sha256').update(file).digest('hex');
  return withAsyncFileLock(path.join(getMemoryDirPath(root), 'files', fileKey), async () => {
    let content: string | undefined;
    try {
      content = await readWorkspaceText(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    signal?.throwIfAborted();
    const existing = await db.sqlite.query('getFileSummary', file);
    if (content === undefined) {
      tracker?.forgetFile(file);
      if (existing) await db.deleteFileSummary(file);
      return false;
    }
    if (existing?.hash === computeFileHash(content) && (existing.isEncrypted || await db.vector.hasSummary(file))) {
      return false;
    }
    await tracker?.processSavedFile(file, content);
    signal?.throwIfAborted();
    await pipeline.summarizeContent(file, path.relative(root, file), content, signal);
    return true;
  }, signal);
}
