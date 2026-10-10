/**
 * Lean Engine Context Ruleset Injection
 * Inspired by minimal code generation principles:
 * 1. Reuse existing project helpers/AST utilities before writing new code.
 * 2. Prefer native standard library features over introducing new npm dependencies.
 * 3. Keep implementations minimal while strictly preserving security, error handling, and type safety.
 */

export const LEAN_DECISION_HIERARCHY = [
  '1. Reuse existing project helpers/AST utilities before writing new code.',
  '2. Prefer native standard library features over introducing new npm dependencies.',
  '3. Keep implementations minimal while strictly preserving security, error handling, and type safety.',
] as const;

export const LEAN_RULES_HEADER = '## 📐 LEAN ENGINE DECISION HIERARCHY';

/**
 * Generates the token-optimized Lean Engine decision hierarchy prompt block.
 */
export function getLeanRulesContext(): string {
  return [
    LEAN_RULES_HEADER,
    '> Strict priority order for AI code generation:',
    ...LEAN_DECISION_HIERARCHY,
  ].join('\n');
}

/**
 * Utility to prepend the Lean Engine decision hierarchy directly to any prompt string.
 */
export function prependLeanRules(promptText: string): string {
  const rules = getLeanRulesContext();
  if (!promptText || promptText.trim().length === 0) {
    return rules;
  }
  return `${rules}\n\n${promptText}`;
}
