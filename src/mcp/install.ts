import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'smol-toml';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { publishAtomic, fileVersion, isWorkspacePath, withAsyncFileLock } from '../core/files.js';
import { updateAgentInstructions } from '../context/instructions.js';

const start = '# remem:begin';
const end = '# remem:end';

async function editFile(root: string, relative: string, edit: (existing: string) => string): Promise<void> {
  const file = path.join(root, relative);
  if (!isWorkspacePath(root, file)) throw new Error('Unsafe installer path: ' + relative);
  await withAsyncFileLock(file, async (assertOwner) => {
    const version = fileVersion(file);
    const existing = version ? await fs.promises.readFile(file, 'utf8') : '';
    const next = edit(existing);
    if (next !== existing) await publishAtomic(file, next, assertOwner, version ? fs.statSync(file).mode & 0o777 : 0o600);
  });
}

export async function installSkillAndMcp(root: string, bundleDir: string, zeroFluffMode = false): Promise<void> {
  const runtime = '.agents/remem-runtime';
  const skill = await fs.promises.readFile(path.join(bundleDir, '../skills/remem/SKILL.md'), 'utf8');
  const command = 'node';
  const args = [path.join(root, runtime, 'remem-mcp.js'), '--workspace', root, ...(zeroFluffMode ? ['--zero-fluff'] : [])];
  const entry = { command, args };
  const configs = [
    ['.mcp.json', 'mcpServers'],
    ['.agents/mcp_config.json', 'mcpServers'],
    ['.vscode/mcp.json', 'servers'],
  ] as const;

  for (const filename of ['remem-mcp.js', 'storage-worker.js', 'sql-wasm.wasm', 'tree-sitter.wasm']) {
    const destination = path.join(root, runtime, filename);
    if (!isWorkspacePath(root, destination)) throw new Error('Unsafe runtime destination.');
    const source = await fs.promises.readFile(path.join(bundleDir, filename));
    await withAsyncFileLock(destination, (assertOwner) => publishAtomic(destination, source, assertOwner));
  }

  for (const [file, key] of configs) {
    await editFile(root, file, (content) => {
      const errors: ParseError[] = [];
      const config = content.trim()
        ? parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: file === '.mcp.json' })
        : {};
      if (errors.length) throw new Error('Invalid MCP configuration in ' + file);
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
          (config[key] !== undefined && (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])))) {
        throw new Error('Invalid MCP configuration in ' + file);
      }
      config[key] ??= {};
      const previous = config[key].remem;
      if (previous && (previous.command !== command || JSON.stringify(previous.args?.slice(0, 3)) !== JSON.stringify(args.slice(0, 3)))) {
        throw new Error('An existing ReMem registration is configured in ' + file);
      }
      const registration = { ...previous, ...entry };
      if (JSON.stringify(previous) === JSON.stringify(registration)) return content;
      return applyEdits(content || '{}\n', modify(content || '{}\n', [key, 'remem'], registration, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
    });
  }

  await editFile(root, '.codex/config.toml', (content) => {
    const markerStart = content.indexOf(start);
    const markerEnd = content.indexOf(end);
    const managed = markerStart >= 0 && markerEnd > markerStart;
    if (!managed && (markerStart >= 0 || markerEnd >= 0)) throw new Error('Malformed ReMem TOML markers.');
    const config = parse(content) as { mcp_servers?: { remem?: unknown } };
    if (config.mcp_servers?.remem && !managed) throw new Error('An existing ReMem registration is configured in .codex/config.toml');
    const block = [start, '[mcp_servers.remem]', 'command = "node"', 'args = ' + JSON.stringify(args), end].join('\n');
    const next = managed
      ? content.slice(0, markerStart) + block + content.slice(markerEnd + end.length)
      : content + (content ? '\n\n' : '') + block + '\n';
    parse(next);
    return next;
  });

  for (const folder of ['.agents', '.claude']) {
    await editFile(root, folder + '/skills/remem/SKILL.md', (existing) => {
      if (existing && existing !== skill) throw new Error('A different ReMem skill already exists in ' + folder);
      return skill;
    });
  }
  await updateAgentInstructions(root, zeroFluffMode);
}
