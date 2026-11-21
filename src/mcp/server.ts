#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { watch } from 'chokidar';
import { parse } from 'jsonc-parser';
import { simpleGit } from 'simple-git';
import { AsyncASTParser } from '../ast/asyncParser.js';
import { ASTAnalyzer } from '../ast/analyzer.js';
import { assembleContext } from '../ast/injector.js';
import { ScratchpadManager } from '../ast/scratchpad.js';
import { shouldIgnorePath } from '../config.js';
import { drainWithin, WorkspaceWorkQueue } from '../core/workQueue.js';
import { isWorkspacePath } from '../core/files.js';
import { SecretShield } from '../core/ignore.js';
import { KnowledgeGraphEngine } from '../context/graph.js';
import { updateAgentInstructions } from '../context/instructions.js';
import { DatabaseManager } from '../database/index.js';
import { getFormattedErrorContext } from '../git/ledger.js';
import { indexWorkspace } from '../summarizer/indexer.js';
import { SummarizerPipeline } from '../summarizer/pipeline.js';
import { refreshIndexedFile } from '../summarizer/workspaceIndex.js';
import { SpecTaskTracker } from '../task/tracker.js';
import { LeanTraceabilityTracker } from '../task/traceability.js';
import { installSkillAndMcp } from './install.js';

declare const REMEM_VERSION: string;

const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fileInput = z.string().min(1).max(1024);
const branchInput = z.string().min(1).max(256);
const taskInput = z.string().min(1).max(500);
const log = { appendLine: (message: string) => console.error(message) };

async function serve(root: string, zeroFluffMode: boolean): Promise<void> {
  SecretShield.getInstance(root);
  const db = new DatabaseManager();
  const shutdown = new AbortController();
  const stopBoot = () => {
    shutdown.abort();
    void drainWithin(db.close()).then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  };
  process.once('SIGINT', stopBoot);
  process.once('SIGTERM', stopBoot);
  try {
    await db.initialize(root);
    shutdown.signal.throwIfAborted();
  } catch (error) {
    await db.close();
    if (shutdown.signal.aborted) return;
    throw error;
  } finally {
    process.removeListener('SIGINT', stopBoot);
    process.removeListener('SIGTERM', stopBoot);
  }
  const scratchpad = new ScratchpadManager(root);
  const git = simpleGit(root, { abort: shutdown.signal, timeout: { block: 2000 } });
  const analyzer = new ASTAnalyzer();
  const tracker = new LeanTraceabilityTracker(root, db, analyzer);
  const tasks = new SpecTaskTracker(root, scratchpad);
  const graph = new KnowledgeGraphEngine(root, db);
  const pipeline = new SummarizerPipeline(db);
  const branch = async (override?: string) => override ||
    await git.revparse(['--abbrev-ref', 'HEAD']).then((name) => name.trim(), () => 'main');

  function resolveFile(relative: string): string {
    const file = path.resolve(root, relative);
    if (file === root || !isWorkspacePath(root, file) || shouldIgnorePath(file)) {
      throw new Error('Expected a non-sensitive path inside the workspace.');
    }
    return file;
  }

  function publicPath(file: string): boolean {
    return isWorkspacePath(root, file) && !shouldIgnorePath(file) && fs.existsSync(file);
  }

  async function syncSession(): Promise<void> {
    await scratchpad.syncSessionState(db);
  }

  function zeroFluffEnabled(): boolean {
    if (zeroFluffMode) return true;
    const settings = path.join(root, '.vscode/settings.json');
    try {
      return isWorkspacePath(root, settings) && fs.existsSync(settings) &&
        parse(fs.readFileSync(settings, 'utf8'))?.['remem.ZeroFluffMode'] === true;
    } catch {
      return false;
    }
  }

  async function syncInstructions(): Promise<void> {
    try { await updateAgentInstructions(root, zeroFluffEnabled(), shutdown.signal); }
    catch (error) { console.error('[ReMem] Could not sync workspace instructions:', error); }
  }

  if (!fs.existsSync(path.join(root, 'AGENTS.md'))) void syncInstructions();
  const fileWatcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (file, stat) => file !== scratchpad.filePath && path.basename(file) !== '.remem_context_feed.md' &&
      (!isWorkspacePath(root, file) || shouldIgnorePath(file + (stat?.isDirectory() ? path.sep : ''))),
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  const rebuild = db.vector.needsRebuild;
  let indexing = true;
  let indexFailed = false;
  const initialIndex = indexWorkspace(root, db, pipeline, log, tracker, shutdown.signal)
    .then(async () => {
      if (rebuild) {
        await db.rehydrateVectorIndexFromSqlite();
        await db.vector.finishRecovery();
      }
      shutdown.signal.throwIfAborted();
      await tasks.syncProgress();
      await syncSession();
      await graph.updateContextFeedSilently(shutdown.signal);
    }).catch((error) => {
      indexFailed = true;
      if (!shutdown.signal.aborted) log.appendLine(`[ReMem] Indexing failed: ${error}`);
    }).finally(() => { indexing = false; });

  const report = (error: unknown) => log.appendLine(`[ReMem] Workspace update failed: ${error}`);
  const queue = new WorkspaceWorkQueue(async (files, signal, overflow) => {
    if (overflow) {
      report('Event capacity exceeded, rescanning the workspace');
      await indexWorkspace(root, db, pipeline, log, tracker, signal);
    }
    const changed = files.filter((file) => file !== scratchpad.filePath &&
      file !== path.join(root, '.remem_context_feed.md'));
    for (let offset = 0; offset < changed.length; offset += 16) {
      signal.throwIfAborted();
      await Promise.all(changed.slice(offset, offset + 16).map((file) =>
        refreshIndexedFile(db, pipeline, file, tracker, signal).catch(report)));
    }
    signal.throwIfAborted();
    if (changed.some((file) => path.extname(file).toLowerCase() === '.md')) await tasks.syncProgress();
    if (files.includes(scratchpad.filePath) || changed.length) await syncSession();
    if (changed.length || files.includes(path.join(root, '.remem_context_feed.md'))) {
      await graph.updateContextFeedSilently(signal);
    }
  }, report);
  fileWatcher.on('error', report);
  fileWatcher.on('all', (event, file) => {
    if (!['add', 'change', 'unlink'].includes(event)) return;
    if (path.basename(file) === '.remem_context_feed.md' && event !== 'unlink') return;
    queue.add(file);
  });

  const server = new McpServer({ name: 'remem', version: REMEM_VERSION });
  const status = () => indexing || queue.busy ? { 'remem/indexStatus': 'indexing' }
    : indexFailed ? { 'remem/indexStatus': 'partial' } : undefined;
  const indexedText = (text: string) => ({ ...toolText(text), _meta: status() });

  server.registerTool('remem_search', {
    description: 'Search indexed workspace summaries and code symbols.',
    inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(5) },
  }, async ({ query, limit }) => {
    const [summaries, symbols] = await Promise.all([db.searchSummaries(query, limit), db.searchChunks(query, limit)]);
    return indexedText(JSON.stringify({
      summaries: summaries.filter((hit) => publicPath(hit.document.filePath)).map(({ document, score }) =>
        ({ file: document.relativePath, summary: document.summary, score })),
      symbols: symbols.filter((hit) => publicPath(hit.document.filePath)).map(({ document, score }) =>
        ({ file: document.relativePath, symbol: document.name, signature: document.signature, score })),
    }));
  });

  server.registerTool('remem_blast_radius', {
    description: 'List imports, direct dependents, and exported symbols for a workspace file.',
    inputSchema: { file: fileInput },
  }, async ({ file }) => {
    const target = resolveFile(file);
    const relative = (files: string[]) => files.filter(publicPath).map((item) => path.relative(root, item));
    const [imports, dependents, exports] = await Promise.all([
      db.sqlite.query('getDependenciesForFile', target),
      db.sqlite.query('getDependentsForFile', target),
      db.sqlite.query('getExportsForFile', target),
    ]);
    return indexedText(JSON.stringify({ imports: relative(imports), dependents: relative(dependents), exports }));
  });

  server.registerTool('remem_get_context', {
    description: 'Retrieve compact workspace context with task progress and security guidance.',
    inputSchema: { file: fileInput.optional(), branch: branchInput.optional() },
  }, async ({ file, branch: requestedBranch }) => {
    return indexedText(await assembleContext(db, scratchpad, analyzer, {
      activeFilePath: file ? resolveFile(file) : undefined,
      activeBranch: await branch(requestedBranch),
      taskTracker: tasks,
      traceabilityTracker: tracker,
      graphEngine: graph,
      zeroFluffMode: zeroFluffEnabled(),
    }));
  });

  server.registerTool('remem_log_postmortem', {
    description: 'Record a verified failure and how to prevent recurrence.',
    inputSchema: { note: z.string().trim().min(1).max(4000), file: fileInput.optional(), branch: branchInput.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ note, file, branch: requestedBranch }) => {
    const id = await db.addErrorNote({
      branch: await branch(requestedBranch),
      filePath: file ? resolveFile(file) : undefined,
      postMortemNote: note,
      timestamp: Date.now(),
      resolved: false,
    });
    return toolText(JSON.stringify({ id }));
  });

  server.registerTool('remem_save_session_state', {
    description: 'Save a session checkpoint to the workspace scratchpad and resume ledger.',
    inputSchema: {
      activeTask: taskInput.optional(),
      completedTasks: z.array(taskInput).max(50).default([]),
      pendingTasks: z.array(taskInput).max(50).default([]),
      lastPlanSnapshot: z.string().max(4000),
      file: fileInput.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ file, ...state }) => {
    await scratchpad.saveCheckpoint(db, { ...state, activeFilePath: file ? resolveFile(file) : undefined });
    return toolText('Session checkpoint saved.');
  });

  const resources = {
    'context-feed': () => graph.getOrGenerateContextFeed(false),
    scratchpad: () => scratchpad.getPlanAsync(),
    'error-ledger': async () => getFormattedErrorContext(db, undefined, await branch()),
  };
  for (const [name, read] of Object.entries(resources)) {
    server.registerResource(name, 'remem://' + name, { mimeType: 'text/markdown' }, async (uri) => {
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await read() }], _meta: status() };
    });
  }

  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 });
  let stopping: Promise<void> | undefined;
  const close = () => {
    stopping ??= Promise.resolve().then(async () => {
      shutdown.abort();
      scratchpad.stop();
      const watcherClosed = fileWatcher.close();
      const queued = queue.stop();
      process.stdin.pause();
      AsyncASTParser.disposeShared();
      const completed = await drainWithin(Promise.allSettled([
        server.close(), watcherClosed, initialIndex, queued, db.close(),
      ]));
      process.stdin.removeListener('end', close);
      if (completed) {
        process.removeListener('SIGINT', close);
        process.removeListener('SIGTERM', close);
      } else {
        process.exit(0);
      }
    }).catch((error) => {
      console.error('[ReMem] Shutdown failed:', error);
      process.exit(1);
    });
  };
  process.stdin.once('end', close);
  server.server.onclose = close;
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await server.connect(transport);
  } catch (error) {
    close();
    await stopping;
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const install = args[0] === 'install';
  if (install) args.shift();
  let root = process.cwd();
  let zeroFluffMode = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--workspace' && args.length) root = args.shift()!;
    else if (arg === '--zero-fluff') zeroFluffMode = true;
    else throw new Error('Usage: remem-mcp [install] [--workspace DIRECTORY] [--zero-fluff]');
  }
  root = fs.realpathSync(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Workspace must be a directory.');
  if (install) {
    await installSkillAndMcp(root, __dirname, zeroFluffMode);
    console.error('ReMem skill and MCP configuration installed in ' + root);
  } else {
    await serve(root, zeroFluffMode);
  }
}

void main().catch((error) => {
  console.error('[ReMem MCP]', error);
  process.exitCode = 1;
});
