import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from '../database/index.js';
import { ASTAnalyzer } from '../ast/analyzer.js';
import { publishAtomic, isWorkspacePath, withAsyncFileLock } from '../core/files.js';
import { shouldIgnorePath, CONFIG } from '../config.js';

/**
 * Persistent Knowledge Graph Engine
 *
 * Extracts dependency and symbol mapping from the isolated SQLite ledger (cuttlehawk_ledger.sqlite)
 * and AST analyzer, compressing it into a token-efficient architecture map persisted at
 * `.cuttlehawk_context_feed.md` in the workspace root.
 *
 * Updates silently in the background on file saves without blocking the IDE or triggering
 * file-watcher infinite loops.
 */
export class KnowledgeGraphEngine {
  private workspaceRoot: string;
  private dbManager: DatabaseManager;
  private astAnalyzer?: ASTAnalyzer;

  constructor(workspaceRoot: string, dbManager: DatabaseManager, astAnalyzer?: ASTAnalyzer) {
    this.workspaceRoot = workspaceRoot;
    this.dbManager = dbManager;
    this.astAnalyzer = astAnalyzer;
  }

  /**
   * Generates the highly compressed project architecture map string.
   */
  public async generateCompressedArchitectureMap(): Promise<string> {
    const sqlite = this.dbManager.sqlite;
    const [dependencies, exports, summaries] = await Promise.all([
      sqlite.query('getAllDependencies'),
      sqlite.query('getAllExports'),
      sqlite.query('getAllFileSummaries'),
    ]);

    // Map: relative file path -> { imports: Set<string>, exports: Set<string>, summary?: string }
    const fileGraph = new Map<
      string,
      {
        imports: Set<string>;
        dependents: Set<string>;
        exports: Set<string>;
        summary?: string;
      }
    >();

    const getOrInitNode = (relPath: string) => {
      let node = fileGraph.get(relPath);
      if (!node) {
        node = {
          imports: new Set<string>(),
          dependents: new Set<string>(),
          exports: new Set<string>(),
        };
        fileGraph.set(relPath, node);
      }
      return node;
    };

    // 1. Ingest summaries
    for (const s of summaries) {
      const rel = s.relativePath || path.relative(this.workspaceRoot, s.filePath);
      if (this.isInternalOrSpecial(rel)) continue;
      const node = getOrInitNode(rel);
      node.summary = s.summary;
    }

    // 2. Ingest dependencies from SQLite
    for (const dep of dependencies) {
      const srcRel = path.relative(this.workspaceRoot, dep.sourceFile);
      const impRel = path.relative(this.workspaceRoot, dep.importedFile);

      if (this.isInternalOrSpecial(srcRel) || this.isInternalOrSpecial(impRel)) continue;

      const srcNode = getOrInitNode(srcRel);
      srcNode.imports.add(impRel);

      const impNode = getOrInitNode(impRel);
      impNode.dependents.add(srcRel);
    }

    // 3. Ingest exports from SQLite
    for (const exp of exports) {
      const rel = path.relative(this.workspaceRoot, exp.filePath);
      if (this.isInternalOrSpecial(rel)) continue;
      const node = getOrInitNode(rel);
      node.exports.add(exp.symbol);
    }

    // 4. Merge in-memory ASTAnalyzer if SQLite records are sparse
    if (this.astAnalyzer) {
      for (const [fileRel, node] of fileGraph.entries()) {
        const fullPath = path.resolve(this.workspaceRoot, fileRel);
        if (node.exports.size === 0) {
          const analyzerExports = this.astAnalyzer.getExports(fullPath);
          for (const sym of analyzerExports) {
            node.exports.add(sym);
          }
        }
        if (node.imports.size === 0) {
          const analyzerImports = this.astAnalyzer.getImports(fullPath);
          for (const impPath of analyzerImports) {
            const impRel = path.relative(this.workspaceRoot, impPath);
            if (!this.isInternalOrSpecial(impRel)) {
              node.imports.add(impRel);
            }
          }
        }
      }
    }

    // Build compressed output
    const lines: string[] = [];
    const projectName = path.basename(this.workspaceRoot);
    const timestamp = new Date().toISOString();
    const totalNodes = fileGraph.size;
    let totalEdges = 0;
    for (const node of fileGraph.values()) {
      totalEdges += node.imports.size;
    }

    lines.push('# 🗺️ CUTTLEHAWK PERSISTENT KNOWLEDGE GRAPH (`.cuttlehawk_context_feed.md`)');
    lines.push(`> Project: \`${projectName}\` | Synced: ${timestamp} | Nodes: ${totalNodes} | Edges: ${totalEdges}`);
    lines.push('');
    lines.push('## 📦 MODULE TOPOLOGY & EXPORTED SYMBOLS');

    // Sort files alphabetically for deterministic output
    const sortedFiles = Array.from(fileGraph.keys()).sort();

    for (const file of sortedFiles) {
      const node = fileGraph.get(file)!;
      const summaryPart = node.summary ? ` — *${node.summary}*` : '';
      lines.push(`- **\`${file}\`**${summaryPart}`);

      if (node.exports.size > 0) {
        const symbols = Array.from(node.exports).slice(0, 10).join(', ');
        const more = node.exports.size > 10 ? ` (+${node.exports.size - 10} more)` : '';
        lines.push(`  ↳ exports: [${symbols}${more}]`);
      }

      if (node.imports.size > 0) {
        const importsList = Array.from(node.imports).slice(0, 10).join(', ');
        const more = node.imports.size > 10 ? ` (+${node.imports.size - 10} more)` : '';
        lines.push(`  ↳ imports: [${importsList}${more}]`);
      }

      if (node.dependents.size > 0) {
        const depList = Array.from(node.dependents).slice(0, 6).join(', ');
        const more = node.dependents.size > 6 ? ` (+${node.dependents.size - 6} more)` : '';
        lines.push(`  ↳ required by: [${depList}${more}]`);
      }
    }

    lines.push('');
    lines.push('## 🔗 COMPACT DEPENDENCY MATRIX');
    for (const file of sortedFiles) {
      const node = fileGraph.get(file)!;
      if (node.imports.size > 0) {
        const targetList = Array.from(node.imports).join(', ');
        lines.push(`\`${file}\` → [${targetList}]`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Updates `.cuttlehawk_context_feed.md` silently in the background.
   */
  public async updateContextFeedSilently(signal?: AbortSignal): Promise<string> {
    const feedPath = path.join(this.workspaceRoot, CONFIG.CONTEXT_FEED_FILE_NAME);
    return withAsyncFileLock(feedPath, async (assertOwner) => {
      if (!isWorkspacePath(this.workspaceRoot, feedPath)) throw new Error('Unsafe context feed path');
      const content = await this.generateCompressedArchitectureMap();
      await publishAtomic(feedPath, content, async () => {
        signal?.throwIfAborted();
        await assertOwner();
      });
      return content;
    }, signal);
  }

  /**
   * Reads or generates the current context feed content.
   */
  public async getOrGenerateContextFeed(persistIfMissing = true): Promise<string> {
    const feedPath = path.join(this.workspaceRoot, CONFIG.CONTEXT_FEED_FILE_NAME);
    const legacyFeedPath = path.join(this.workspaceRoot, CONFIG.LEGACY_CONTEXT_FEED_FILE_NAME);
    if (!isWorkspacePath(this.workspaceRoot, feedPath)) throw new Error('Unsafe context feed path');
    try {
      if (fs.existsSync(feedPath)) {
        return await fs.promises.readFile(feedPath, 'utf8');
      } else if (fs.existsSync(legacyFeedPath) && isWorkspacePath(this.workspaceRoot, legacyFeedPath)) {
        return await fs.promises.readFile(legacyFeedPath, 'utf8');
      }
    } catch {
      // Fall through to generation
    }
    return persistIfMissing ? this.updateContextFeedSilently() : this.generateCompressedArchitectureMap();
  }

  private isInternalOrSpecial(relPath: string): boolean {
    const file = path.resolve(this.workspaceRoot, relPath);
    return !isWorkspacePath(this.workspaceRoot, file) || shouldIgnorePath(file) || !fs.existsSync(file);
  }
}
