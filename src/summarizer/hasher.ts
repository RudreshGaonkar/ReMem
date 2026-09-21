import * as crypto from 'crypto';

/**
 * Computes a SHA-256 hash string for the given file content.
 */
export function computeFileHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Estimates the token count of a given text content.
 * Standard heuristic: ~1 token per 4 characters / 0.75 words.
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
