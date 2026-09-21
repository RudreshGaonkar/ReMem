import * as path from 'path';
import type * as vscode from 'vscode';
import { CONFIG } from '../config.js';
import { DatabaseManager } from '../database/index.js';
import { FileSummary } from '../types/index.js';
import { computeFileHash, estimateTokenCount } from './hasher.js';

/**
 * SummarizerPipeline processes source code and generates 1-2 sentence structural summaries.
 */
export class SummarizerPipeline {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Checks whether a file is sensitive based on predefined naming patterns.
   */
  public isSensitiveFile(filePath: string): boolean {
    const filename = path.basename(filePath);
    return CONFIG.SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filename) || pattern.test(filePath));
  }

  /**
   * Summarizes a VS Code TextDocument and stores the result in SQLite + Orama.
   */
  public async summarizeDocument(document: vscode.TextDocument): Promise<FileSummary | null> {
    const filePath = document.uri.fsPath;
    const content = document.getText();
    const relativePath = this.dbManager.rootPath ? path.relative(this.dbManager.rootPath, filePath) : path.basename(filePath);

    return this.summarizeContent(filePath, relativePath, content);
  }

  /**
   * Summarizes raw file content and updates the database.
   */
  public async summarizeContent(
    filePath: string,
    relativePath: string,
    content: string
  ): Promise<FileSummary | null> {
    const hash = computeFileHash(content);
    const isSensitive = this.isSensitiveFile(filePath);
    const tokenCount = estimateTokenCount(content);

    let summaryText: string;

    if (isSensitive) {
      summaryText = `[Encrypted Vault File] Sensitive configuration or secret keys (${path.basename(filePath)}). Protected by AES-256-GCM.`;
    } else {
      summaryText = this.generateStructuralSummary(filePath, content);
    }

    const fileSummary: FileSummary = {
      filePath,
      relativePath,
      summary: summaryText,
      hash,
      lastModified: Date.now(),
      tokenCountEstimate: tokenCount,
      isEncrypted: isSensitive,
    };

    await this.dbManager.saveFileSummary(fileSummary);
    return fileSummary;
  }

  /**
   * Extracts structural components (classes, functions, types, exports) to construct a 1-2 sentence summary.
   */
  public generateStructuralSummary(filePath: string, content: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // Markdown / Documentation files
    if (ext === '.md' || ext === '.txt') {
      const firstHeading = content.match(/^#+\s+(.+)$/m);
      if (firstHeading) {
        return `Documentation file covering ${firstHeading[1].trim()}.`;
      }
      return `Documentation and notes in ${filename}.`;
    }

    // JSON configuration files
    if (ext === '.json') {
      try {
        const parsed = JSON.parse(content);
        const keys = Object.keys(parsed).slice(0, 5).join(', ');
        return `JSON configuration module containing top-level keys: ${keys || 'empty'}.`;
      } catch {
        return `JSON configuration file (${filename}).`;
      }
    }

    // Source code files (TS, JS, Python, Go, Rust, Java, etc.)
    const exportedItems: string[] = [];
    const internalItems: string[] = [];

    // Check for comments at the top of the file
    const docCommentMatch = content.match(/^\/\*\*([\s\S]*?)\*\//m) || content.match(/^"""([\s\S]*?)"""/m);
    let docSnippet = '';
    if (docCommentMatch) {
      docSnippet = docCommentMatch[1]
        .replace(/\r?\n\s*\*?\s*/g, ' ')
        .replace(/@\w+.*$/g, '')
        .trim();
      if (docSnippet.length > 80) {
        docSnippet = docSnippet.substring(0, 80) + '...';
      }
    }

    // Regex scanners for common structural constructs
    const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(class|interface|type|enum|function|const|let|var)\s+([a-zA-Z0-9_$]+)/g;
    let match: RegExpExecArray | null;
    while ((match = exportRegex.exec(content)) !== null) {
      exportedItems.push(`${match[1]} ${match[2]}`);
      if (exportedItems.length >= 4) break;
    }

    // If no explicit exports found, scan for general class/function definitions
    if (exportedItems.length === 0) {
      const genericRegex = /(?:async\s+)?(class|function|def|func|fn)\s+([a-zA-Z0-9_$]+)/g;
      while ((match = genericRegex.exec(content)) !== null) {
        internalItems.push(`${match[1]} ${match[2]}`);
        if (internalItems.length >= 3) break;
      }
    }

    // Assemble 1-2 sentence summary
    let summary = '';
    if (docSnippet) {
      summary += `${docSnippet} `;
    }

    if (exportedItems.length > 0) {
      summary += `Defines and exports: ${exportedItems.join(', ')}.`;
    } else if (internalItems.length > 0) {
      summary += `Defines ${internalItems.join(', ')}.`;
    } else {
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      summary += `Source module (${filename}) containing ${lines.length} lines of code.`;
    }

    return summary.trim();
  }
}
