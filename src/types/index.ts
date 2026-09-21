/**
 * File summary representation stored in DB and memory index.
 */
export interface FileSummary {
  filePath: string;
  relativePath: string;
  summary: string;
  hash: string;
  lastModified: number;
  tokenCountEstimate: number;
  isEncrypted: boolean;
}

/**
 * Git Branch & Rollback Error Ledger entry.
 * Captures post-mortem notes when branches switch or commits are reverted.
 */
export interface ErrorLedgerEntry {
  id?: number;
  branch: string;
  commitHash?: string;
  filePath?: string;
  postMortemNote: string;
  timestamp: number;
  resolved: boolean;
}

/**
 * Secure Secrets Vault entry encrypted with AES-256-GCM.
 */
export interface VaultSecret {
  filePath: string;
  relativePath: string;
  iv: string; // Hex or base64 encoded IV
  authTag: string; // Hex or base64 encoded auth tag
  encryptedData: string; // Ciphertext
  keySalt: string; // PBKDF2 salt
  updatedAt: number;
}

/**
 * In-memory vault session cache representation.
 */
export interface VaultSessionCache {
  masterKey: Buffer | null;
  expiresAt: number | null;
}

/**
 * AST Dependency & Blast Radius representation.
 */
export interface ASTBlastRadius {
  sourceFile: string;
  imports: string[];
  exports: string[];
  dependents: string[];
  lastParsed: number;
}

/**
 * Global and structural project summary.
 */
export interface ProjectOverview {
  globalOverview100Words: string;
  serializedFileTree: string;
  totalFiles: number;
  updatedAt: number;
}

/**
 * LRU Context Entry for token pruning across conversation turns.
 */
export interface LRUContextEntry {
  filePath: string;
  lastUsedTurn: number;
  tokenCount: number;
}

/**
 * High-level status info for ReMem diagnostics.
 */
export interface EngineStatus {
  workspaceRoot: string;
  isInitialized: boolean;
  totalIndexedFiles: number;
  ledgerEntriesCount: number;
  vaultEntriesCount: number;
  isVaultUnlocked: boolean;
}
