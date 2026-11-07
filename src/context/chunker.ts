import * as fs from 'fs';
import * as path from 'path';
import Parser from 'web-tree-sitter';
import { ASTChunk } from '../types/index.js';
import { VectorSearchEngine } from '../database/vector.js';
import { AsyncASTParser } from '../ast/asyncParser.js';

let isParserInitialized = false;

/**
 * Initializes web-tree-sitter WASM runtime safely.
 */
async function initTreeSitter(): Promise<boolean> {
  if (isParserInitialized) {
    return true;
  }
  try {
    const wasmPath = path.join(__dirname, 'tree-sitter.wasm');
    const altWasmPath = path.join(__dirname, '..', 'tree-sitter.wasm');
    const resolvedPath = fs.existsSync(wasmPath) ? wasmPath : (fs.existsSync(altWasmPath) ? altWasmPath : wasmPath);
    await Parser.init({ moduleURL: resolvedPath });
    isParserInitialized = true;
    return true;
  } catch (err) {
    // Parser might have already been initialized elsewhere in the extension
    isParserInitialized = true;
    return false;
  }
}

/**
 * AST Context Chunker
 * Deconstructs files into individual functions, interfaces, and classes using
 * web-tree-sitter with high-performance structural extraction fallbacks.
 * Enables granular chunk indexing into @orama/orama and ultra-compact AI prompt injection.
 *
 * RAM Expansion (v1.0.0): maxChunkLines raised from 45 → 80 and class condensation
 * threshold lifted from 25 → 40 method signatures per class.  Combined with the
 * ORAMA_BATCH_SIZE=500 / MAX_RAM_BUDGET_BYTES=100MB constants in vector.ts this
 * allows the AST worker threads to process significantly larger files without
 * hitting aggressive GC pauses.
 */
export class ASTContextChunker {
  private isReady: boolean = false;
  /**
   * Maximum lines kept per chunk before truncation.
   * Raised to 80 (from 45) to reduce GC pressure on large files and give
   * the AST worker threads more breathing room within the 100MB RAM budget.
   */
  private maxChunkLines: number = 80;

  public get isInitialized(): boolean {
    return this.isReady;
  }

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    try {
      await initTreeSitter();
      this.isReady = true;
    } catch {
      this.isReady = false;
    }
  }

  /**
   * Chunks file content into distinct functions, interfaces, and classes.
   */
  public extractChunks(filePath: string, relativePath: string, content: string): ASTChunk[] {
    const ext = path.extname(filePath).toLowerCase();
    const chunks: ASTChunk[] = [];
    const lines = content.split(/\r?\n/);

    // Markdown / JSON handling: single structural chunk
    if (ext === '.md' || ext === '.txt' || ext === '.json') {
      const preview = lines.slice(0, 30).join('\n');
      chunks.push({
        id: `${relativePath}#file`,
        filePath,
        relativePath,
        name: path.basename(filePath),
        kind: 'type',
        startLine: 1,
        endLine: Math.min(lines.length, 30),
        signature: `${path.basename(filePath)} (${lines.length} lines)`,
        content: preview,
        tokenEstimate: Math.ceil(preview.length / 4),
      });
      return chunks;
    }

    // Source code languages (TypeScript, JavaScript, Python, Go, Rust, etc.)
    // 1. Interfaces & Types
    const interfaceRegex = /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?\s*\{/gm;
    let match: RegExpExecArray | null;

    while ((match = interfaceRegex.exec(content)) !== null) {
      const name = match[1];
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      const extracted = this.extractBraceBlock(content, match.index);

      if (extracted) {
        const chunkContent = this.capChunkContent(extracted.block);
        chunks.push({
          id: `${relativePath}#interface:${name}`,
          filePath,
          relativePath,
          name,
          kind: 'interface',
          startLine,
          endLine: startLine + extracted.lineCount - 1,
          signature: match[0].replace(/\s*\{$/, ''),
          content: chunkContent,
          tokenEstimate: Math.ceil(chunkContent.length / 4),
        });
      }
    }

    // 2. Type Aliases
    const typeRegex = /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?\s*=\s*([^;]+);/gm;
    while ((match = typeRegex.exec(content)) !== null) {
      const name = match[1];
      const startLine = content.substring(0, match.index).split(/\r?\n/).length;
      const chunkContent = match[0].trim();
      chunks.push({
        id: `${relativePath}#type:${name}`,
        filePath,
        relativePath,
        name,
        kind: 'type',
        startLine,
        endLine: startLine + chunkContent.split(/\r?\n/).length - 1,
        signature: `type ${name}`,
        content: chunkContent,
        tokenEstimate: Math.ceil(chunkContent.length / 4),
      });
    }

    // 3. Classes
    const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      const extracted = this.extractBraceBlock(content, match.index);

      if (extracted) {
        // Extract class declaration and public method signatures to keep tokens minimal
        const signature = match[0].replace(/\s*\{$/, '');
        const condensedClass = this.summarizeClassBody(signature, extracted.block);
        const chunkContent = this.capChunkContent(condensedClass);

        chunks.push({
          id: `${relativePath}#class:${name}`,
          filePath,
          relativePath,
          name,
          kind: 'class',
          startLine,
          endLine: startLine + extracted.lineCount - 1,
          signature,
          content: chunkContent,
          tokenEstimate: Math.ceil(chunkContent.length / 4),
        });
      }
    }

    // 4. Standalone and Exported Functions (TS/JS/Python)
    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s*(\*?\s*[A-Za-z0-9_$]+)\s*\(([^)]*)\)(?::\s*[^{]+)?\s*\{/gm;
    while ((match = functionRegex.exec(content)) !== null) {
      const rawName = match[1].replace(/^\*\s*/, '');
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      const extracted = this.extractBraceBlock(content, match.index);

      if (extracted) {
        const chunkContent = this.capChunkContent(extracted.block);
        chunks.push({
          id: `${relativePath}#function:${rawName}`,
          filePath,
          relativePath,
          name: rawName,
          kind: 'function',
          startLine,
          endLine: startLine + extracted.lineCount - 1,
          signature: match[0].replace(/\s*\{$/, ''),
          content: chunkContent,
          tokenEstimate: Math.ceil(chunkContent.length / 4),
        });
      }
    }

    // 5. Const Arrow Functions: export const foo = async (...) => { ... }
    const arrowFuncRegex = /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)(?::\s*[^{=]+)?\s*=>\s*\{/gm;
    while ((match = arrowFuncRegex.exec(content)) !== null) {
      const name = match[1];
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      const extracted = this.extractBraceBlock(content, match.index);

      if (extracted) {
        const chunkContent = this.capChunkContent(extracted.block);
        chunks.push({
          id: `${relativePath}#function:${name}`,
          filePath,
          relativePath,
          name,
          kind: 'function',
          startLine,
          endLine: startLine + extracted.lineCount - 1,
          signature: match[0].replace(/\s*\{$/, ''),
          content: chunkContent,
          tokenEstimate: Math.ceil(chunkContent.length / 4),
        });
      }
    }

    // 6. Python Functions: def foo(...) or async def foo(...)
    const pythonFuncRegex = /^(?:async\s+)?def\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)(?:\s*->\s*[^:]+)?:/gm;
    while ((match = pythonFuncRegex.exec(content)) !== null) {
      const name = match[1];
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      const pyBlock = this.extractPythonIndentedBlock(lines, startLine - 1);

      chunks.push({
        id: `${relativePath}#function:${name}`,
        filePath,
        relativePath,
        name,
        kind: 'function',
        startLine,
        endLine: startLine + pyBlock.split(/\r?\n/).length - 1,
        signature: match[0].replace(/:$/, ''),
        content: this.capChunkContent(pyBlock),
        tokenEstimate: Math.ceil(pyBlock.length / 4),
      });
    }

    // Fallback: If no AST chunks were matched in source code, return an overview chunk
    if (chunks.length === 0) {
      const sample = lines.slice(0, 35).join('\n');
      chunks.push({
        id: `${relativePath}#module`,
        filePath,
        relativePath,
        name: path.basename(filePath),
        kind: 'type',
        startLine: 1,
        endLine: Math.min(lines.length, 35),
        signature: path.basename(filePath),
        content: sample,
        tokenEstimate: Math.ceil(sample.length / 4),
      });
    }

    return chunks;
  }

  /**
   * Indexes extracted AST chunks into Orama vector search engine.
   */
  /**
   * Asynchronously extracts AST code chunks off the main thread via worker_threads.
   */
  public async extractChunksAsync(filePath: string, relativePath: string, content: string): Promise<ASTChunk[]> {
    try {
      const parser = AsyncASTParser.getInstance();
      const result = await parser.parseAsync(filePath, relativePath, content);
      if (result.chunks && result.chunks.length > 0) {
        return result.chunks;
      }
    } catch {
      // Fallback to sync extraction
    }
    return this.extractChunks(filePath, relativePath, content);
  }

  public async indexFileChunks(
    filePath: string,
    relativePath: string,
    content: string,
    vectorEngine: VectorSearchEngine
  ): Promise<ASTChunk[]> {
    // Remove previous chunks for this file
    await vectorEngine.removeChunksForFile(filePath);

    const chunks = await this.extractChunksAsync(filePath, relativePath, content);
    await vectorEngine.indexChunks(chunks);

    return chunks;
  }

  /**
   * Retrieves the most relevant AST chunks for prompt injection.
   * Limits results to keep token consumption extremely lean.
   */
  public async getRelevantChunks(
    activeFilePath: string,
    vectorEngine: VectorSearchEngine,
    options: {
      query?: string;
      maxChunks?: number;
      fileContent?: string;
      relativePath?: string;
    } = {}
  ): Promise<ASTChunk[]> {
    const maxChunks = options.maxChunks || 3;

    // If query provided, search Orama for relevant chunks across workspace
    if (options.query && options.query.trim().length > 0) {
      const searchHits = await vectorEngine.searchChunks(options.query, maxChunks);
      if (searchHits.length > 0) {
        return searchHits.map((h) => ({
          id: h.document.chunkId,
          filePath: h.document.filePath,
          relativePath: h.document.relativePath,
          name: h.document.name,
          kind: (h.document.kind as any) || 'function',
          startLine: 1,
          endLine: 1,
          signature: h.document.signature,
          content: h.document.content,
          tokenEstimate: Math.ceil(h.document.content.length / 4),
        }));
      }
    }

    // Otherwise, extract and return the top AST chunks from active file
    if (options.fileContent && options.relativePath) {
      const chunks = this.extractChunks(activeFilePath, options.relativePath, options.fileContent);
      return chunks.slice(0, maxChunks);
    }

    if (fs.existsSync(activeFilePath)) {
      try {
        const content = fs.readFileSync(activeFilePath, 'utf8');
        const relPath = path.basename(activeFilePath);
        const chunks = this.extractChunks(activeFilePath, relPath, content);
        return chunks.slice(0, maxChunks);
      } catch {
        // read error
      }
    }

    return [];
  }

  /**
   * Helper: extracts matching balanced brace block {...} from start index.
   */
  private extractBraceBlock(text: string, startIndex: number): { block: string; lineCount: number } | null {
    const firstBrace = text.indexOf('{', startIndex);
    if (firstBrace === -1) return null;

    let depth = 0;
    let inString: string | null = null;
    let inComment = false;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];
      const prev = i > 0 ? text[i - 1] : '';

      // Skip comment blocks
      if (!inString && char === '/' && text[i + 1] === '*') {
        inComment = true;
        i++;
        continue;
      }
      if (inComment && char === '*' && text[i + 1] === '/') {
        inComment = false;
        i++;
        continue;
      }
      if (inComment) continue;

      // Skip strings
      if ((char === "'" || char === '"' || char === '`') && prev !== '\\') {
        if (!inString) inString = char;
        else if (inString === char) inString = null;
        continue;
      }
      if (inString) continue;

      // Depth count
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          const block = text.substring(startIndex, i + 1);
          const lineCount = block.split(/\r?\n/).length;
          return { block, lineCount };
        }
      }
    }

    return null;
  }

  /**
   * Helper: extracts Python indented block starting from def line.
   */
  private extractPythonIndentedBlock(lines: string[], startLineIdx: number): string {
    const result: string[] = [lines[startLineIdx]];
    const baseIndent = lines[startLineIdx].search(/\S/);

    for (let i = startLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) {
        result.push(line);
        continue;
      }
      const lineIndent = line.search(/\S/);
      if (lineIndent <= baseIndent) {
        break; // Out of block
      }
      result.push(line);
      if (result.length >= this.maxChunkLines) {
        result.push('    # ... [truncated for token efficiency]');
        break;
      }
    }

    return result.join('\n');
  }

  /**
   * Condenses a class block into its declaration and method signatures.
   */
  private summarizeClassBody(signature: string, classBlock: string): string {
    const lines = classBlock.split(/\r?\n/);
    if (lines.length <= this.maxChunkLines) {
      return classBlock;
    }

    // Keep class signature + public method signatures
    const condensed: string[] = [signature + ' {'];
    const methodRegex = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([a-zA-Z0-9_$]+)\s*\([^)]*\)(?::\s*[^;{]+)?/g;

    for (let i = 1; i < lines.length - 1; i++) {
      const line = lines[i];
      if (methodRegex.test(line)) {
        condensed.push(line.replace(/\{.*$/, '').trimEnd() + ';');
      }
      if (condensed.length >= 40) {
        condensed.push('  // ... [additional methods omitted for token optimization]');
        break;
      }
    }
    condensed.push('}');
    return condensed.join('\n');
  }

  /**
   * Caps chunk line length to maintain strict token budget.
   */
  private capChunkContent(content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.length <= this.maxChunkLines) {
      return content;
    }
    const truncated = lines.slice(0, this.maxChunkLines);
    truncated.push('  // ... [remaining implementation truncated for token optimization]');
    if (lines[lines.length - 1].trim() === '}') {
      truncated.push('}');
    }
    return truncated.join('\n');
  }
}
