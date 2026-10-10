import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ScratchpadManager } from '../ast/scratchpad.js';
import { shouldIgnorePath } from '../config.js';

export const TECH_DEBT_MARKER_START = '<!-- REMEM_TECH_DEBT_START -->';
export const TECH_DEBT_MARKER_END = '<!-- REMEM_TECH_DEBT_END -->';

const MAX_SCAN_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB cap

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.wasm', '.vsix', '.sqlite', '.db', '.lock',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.pdf', '.exe', '.dll', '.so', '.dylib', '.bin'
]);

export interface TechDebtItem {
  filePath: string;
  relativePath: string;
  line: number;
  tag: 'remem-debt' | 'TODO';
  description: string;
  snippet: string;
}

export interface TechDebtScanResult {
  totalItems: number;
  filesScanned: number;
  filesWithDebt: number;
  items: TechDebtItem[];
  markdownTable: string;
}

/**
 * Tech Debt Ledger (Lean Engine)
 * Scans workspace files for comments prefixed with `// remem-debt:` or `// TODO:`
 * and appends/updates a structured summary table into `.recall_scratchpad.md`.
 */
export class TechDebtLedger {
  private workspaceRoot: string;
  private scratchpad: ScratchpadManager;
  private outputChannel?: vscode.OutputChannel;

  constructor(
    workspaceRoot: string,
    scratchpad: ScratchpadManager,
    outputChannel?: vscode.OutputChannel
  ) {
    this.workspaceRoot = workspaceRoot;
    this.scratchpad = scratchpad;
    this.outputChannel = outputChannel;
  }

  /**
   * Scans workspace files for technical debt and TODO comments.
   */
  public async scanWorkspace(): Promise<TechDebtScanResult> {
    const filePaths = await this.discoverCandidateFiles();
    const items: TechDebtItem[] = [];
    const filesWithDebtSet = new Set<string>();

    // Regex matching comments prefixed with // remem-debt: or // TODO:
    // Also accommodates # and /* for multi-language flexibility
    const debtRegex = /(?:\/\/|#|\/\*)\s*(remem-debt|TODO)\s*:\s*(.*)/i;

    for (const filePath of filePaths) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_SCAN_FILE_SIZE_BYTES) {
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const relPath = path.relative(this.workspaceRoot, filePath);

        for (let idx = 0; idx < lines.length; idx++) {
          const lineText = lines[idx];
          const match = lineText.match(debtRegex);
          if (match) {
            const rawTag = match[1].toLowerCase();
            const tag: 'remem-debt' | 'TODO' = rawTag === 'remem-debt' ? 'remem-debt' : 'TODO';
            let description = match[2].trim();
            // Clean trailing comment closures e.g. */
            description = description.replace(/\*\/$/, '').trim();

            items.push({
              filePath,
              relativePath: relPath,
              line: idx + 1,
              tag,
              description: description || '(No description provided)',
              snippet: lineText.trim().substring(0, 120),
            });
            filesWithDebtSet.add(relPath);
          }
        }
      } catch (err) {
        // Skip unreadable / binary files
        continue;
      }
    }

    const markdownTable = this.formatMarkdownTable(items, filePaths.length);

    return {
      totalItems: items.length,
      filesScanned: filePaths.length,
      filesWithDebt: filesWithDebtSet.size,
      items,
      markdownTable,
    };
  }

  /**
   * Discovers text files in the workspace, skipping ignored patterns.
   */
  private async discoverCandidateFiles(): Promise<string[]> {
    const candidatePaths: string[] = [];

    // Attempt VS Code workspace search first
    if (vscode.workspace && vscode.workspace.findFiles) {
      try {
        const excludePattern = '{**/node_modules/**,**/.git/**,**/.antigravityMem/**,**/out/**,**/dist/**,**/.vscode-test/**}';
        const uris = await vscode.workspace.findFiles('**/*', excludePattern, 5000);
        for (const uri of uris) {
          const fsPath = uri.fsPath;
          if (this.isCandidateFile(fsPath)) {
            candidatePaths.push(fsPath);
          }
        }
        if (candidatePaths.length > 0) {
          return candidatePaths;
        }
      } catch {
        // Fallback to recursive filesystem traversal
      }
    }

    // Fallback: directory crawl
    this.crawlDirectory(this.workspaceRoot, candidatePaths);
    return candidatePaths;
  }

  /**
   * Checks whether a file path is a suitable candidate for text debt scanning.
   */
  private isCandidateFile(filePath: string): boolean {
    if (shouldIgnorePath(filePath)) {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return false;
    }
    return true;
  }

  /**
   * Recursively crawls a directory for candidate code files.
   */
  private crawlDirectory(dir: string, collected: string[]): void {
    if (!fs.existsSync(dir)) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!shouldIgnorePath(fullPath) && !entry.name.startsWith('.')) {
            this.crawlDirectory(fullPath, collected);
          }
        } else if (entry.isFile()) {
          if (this.isCandidateFile(fullPath)) {
            collected.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  /**
   * Formats the collected debt items into a markdown table block.
   */
  public formatMarkdownTable(items: TechDebtItem[], totalFilesScanned: number): string {
    const lines: string[] = [
      TECH_DEBT_MARKER_START,
      '## 💳 Tech Debt Ledger',
      `> Scanned **${totalFilesScanned}** workspace files. Found **${items.length}** tracked shortcut(s) / technical debt item(s).`,
      '',
    ];

    if (items.length === 0) {
      lines.push('*No active technical debt shortcuts (`// remem-debt:`) or `// TODO:` comments found in workspace.*');
    } else {
      lines.push('| Tag | File | Line | Tracked Shortcut / Debt Description |');
      lines.push('| :--- | :--- | :---: | :--- |');

      for (const item of items) {
        // Escape pipe characters in description for valid markdown tables
        const escapedDesc = item.description.replace(/\|/g, '\\|');
        const tagBadge = item.tag === 'remem-debt' ? '`remem-debt`' : '`TODO`';
        lines.push(`| ${tagBadge} | \`${item.relativePath}\` | ${item.line} | ${escapedDesc} |`);
      }
    }

    lines.push(TECH_DEBT_MARKER_END);
    return lines.join('\n');
  }

  /**
   * Appends or replaces the tech debt ledger section in .recall_scratchpad.md.
   */
  public updateScratchpadWithDebt(scanResult: TechDebtScanResult): void {
    try {
      const currentContent = this.scratchpad.getPlan();
      const debtBlock = scanResult.markdownTable;

      let updatedContent = '';
      if (currentContent.includes(TECH_DEBT_MARKER_START) && currentContent.includes(TECH_DEBT_MARKER_END)) {
        const startIndex = currentContent.indexOf(TECH_DEBT_MARKER_START);
        const endIndex = currentContent.indexOf(TECH_DEBT_MARKER_END) + TECH_DEBT_MARKER_END.length;
        updatedContent =
          currentContent.substring(0, startIndex) +
          debtBlock +
          currentContent.substring(endIndex);
      } else {
        updatedContent = currentContent.trim() + '\n\n' + debtBlock + '\n';
      }

      this.scratchpad.updatePlan(updatedContent);
      this.outputChannel?.appendLine(
        `[ReMem Tech Debt] Appended/updated Tech Debt Ledger in .recall_scratchpad.md (${scanResult.totalItems} items).`
      );
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Tech Debt] Failed to update scratchpad: ${err}`);
    }
  }

  /**
   * Executes a complete scan and writes the debt ledger into .recall_scratchpad.md.
   */
  public async collectAndRecordDebt(): Promise<TechDebtScanResult> {
    const result = await this.scanWorkspace();
    this.updateScratchpadWithDebt(result);
    return result;
  }
}
