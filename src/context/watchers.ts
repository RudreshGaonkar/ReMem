import * as vscode from 'vscode';
import { DatabaseManager } from '../database/index.js';
import { shouldIgnorePath } from '../config.js';
import { computeFileHash } from '../summarizer/hasher.js';
import { SummarizerPipeline } from '../summarizer/pipeline.js';
import type { LeanTraceabilityTracker } from '../task/traceability.js';
import type { KnowledgeGraphEngine } from './graph.js';

/**
 * Strict 1200ms debounce delay to prevent CPU spikes and thread starvation.
 */
export const WATCHER_DEBOUNCE_MS = 1200;

/**
 * Guard check to immediately exit if the file path is internal or loop-inducing.
 */
export function isLoopInducingOrInternalPath(filePath: string): boolean {
  if (!filePath) return true;
  const p = filePath.replace(/\\/g, '/');

  // Strict guard clauses required for ReMem Anti-Loop File Watcher
  if (
    p.includes('.antigravityMem') ||
    p.includes('.recall_scratchpad.md') ||
    p.includes('.remem_context_feed.md')
  ) {
    return true;
  }

  // Also skip standard transient/build directories
  if (
    p.includes('/.git/') ||
    p.includes('/node_modules/') ||
    p.includes('/out/') ||
    p.includes('/dist/')
  ) {
    return true;
  }

  return false;
}

/**
 * Anti-Loop File Watcher
 *
 * Implements strict guard clauses to prevent self-triggering loops from internal
 * files (.antigravityMem, .recall_scratchpad.md, .remem_context_feed.md) and applies
 * a strict 1200ms debounce across document saves to prevent CPU spikes.
 */
export function setupAntiLoopFileWatcher(
  context: vscode.ExtensionContext,
  dbManager: DatabaseManager,
  pipeline: SummarizerPipeline,
  outputChannel?: vscode.OutputChannel,
  traceabilityTracker?: LeanTraceabilityTracker,
  graphEngine?: KnowledgeGraphEngine
): void {
  // Map of active debounce timers per file path
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
    const isEnabled = vscode.workspace.getConfiguration('remem').get<boolean>('enableAutoSummarize', true);
    if (!isEnabled) {
      return;
    }

    // Ignore unsupported schemes (e.g. git, output, debug)
    if (document.uri.scheme !== 'file') {
      return;
    }

    const filePath = document.uri.fsPath;

    // Strict Anti-Loop Guard Clauses: exit immediately
    if (isLoopInducingOrInternalPath(filePath)) {
      return;
    }

    if (shouldIgnorePath(filePath)) {
      return;
    }

    // Clear any existing debounce timer for this file
    const existingTimer = debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
      debounceTimers.delete(filePath);
    }

    // Strict 1200ms debounce
    const timer = setTimeout(async () => {
      debounceTimers.delete(filePath);

      try {
        const content = document.getText();
        const currentHash = computeFileHash(content);

        // Parse imports & exports to update SQLite traceability ledger on file save
        if (traceabilityTracker) {
          try {
            await traceabilityTracker.processSavedFile(filePath, content);
          } catch {
            // Non-blocking
          }
        }

        // Check existing hash in SQLite to skip redundant processing
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

        // Silently update .remem_context_feed.md in background
        if (graphEngine) {
          graphEngine.updateContextFeedSilently().catch(() => {});
        }
      } catch (err) {
        outputChannel?.appendLine(`[ReMem Watcher Error] Failed to process ${filePath}: ${err}`);
      }
    }, WATCHER_DEBOUNCE_MS);

    debounceTimers.set(filePath, timer);
  });

  // Watch for file deletions
  const deleteListener = vscode.workspace.onDidDeleteFiles(async (event: vscode.FileDeleteEvent) => {
    for (const fileUri of event.files) {
      const filePath = fileUri.fsPath;
      if (isLoopInducingOrInternalPath(filePath)) continue;

      try {
        await dbManager.deleteFileSummary(filePath);
        outputChannel?.appendLine(
          `[ReMem Watcher] Removed deleted file from memory index: ${vscode.workspace.asRelativePath(fileUri)}`
        );
        if (graphEngine) {
          graphEngine.updateContextFeedSilently().catch(() => {});
        }
      } catch (err) {
        outputChannel?.appendLine(`[ReMem Watcher Error] Failed to remove ${filePath}: ${err}`);
      }
    }
  });

  // Watch for file renames
  const renameListener = vscode.workspace.onDidRenameFiles(async (event: vscode.FileRenameEvent) => {
    for (const file of event.files) {
      const oldPath = file.oldUri.fsPath;
      const newPath = file.newUri.fsPath;

      if (isLoopInducingOrInternalPath(oldPath) && isLoopInducingOrInternalPath(newPath)) continue;

      try {
        await dbManager.deleteFileSummary(oldPath);
        if (!shouldIgnorePath(newPath) && !isLoopInducingOrInternalPath(newPath)) {
          const doc = await vscode.workspace.openTextDocument(file.newUri);
          await pipeline.summarizeDocument(doc);
          outputChannel?.appendLine(
            `[ReMem Watcher] Renamed summary from ${vscode.workspace.asRelativePath(file.oldUri)} -> ${vscode.workspace.asRelativePath(file.newUri)}`
          );
        }
        if (graphEngine) {
          graphEngine.updateContextFeedSilently().catch(() => {});
        }
      } catch (err) {
        outputChannel?.appendLine(`[ReMem Watcher Error] Failed to handle rename ${oldPath}: ${err}`);
      }
    }
  });

  context.subscriptions.push(
    saveListener,
    deleteListener,
    renameListener,
    {
      dispose: () => {
        for (const timer of debounceTimers.values()) {
          clearTimeout(timer);
        }
        debounceTimers.clear();
      },
    }
  );
}

/**
 * Alias for backward compatibility.
 */
export const setupFileWatcher = setupAntiLoopFileWatcher;
