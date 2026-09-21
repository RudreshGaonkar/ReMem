import * as fs from 'fs';
import { getScratchpadPath } from '../config.js';

/**
 * Manages the active workspace scratchpad (.recall_scratchpad.md).
 */
export class ScratchpadManager {
  private workspaceRoot: string;
  private scratchpadPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.scratchpadPath = getScratchpadPath(workspaceRoot);
    this.ensureScratchpad();
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
   */
  public updatePlan(content: string): void {
    fs.writeFileSync(this.scratchpadPath, content, 'utf8');
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

  public get filePath(): string {
    return this.scratchpadPath;
  }

  public get rootPath(): string {
    return this.workspaceRoot;
  }
}
