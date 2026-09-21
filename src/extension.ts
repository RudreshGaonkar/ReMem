import * as vscode from 'vscode';
import * as fs from 'fs';
import { CONFIG, getMemoryDirPath } from './config.js';
import { DatabaseManager } from './database/index.js';
import { GitStateWatcher } from './git/watcher.js';
import { getFormattedErrorContext } from './git/ledger.js';
import { promptForPostMortem } from './git/prompt.js';
import { SummarizerPipeline } from './summarizer/pipeline.js';
import { setupFileWatcher } from './summarizer/watcher.js';
import { generateDirectoryTree, indexWorkspace } from './summarizer/indexer.js';
import { VaultStorage } from './vault/storage.js';
import { VaultSessionManager } from './vault/session.js';
import { encryptAndStoreSecret, readAndDecryptSecret } from './vault/ui.js';
import { ASTAnalyzer } from './ast/analyzer.js';
import { ScratchpadManager } from './ast/scratchpad.js';
import { assembleContext } from './ast/injector.js';
import { EngineStatus } from './types/index.js';

let outputChannel: vscode.OutputChannel | undefined;
let dbManager: DatabaseManager | null = null;
let pipeline: SummarizerPipeline | null = null;
let gitWatcher: GitStateWatcher | null = null;
let vaultStorage: VaultStorage | null = null;
let vaultSession: VaultSessionManager | null = null;
let astAnalyzer: ASTAnalyzer | null = null;
let scratchpad: ScratchpadManager | null = null;

/**
 * Extension activation lifecycle entry point.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(CONFIG.OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine(`[ReMem] Activating ReMem AI Memory & Token Optimization Engine...`);

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    outputChannel.appendLine(`[ReMem] No active workspace folder detected. Extension running in standby mode.`);
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  outputChannel.appendLine(`[ReMem] Workspace Root: ${workspaceRoot}`);

  // Initialize the local .antigravityMem directory
  ensureMemoryDirectory(workspaceRoot);

  // Initialize unified DatabaseManager (SQLite + Orama)
  try {
    dbManager = new DatabaseManager();
    await dbManager.initialize(workspaceRoot);
    pipeline = new SummarizerPipeline(dbManager);
    outputChannel.appendLine(`[ReMem Database] SQLite ledger and Orama vector search initialized successfully.`);

    // Initialize Secure Secrets Vault
    vaultStorage = new VaultStorage(workspaceRoot);
    vaultSession = new VaultSessionManager(CONFIG.VAULT_CACHE_TIMEOUT_MS);
    outputChannel.appendLine(`[ReMem Vault] Secure Secrets Vault initialized.`);

    // Initialize Scratchpad Manager (.recall_scratchpad.md)
    scratchpad = new ScratchpadManager(workspaceRoot);

    // Initialize AST Dependency Analyzer
    astAnalyzer = new ASTAnalyzer();
    await astAnalyzer.initialize();
    astAnalyzer.buildDependencyGraph(workspaceRoot).catch((err) => {
      outputChannel?.appendLine(`[ReMem AST Error] Dependency scan error: ${err}`);
    });

    // Setup active file watchers for onDidSaveTextDocument
    setupFileWatcher(context, dbManager, pipeline, outputChannel);

    // Setup Git State Watcher (.git/HEAD file watcher)
    gitWatcher = new GitStateWatcher(workspaceRoot, dbManager, outputChannel);
    await gitWatcher.initialize(context);

    // Trigger initial background workspace indexation
    indexWorkspace(workspaceRoot, dbManager, pipeline, outputChannel).catch((err) => {
      outputChannel?.appendLine(`[ReMem Indexer Error] Background indexing failed: ${err}`);
    });
  } catch (err) {
    outputChannel.appendLine(`[ReMem Database Error] Failed to initialize database: ${err}`);
    vscode.window.showErrorMessage(`ReMem Database initialization failed: ${err}`);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('remem.status', () => showEngineStatus(workspaceRoot)),
    vscode.commands.registerCommand('remem.showScratchpad', () => openOrCreateScratchpad()),
    vscode.commands.registerCommand('remem.purgeMemory', () => purgeMemory(workspaceRoot)),
    vscode.commands.registerCommand('remem.searchSummaries', () => handleSearchCommand()),
    vscode.commands.registerCommand('remem.reindexWorkspace', () => handleReindexCommand(workspaceRoot)),
    vscode.commands.registerCommand('remem.showDirectoryTree', () => handleShowTreeCommand(workspaceRoot)),
    vscode.commands.registerCommand('remem.addPostMortem', () => handleAddPostMortemCommand()),
    vscode.commands.registerCommand('remem.showErrorContext', () => handleShowErrorContextCommand()),
    vscode.commands.registerCommand('remem.lockVault', () => handleLockVaultCommand()),
    vscode.commands.registerCommand('remem.encryptActiveFile', () => handleEncryptActiveFileCommand()),
    vscode.commands.registerCommand('remem.viewVaultSecrets', () => handleViewVaultSecretsCommand()),
    vscode.commands.registerCommand('remem.getContext', () => handleGetContextCommand())
  );

  outputChannel.appendLine(`[ReMem] ReMem Context Engine activated successfully.`);
}

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

  if (outputChannel) {
    outputChannel.appendLine(`[ReMem] Deactivating ReMem Context Engine.`);
    outputChannel.dispose();
  }
}

/**
 * Returns the active DatabaseManager instance.
 */
export function getDatabaseManager(): DatabaseManager | null {
  return dbManager;
}

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

/**
 * Displays current engine status via an Information notification and Output Channel.
 */
async function showEngineStatus(workspaceRoot: string): Promise<void> {
  const memDir = getMemoryDirPath(workspaceRoot);
  const isInitialized = fs.existsSync(memDir) && (dbManager?.isReady ?? false);

  const stats = dbManager ? await dbManager.getStats() : { fileSummariesCount: 0, errorNotesCount: 0, vectorIndexedCount: 0 };
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

  const message = `ReMem Status: Initialized: ${status.isInitialized} | Summaries: ${stats.fileSummariesCount} | Error Notes: ${stats.errorNotesCount} | Vault Secrets: ${vaultCount} (Unlocked: ${isVaultUnlocked})`;
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
 * Locks the in-memory vault session immediately.
 */
function handleLockVaultCommand(): void {
  if (vaultSession) {
    vaultSession.lock();
    vscode.window.showInformationMessage('ReMem: Vault session locked. Master key wiped from memory.');
    outputChannel?.appendLine('[ReMem Vault] Vault session manually locked.');
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
    vscode.window.showInformationMessage(`ReMem: Encrypted "${relativePath}" and saved into Secure Vault.`);
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
 * Purges the local .antigravityMem cache and rebuilds database structures.
 */
async function purgeMemory(workspaceRoot: string): Promise<void> {
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

    if (scratchpad) {
      scratchpad.clearPlan();
    }

    vscode.window.showInformationMessage('ReMem: Local memory directory and databases purged and reset.');
    outputChannel?.appendLine(`[ReMem] Local memory and databases purged and reset.`);
  }
}
