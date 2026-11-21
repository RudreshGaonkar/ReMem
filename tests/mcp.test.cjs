const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const bundle = path.resolve(__dirname, '../out/cuttlehawk-mcp.js');

test('installer preserves existing rules and MCP settings and installs a working bundle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Existing rules\r\nKeep this.\r\n');
  await fs.writeFile(path.join(root, '.vscode/mcp.json'), '{\n // Existing entry\n "servers": {"existing": {"command": "keep"}}\n}');
  await fs.writeFile(path.join(root, '.codex/config.toml'), '# Existing setting\nmodel = "example"\n');
  for (let run = 0; run < 2; run++) {
    execFileSync(process.execPath, [bundle, 'install', '--workspace', root, '--zero-fluff'], { stdio: 'pipe' });
  }
  const rules = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(rules.startsWith('# Existing rules\r\nKeep this.\r\n'));
  assert.equal(rules.match(/cuttlehawk:begin/g).length, 1);
  assert.match(rules, /ZERO FLUFF MODE ACTIVE/);
  assert.match(await fs.readFile(path.join(root, '.vscode/mcp.json'), 'utf8'), /Existing entry/);
  assert.match(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8'), /model = "example"/);
  assert.match(await fs.readFile(path.join(root, '.claude/skills/cuttlehawk/SKILL.md'), 'utf8'), /name: cuttlehawk-context-engine/);
  const config = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
  const client = await connect(root, config.mcpServers.cuttlehawk.args[0]);
  try {
    assert.equal((await client.listTools()).tools.length, 5);
    assert.equal(client.getServerVersion().version, require('../package.json').version);
  } finally {
    await client.close();
  }
});

test('installer upgrades legacy MCP registrations and deduplicates rules', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-upgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = [['.mcp.json', 'mcpServers'], ['.agents/mcp_config.json', 'mcpServers'], ['.vscode/mcp.json', 'servers']];
  const legacy = { command: 'node', args: [path.join(root, '.agents/remem-runtime/remem-mcp.js'), '--workspace', root] };
  for (const [relative, key] of paths) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ [key]: { remem: legacy, unrelated: { command: 'keep' } } }));
  }
  const codex = path.join(root, '.codex/config.toml');
  await fs.mkdir(path.dirname(codex));
  const toml = 'model = "example"\n# remem:begin\n[mcp_servers.remem]\ncommand = "node"\nargs = '
    + JSON.stringify(legacy.args) + '\n# remem:end\n\n[mcp_servers.unrelated]\ncommand = "keep"\n';
  await fs.writeFile(codex, toml);
  const oldBlock = '<!-- remem:begin -->\r\nold rules\r\n<!-- remem:end -->';
  const newBlock = '<!-- cuttlehawk:begin -->\r\nnew rules\r\n<!-- cuttlehawk:end -->';
  for (const relative of ['AGENTS.md', 'CLAUDE.md']) {
    await fs.writeFile(path.join(root, relative), ['# Existing rules', newBlock, 'Keep this.', oldBlock, newBlock, ''].join('\r\n'));
  }
  const legacyRule = path.join(root, '.agents/rules/remem.md');
  const currentRule = path.join(root, '.agents/rules/cuttlehawk.md');
  await fs.mkdir(path.dirname(legacyRule));
  await fs.writeFile(legacyRule, 'Custom legacy rules.\n');
  await fs.writeFile(currentRule, 'Custom current rules.\n');
  execFileSync(process.execPath, [bundle, 'install', '--workspace', root], { stdio: 'pipe' });
  for (const [relative, key] of paths) {
    const config = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'))[key];
    assert.equal(config.remem, undefined);
    assert.equal(config.cuttlehawk.args[0], path.join(root, '.agents/cuttlehawk-runtime/cuttlehawk-mcp.js'));
    assert.equal(config.unrelated.command, 'keep');
  }
  const updatedToml = await fs.readFile(codex, 'utf8');
  assert.doesNotMatch(updatedToml, /remem/);
  assert.match(updatedToml, /\[mcp_servers\.cuttlehawk\]/);
  assert.match(updatedToml, /\[mcp_servers\.unrelated\]/);
  for (const relative of ['AGENTS.md', 'CLAUDE.md']) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    assert.equal(content.match(/cuttlehawk:begin/g).length, 1);
    assert.equal(content.match(/cuttlehawk:end/g).length, 1);
    assert.doesNotMatch(content, /remem:(begin|end)/);
    assert.match(content, /\r\nKeep this\.\r\n/);
    assert.doesNotMatch(content, /(?<!\r)\n/);
  }
  assert.equal(await fs.readFile(legacyRule, 'utf8'), 'Custom legacy rules.\n');
  assert.match(await fs.readFile(currentRule, 'utf8'), /^Custom current rules\./);
});

test('installer rejects a late config conflict before publishing runtime or earlier configs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(path.join(root, '.codex/config.toml'), '[mcp_servers.remem]\ncommand = "custom"\n');
  assert.throws(() => execFileSync(process.execPath, [bundle, 'install', '--workspace', root], { stdio: 'pipe' }),
    /registration conflicts in \.codex\/config\.toml/);
  for (const file of ['.mcp.json', '.agents/cuttlehawk-runtime', '.agents/mcp_config.json', '.vscode/mcp.json']) {
    await assert.rejects(fs.stat(path.join(root, file)), { code: 'ENOENT' });
  }
});

async function connect(root, entry = bundle) {
  const client = new Client({ name: 'cuttlehawk-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--workspace', root, '--zero-fluff'],
    stderr: 'inherit',
  }));
  return client;
}

async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

async function resource(client, name) {
  return (await client.readResource({ uri: 'cuttlehawk://' + name })).contents[0].text;
}

async function eventually(check) {
  const timeout = Date.now() + 6000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < timeout);
  assert.fail('Workspace changes were not reflected before the deadline');
}

test('two MCP processes share searchable code, graph, task progress, and session state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-mcp-'));
  const clients = [];
  try {
    await fs.writeFile(path.join(root, 'engine.ts'), 'export function exampleEngine() { return 42; }\n');
    await fs.writeFile(path.join(root, 'consumer.ts'), 'import { exampleEngine } from "./engine.js";\nexport const value = exampleEngine();\n');
    await fs.writeFile(path.join(root, 'spec.md'), '# First milestone\n- [x] Establish baseline\n- [ ] Verify callers\n');
    await fs.writeFile(path.join(root, '.env'), 'CREDENTIAL_CANARY=secret\n');
    const memory = path.join(root, '.antigravityMem');
    await fs.mkdir(memory);
    const ledgerLock = path.join(memory, 'cuttlehawk_ledger.sqlite.lock');
    const indexLock = path.join(memory, 'orama_index.json.lock');
    // Recover a fresh lock from a dead owner and preserve an old live lock.
    await fs.writeFile(ledgerLock, JSON.stringify({ pid: 0x7fffffff, timestamp: Date.now() }));
    await fs.writeFile(indexLock, JSON.stringify({ pid: process.pid, timestamp: Date.now() - 11_000 }));
    const [a, b] = await Promise.all([connect(root), connect(root)]);
    clients.push(a, b);
    assert.equal((await a.listResources()).resources.length, 3);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(JSON.parse(await fs.readFile(indexLock, 'utf8')).pid, process.pid);
    const partial = await b.callTool({ name: 'cuttlehawk_search', arguments: { query: 'exampleEngine' } });
    assert.equal(partial._meta['cuttlehawk/indexStatus'], 'indexing');
    assert.deepEqual(JSON.parse(partial.content[0].text).symbols, []);
    await fs.unlink(indexLock);
    await eventually(async () => {
      const graph = await resource(a, 'context-feed');
      const hits = JSON.parse(await tool(b, 'cuttlehawk_search', { query: 'exampleEngine' }));
      assert.doesNotMatch(graph, /CREDENTIAL_CANARY|\.env/);
      return graph.includes('imports: [engine.ts]') && hits.symbols.some((hit) => hit.symbol === 'exampleEngine');
    });
    const blast = JSON.parse(await tool(a, 'cuttlehawk_blast_radius', { file: 'engine.ts' }));
    assert.deepEqual(blast.dependents, ['consumer.ts']);

    await Promise.all([
      tool(a, 'cuttlehawk_log_postmortem', { note: 'First postmortem' }),
      tool(b, 'cuttlehawk_log_postmortem', { note: 'Second postmortem' }),
    ]);
    const errors = await resource(a, 'error-ledger');
    assert.match(errors, /First postmortem/);
    assert.match(errors, /Second postmortem/);
    await tool(b, 'cuttlehawk_save_session_state', {
      activeTask: 'Check caller',
      pendingTasks: ['Verify callers'],
      completedTasks: ['Establish baseline'],
      lastPlanSnapshot: 'Review return value',
      file: 'engine.ts',
    });
    assert.match(await resource(a, 'scratchpad'), /Review return value/);
    const context = await tool(a, 'cuttlehawk_get_context', { file: 'engine.ts' });
    for (const expected of ['RESUME STATE', 'Check caller', 'ZERO FLUFF MODE ACTIVE', 'SECURITY, ASSET & COMPLIANCE',
      'Verify callers', 'AST CODE CHUNKS', 'exampleEngine']) {
      assert.ok(context.includes(expected), expected);
    }

    await fs.writeFile(path.join(root, 'consumer.ts'), 'export const rewrittenConsumer = true;\n');
    await eventually(async () => {
      const result = JSON.parse(await tool(b, 'cuttlehawk_blast_radius', { file: 'engine.ts' }));
      return !result.dependents.length && (await resource(b, 'context-feed')).includes('rewrittenConsumer');
    });
    const denied = await a.callTool({ name: 'cuttlehawk_get_context', arguments: { file: '.env' } });
    assert.equal(denied.isError, true);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local diff audit reports spec progress, dependency expansion, and security findings', async () => {
  const { build } = require('esbuild');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-audit-'));
  try {
    const cwd = path.resolve(__dirname, '..');
    const auditBundle = path.join(root, 'audit.cjs');
    await build({
      absWorkingDir: cwd,
      stdin: {
        contents: [
          "export { LocalDiffAuditor } from './src/review/auditor.ts';",
          "export { SpecTaskTracker } from './src/task/tracker.ts';",
          "export { ASTAnalyzer } from './src/ast/analyzer.ts';",
          "export { ScratchpadManager } from './src/ast/scratchpad.ts';",
          "export { DatabaseManager } from './src/database/index.ts';",
        ].join('\n'),
        resolveDir: cwd,
      },
      bundle: true,
      platform: 'node',
      logLevel: 'warning',
      outfile: auditBundle,
    });
    await fs.copyFile(path.join(cwd, 'out/sql-wasm.wasm'), path.join(root, 'sql-wasm.wasm'));
    const { LocalDiffAuditor, SpecTaskTracker, ASTAnalyzer, ScratchpadManager, DatabaseManager } = require(auditBundle);
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    await fs.writeFile(path.join(root, 'spec.md'), '# Delivery\n- [x] Create fixtures\n- [ ] Verify results\n');
    await fs.writeFile(path.join(root, 'app.ts'), 'export function render(node, text) { node.textContent = text; }\n');
    await fs.writeFile(path.join(root, 'package.json'), '{"dependencies": {}}\n');
    git('add', 'spec.md', 'app.ts', 'package.json');
    git('-c', 'user.name=Cuttlehawk Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline');
    await fs.writeFile(path.join(root, 'app.ts'), 'export function render(node, text) {\n  node.innerHTML = text;\n}\n');
    await fs.writeFile(path.join(root, 'package.json'), '{\n  "dependencies": {\n    "additional-library": "1.0.0"\n  }\n}\n');

    const database = new DatabaseManager();
    await database.initialize(root);
    try {
      const scratchpad = new ScratchpadManager(root);
      const taskTracker = new SpecTaskTracker(root, scratchpad);
      const spec = await taskTracker.syncProgress();
      assert.equal(spec.percentage, 50);
      const auditor = new LocalDiffAuditor(root, database, new ASTAnalyzer(), scratchpad);
      const report = await auditor.auditDiff(spec);
      assert.match(report.markdownReport, /1 of 2 completed tasks/);
      assert.match(report.markdownReport, /Verify results/);
      assert.ok(report.issues.some((issue) => issue.type === 'overbuild'));
      assert.ok(report.issues.some((issue) => issue.type === 'security_vulnerability'));
    } finally {
      await database.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovers corrupt SQLite and Orama snapshots and retains the last valid ledger', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = path.join(root, '.antigravityMem');
  await fs.writeFile(path.join(root, 'core.ts'), 'export function recoveredSymbol() { return 4; }\n');
  const initial = await connect(root);
  try {
    await tool(initial, 'cuttlehawk_log_postmortem', { note: 'keep this ledger entry', branch: 'main' });
    await eventually(async () => (await resource(initial, 'context-feed')).includes('recoveredSymbol'));
  } finally {
    await initial.close();
  }
  const ledger = path.join(memory, 'cuttlehawk_ledger.sqlite');
  const index = path.join(memory, 'orama_index.json');
  assert.match((await fs.readFile(ledger + '.bak')).subarray(0, 16).toString(), /^SQLite format 3/);
  await fs.writeFile(ledger, 'truncated database');
  await fs.writeFile(index, '{"oramaData":');
  const recovered = await connect(root);
  try {
    assert.match(await resource(recovered, 'error-ledger'), /keep this ledger entry/);
    await eventually(async () => {
      const hits = JSON.parse(await tool(recovered, 'cuttlehawk_search', { query: 'recoveredSymbol' }));
      return hits.symbols.some((hit) => hit.symbol === 'recoveredSymbol');
    });
    const quarantine = (await fs.readdir(memory)).find((name) => name.startsWith('cuttlehawk_ledger.sqlite.corrupted-'));
    assert.ok(quarantine);
    assert.equal(await fs.readFile(path.join(memory, quarantine), 'utf8'), 'truncated database');
    JSON.parse(await fs.readFile(index, 'utf8'));
  } finally {
    await recovered.close();
  }
});

test('migrates legacy remem_ledger.sqlite and legacy rules seamlessly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = path.join(root, '.antigravityMem');
  await fs.mkdir(memory, { recursive: true });
  await fs.writeFile(path.join(root, 'source.ts'), 'export function migratedFn() { return "ok"; }\n');
  await fs.writeFile(path.join(root, '.remem_context_feed.md'), '# Legacy Feed Map\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Agents\n<!-- remem:begin -->\n## ReMem workspace context\nOld info\n<!-- remem:end -->\n');

  // Create an initial server to create a valid sqlite db, then rename it to remem_ledger.sqlite
  const temp = await connect(root);
  await tool(temp, 'cuttlehawk_log_postmortem', { note: 'migrated error note', branch: 'main' });
  await temp.close();

  // Rename cuttlehawk_ledger.sqlite to legacy remem_ledger.sqlite
  const newLedger = path.join(memory, 'cuttlehawk_ledger.sqlite');
  const legacyLedger = path.join(memory, 'remem_ledger.sqlite');
  await fs.rename(newLedger, legacyLedger);
  if (await fs.stat(newLedger + '.bak').then(() => true, () => false)) {
    await fs.rename(newLedger + '.bak', legacyLedger + '.bak');
  }

  // Connect fresh - should automatically migrate remem_ledger.sqlite -> cuttlehawk_ledger.sqlite
  const migrated = await connect(root);
  try {
    assert.match(await resource(migrated, 'error-ledger'), /migrated error note/);
    assert.ok(await fs.stat(newLedger).then(() => true, () => false));
    // Verify AGENTS.md was migrated to cuttlehawk markers
    const updatedAgents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(updatedAgents, /cuttlehawk:begin/);
    assert.doesNotMatch(updatedAgents, /remem:begin/);
  } finally {
    await migrated.close();
  }
});

test('200-file watcher burst preserves MCP responsiveness and exits cleanly on SIGTERM', { timeout: 20_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlehawk-burst-'));
  await fs.writeFile(path.join(root, 'seed.ts'), 'export function seedSymbol() { return 1; }\n');
  const child = spawn(process.execPath, [bundle, '--workspace', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await exited.catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const { createInterface } = require('node:readline');
  const replies = new Map();
  const invalid = [];
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.jsonrpc !== '2.0') invalid.push(line);
      replies.get(message.id)?.(message);
    } catch {
      invalid.push(line);
    }
  });
  function send(method, params, requestId) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  }
  function request(method, params, deadline = 1500) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        replies.delete(requestId);
        reject(new Error(`${method} did not respond in ${deadline} ms. ${stderr}`));
      }, deadline);
      replies.set(requestId, (message) => {
        clearTimeout(timer);
        replies.delete(requestId);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      send(method, params, requestId);
    });
  }
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'burst-test', version: '1' },
  });
  send('notifications/initialized');
  const search = (query) => request('tools/call', { name: 'cuttlehawk_search', arguments: { query } });
  await eventually(async () => JSON.parse((await search('seedSymbol')).content[0].text).symbols.length > 0);
  const context = await request('tools/call', { name: 'cuttlehawk_get_context', arguments: { file: 'seed.ts' } });
  assert.match(context.content[0].text, /seedSymbol/);

  await Promise.all(Array.from({ length: 200 }, (_, i) =>
    fs.writeFile(path.join(root, `burst-${i}.ts`), `export function burstSymbol${i}() { return ${i}; }\n`)));
  let pings = 0;
  await eventually(async () => {
    await request('ping', {}, 750);
    pings++;
    const feed = await request('resources/read', { uri: 'cuttlehawk://context-feed' });
    return (feed.contents[0].text.match(/burst-\d+\.ts/g) || []).length === 200;
  });
  assert.ok(pings > 0);

  // Ask for shutdown with more watcher work pending.
  await fs.writeFile(path.join(root, 'seed.ts'), 'export const closingSymbol = true;\n');
  assert.ok(child.kill('SIGTERM'));
  let timeout;
  try {
    const state = await Promise.race([
      exited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(stderr)), 3000); }),
    ]);
    assert.deepEqual(state, { code: 0, signal: null });
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual(invalid, []);
  assert.match(stderr, /Starting initial workspace scan/);
  const memory = path.join(root, '.antigravityMem');
  assert.ok((await fs.readdir(memory)).every((name) => !name.endsWith('.lock')));
});
