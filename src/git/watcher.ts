import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { simpleGit, SimpleGit } from 'simple-git';
import { DatabaseManager } from '../database/index.js';
import { promptForPostMortem } from './prompt.js';

export class GitStateWatcher {
  private git: SimpleGit;
  private workspaceRoot: string;
  private dbManager: DatabaseManager;
  private outputChannel?: vscode.OutputChannel;
  private currentBranch: string = '';
  private lastCommitHash: string = '';
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(workspaceRoot: string, dbManager: DatabaseManager, outputChannel?: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.dbManager = dbManager;
    this.outputChannel = outputChannel;
    this.git = simpleGit(workspaceRoot);
  }

  /**
   * Initializes the Git state tracker and sets up filesystem watchers on .git/HEAD and .git/refs.
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    const gitDir = path.join(this.workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      this.outputChannel?.appendLine(`[ReMem Git] No .git directory found at ${this.workspaceRoot}. Git ledger standing by.`);
      return;
    }

    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        return;
      }

      // Read initial branch and commit
      const status = await this.git.status();
      this.currentBranch = status.current || 'HEAD';
      const log = await this.git.log({ maxCount: 1 }).catch(() => null);
      this.lastCommitHash = log?.latest?.hash || '';

      this.outputChannel?.appendLine(`[ReMem Git] Initialized Git watcher on branch "${this.currentBranch}" (${this.lastCommitHash.substring(0, 7)})`);

      // Setup file watcher on .git/HEAD and .git/refs/**
      const gitPattern = new vscode.RelativePattern(this.workspaceRoot, '.git/{HEAD,refs/**,ORIG_HEAD}');
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(gitPattern);

      this.fileWatcher.onDidChange(() => this.handleGitStateChange());
      this.fileWatcher.onDidCreate(() => this.handleGitStateChange());

      context.subscriptions.push(this.fileWatcher);
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Git Error] Failed to initialize git tracker: ${err}`);
    }
  }

  /**
   * Debounces and evaluates git state change upon .git filesystem events.
   */
  private handleGitStateChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Debounce to allow git CLI operations to finish atomic writes
    this.debounceTimer = setTimeout(async () => {
      try {
        const status = await this.git.status();
        const newBranch = status.current || 'HEAD';
        const log = await this.git.log({ maxCount: 1 }).catch(() => null);
        const newCommitHash = log?.latest?.hash || '';

        // Check if branch switched
        if (this.currentBranch && this.currentBranch !== newBranch && this.currentBranch !== 'HEAD') {
          const oldBranch = this.currentBranch;
          this.outputChannel?.appendLine(`[ReMem Git] Branch transition detected: "${oldBranch}" -> "${newBranch}"`);

          // Update branch state before showing prompt
          this.currentBranch = newBranch;
          this.lastCommitHash = newCommitHash;

          // Prompt user for post-mortem note on the previous branch
          await promptForPostMortem(this.dbManager, oldBranch, status.modified, this.lastCommitHash, this.outputChannel);
        } else if (newBranch !== this.currentBranch) {
          this.currentBranch = newBranch;
          this.lastCommitHash = newCommitHash;
        }
      } catch (err) {
        this.outputChannel?.appendLine(`[ReMem Git Error] Error checking git status: ${err}`);
      }
    }, 600);
  }

  /**
   * Returns current active branch name.
   */
  public get activeBranch(): string {
    return this.currentBranch;
  }

  /**
   * Disposes watchers.
   */
  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
    }
  }
}
