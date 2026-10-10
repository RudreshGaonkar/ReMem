import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SimpleGit, simpleGit } from 'simple-git';
import { DatabaseManager } from '../database/index.js';
import { ASTAnalyzer } from '../ast/analyzer.js';
import { ScratchpadManager } from '../ast/scratchpad.js';
import { shouldIgnorePath, getMemoryDirPath } from '../config.js';
import { DiffAuditReport, DiffIssue } from '../types/index.js';

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB limit for safe inspections

/**
 * Local Diff Auditor (CodeRabbit Pattern)
 * Inspects active git working tree and staged diffs, cross-references AST dependencies
 * and Orama vector context, and flags leftover debug markers, syntax/import flaws, and style breaches.
 */
export class LocalDiffAuditor {
  private workspaceRoot: string;
  private dbManager: DatabaseManager;
  private astAnalyzer: ASTAnalyzer;
  private scratchpad: ScratchpadManager;
  private git: SimpleGit;
  private outputChannel?: vscode.OutputChannel;

  constructor(
    workspaceRoot: string,
    dbManager: DatabaseManager,
    astAnalyzer: ASTAnalyzer,
    scratchpad: ScratchpadManager,
    outputChannel?: vscode.OutputChannel
  ) {
    this.workspaceRoot = workspaceRoot;
    this.dbManager = dbManager;
    this.astAnalyzer = astAnalyzer;
    this.scratchpad = scratchpad;
    this.git = simpleGit(workspaceRoot);
    this.outputChannel = outputChannel;
  }

  /**
   * Executes a complete local diff audit and returns a structured report.
   */
  public async auditDiff(): Promise<DiffAuditReport | null> {
    const gitDir = path.join(this.workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      this.outputChannel?.appendLine('[ReMem Auditor] No .git directory found. Diff audit requires Git.');
      vscode.window.showInformationMessage('ReMem Diff Auditor: No Git repository detected. Diff audit is unavailable.');
      return null;
    }

    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        vscode.window.showInformationMessage('ReMem Diff Auditor: Workspace is not a Git repository.');
        return null;
      }
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Auditor] Git check failed: ${err}`);
      return null;
    }

    // Determine current branch
    let currentBranch = 'HEAD';
    try {
      const status = await this.git.status();
      currentBranch = status.current || 'HEAD';
    } catch {
      // Fallback
    }

    // Inspect working tree and staged diffs
    let diffSummary;
    let rawDiff = '';
    try {
      // Try comparing working tree against HEAD
      diffSummary = await this.git.diffSummary(['HEAD']).catch(() => null);
      rawDiff = await this.git.diff(['HEAD']).catch(() => '');

      if (!diffSummary) {
        // Fallback for fresh repos with zero commits
        diffSummary = await this.git.diffSummary();
        rawDiff = await this.git.diff();
      }
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Auditor] Error gathering git diff: ${err}`);
      vscode.window.showWarningMessage(`ReMem Diff Auditor: Could not read Git diff: ${err}`);
      return null;
    }

    if (!diffSummary || diffSummary.files.length === 0) {
      this.outputChannel?.appendLine('[ReMem Auditor] Working tree is clean. No active or staged changes to audit.');
      vscode.window.showInformationMessage('ReMem Diff Auditor: Working tree is clean. No active changes found.');
      return null;
    }

    const issues: DiffIssue[] = [];
    const blastRadiusSummaries: { file: string; dependentsCount: number; dependents: string[] }[] = [];
    const diffChunksMap = this.parseUnifiedDiff(rawDiff);

    // Read project style rules from .recall_scratchpad.md
    const styleRules = this.extractScratchpadRules();

    let filesAuditedCount = 0;

    for (const fileItem of diffSummary.files) {
      const relPath = fileItem.file;
      const fullPath = path.resolve(this.workspaceRoot, relPath);

      // Skip internal/ignored directories
      if (shouldIgnorePath(fullPath)) {
        continue;
      }

      // Check existence (file might have been deleted)
      if (!fs.existsSync(fullPath)) {
        continue;
      }

      // Safe guard: check file size (under 1 MB cap)
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            type: 'style_rule',
            severity: 'info',
            message: `Skipped in-depth diff audit: file size (${(stat.size / (1024 * 1024)).toFixed(1)} MB) exceeds 1 MB safety threshold.`,
          });
          continue;
        }
      } catch {
        continue;
      }

      filesAuditedCount++;

      // Read file content strictly in read-only mode
      let fileContent = '';
      try {
        fileContent = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      const fileChunks = diffChunksMap.get(relPath) || { addedLines: [] };

      // 1. Check for leftover debug statements on added/modified lines
      this.checkDebugStatements(relPath, fullPath, fileChunks.addedLines, issues);

      // 2. Syntax, delimiter balance, and AST import discrepancies
      await this.checkSyntaxAndImports(relPath, fullPath, fileContent, issues);

      // 3. Project style rules compliance from .recall_scratchpad.md
      this.checkStyleRules(relPath, fullPath, fileContent, styleRules, issues);

      // 4. Cross-reference AST blast radius and Orama context
      const blastRadius = this.astAnalyzer.getBlastRadius(fullPath);
      if (blastRadius.dependents.length > 0) {
        const dependentRels = blastRadius.dependents.map((p) => path.relative(this.workspaceRoot, p));
        blastRadiusSummaries.push({
          file: relPath,
          dependentsCount: blastRadius.dependents.length,
          dependents: dependentRels,
        });

        issues.push({
          filePath: fullPath,
          relativePath: relPath,
          type: 'blast_radius',
          severity: 'info',
          message: `Modifying this file impacts ${blastRadius.dependents.length} downstream dependent module(s): ${dependentRels.slice(0, 3).join(', ')}${dependentRels.length > 3 ? '...' : ''}.`,
        });
      }
    }

    const reportMarkdown = this.formatMarkdownReport(
      currentBranch,
      diffSummary,
      filesAuditedCount,
      issues,
      blastRadiusSummaries
    );

    const report: DiffAuditReport = {
      timestamp: Date.now(),
      branch: currentBranch,
      totalFilesChanged: diffSummary.files.length,
      filesAudited: filesAuditedCount,
      insertions: diffSummary.insertions,
      deletions: diffSummary.deletions,
      issues,
      blastRadiusSummary: blastRadiusSummaries,
      markdownReport: reportMarkdown,
    };

    // Store review artifact safely within .antigravityMem/
    this.persistReportToMem(reportMarkdown);

    return report;
  }

  /**
   * Parses unified git diff text to extract added lines and their line numbers per file.
   */
  private parseUnifiedDiff(diffText: string): Map<string, { addedLines: { lineNum: number; text: string }[] }> {
    const fileMap = new Map<string, { addedLines: { lineNum: number; text: string }[] }>();
    if (!diffText) return fileMap;

    const lines = diffText.split(/\r?\n/);
    let currentFile = '';
    let currentLineNum = 0;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFile = match[2];
          if (!fileMap.has(currentFile)) {
            fileMap.set(currentFile, { addedLines: [] });
          }
        }
      } else if (line.startsWith('@@')) {
        // e.g. @@ -10,4 +25,7 @@
        const match = line.match(/@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/);
        if (match) {
          currentLineNum = parseInt(match[1], 10);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        if (currentFile && fileMap.has(currentFile)) {
          fileMap.get(currentFile)!.addedLines.push({
            lineNum: currentLineNum,
            text: line.substring(1),
          });
        }
        currentLineNum++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Deleted line; line count for new file does not increment
      } else {
        // Context line
        currentLineNum++;
      }
    }

    return fileMap;
  }

  /**
   * Scans added lines for leftover debug statements, debugger keywords, or unfinished tags.
   */
  private checkDebugStatements(
    relPath: string,
    fullPath: string,
    addedLines: { lineNum: number; text: string }[],
    issues: DiffIssue[]
  ): void {
    const debugPatterns = [
      { regex: /\bconsole\.(?:log|debug|warn|trace)\s*\(/, label: 'console logging statement', severity: 'warning' as const },
      { regex: /\bdebugger\b;?/, label: 'debugger statement', severity: 'error' as const },
      { regex: /\b(?:var_dump|print_r|dd)\s*\(/, label: 'PHP dump statement', severity: 'warning' as const },
      { regex: /\bprint\s*\([^)]*debug/i, label: 'python debug print', severity: 'info' as const },
      { regex: /\b(?:TODO|FIXME|XXX|HACK)\b(?::|\s+-|\s+[A-Z])/, label: 'unresolved TODO/FIXME marker', severity: 'info' as const },
    ];

    for (const item of addedLines) {
      const trimmed = item.text.trim();
      // Skip commented-out descriptions if they aren't explicit markers
      for (const pattern of debugPatterns) {
        if (pattern.regex.test(trimmed)) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            line: item.lineNum,
            type: 'debug_statement',
            severity: pattern.severity,
            message: `Found ${pattern.label} in added lines`,
            snippet: trimmed.substring(0, 100),
          });
        }
      }
    }
  }

  /**
   * Verifies syntax balance and cross-references AST module imports.
   */
  private async checkSyntaxAndImports(
    relPath: string,
    fullPath: string,
    content: string,
    issues: DiffIssue[]
  ): Promise<void> {
    // 1. Delimiter balance check (parentheses, braces, brackets)
    const delimiterIssue = this.checkDelimiterBalance(content);
    if (delimiterIssue) {
      issues.push({
        filePath: fullPath,
        relativePath: relPath,
        type: 'syntax_discrepancy',
        severity: 'error',
        message: delimiterIssue,
      });
    }

    // 2. Cross-reference relative imports with disk existence and exports
    const namedImports = this.astAnalyzer.extractNamedImports(content);
    const rawImports = this.astAnalyzer.extractImports(content);

    for (const rawImport of rawImports) {
      if (rawImport.startsWith('.')) {
        const resolved = this.astAnalyzer.resolveImportPath(fullPath, rawImport);
        if (!resolved) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            type: 'broken_import',
            severity: 'error',
            message: `Unresolvable relative import: "${rawImport}" does not match an existing file.`,
          });
        }
      }
    }

    // 3. Named imports verification against known exports of target module
    for (const named of namedImports) {
      if (named.fromPath.startsWith('.')) {
        const resolved = this.astAnalyzer.resolveImportPath(fullPath, named.fromPath);
        if (resolved && fs.existsSync(resolved)) {
          const knownExports = this.astAnalyzer.getExports(resolved);
          if (knownExports.length > 0 && !knownExports.includes(named.symbol)) {
            // Target file has exports parsed, but the imported symbol is not present
            const targetRel = path.relative(this.workspaceRoot, resolved);
            issues.push({
              filePath: fullPath,
              relativePath: relPath,
              type: 'missing_export',
              severity: 'warning',
              message: `Symbol "${named.symbol}" imported from "${targetRel}" is not declared in its parsed exports.`,
            });
          }
        }
      }
    }

    // 4. Query Orama semantic context for architectural relevance
    try {
      const baseName = path.basename(relPath, path.extname(relPath));
      const searchHits = await this.dbManager.searchSummaries(baseName, 1);
      if (searchHits.length > 0 && searchHits[0].document.filePath !== fullPath) {
        // Discovered related module
        issues.push({
          filePath: fullPath,
          relativePath: relPath,
          type: 'blast_radius',
          severity: 'info',
          message: `Semantically related to workspace module "${searchHits[0].document.relativePath}": ${searchHits[0].document.summary}`,
        });
      }
    } catch {
      // Non-fatal Orama query
    }
  }

  /**
   * Checks for unbalanced delimiters (parentheses, braces, brackets), ignoring comments and strings.
   */
  private checkDelimiterBalance(content: string): string | null {
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;

    // Remove single and multi-line comments and strings to avoid false positives
    const sanitized = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    for (let i = 0; i < sanitized.length; i++) {
      const char = sanitized[i];
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '(') parenCount++;
      else if (char === ')') parenCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }

    if (braceCount !== 0) return `Potential syntax mismatch: curly braces balance off by ${braceCount}`;
    if (parenCount !== 0) return `Potential syntax mismatch: parentheses balance off by ${parenCount}`;
    if (bracketCount !== 0) return `Potential syntax mismatch: square brackets balance off by ${bracketCount}`;

    return null;
  }

  /**
   * Extracts style guidelines, conventions, or constraints documented in .recall_scratchpad.md.
   */
  private extractScratchpadRules(): string[] {
    const rules: string[] = [];
    const plan = this.scratchpad.getPlan();
    if (!plan) return rules;

    const lines = plan.split(/\r?\n/);
    let inRulesSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#+\s+.*(?:rule|style|convention|constraint|guideline)/i.test(trimmed)) {
        inRulesSection = true;
        continue;
      } else if (inRulesSection && /^#+\s+/.test(trimmed)) {
        inRulesSection = false;
      }

      if (inRulesSection && /^[-*]\s+/.test(trimmed)) {
        rules.push(trimmed.replace(/^[-*]\s+/, ''));
      }
    }

    return rules;
  }

  /**
   * Verifies basic file consistency against rules parsed from the scratchpad.
   */
  private checkStyleRules(
    relPath: string,
    fullPath: string,
    content: string,
    rules: string[],
    issues: DiffIssue[]
  ): void {
    if (rules.length === 0) return;

    for (const rule of rules) {
      const lower = rule.toLowerCase();

      // Check tab vs space indentation if rule specifies
      if (lower.includes('no tabs') || lower.includes('use spaces')) {
        if (/^\t+/m.test(content)) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            type: 'style_rule',
            severity: 'warning',
            message: `Scratchpad rule violation ("${rule}"): File contains tab indentation instead of spaces.`,
          });
        }
      }

      // Check max line length if specified (e.g., max line length 100 or 120)
      const lineLenMatch = lower.match(/(?:max(?:imum)?\s+line\s+length|limit\s+lines\s+to)\s+(\d+)/);
      if (lineLenMatch) {
        const maxLen = parseInt(lineLenMatch[1], 10);
        const longLines = content.split(/\r?\n/).filter((l) => l.length > maxLen);
        if (longLines.length > 0) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            type: 'style_rule',
            severity: 'info',
            message: `Scratchpad rule notice ("${rule}"): ${longLines.length} line(s) exceed ${maxLen} characters.`,
          });
        }
      }
    }
  }

  /**
   * Formats the audit findings into a clean Markdown checklist.
   */
  private formatMarkdownReport(
    branch: string,
    diffSummary: any,
    auditedCount: number,
    issues: DiffIssue[],
    blastSummaries: { file: string; dependentsCount: number; dependents: string[] }[]
  ): string {
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    const infoCount = issues.filter((i) => i.severity === 'info').length;

    const sections: string[] = [];

    sections.push('# 🐰 ReMem Local Diff Audit (CodeRabbit Pattern)');
    sections.push(`> Automated structural checklist & blast radius review generated locally at ${new Date().toLocaleTimeString()}.\n`);

    sections.push('## 📊 Overview');
    sections.push(`- **Branch**: \`${branch}\``);
    sections.push(`- **Files Changed in Git**: ${diffSummary.files.length} (${diffSummary.insertions} additions, ${diffSummary.deletions} deletions)`);
    sections.push(`- **Files Audited**: ${auditedCount} (safety capped at <= 1 MB)`);
    sections.push(`- **Audit Findings**: ${errorCount} error(s), ${warningCount} warning(s), ${infoCount} informational hint(s)\n`);

    if (issues.length === 0) {
      sections.push('### ✅ Clean Bill of Health');
      sections.push('- No leftover debug markers or console logs detected in added lines.');
      sections.push('- All relative imports resolve successfully to valid modules.');
      sections.push('- Delimiters and style rules are intact.');
      return sections.join('\n');
    }

    // 1. Leftover Debug Statements
    const debugIssues = issues.filter((i) => i.type === 'debug_statement');
    if (debugIssues.length > 0) {
      sections.push('## 🚨 Leftover Debug Statements & Markers');
      for (const item of debugIssues) {
        const lineStr = item.line ? `:${item.line}` : '';
        sections.push(`- [ ] **\`${item.relativePath}${lineStr}\`**: ${item.message}`);
        if (item.snippet) {
          sections.push(`  \`\`\`typescript\n  ${item.snippet}\n  \`\`\``);
        }
      }
      sections.push('');
    }

    // 2. Syntax & Import Discrepancies
    const importIssues = issues.filter((i) => i.type === 'broken_import' || i.type === 'missing_export' || i.type === 'syntax_discrepancy');
    if (importIssues.length > 0) {
      sections.push('## ⚠️ Syntax & Import Discrepancies');
      for (const item of importIssues) {
        const icon = item.severity === 'error' ? '❌' : '⚠️';
        sections.push(`- [ ] ${icon} **\`${item.relativePath}\`**: ${item.message}`);
      }
      sections.push('');
    }

    // 3. Scratchpad Style Rule Check
    const styleIssues = issues.filter((i) => i.type === 'style_rule');
    if (styleIssues.length > 0) {
      sections.push('## 📏 Scratchpad Style Compliance');
      for (const item of styleIssues) {
        sections.push(`- [ ] **\`${item.relativePath}\`**: ${item.message}`);
      }
      sections.push('');
    }

    // 4. AST Blast Radius & Architectural Impact
    if (blastSummaries.length > 0) {
      sections.push('## 💥 AST Blast Radius & Impacted Modules');
      for (const item of blastSummaries) {
        sections.push(`- **\`${item.file}\`** impacts **${item.dependentsCount}** dependent module(s):`);
        for (const dep of item.dependents) {
          sections.push(`  - \`${dep}\``);
        }
      }
      sections.push('');
    }

    sections.push('---\n*Audit executed 100% locally by ReMem without external API calls.*');

    return sections.join('\n');
  }

  /**
   * Persists the last audit report strictly into .antigravityMem/last_diff_audit.md.
   */
  private persistReportToMem(markdown: string): void {
    try {
      const memDir = getMemoryDirPath(this.workspaceRoot);
      if (fs.existsSync(memDir)) {
        const targetPath = path.join(memDir, 'last_diff_audit.md');
        fs.writeFileSync(targetPath, markdown, 'utf8');
      }
    } catch {
      // Non-fatal cache write
    }
  }
}
