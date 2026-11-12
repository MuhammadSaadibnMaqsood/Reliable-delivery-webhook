import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API key format (frozen design):  whk_<prefix>_<secret>
 *   - prefix: 6 random bytes, hex (12 chars) — stored as key_prefix for O(1)
 *     lookup and safe display; carries no secret material.
 *   - secret: 32 random bytes, base64url (43 chars) — 256 bits of entropy.
 * Only SHA-256(full key) is stored (NFR-11). Plaintext exists exactly once:
 * in the creation response. It is never logged (the request logger already
 * redacts the x-api-key header).
 */

export const API_KEY_HEADER = 'x-api-key';
const KEY_SCHEME = 'whk';
// NOTE: the base64url secret alphabet itself contains '_' and '-', so a
// presented key is parsed by this anchored pattern (first two separators),
// never by split('_').
const KEY_PATTERN = /^whk_([0-9a-f]{12})_[A-Za-z0-9_-]{32,}$/;

export interface GeneratedApiKey {
  plaintext: string;
  keyPrefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${KEY_SCHEME}_${prefix}_${secret}`;
  return {
    plaintext,
    keyPrefix: `${KEY_SCHEME}_${prefix}`,
    keyHash: hashApiKey(plaintext),
  };
}

/** SHA-256 hex digest of the COMPLETE presented key. */
export function hashApiKey(plaintextKey: string): string {
  return createHash('sha256').update(plaintextKey, 'utf8').digest('hex');
}

/**
 * Returns the stored lookup prefix ("whk_<12 hex>") for a presented key,
 * or null when the shape is wrong. Shape-only check — never touches secrets.
 */
export function extractKeyPrefix(presentedKey: string): string | null {
  const match = KEY_PATTERN.exec(presentedKey);
  return match ? `${KEY_SCHEME}_${match[1]}` : null;
}

/** Constant-time comparison of two hex digests. */
export function apiKeyHashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
