import * as path from 'path';
import { DatabaseManager } from '../database/index.js';
import { getFormattedErrorContext } from '../git/ledger.js';
import { ASTAnalyzer } from './analyzer.js';
import { ScratchpadManager } from './scratchpad.js';

import { SpecTaskTracker } from '../task/tracker.js';

export interface AssembleContextOptions {
  activeFilePath?: string;
  activeBranch?: string;
  currentTurn?: number;
  maxTurnAge?: number;
  taskTracker?: SpecTaskTracker;
  specTaskContext?: string;
}

/**
 * LRU Context Manager tracks file touch recency across conversation turns.
 */
export class LRUContextManager {
  private turnMap: Map<string, number> = new Map(); // filePath -> turn
  private maxTurns: number;

  constructor(maxTurns: number = 3) {
    this.maxTurns = maxTurns;
  }

  public touch(filePath: string, currentTurn: number): void {
    this.turnMap.set(filePath, currentTurn);
  }

  public getActiveFiles(currentTurn: number): string[] {
    const active: string[] = [];
    for (const [filePath, turn] of this.turnMap.entries()) {
      if (currentTurn - turn < this.maxTurns) {
        active.push(filePath);
      }
    }
    return active;
  }

  public prune(currentTurn: number): void {
    for (const [filePath, turn] of this.turnMap.entries()) {
      if (currentTurn - turn >= this.maxTurns) {
        this.turnMap.delete(filePath);
      }
    }
  }
}

/**
 * Assembles a token-optimized, consolidated prompt context block combining:
 * 1. Active file structural summary
 * 2. AST Blast Radius (dependent files that import it + their summaries)
 * 3. Error Ledger post-mortem warnings
 * 4. Multi-step plan from .recall_scratchpad.md
 */
export async function assembleContext(
  dbManager: DatabaseManager,
  scratchpad: ScratchpadManager,
  astAnalyzer: ASTAnalyzer,
  options: AssembleContextOptions = {}
): Promise<string> {
  const { activeFilePath, activeBranch = 'main' } = options;
  const sections: string[] = [];

  sections.push('# 🧠 REMEM TOKEN-OPTIMIZED CONTEXT INJECTION');

  // 1. Active Build Phase & Spec Milestones (GSD Pattern)
  if (options.taskTracker) {
    const taskContext = options.taskTracker.getActiveTaskContext();
    if (taskContext) {
      sections.push(`\n${taskContext}`);
    }
  } else if (options.specTaskContext) {
    sections.push(`\n${options.specTaskContext}`);
  }

  // 2. Active Scratchpad Plan
  const plan = scratchpad.getPlan().trim();
  if (plan) {
    sections.push(`\n## 🎯 ACTIVE EXECUTION PLAN (.recall_scratchpad.md)\n${plan}`);
  }

  // 2. Active File Summary
  if (activeFilePath) {
    const activeSummary = dbManager.getFileSummary(activeFilePath);
    const relPath = path.relative(scratchpad.rootPath, activeFilePath);

    sections.push(`\n## 📄 ACTIVE FILE CONTEXT (${relPath})`);
    if (activeSummary) {
      sections.push(`- **Summary:** ${activeSummary.summary}`);
      sections.push(`- **Estimated Tokens:** ~${activeSummary.tokenCountEstimate} | **Encrypted:** ${activeSummary.isEncrypted}`);
    } else {
      sections.push(`- **File:** ${relPath} (Unindexed or new file)`);
    }

    // 3. AST Blast Radius (Dependents)
    const blastRadius = astAnalyzer.getBlastRadius(activeFilePath);
    if (blastRadius.dependents.length > 0) {
      sections.push(`\n## 💥 AST BLAST RADIUS (Files that import this module)`);
      for (const depPath of blastRadius.dependents.slice(0, 5)) {
        const depRel = path.relative(scratchpad.rootPath, depPath);
        const depSummary = dbManager.getFileSummary(depPath);
        const summaryText = depSummary ? `: ${depSummary.summary}` : '';
        sections.push(`- \`${depRel}\`${summaryText}`);
      }
      if (blastRadius.dependents.length > 5) {
        sections.push(`- *...and ${blastRadius.dependents.length - 5} more dependent files.*`);
      }
    }
  }

  // 4. Git Branch & Rollback Error Ledger
  const errorWarnings = getFormattedErrorContext(dbManager, activeFilePath, activeBranch);
  if (errorWarnings) {
    sections.push(`\n## ⚠️ PAST ATTEMPTS & ERROR LEDGER\n${errorWarnings}`);
  }

  return sections.join('\n');
}
