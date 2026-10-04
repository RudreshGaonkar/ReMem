import * as vscode from 'vscode';
import { VaultSecret } from '../types/index.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { VaultSessionManager } from './session.js';
import { VaultStorage } from './storage.js';

/**
 * Retrieves the workspace encryption key from native SecretStorage / OS Keychain.
 */
export async function getOrPromptVaultPassword(
  sessionManager: VaultSessionManager
): Promise<string | null> {
  try {
    return await sessionManager.getOrCreateMasterKey();
  } catch (err) {
    vscode.window.showWarningMessage(`ReMem: Unable to access native SecretStorage: ${err}`);
    return null;
  }
}

/**
 * Encrypts a sensitive file's contents with the native keychain master key and stores it in the local vault.
 */
export async function encryptAndStoreSecret(
  filePath: string,
  relativePath: string,
  content: string,
  storage: VaultStorage,
  sessionManager: VaultSessionManager
): Promise<boolean> {
  const masterKey = await sessionManager.getOrCreateMasterKey();
  if (!masterKey) {
    return false;
  }

  try {
    const payload = encryptSecret(content, masterKey);
    const secretEntry: VaultSecret = {
      filePath,
      relativePath,
      iv: payload.iv,
      authTag: payload.authTag,
      encryptedData: payload.encryptedData,
      keySalt: payload.keySalt,
      updatedAt: Date.now(),
    };

    storage.storeSecret(secretEntry);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`ReMem: Encryption failed: ${err}`);
    return false;
  }
}

/**
 * Decrypts a stored secret from the vault using the native keychain master key.
 */
export async function readAndDecryptSecret(
  filePath: string,
  storage: VaultStorage,
  sessionManager: VaultSessionManager
): Promise<string | null> {
  const secret = storage.getSecret(filePath);
  if (!secret) {
    return null;
  }

  const masterKey = await sessionManager.getMasterKey();
  if (!masterKey) {
    vscode.window.showWarningMessage('ReMem: Native encryption key could not be retrieved from System Keychain.');
    return null;
  }

  try {
    const decrypted = decryptSecret(
      {
        encryptedData: secret.encryptedData,
        iv: secret.iv,
        authTag: secret.authTag,
        keySalt: secret.keySalt,
      },
      masterKey
    );

    return decrypted;
  } catch (err) {
    vscode.window.showErrorMessage('ReMem: Decryption failed. Keychain key mismatch or corrupted ciphertext.');
    return null;
  }
}
