import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { executeClaimedDelivery } from '../src/services/delivery-executor.service.js';
import {
  claimDueDeliveries,
  sweepExhaustedExpiredLeases,
  type ClaimedDelivery,
} from '../src/services/delivery-queue.service.js';
import { encryptSecret } from '../src/utils/crypto.js';
import { computeRetryDelayMs, JITTER_RATIO } from '../src/utils/retry-policy.js';

/**
 * Phase 5B.3 retry-engine tests: policy math as pure units, transitions
 * against the real database with a local mock receiver. Same foreign-row
 * safety discipline as the other worker suites (24 h-past seeds, batch-1
 * claims, force-due only on our own rows).
 *
 * Backoff windows are asserted between next_attempt_at and updated_at —
 * BOTH server-written timestamps — so the bounds are exact and immune to
 * client/server clock skew.
 */

const SIGNING_SECRET = `whsec_${randomBytes(32).toString('base64url')}`;

let server: http.Server;
let port: number;

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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/notfound') res.writeHead(404).end();
    else res.writeHead(500).end('boom');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });

  const user = await prisma.user.create({
    data: { email: `p5b3-${randomUUID()}@example.test`, passwordHash: 'x', name: 'Retry Tester' },
  });
  created.userIds.push(user.id);
  const project = await prisma.project.create({ data: { userId: user.id, name: 'Retry Project' } });
  projectId = project.id;
  created.projectIds.push(projectId);
  const eventType = await prisma.eventType.create({ data: { projectId, name: 'retry.test' } });
  eventTypeId = eventType.id;
  created.eventTypeIds.push(eventTypeId);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.deliveryAttempt.deleteMany({ where: { deliveryId: { in: created.deliveryIds } } });
  await prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } });
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

async function seedEndpoint(path: string): Promise<string> {
  const endpoint = await prisma.endpoint.create({
    data: {
      projectId,
      url: `http://127.0.0.1:${port}${path}`,
      signingSecret: encryptSecret(SIGNING_SECRET),
    },
  });
  created.endpointIds.push(endpoint.id);
  return endpoint.id;
}

async function seedDelivery(endpointId: string, maxAttempts: number): Promise<string> {
  const event = await prisma.event.create({
    data: {
      projectId,
      eventTypeId,
      payload: { retry: true },
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
      maxAttempts,
      nextAttemptAt: new Date(Date.now() - 86_400_000),
    },
  });
  created.deliveryIds.push(delivery.id);
  return delivery.id;
}

async function claimOne(expectedId: string): Promise<ClaimedDelivery> {
  const claimed = await claimDueDeliveries(`retry-${randomUUID().slice(0, 8)}`, 1, 60_000);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.id).toBe(expectedId);
  return claimed[0]!;
}

/** Force a pending delivery due again — our own fixture rows only. */
async function forceDue(deliveryId: string): Promise<void> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { nextAttemptAt: new Date(Date.now() - 86_400_000) },
  });
}

describe('backoff policy (pure)', () => {
  const policy = { initialDelayMs: 30_000, maxDelayMs: 3_600_000 };
  const mid = () => 0.5; // jitter factor exactly 1.0

  it('doubles per consumed attempt and respects the hard maximum', () => {
    expect(computeRetryDelayMs(1, { ...policy, random: mid })).toBe(30_000);
    expect(computeRetryDelayMs(2, { ...policy, random: mid })).toBe(60_000);
    expect(computeRetryDelayMs(3, { ...policy, random: mid })).toBe(120_000);
    expect(computeRetryDelayMs(6, { ...policy, random: mid })).toBe(960_000);
    expect(computeRetryDelayMs(8, { ...policy, random: mid })).toBe(3_600_000); // capped
    expect(computeRetryDelayMs(30, { ...policy, random: mid })).toBe(3_600_000); // stays capped
    // Even maximum upward jitter can never pierce the ceiling.
    expect(computeRetryDelayMs(30, { ...policy, random: () => 1 })).toBe(3_600_000);
  });

  it('keeps jitter inside ±20% of the capped base', () => {
    for (let i = 0; i < 200; i += 1) {
      const delay = computeRetryDelayMs(3, policy); // base 120 000
      expect(delay).toBeGreaterThanOrEqual(120_000 * (1 - JITTER_RATIO));
      expect(delay).toBeLessThanOrEqual(120_000 * (1 + JITTER_RATIO));
    }
    // And jitter actually varies (not a constant).
    const samples = new Set(
      Array.from({ length: 50 }, () => computeRetryDelayMs(3, policy)),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('retry transitions', () => {
  it('retryable failure with budget → pending with exact first-backoff window; growth on the next attempt; dead-letter on exhaustion; history preserved', async () => {
    const endpointId = await seedEndpoint('/fail500');
    const deliveryId = await seedDelivery(endpointId, 3);

    // --- attempt 1: pending, delay in [0.8, 1.2] × 30 s (server-clock exact)
    expect(await executeClaimedDelivery(await claimOne(deliveryId))).toBe('retrying');
    let row = (await prisma.delivery.findUnique({ where: { id: deliveryId } }))!;
    expect(row.status).toBe('pending');
    expect(row.attemptCount).toBe(1);
    expect(row.completedAt).toBeNull();
    expect(row.claimToken).toBeNull();
    expect(row.lockedBy).toBeNull();
    expect(row.lastError).toContain('500');
    const delay1 = row.nextAttemptAt.getTime() - row.updatedAt.getTime();
    expect(delay1).toBeGreaterThanOrEqual(24_000);
    expect(delay1).toBeLessThanOrEqual(36_000);

    // --- attempt 2: exponential growth, [0.8, 1.2] × 60 s
    await forceDue(deliveryId);
    expect(await executeClaimedDelivery(await claimOne(deliveryId))).toBe('retrying');
    row = (await prisma.delivery.findUnique({ where: { id: deliveryId } }))!;
    expect(row.attemptCount).toBe(2);
    const delay2 = row.nextAttemptAt.getTime() - row.updatedAt.getTime();
    expect(delay2).toBeGreaterThanOrEqual(48_000);
    expect(delay2).toBeLessThanOrEqual(72_000);

    // --- attempt 3 (= max): retryable failure with no budget → dead_lettered
    await forceDue(deliveryId);
    expect(await executeClaimedDelivery(await claimOne(deliveryId))).toBe('dead_lettered');
    const full = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });
    expect(full?.status).toBe('dead_lettered');
    expect(full?.completedAt).not.toBeNull();
    expect(full?.claimToken).toBeNull();
    // Complete, truthful attempt history (AC-03 / FR-49).
    expect(full?.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(full?.attempts.every((a) => a.outcome === 'failed_retryable')).toBe(true);
    expect(full?.attempts.every((a) => a.responseStatus === 500)).toBe(true);
  });

  it('permanent failure → failed immediately, budget irrelevant', async () => {
    const endpointId = await seedEndpoint('/notfound');
    const deliveryId = await seedDelivery(endpointId, 3);

    expect(await executeClaimedDelivery(await claimOne(deliveryId))).toBe('failed');
    const row = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { attempts: true },
    });
    expect(row?.status).toBe('failed');
    expect(row?.attemptCount).toBe(1); // two attempts were still available
    expect(row?.completedAt).not.toBeNull();
    expect(row?.attempts[0]?.outcome).toBe('failed_permanent');
  });

  it('crash on the final attempt: sweep dead-letters WITHOUT fabricating an attempt row', async () => {
    const endpointId = await seedEndpoint('/fail500');
    const deliveryId = await seedDelivery(endpointId, 2);
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: 'processing',
        attemptCount: 2, // final attempt was in flight
        claimToken: randomUUID(),
        lockedBy: 'worker-crashed',
        leaseExpiresAt: new Date(Date.now() - 3_600_000),
      },
    });

    const swept = await sweepExhaustedExpiredLeases();
    expect(swept).toBeGreaterThanOrEqual(1);

    const row = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { attempts: true },
    });
    expect(row?.status).toBe('dead_lettered');
    expect(row?.completedAt).not.toBeNull();
    expect(row?.claimToken).toBeNull();
    expect(row?.attempts).toHaveLength(0); // the HTTP request never completed
  });

  it('expired lease with budget left is reclaimed (attempt count grows, token replaced)', async () => {
    const endpointId = await seedEndpoint('/fail500');
    const deliveryId = await seedDelivery(endpointId, 3);
    const oldToken = randomUUID();
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: 'processing',
        attemptCount: 1,
        claimToken: oldToken,
        lockedBy: 'worker-crashed',
        leaseExpiresAt: new Date(Date.now() - 3_600_000),
      },
    });

    const claim = await claimOne(deliveryId);
    expect(claim.attemptCount).toBe(2);
    expect(claim.claimToken).not.toBe(oldToken);
  });

  it('a stale worker cannot schedule a retry over newer state', async () => {
    const endpointId = await seedEndpoint('/fail500');
    const deliveryId = await seedDelivery(endpointId, 3);
    const claim = await claimOne(deliveryId);

    const replacement = randomUUID();
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { claimToken: replacement },
    });

    expect(await executeClaimedDelivery(claim)).toBe('stale');
    const row = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { attempts: true },
    });
    expect(row?.status).toBe('processing'); // untouched
    expect(row?.claimToken).toBe(replacement);
    expect(row?.attempts).toHaveLength(0); // nothing recorded by the loser
  });
});
