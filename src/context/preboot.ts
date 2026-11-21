import * as fs from 'fs';
import * as path from 'path';
import { isWorkspacePath } from '../core/files.js';
import { KnowledgeGraphEngine } from './graph.js';
import { DatabaseManager } from '../database/index.js';

export const PREBOOT_AI_INSTRUCTION =
  'Use this architecture map to orient yourself. Verify relevant source and tests before making changes.';

/**
 * Pre-Boot Context Provider
 *
 * Builds the shared architecture and session resume context for editor and MCP callers.
 */
export class PreBootContextProvider {
  private workspaceRoot: string;
  private graphEngine?: KnowledgeGraphEngine;
  private dbManager?: DatabaseManager;

  constructor(workspaceRoot: string, graphEngine?: KnowledgeGraphEngine, dbManager?: DatabaseManager) {
    this.workspaceRoot = workspaceRoot;
    this.graphEngine = graphEngine;
    this.dbManager = dbManager;
  }

  /**
   * Wires in a DatabaseManager instance so session state can be injected into pre-boot context.
   */
  public setDatabaseManager(db: DatabaseManager): void {
    this.dbManager = db;
  }

  /**
   * Generates the complete pre-boot system prompt context injection block.
   * Includes a RESUME STATE block when an active session is found in SQLite.
   */
  public async getPreBootSystemPrompt(): Promise<string> {
    const feedContent = await this.loadContextFeed();

    const sections: string[] = [];
    sections.push('## 🗺️ PRE-BOOT PROJECT ARCHITECTURE MAP (ReMem Graph Engine)');
    sections.push(`> **MANDATORY DIRECTIVE:** ${PREBOOT_AI_INSTRUCTION}`);
    sections.push('');

    // ── Universal Session Resume Block ───────────────────────────────────────
    const resumeBlock = await this.buildResumeStateBlock();
    if (resumeBlock) {
      sections.push(resumeBlock);
      sections.push('');
    }

    const maxFeedCharacters = 6000;
    sections.push(feedContent.trim().slice(0, maxFeedCharacters));
    if (feedContent.length > maxFeedCharacters) sections.push('See .remem_context_feed.md for the full map.');

    return sections.join('\n');
  }

  /**
   * Reads the last persisted session state from SQLite and returns a formatted
   * `## 🔄 RESUME STATE` markdown block, or `null` if no active session exists.
   */
  public async buildResumeStateBlock(): Promise<string | null> {
    if (!this.dbManager) {
      return null;
    }

    let sessionState: ReturnType<DatabaseManager['getCurrentSessionState']>;
    try {
      sessionState = await this.dbManager.sqlite.query('getCurrentSessionState');
    } catch {
      return null;
    }

    if (!sessionState) {
      return null;
    }

    const { activeTask, completedTasks, pendingTasks, lastPlanSnapshot, activeFilePath, timestamp } = sessionState;

    // Only inject a resume block when there is genuine work-in-progress
    if (!activeTask && pendingTasks.length === 0 && !lastPlanSnapshot) {
      return null;
    }

    const ago = this.humanRelativeTime(timestamp);
    const lines: string[] = [
      '## 🔄 RESUME STATE',
      `> Last saved ${ago}. Check the current plan before continuing.`,
      '',
    ];

    if (activeTask) {
      lines.push(`- **Was Working On:** ${activeTask}`);
    }

    if (activeFilePath) {
      lines.push(`- **Active File at Interruption:** \`${activeFilePath}\``);
    }

    if (completedTasks.length > 0) {
      lines.push(`- **Completed Steps (${completedTasks.length}):**`);
      for (const task of completedTasks.slice(-5)) {
        lines.push(`  - [x] ${task}`);
      }
    }

    if (pendingTasks.length > 0) {
      lines.push(`- **Remaining Steps (${pendingTasks.length}):**`);
      for (const task of pendingTasks.slice(0, 5)) {
        lines.push(`  - [ ] ${task}`);
      }
    }

    if (lastPlanSnapshot && lastPlanSnapshot.trim().length > 0) {
      lines.push('');
      lines.push('### Last Plan Snapshot');
      lines.push('```');
      lines.push(lastPlanSnapshot.slice(0, 800)); // Cap to prevent token bloat
      if (lastPlanSnapshot.length > 800) {
        lines.push('... [snapshot truncated]');
      }
      lines.push('```');
    }

    return lines.join('\n');
  }

  /**
   * Returns a human-readable relative time string (e.g. "5 minutes ago").
   */
  private humanRelativeTime(timestamp: number): string {
    const diffMs = Math.max(0, Date.now() - timestamp);
    const diffSeconds = Math.floor(diffMs / 1000);
    if (diffSeconds < 60) return `${diffSeconds}s ago`;
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  /**
   * Loads the current .remem_context_feed.md from the isolated workspace root.
   */
  private async loadContextFeed(): Promise<string> {
    const feedPath = path.join(this.workspaceRoot, '.remem_context_feed.md');

    if (!isWorkspacePath(this.workspaceRoot, feedPath)) throw new Error('Unsafe context feed path');
    try {
      if (fs.existsSync(feedPath)) {
        const content = await fs.promises.readFile(feedPath, 'utf8');
        if (content && content.trim().length > 0) {
          return content;
        }
      }
    } catch {
      // Fall through to generation
    }

    if (this.graphEngine) {
      const generated = await this.graphEngine.generateCompressedArchitectureMap();
      if (generated && generated.trim().length > 0) {
        return generated;
      }
    }

    return '# Project Architecture Map not yet generated. Trigger ReMem Re-index.';
  }

}
