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
