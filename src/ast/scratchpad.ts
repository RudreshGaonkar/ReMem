import * as fs from 'fs';
import { publishAtomic, fileVersion, isWorkspacePath, withAsyncFileLock } from '../core/files.js';
import type { DatabaseManager } from '../database/index.js';
import { getScratchpadPath } from '../config.js';

/**
 * Snapshot of the scratchpad state captured for session recovery.
 */
export interface ScratchpadSnapshot {
  filePath: string;
  exists: boolean;
  content: string;
  lastModified: number | null;
}

/**
 * Callback type invoked whenever scratchpad content changes.
 * Receives the new raw content so the caller can persist session state.
 */
export type ScratchpadChangeCallback = (newContent: string) => void;

/**
 * Manages the active workspace scratchpad (.recall_scratchpad.md).
 */
type SessionState = Parameters<DatabaseManager['saveSessionState']>[0];

const defaultPlan = [
  '# Cuttlehawk Active Scratchpad',
  '',
  '## Current Plan & Subtasks',
  '',
  '## Working Notes & Hypotheses',
  '',
].join('\n');

export class ScratchpadManager {
  private workspaceRoot: string;
  private scratchpadPath: string;
  private readonly shutdown = new AbortController();
  private changeCallbacks: ScratchpadChangeCallback[] = [];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.scratchpadPath = getScratchpadPath(workspaceRoot);
  }

  /**
   * Registers a callback to be invoked whenever scratchpad content is written.
   * Used by the Universal Session State sub-module to persist task progress
   * into SQLite for cross-model resumption.
   */
  public onContentChange(callback: ScratchpadChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Reads the active scratchpad plan.
   */
  public getPlan(): string {
    try {
      return fs.readFileSync(this.scratchpadPath, 'utf8');
    } catch {
      return defaultPlan;
    }
  }

  public async getPlanAsync(): Promise<string> {
    try {
      return await fs.promises.readFile(this.scratchpadPath, 'utf8');
    } catch {
      return defaultPlan;
    }
  }

  /**
   * Overwrites the scratchpad with updated content.
   * Fires registered `onContentChange` callbacks so session state can be
   * persisted to SQLite for cross-model resumption (Universal Session State).
   */
  public async updatePlan(content: string): Promise<void> {
    await this.editPlan(() => content);
  }

  public async editPlan(edit: (current: string) => string, afterWrite?: () => Promise<void>): Promise<void> {
    const content = await withAsyncFileLock(this.scratchpadPath, async (assertOwner) => {
      const current = fileVersion(this.scratchpadPath) ? await fs.promises.readFile(this.scratchpadPath, 'utf8') : defaultPlan;
      const next = edit(current);
      if (next !== current || !fileVersion(this.scratchpadPath)) await publishAtomic(this.scratchpadPath, next, assertOwner);
      await afterWrite?.();
      return next;
    }, this.shutdown.signal);
    // Notify session-state listeners of the change
    for (const cb of this.changeCallbacks) {
      try { cb(content); } catch { /* non-fatal */ }
    }
  }

  /**
   * Appends a new checklist task to the scratchpad plan.
   */
  public async appendTask(task: string): Promise<void> {
    await this.editPlan((current) => `${current.trim()}\n- [ ] ${task}\n`);
  }

  /**
   * Resets the scratchpad to default template.
   */
  public async clearPlan(): Promise<void> {
    await this.updatePlan(defaultPlan);
  }

  // ─── Session persistence & recovery ────────────────────────────────────────

  /**
   * Captures a snapshot of the current scratchpad state (path, existence,
   * content, modification time) so callers can log or display recovery info.
   */
  public captureSnapshot(): ScratchpadSnapshot {
    const exists = fs.existsSync(this.scratchpadPath);
    let content = '';
    let lastModified: number | null = null;

    if (exists) {
      try {
        content = fs.readFileSync(this.scratchpadPath, 'utf8');
        const stats = fs.statSync(this.scratchpadPath);
        lastModified = stats.mtimeMs;
      } catch {
        // Unreadable – treated as empty
      }
    }

    return {
      filePath: this.scratchpadPath,
      exists,
      content,
      lastModified,
    };
  }

  /**
   * Restores scratchpad state across an IDE restart.
   *
   * Behaviour:
   *  • If the scratchpad file already exists on disk, its contents are preserved
   *    and the method returns `true` (no-op – state already intact).
   *  • If the file is missing but `previousContent` is provided, that content is
   *    written back (useful when callers persist content via VS Code globalState).
   *  • Otherwise the default template is written and the method returns `false`.
   */
  public async restoreState(previousContent?: string): Promise<boolean> {
    if (!isWorkspacePath(this.workspaceRoot, this.scratchpadPath)) throw new Error('Unsafe scratchpad path.');
    return withAsyncFileLock(this.scratchpadPath, async (assertOwner) => {
      if (fileVersion(this.scratchpadPath)) return true;
      await publishAtomic(this.scratchpadPath, previousContent?.trim() ? previousContent : defaultPlan, assertOwner);
      return Boolean(previousContent?.trim());
    }, this.shutdown.signal);
  }

  public async syncSessionState(db: DatabaseManager, activeFilePath?: string): Promise<void> {
    await withAsyncFileLock(this.scratchpadPath, async (assertOwner) => {
      if (!fileVersion(this.scratchpadPath)) {
        await publishAtomic(this.scratchpadPath, defaultPlan, assertOwner);
        return;
      }
      const timestamp = fs.statSync(this.scratchpadPath).mtimeMs;
      const saved = await db.sqlite.query('getCurrentSessionState');
      if (saved && saved.timestamp >= timestamp) return;
      const content = await fs.promises.readFile(this.scratchpadPath, 'utf8');
      if (content === defaultPlan) return;
      const completedTasks: string[] = [];
      const pendingTasks: string[] = [];
      for (const match of content.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s+([^\r\n]+)$/gm)) {
        const task = match[2].trim();
        if (task && !/^Step \d+:$/.test(task)) {
          (match[1] === ' ' ? pendingTasks : completedTasks).push(task);
        }
      }
      await db.saveSessionState({
        activeTask: pendingTasks[0],
        completedTasks,
        pendingTasks,
        lastPlanSnapshot: content.slice(0, 1200),
        activeFilePath,
        timestamp,
      });
    }, this.shutdown.signal);
  }

  public async saveCheckpoint(db: DatabaseManager, state: SessionState): Promise<void> {
    const start = '<!-- cuttlehawk:checkpoint -->';
    const end = '<!-- /cuttlehawk:checkpoint -->';
    const legacyStart = '<!-- remem:checkpoint -->';
    const legacyEnd = '<!-- /remem:checkpoint -->';
    await this.editPlan((current) => {
      let first = current.indexOf(start);
      let last = current.indexOf(end);
      let markerEnd = end;
      if (first < 0 && current.indexOf(legacyStart) >= 0) {
        first = current.indexOf(legacyStart);
        last = current.indexOf(legacyEnd);
        markerEnd = legacyEnd;
      }
      if ((first >= 0 || last >= 0) && (first < 0 || last <= first)) {
        throw new Error('Malformed scratchpad checkpoint markers.');
      }
      const clean = (value: string) => value
        .replaceAll(start, '').replaceAll(end, '')
        .replaceAll(legacyStart, '').replaceAll(legacyEnd, '');
      const list = (task: string) => clean(task).replace(/\s+/g, ' ');
      const block = [
        start,
        '## Session checkpoint',
        ...(state.activeTask ? ['Active task: ' + list(state.activeTask)] : []),
        ...(state.completedTasks ?? []).map((task) => '- [x] ' + list(task)),
        ...(state.pendingTasks ?? []).map((task) => '- [ ] ' + list(task)),
        clean(state.lastPlanSnapshot),
        end,
      ].join('\n');
      return first < 0 ? current.trimEnd() + '\n\n' + block + '\n'
        : current.slice(0, first) + block + current.slice(last + markerEnd.length);
    }, async () => {
      await db.saveSessionState({ ...state, timestamp: Math.max(Date.now(), fs.statSync(this.scratchpadPath).mtimeMs) });
    });
  }

  public stop(): void {
    this.shutdown.abort();
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  public get filePath(): string {
    return this.scratchpadPath;
  }

  public get rootPath(): string {
    return this.workspaceRoot;
  }
}
