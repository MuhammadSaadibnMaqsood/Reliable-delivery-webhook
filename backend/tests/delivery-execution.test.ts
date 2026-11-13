import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { executeClaimedDelivery } from '../src/services/delivery-executor.service.js';
import { dispatchWebhook } from '../src/services/delivery-http.service.js';
import {
  claimDueDeliveries,
  type ClaimedDelivery,
} from '../src/services/delivery-queue.service.js';
import { createWorker } from '../src/services/worker.service.js';
import { encryptSecret } from '../src/utils/crypto.js';
import { verifySignatureHeader, WEBHOOK_HEADERS } from '../src/utils/webhook-signature.js';

/**
 * Phase 5B.2 delivery-execution tests: a LOCAL mock receiver (127.0.0.1,
 * random port — never a real third-party host) + the real Neon database.
 * Local destinations are reachable only because the test env sets the
 * dev-only DESTINATION_ALLOW_PRIVATE flag, which the delivery path honors
 * and registration/production refuse.
 *
 * Foreign-row safety (same discipline as worker.test.ts): fixtures seed
 * next_attempt_at ~24 h in the past so they sort first, every claim uses
 * batch size 1, and at any claim moment exactly one of our deliveries is
 * eligible.
 */

const SIGNING_SECRET = `whsec_${randomBytes(32).toString('base64url')}`;
const PAYLOAD = { hello: 'world', items: [2, 1], nested: { b: 2, a: 1 } };

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let port: number;
const received: CapturedRequest[] = [];

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  eventTypeIds: [] as string[],
  endpointIds: [] as string[],
  eventIds: [] as string[],
  deliveryIds: [] as string[],
};

let projectId: string;
let eventTypeId: string;

function startReceiver(): Promise<void> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      switch (req.url) {
        case '/fail500':
          res.writeHead(500).end('server error');
          return;
        case '/notfound':
          res.writeHead(404).end('nope');
          return;
        case '/redirect':
          res.writeHead(302, { location: '/ok' }).end();
          return;
        case '/slow':
          setTimeout(() => res.writeHead(200).end('late'), 2_500);
          return;
        default:
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

const hitsFor = (path: string) => received.filter((r) => r.url === path);

beforeAll(async () => {
  await startReceiver();

  const user = await prisma.user.create({
    data: { email: `p5b2-${randomUUID()}@example.test`, passwordHash: 'x', name: 'Exec Tester' },
  });
  created.userIds.push(user.id);
  const project = await prisma.project.create({ data: { userId: user.id, name: 'Exec Project' } });
  projectId = project.id;
  created.projectIds.push(projectId);
  const eventType = await prisma.eventType.create({ data: { projectId, name: 'exec.test' } });
  eventTypeId = eventType.id;
  created.eventTypeIds.push(eventTypeId);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.deliveryAttempt.deleteMany({
    where: { deliveryId: { in: created.deliveryIds } },
  });
  await prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } });
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

async function seedEndpoint(
  url: string,
  overrides: { isActive?: boolean; deletedAt?: Date | null; timeoutMs?: number | null } = {},
): Promise<string> {
  const endpoint = await prisma.endpoint.create({
    data: {
      projectId,
      url,
      signingSecret: encryptSecret(SIGNING_SECRET),
      isActive: overrides.isActive ?? true,
      deletedAt: overrides.deletedAt ?? null,
      timeoutMs: overrides.timeoutMs ?? null,
    },
  });
  created.endpointIds.push(endpoint.id);
  return endpoint.id;
}

/** Seeds event + pending delivery (due 24 h ago) and claims it (batch 1). */
async function seedAndClaim(endpointId: string): Promise<ClaimedDelivery> {
  const event = await prisma.event.create({
    data: {
      projectId,
      eventTypeId,
      payload: PAYLOAD,
      payloadHash: randomBytes(32).toString('hex'),
      idempotencyKey: `idem-${randomUUID()}`,
    },
  });
  created.eventIds.push(event.id);
  const delivery = await prisma.delivery.create({
    data: {
      projectId,
      eventId: event.id,
      endpointId,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 86_400_000),
    },
  });
  created.deliveryIds.push(delivery.id);

  const claimed = await claimDueDeliveries(`exec-test-${randomUUID().slice(0, 8)}`, 1, 60_000);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.id).toBe(delivery.id);
  return claimed[0]!;
}

describe('successful delivery', () => {
  it('signs, pins, POSTs, records success — and the receiver can verify the signature', async () => {
    const endpointId = await seedEndpoint(`http://127.0.0.1:${port}/ok`);
    const claim = await seedAndClaim(endpointId);

    const outcome = await executeClaimedDelivery(claim);
    expect(outcome).toBe('succeeded');

    const hit = hitsFor('/ok').at(-1)!;
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers[WEBHOOK_HEADERS.id]).toBe(claim.id);
    expect(hit.headers[WEBHOOK_HEADERS.eventId]).toBe(claim.eventId);
    expect(hit.headers[WEBHOOK_HEADERS.eventType]).toBe('exec.test');
    expect(hit.headers[WEBHOOK_HEADERS.attempt]).toBe('1');
    expect(Number(hit.headers[WEBHOOK_HEADERS.timestamp])).toBeGreaterThan(0);
    // jsonb round-trips key order in storage form, so the dispatched body is
    // semantically equal to the producer payload; byte-exactness is between
    // the SIGNED string and the SENT body — proven by the signature check.
    expect(JSON.parse(hit.body)).toEqual(PAYLOAD);

    // Receiver-side verification of the documented scheme.
    const signatureHeader = String(hit.headers[WEBHOOK_HEADERS.signature]);
    expect(verifySignatureHeader(SIGNING_SECRET, signatureHeader, hit.body)).toBe(true);
    expect(verifySignatureHeader(SIGNING_SECRET, signatureHeader, `${hit.body} `)).toBe(false);
    expect(verifySignatureHeader('whsec_wrong', signatureHeader, hit.body)).toBe(false);

    const row = await prisma.delivery.findUnique({
      where: { id: claim.id },
      include: { attempts: true },
    });
    expect(row?.status).toBe('succeeded');
    expect(row?.completedAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
    expect(row?.claimToken).toBeNull();
    expect(row?.lockedBy).toBeNull();
    expect(row?.attempts).toHaveLength(1);
    const attempt = row!.attempts[0]!;
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.trigger).toBe('automatic');
    expect(attempt.outcome).toBe('success');
    expect(attempt.responseStatus).toBe(200);
    expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
    expect(attempt.requestUrl).toBe(`http://127.0.0.1:${port}/ok`);
    expect(attempt.finishedAt!.getTime()).toBeGreaterThanOrEqual(attempt.startedAt.getTime());
    created.deliveryIds.includes(claim.id);
  });
});

describe('failure handling', () => {
  it('5xx → retry scheduled (5B.3); 4xx → failed with a permanent attempt', async () => {
    const ep500 = await seedEndpoint(`http://127.0.0.1:${port}/fail500`);
    const claim500 = await seedAndClaim(ep500);
    expect(await executeClaimedDelivery(claim500)).toBe('retrying');

    const row500 = await prisma.delivery.findUnique({
      where: { id: claim500.id },
      include: { attempts: true },
    });
    expect(row500?.status).toBe('pending'); // scheduled for retry
    expect(row500?.completedAt).toBeNull();
    expect(row500?.claimToken).toBeNull();
    expect(row500?.lastError).toContain('500');
    expect(row500?.attempts[0]).toMatchObject({
      outcome: 'failed_retryable',
      responseStatus: 500,
      errorCategory: 'http_5xx',
    });

    const ep404 = await seedEndpoint(`http://127.0.0.1:${port}/notfound`);
    const claim404 = await seedAndClaim(ep404);
    expect(await executeClaimedDelivery(claim404)).toBe('failed');
    const row404 = await prisma.delivery.findUnique({
      where: { id: claim404.id },
      include: { attempts: true },
    });
    expect(row404?.attempts[0]).toMatchObject({
      outcome: 'failed_permanent',
      responseStatus: 404,
      errorCategory: 'http_4xx',
    });
  });

  it('redirects are NOT followed (an unpinned target is never contacted)', async () => {
    const okHitsBefore = hitsFor('/ok').length;
    const ep = await seedEndpoint(`http://127.0.0.1:${port}/redirect`);
    const claim = await seedAndClaim(ep);

    expect(await executeClaimedDelivery(claim)).toBe('failed');

    const row = await prisma.delivery.findUnique({
      where: { id: claim.id },
      include: { attempts: true },
    });
    expect(row?.attempts[0]?.responseStatus).toBe(302);
    expect(row?.attempts[0]?.errorCategory).toBe('other');
    expect(row?.attempts[0]?.errorMessage).toContain('redirect');
    expect(hitsFor('/ok').length).toBe(okHitsBefore); // the Location target was never called
  });

  it('timeouts respect the endpoint override and classify as retryable', async () => {
    const ep = await seedEndpoint(`http://127.0.0.1:${port}/slow`, { timeoutMs: 1000 });
    const claim = await seedAndClaim(ep);

    const startedAt = Date.now();
    expect(await executeClaimedDelivery(claim)).toBe('retrying'); // timeouts are retryable
    expect(Date.now() - startedAt).toBeLessThan(2_400); // did not wait for the 2.5 s body

    const row = await prisma.delivery.findUnique({
      where: { id: claim.id },
      include: { attempts: true },
    });
    expect(row?.attempts[0]).toMatchObject({
      outcome: 'failed_retryable',
      responseStatus: null,
      errorCategory: 'timeout',
    });
  });

  it('DNS failures record a retryable dns attempt', async () => {
    const ep = await seedEndpoint(`http://no-such-${randomUUID().slice(0, 8)}.invalid/hook`);
    const claim = await seedAndClaim(ep);

    expect(await executeClaimedDelivery(claim)).toBe('retrying'); // dns is transient
    const row = await prisma.delivery.findUnique({
      where: { id: claim.id },
      include: { attempts: true },
    });
    expect(row?.attempts[0]).toMatchObject({
      outcome: 'failed_retryable',
      responseStatus: null,
      errorCategory: 'dns',
    });
  });
});

describe('pre-send gate and SSRF', () => {
  it('inactive and deleted endpoints cancel WITHOUT HTTP and WITHOUT attempt rows', async () => {
    const requestsBefore = received.length;

    const inactive = await seedEndpoint(`http://127.0.0.1:${port}/ok`, { isActive: false });
    const claimInactive = await seedAndClaim(inactive);
    expect(await executeClaimedDelivery(claimInactive)).toBe('cancelled');

    const deleted = await seedEndpoint(`http://127.0.0.1:${port}/ok`, {
      isActive: false,
      deletedAt: new Date(),
    });
    const claimDeleted = await seedAndClaim(deleted);
    expect(await executeClaimedDelivery(claimDeleted)).toBe('cancelled');

    const [rowInactive, rowDeleted] = await Promise.all([
      prisma.delivery.findUnique({ where: { id: claimInactive.id }, include: { attempts: true } }),
      prisma.delivery.findUnique({ where: { id: claimDeleted.id }, include: { attempts: true } }),
    ]);
    expect(rowInactive?.status).toBe('cancelled');
    expect(rowInactive?.lastError).toBe('cancelled: endpoint inactive');
    expect(rowInactive?.attempts).toHaveLength(0);
    expect(rowDeleted?.lastError).toBe('cancelled: endpoint deleted');
    expect(rowDeleted?.attempts).toHaveLength(0);
    expect(received.length).toBe(requestsBefore); // zero HTTP traffic
  });

  it('strict mode blocks private destinations at delivery time (ssrf_blocked, permanent)', async () => {
    const ep = await seedEndpoint('https://127.0.0.3/metadata');
    const claim = await seedAndClaim(ep);

    const outcome = await executeClaimedDelivery(claim, { allowPrivateDestinations: false });
    expect(outcome).toBe('failed');

    const row = await prisma.delivery.findUnique({
      where: { id: claim.id },
      include: { attempts: true },
    });
    expect(row?.status).toBe('failed');
    expect(row?.attempts[0]).toMatchObject({
      outcome: 'failed_permanent',
      responseStatus: null,
      errorCategory: 'ssrf_blocked',
    });
  });

  it('connections are pinned: an unresolvable hostname is reached ONLY via the vetted address', async () => {
    const fakeHost = `pinned-${randomUUID().slice(0, 8)}.invalid`;
    const result = await dispatchWebhook({
      url: `http://${fakeHost}:${port}/ok`,
      addresses: ['127.0.0.1'], // the pin — DNS could never produce this
      rawBody: '{"pinned":true}',
      signingSecret: SIGNING_SECRET,
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      eventType: 'exec.test',
      attemptNumber: 1,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true); // socket went to the pin, not to DNS
    const hit = received.at(-1)!;
    expect(hit.headers.host).toBe(`${fakeHost}:${port}`); // Host preserved for the app layer

    // And an empty pin set refuses to connect anywhere.
    const refused = await dispatchWebhook({
      url: `http://${fakeHost}:${port}/ok`,
      addresses: [],
      rawBody: '{}',
      signingSecret: SIGNING_SECRET,
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      eventType: 'exec.test',
      attemptNumber: 1,
      timeoutMs: 5_000,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errorCategory).toBe('connection');
  });
});

describe('fencing during recording', () => {
  it('a worker whose token was replaced mid-flight records NOTHING', async () => {
    const ep = await seedEndpoint(`http://127.0.0.1:${port}/ok`);
    const claim = await seedAndClaim(ep);

    // Simulate a reclaim while the HTTP request is in flight.
    const replacementToken = randomUUID();
    await prisma.delivery.update({
      where: { id: claim.id },
      data: { claimToken: replacementToken },
    });

    const outcome = await executeClaimedDelivery(claim); // still holds the OLD token
    expect(outcome).toBe('stale');

    const row = await prisma.delivery.findUnique({
      where: { id: claim.id },
      include: { attempts: true },
    });
    expect(row?.status).toBe('processing'); // untouched by the stale worker
    expect(row?.claimToken).toBe(replacementToken);
    expect(row?.attempts).toHaveLength(0); // no attempt row either
  });
});

describe('worker tick end-to-end', () => {
  it('one tick claims, executes and records mixed outcomes', async () => {
    const okEp = await seedEndpoint(`http://127.0.0.1:${port}/ok`);
    const failEp = await seedEndpoint(`http://127.0.0.1:${port}/fail500`);

    const mkDelivery = async (endpointId: string) => {
      const event = await prisma.event.create({
        data: {
          projectId,
          eventTypeId,
          payload: PAYLOAD,
          payloadHash: randomBytes(32).toString('hex'),
          idempotencyKey: `idem-${randomUUID()}`,
        },
      });
      created.eventIds.push(event.id);
      const delivery = await prisma.delivery.create({
        data: {
          projectId,
          eventId: event.id,
          endpointId,
          maxAttempts: 3,
          nextAttemptAt: new Date(Date.now() - 86_400_000),
        },
      });
      created.deliveryIds.push(delivery.id);
      return delivery.id;
    };

    const okId = await mkDelivery(okEp);
    const failId = await mkDelivery(failEp);

    const tick = await createWorker({ batchSize: 2, leaseMs: 60_000 }).runTick();
    expect(tick.claimed).toHaveLength(2);
    expect(tick.outcomes[okId]).toBe('succeeded');
    expect(tick.outcomes[failId]).toBe('retrying'); // 5xx + budget left

    expect((await prisma.delivery.findUnique({ where: { id: okId } }))?.status).toBe('succeeded');
    expect((await prisma.delivery.findUnique({ where: { id: failId } }))?.status).toBe('pending');
  });
});
