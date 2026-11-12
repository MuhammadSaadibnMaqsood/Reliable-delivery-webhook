import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * At-rest encryption for endpoint signing secrets (NFR-12).
 *
 * AES-256-GCM (authenticated encryption) with a dedicated key from
 * SECRET_ENCRYPTION_KEY — deliberately not the JWT secret. A fresh random
 * 12-byte IV is generated per encryption; the stored format is a single
 * versioned string that fits the existing text column:
 *
 *   v1:<iv b64url>:<auth tag b64url>:<ciphertext b64url>
 *
 * The version prefix leaves room for key rotation / algorithm changes
 * without a schema migration. Plaintext secrets are never logged and never
 * serialized into API responses (creation returns the plaintext exactly
 * once, before it is discarded).
 */

const FORMAT_VERSION = 'v1';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Parses and validates a hex-encoded 32-byte key. Throws on anything else —
 * failing safely (no boot, no write) beats ever storing plaintext. Exported
 * for direct testing of invalid configurations.
 */
export function parseEncryptionKey(rawHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(rawHex)) {
    throw new Error('SECRET_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  const key = Buffer.from(rawHex, 'hex');
  if (key.length !== 32) {
    throw new Error('SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

// Validated at boot (env schema) and re-validated here; module load fails on
// a bad key, so no code path can fall through to storing plaintext.
const ENCRYPTION_KEY = parseEncryptionKey(env.SECRET_ENCRYPTION_KEY);

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Unrecognized encrypted secret format');
  }
  const iv = Buffer.from(parts[1] ?? '', 'base64url');
  const authTag = Buffer.from(parts[2] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Corrupt encrypted secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  // GCM authentication failure (tampering / wrong key) throws here.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * New endpoint signing secret: whsec_ + 32 random bytes (256 bits), base64url.
 * Used for HMAC-SHA256 outbound signatures in Phase 5.
 */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
