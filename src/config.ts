import * as path from 'path';

export const CONFIG = {
  // Folder & File Names
  MEM_DIR_NAME: '.antigravityMem',
  SCRATCHPAD_FILE_NAME: '.recall_scratchpad.md',
  DB_FILE_NAME: 'remem_ledger.sqlite',
  VECTOR_INDEX_FILE_NAME: 'orama_index.json',
  OUTPUT_CHANNEL_NAME: 'ReMem Engine',

  // Limits & Timeouts
  VAULT_CACHE_TIMEOUT_MS: 60 * 60 * 1000, // 1 hour in milliseconds
  DEFAULT_LRU_TURNS: 3,
  GLOBAL_SUMMARY_MAX_WORDS: 100,
  FILE_SUMMARY_MAX_SENTENCES: 2,

  // Sensitive File Patterns (Vault)
  SENSITIVE_FILE_PATTERNS: [
    /^\.env(\..+)?$/i,
    /.*\.pem$/i,
    /.*\.key$/i,
    /.*secrets\.json$/i,
    /^id_rsa.*$/i,
    /.*\.pfx$/i,
    /.*\.keystore$/i,
  ],
} as const;

/**
 * Returns the path to the .antigravityMem directory inside the given workspace root.
 */
export function getMemoryDirPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG.MEM_DIR_NAME);
}

/**
 * Returns the path to the SQLite DB file inside the memory directory.
 */
export function getDbFilePath(workspaceRoot: string): string {
  return path.join(getMemoryDirPath(workspaceRoot), CONFIG.DB_FILE_NAME);
}

/**
 * Returns the path to the active scratchpad markdown file in the workspace root.
 */
export function getScratchpadPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG.SCRATCHPAD_FILE_NAME);
}

/**
 * Checks if a given file path should be ignored by the engine.
 */
export function shouldIgnorePath(filePath: string): boolean {
  const ignoredPatterns = [
    /[\\/]\.git([\\/]|$)/i,
    /[\\/]node_modules([\\/]|$)/i,
    /[\\/]\.antigravityMem([\\/]|$)/i,
    /[\\/]out([\\/]|$)/i,
    /[\\/]dist([\\/]|$)/i,
    /[\\/]\.vscode-test([\\/]|$)/i,
    /[\\/]\.DS_Store$/i,
    /[\\/]\.recall_scratchpad\.md$/i,
  ];

  return ignoredPatterns.some((pattern) => pattern.test(filePath));
}

