import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { simpleGit, SimpleGit } from 'simple-git';
import { DatabaseManager } from '../database/index.js';
import { promptForPostMortem } from './prompt.js';
import { SummarizerPipeline } from '../summarizer/pipeline.js';
import { shouldIgnorePath } from '../config.js';

/**
 * Result returned after a remote-pull sync sweep.
 */
export interface RemoteSyncResult {
  detectedFiles: string[];
  summarizedCount: number;
  skippedCount: number;
}

export class GitStateWatcher {
  private git: SimpleGit;
  private workspaceRoot: string;
  private dbManager: DatabaseManager;
  private pipeline: SummarizerPipeline | null = null;
  private outputChannel?: vscode.OutputChannel;

  private currentBranch: string = '';
  private lastCommitHash: string = '';

  /** Watcher for branch / commit transitions (.git/HEAD, .git/refs, .git/ORIG_HEAD) */
  private gitStateWatcher: vscode.FileSystemWatcher | null = null;

  /** Watcher for incoming remote changes (.git/FETCH_HEAD, .git/refs/remotes/, .git/index) */
  private remoteSyncWatcher: vscode.FileSystemWatcher | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;
  private remoteSyncDebounce: NodeJS.Timeout | null = null;

  /** Tracks file paths that were present in the last known git index snapshot. */
  private lastIndexedPaths: Set<string> = new Set();

  /** SHA-256 of FETCH_HEAD at last remote-sync check – avoids redundant sweeps. */
  private lastFetchHeadHash: string = '';

  constructor(workspaceRoot: string, dbManager: DatabaseManager, outputChannel?: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.dbManager = dbManager;
    this.outputChannel = outputChannel;
    this.git = simpleGit(workspaceRoot);
  }

  /**
   * Attaches a SummarizerPipeline so the remote-sync watcher can auto-summarize
   * incoming files. Call this immediately after constructing, before initialize().
   */
  public setPipeline(pipeline: SummarizerPipeline): void {
    this.pipeline = pipeline;
  }

  /**
   * Initializes the Git state tracker and sets up filesystem watchers on:
   *   • .git/HEAD, .git/refs/**, .git/ORIG_HEAD  (branch / commit transitions)
   *   • .git/FETCH_HEAD, .git/refs/remotes/**,  (remote pull / merge / checkout)
   *     .git/index
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    const gitDir = path.join(this.workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      this.outputChannel?.appendLine(
        `[ReMem Git] No .git directory found at ${this.workspaceRoot}. Git ledger standing by.`
      );
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

      this.outputChannel?.appendLine(
        `[ReMem Git] Initialized Git watcher on branch "${this.currentBranch}" (${this.lastCommitHash.substring(0, 7)})`
      );

      // Snapshot what files are currently tracked so we can diff after a pull
      await this.snapshotTrackedFiles();

      // ── Watcher 1: Branch / commit state (.git/HEAD, refs, ORIG_HEAD) ────────
      const gitStatePattern = new vscode.RelativePattern(
        this.workspaceRoot,
        '.git/{HEAD,refs/**,ORIG_HEAD}'
      );
      this.gitStateWatcher = vscode.workspace.createFileSystemWatcher(gitStatePattern);
      this.gitStateWatcher.onDidChange(() => this.handleGitStateChange());
      this.gitStateWatcher.onDidCreate(() => this.handleGitStateChange());
      context.subscriptions.push(this.gitStateWatcher);

      // ── Watcher 2: Remote sync (.git/FETCH_HEAD, refs/remotes/**, .git/index) ─
      const remoteSyncPattern = new vscode.RelativePattern(
        this.workspaceRoot,
        '.git/{FETCH_HEAD,index,refs/remotes/**}'
      );
      this.remoteSyncWatcher = vscode.workspace.createFileSystemWatcher(remoteSyncPattern);
      this.remoteSyncWatcher.onDidChange(() => this.handleRemoteSyncEvent());
      this.remoteSyncWatcher.onDidCreate(() => this.handleRemoteSyncEvent());
      context.subscriptions.push(this.remoteSyncWatcher);
    } catch (err) {
      this.outputChannel?.appendLine(`[ReMem Git Error] Failed to initialize git tracker: ${err}`);
    }
  }

  // ─── Branch / commit state ────────────────────────────────────────────────

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
          this.outputChannel?.appendLine(
            `[ReMem Git] Branch transition detected: "${oldBranch}" -> "${newBranch}"`
          );

          // Update branch state before showing prompt
          this.currentBranch = newBranch;
          this.lastCommitHash = newCommitHash;

          // Prompt user for post-mortem note on the previous branch
          await promptForPostMortem(
            this.dbManager,
            oldBranch,
            status.modified,
            this.lastCommitHash,
            this.outputChannel
          );
        } else if (newBranch !== this.currentBranch) {
          this.currentBranch = newBranch;
          this.lastCommitHash = newCommitHash;
        }
      } catch (err) {
        this.outputChannel?.appendLine(`[ReMem Git Error] Error checking git status: ${err}`);
      }
    }, 600);
  }

  // ─── Remote pull / merge sync ─────────────────────────────────────────────

  /**
   * Fires when FETCH_HEAD / refs/remotes / index changes, indicating an incoming
   * `git pull`, `git fetch`, `git merge`, or `git checkout` from a remote.
   */
  private handleRemoteSyncEvent(): void {
    if (this.remoteSyncDebounce) {
      clearTimeout(this.remoteSyncDebounce);
    }

    // 1 200 ms debounce – git writes several files atomically; we wait for the dust to settle
    this.remoteSyncDebounce = setTimeout(async () => {
      try {
        await this.runRemoteSyncSweep();
      } catch (err) {
        this.outputChannel?.appendLine(`[ReMem Git Sync Error] Remote sync sweep failed: ${err}`);
      }
    }, 1200);
  }

  /**
   * Core remote-sync logic:
   *   1. Guards against duplicate sweeps via a FETCH_HEAD SHA-256 check.
   *   2. Diffs git-tracked files against the last known snapshot.
   *   3. For each changed file, computes a SHA-256 and compares against the
   *      SQLite `file_summaries` hash column.
   *   4. Triggers background summarization for every file whose hash differs.
   */
  public async runRemoteSyncSweep(): Promise<RemoteSyncResult> {
    const result: RemoteSyncResult = { detectedFiles: [], summarizedCount: 0, skippedCount: 0 };

    // ── Guard: only act when FETCH_HEAD actually changed ─────────────────────
    const fetchHeadPath = path.join(this.workspaceRoot, '.git', 'FETCH_HEAD');
    if (fs.existsSync(fetchHeadPath)) {
      const raw = fs.readFileSync(fetchHeadPath, 'utf8');
      const currentFetchHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
      if (currentFetchHash === this.lastFetchHeadHash) {
        // Nothing new since last sweep
        return result;
      }
      this.lastFetchHeadHash = currentFetchHash;
    }

    if (!this.pipeline) {
      this.outputChannel?.appendLine(
        `[ReMem Git Sync] No pipeline attached – skipping auto-summarization.`
      );
      return result;
    }

    // ── Determine changed files via git diff ──────────────────────────────────
    let changedFiles: string[] = [];
    try {
      // Get files changed between the previous commit and current HEAD
      const diffSummary = await this.git.diffSummary(['HEAD@{1}', 'HEAD']).catch(() => null);
      if (diffSummary && diffSummary.files.length > 0) {
        changedFiles = diffSummary.files
          .map((f) => path.join(this.workspaceRoot, f.file))
          .filter((fp) => !shouldIgnorePath(fp) && fs.existsSync(fp));
      }
    } catch {
      // Fallback: compare current tracked files against last snapshot
      changedFiles = await this.detectChangedFilesViaSnapshot();
    }

    // Also refresh snapshot for next sweep
    await this.snapshotTrackedFiles();

    if (changedFiles.length === 0) {
      return result;
    }

    this.outputChannel?.appendLine(
      `[ReMem Git Sync] Remote changes detected — ${changedFiles.length} file(s) to review.`
    );

    // ── Per-file SHA-256 check and summarization ──────────────────────────────
    for (const filePath of changedFiles) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory() || stats.size > 1024 * 1024) {
          continue; // skip dirs and large binaries
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const currentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const existing = this.dbManager.getFileSummary(filePath);

        if (existing && existing.hash === currentHash) {
          result.skippedCount++;
          continue; // content identical – already summarized
        }

        result.detectedFiles.push(filePath);
        const relativePath = path.relative(this.workspaceRoot, filePath);

        await this.pipeline!.summarizeContent(filePath, relativePath, content);
        result.summarizedCount++;

        this.outputChannel?.appendLine(
          `[ReMem Git Sync] Auto-summarized teammate change: ${relativePath}`
        );
      } catch {
        // Binary or unreadable file – skip silently
        continue;
      }
    }

    // Flush updated summaries to disk
    if (result.summarizedCount > 0) {
      await this.dbManager.flushToDisk();
      this.outputChannel?.appendLine(
        `[ReMem Git Sync] Sync complete — ${result.summarizedCount} file(s) summarized, ` +
          `${result.skippedCount} unchanged.`
      );
      vscode.window.showInformationMessage(
        `ReMem: Teammate changes synced — ${result.summarizedCount} file(s) auto-summarized.`
      );
    }

    return result;
  }

  // ─── Tracked-file snapshot helpers ───────────────────────────────────────

  /**
   * Snapshots the list of files currently tracked by git so we can diff after
   * a pull when `git diff HEAD@{1} HEAD` is unavailable (e.g. first commit).
   */
  private async snapshotTrackedFiles(): Promise<void> {
    try {
      const tracked = await this.git.raw(['ls-files']).catch(() => '');
      const files = tracked
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => path.join(this.workspaceRoot, f));
      this.lastIndexedPaths = new Set(files);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Fallback change-detection: compares the current git-tracked file list
   * against the last snapshot and returns files that are new or modified.
   */
  private async detectChangedFilesViaSnapshot(): Promise<string[]> {
    const changed: string[] = [];
    try {
      const tracked = await this.git.raw(['ls-files']).catch(() => '');
      const currentFiles = tracked
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => path.join(this.workspaceRoot, f));

      for (const fp of currentFiles) {
        if (!this.lastIndexedPaths.has(fp)) {
          changed.push(fp); // new file
        } else if (fs.existsSync(fp)) {
          changed.push(fp); // may have changed content – let hash guard catch unchanged
        }
      }
    } catch {
      // Non-fatal
    }
    return changed;
  }

  // ─── Public accessors ─────────────────────────────────────────────────────

  /**
   * Returns current active branch name.
   */
  public get activeBranch(): string {
    return this.currentBranch;
  }

  /**
   * Exposes a manual trigger for the remote sync sweep (used by the StatusBar toggle command).
   */
  public async triggerManualSync(): Promise<RemoteSyncResult> {
    // Reset the FETCH_HEAD guard so a manual trigger always runs
    this.lastFetchHeadHash = '';
    return this.runRemoteSyncSweep();
  }

  /**
   * Disposes all watchers and timers.
   */
  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.remoteSyncDebounce) {
      clearTimeout(this.remoteSyncDebounce);
      this.remoteSyncDebounce = null;
    }
    if (this.gitStateWatcher) {
      this.gitStateWatcher.dispose();
      this.gitStateWatcher = null;
    }
    if (this.remoteSyncWatcher) {
      this.remoteSyncWatcher.dispose();
      this.remoteSyncWatcher = null;
    }
  }
}
