import * as fs from 'fs';
import * as path from 'path';
import type { LeanTraceabilityTracker } from '../task/traceability.js';
import { refreshIndexedFile, workspaceFiles } from './workspaceIndex.js';
import { DatabaseManager } from '../database/index.js';
import { SummarizerPipeline } from './pipeline.js';
import { shouldIgnorePath } from '../config.js';

export interface IndexingResult {
  totalFilesFound: number;
  indexedCount: number;
  skippedCount: number;
}

/**
 * Scans the workspace in the background and indexes all unindexed or modified files.
 */
export async function indexWorkspace(
  workspaceRoot: string,
  dbManager: DatabaseManager,
  pipeline: SummarizerPipeline,
  outputChannel?: { appendLine(message: string): void },
  tracker?: LeanTraceabilityTracker,
  signal?: AbortSignal,
): Promise<IndexingResult> {
  outputChannel?.appendLine(`[Cuttlehawk Indexer] Starting initial workspace scan for: ${workspaceRoot}`);

  let totalFilesFound = 0;
  let indexedCount = 0;
  let skippedCount = 0;
  const batch: string[] = [];
  async function flushBatch(): Promise<void> {
    await Promise.all(batch.splice(0).map(async (file) => {
      try {
        if (await refreshIndexedFile(dbManager, pipeline, file, tracker, signal)) indexedCount++;
        else skippedCount++;
      } catch (error) {
        signal?.throwIfAborted();
        skippedCount++;
        outputChannel?.appendLine(`[Cuttlehawk Indexer] Could not index ${file}: ${error}`);
      }
    }));
  }
  for await (const file of workspaceFiles(workspaceRoot, signal)) {
    totalFilesFound++;
    batch.push(file);
    if (batch.length === 16) await flushBatch();
    if (totalFilesFound >= 2000) break;
  }
  await flushBatch();

  // Flush to disk after bulk indexing
  await dbManager.flushToDisk();

  outputChannel?.appendLine(
    `[Cuttlehawk Indexer] Workspace indexing completed. Scanned: ${totalFilesFound}, Newly Indexed/Updated: ${indexedCount}, Unchanged (Cached): ${skippedCount}`
  );

  return {
    totalFilesFound: totalFilesFound,
    indexedCount,
    skippedCount,
  };
}

/**
 * Builds a fast, serialized tree structure of the workspace.
 */
export function generateDirectoryTree(workspaceRoot: string, maxDepth: number = 4): string {
  function scan(dir: string, depth: number): string[] {
    if (depth > maxDepth) return [];
    const entries: string[] = [];

    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (shouldIgnorePath(fullPath)) continue;

        const indent = '  '.repeat(depth);
        if (item.isDirectory()) {
          entries.push(`${indent}📁 ${item.name}/`);
          entries.push(...scan(fullPath, depth + 1));
        } else {
          entries.push(`${indent}📄 ${item.name}`);
        }
      }
    } catch {
      // Ignore unreadable dirs
    }

    return entries;
  }

  return scan(workspaceRoot, 0).join('\n');
}
