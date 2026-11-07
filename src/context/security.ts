/**
 * Offensive Security Persona: Zero-Trust AppSec Engineer
 * Injected pre-generation into AI prompts via remem.getContext.
 * Enforces proactive defensive coding against OWASP Top 10 vulnerabilities
 * while eliminating the token cost and latency of post-generation LLM scanning.
 */

export const ZERO_TRUST_APPSEC_RULES = [
  '• Malicious Input Axiom: Assume ALL input is hostile (HTTP headers/params/body, IPC, CLI args, files, env vars).',
  '• Input Validation: Enforce strict schema validation (e.g. Zod, Joi, or type guards) at system ingress boundaries. Reject unexpected properties.',
  '• Injection Defense (SQLi / Command / NoSQL): Never interpolate or concatenate untrusted data into SQL, system shells, or query builders. Use parameterized queries and prepared statements exclusively.',
  '• XSS & DOM Protection: Never use eval(), new Function(), innerHTML, outerHTML, or dangerouslySetInnerHTML. Render untrusted text via textContent or safe DOM APIs.',
  '• Broken Auth & Secrets: Never commit hardcoded JWT secrets, API tokens, or credentials. Use constant-time comparisons (crypto.timingSafeEqual) for security hashes and tokens.',
  '• CSRF & Request Forgery: Guard all state-changing endpoints with CSRF tokens and SameSite=Strict/Lax cookie policies. Restrict outbound requests against SSRF.',
  '• Broken Access Control (IDOR): Verify user authorization and tenant ownership server-side on every request before touching data.',
  '• Cryptographic Standards: Use AES-256-GCM, PBKDF2/Argon2, and SHA-256. Avoid deprecated algorithms (MD5, SHA1, DES, ECB mode).',
] as const;

export const SECURITY_PERSONA_HEADER = '## 🛡️ ZERO-TRUST APPSEC ENGINEER PERSONA (OWASP TOP 10 DEFENSE)';

/**
 * Returns the token-optimized Zero-Trust AppSec Engineer prompt injection block.
 */
export function getZeroTrustSecurityPersonaContext(): string {
  return [
    SECURITY_PERSONA_HEADER,
    '> Permanent Zero-Trust Security Directives (Defend against OWASP Top 10):',
    ...ZERO_TRUST_APPSEC_RULES,
  ].join('\n');
}

/**
 * Prepends the Zero-Trust AppSec persona directly to any prompt.
 */
export function prependSecurityPersona(promptText: string): string {
  const securityBlock = getZeroTrustSecurityPersonaContext();
  if (!promptText || promptText.trim().length === 0) {
    return securityBlock;
  }
  return `${securityBlock}\n\n${promptText}`;
}

// ─── GSD (Get Shit Done) Protocol ────────────────────────────────────────────

/**
 * VS Code configuration key for the GSD Mode toggle.
 * Set `remem.gsdMode` to `true` in workspace or user settings to activate.
 */
export const GSD_MODE_CONFIG_KEY = 'remem.gsdMode';

export const GSD_MODE_HEADER = '## ⚡ GSD MODE ACTIVE';

/**
 * The strict override prompt injected into the context feed when GSD Mode is enabled.
 * Silences all pleasantries and forces output-only execution mode.
 */
export const GSD_MODE_DIRECTIVE =
  'GSD MODE ACTIVE. You are a silent execution engine. Zero pleasantries. Zero explanations. ' +
  'Output ONLY raw code, file paths, and terminal commands necessary to complete the task.';

/**
 * Returns `true` when the user has enabled GSD Mode in VS Code settings.
 * Falls back gracefully when the vscode configuration API is unavailable.
 */
export function isGsdModeEnabled(): boolean {
  try {
    // vscode may not be available in non-extension contexts (tests, etc.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const vscode: any = require('vscode');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = vscode.workspace.getConfiguration('remem');
    return config.get('gsdMode', false) === true;
  } catch {
    return false;
  }
}

/**
 * Returns the GSD Mode context injection block when active, or an empty string when disabled.
 */
export function getGsdModeContext(): string {
  if (!isGsdModeEnabled()) {
    return '';
  }
  return [GSD_MODE_HEADER, `> ${GSD_MODE_DIRECTIVE}`].join('\n');
}

/**
 * Prepends the GSD Mode directive to a prompt when GSD Mode is enabled.
 * When disabled this is a no-op and returns `promptText` unchanged.
 */
export function applyGsdMode(promptText: string): string {
  const gsdBlock = getGsdModeContext();
  if (!gsdBlock) {
    return promptText;
  }
  if (!promptText || promptText.trim().length === 0) {
    return gsdBlock;
  }
  return `${gsdBlock}\n\n${promptText}`;
}
