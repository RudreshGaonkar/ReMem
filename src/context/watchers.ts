import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceWorkQueue } from '../core/workQueue.js';
import { indexWorkspace } from '../summarizer/indexer.js';
import { DatabaseManager } from '../database/index.js';
import { shouldIgnorePath } from '../config.js';
import { SecretShield } from '../core/ignore.js';
import { refreshIndexedFile } from '../summarizer/workspaceIndex.js';
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

  // Pass through Bulletproof SecretShield (.gitignore + secret blocklist)
  if (SecretShield.getInstance().isIgnored(filePath)) {
    return true;
  }

  const p = filePath.replace(/\\/g, '/');

  // Strict guard clauses required for Cuttlehawk Anti-Loop File Watcher
  if (
    p.includes('.antigravityMem') ||
    p.includes('.recall_scratchpad.md') ||
    p.includes('.cuttlehawk_context_feed.md') ||
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
 * files (.antigravityMem, .recall_scratchpad.md, .cuttlehawk_context_feed.md) and applies
 * a strict 1200ms debounce across document saves to prevent CPU spikes.
 */
export function setupAntiLoopFileWatcher(
  context: vscode.ExtensionContext,
  dbManager: DatabaseManager,
  pipeline: SummarizerPipeline,
  outputChannel?: vscode.OutputChannel,
  traceabilityTracker?: LeanTraceabilityTracker,
  graphEngine?: KnowledgeGraphEngine,
  syncTasks?: () => Promise<unknown>,
): { add(file: string): void; stop(): Promise<void> } {
  const report = (error: unknown) => outputChannel?.appendLine(`[Cuttlehawk Watcher] ${error}`);
  const queue = new WorkspaceWorkQueue(async (files, signal, overflow) => {
    if (overflow) {
      report('Event capacity exceeded, rescanning the workspace');
      await indexWorkspace(dbManager.rootPath, dbManager, pipeline, outputChannel, traceabilityTracker, signal);
    }
    const config = vscode.workspace.getConfiguration('cuttlehawk');
    const legacyConfig = vscode.workspace.getConfiguration('remem');
    const enabled = config.get<boolean>('enableAutoSummarize', legacyConfig.get<boolean>('enableAutoSummarize', true));
    const indexedFiles = enabled ? files : files.filter((file) => !fs.existsSync(file));
    for (let offset = 0; offset < indexedFiles.length; offset += 16) {
      signal.throwIfAborted();
      await Promise.all(indexedFiles.slice(offset, offset + 16).map((file) =>
        refreshIndexedFile(dbManager, pipeline, file, traceabilityTracker, signal).catch(report)));
    }
    signal.throwIfAborted();
    if (files.some((file) => path.extname(file).toLowerCase() === '.md')) await syncTasks?.();
    if (indexedFiles.length || overflow) await graphEngine?.updateContextFeedSilently(signal);
  }, report, WATCHER_DEBOUNCE_MS);

  const add = (file: string) => {
    if (!isLoopInducingOrInternalPath(file) && !shouldIgnorePath(file)) queue.add(file);
  };
  const enqueue = (uri: vscode.Uri) => {
    if (uri.scheme === 'file') add(uri.fsPath);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dbManager.rootPath, '**/*'));
  const listeners = [
    watcher,
    watcher.onDidCreate(enqueue),
    watcher.onDidChange(enqueue),
    watcher.onDidDelete(enqueue),
    vscode.workspace.onDidSaveTextDocument((document) => enqueue(document.uri)),
    vscode.workspace.onDidDeleteFiles((event) => event.files.forEach(enqueue)),
    vscode.workspace.onDidRenameFiles((event) => event.files.forEach(({ oldUri, newUri }) => {
      enqueue(oldUri);
      enqueue(newUri);
    })),
  ];
  const stop = () => {
    for (const listener of listeners) listener.dispose();
    return queue.stop();
  };
  context.subscriptions.push({ dispose: () => { void stop(); } });
  return { add, stop };
}

/**
 * Alias for backward compatibility.
 */
export const setupFileWatcher = setupAntiLoopFileWatcher;
