import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ScratchpadManager } from '../ast/scratchpad.js';
import { shouldIgnorePath, getMemoryDirPath } from '../config.js';
import { ChecklistItem, PhaseInfo, SpecFileReport } from '../types/index.js';

const MAX_SPEC_SIZE_BYTES = 1024 * 1024; // 1 MB cap
const SYNC_START = '<!-- REMEM_SYNCED_SPEC_START -->';
const SYNC_END = '<!-- REMEM_SYNCED_SPEC_END -->';

/**
 * Spec & Task Sync Engine (GSD Pattern)
 * Discovers spec and progress markdown files, extracts phase checklists,
 * syncs active build state into .recall_scratchpad.md, and locks AI context to the current milestone.
 */
export class SpecTaskTracker {
  private workspaceRoot: string;
  private scratchpad: ScratchpadManager;
  private outputChannel?: vscode.OutputChannel;
  private latestReport: SpecFileReport | null = null;

  constructor(workspaceRoot: string, scratchpad: ScratchpadManager, outputChannel?: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.scratchpad = scratchpad;
    this.outputChannel = outputChannel;
  }

  /**
   * Scans workspace root and docs directories to locate spec or progress tracker files.
   */
  public findSpecFiles(): string[] {
    const candidateFiles: { filePath: string; priority: number }[] = [];
    const searchDirs = [this.workspaceRoot];

    // Check optional subdirectories if present
    const docsDir = path.join(this.workspaceRoot, 'docs');
    if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
      searchDirs.push(docsDir);
    }
    const specsDir = path.join(this.workspaceRoot, 'specs');
    if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
      searchDirs.push(specsDir);
    }

    const specPatterns = [
      { regex: /^.*spec.*\.md$/i, priority: 10 },
      { regex: /^.*specification.*\.md$/i, priority: 10 },
      { regex: /^progress.*\.md$/i, priority: 9 },
      { regex: /^roadmap.*\.md$/i, priority: 8 },
      { regex: /^tasks?.*\.md$/i, priority: 7 },
      { regex: /^todo.*\.md$/i, priority: 6 },
      { regex: /^\.recall_scratchpad\.md$/i, priority: 1 }, // Fallback default
    ];

    for (const dir of searchDirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;

          const fullPath = path.join(dir, entry.name);
          if (shouldIgnorePath(fullPath) && entry.name !== '.recall_scratchpad.md') {
            continue;
          }

          for (const pattern of specPatterns) {
            if (pattern.regex.test(entry.name)) {
              candidateFiles.push({ filePath: fullPath, priority: pattern.priority });
              break;
            }
          }
        }
      } catch {
        // Non-fatal directory read
      }
    }

    // Sort by priority descending (explicit specs take precedence over scratchpad fallback)
    candidateFiles.sort((a, b) => b.priority - a.priority);
    return candidateFiles.map((c) => c.filePath);
  }

  /**
   * Parses markdown checklist items and phase headings from a given spec file.
   */
  public parseSpecFile(filePath: string): SpecFileReport | null {
    if (!fs.existsSync(filePath)) return null;

    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_SPEC_SIZE_BYTES) {
        this.outputChannel?.appendLine(
          `[ReMem Spec Tracker] File ${filePath} exceeds 1 MB limit (${(stat.size / 1024).toFixed(0)} KB). Skipping parse.`
        );
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      const phases: PhaseInfo[] = [];
      let currentPhase: PhaseInfo = {
        title: 'Initial Tasks',
        level: 2,
        items: [],
        totalTasks: 0,
        completedTasks: 0,
        percentage: 0,
      };

      const headingRegex = /^(#{1,6})\s+(.+)$/;
      const checklistPendingRegex = /^\s*[-*+]\s+\[\s*\]\s+(.+)$/;
      const checklistCompletedRegex = /^\s*[-*+]\s+\[[xX]\]\s+(.+)$/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip synced section markers when reading .recall_scratchpad.md
        if (line.includes(SYNC_START)) {
          while (i < lines.length && !lines[i].includes(SYNC_END)) {
            i++;
          }
          continue;
        }

        const headingMatch = line.match(headingRegex);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const title = headingMatch[2].trim();

          // If current phase has items, push it to phases list before starting a new phase
          if (currentPhase.items.length > 0) {
            currentPhase.totalTasks = currentPhase.items.length;
            currentPhase.completedTasks = currentPhase.items.filter((item) => item.completed).length;
            currentPhase.percentage = Math.round((currentPhase.completedTasks / currentPhase.totalTasks) * 100);
            phases.push(currentPhase);
          }

          currentPhase = {
            title,
            level,
            items: [],
            totalTasks: 0,
            completedTasks: 0,
            percentage: 0,
          };
          continue;
        }

        const pendingMatch = line.match(checklistPendingRegex);
        if (pendingMatch) {
          currentPhase.items.push({
            text: pendingMatch[1].trim(),
            completed: false,
            line: i + 1,
          });
          continue;
        }

        const completedMatch = line.match(checklistCompletedRegex);
        if (completedMatch) {
          currentPhase.items.push({
            text: completedMatch[1].trim(),
            completed: true,
            line: i + 1,
          });
          continue;
        }
      }

      // Finalize last phase
      if (currentPhase.items.length > 0) {
        currentPhase.totalTasks = currentPhase.items.length;
        currentPhase.completedTasks = currentPhase.items.filter((item) => item.completed).length;
        currentPhase.percentage = Math.round((currentPhase.completedTasks / currentPhase.totalTasks) * 100);
        phases.push(currentPhase);
      }

      // Calculate totals across all phases
      let totalTasks = 0;
      let completedTasks = 0;
      for (const phase of phases) {
        totalTasks += phase.totalTasks;
        completedTasks += phase.completedTasks;
      }

      const overallPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      // Identify active phase: first phase with pending items (or last phase if all complete)
      let activePhase: PhaseInfo | null = null;
      for (const phase of phases) {
        if (phase.items.some((item) => !item.completed)) {
          activePhase = phase;
          break;
        }
      }
      if (!activePhase && phases.length > 0) {
        activePhase = phases[phases.length - 1];
      }

      // Identify next pending task
      let nextPendingTask: ChecklistItem | null = null;
      if (activePhase) {
        nextPendingTask = activePhase.items.find((item) => !item.completed) || null;
      }
      if (!nextPendingTask) {
        for (const phase of phases) {
          const item = phase.items.find((i) => !i.completed);
          if (item) {
            nextPendingTask = item;
            break;
          }
        }
      }

      return {
        filePath,
        relativePath: path.relative(this.workspaceRoot, filePath),
        phases,
        totalTasks,
        completedTasks,
        percentage: overallPercentage,
        activePhase,
        nextPendingTask,
      };
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Spec Tracker] Error parsing spec ${filePath}: ${err}`);
      return null;
    }
  }

  /**
   * Discovers the best spec file, calculates progress, updates .recall_scratchpad.md, and caches the report.
   */
  public async syncProgress(showNotification: boolean = false): Promise<SpecFileReport | null> {
    const specFiles = this.findSpecFiles();
    if (specFiles.length === 0) {
      if (showNotification) {
        vscode.window.showInformationMessage('ReMem Task Tracker: No spec or checklist files found in workspace.');
      }
      return null;
    }

    const primarySpecPath = specFiles[0];
    const report = this.parseSpecFile(primarySpecPath);
    if (!report) {
      return null;
    }

    this.latestReport = report;

    // Synchronize into .recall_scratchpad.md if the primary spec is an external file
    const scratchpadPath = this.scratchpad.filePath;
    const isScratchpadItself = path.resolve(primarySpecPath) === path.resolve(scratchpadPath);

    if (!isScratchpadItself && report.totalTasks > 0) {
      this.updateScratchpadSyncedSection(report);
    }

    // Persist a snapshot copy into .antigravityMem/task_progress.json for safe indexing
    this.persistReportToMem(report);

    const logMsg = `[ReMem Spec Tracker] Synced ${report.relativePath}: ${report.completedTasks}/${report.totalTasks} tasks complete (${report.percentage}%). Active phase: "${report.activePhase?.title || 'None'}".`;
    this.outputChannel?.appendLine(logMsg);

    if (showNotification) {
      vscode.window.showInformationMessage(
        `ReMem: Synced spec progress from "${report.relativePath}" (${report.completedTasks}/${report.totalTasks} complete, ${report.percentage}%).`
      );
    }

    return report;
  }

  /**
   * Injects or updates the demarcated synchronized section in .recall_scratchpad.md without modifying user notes.
   */
  private updateScratchpadSyncedSection(report: SpecFileReport): void {
    try {
      const currentContent = this.scratchpad.getPlan();
      const pendingItems = report.activePhase
        ? report.activePhase.items.filter((item) => !item.completed).slice(0, 5)
        : [];

      const syncedLines = [
        SYNC_START,
        `## 📋 Synced Spec Progress (Auto-synced from \`${report.relativePath}\`)`,
        `- **Active Phase**: ${report.activePhase ? report.activePhase.title : 'All Milestones Complete'}`,
        `- **Progress**: ${report.completedTasks}/${report.totalTasks} tasks completed (${report.percentage}%)`,
        report.nextPendingTask
          ? `- **Immediate Objective**: ${report.nextPendingTask.text}`
          : `- **Immediate Objective**: All tasks completed 🎉`,
        '',
        '### 📌 Pending Checklist in Active Phase:',
        ...(pendingItems.length > 0
          ? pendingItems.map((item) => `- [ ] ${item.text}`)
          : ['- [x] All tasks in this phase are complete!']),
        SYNC_END,
      ];

      const syncedBlock = syncedLines.join('\n');

      let updatedContent = '';
      if (currentContent.includes(SYNC_START) && currentContent.includes(SYNC_END)) {
        const startIndex = currentContent.indexOf(SYNC_START);
        const endIndex = currentContent.indexOf(SYNC_END) + SYNC_END.length;
        updatedContent =
          currentContent.substring(0, startIndex) +
          syncedBlock +
          currentContent.substring(endIndex);
      } else {
        updatedContent = currentContent.trim() + '\n\n' + syncedBlock + '\n';
      }

      this.scratchpad.updatePlan(updatedContent);
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Spec Tracker] Error updating scratchpad sync section: ${err}`);
    }
  }

  /**
   * Formats active build phase and task context for prompt injection in remem.getContext.
   */
  public getActiveTaskContext(): string {
    const report = this.latestReport;
    if (!report || report.totalTasks === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push(`## 🎯 ACTIVE BUILD PHASE & SPEC MILESTONES (\`${report.relativePath}\`)`);
    if (report.activePhase) {
      lines.push(`- **Current Phase:** ${report.activePhase.title}`);
      lines.push(
        `- **Phase Completion:** ${report.activePhase.completedTasks}/${report.activePhase.totalTasks} tasks (${report.activePhase.percentage}%)`
      );
    }
    lines.push(
      `- **Overall Spec Progress:** ${report.completedTasks}/${report.totalTasks} tasks completed (${report.percentage}%)`
    );
    if (report.nextPendingTask) {
      lines.push(`- **Current Objective / Next Task:** ${report.nextPendingTask.text}`);
    }

    if (report.activePhase) {
      const pending = report.activePhase.items.filter((item) => !item.completed).slice(0, 5);
      if (pending.length > 0) {
        lines.push(`- **Upcoming Checklist in Active Phase:**`);
        for (const item of pending) {
          lines.push(`  - [ ] ${item.text}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Returns the cached spec report if available.
   */
  public getLatestReport(): SpecFileReport | null {
    return this.latestReport;
  }

  /**
   * Persists the parsed report JSON strictly into .antigravityMem/task_progress.json.
   */
  private persistReportToMem(report: SpecFileReport): void {
    try {
      const memDir = getMemoryDirPath(this.workspaceRoot);
      if (fs.existsSync(memDir)) {
        const targetPath = path.join(memDir, 'task_progress.json');
        fs.writeFileSync(targetPath, JSON.stringify(report, null, 2), 'utf8');
      }
    } catch {
      // Non-fatal cache write
    }
  }
}
