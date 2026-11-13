import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhook signature scheme (FR-53, NFR-33) — the documented format
 * receivers verify against:
 *
 *   X-Webhook-Signature: t=<unix seconds>,v1=<hex>
 *   v1 = HMAC-SHA256( secret, `${t}.${rawRequestBody}` )
 *
 * - `secret` is the endpoint's whsec_… signing secret, exactly as issued.
 * - `rawRequestBody` is the EXACT byte-for-byte JSON string that is sent —
 *   receivers must verify against the raw body BEFORE parsing it.
 * - The signed timestamp lets receivers enforce a tolerance window against
 *   replay (recommended: 5 minutes).
 * - The `v1=` prefix versions the scheme so it can evolve without breaking
 *   existing receivers; verifiers ignore unknown pairs.
 *
 * Receiver verification (reference, also used by our tests):
 *   1. Parse `t` and `v1` from the header.
 *   2. Recompute HMAC-SHA256(secret, `${t}.${rawBody}`).
 *   3. Constant-time-compare with `v1`; check |now - t| <= tolerance.
 */

export function computeWebhookSignature(
  signingSecret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac('sha256', signingSecret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
}

export function buildSignatureHeader(
  signingSecret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `t=${timestampSeconds},v1=${computeWebhookSignature(signingSecret, timestampSeconds, rawBody)}`;
}

/** Reference verifier (constant-time), exercised by the integration tests. */
export function verifySignatureHeader(
  signingSecret: string,
  header: string,
  rawBody: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const pairs = new Map(
    header.split(',').map((part) => {
      const idx = part.indexOf('=');
      return [part.slice(0, idx), part.slice(idx + 1)] as const;
    }),
  );
  const timestamp = Number(pairs.get('t'));
  const provided = pairs.get('v1');
  if (!Number.isInteger(timestamp) || !provided) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = computeWebhookSignature(signingSecret, timestamp, rawBody);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Canonical header names for outbound webhook requests. */
export const WEBHOOK_HEADERS = {
  id: 'x-webhook-id', // delivery id — stable across retries (NFR-07/27)
  eventId: 'x-webhook-event-id',
  eventType: 'x-webhook-event-type',
  timestamp: 'x-webhook-timestamp',
  signature: 'x-webhook-signature',
  attempt: 'x-webhook-attempt',
} as const;
