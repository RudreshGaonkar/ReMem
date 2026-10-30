import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from '../database/index.js';
import { ASTAnalyzer } from '../ast/analyzer.js';
import { shouldIgnorePath } from '../config.js';

/**
 * Lean Traceability Tracker
 * Parses import and export statements on file save, registers module dependencies
 * in SQLite remem_ledger, and provides Ripple Effect Warnings to alert agents of downstream breaking changes.
 */
export class LeanTraceabilityTracker {
  private workspaceRoot: string;
  private dbManager: DatabaseManager;
  private astAnalyzer?: ASTAnalyzer;

  constructor(workspaceRoot: string, dbManager: DatabaseManager, astAnalyzer?: ASTAnalyzer) {
    this.workspaceRoot = workspaceRoot;
    this.dbManager = dbManager;
    this.astAnalyzer = astAnalyzer;
  }

  /**
   * Resolves a relative import path to an absolute path on disk.
   */
  public resolveImportPath(fromFilePath: string, importString: string): string | null {
    if (!importString.startsWith('.')) {
      return null;
    }

    const dir = path.dirname(fromFilePath);
    const candidatePath = path.resolve(dir, importString);
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '/index.ts', '/index.js'];
    const baseCandidate = candidatePath.replace(/\.js$/, '');

    for (const ext of extensions) {
      const fullPath = candidatePath + ext;
      if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
        return fullPath;
      }
      const tsPath = baseCandidate + ext;
      if (fs.existsSync(tsPath) && !fs.statSync(tsPath).isDirectory()) {
        return tsPath;
      }
    }

    return null;
  }

  /**
   * Parses imports and exports from file content using fast regex scanners.
   */
  public parseImportsAndExports(content: string): { imports: string[]; exports: string[] } {
    const rawImports: string[] = [];
    const exports: string[] = [];

    // 1. ES6 import/export from '...'
    const es6Regex = /(?:import|export)\s+(?:[\w\s{},*]+from\s+)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = es6Regex.exec(content)) !== null) {
      rawImports.push(match[1]);
    }

    // 2. CommonJS require('...')
    const cjsRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = cjsRegex.exec(content)) !== null) {
      rawImports.push(match[1]);
    }

    // 3. Dynamic import('...')
    const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicRegex.exec(content)) !== null) {
      rawImports.push(match[1]);
    }

    // 4. Python imports
    const pyRegex = /(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/g;
    while ((match = pyRegex.exec(content)) !== null) {
      rawImports.push(match[1] || match[2]);
    }

    // Exports
    const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([a-zA-Z0-9_$]+)/g;
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }

    return {
      imports: Array.from(new Set(rawImports)),
      exports: Array.from(new Set(exports)),
    };
  }

  /**
   * Processes a saved file: parses imports/exports and persists dependencies into SQLite remem_ledger.
   */
  public async processSavedFile(
    filePath: string,
    fileContent?: string
  ): Promise<{ imports: string[]; exports: string[]; dependents: string[] }> {
    try {
      const content = fileContent !== undefined ? fileContent : fs.readFileSync(filePath, 'utf8');
      const { imports: rawImports, exports } = this.parseImportsAndExports(content);

      // Resolve relative imports to absolute paths
      const resolvedDependencies: { importedFile: string; importStatement?: string }[] = [];
      for (const rawImport of rawImports) {
        const resolved = this.resolveImportPath(filePath, rawImport);
        if (resolved) {
          resolvedDependencies.push({
            importedFile: resolved,
            importStatement: rawImport,
          });
        }
      }

      // Record in SQLite remem_ledger
      this.dbManager.sqlite.recordDependencies(filePath, resolvedDependencies);
      this.dbManager.sqlite.recordExports(
        filePath,
        exports.map((sym) => ({ symbol: sym }))
      );

      // Sync into in-memory ASTAnalyzer if attached
      if (this.astAnalyzer) {
        this.astAnalyzer.processFileDependencies(filePath);
      }

      const dependents = this.getDependents(filePath);

      return {
        imports: resolvedDependencies.map((d) => d.importedFile),
        exports,
        dependents,
      };
    } catch {
      return { imports: [], exports: [], dependents: [] };
    }
  }

  /**
   * Retrieves all workspace files that depend on (import) the specified file from SQLite.
   */
  public getDependents(filePath: string): string[] {
    const sqliteDependents = this.dbManager.sqlite.getDependentsForFile(filePath);
    if (sqliteDependents.length > 0) {
      return sqliteDependents;
    }

    // Fallback to in-memory ASTAnalyzer if SQLite records were not yet seeded
    if (this.astAnalyzer) {
      return this.astAnalyzer.getDependentFiles(filePath);
    }

    return [];
  }

  /**
   * Generates a "Ripple Effect Warning" block for context injection.
   * Warns the AI coding agent about downstream dependents that could break.
   */
  public generateRippleEffectWarning(filePath: string): string | null {
    const dependents = this.getDependents(filePath);
    if (!dependents || dependents.length === 0) {
      return null;
    }

    const relPath = path.relative(this.workspaceRoot, filePath);
    const sections: string[] = [];

    sections.push('## 🌊 RIPPLE EFFECT WARNING (Lean Traceability Ledger)');
    sections.push(
      `Modifying \`${relPath}\` impacts **${dependents.length}** downstream workspace file(s):`
    );

    const displayLimit = 6;
    for (const depPath of dependents.slice(0, displayLimit)) {
      const depRel = path.relative(this.workspaceRoot, depPath);
      sections.push(`- \`${depRel}\``);
    }

    if (dependents.length > displayLimit) {
      sections.push(`- *...and ${dependents.length - displayLimit} more dependent file(s).*`);
    }

    sections.push(
      '> ⚠️ **Anticipate Breaking Changes**: Verify exported types, function signatures, and interface contracts before making changes. Downstream workspace modules depend on this file.'
    );

    return sections.join('\n');
  }

  /**
   * Performs an initial scan of workspace files to seed dependencies in SQLite remem_ledger.
   */
  public async scanWorkspace(maxFiles: number = 500): Promise<number> {
    let processed = 0;

    const scanDir = (dir: string) => {
      if (processed >= maxFiles) return;
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (processed >= maxFiles) break;
          const fullPath = path.join(dir, item.name);
          if (shouldIgnorePath(fullPath)) continue;

          if (item.isDirectory()) {
            scanDir(fullPath);
          } else if (item.isFile()) {
            const ext = path.extname(item.name).toLowerCase();
            if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'].includes(ext)) {
              this.processSavedFile(fullPath);
              processed++;
            }
          }
        }
      } catch {
        // ignore unreadable
      }
    };

    scanDir(this.workspaceRoot);
    return processed;
  }
}
