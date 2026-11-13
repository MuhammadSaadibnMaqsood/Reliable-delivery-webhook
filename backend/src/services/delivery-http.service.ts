import { isIP } from 'node:net';
import { Agent, request } from 'undici';
import type { ErrorCategory } from '@prisma/client';
import { buildSignatureHeader, WEBHOOK_HEADERS } from '../utils/webhook-signature.js';

/**
 * Pinned outbound HTTP dispatch — the connection-level half of SSRF
 * protection (the half registration-time checks cannot provide).
 *
 * The caller validates the URL with validateDestinationUrl() IMMEDIATELY
 * before dispatch and hands the vetted addresses here. The undici Agent's
 * connector then uses a custom lookup that returns ONLY those addresses —
 * the socket physically cannot connect anywhere else, so a resolver that
 * changes its answer between validation and connect (DNS rebinding) changes
 * nothing. TLS still verifies against the original hostname (SNI/servername
 * are hostname-based, the lookup only replaces address resolution).
 *
 * Redirects are NOT followed (undici default maxRedirections=0): a 3xx is
 * returned as an ordinary non-success response, because a redirect target
 * would be an unvalidated, unpinned destination.
 */

export interface WebhookDispatchRequest {
  url: string;
  /** Vetted addresses from validateDestinationUrl — the pin set. */
  addresses: string[];
  rawBody: string;
  signingSecret: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  attemptNumber: number;
  timeoutMs: number;
}

export type WebhookDispatchResult =
  | { ok: true; statusCode: number; latencyMs: number }
  | {
      ok: false;
      statusCode: number | null;
      latencyMs: number;
      errorCategory: ErrorCategory;
      errorMessage: string;
    };

/** dns.lookup-compatible resolver that only ever answers from the pin set. */
function buildPinnedLookup(expectedHostname: string, addresses: string[]) {
  const pins = addresses.map((address) => ({ address, family: isIP(address) }));

  return (
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, ...args: never[]) => void,
  ): void => {
    const cb = callback as unknown as (
      err: NodeJS.ErrnoException | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;

    if (hostname.toLowerCase() !== expectedHostname.toLowerCase() || pins.length === 0) {
      // Any attempt to resolve a different host through this agent (e.g. a
      // followed redirect) is refused outright.
      cb(Object.assign(new Error(`Refusing to resolve unpinned host ${hostname}`), {
        code: 'EUNPINNEDHOST',
      }));
      return;
    }

    const wantsAll =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) {
      cb(null, pins);
    } else {
      cb(null, pins[0]!.address, pins[0]!.family);
    }
  };
}

function classifyDispatchError(err: unknown): { category: ErrorCategory; message: string } {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const name = error.name;

  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return { category: 'timeout', message: 'Request timed out' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { category: 'dns', message: `DNS resolution failed (${code})` };
  }
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('CERT_') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER'
  ) {
    return { category: 'tls', message: `TLS failure (${code})` };
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE' ||
    code === 'EUNPINNEDHOST' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return { category: 'connection', message: `Connection failed (${code})` };
  }
  return { category: 'other', message: error.message.slice(0, 300) };
}

/** POST the signed webhook over a pinned connection. Never throws. */
export async function dispatchWebhook(req: WebhookDispatchRequest): Promise<WebhookDispatchResult> {
  const url = new URL(req.url);
  const bareHost =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  const agent = new Agent({
    connect: { lookup: buildPinnedLookup(bareHost, req.addresses) },
    headersTimeout: req.timeoutMs,
    bodyTimeout: req.timeoutMs,
  });

  const timestampSeconds = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();

  try {
    const response = await request(req.url, {
      method: 'POST',
      dispatcher: agent,
      body: req.rawBody,
      signal: AbortSignal.timeout(req.timeoutMs),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'webhook-platform/0.1',
        [WEBHOOK_HEADERS.id]: req.deliveryId,
        [WEBHOOK_HEADERS.eventId]: req.eventId,
        [WEBHOOK_HEADERS.eventType]: req.eventType,
        [WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
        [WEBHOOK_HEADERS.attempt]: String(req.attemptNumber),
        [WEBHOOK_HEADERS.signature]: buildSignatureHeader(
          req.signingSecret,
          timestampSeconds,
          req.rawBody,
        ),
      },
    });

    // Drain (bounded) so the socket is reusable/closable; bodies are not stored.
    await response.body.dump({ limit: 65_536 }).catch(() => undefined);
    const latencyMs = Date.now() - startedAt;

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, statusCode: response.statusCode, latencyMs };
    }
    const category: ErrorCategory =
      response.statusCode >= 500 ? 'http_5xx' : response.statusCode >= 400 ? 'http_4xx' : 'other';
    return {
      ok: false,
      statusCode: response.statusCode,
      latencyMs,
      errorCategory: category,
      errorMessage:
        category === 'other'
          ? `Unexpected status ${response.statusCode} (redirects are not followed)`
          : `Destination responded ${response.statusCode}`,
    };
  } catch (err) {
    const { category, message } = classifyDispatchError(err);
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      errorCategory: category,
      errorMessage: message,
    };
  } finally {
    await agent.close().catch(() => undefined);
  }
}
