import * as fs from 'fs';
import * as path from 'path';
import Parser from 'web-tree-sitter';
import { ASTBlastRadius } from '../types/index.js';
import { shouldIgnorePath } from '../config.js';
import { AsyncASTParser } from './asyncParser.js';

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
      // `moduleURL` tells web-tree-sitter where to find tree-sitter.wasm at runtime.
      // esbuild copies the file to out/tree-sitter.wasm alongside out/extension.js.
      const wasmPath = path.join(__dirname, 'tree-sitter.wasm');
      await Parser.init({ moduleURL: wasmPath });
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
   * Scans and builds the in-memory dependency graph for the entire workspace
   * completely asynchronously without blocking the VS Code main IDE thread.
   */
  public async buildDependencyGraph(workspaceRoot: string): Promise<void> {
    this.importMap.clear();
    this.reverseDependencyMap.clear();
    this.exportMap.clear();

    const fileList: string[] = [];

    const collectFilesAsync = async (dir: string): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (shouldIgnorePath(fullPath)) continue;

          if (entry.isDirectory()) {
            await collectFilesAsync(fullPath);
          } else if (entry.isFile()) {
            fileList.push(fullPath);
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    };

    await collectFilesAsync(workspaceRoot);

    // Process files in non-blocking slices of 10 to keep the IDE thread responsive
    const BATCH_SIZE = 10;
    for (let i = 0; i < fileList.length; i += BATCH_SIZE) {
      const batch = fileList.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((filePath) => this.processFileDependenciesAsync(filePath)));
      // Yield to the event loop between batches
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Asynchronously processes dependencies for a file using worker_threads / non-blocking parsing.
   */
  public async processFileDependenciesAsync(filePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const parser = AsyncASTParser.getInstance();
      const relativePath = path.basename(filePath);
      const parsed = await parser.parseAsync(filePath, relativePath, content);

      this.exportMap.set(filePath, new Set(parsed.exports));

      const resolvedImports = new Set<string>();
      for (const rawImport of parsed.imports) {
        const resolved = this.resolveImportPath(filePath, rawImport);
        if (resolved) {
          resolvedImports.add(resolved);

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
   * Processes dependencies for a single file and updates maps synchronously (fallback).
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

  /**
   * Returns known exported symbols for a file.
   */
  public getExports(filePath: string): string[] {
    const exports = this.exportMap.get(filePath);
    return exports ? Array.from(exports) : [];
  }

  /**
   * Returns resolved imported file paths for a file.
   */
  public getImports(filePath: string): string[] {
    const imports = this.importMap.get(filePath);
    return imports ? Array.from(imports) : [];
  }

  /**
   * Extracts named imports with their import sources from file content.
   */
  public extractNamedImports(content: string): { symbol: string; fromPath: string }[] {
    const namedImports: { symbol: string; fromPath: string }[] = [];
    const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = namedImportRegex.exec(content)) !== null) {
      const rawSymbols = match[1];
      const fromPath = match[2];
      const symbols = rawSymbols
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s.length > 0 && s !== 'type');
      for (const symbol of symbols) {
        namedImports.push({ symbol, fromPath });
      }
    }
    return namedImports;
  }
}
