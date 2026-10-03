import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DatabaseManager } from '../database/index.js';
import { shouldIgnorePath } from '../config.js';
import { computeFileHash } from './hasher.js';
import { SummarizerPipeline } from './pipeline.js';

/**
 * Sets up document save, delete, and rename watchers to automatically keep summaries updated.
 */
export function setupFileWatcher(
  context: vscode.ExtensionContext,
  dbManager: DatabaseManager,
  pipeline: SummarizerPipeline,
  outputChannel?: vscode.OutputChannel
): void {
  // 1. Watch for file saves
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
    // Check if auto summarization is enabled in settings
    const isEnabled = vscode.workspace.getConfiguration('remem').get<boolean>('enableAutoSummarize', true);
    if (!isEnabled) {
      return;
    }

    const filePath = document.uri.fsPath;

    // Ignore unsupported schemes (e.g. git, output, debug)
    if (document.uri.scheme !== 'file') {
      return;
    }

    // Ignore internal / cache / build directories
    if (shouldIgnorePath(filePath)) {
      return;
    }

    try {
      const content = document.getText();
      const currentHash = computeFileHash(content);

      // Check existing hash in SQLite
      const existing = dbManager.getFileSummary(filePath);
      if (existing && existing.hash === currentHash) {
        outputChannel?.appendLine(
          `[ReMem Watcher] Content hash unchanged for ${vscode.workspace.asRelativePath(document.uri)}. Skipping summarization.`
        );
        return;
      }

      // Content changed or new file: summarize
      outputChannel?.appendLine(
        `[ReMem Watcher] Content changed in ${vscode.workspace.asRelativePath(document.uri)}. Updating summary...`
      );
      const summary = await pipeline.summarizeDocument(document);
      if (summary) {
        outputChannel?.appendLine(
          `[ReMem Watcher] Summary updated for ${summary.relativePath}: "${summary.summary}"`
        );
      }
    } catch (err) {
      outputChannel?.appendLine(`[ReMem Watcher Error] Failed to process ${filePath}: ${err}`);
    }
  });

  // 2. Watch for file deletions
  const deleteListener = vscode.workspace.onDidDeleteFiles(async (event: vscode.FileDeleteEvent) => {
    for (const fileUri of event.files) {
      const filePath = fileUri.fsPath;
      try {
        await dbManager.deleteFileSummary(filePath);
        outputChannel?.appendLine(
          `[ReMem Watcher] Removed deleted file from memory index: ${vscode.workspace.asRelativePath(fileUri)}`
        );
      } catch (err) {
        outputChannel?.appendLine(`[ReMem Watcher Error] Failed to remove ${filePath}: ${err}`);
      }
    }
  });

  // 3. Watch for file renames
  const renameListener = vscode.workspace.onDidRenameFiles(async (event: vscode.FileRenameEvent) => {
    for (const file of event.files) {
      const oldPath = file.oldUri.fsPath;
      const newPath = file.newUri.fsPath;

      try {
        await dbManager.deleteFileSummary(oldPath);
        if (!shouldIgnorePath(newPath)) {
          const doc = await vscode.workspace.openTextDocument(file.newUri);
          await pipeline.summarizeDocument(doc);
          outputChannel?.appendLine(
            `[ReMem Watcher] Renamed summary from ${vscode.workspace.asRelativePath(file.oldUri)} -> ${vscode.workspace.asRelativePath(file.newUri)}`
          );
        }
      } catch (err) {
        outputChannel?.appendLine(`[ReMem Watcher Error] Failed to handle rename ${oldPath}: ${err}`);
      }
    }
  });

  context.subscriptions.push(saveListener, deleteListener, renameListener);
}

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
