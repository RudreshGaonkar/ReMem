import { DatabaseManager } from '../database/index.js';
import { ErrorLedgerEntry } from '../types/index.js';

/**
 * Queries the error ledger and formats post-mortem notes into a prompt-ready warning block.
 */
export function getFormattedErrorContext(
  dbManager: DatabaseManager,
  activeFilePath?: string,
  activeBranch?: string
): string {
  const fileNotes = activeFilePath ? dbManager.getErrorNotesForFile(activeFilePath) : [];
  const branchNotes = activeBranch ? dbManager.getErrorNotesForBranch(activeBranch) : [];

  // Deduplicate entries by ID or postMortemNote + timestamp
  const seenIds = new Set<number | string>();
  const combinedNotes: ErrorLedgerEntry[] = [];

  for (const note of [...fileNotes, ...branchNotes]) {
    const key = note.id !== undefined ? note.id : `${note.postMortemNote}-${note.timestamp}`;
    if (!seenIds.has(key)) {
      seenIds.add(key);
      combinedNotes.push(note);
    }
  }

  if (combinedNotes.length === 0) {
    return '';
  }

  return formatNotesForPrompt(combinedNotes);
}

/**
 * Formats an array of ErrorLedgerEntry items into Markdown prompt injection text.
 */
export function formatNotesForPrompt(notes: ErrorLedgerEntry[]): string {
  if (notes.length === 0) {
    return '';
  }

  const lines: string[] = [
    '### ⚠️ PAST ATTEMPTS & ERROR LEDGER (DO NOT REPEAT PREVIOUS MISTAKES):',
  ];

  for (const note of notes) {
    const dateStr = new Date(note.timestamp).toISOString().split('T')[0];
    const target = note.filePath ? ` [File: ${note.filePath}]` : '';
    lines.push(`- **[Branch: ${note.branch}] (${dateStr})${target}:** ${note.postMortemNote}`);
  }

  return lines.join('\n');
}
