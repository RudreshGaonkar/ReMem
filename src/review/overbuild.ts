import * as fs from 'fs';
import * as path from 'path';
import { ASTAnalyzer } from '../ast/analyzer.js';
import { DiffIssue } from '../types/index.js';
import { shouldIgnorePath } from '../config.js';

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls',
  'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib'
]);

/**
 * Checks if an import path points to a standard node library, vscode API, or relative file.
 */
function isInternalOrStdLib(importTarget: string): boolean {
  if (importTarget.startsWith('.') || importTarget.startsWith('/')) {
    return true;
  }
  if (importTarget.startsWith('node:')) {
    return true;
  }
  if (NODE_BUILTINS.has(importTarget)) {
    return true;
  }
  if (importTarget === 'vscode' || importTarget.startsWith('@types/')) {
    return true;
  }
  return false;
}

/**
 * Extracts external root package name from an import string (e.g. "@orama/orama/dist" -> "@orama/orama", "lodash/fp" -> "lodash").
 */
function extractPackageName(importPath: string): string {
  const parts = importPath.split('/');
  if (importPath.startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/**
 * Overbuild Diff Filter (Lean Engine)
 * Scans active git diffs to detect over-engineering patterns:
 * 1. Newly introduced external dependencies (in package.json and imports).
 * 2. Redundant wrapper components/functions that trivially forward calls.
 * 3. Unnecessary boilerplate files or redundant re-export barrel files.
 */
export class OverbuildAuditor {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Runs all over-engineering and lean engine checks across the active git diff.
   */
  public auditDiffOverbuild(
    diffFiles: { file: string }[],
    diffChunksMap: Map<string, { addedLines: { lineNum: number; text: string }[] }>,
    astAnalyzer: ASTAnalyzer,
    issues: DiffIssue[]
  ): void {
    // 1. Audit newly introduced external dependencies in package.json and code imports
    this.checkExternalDependencies(diffChunksMap, issues);

    // 2. Audit redundant wrapper components and unnecessary boilerplate files
    for (const fileItem of diffFiles) {
      const relPath = fileItem.file;
      const fullPath = path.resolve(this.workspaceRoot, relPath);

      if (shouldIgnorePath(fullPath)) {
        continue;
      }

      if (!fs.existsSync(fullPath)) {
        continue;
      }

      const fileChunks = diffChunksMap.get(relPath) || { addedLines: [] };

      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      // Check for unnecessary boilerplate files
      this.checkBoilerplateFiles(relPath, fullPath, content, fileChunks.addedLines, issues);

      // Check for redundant wrapper components/functions
      this.checkRedundantWrappers(relPath, fullPath, content, fileChunks.addedLines, astAnalyzer, issues);
    }
  }

  /**
   * 1. Newly introduced external dependencies check:
   * Inspects package.json additions and newly introduced import statements.
   */
  private checkExternalDependencies(
    diffChunksMap: Map<string, { addedLines: { lineNum: number; text: string }[] }>,
    issues: DiffIssue[]
  ): void {
    const newlyAddedPackages = new Set<string>();

    // Check package.json diff for added dependencies
    for (const [relPath, chunk] of diffChunksMap.entries()) {
      if (path.basename(relPath).toLowerCase() === 'package.json') {
        const fullPath = path.resolve(this.workspaceRoot, relPath);
        for (const addedLine of chunk.addedLines) {
          const trimmed = addedLine.text.trim();
          // Match dependency lines like: "axios": "^1.6.0" or "@types/foo": "1.0"
          const depMatch = trimmed.match(/"(@?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?)"\s*:\s*"[^"]+"/);
          if (depMatch) {
            const pkgName = depMatch[1];
            newlyAddedPackages.add(pkgName);

            issues.push({
              filePath: fullPath,
              relativePath: relPath,
              line: addedLine.lineNum,
              type: 'overbuild',
              severity: 'warning',
              message: `Lean Engine Warning: Newly introduced external dependency "${pkgName}". Prioritize native standard library or existing project utilities before introducing new npm dependencies.`,
              snippet: trimmed,
            });
          }
        }
      }
    }

    // Check source code files for imports of external third-party dependencies in added lines
    const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/;

    for (const [relPath, chunk] of diffChunksMap.entries()) {
      if (path.basename(relPath).toLowerCase() === 'package.json') {
        continue;
      }

      const fullPath = path.resolve(this.workspaceRoot, relPath);
      for (const addedLine of chunk.addedLines) {
        const trimmed = addedLine.text.trim();
        const match = trimmed.match(importRegex);
        if (match) {
          const importTarget = match[1] || match[2];
          if (!isInternalOrStdLib(importTarget)) {
            const pkgName = extractPackageName(importTarget);
            // If the package is newly added in package.json or is not a core standard dependency
            if (newlyAddedPackages.has(pkgName)) {
              issues.push({
                filePath: fullPath,
                relativePath: relPath,
                line: addedLine.lineNum,
                type: 'overbuild',
                severity: 'warning',
                message: `Lean Engine Warning: Added import relies on newly introduced external dependency "${pkgName}". Check if native standard library or existing project helpers can fulfill this requirement.`,
                snippet: trimmed,
              });
            }
          }
        }
      }
    }
  }

  /**
   * 2. Redundant wrapper components check:
   * Identifies classes or functions that merely pass through arguments to another invocation
   * without adding logic, transformations, or state.
   */
  private checkRedundantWrappers(
    relPath: string,
    fullPath: string,
    content: string,
    addedLines: { lineNum: number; text: string }[],
    astAnalyzer: ASTAnalyzer,
    issues: DiffIssue[]
  ): void {
    // A. Detect wrapper naming smell (e.g. FooWrapper, BarProxy, BazAdapter, Facade)
    const baseName = path.basename(relPath, path.extname(relPath));
    const isWrapperNamedFile = /(?:wrapper|proxy|adapter|facade|forwarder)$/i.test(baseName);

    if (isWrapperNamedFile) {
      const nonCommentLines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));

      const exports = astAnalyzer.getExports(fullPath);
      const imports = astAnalyzer.extractImports(content);

      if (nonCommentLines.length <= 35 || (exports.length <= 1 && imports.length <= 1)) {
        issues.push({
          filePath: fullPath,
          relativePath: relPath,
          type: 'overbuild',
          severity: 'warning',
          message: `Lean Engine Warning: Redundant wrapper file "${relPath}" (${nonCommentLines.length} lines). Avoid creating shallow wrapper or proxy abstractions when the underlying component can be used directly.`,
        });
      }
    }

    // B. Detect trivial pass-through functions on added lines
    // Example: const wrapX = (a, b) => x(a, b); or function wrapX(a, b) { return x(a, b); }
    const arrowPassthrough = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*\(([^)]*)\)\s*=>\s*([a-zA-Z0-9_$.]+)\(\2\);?/;
    const functionPassthrough = /function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*:\s*[^\{]+\{\s*return\s+([a-zA-Z0-9_$.]+)\(\2\);?\s*\}|function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*\{\s*return\s+([a-zA-Z0-9_$.]+)\(\5\);?\s*\}/;

    for (const addedLine of addedLines) {
      const trimmed = addedLine.text.trim();

      const arrowMatch = trimmed.match(arrowPassthrough);
      if (arrowMatch) {
        const fnName = arrowMatch[1];
        const targetFn = arrowMatch[3];
        if (fnName !== targetFn) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            line: addedLine.lineNum,
            type: 'overbuild',
            severity: 'warning',
            message: `Lean Engine Warning: Redundant wrapper function "${fnName}" trivially delegates to "${targetFn}" without transformation.`,
            snippet: trimmed,
          });
        }
        continue;
      }

      const fnMatch = trimmed.match(functionPassthrough);
      if (fnMatch) {
        const fnName = fnMatch[1] || fnMatch[4];
        const targetFn = fnMatch[3] || fnMatch[6];
        if (fnName !== targetFn) {
          issues.push({
            filePath: fullPath,
            relativePath: relPath,
            line: addedLine.lineNum,
            type: 'overbuild',
            severity: 'warning',
            message: `Lean Engine Warning: Redundant pass-through wrapper function "${fnName}" directly forwards to "${targetFn}".`,
            snippet: trimmed,
          });
        }
      }
    }
  }

  /**
   * 3. Unnecessary boilerplate files check:
   * Flags trivial re-export barrel files, placeholder stub files, or over-abstracted scaffolding.
   */
  private checkBoilerplateFiles(
    relPath: string,
    fullPath: string,
    content: string,
    addedLines: { lineNum: number; text: string }[],
    issues: DiffIssue[]
  ): void {
    const ext = path.extname(relPath).toLowerCase();
    if (!['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
      return;
    }

    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const nonCommentLines = lines.filter((l) => !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));

    // A. Trivial single re-export barrel file (e.g., export * from './foo'; in an index.ts)
    if (nonCommentLines.length === 1) {
      const singleLine = nonCommentLines[0];
      const reExportMatch = singleLine.match(/^export\s+(?:\*|\{[^}]+\})\s+from\s+['"][^'"]+['"];?$/);
      if (reExportMatch) {
        issues.push({
          filePath: fullPath,
          relativePath: relPath,
          type: 'overbuild',
          severity: 'info',
          message: `Lean Engine Notice: Trivial barrel re-export file ("${relPath}"). File only re-exports a single module; consider importing directly to reduce boilerplate indirection.`,
          snippet: singleLine,
        });
        return;
      }
    }

    // B. Stub/placeholder file with minimal content (< 4 lines of code)
    if (nonCommentLines.length > 0 && (nonCommentLines.length <= 3 || addedLines.length <= 3)) {
      const isStub = nonCommentLines.some((l) =>
        /(?:placeholder|stub|dummy|TODO|throw new Error\(['"]not implemented['"]\))/i.test(l)
      );
      if (isStub) {
        issues.push({
          filePath: fullPath,
          relativePath: relPath,
          type: 'overbuild',
          severity: 'info',
          message: `Lean Engine Notice: Potential boilerplate stub/placeholder file detected ("${relPath}"). Consider inlining or implementing directly.`,
        });
        return;
      }
    }

    // C. Boilerplate naming smell in source files
    const baseName = path.basename(relPath).toLowerCase();
    if (/(?:boilerplate|placeholder|stub|dummy|mock-template)\.[a-z]+$/.test(baseName)) {
      issues.push({
        filePath: fullPath,
        relativePath: relPath,
        type: 'overbuild',
        severity: 'info',
        message: `Lean Engine Notice: Boilerplate template naming detected in active source file ("${relPath}").`,
      });
    }
  }
}

/**
 * Convenience helper to audit a git diff for overbuild/over-engineering concerns.
 */
export function auditOverbuild(
  workspaceRoot: string,
  diffFiles: { file: string }[],
  diffChunksMap: Map<string, { addedLines: { lineNum: number; text: string }[] }>,
  astAnalyzer: ASTAnalyzer,
  issues: DiffIssue[]
): void {
  const auditor = new OverbuildAuditor(workspaceRoot);
  auditor.auditDiffOverbuild(diffFiles, diffChunksMap, astAnalyzer, issues);
}
