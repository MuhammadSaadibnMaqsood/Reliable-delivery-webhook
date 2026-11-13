import { env } from '../config/env.js';

/**
 * Retry backoff policy (FR-39, AC-03): bounded exponential with jitter.
 *
 *   raw(n)   = initialDelayMs · 2^(n-1)        n = attempts already consumed
 *   capped   = min(maxDelayMs, raw)
 *   jittered = capped · (1 ± JITTER_RATIO)     uniform
 *   delay    = min(maxDelayMs, round(jittered))
 *
 * Jitter spreads retries so a burst of failures against one destination
 * does not come back as a synchronized thundering herd; the final min()
 * guarantees the configured maximum is a hard ceiling even at +20%.
 * Attempt BUDGETS are not decided here — the delivery's snapshotted
 * max_attempts (endpoint override or DELIVERY_MAX_ATTEMPTS_DEFAULT) is
 * enforced by the executor and the claim/sweep guards.
 */

export const JITTER_RATIO = 0.2;

export interface RetryPolicyOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable randomness for deterministic tests. */
  random?: () => number;
}

export function computeRetryDelayMs(
  attemptsConsumed: number,
  options: RetryPolicyOptions = {},
): number {
  const initialDelayMs = options.initialDelayMs ?? env.DELIVERY_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? env.DELIVERY_RETRY_MAX_DELAY_MS;
  const random = options.random ?? Math.random;

  const exponent = Math.max(0, attemptsConsumed - 1);
  // 2^30 ms ≈ 12 days — past any sane cap; avoids float blow-ups for large n.
  const raw = initialDelayMs * 2 ** Math.min(exponent, 30);
  const capped = Math.min(maxDelayMs, raw);
  const jittered = capped * (1 - JITTER_RATIO + random() * 2 * JITTER_RATIO);
  return Math.min(maxDelayMs, Math.round(jittered));
}
