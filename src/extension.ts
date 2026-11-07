import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { CONFIG, getMemoryDirPath, shouldIgnorePath } from './config.js';
import { DatabaseManager } from './database/index.js';
import { GitStateWatcher } from './git/watcher.js';
import { getFormattedErrorContext } from './git/ledger.js';
import { promptForPostMortem } from './git/prompt.js';
import { SummarizerPipeline } from './summarizer/pipeline.js';
import { setupAntiLoopFileWatcher } from './context/watchers.js';
import { generateDirectoryTree, indexWorkspace } from './summarizer/indexer.js';
import { VaultStorage } from './vault/storage.js';
import { VaultSessionManager } from './vault/session.js';
import { encryptAndStoreSecret, readAndDecryptSecret } from './vault/ui.js';
import { ASTAnalyzer } from './ast/analyzer.js';
import { ScratchpadManager } from './ast/scratchpad.js';
import { assembleContext } from './ast/injector.js';
import { EngineStatus } from './types/index.js';
import { LocalDiffAuditor } from './review/auditor.js';
import { SpecTaskTracker } from './task/tracker.js';
import { TechDebtLedger } from './task/debt.js';
import { ASTContextChunker } from './context/chunker.js';
import { LeanTraceabilityTracker } from './task/traceability.js';
import { WorkspaceIsolationManager } from './core/workspace.js';
import { KnowledgeGraphEngine } from './context/graph.js';
import { PreBootContextProvider } from './context/preboot.js';
import { AsyncASTParser } from './ast/asyncParser.js';

// ─── Module-level singletons (scoped per extension host activation) ──────────

let outputChannel: vscode.OutputChannel | undefined;
let workspaceIsolation: WorkspaceIsolationManager | null = null;
let dbManager: DatabaseManager | null = null;
let pipeline: SummarizerPipeline | null = null;
let gitWatcher: GitStateWatcher | null = null;
let vaultStorage: VaultStorage | null = null;
let vaultSession: VaultSessionManager | null = null;
let astAnalyzer: ASTAnalyzer | null = null;
let scratchpad: ScratchpadManager | null = null;
let diffAuditor: LocalDiffAuditor | null = null;
let taskTracker: SpecTaskTracker | null = null;
let techDebtLedger: TechDebtLedger | null = null;
let astChunker: ASTContextChunker | null = null;
let traceabilityTracker: LeanTraceabilityTracker | null = null;
let graphEngine: KnowledgeGraphEngine | null = null;
let preBootProvider: PreBootContextProvider | null = null;

/** StatusBar item showing ReMem state with a toggle/sync click handler. */
let statusBarItem: vscode.StatusBarItem | undefined;

/** When `false` the engine is paused: file-save summarization is disabled. */
let isEngineActive: boolean = true;

/** workspaceState key used to persist scratchpad content strictly within this workspace (prevents multi-window bleed). */
const SCRATCHPAD_STATE_KEY = 'remem.scratchpadContent';

// ─── Activation ──────────────────────────────────────────────────────────────

/**
 * Extension activation lifecycle entry point.
 *
 * `onStartupFinished` is listed in `activationEvents` so VS Code boots ReMem
 * automatically on every workspace open — no manual command required.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(CONFIG.OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine(`[ReMem] Activating ReMem AI Memory & Token Optimization Engine...`);

  // ── Register all commands unconditionally ─────────────────────────────────
  // Commands MUST be registered before any early-return guard, otherwise VS Code
  // reports "command 'remem.X' not found" whenever activation exits early
  // (e.g. no workspace folder open, or a dependency fails to initialise).
  context.subscriptions.push(
    vscode.commands.registerCommand('remem.status', () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('ReMem: No workspace folder is open.'); return; }
      return showEngineStatus(root);
    }),
    vscode.commands.registerCommand('remem.showScratchpad', () => openOrCreateScratchpad()),
    vscode.commands.registerCommand('remem.purgeMemory', () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('ReMem: No workspace folder is open.'); return; }
      return purgeMemory(root, context);
    }),
    vscode.commands.registerCommand('remem.searchSummaries', () => handleSearchCommand()),
    vscode.commands.registerCommand('remem.reindexWorkspace', () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('ReMem: No workspace folder is open.'); return; }
      return handleReindexCommand(root);
    }),
    vscode.commands.registerCommand('remem.showDirectoryTree', () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('ReMem: No workspace folder is open.'); return; }
      return handleShowTreeCommand(root);
    }),
    vscode.commands.registerCommand('remem.addPostMortem', () => handleAddPostMortemCommand()),
    vscode.commands.registerCommand('remem.showErrorContext', () => handleShowErrorContextCommand()),
    vscode.commands.registerCommand('remem.lockVault', () => handleLockVaultCommand()),
    vscode.commands.registerCommand('remem.encryptActiveFile', () => handleEncryptActiveFileCommand()),
    vscode.commands.registerCommand('remem.viewVaultSecrets', () => handleViewVaultSecretsCommand()),
    vscode.commands.registerCommand('remem.getContext', () => handleGetContextCommand()),
    vscode.commands.registerCommand('remem.toggleSync', () => handleToggleSyncCommand()),
    vscode.commands.registerCommand('remem.reviewDiff', () => handleReviewDiffCommand()),
    vscode.commands.registerCommand('remem.syncTaskProgress', () => handleSyncTaskProgressCommand()),
    vscode.commands.registerCommand('remem.logDebt', () => handleLogDebtCommand()),
    vscode.commands.registerCommand('remem.toggleZeroFluffMode', () => handleToggleZeroFluffModeCommand())
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    outputChannel.appendLine(`[ReMem] No active workspace folder detected. Extension running in standby mode.`);
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  outputChannel.appendLine(`[ReMem] Workspace Root: ${workspaceRoot}`);

  // ── Strict Workspace Isolation & Sandboxing ──────────────────────────────
  workspaceIsolation = new WorkspaceIsolationManager(context, workspaceRoot);

  // ── StatusBar item (created early so it is visible even if init takes time) ─
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'remem.toggleSync';
  updateStatusBar(); // set initial label
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Initialize the local .antigravityMem directory
  ensureMemoryDirectory(workspaceRoot);

  // Initialize unified DatabaseManager (SQLite + Orama) scoped strictly to workspace
  try {
    dbManager = new DatabaseManager();
    await dbManager.initialize(workspaceIsolation.workspaceRoot);
    pipeline = new SummarizerPipeline(dbManager);

    outputChannel.appendLine(`[ReMem Database] SQLite ledger and Orama vector search initialized for workspace.`);

    // ── Session recovery ────────────────────────────────────────────────────
    await performSessionRecovery(context, workspaceRoot);

    // ── Secure Secrets Vault (Native SecretStorage / OS Keychain) ───────────
    vaultStorage = new VaultStorage(workspaceRoot);
    vaultSession = new VaultSessionManager(context.secrets, workspaceRoot, outputChannel);
    pipeline.setVault(vaultStorage, vaultSession);
    outputChannel.appendLine(`[ReMem Vault] Secure Secrets Vault initialized (backed by native SecretStorage).`);

    // ── Scratchpad Manager (.recall_scratchpad.md) (Workspace-Scoped State) ─
    scratchpad = new ScratchpadManager(workspaceRoot);
    const persistedContent = context.workspaceState.get<string>(SCRATCHPAD_STATE_KEY);
    const wasRestored = scratchpad.restoreState(persistedContent);
    outputChannel.appendLine(
      wasRestored
        ? `[ReMem Scratchpad] Scratchpad state restored from workspace session.`
        : `[ReMem Scratchpad] Scratchpad initialized with default template.`
    );

    // ── Universal Session State: persist task progress to SQLite on every ──
    // scratchpad write, enabling cross-model resume via the RESUME STATE block.
    scratchpad.onContentChange((newContent: string) => {
      if (!dbManager) return;
      try {
        // Parse completed / pending tasks from the markdown checklist in scratchpad
        const lines = newContent.split(/\r?\n/);
        const completedTasks: string[] = [];
        const pendingTasks: string[] = [];
        let activeTask: string | undefined;

        for (const line of lines) {
          const doneMatch = line.match(/^\s*[-*+]\s+\[[xX]\]\s+(.+)$/);
          if (doneMatch) {
            completedTasks.push(doneMatch[1].trim());
            continue;
          }
          const pendingMatch = line.match(/^\s*[-*+]\s+\[\s*\]\s+(.+)$/);
          if (pendingMatch) {
            const taskText = pendingMatch[1].trim();
            pendingTasks.push(taskText);
            if (!activeTask) {
              activeTask = taskText; // First pending item is the active task
            }
          }
        }

        dbManager.saveSessionState({
          activeTask,
          completedTasks,
          pendingTasks,
          lastPlanSnapshot: newContent.slice(0, 1200),
          activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
          timestamp: Date.now(),
        });
      } catch {
        // Non-fatal: session state persistence failure should never crash the extension
      }
    });

    // ── AST Dependency Analyzer & Context Chunker (Async / Worker Threads) ──
    astAnalyzer = new ASTAnalyzer();
    await astAnalyzer.initialize();
    astAnalyzer.buildDependencyGraph(workspaceRoot).catch((err) => {
      outputChannel?.appendLine(`[ReMem AST Error] Dependency scan error: ${err}`);
    });

    astChunker = new ASTContextChunker();
    traceabilityTracker = new LeanTraceabilityTracker(workspaceRoot, dbManager, astAnalyzer);
    traceabilityTracker.scanWorkspace(150).catch(() => { });

    // ── Persistent Knowledge Graph ("Graphify") & Pre-Boot Context Provider ─
    graphEngine = new KnowledgeGraphEngine(workspaceRoot, dbManager, astAnalyzer);
    preBootProvider = new PreBootContextProvider(workspaceRoot, graphEngine, dbManager);
    preBootProvider.registerChatParticipant(context);
    // Generate initial persistent architecture map silently in background
    graphEngine.updateContextFeedSilently().catch(() => { });

    // ── Anti-Loop File Watcher (strict 1200ms debounce & internal file filters)
    setupAntiLoopFileWatcher(context, dbManager, pipeline, outputChannel, traceabilityTracker, graphEngine);

    // ── Git State Watcher ──────────────────────────────────────────────────
    gitWatcher = new GitStateWatcher(workspaceRoot, dbManager, outputChannel);
    gitWatcher.setPipeline(pipeline); // wire in pipeline for remote-sync auto-summarization
    await gitWatcher.initialize(context);

    // ── Initial background workspace indexation ────────────────────────────
    indexWorkspace(workspaceRoot, dbManager, pipeline, outputChannel).catch((err) => {
      outputChannel?.appendLine(`[ReMem Indexer Error] Background indexing failed: ${err}`);
    });

    // ── Spec & Task Sync Engine (Zero Fluff Mode Pattern) ────────────────────
    taskTracker = new SpecTaskTracker(workspaceRoot, scratchpad, outputChannel);
    await taskTracker.syncProgress(false);

    // ── Local Diff Auditor (CodeRabbit Pattern) ────────────────────────────
    diffAuditor = new LocalDiffAuditor(workspaceRoot, dbManager, astAnalyzer, scratchpad, outputChannel);

    // ── Tech Debt Ledger (Lean Engine) ─────────────────────────────────────
    techDebtLedger = new TechDebtLedger(workspaceRoot, scratchpad, outputChannel);

    // ── Auto-sync task progress on document save ───────────────────────────
    const taskSaveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (taskTracker && doc.uri.scheme === 'file') {
        const docPath = doc.uri.fsPath;
        const fileName = path.basename(docPath).toLowerCase();
        if (fileName.endsWith('.md') || !shouldIgnorePath(docPath)) {
          taskTracker.syncProgress(false).catch(() => { });
        }
      }
    });
    context.subscriptions.push(taskSaveWatcher);

    // ── Periodically persist scratchpad to workspaceState (no cross-window bleed)
    const scratchpadPersistTimer = setInterval(() => {
      if (scratchpad) {
        const content = scratchpad.getPlan();
        context.workspaceState.update(SCRATCHPAD_STATE_KEY, content);
      }
    }, 60_000); // every 60 seconds
    context.subscriptions.push({ dispose: () => clearInterval(scratchpadPersistTimer) });

  } catch (err) {
    outputChannel.appendLine(`[ReMem Database Error] Failed to initialize database: ${err}`);
    vscode.window.showErrorMessage(`ReMem Database initialization failed: ${err}`);
  }

  outputChannel.appendLine(`[ReMem] ReMem Context Engine activated successfully.`);
}

// ─── Deactivation ─────────────────────────────────────────────────────────────

/**
 * Extension deactivation lifecycle.
 * Ensures in-memory databases are exported and flushed to disk, and vault keys are wiped.
 */
export async function deactivate(): Promise<void> {
  if (vaultSession) {
    vaultSession.lock();
    vaultSession = null;
    vaultStorage = null;
  }

  if (gitWatcher) {
    gitWatcher.dispose();
    gitWatcher = null;
  }

  if (dbManager) {
    outputChannel?.appendLine(`[ReMem] Persisting databases to disk before deactivation...`);
    await dbManager.close();
    dbManager = null;
    pipeline = null;
  }

  astAnalyzer = null;
  scratchpad = null;
  diffAuditor = null;
  taskTracker = null;
  astChunker = null;
  traceabilityTracker = null;
  graphEngine = null;
  preBootProvider = null;
  workspaceIsolation = null;

  AsyncASTParser.getInstance().dispose();

  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }

  if (outputChannel) {
    outputChannel.appendLine(`[ReMem] Deactivating ReMem Context Engine.`);
    outputChannel.dispose();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Returns the active DatabaseManager instance.
 */
export function getDatabaseManager(): DatabaseManager | null {
  return dbManager;
}

// ─── Session recovery ──────────────────────────────────────────────────────────

/**
 * Runs on every startup to restore state from the persisted `.antigravityMem/` directory:
 *
 * 1. Verifies SQLite schema integrity; repairs missing tables if required.
 * 2. Checks whether the Orama vector index is populated; if not (e.g. after an
 *    OS crash that left the JSON file missing), re-hydrates it from SQLite rows.
 * 3. Logs recovery diagnostics to the output channel.
 */
async function performSessionRecovery(
  _context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  if (!dbManager) return;

  const memDir = getMemoryDirPath(workspaceRoot);
  const dbPath = `${memDir}/${CONFIG.DB_FILE_NAME}`;

  // ── 1. Schema integrity ──────────────────────────────────────────────────
  const schemaOk = dbManager.verifySchemaIntegrity();
  outputChannel?.appendLine(
    schemaOk
      ? `[ReMem Recovery] Schema integrity: ✅ intact.`
      : `[ReMem Recovery] Schema integrity: ⚠️  repaired (missing tables were recreated).`
  );

  // ── 2. Vector index re-hydration ─────────────────────────────────────────
  const vectorCount = await dbManager.getStats().then((s) => s.vectorIndexedCount);
  const sqliteCount = await dbManager.getStats().then((s) => s.fileSummariesCount);

  if (sqliteCount > 0 && vectorCount === 0) {
    outputChannel?.appendLine(
      `[ReMem Recovery] Orama index is empty but SQLite has ${sqliteCount} summaries. ` +
      `Re-hydrating vector index from disk…`
    );
    const rehydrated = await dbManager.rehydrateVectorIndexFromSqlite();
    outputChannel?.appendLine(
      `[ReMem Recovery] Vector index re-hydrated with ${rehydrated} document(s).`
    );
  } else {
    outputChannel?.appendLine(
      `[ReMem Recovery] Session state: ${sqliteCount} summaries, ${vectorCount} vectors indexed. ` +
      `DB: ${fs.existsSync(dbPath) ? '✅ found' : '🆕 new'}.`
    );
  }
}

// ─── StatusBar helpers ────────────────────────────────────────────────────────

/**
 * Updates the StatusBar label to reflect the current engine state.
 */
function updateStatusBar(): void {
  if (!statusBarItem) return;

  if (isEngineActive) {
    statusBarItem.text = `$(brain) ReMem: Active`;
    statusBarItem.tooltip = 'ReMem is active. Click to pause auto-summarization or trigger a manual sync.';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(debug-pause) ReMem: Paused`;
    statusBarItem.tooltip = 'ReMem is paused. Click to resume.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

/**
 * Handles the StatusBar click:
 *   • If engine is paused  → resumes it.
 *   • If engine is active  → presents a Quick Pick: Pause | Manual Sync.
 */
async function handleToggleSyncCommand(): Promise<void> {
  if (!isEngineActive) {
    // Resume
    isEngineActive = true;
    updateStatusBar();
    vscode.window.showInformationMessage('ReMem: Engine resumed. Auto-summarization is active.');
    outputChannel?.appendLine('[ReMem] Engine resumed by user.');
    return;
  }

  // Active → offer Pause or Manual Sync
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(sync) Manual Sync Now',
        description: 'Re-check Git remote changes and auto-summarize any new files',
        value: 'sync',
      },
      {
        label: '$(debug-pause) Pause ReMem',
        description: 'Temporarily disable auto-summarization (re-click to resume)',
        value: 'pause',
      },
    ],
    { placeHolder: 'ReMem is active — what would you like to do?' }
  );

  if (!choice) return;

  if (choice.value === 'pause') {
    isEngineActive = false;
    updateStatusBar();
    vscode.window.showInformationMessage('ReMem: Engine paused. Click the StatusBar item to resume.');
    outputChannel?.appendLine('[ReMem] Engine paused by user.');
  } else if (choice.value === 'sync') {
    if (!gitWatcher) {
      vscode.window.showWarningMessage('ReMem: Git watcher is not running (no .git repo detected).');
      return;
    }
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ReMem: Scanning for remote Git changes…',
        cancellable: false,
      },
      async () => {
        const result = await gitWatcher!.triggerManualSync();
        if (result.summarizedCount > 0) {
          vscode.window.showInformationMessage(
            `ReMem Sync: ${result.summarizedCount} file(s) auto-summarized from teammate changes.`
          );
        } else {
          vscode.window.showInformationMessage('ReMem Sync: No new remote changes detected.');
        }
      }
    );
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Ensures the hidden .antigravityMem folder exists in the project root.
 */
function ensureMemoryDirectory(workspaceRoot: string): void {
  const memDir = getMemoryDirPath(workspaceRoot);
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true });
    outputChannel?.appendLine(`[ReMem] Created local memory directory at: ${memDir}`);
  } else {
    outputChannel?.appendLine(`[ReMem] Located existing memory directory at: ${memDir}`);
  }
}

// ─── Command handlers ──────────────────────────────────────────────────────────

/**
 * Displays current engine status via an Information notification and Output Channel.
 */
async function showEngineStatus(workspaceRoot: string): Promise<void> {
  const memDir = getMemoryDirPath(workspaceRoot);
  const isInitialized = fs.existsSync(memDir) && (dbManager?.isReady ?? false);

  const stats = dbManager
    ? await dbManager.getStats()
    : { fileSummariesCount: 0, errorNotesCount: 0, vectorIndexedCount: 0 };
  const vaultCount = vaultStorage ? vaultStorage.count() : 0;
  const isVaultUnlocked = vaultSession ? vaultSession.isUnlocked() : false;

  const status: EngineStatus = {
    workspaceRoot,
    isInitialized,
    totalIndexedFiles: stats.fileSummariesCount,
    ledgerEntriesCount: stats.errorNotesCount,
    vaultEntriesCount: vaultCount,
    isVaultUnlocked,
  };

  const message =
    `ReMem Status: Initialized: ${status.isInitialized} | ` +
    `Summaries: ${stats.fileSummariesCount} | Error Notes: ${stats.errorNotesCount} | ` +
    `Vault Secrets: ${vaultCount} (Unlocked: ${isVaultUnlocked}) | ` +
    `Engine: ${isEngineActive ? 'Active' : 'Paused'}`;

  vscode.window.showInformationMessage(message);
  outputChannel?.appendLine(`[ReMem Status Check]\n${JSON.stringify(status, null, 2)}`);
}

/**
 * Assembles and displays the full token-optimized AI context block for the active file.
 */
async function handleGetContextCommand(): Promise<void> {
  if (!dbManager || !scratchpad || !astAnalyzer) {
    vscode.window.showWarningMessage('ReMem engine components are not ready.');
    return;
  }

  const activeEditor = vscode.window.activeTextEditor;
  const activeFilePath = activeEditor?.document.uri.fsPath;
  const activeBranch = gitWatcher?.activeBranch;

  const assembledContext = await assembleContext(dbManager, scratchpad, astAnalyzer, {
    activeFilePath,
    activeBranch,
    taskTracker: taskTracker || undefined,
    astChunker: astChunker || undefined,
    traceabilityTracker: traceabilityTracker || undefined,
    graphEngine: graphEngine || undefined,
    preBootProvider: preBootProvider || undefined,
  });

  // Copy to clipboard
  await vscode.env.clipboard.writeText(assembledContext);

  // Show preview in markdown editor
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `${assembledContext}\n\n*(Copied to clipboard for AI system prompt)*\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: true });
  vscode.window.showInformationMessage('ReMem: Token-optimized context generated and copied to clipboard.');
}

/**
 * Audits active / staged Git working tree diff against AST dependencies and Orama context.
 */
async function handleReviewDiffCommand(): Promise<void> {
  if (!diffAuditor) {
    vscode.window.showWarningMessage('ReMem Diff Auditor is not ready.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ReMem: Auditing Git diff and AST dependencies...',
      cancellable: false,
    },
    async () => {
      const report = await diffAuditor!.auditDiff();
      if (!report) {
        return;
      }

      // Display in output channel
      outputChannel?.appendLine(`\n${report.markdownReport}\n`);

      // Open in a markdown editor tab for review
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: report.markdownReport,
      });
      await vscode.window.showTextDocument(doc, { preview: true });

      const issueCount = report.issues.length;
      if (issueCount === 0) {
        vscode.window.showInformationMessage(
          `ReMem Diff Audit: Clean! ${report.filesAudited} file(s) audited, 0 issues detected.`
        );
      } else {
        vscode.window.showWarningMessage(
          `ReMem Diff Audit: Audited ${report.filesAudited} file(s) with ${issueCount} item(s) flagged. Review opened in editor.`
        );
      }
    }
  );
}

/**
 * Manually synchronizes spec checklists and phase progress into .recall_scratchpad.md.
 */
async function handleSyncTaskProgressCommand(): Promise<void> {
  if (!taskTracker) {
    vscode.window.showWarningMessage('ReMem Task Tracker is not ready.');
    return;
  }

  const report = await taskTracker.syncProgress(true);
  if (report) {
    outputChannel?.appendLine(
      `[ReMem Spec Tracker] Synced "${report.relativePath}": ${report.completedTasks}/${report.totalTasks} complete (${report.percentage}%). Active phase: "${report.activePhase?.title || 'None'}".`
    );
  }
}

/**
 * Scans workspace files for tech debt and TODO shortcuts and records them in .recall_scratchpad.md.
 */
async function handleLogDebtCommand(): Promise<void> {
  if (!techDebtLedger || !scratchpad) {
    vscode.window.showWarningMessage('ReMem Tech Debt Ledger is not ready.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ReMem: Collecting Tech Debt & Shortcuts...',
      cancellable: false,
    },
    async () => {
      const result = await techDebtLedger!.collectAndRecordDebt();
      outputChannel?.appendLine(
        `[ReMem Tech Debt] Scanned ${result.filesScanned} file(s). Found ${result.totalItems} item(s) across ${result.filesWithDebt} file(s).`
      );

      // Open scratchpad in editor for user review
      const scratchpadPath = scratchpad?.filePath;
      if (scratchpadPath && fs.existsSync(scratchpadPath)) {
        const doc = await vscode.workspace.openTextDocument(scratchpadPath);
        await vscode.window.showTextDocument(doc, { preview: false });
      }

      vscode.window.showInformationMessage(
        `ReMem: Collected ${result.totalItems} tech debt item(s) into .recall_scratchpad.md.`
      );
    }
  );
}

/**
 * Locks the in-memory vault session immediately.
 */
function handleLockVaultCommand(): void {
  if (vaultSession) {
    vaultSession.lock();
    vscode.window.showInformationMessage('ReMem: Vault in-memory session cleared. Native credentials remain safely secured in System Keychain.');
    outputChannel?.appendLine('[ReMem Vault] Vault session cache manually cleared.');
  }
}

/**
 * Encrypts the active text document into the vault.
 */
async function handleEncryptActiveFileCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !vaultStorage || !vaultSession) {
    vscode.window.showWarningMessage('No active file open to encrypt.');
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
  const content = editor.document.getText();

  const success = await encryptAndStoreSecret(filePath, relativePath, content, vaultStorage, vaultSession);
  if (success) {
    vscode.window.showInformationMessage(`ReMem: Encrypted "${relativePath}" and saved into Secure Vault (Native Keychain).`);
    outputChannel?.appendLine(`[ReMem Vault] Encrypted and stored secret: ${relativePath}`);
  }
}

/**
 * Views and allows decrypting stored vault secrets.
 */
async function handleViewVaultSecretsCommand(): Promise<void> {
  if (!vaultStorage || !vaultSession) {
    vscode.window.showWarningMessage('ReMem Vault is not ready.');
    return;
  }

  const secrets = vaultStorage.getAllSecrets();
  if (secrets.length === 0) {
    vscode.window.showInformationMessage('ReMem Vault is empty. No encrypted secrets stored.');
    return;
  }

  const items = secrets.map((s) => ({
    label: s.relativePath,
    description: `Last updated: ${new Date(s.updatedAt).toLocaleString()}`,
    filePath: s.filePath,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a secret to decrypt and view',
  });

  if (selected) {
    const decrypted = await readAndDecryptSecret(selected.filePath, vaultStorage, vaultSession);
    if (decrypted !== null) {
      const doc = await vscode.workspace.openTextDocument({
        language: 'plaintext',
        content: `# Decrypted Secret: ${selected.label}\n\n${decrypted}\n`,
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }
}

/**
 * Manually logs a post-mortem error note.
 */
async function handleAddPostMortemCommand(): Promise<void> {
  if (!dbManager) {
    vscode.window.showWarningMessage('ReMem engine is not ready.');
    return;
  }

  const activeBranch = gitWatcher?.activeBranch || 'main';
  const activeEditor = vscode.window.activeTextEditor;
  const activeFile = activeEditor?.document.uri.fsPath;

  await promptForPostMortem(
    dbManager,
    activeBranch,
    activeFile ? [activeFile] : [],
    undefined,
    outputChannel
  );
}

/**
 * Shows the formatted error context / rollback warnings for active context.
 */
async function handleShowErrorContextCommand(): Promise<void> {
  if (!dbManager) {
    vscode.window.showWarningMessage('ReMem engine is not ready.');
    return;
  }

  const activeEditor = vscode.window.activeTextEditor;
  const activeFile = activeEditor?.document.uri.fsPath;
  const activeBranch = gitWatcher?.activeBranch;

  const errorContext = getFormattedErrorContext(dbManager, activeFile, activeBranch);

  if (!errorContext) {
    vscode.window.showInformationMessage('No error ledger or rollback notes logged for current context.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# Active Error Context & Past Rollbacks\n\n${errorContext}\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Manually re-indexes the workspace.
 */
async function handleReindexCommand(workspaceRoot: string): Promise<void> {
  if (!dbManager || !pipeline) {
    vscode.window.showWarningMessage('ReMem engine is not ready.');
    return;
  }

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ReMem: Indexing workspace files...',
      cancellable: false,
    },
    async () => {
      const result = await indexWorkspace(workspaceRoot, dbManager!, pipeline!, outputChannel);
      vscode.window.showInformationMessage(
        `ReMem Indexing Complete: ${result.indexedCount} updated, ${result.skippedCount} cached (unchanged).`
      );
    }
  );
}

/**
 * Generates and displays the fast serialized directory tree.
 */
async function handleShowTreeCommand(workspaceRoot: string): Promise<void> {
  const tree = generateDirectoryTree(workspaceRoot);
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# Workspace Structure Tree\n\n\`\`\`\n${tree}\n\`\`\`\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Interactive command allowing the user or agent to search file summaries.
 */
async function handleSearchCommand(): Promise<void> {
  if (!dbManager) {
    vscode.window.showWarningMessage('ReMem database is not yet ready.');
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: 'Search project context summaries (e.g. "auth middleware", "database connection")',
    placeHolder: 'Enter search term...',
  });

  if (!query) {
    return;
  }

  const results = await dbManager.searchSummaries(query, 5);
  if (results.length === 0) {
    vscode.window.showInformationMessage(`No file summaries found matching "${query}".`);
    return;
  }

  const items = results.map((r) => ({
    label: r.document.relativePath,
    description: `Score: ${r.score.toFixed(2)}`,
    detail: r.document.summary,
    filePath: r.document.filePath,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Matches for "${query}"`,
  });

  if (selected) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.filePath));
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Opens or creates the active scratchpad (.recall_scratchpad.md).
 */
async function openOrCreateScratchpad(): Promise<void> {
  if (!scratchpad) {
    return;
  }

  const scratchpadPath = scratchpad.filePath;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchpadPath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Toggles the Zero Fluff Mode setting in the workspace configuration.
 * When Zero Fluff Mode is active the context feed is stripped to raw code, paths, and
 * terminal commands only — no pleasantries, no explanations.
 */
async function handleToggleZeroFluffModeCommand(): Promise<void> {
  const config = vscode.workspace.getConfiguration('remem');
  const current = config.get<boolean>('ZeroFluffMode', false);
  await config.update('ZeroFluffMode', !current, vscode.ConfigurationTarget.Workspace);
  if (!current) {
    vscode.window.showInformationMessage(
      '⚡ ReMem Zero Fluff Mode ACTIVATED — Context feed is now execution-only. Zero pleasantries.'
    );
    outputChannel?.appendLine('[ReMem] Zero Fluff Mode activated.');
  } else {
    vscode.window.showInformationMessage('ReMem Zero Fluff Mode deactivated — Normal context mode restored.');
    outputChannel?.appendLine('[ReMem] Zero Fluff Mode deactivated.');
  }
}

/**
 * Purges the local .antigravityMem cache and rebuilds database structures.
 */
async function purgeMemory(workspaceRoot: string, context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Are you sure you want to purge local AI context memory (.antigravityMem)?',
    { modal: true },
    'Yes, Purge'
  );

  if (confirm === 'Yes, Purge') {
    if (vaultSession) {
      vaultSession.lock();
    }

    if (dbManager) {
      await dbManager.close();
      dbManager = null;
      pipeline = null;
    }

    const memDir = getMemoryDirPath(workspaceRoot);
    if (fs.existsSync(memDir)) {
      fs.rmSync(memDir, { recursive: true, force: true });
    }

    ensureMemoryDirectory(workspaceRoot);

    dbManager = new DatabaseManager();
    await dbManager.initialize(workspaceRoot);
    pipeline = new SummarizerPipeline(dbManager);
    vaultStorage = new VaultStorage(workspaceRoot);
    vaultSession = new VaultSessionManager(context.secrets, workspaceRoot, outputChannel);
    pipeline.setVault(vaultStorage, vaultSession);

    // Re-initialize diffAuditor and taskTracker
    if (astAnalyzer && scratchpad) {
      taskTracker = new SpecTaskTracker(workspaceRoot, scratchpad, outputChannel);
      diffAuditor = new LocalDiffAuditor(workspaceRoot, dbManager, astAnalyzer, scratchpad, outputChannel);
    }

    // Re-wire the scratchpad → SQLite session state callback to the new dbManager
    // (The old callback's closure reference was nulled out above, so we need a fresh one)
    if (scratchpad) {
      scratchpad.onContentChange((newContent: string) => {
        if (!dbManager) return;
        try {
          const lines = newContent.split(/\r?\n/);
          const completedTasks: string[] = [];
          const pendingTasks: string[] = [];
          let activeTask: string | undefined;
          for (const line of lines) {
            const doneMatch = line.match(/^\s*[-*+]\s+\[[xX]\]\s+(.+)$/);
            if (doneMatch) { completedTasks.push(doneMatch[1].trim()); continue; }
            const pendingMatch = line.match(/^\s*[-*+]\s+\[\s*\]\s+(.+)$/);
            if (pendingMatch) {
              const taskText = pendingMatch[1].trim();
              pendingTasks.push(taskText);
              if (!activeTask) { activeTask = taskText; }
            }
          }
          dbManager.saveSessionState({
            activeTask, completedTasks, pendingTasks,
            lastPlanSnapshot: newContent.slice(0, 1200),
            activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
            timestamp: Date.now(),
          });
        } catch { /* non-fatal */ }
      });
    }

    // Update preBootProvider with the fresh dbManager after purge
    if (preBootProvider) {
      preBootProvider.setDatabaseManager(dbManager);
    }

    // Also clear the persisted scratchpad content from workspaceState (isolated per window)
    await context.workspaceState.update(SCRATCHPAD_STATE_KEY, undefined);

    if (graphEngine) {
      await graphEngine.updateContextFeedSilently().catch(() => { });
    }

    if (scratchpad) {
      scratchpad.clearPlan();
    }

    vscode.window.showInformationMessage('ReMem: Local memory directory and databases purged and reset.');
    outputChannel?.appendLine(`[ReMem] Local memory and databases purged and reset.`);
  }
}
