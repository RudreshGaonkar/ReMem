import * as crypto from 'crypto';

export interface EncryptedPayload {
  encryptedData: string; // Hex ciphertext
  iv: string; // Hex IV (12 bytes)
  authTag: string; // Hex GCM authentication tag (16 bytes)
  keySalt: string; // Hex salt for PBKDF2 (16 bytes)
}

const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH_BYTES = 32; // 256-bit key
const IV_LENGTH_BYTES = 12; // Standard 96-bit IV for AES-GCM
const SALT_LENGTH_BYTES = 16;
const DIGEST_ALGORITHM = 'sha256';
const CIPHER_ALGORITHM = 'aes-256-gcm';

/**
 * Derives a 32-byte cryptographic key using PBKDF2-HMAC-SHA256 with 100,000 iterations.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH_BYTES,
    DIGEST_ALGORITHM
  );
}

/**
 * Encrypts plain text using AES-256-GCM authenticated encryption.
 */
export function encryptSecret(text: string, password: string): EncryptedPayload {
  const salt = crypto.randomBytes(SALT_LENGTH_BYTES);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedData: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    keySalt: salt.toString('hex'),
  };
}

/**
 * Decrypts AES-256-GCM ciphertext using the master password and verifies the GCM authentication tag.
 */
export function decryptSecret(payload: EncryptedPayload, password: string): string {
  const salt = Buffer.from(payload.keySalt, 'hex');
  const key = deriveKey(password, salt);
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const ciphertext = Buffer.from(payload.encryptedData, 'hex');

  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
