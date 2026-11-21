import * as fs from 'fs';
import * as path from 'path';
import { publishAtomic, fileVersion, isWorkspacePath, withAsyncFileLock } from '../core/files.js';
import { getLeanRulesContext } from './leanRules.js';
import { getZeroFluffModeContext } from './security.js';

export const AGENT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.agents/rules/remem.md', '.antigravity/rules.md'];
const begin = '<!-- remem:begin -->';
const end = '<!-- remem:end -->';

export async function updateAgentInstructions(root: string, zeroFluffMode = false, signal?: AbortSignal): Promise<void> {
  for (const relative of AGENT_INSTRUCTION_FILES) {
    const file = path.join(root, relative);
    if (!isWorkspacePath(root, file)) throw new Error('Unsafe agent instruction path: ' + relative);
    if (relative === '.antigravity/rules.md' && !fs.existsSync(file)) continue;
    await withAsyncFileLock(file, async (assertOwner) => {
      const existing = fileVersion(file) ? await fs.promises.readFile(file, 'utf8') : '';
      if (existing.includes(begin) !== existing.includes(end) ||
          (existing.includes(begin) && existing.indexOf(begin) > existing.indexOf(end))) {
        throw new Error('Malformed ReMem instruction markers in ' + relative);
      }
      const newline = existing.includes('\r\n') ? '\r\n' : '\n';
      const block = [
        begin,
        '## ReMem workspace context',
        'At session start, read `.remem_context_feed.md` for the architecture map and `.recall_scratchpad.md` for current work. Use `remem_get_context` when available to retrieve relevant code, session state, and recorded errors.',
        getZeroFluffModeContext(zeroFluffMode) || 'Keep responses concise and report verification results.',
        getLeanRulesContext(),
        'Before making code changes, check input validation, authorization, and secret handling. Check access to protected assets, privacy and licensing obligations, and failure, concurrency, and rollback behavior. Apply the controls relevant to the change.',
        end,
      ].join('\n').replace(/\n/g, newline);
      const next = existing.includes(begin)
        ? existing.slice(0, existing.indexOf(begin)) + block + existing.slice(existing.indexOf(end) + end.length)
        : (existing || (relative === '.agents/rules/remem.md' ? '---\ntrigger: always_on\n---\n' : '')) +
          (existing ? newline + newline : '') + block + newline;
      if (next !== existing) await publishAtomic(file, next, assertOwner, fileVersion(file) ? fs.statSync(file).mode & 0o777 : 0o644);
    }, signal);
  }
}
