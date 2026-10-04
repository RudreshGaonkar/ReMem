import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { CONFIG } from '../config.js';

export type VaultLockListener = (isUnlocked: boolean) => void;

/**
 * Manages the workspace encryption key using VS Code's native SecretStorage API
 * (backed by the OS Keychain: Linux Keyring / macOS Keychain / Windows Credential Manager).
 *
 * Includes automatic in-memory caching and non-blocking fallback if native keychain access fails.
 */
export class VaultSessionManager {
  private secretStorage: vscode.SecretStorage;
  private secretKeyName: string;
  private cachedKey: string | null = null;
  private ephemeralFallbackKey: string | null = null;
  private expiresAt: number | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private sessionDurationMs: number;
  private outputChannel?: vscode.OutputChannel;
  private listeners: Set<VaultLockListener> = new Set();

  constructor(
    secretStorage: vscode.SecretStorage,
    workspaceRoot: string,
    outputChannel?: vscode.OutputChannel,
    sessionDurationMs: number = CONFIG.VAULT_CACHE_TIMEOUT_MS
  ) {
    this.secretStorage = secretStorage;
    this.sessionDurationMs = sessionDurationMs;
    this.outputChannel = outputChannel;

    // Workspace-scoped unique key identifier in OS keychain
    const workspaceHash = crypto
      .createHash('sha256')
      .update(workspaceRoot, 'utf8')
      .digest('hex')
      .substring(0, 16);
    this.secretKeyName = `remem.vault.key.${workspaceHash}`;
  }

  /**
   * Retrieves the workspace encryption key from native SecretStorage, or generates
   * a cryptographically secure 256-bit random key and stores it in the system keychain.
   *
   * If native SecretStorage access is unavailable or denied by the system, gracefully
   * falls back to an ephemeral in-memory key so workspace operations never block.
   */
  public async getOrCreateMasterKey(): Promise<string> {
    // 1. Return in-memory cached key if still valid
    if (this.cachedKey && this.expiresAt && Date.now() < this.expiresAt) {
      return this.cachedKey;
    }

    // 2. Attempt retrieval from VS Code native SecretStorage (OS Keychain)
    try {
      const storedKey = await this.secretStorage.get(this.secretKeyName);
      if (storedKey && storedKey.trim().length > 0) {
        this.cacheKeyInMemory(storedKey);
        return storedKey;
      }

      // 3. Generate a new 256-bit key and persist to OS Keychain
      const newKey = crypto.randomBytes(32).toString('hex');
      await this.secretStorage.store(this.secretKeyName, newKey);
      this.cacheKeyInMemory(newKey);
      this.outputChannel?.appendLine(
        `[ReMem Vault] Initialized new workspace encryption key in native System Keychain.`
      );
      return newKey;
    } catch (err) {
      // 4. Fallback: If OS keychain throws/declines, use an ephemeral in-memory key
      this.outputChannel?.appendLine(
        `[ReMem Vault] Native SecretStorage access unavailable (${err}). Falling back to ephemeral in-memory key.`
      );
      if (!this.ephemeralFallbackKey) {
        this.ephemeralFallbackKey = crypto.randomBytes(32).toString('hex');
      }
      return this.ephemeralFallbackKey;
    }
  }

  /**
   * Retrieves the master key without forcing new key generation unless required.
   */
  public async getMasterKey(): Promise<string | null> {
    try {
      return await this.getOrCreateMasterKey();
    } catch {
      return this.ephemeralFallbackKey;
    }
  }

  /**
   * Caches the key in memory with auto-expiration.
   */
  private cacheKeyInMemory(key: string): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    this.cachedKey = key;
    this.expiresAt = Date.now() + this.sessionDurationMs;

    this.timeoutHandle = setTimeout(() => {
      this.lock();
    }, this.sessionDurationMs);

    this.notifyListeners(true);
  }

  /**
   * Checks if a key is currently cached and unlocked in memory.
   */
  public isUnlocked(): boolean {
    if (this.cachedKey && this.expiresAt && Date.now() < this.expiresAt) {
      return true;
    }
    return this.ephemeralFallbackKey !== null;
  }

  /**
   * Returns the cached master password/key if available.
   */
  public getPassword(): string | null {
    if (this.cachedKey && this.expiresAt && Date.now() < this.expiresAt) {
      return this.cachedKey;
    }
    return this.ephemeralFallbackKey;
  }

  /**
   * Returns remaining session cache lifetime in seconds.
   */
  public getRemainingTimeSeconds(): number {
    if (!this.expiresAt) {
      return 0;
    }
    return Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
  }

  /**
   * Invalidates the in-memory cached key. Native key remains safe in SecretStorage.
   */
  public lock(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    this.cachedKey = null;
    this.expiresAt = null;
    this.ephemeralFallbackKey = null;

    this.notifyListeners(false);
  }

  /**
   * Deletes the stored workspace key from native SecretStorage.
   */
  public async clearKey(): Promise<void> {
    this.lock();
    this.ephemeralFallbackKey = null;
    try {
      await this.secretStorage.delete(this.secretKeyName);
      this.outputChannel?.appendLine(`[ReMem Vault] Wiped workspace key from native SecretStorage.`);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Subscribes to lock/unlock state transitions.
   */
  public onStateChange(listener: VaultLockListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(isUnlocked: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(isUnlocked);
      } catch (err) {
        console.error('[ReMem Vault] Error in listener callback:', err);
      }
    }
  }
}
