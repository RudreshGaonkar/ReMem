import * as fs from 'fs';
import * as path from 'path';
import Parser from 'web-tree-sitter';
import { ASTBlastRadius } from '../types/index.js';
import { shouldIgnorePath } from '../config.js';

/**
 * ASTAnalyzer parses source files, extracts imports and exports, and calculates the blast radius.
 */
export class ASTAnalyzer {
  private isParserReady: boolean = false;
  private importMap: Map<string, Set<string>> = new Map(); // file -> files it imports
  private reverseDependencyMap: Map<string, Set<string>> = new Map(); // file -> files that import it
  private exportMap: Map<string, Set<string>> = new Map(); // file -> exported symbols

  /**
   * Initializes the Web-Tree-Sitter WASM engine.
   */
  public async initialize(): Promise<void> {
    try {
      await Parser.init();
      this.isParserReady = true;
    } catch (err) {
      console.warn('[ReMem AST] web-tree-sitter initialization fallback to regex parser:', err);
      this.isParserReady = false;
    }
  }

  /**
   * Extracts imported module/relative paths and symbols from a file's content.
   */
  public extractImports(content: string): string[] {
    const imports: string[] = [];

    // 1. ES6 import/export statements: import ... from '...'; export ... from '...';
    const es6ImportRegex = /(?:import|export)\s+(?:[\w\s{},*]+from\s+)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = es6ImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // 2. CommonJS require statements: require('...')
    const cjsRequireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = cjsRequireRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // 3. Dynamic imports: import('...')
    const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // 4. Python imports: from ... import ... or import ...
    const pythonImportRegex = /(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/g;
    while ((match = pythonImportRegex.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }

    return Array.from(new Set(imports));
  }

  /**
   * Extracts exported symbols from a file's content.
   */
  public extractExports(content: string): string[] {
    const exports: string[] = [];
    const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([a-zA-Z0-9_$]+)/g;

    let match: RegExpExecArray | null;
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }

    return Array.from(new Set(exports));
  }

  /**
   * Resolves an import string to an absolute file path within the workspace.
   */
  public resolveImportPath(fromFilePath: string, importString: string): string | null {
    // Only resolve relative project imports (starting with . or /)
    if (!importString.startsWith('.')) {
      return null;
    }

    const dir = path.dirname(fromFilePath);
    const candidatePath = path.resolve(dir, importString);

    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '/index.ts', '/index.js'];

    // Try stripping existing .js extension for TS imports (e.g. ./config.js -> ./config.ts)
    const baseCandidate = candidatePath.replace(/\.js$/, '');

    for (const ext of extensions) {
      const fullPathWithExt = candidatePath + ext;
      if (fs.existsSync(fullPathWithExt) && !fs.statSync(fullPathWithExt).isDirectory()) {
        return fullPathWithExt;
      }

      const tsCandidate = baseCandidate + ext;
      if (fs.existsSync(tsCandidate) && !fs.statSync(tsCandidate).isDirectory()) {
        return tsCandidate;
      }
    }

    return null;
  }

  /**
   * Scans and builds the in-memory dependency graph for the entire workspace.
   */
  public async buildDependencyGraph(workspaceRoot: string): Promise<void> {
    this.importMap.clear();
    this.reverseDependencyMap.clear();
    this.exportMap.clear();

    const scanDirectory = (dir: string) => {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = path.join(dir, item.name);
          if (shouldIgnorePath(fullPath)) continue;

          if (item.isDirectory()) {
            scanDirectory(fullPath);
          } else if (item.isFile()) {
            this.processFileDependencies(fullPath);
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    };

    scanDirectory(workspaceRoot);
  }

  /**
   * Processes dependencies for a single file and updates maps.
   */
  public processFileDependencies(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const rawImports = this.extractImports(content);
      const exports = this.extractExports(content);

      this.exportMap.set(filePath, new Set(exports));

      const resolvedImports = new Set<string>();

      for (const rawImport of rawImports) {
        const resolved = this.resolveImportPath(filePath, rawImport);
        if (resolved) {
          resolvedImports.add(resolved);

          // Update reverse dependency map (resolved -> imported by filePath)
          if (!this.reverseDependencyMap.has(resolved)) {
            this.reverseDependencyMap.set(resolved, new Set());
          }
          this.reverseDependencyMap.get(resolved)!.add(filePath);
        }
      }

      this.importMap.set(filePath, resolvedImports);
    } catch {
      // Ignore binary or unreadable files
    }
  }

  /**
   * Returns all files that depend on (import) the specified file path ("blast radius").
   */
  public getDependentFiles(targetFilePath: string): string[] {
    const dependents = this.reverseDependencyMap.get(targetFilePath);
    if (!dependents) {
      return [];
    }
    return Array.from(dependents);
  }

  /**
   * Returns complete AST Blast Radius analysis for a file.
   */
  public getBlastRadius(targetFilePath: string): ASTBlastRadius {
    const imports = this.importMap.get(targetFilePath);
    const exports = this.exportMap.get(targetFilePath);
    const dependents = this.reverseDependencyMap.get(targetFilePath);

    return {
      sourceFile: targetFilePath,
      imports: imports ? Array.from(imports) : [],
      exports: exports ? Array.from(exports) : [],
      dependents: dependents ? Array.from(dependents) : [],
      lastParsed: Date.now(),
    };
  }

  public get isReady(): boolean {
    return this.isParserReady;
  }
}
