import * as fs from 'fs';
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
export class ScratchpadManager {
  private workspaceRoot: string;
  private scratchpadPath: string;
  private changeCallbacks: ScratchpadChangeCallback[] = [];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.scratchpadPath = getScratchpadPath(workspaceRoot);
    this.ensureScratchpad();
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
   * Ensures the scratchpad file exists with a default template.
   */
  public ensureScratchpad(): string {
    if (!fs.existsSync(this.scratchpadPath)) {
      const initialTemplate = [
        '# 📝 ReMem Active Scratchpad',
        '',
        '> This hidden file tracks multi-step AI execution plans, context notes, and active subtasks.',
        '',
        '## 🎯 Current Plan & Subtasks',
        '- [ ] Step 1: ',
        '- [ ] Step 2: ',
        '',
        '## 💡 Working Notes & Hypotheses',
        '- ',
      ].join('\n');

      fs.writeFileSync(this.scratchpadPath, initialTemplate, 'utf8');
    }
    return this.scratchpadPath;
  }

  /**
   * Reads the active scratchpad plan.
   */
  public getPlan(): string {
    this.ensureScratchpad();
    try {
      return fs.readFileSync(this.scratchpadPath, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Overwrites the scratchpad with updated content.
   * Fires registered `onContentChange` callbacks so session state can be
   * persisted to SQLite for cross-model resumption (Universal Session State).
   */
  public updatePlan(content: string): void {
    fs.writeFileSync(this.scratchpadPath, content, 'utf8');
    // Notify session-state listeners of the change
    for (const cb of this.changeCallbacks) {
      try { cb(content); } catch { /* non-fatal */ }
    }
  }

  /**
   * Appends a new checklist task to the scratchpad plan.
   */
  public appendTask(task: string): void {
    const current = this.getPlan();
    const updated = `${current.trim()}\n- [ ] ${task}\n`;
    this.updatePlan(updated);
  }

  /**
   * Resets the scratchpad to default template.
   */
  public clearPlan(): void {
    if (fs.existsSync(this.scratchpadPath)) {
      fs.unlinkSync(this.scratchpadPath);
    }
    this.ensureScratchpad();
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
  public restoreState(previousContent?: string): boolean {
    if (fs.existsSync(this.scratchpadPath)) {
      // Already present on disk – state is intact
      return true;
    }

    if (previousContent && previousContent.trim().length > 0) {
      fs.writeFileSync(this.scratchpadPath, previousContent, 'utf8');
      return true;
    }

    // Nothing to restore – write the default template
    this.ensureScratchpad();
    return false;
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  public get filePath(): string {
    return this.scratchpadPath;
  }

  public get rootPath(): string {
    return this.workspaceRoot;
  }
}
