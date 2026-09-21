import { CONFIG } from '../config.js';

export type VaultLockListener = (isUnlocked: boolean) => void;

/**
 * Manages the in-memory master password session with an exact 1-hour auto-expiration policy.
 */
export class VaultSessionManager {
  private cachedPassword: string | null = null;
  private expiresAt: number | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private sessionDurationMs: number;
  private listeners: Set<VaultLockListener> = new Set();

  constructor(sessionDurationMs: number = CONFIG.VAULT_CACHE_TIMEOUT_MS) {
    this.sessionDurationMs = sessionDurationMs;
  }

  /**
   * Caches the master password in memory and arms the 1-hour expiration timer.
   */
  public setPassword(password: string): void {
    // Clear any existing timer
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    this.cachedPassword = password;
    this.expiresAt = Date.now() + this.sessionDurationMs;

    // Set automatic timer to wipe credentials after exactly 1 hour
    this.timeoutHandle = setTimeout(() => {
      this.lock();
    }, this.sessionDurationMs);

    this.notifyListeners(true);
  }

  /**
   * Checks if the session is currently unlocked and unexpired.
   */
  public isUnlocked(): boolean {
    if (!this.cachedPassword || !this.expiresAt) {
      return false;
    }

    if (Date.now() >= this.expiresAt) {
      this.lock();
      return false;
    }

    return true;
  }

  /**
   * Returns the cached master password if unexpired, or null otherwise.
   */
  public getPassword(): string | null {
    if (!this.isUnlocked()) {
      return null;
    }
    return this.cachedPassword;
  }

  /**
   * Returns remaining session lifetime in seconds.
   */
  public getRemainingTimeSeconds(): number {
    if (!this.isUnlocked() || !this.expiresAt) {
      return 0;
    }
    return Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
  }

  /**
   * Immediately invalidates and wipes cached master credentials from memory.
   */
  public lock(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    this.cachedPassword = null;
    this.expiresAt = null;

    this.notifyListeners(false);
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
