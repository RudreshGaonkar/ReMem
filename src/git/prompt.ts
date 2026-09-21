import * as vscode from 'vscode';
import { DatabaseManager } from '../database/index.js';
import { ErrorLedgerEntry } from '../types/index.js';

/**
 * Prompts the developer for a post-mortem note when a Git branch change or rollback occurs.
 */
export async function promptForPostMortem(
  dbManager: DatabaseManager,
  branchName: string,
  changedFiles: string[] = [],
  commitHash?: string,
  outputChannel?: vscode.OutputChannel
): Promise<ErrorLedgerEntry | null> {
  const promptMessage = `ReMem: Switched from branch "${branchName}". Any post-mortem note or warning for AI?`;

  const note = await vscode.window.showInputBox({
    prompt: promptMessage,
    placeHolder: 'e.g., "Abandoned approach X due to race conditions in OAuth token refresh"',
    ignoreFocusOut: true,
  });

  if (!note || note.trim().length === 0) {
    outputChannel?.appendLine(`[ReMem Git Ledger] Post-mortem prompt skipped by user for branch: ${branchName}`);
    return null;
  }

  const trimmedNote = note.trim();
  const timestamp = Date.now();

  // If specific files were modified, create entries for each file; otherwise create general branch note
  if (changedFiles.length > 0) {
    for (const filePath of changedFiles) {
      const entry: ErrorLedgerEntry = {
        branch: branchName,
        commitHash,
        filePath,
        postMortemNote: trimmedNote,
        timestamp,
        resolved: false,
      };
      dbManager.addErrorNote(entry);
    }
  } else {
    const entry: ErrorLedgerEntry = {
      branch: branchName,
      commitHash,
      postMortemNote: trimmedNote,
      timestamp,
      resolved: false,
    };
    dbManager.addErrorNote(entry);
  }

  await dbManager.flushToDisk();

  vscode.window.showInformationMessage(`ReMem: Post-mortem note logged for AI memory (${branchName}).`);
  outputChannel?.appendLine(`[ReMem Git Ledger] Logged error ledger entry for [${branchName}]: "${trimmedNote}"`);

  return {
    branch: branchName,
    commitHash,
    postMortemNote: trimmedNote,
    timestamp,
    resolved: false,
  };
}
