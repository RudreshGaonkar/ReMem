import * as fs from 'fs';
import * as path from 'path';
import { getMemoryDirPath } from '../config.js';
import { VaultSecret } from '../types/index.js';

/**
 * Manages encrypted secrets persistence inside .antigravityMem/vault.json.
 */
export class VaultStorage {
  private vaultFilePath: string;
  private secrets: Map<string, VaultSecret> = new Map(); // filePath -> VaultSecret

  constructor(workspaceRoot: string) {
    this.vaultFilePath = path.join(getMemoryDirPath(workspaceRoot), 'vault.json');
    this.loadFromDisk();
  }

  /**
   * Loads encrypted secrets from disk.
   */
  public loadFromDisk(): void {
    if (fs.existsSync(this.vaultFilePath)) {
      try {
        const raw = fs.readFileSync(this.vaultFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.secrets = new Map(parsed.map((item: VaultSecret) => [item.filePath, item]));
        }
      } catch (err) {
        console.error('[ReMem Vault] Failed to parse vault.json:', err);
      }
    }
  }

  /**
   * Stores or updates an encrypted secret in the vault.
   */
  public storeSecret(secret: VaultSecret): void {
    this.secrets.set(secret.filePath, secret);
    this.saveToDisk();
  }

  /**
   * Retrieves an encrypted secret entry by file path.
   */
  public getSecret(filePath: string): VaultSecret | undefined {
    return this.secrets.get(filePath);
  }

  /**
   * Removes an encrypted secret entry.
   */
  public deleteSecret(filePath: string): boolean {
    const deleted = this.secrets.delete(filePath);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  /**
   * Returns all stored encrypted secrets.
   */
  public getAllSecrets(): VaultSecret[] {
    return Array.from(this.secrets.values());
  }

  /**
   * Returns the count of encrypted secrets stored.
   */
  public count(): number {
    return this.secrets.size;
  }

  /**
   * Persists all encrypted secrets to .antigravityMem/vault.json.
   */
  public saveToDisk(): void {
    const dir = path.dirname(this.vaultFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = JSON.stringify(Array.from(this.secrets.values()), null, 2);
    fs.writeFileSync(this.vaultFilePath, data, 'utf8');
  }
}
