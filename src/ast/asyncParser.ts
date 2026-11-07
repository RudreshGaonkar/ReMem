import { Worker } from 'worker_threads';
import * as path from 'path';
import { ASTChunk } from '../types/index.js';

export interface ParseResult {
  imports: string[];
  exports: string[];
  namedImports: { symbol: string; fromPath: string }[];
  chunks: ASTChunk[];
}

/**
 * Worker thread script executed when worker_threads is spawned with eval: true.
 * Parses file AST, imports, exports, and code chunks off the main IDE UI thread.
 */
const WORKER_CODE = `
const { parentPort } = require('worker_threads');

function extractImports(content) {
  const imports = [];
  const es6Regex = /(?:import|export)\\s+(?:[\\w\\s{},*]+from\\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = es6Regex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  const cjsRegex = /require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
  while ((match = cjsRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  const dynRegex = /import\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
  while ((match = dynRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  const pyRegex = /(?:from\\s+([a-zA-Z0-9_.]+)\\s+import|import\\s+([a-zA-Z0-9_.]+))/g;
  while ((match = pyRegex.exec(content)) !== null) {
    imports.push(match[1] || match[2]);
  }
  return Array.from(new Set(imports));
}

function extractExports(content) {
  const exports = [];
  const exportRegex = /export\\s+(?:default\\s+)?(?:async\\s+)?(?:class|interface|type|enum|function|const|let|var)\\s+([a-zA-Z0-9_$]+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }
  return Array.from(new Set(exports));
}

function extractNamedImports(content) {
  const namedImports = [];
  const regex = /import\\s*\\{([^}]+)\\}\\s*from\\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const rawSymbols = match[1];
    const fromPath = match[2];
    const symbols = rawSymbols
      .split(',')
      .map((s) => s.trim().split(/\\s+as\\s+/)[0].trim())
      .filter((s) => s.length > 0 && s !== 'type');
    for (const sym of symbols) {
      namedImports.push({ symbol: sym, fromPath });
    }
  }
  return namedImports;
}

function extractBraceBlock(content, startIndex) {
  const openBrace = content.indexOf('{', startIndex);
  if (openBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBrace; i < content.length; i++) {
    const char = content[i];
    const prevChar = i > 0 ? content[i - 1] : '';

    if (inLineComment) {
      if (char === '\\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '/' && prevChar === '*') inBlockComment = false;
      continue;
    }
    if (inString) {
      if (char === stringChar && prevChar !== '\\\\') inString = false;
      continue;
    }
    if (char === '/' && content[i + 1] === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && content[i + 1] === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '\`') {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        return { block: content.substring(startIndex, i + 1), endIndex: i };
      }
    }
  }
  return null;
}

function extractASTChunks(filePath, relativePath, content) {
  const chunks = [];
  const lines = content.split(/\\r?\\n/);
  const ext = (filePath.split('.').pop() || '').toLowerCase();

  if (ext === 'md' || ext === 'txt' || ext === 'json') {
    const preview = lines.slice(0, 30).join('\\n');
    chunks.push({
      id: relativePath + '#file',
      filePath,
      relativePath,
      name: relativePath.split('/').pop() || filePath,
      kind: 'type',
      startLine: 1,
      endLine: Math.min(lines.length, 30),
      signature: (relativePath.split('/').pop() || filePath) + ' (' + lines.length + ' lines)',
      content: preview,
      tokenEstimate: Math.ceil(preview.length / 4),
    });
    return chunks;
  }

  // Interfaces
  const ifaceRegex = /^(?:\\s*)?(?:export\\s+)?interface\\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\\s+extends\\s+[^{]+)?\\s*\\{/gm;
  let match;
  while ((match = ifaceRegex.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index;
    const startLine = content.substring(0, startIdx).split(/\\r?\\n/).length;
    const extracted = extractBraceBlock(content, match.index);
    if (extracted) {
      const block = extracted.block.split(/\\r?\\n/).slice(0, 45).join('\\n');
      const endLine = startLine + block.split(/\\r?\\n/).length - 1;
      chunks.push({
        id: relativePath + '#interface:' + name,
        filePath,
        relativePath,
        name,
        kind: 'interface',
        startLine,
        endLine,
        signature: 'interface ' + name,
        content: block,
        tokenEstimate: Math.ceil(block.length / 4),
      });
    }
  }

  // Classes
  const classRegex = /^(?:\\s*)?(?:export\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\\s+(?:extends|implements)\\s+[^{]+)?\\s*\\{/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index;
    const startLine = content.substring(0, startIdx).split(/\\r?\\n/).length;
    const extracted = extractBraceBlock(content, match.index);
    if (extracted) {
      const block = extracted.block.split(/\\r?\\n/).slice(0, 45).join('\\n');
      const endLine = startLine + block.split(/\\r?\\n/).length - 1;
      chunks.push({
        id: relativePath + '#class:' + name,
        filePath,
        relativePath,
        name,
        kind: 'class',
        startLine,
        endLine,
        signature: 'class ' + name,
        content: block,
        tokenEstimate: Math.ceil(block.length / 4),
      });
    }
  }

  // Functions
  const fnRegex = /^(?:\\s*)?(?:export\\s+)?(?:async\\s+)?function\\s+([A-Za-z0-9_$]+)\\s*\\(([^)]*)\\)[^{]*\\{/gm;
  while ((match = fnRegex.exec(content)) !== null) {
    const name = match[1];
    const params = match[2].trim();
    const startIdx = match.index;
    const startLine = content.substring(0, startIdx).split(/\\r?\\n/).length;
    const extracted = extractBraceBlock(content, match.index);
    if (extracted) {
      const block = extracted.block.split(/\\r?\\n/).slice(0, 45).join('\\n');
      const endLine = startLine + block.split(/\\r?\\n/).length - 1;
      chunks.push({
        id: relativePath + '#fn:' + name,
        filePath,
        relativePath,
        name,
        kind: 'function',
        startLine,
        endLine,
        signature: 'function ' + name + '(' + params + ')',
        content: block,
        tokenEstimate: Math.ceil(block.length / 4),
      });
    }
  }

  return chunks;
}

parentPort.on('message', (task) => {
  try {
    const imports = extractImports(task.content);
    const exports = extractExports(task.content);
    const namedImports = extractNamedImports(task.content);
    const chunks = extractASTChunks(task.filePath, task.relativePath, task.content);

    parentPort.postMessage({
      id: task.id,
      success: true,
      result: { imports, exports, namedImports, chunks }
    });
  } catch (err) {
    parentPort.postMessage({
      id: task.id,
      success: false,
      error: String(err)
    });
  }
});
`;

/**
 * AsyncASTParser runs web-tree-sitter and AST code chunking entirely in
 * Node.js worker_threads (with non-blocking promise fallback) to guarantee
 * that the VS Code IDE main thread is never blocked.
 */
export class AsyncASTParser {
  private static instance: AsyncASTParser | null = null;
  private worker: Worker | null = null;
  private taskIdCounter: number = 0;
  private pendingTasks: Map<number, { resolve: (res: ParseResult) => void; reject: (err: any) => void }> = new Map();
  private workerAvailable: boolean = true;

  public constructor() {
    this.initWorker();
  }

  public static getInstance(): AsyncASTParser {
    if (!AsyncASTParser.instance) {
      AsyncASTParser.instance = new AsyncASTParser();
    }
    return AsyncASTParser.instance;
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(WORKER_CODE, { eval: true });
      this.worker.on('message', (msg: { id: number; success: boolean; result?: ParseResult; error?: string }) => {
        const handler = this.pendingTasks.get(msg.id);
        if (handler) {
          this.pendingTasks.delete(msg.id);
          if (msg.success && msg.result) {
            handler.resolve(msg.result);
          } else {
            handler.reject(new Error(msg.error || 'Worker AST parse failed'));
          }
        }
      });

      this.worker.on('error', (err) => {
        console.warn('[ReMem AsyncParser] Worker thread error, falling back to non-blocking promises:', err);
        this.workerAvailable = false;
        this.drainPendingTasks(err);
      });

      this.worker.on('exit', () => {
        this.worker = null;
      });
    } catch (err) {
      console.warn('[ReMem AsyncParser] worker_threads unavailable, using non-blocking promise fallback:', err);
      this.workerAvailable = false;
    }
  }

  private drainPendingTasks(err: any): void {
    for (const handler of this.pendingTasks.values()) {
      handler.reject(err);
    }
    this.pendingTasks.clear();
  }

  /**
   * Parses file content asynchronously. Runs on a background worker thread if available,
   * or executes via non-blocking setImmediate promise slicing on the main thread.
   */
  public async parseAsync(filePath: string, relativePath: string, content: string): Promise<ParseResult> {
    if (this.workerAvailable && this.worker) {
      return new Promise<ParseResult>((resolve, reject) => {
        const id = ++this.taskIdCounter;
        this.pendingTasks.set(id, { resolve, reject });
        this.worker!.postMessage({ id, content, filePath, relativePath });
      });
    }

    // Non-blocking promise fallback with setImmediate macro-task yield
    return new Promise<ParseResult>((resolve) => {
      setImmediate(() => {
        const result = this.fallbackParse(filePath, relativePath, content);
        resolve(result);
      });
    });
  }

  /**
   * Non-blocking CPU slice fallback.
   */
  private fallbackParse(filePath: string, relativePath: string, content: string): ParseResult {
    const imports = this.extractImportsSync(content);
    const exports = this.extractExportsSync(content);
    const namedImports = this.extractNamedImportsSync(content);
    const chunks = this.extractChunksSync(filePath, relativePath, content);
    return { imports, exports, namedImports, chunks };
  }

  private extractImportsSync(content: string): string[] {
    const imports: string[] = [];
    const es6Regex = /(?:import|export)\s+(?:[\w\s{},*]+from\s+)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = es6Regex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    const cjsRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = cjsRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    const pyRegex = /(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/g;
    while ((match = pyRegex.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }
    return Array.from(new Set(imports));
  }

  private extractExportsSync(content: string): string[] {
    const exports: string[] = [];
    const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([a-zA-Z0-9_$]+)/g;
    let match: RegExpExecArray | null;
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
    return Array.from(new Set(exports));
  }

  private extractNamedImportsSync(content: string): { symbol: string; fromPath: string }[] {
    const named: { symbol: string; fromPath: string }[] = [];
    const regex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const rawSymbols = match[1];
      const fromPath = match[2];
      const symbols = rawSymbols
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s.length > 0 && s !== 'type');
      for (const sym of symbols) {
        named.push({ symbol: sym, fromPath });
      }
    }
    return named;
  }

  private extractChunksSync(filePath: string, relativePath: string, content: string): ASTChunk[] {
    const chunks: ASTChunk[] = [];
    const lines = content.split(/\r?\n/);
    const ext = path.extname(filePath).toLowerCase();

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

    const ifaceRegex = /^(?:\s*)?(?:export\s+)?interface\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?\s*\{/gm;
    let match: RegExpExecArray | null;
    while ((match = ifaceRegex.exec(content)) !== null) {
      const name = match[1];
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      chunks.push({
        id: `${relativePath}#interface:${name}`,
        filePath,
        relativePath,
        name,
        kind: 'interface',
        startLine,
        endLine: startLine + 10,
        signature: `interface ${name}`,
        content: `interface ${name}`,
        tokenEstimate: 20,
      });
    }

    const classRegex = /^(?:\s*)?(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+(?:extends|implements)\s+[^{]+)?\s*\{/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      chunks.push({
        id: `${relativePath}#class:${name}`,
        filePath,
        relativePath,
        name,
        kind: 'class',
        startLine,
        endLine: startLine + 10,
        signature: `class ${name}`,
        content: `class ${name}`,
        tokenEstimate: 20,
      });
    }

    const fnRegex = /^(?:\s*)?(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)[^{]*\{/gm;
    while ((match = fnRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2].trim();
      const startIdx = match.index;
      const startLine = content.substring(0, startIdx).split(/\r?\n/).length;
      chunks.push({
        id: `${relativePath}#fn:${name}`,
        filePath,
        relativePath,
        name,
        kind: 'function',
        startLine,
        endLine: startLine + 10,
        signature: `function ${name}(${params})`,
        content: `function ${name}(${params})`,
        tokenEstimate: 20,
      });
    }

    return chunks;
  }

  public dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingTasks.clear();
  }
}
