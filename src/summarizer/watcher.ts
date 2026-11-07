import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DatabaseManager } from '../database/index.js';
import { shouldIgnorePath } from '../config.js';
import { SummarizerPipeline } from './pipeline.js';

export { setupAntiLoopFileWatcher, setupFileWatcher } from '../context/watchers.js';

/**
 * Triggered by the GitStateWatcher after a remote pull/merge is detected.
 * Walks the list of changed file paths, SHA-256 checks each against SQLite,
 * and triggers summarization for any file whose content has changed.
 *
 * Returns the number of files that were actually re-summarized.
 */
export async function triggerGitSyncSummarization(
  changedFilePaths: string[],
  workspaceRoot: string,
  dbManager: DatabaseManager,
  pipeline: SummarizerPipeline,
  outputChannel?: vscode.OutputChannel
): Promise<number> {
  let summarizedCount = 0;

  for (const filePath of changedFilePaths) {
    if (shouldIgnorePath(filePath)) {
      continue;
    }

    try {
      const stats = fs.statSync(filePath);
      if (stats.isDirectory() || stats.size > 1024 * 1024) {
        continue; // skip dirs and large binaries
      }

      const content = fs.readFileSync(filePath, 'utf8');

      // SHA-256 guard: only re-summarize if content actually changed
      const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      const existing = dbManager.getFileSummary(filePath);
      if (existing && existing.hash === contentHash) {
        continue; // unchanged
      }

      const relativePath = path.relative(workspaceRoot, filePath);
      await pipeline.summarizeContent(filePath, relativePath, content);
      summarizedCount++;

      outputChannel?.appendLine(
        `[ReMem Sync Watcher] Auto-summarized remote change: ${relativePath}`
      );
    } catch {
      // Binary or unreadable – skip silently
      continue;
    }
  }

  return summarizedCount;
}
