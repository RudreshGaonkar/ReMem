import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseManager } from '../database/index.js';
import { computeFileHash } from './hasher.js';
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
  outputChannel?: vscode.OutputChannel
): Promise<IndexingResult> {
  outputChannel?.appendLine(`[ReMem Indexer] Starting initial workspace scan for: ${workspaceRoot}`);

  // Find files in workspace excluding common build/dependency artifacts
  const excludePattern = '{**/node_modules/**,**/.git/**,**/.antigravityMem/**,**/out/**,**/dist/**,**/.vscode-test/**}';
  const fileUris = await vscode.workspace.findFiles('**/*', excludePattern, 2000);

  let indexedCount = 0;
  let skippedCount = 0;

  for (const uri of fileUris) {
    const filePath = uri.fsPath;
    if (shouldIgnorePath(filePath)) {
      continue;
    }

    try {
      const stats = fs.statSync(filePath);
      // Skip directories and huge binary files (> 1MB)
      if (stats.isDirectory() || stats.size > 1024 * 1024) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const hash = computeFileHash(content);
      const relativePath = path.relative(workspaceRoot, filePath);

      const existing = dbManager.getFileSummary(filePath);
      if (existing && existing.hash === hash) {
        skippedCount++;
        continue;
      }

      // Summarize and store
      await pipeline.summarizeContent(filePath, relativePath, content);
      indexedCount++;
    } catch (err) {
      // Binary or unreadable file, ignore
      continue;
    }
  }

  // Flush to disk after bulk indexing
  await dbManager.flushToDisk();

  outputChannel?.appendLine(
    `[ReMem Indexer] Workspace indexing completed. Scanned: ${fileUris.length}, Newly Indexed/Updated: ${indexedCount}, Unchanged (Cached): ${skippedCount}`
  );

  return {
    totalFilesFound: fileUris.length,
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
