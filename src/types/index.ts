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

/**
 * Local Diff Audit issues and results.
 */
export type DiffIssueSeverity = 'warning' | 'info' | 'error';

export interface DiffIssue {
  filePath: string;
  relativePath: string;
  line?: number;
  type: 'debug_statement' | 'broken_import' | 'missing_export' | 'syntax_discrepancy' | 'style_rule' | 'blast_radius';
  severity: DiffIssueSeverity;
  message: string;
  snippet?: string;
}

export interface DiffAuditReport {
  timestamp: number;
  branch: string;
  totalFilesChanged: number;
  filesAudited: number;
  insertions: number;
  deletions: number;
  issues: DiffIssue[];
  blastRadiusSummary: { file: string; dependentsCount: number; dependents: string[] }[];
  markdownReport: string;
}

/**
 * Spec & Task Sync structures.
 */
export interface ChecklistItem {
  text: string;
  completed: boolean;
  line: number;
}

export interface PhaseInfo {
  title: string;
  level: number;
  items: ChecklistItem[];
  totalTasks: number;
  completedTasks: number;
  percentage: number;
}

export interface SpecFileReport {
  filePath: string;
  relativePath: string;
  phases: PhaseInfo[];
  totalTasks: number;
  completedTasks: number;
  percentage: number;
  activePhase: PhaseInfo | null;
  nextPendingTask: ChecklistItem | null;
}

