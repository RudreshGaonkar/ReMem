import * as fs from 'fs';
import * as path from 'path';
import { publishAtomic, fileVersion, isWorkspacePath, withAsyncFileLock } from '../core/files.js';
import { getLeanRulesContext } from './leanRules.js';
import { getZeroFluffModeContext } from './security.js';

export const AGENT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.agents/rules/cuttlehawk.md', '.antigravity/rules.md'];
const begin = '<!-- cuttlehawk:begin -->';
const end = '<!-- cuttlehawk:end -->';
const managedBlock = /<!-- (cuttlehawk|remem):begin -->(?:(?!<!-- (?:cuttlehawk|remem):(?:begin|end) -->)[\s\S])*?<!-- \1:end -->/g;
const marker = /<!-- (?:cuttlehawk|remem):(?:begin|end) -->/;

export async function updateAgentInstructions(root: string, zeroFluffMode = false, signal?: AbortSignal): Promise<void> {
  for (const relative of AGENT_INSTRUCTION_FILES) {
    const file = path.join(root, relative);
    if (!isWorkspacePath(root, file)) throw new Error('Unsafe agent instruction path: ' + relative);
    if (relative === '.antigravity/rules.md' && !fs.existsSync(file)) continue;
    await withAsyncFileLock(file, async (assertOwner) => {
      const version = fileVersion(file);
      const legacyRule = path.join(root, '.agents/rules/remem.md');
      const legacyVersion = !version && relative === '.agents/rules/cuttlehawk.md'
        && isWorkspacePath(root, legacyRule) ? fileVersion(legacyRule) : '';
      const source = legacyVersion ? legacyRule : file;
      const existing = version || legacyVersion ? await fs.promises.readFile(source, 'utf8') : '';
      const clean = existing.replace(managedBlock, '');
      if (marker.test(clean)) throw new Error('Malformed Cuttlehawk instruction markers in ' + relative);
      const newline = existing.includes('\r\n') ? '\r\n' : '\n';
      const block = [
        begin,
        '## Cuttlehawk workspace context',
        'At session start, read `.cuttlehawk_context_feed.md` for the architecture map and `.recall_scratchpad.md` for current work. Use `cuttlehawk_get_context` when available to retrieve relevant code, session state, and recorded errors.',
        getZeroFluffModeContext(zeroFluffMode) || 'Keep responses concise and report verification results.',
        '## Mandatory execution rules',
        '- **No speculative features.** If project requirements or intent are unclear, ask the user for confirmation before introducing features, files, or design assumptions.',
        '- **Git branch check before edits.** Run `git branch --show-current` before modifying files. On `main` or `master`, ask the user whether to work directly on the current branch or create a new branch, and wait for their choice before editing. If the current branch already contains commits for the same task and is a feature or working branch, continue there without asking.',
        '- **Code Reuse & Duplicate-Prevention.** Before creating a helper, function, component, or module, use `cuttlehawk_search` and `cuttlehawk_get_context` to check for matching or related logic. If you find any, stop before writing or modifying anything. Report the exact `file:line` and symbol name to the user, then ask whether to reuse or extend the existing implementation, modify it, or keep it untouched. Wait for their decision. Never create duplicate implementations or parallel utilities without user confirmation.',
        getLeanRulesContext(),
        'Before making code changes, check input validation, authorization, and secret handling. Check access to protected assets, privacy and licensing obligations, and failure, concurrency, and rollback behavior. Apply the controls relevant to the change.',
        end,
      ].join('\n').replace(/\n/g, newline);
      const firstBlock = existing.search(managedBlock);
      const preamble = !existing && relative === '.agents/rules/cuttlehawk.md'
        ? ['---', 'trigger: always_on', '---', ''].join(newline) : '';
      const next = firstBlock >= 0
        ? existing.slice(0, firstBlock) + block + existing.slice(firstBlock).replace(managedBlock, '').replace(/^(?:\r?\n)+$/, newline)
        : (existing || preamble) + (existing ? newline + newline : '') + block + newline;
      if (!version || next !== existing) {
        const mode = version || legacyVersion ? fs.statSync(source).mode & 0o777 : 0o644;
        await publishAtomic(file, next, assertOwner, mode);
      }
      if (legacyVersion && fileVersion(legacyRule) === legacyVersion) await fs.promises.unlink(legacyRule);
    }, signal);
  }
}
