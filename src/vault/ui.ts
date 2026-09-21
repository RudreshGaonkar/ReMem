import * as vscode from 'vscode';
import { VaultSecret } from '../types/index.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { VaultSessionManager } from './session.js';
import { VaultStorage } from './storage.js';

/**
 * Retrieves the master vault password from memory, or prompts the user via the IDE UI.
 */
export async function getOrPromptVaultPassword(
  sessionManager: VaultSessionManager
): Promise<string | null> {
  if (sessionManager.isUnlocked()) {
    return sessionManager.getPassword();
  }

  const password = await vscode.window.showInputBox({
    password: true,
    prompt: 'ReMem Secure Vault: Enter master encryption password (cached in memory for 1 hour)',
    placeHolder: 'Enter master password...',
    ignoreFocusOut: true,
  });

  if (!password || password.trim().length === 0) {
    vscode.window.showWarningMessage('ReMem: Vault operation cancelled (password required).');
    return null;
  }

  sessionManager.setPassword(password);
  const remainingMinutes = Math.round(sessionManager.getRemainingTimeSeconds() / 60);
  vscode.window.showInformationMessage(`ReMem: Vault unlocked. Credentials cached for ${remainingMinutes} minutes.`);

  return password;
}

/**
 * Encrypts a sensitive file's contents with the master password and stores it in the local vault.
 */
export async function encryptAndStoreSecret(
  filePath: string,
  relativePath: string,
  content: string,
  storage: VaultStorage,
  sessionManager: VaultSessionManager
): Promise<boolean> {
  const password = await getOrPromptVaultPassword(sessionManager);
  if (!password) {
    return false;
  }

  try {
    const payload = encryptSecret(content, password);
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
 * Decrypts a stored secret from the vault using the cached or prompted master password.
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

  const password = await getOrPromptVaultPassword(sessionManager);
  if (!password) {
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
      password
    );

    return decrypted;
  } catch (err) {
    vscode.window.showErrorMessage('ReMem: Decryption failed. Incorrect master password or corrupted ciphertext.');
    return null;
  }
}
