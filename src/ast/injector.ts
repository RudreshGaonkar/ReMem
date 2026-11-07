import * as path from 'path';
import { DatabaseManager } from '../database/index.js';
import { getFormattedErrorContext } from '../git/ledger.js';
import { ASTAnalyzer } from './analyzer.js';
import { ScratchpadManager } from './scratchpad.js';
import { SpecTaskTracker } from '../task/tracker.js';
import { getLeanRulesContext } from '../context/leanRules.js';
import { getZeroTrustSecurityPersonaContext, getZeroFluffModeContext } from '../context/security.js';
import { ASTContextChunker } from '../context/chunker.js';
import { LeanTraceabilityTracker } from '../task/traceability.js';
import { PreBootContextProvider } from '../context/preboot.js';
import { KnowledgeGraphEngine } from '../context/graph.js';

export interface AssembleContextOptions {
  activeFilePath?: string;
  activeBranch?: string;
  currentTurn?: number;
  maxTurnAge?: number;
  taskTracker?: SpecTaskTracker;
  specTaskContext?: string;
  includeLeanRules?: boolean;
  includeSecurityPersona?: boolean;
  includePreBootContext?: boolean;
  preBootProvider?: PreBootContextProvider;
  graphEngine?: KnowledgeGraphEngine;
  astChunker?: ASTContextChunker;
  traceabilityTracker?: LeanTraceabilityTracker;
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
 * 1. Zero-Trust AppSec Engineer Persona (Pre-generation OWASP Top 10 defense)
 * 2. Lean Engine Decision Hierarchy
 * 3. Active build phase & spec checklist
 * 4. Active execution plan from .recall_scratchpad.md
 * 5. Active file summary
 * 6. Most relevant AST chunks (web-tree-sitter functions, classes, interfaces)
 * 7. Ripple Effect Warning from SQLite Lean Traceability Ledger
 * 8. Error Ledger post-mortem warnings
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

  // ── Zero Fluff Mode Protocol ──────────────────────────────────────────────
  // When Zero Fluff Mode is enabled this block takes precedence — injected first so
  // the AI model sees the execution-only directive before any other context.
  const zeroFluffBlock = getZeroFluffModeContext();
  if (zeroFluffBlock) {
    sections.push(`\n${zeroFluffBlock}`);
  }

  // Pre-Boot Context Provider: Persistent Knowledge Graph Architecture Map
  if (options.includePreBootContext !== false) {
    const preboot =
      options.preBootProvider ||
      new PreBootContextProvider(
        scratchpad.rootPath,
        options.graphEngine || new KnowledgeGraphEngine(scratchpad.rootPath, dbManager, astAnalyzer)
      );
    try {
      const prebootBlock = await preboot.getPreBootSystemPrompt();
      if (prebootBlock) {
        sections.push(`\n${prebootBlock}`);
      }
    } catch {
      // Non-blocking fallback
    }
  }

  // 1. Permanent Zero-Trust AppSec Engineer Persona (Pre-generation OWASP defense)
  if (options.includeSecurityPersona !== false) {
    const securityPersona = getZeroTrustSecurityPersonaContext();
    if (securityPersona) {
      sections.push(`\n${securityPersona}`);
    }
  }

  // 2. Lean Engine: Concise Decision Hierarchy prepended to AI prompts
  if (options.includeLeanRules !== false) {
    const leanRules = getLeanRulesContext();
    if (leanRules) {
      sections.push(`\n${leanRules}`);
    }
  }

  // 3. Active Build Phase & Spec Milestones (Zero Fluff Mode Pattern)
  if (options.taskTracker) {
    const taskContext = options.taskTracker.getActiveTaskContext();
    if (taskContext) {
      sections.push(`\n${taskContext}`);
    }
  } else if (options.specTaskContext) {
    sections.push(`\n${options.specTaskContext}`);
  }

  // 4. Active Scratchpad Plan
  const plan = scratchpad.getPlan().trim();
  if (plan) {
    sections.push(`\n## 🎯 ACTIVE EXECUTION PLAN (.recall_scratchpad.md)\n${plan}`);
  }

  // 5. Active File Summary & Relevant AST Chunks
  if (activeFilePath) {
    const activeSummary = dbManager.getFileSummary(activeFilePath);
    const relPath = path.relative(scratchpad.rootPath, activeFilePath);

    sections.push(`\n## 📄 ACTIVE FILE CONTEXT (\`${relPath}\`)`);
    if (activeSummary) {
      sections.push(`- **Summary:** ${activeSummary.summary}`);
      sections.push(`- **Estimated Tokens:** ~${activeSummary.tokenCountEstimate} | **Encrypted:** ${activeSummary.isEncrypted}`);
    } else {
      sections.push(`- **File:** \`${relPath}\` (Unindexed or new file)`);
    }

    // 6. Granular AST Context Chunks (web-tree-sitter: functions, interfaces, classes)
    const chunker = options.astChunker || new ASTContextChunker();
    try {
      const relevantChunks = await chunker.getRelevantChunks(activeFilePath, dbManager.vector, {
        maxChunks: 3,
        relativePath: relPath,
      });

      if (relevantChunks.length > 0) {
        sections.push(`\n## 🧩 RELEVANT AST CODE CHUNKS (Token-Optimized Retrieval)`);
        for (const chunk of relevantChunks) {
          const linesLabel = chunk.startLine ? ` (lines ${chunk.startLine}-${chunk.endLine})` : '';
          sections.push(`\n### ${chunk.kind.toUpperCase()}: \`${chunk.name}\`${linesLabel}`);
          sections.push('```typescript');
          sections.push(chunk.content);
          sections.push('```');
        }
      }
    } catch {
      // Non-blocking fallback
    }

    // 7. Ripple Effect Warning (Lean Traceability Tracker)
    const tracker =
      options.traceabilityTracker ||
      new LeanTraceabilityTracker(scratchpad.rootPath, dbManager, astAnalyzer);
    const rippleWarning = tracker.generateRippleEffectWarning(activeFilePath);
    if (rippleWarning) {
      sections.push(`\n${rippleWarning}`);
    } else {
      // Fallback: AST Blast Radius (Dependents)
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
  }

  // 8. Git Branch & Rollback Error Ledger
  const errorWarnings = getFormattedErrorContext(dbManager, activeFilePath, activeBranch);
  if (errorWarnings) {
    sections.push(`\n## ⚠️ PAST ATTEMPTS & ERROR LEDGER\n${errorWarnings}`);
  }

  return sections.join('\n');
}
