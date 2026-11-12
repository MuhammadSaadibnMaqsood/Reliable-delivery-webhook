import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization for idempotency payload hashing (UC-20).
 *
 * jsonb normalizes key order on storage, so the payload hash MUST be
 * computed from a deterministic serialization at ingestion time, never
 * re-derived from the stored column. Rules:
 *   - object keys sorted lexicographically, recursively
 *   - array order preserved
 *   - JSON data types preserved exactly (string/number/boolean/null)
 *   - mirrors JSON.stringify semantics for edge values: undefined inside
 *     arrays serializes as null; object entries with undefined values are
 *     omitted; non-JSON values (functions, symbols, BigInt) throw.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value); // NaN/Infinity become "null", like JSON.stringify
    case 'object':
      break;
    default:
      throw new Error(`Value of type ${typeof value} is not JSON-serializable`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined ? 'null' : canonicalJsonStringify(item),
    );
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 hex digest of the canonical serialization. */
export function canonicalPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(payload), 'utf8').digest('hex');
}
