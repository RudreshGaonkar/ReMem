import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

/**
 * Hardcoded blocklist of sensitive and secret file patterns.
 * These patterns are permanently enforced regardless of user .gitignore configuration.
 */
export const HARDCODED_SECRET_BLOCKLIST: string[] = [
  '.env*',
  '*.pem',
  '*.key',
  'secrets.json',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '*.pfx',
  '*.keystore',
  '*.jks',
  '*.cert',
  '*.crt',
  '*.p12',
  '*.ovpn',
  '*.pkcs12',
  '.antigravityMem/**',
  '.recall_scratchpad.md',
  '.remem_context_feed.md',
  '.git/**',
  'node_modules/**',
  'out/**',
  'dist/**',
  '.vscode-test/**',
  '*.log',
  '*.corrupted*',
];

/**
 * Bulletproof Secret Shield
 *
 * Compiles a high-performance ignore instance combining the workspace `.gitignore`
 * with a hardcoded sensitive secrets blocklist (`.env*`, `*.pem`, `*.key`, `secrets.json`, etc.).
 *
 * All file paths are passed through this instance before reaching the file watcher,
 * summarizer pipeline, or Orama vector search index.
 */
export class SecretShield {
  private static instance: SecretShield | null = null;
  private ig: Ignore;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.normalize(path.resolve(workspaceRoot));
    this.ig = ignore();
    this.reload();
    SecretShield.instance = this;
  }

  /**
   * Retrieves or initializes the singleton SecretShield instance.
   */
  public static getInstance(workspaceRoot?: string): SecretShield {
    if (!SecretShield.instance || (workspaceRoot && SecretShield.instance.workspaceRoot !== path.normalize(path.resolve(workspaceRoot)))) {
      SecretShield.instance = new SecretShield(workspaceRoot || process.cwd());
    }
    return SecretShield.instance;
  }

  /**
   * Reloads .gitignore and recompiles the ignore rules.
   */
  public reload(): void {
    this.ig = ignore();

    // 1. Inject permanent hardcoded secret blocklist
    this.ig.add(HARDCODED_SECRET_BLOCKLIST);

    // 2. Read and parse workspace .gitignore if it exists
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        const validRules = content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'));
        if (validRules.length > 0) {
          this.ig.add(validRules);
        }
      } catch {
        // Non-fatal if .gitignore is temporarily unreadable
      }
    }
  }

  /**
   * Evaluates if a given file path should be blocked from watchers and vector indexers.
   * Supports both absolute and workspace-relative paths.
   */
  public isIgnored(targetPath: string): boolean {
    if (!targetPath) return true;

    const absPath = path.isAbsolute(targetPath)
      ? path.normalize(path.resolve(targetPath))
      : path.normalize(path.resolve(this.workspaceRoot, targetPath));

    // Fast-path: Explicit filename check for high-risk secrets
    const baseName = path.basename(absPath).toLowerCase();
    if (
      baseName.startsWith('.env') ||
      baseName.endsWith('.pem') ||
      baseName.endsWith('.key') ||
      baseName === 'secrets.json' ||
      baseName.startsWith('id_rsa') ||
      baseName === '.recall_scratchpad.md' ||
      baseName === '.remem_context_feed.md'
    ) {
      return true;
    }

    // Fast-path: Internal storage and build directories
    const norm = absPath.replace(/\\/g, '/');
    if (
      norm.includes('/.antigravityMem/') ||
      norm.includes('/.git/') ||
      norm.includes('/node_modules/') ||
      norm.includes('/out/') ||
      norm.includes('/dist/')
    ) {
      return true;
    }

    // Prepare relative path for `ignore` library
    let relPath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');

    // Reject out-of-workspace paths
    if (relPath.startsWith('..')) {
      return true;
    }

    if (relPath.startsWith('./')) {
      relPath = relPath.slice(2);
    }

    if (!relPath || relPath === '.') {
      return false;
    }

    try {
      return this.ig.ignores(relPath);
    } catch {
      return false;
    }
  }
}

