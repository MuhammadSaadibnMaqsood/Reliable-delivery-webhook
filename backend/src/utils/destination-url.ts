import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

/**
 * SSRF-protected destination URL validation (FR-18, FR-56, NFR-14).
 *
 * Policy: HTTPS only · no embedded credentials · no localhost/internal names
 * · hostname must resolve, and EVERY resolved A/AAAA address must be public
 * unicast. IP classification uses ipaddr.js range data rather than
 * hand-rolled CIDR matching, which rejects loopback, RFC1918 private,
 * link-local (incl. 169.254.169.254 cloud metadata), CGNAT, unique-local,
 * multicast, reserved and unspecified ranges, with IPv4-mapped IPv6
 * unwrapped first.
 *
 * ── DNS REBINDING: DOCUMENTED LIMITATION ─────────────────────────────────
 * This module validates the addresses returned AT VALIDATION TIME. A
 * malicious authoritative resolver can later answer with a private address
 * (classic rebinding), so registration-time validation alone is NOT complete
 * protection and is not claimed to be. REQUIREMENT FOR PHASE 5: the delivery
 * worker must call validateDestinationUrl() again immediately before every
 * HTTP request and pin the actual TCP connection to a validated public
 * address (e.g. undici Agent with a custom lookup that only returns the
 * vetted IPs), never re-resolving independently. Redirects must be disabled
 * or re-validated per hop.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type DestinationValidation =
  | { valid: true; addresses: string[] }
  | { valid: false; reason: string };

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function fail(reason: string): DestinationValidation {
  return { valid: false, reason };
}

/** True only for globally routable unicast addresses. */
function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export async function validateDestinationUrl(rawUrl: string): Promise<DestinationValidation> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail('Not a valid URL');
  }

  if (url.protocol !== 'https:') {
    return fail('Only https:// destinations are allowed');
  }
  if (url.username !== '' || url.password !== '') {
    return fail('URLs with embedded credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) {
    return fail('URL has no hostname');
  }
  if (hostname === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return fail('Destination hostname is not public');
  }

  // IP literal? ([::1] arrives bracketed from URL.hostname)
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (ipaddr.isValid(bareHost)) {
    return isPublicAddress(bareHost)
      ? { valid: true, addresses: [bareHost] }
      : fail('Destination IP address is not public');
  }

  // Resolve via the same path the HTTP client would use (getaddrinfo — also
  // catches hosts-file tricks) and require EVERY returned address be public.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(bareHost, { all: true, verbatim: true });
  } catch {
    return fail('Destination hostname could not be resolved');
  }
  if (records.length === 0) {
    return fail('Destination hostname has no DNS records');
  }

  const addresses = records.map((r) => r.address);
  if (!addresses.every(isPublicAddress)) {
    return fail('Destination resolves to a non-public address');
  }

  return { valid: true, addresses };
}
