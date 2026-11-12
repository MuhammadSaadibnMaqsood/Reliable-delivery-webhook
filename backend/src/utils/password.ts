import * as argon2 from 'argon2';

/**
 * Argon2id with the OWASP-recommended baseline (19 MiB, t=2, p=1).
 * Parameters are encoded into the hash string, so they can be raised later
 * without breaking existing hashes — verify() reads them from the hash.
 */
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plainText: string): Promise<string> {
  return argon2.hash(plainText, ARGON2_OPTIONS);
}

/** Never throws: malformed stored hashes count as a failed verification. */
export async function verifyPassword(hash: string, plainText: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainText);
  } catch {
    return false;
  }
}
