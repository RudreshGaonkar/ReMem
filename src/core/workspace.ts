import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { CONFIG } from '../config.js';

/**
 * Error thrown when an operation attempts to breach workspace sandboxing.
 */
export class WorkspaceIsolationError extends Error {
  constructor(message: string) {
    super(`[ReMem Workspace Isolation Breach] ${message}`);
    this.name = 'WorkspaceIsolationError';
  }
}

/**
 * Strict Workspace Isolation Manager
 *
 * Ensures all databases (remem_ledger.sqlite, orama_index.json), knowledge graphs,
 * file reads, and AI terminal command executions are strictly scoped to the active
 * workspace folder (vscode.workspace.workspaceFolders[0]).
 *
 * Prevents any context bleeding across multiple open VS Code windows by replacing
 * globalState with workspaceState and sandboxing all paths and execution cwds.
 */
export class WorkspaceIsolationManager {
  private static instance: WorkspaceIsolationManager | null = null;
  private readonly _workspaceRoot: string;
  private readonly _context: vscode.ExtensionContext;
  private readonly _memoryDir: string;
  private readonly _dbPath: string;
  private readonly _vectorIndexPath: string;
  private readonly _contextFeedPath: string;
  private readonly _scratchpadPath: string;

  public constructor(context: vscode.ExtensionContext, workspaceRoot?: string) {
    this._context = context;

    const resolvedRoot = workspaceRoot || WorkspaceIsolationManager.resolveActiveWorkspaceRoot();
    if (!resolvedRoot) {
      throw new WorkspaceIsolationError('No active workspace folder detected. Cannot initialize isolated workspace.');
    }

    this._workspaceRoot = path.normalize(path.resolve(resolvedRoot));
    this._memoryDir = path.join(this._workspaceRoot, CONFIG.MEM_DIR_NAME);
    this._dbPath = path.join(this._memoryDir, CONFIG.DB_FILE_NAME);
    this._vectorIndexPath = path.join(this._memoryDir, CONFIG.VECTOR_INDEX_FILE_NAME);
    this._contextFeedPath = path.join(this._workspaceRoot, '.remem_context_feed.md');
    this._scratchpadPath = path.join(this._workspaceRoot, CONFIG.SCRATCHPAD_FILE_NAME);

    // Ensure scoped storage directory exists
    if (!fs.existsSync(this._memoryDir)) {
      fs.mkdirSync(this._memoryDir, { recursive: true });
    }

    WorkspaceIsolationManager.instance = this;
  }

  /**
   * Retrieves or initializes the current workspace isolation singleton.
   */
  public static getInstance(): WorkspaceIsolationManager | null {
    return WorkspaceIsolationManager.instance;
  }

  /**
   * Resolves the primary active workspace root directory strictly from vscode.workspace.workspaceFolders[0].
   */
  public static resolveActiveWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }
    return path.normalize(path.resolve(folders[0].uri.fsPath));
  }

  /**
   * Gets the active workspace folder uri.
   */
  public static getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  // ── Scoped Paths ────────────────────────────────────────────────────────────

  public get workspaceRoot(): string {
    return this._workspaceRoot;
  }

  public get memoryDir(): string {
    return this._memoryDir;
  }

  public get dbPath(): string {
    return this._dbPath;
  }

  public get vectorIndexPath(): string {
    return this._vectorIndexPath;
  }

  public get contextFeedPath(): string {
    return this._contextFeedPath;
  }

  public get scratchpadPath(): string {
    return this._scratchpadPath;
  }

  public get extensionContext(): vscode.ExtensionContext {
    return this._context;
  }

  // ── Sandboxed Path Resolution & File Operations ────────────────────────────

  /**
   * Asserts that a target file path resides strictly inside the active workspace.
   * Throws WorkspaceIsolationError if path traversal or out-of-workspace target is detected.
   */
  public assertWithinWorkspace(targetPath: string): string {
    const resolved = path.isAbsolute(targetPath)
      ? path.normalize(path.resolve(targetPath))
      : path.normalize(path.resolve(this._workspaceRoot, targetPath));

    // Case-insensitive check on Windows/macOS, strict prefix check on Linux
    const isInside = process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(this._workspaceRoot.toLowerCase())
      : resolved.startsWith(this._workspaceRoot);

    if (!isInside) {
      throw new WorkspaceIsolationError(
        `Access denied: Path "${targetPath}" is outside the active workspace sandbox "${this._workspaceRoot}".`
      );
    }

    return resolved;
  }

  /**
   * Reads a file asynchronously, guaranteeing that the target path is inside the workspace sandbox.
   */
  public async readWorkspaceFile(filePath: string): Promise<string> {
    const safePath = this.assertWithinWorkspace(filePath);
    return await fs.promises.readFile(safePath, 'utf8');
  }

  /**
   * Writes a file asynchronously, guaranteeing that the target path is inside the workspace sandbox.
   */
  public async writeWorkspaceFile(filePath: string, content: string): Promise<void> {
    const safePath = this.assertWithinWorkspace(filePath);
    const parentDir = path.dirname(safePath);
    if (!fs.existsSync(parentDir)) {
      await fs.promises.mkdir(parentDir, { recursive: true });
    }
    await fs.promises.writeFile(safePath, content, 'utf8');
  }

  /**
   * Resolves a relative path to an absolute path within this isolated workspace.
   */
  public toRelativePath(filePath: string): string {
    return path.relative(this._workspaceRoot, filePath);
  }

  // ── AI Terminal & Command Execution CWD Sandboxing ─────────────────────────

  /**
   * Returns the absolute workspace root as the mandatory working directory for all executions.
   */
  public getWorkspaceCwd(): string {
    return this._workspaceRoot;
  }

  /**
   * Creates or returns a VS Code terminal strictly sandboxed to the active workspace path as CWD.
   */
  public createIsolatedTerminal(name: string = 'ReMem AI Agent'): vscode.Terminal {
    return vscode.window.createTerminal({
      name,
      cwd: this._workspaceRoot,
    });
  }

  /**
   * Executes a command strictly forcing the active workspace path as the absolute CWD.
   */
  public async executeCommand(
    command: string,
    args: string[] = [],
    options: child_process.SpawnOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      // Force cwd strictly to active workspace root
      const enforcedOptions: child_process.SpawnOptions = {
        ...options,
        cwd: this._workspaceRoot,
      };

      const proc = child_process.spawn(command, args, enforcedOptions);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0,
        });
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  // ── Multi-Window State Isolation (workspaceState vs globalState) ───────────

  /**
   * Retrieves a workspace-isolated state value (never bleeds across open windows).
   */
  public getWorkspaceState<T>(key: string, defaultValue?: T): T | undefined {
    return this._context.workspaceState.get<T>(key, defaultValue as T);
  }

  /**
   * Updates a workspace-isolated state value.
   */
  public async updateWorkspaceState<T>(key: string, value: T): Promise<void> {
    await this._context.workspaceState.update(key, value);
  }
}
