import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'smol-toml';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { publishAtomic, fileVersion, isWorkspacePath, withAsyncFileLock } from '../core/files.js';
import { updateAgentInstructions } from '../context/instructions.js';

const start = '# cuttlehawk:begin';
const end = '# cuttlehawk:end';
const legacyStart = '# remem:begin';
const legacyEnd = '# remem:end';

type ConfigEdit = { relative: string; edit: (existing: string) => string };

async function withPreparedEdits(
  root: string,
  edits: ConfigEdit[],
  apply: (publish: () => Promise<void>) => Promise<void>,
  index = 0,
  publications: (() => Promise<void>)[] = [],
): Promise<void> {
  if (index === edits.length) {
    await apply(async () => {
      for (const publish of publications) await publish();
    });
    return;
  }
  const { relative, edit } = edits[index];
  const file = path.join(root, relative);
  if (!isWorkspacePath(root, file)) throw new Error('Unsafe installer path: ' + relative);
  await withAsyncFileLock(file, async (assertOwner) => {
    const version = fileVersion(file);
    const existing = version ? await fs.promises.readFile(file, 'utf8') : '';
    const next = edit(existing);
    if (next !== existing) {
      const mode = version ? fs.statSync(file).mode & 0o777 : 0o600;
      publications.push(() => publishAtomic(file, next, async () => {
        await assertOwner();
        if (!isWorkspacePath(root, file) || fileVersion(file) !== version) {
          throw new Error('Installer configuration changed during installation: ' + relative);
        }
      }, mode));
    }
    await withPreparedEdits(root, edits, apply, index + 1, publications);
  });
}

export async function installSkillAndMcp(root: string, bundleDir: string, zeroFluffMode = false): Promise<void> {
  const runtime = '.agents/cuttlehawk-runtime';
  const skill = await fs.promises.readFile(path.join(bundleDir, '../skills/cuttlehawk/SKILL.md'), 'utf8');
  const command = 'node';
  const args = [path.join(root, runtime, 'cuttlehawk-mcp.js'), '--workspace', root, ...(zeroFluffMode ? ['--zero-fluff'] : [])];
  const entry = { command, args };
  const configs = [
    ['.mcp.json', 'mcpServers'],
    ['.agents/mcp_config.json', 'mcpServers'],
    ['.vscode/mcp.json', 'servers'],
  ] as const;

  const legacyEntry = path.join(root, '.agents/remem-runtime/remem-mcp.js');
  const validateRegistration = (registration: unknown, file: string) => {
    if (registration === undefined) return;
    const previous = registration as Partial<typeof entry> | null;
    if (previous?.command !== command || !Array.isArray(previous.args)
        || ![args[0], legacyEntry].includes(previous.args[0])
        || previous.args[1] !== '--workspace' || previous.args[2] !== root) {
      throw new Error('An existing Cuttlehawk or ReMem registration conflicts in ' + file);
    }
  };

  const edits: ConfigEdit[] = configs.map(([file, key]) => ({
    relative: file,
    edit(content) {
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
      validateRegistration(config[key].cuttlehawk, file);
      validateRegistration(config[key].remem, file);
      const previous = config[key].cuttlehawk ?? config[key].remem;
      const registration = { ...previous, ...entry };
      let updated = content || '{}\n';
      if (config[key].remem) {
        updated = applyEdits(updated, modify(updated, [key, 'remem'], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }));
      }
      if (JSON.stringify(config[key].cuttlehawk) === JSON.stringify(registration) && !config[key].remem) return content;
      return applyEdits(updated, modify(updated, [key, 'cuttlehawk'], registration, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
    },
  }));

  const codexFile = '.codex/config.toml';
  type CodexConfig = { mcp_servers?: { cuttlehawk?: unknown; remem?: unknown } };
  edits.push({ relative: codexFile, edit(content) {
    const config = parse(content) as CodexConfig;
    validateRegistration(config.mcp_servers?.cuttlehawk, codexFile);
    validateRegistration(config.mcp_servers?.remem, codexFile);
    let clean = content;
    for (const [name, begin, finish] of [
      ['remem', legacyStart, legacyEnd], ['cuttlehawk', start, end],
    ] as const) {
      const first = clean.indexOf(begin);
      const last = clean.indexOf(finish);
      if (first < 0 && last < 0) continue;
      if (first < 0 || last <= first) throw new Error('Malformed Cuttlehawk TOML markers.');
      const section = (parse(clean.slice(first, last + finish.length)) as CodexConfig).mcp_servers?.[name];
      if (!section) throw new Error('Invalid managed MCP configuration in ' + codexFile);
      const withoutBlock = clean.slice(0, first) + clean.slice(last + finish.length);
      // Verify that removing the marked region changes only the managed registration.
      const expected = parse(clean) as CodexConfig;
      delete expected.mcp_servers?.[name];
      if (expected.mcp_servers && !Object.keys(expected.mcp_servers).length) delete expected.mcp_servers;
      const actual = parse(withoutBlock) as CodexConfig;
      if (actual.mcp_servers && !Object.keys(actual.mcp_servers).length) delete actual.mcp_servers;
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error('Managed MCP block contains other configuration in ' + codexFile);
      }
      clean = withoutBlock;
    }
    const remaining = parse(clean) as CodexConfig;
    if (remaining.mcp_servers?.cuttlehawk) {
      throw new Error('An existing unmanaged Cuttlehawk registration is configured in ' + codexFile);
    }
    if (remaining.mcp_servers?.remem) {
      // Adopt a conventional standalone legacy table. Verify the edit before accepting it.
      const withoutLegacy = clean.replace(/^\[mcp_servers\.remem\][^\S\r\n]*(?:#[^\r\n]*)?\r?$[\s\S]*?(?=^\s*\[|(?![\s\S]))/m, '');
      delete remaining.mcp_servers.remem;
      if (!Object.keys(remaining.mcp_servers).length) delete remaining.mcp_servers;
      const actual = parse(withoutLegacy) as CodexConfig;
      if (actual.mcp_servers && !Object.keys(actual.mcp_servers).length) delete actual.mcp_servers;
      if (JSON.stringify(remaining) !== JSON.stringify(actual)) {
        throw new Error('An existing unmanaged ReMem registration is configured in ' + codexFile);
      }
      clean = withoutLegacy;
    }
    const block = [start, '[mcp_servers.cuttlehawk]', 'command = "node"', 'args = ' + JSON.stringify(args), end].join('\n');
    const next = clean.trimEnd() + (clean.trim() ? '\n\n' : '') + block + '\n';
    parse(next);
    return next;
  } });

  for (const folder of ['.agents', '.claude']) {
    edits.push({ relative: folder + '/skills/cuttlehawk/SKILL.md', edit(existing) {
      if (existing && existing !== skill) throw new Error('A different Cuttlehawk skill already exists in ' + folder);
      return skill;
    } });
  }
  await withPreparedEdits(root, edits, async (publish) => {
    const assets = await Promise.all(['cuttlehawk-mcp.js', 'storage-worker.js', 'sql-wasm.wasm', 'tree-sitter.wasm'].map(async (filename) => {
      const destination = path.join(root, runtime, filename);
      if (!isWorkspacePath(root, destination)) throw new Error('Unsafe runtime destination.');
      return { destination, source: await fs.promises.readFile(path.join(bundleDir, filename)) };
    }));
    for (const { destination, source } of assets) {
      await withAsyncFileLock(destination, (assertOwner) => publishAtomic(destination, source, assertOwner));
    }
    await publish();
    for (const folder of ['.agents', '.claude']) {
      const oldSkill = path.join(root, folder, 'skills/remem/SKILL.md');
      if (isWorkspacePath(root, oldSkill) && fs.existsSync(oldSkill)) {
        try {
          fs.unlinkSync(oldSkill);
          const oldDir = path.dirname(oldSkill);
          if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
        } catch {}
      }
    }
    await updateAgentInstructions(root, zeroFluffMode);
  });
}
