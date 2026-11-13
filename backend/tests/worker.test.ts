import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import {
  claimDueDeliveries,
  extendLease,
  sweepExhaustedExpiredLeases,
} from '../src/services/delivery-queue.service.js';
import { createWorker } from '../src/services/worker.service.js';

/**
 * Phase 5B.1 worker-foundation tests against the real database: claiming,
 * SKIP LOCKED concurrency, lease expiry/reclaim, fencing, exhausted sweep.
 * Fixtures are built directly with Prisma (queue mechanics, not HTTP).
 * Non-destructive: unique fixtures, exact-id cleanup.
 */

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f-]{36}$/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
let endpointId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `p5b1-${randomUUID()}@example.test`,
      passwordHash: 'x',
      name: 'Worker Tester',
    },
  });
  created.userIds.push(user.id);

  const project = await prisma.project.create({
    data: { userId: user.id, name: 'Worker Project' },
  });
  projectId = project.id;
  created.projectIds.push(projectId);

  const eventType = await prisma.eventType.create({
    data: { projectId, name: 'worker.test' },
  });
  eventTypeId = eventType.id;
  created.eventTypeIds.push(eventTypeId);

  const endpoint = await prisma.endpoint.create({
    data: {
      projectId,
      url: 'https://receiver.example.test/worker',
      signingSecret: 'v1:unused:unused:unused',
    },
  });
  endpointId = endpoint.id;
  created.endpointIds.push(endpointId);
});

afterAll(async () => {
  await prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } });
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

interface DeliverySeed {
  status?: 'pending' | 'processing';
  attemptCount?: number;
  maxAttempts?: number;
  nextAttemptAt?: Date;
  leaseExpiresAt?: Date | null;
  claimToken?: string | null;
  lockedBy?: string | null;
}

/**
 * Each delivery needs its own event ((event_id, endpoint_id) is unique).
 *
 * SAFETY: this suite runs against the real shared database and the claim
 * query is global, so every seed defaults next_attempt_at to 24 h in the
 * past — our rows always sort FIRST in the claim's ORDER BY — and every
 * claim call uses a batch size no larger than the seeded eligible count.
 * Together that guarantees the tests can never claim (mutate) a delivery
 * that is not part of this run's fixtures.
 */
async function seedDelivery(seed: DeliverySeed = {}): Promise<string> {
  const event = await prisma.event.create({
    data: {
      projectId,
      eventTypeId,
      payload: { seeded: true },
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
      status: seed.status ?? 'pending',
      attemptCount: seed.attemptCount ?? 0,
      maxAttempts: seed.maxAttempts ?? 3,
      nextAttemptAt: seed.nextAttemptAt ?? new Date(Date.now() - 86_400_000),
      leaseExpiresAt: seed.leaseExpiresAt ?? null,
      claimToken: seed.claimToken ?? null,
      lockedBy: seed.lockedBy ?? null,
    },
  });
  created.deliveryIds.push(delivery.id);
  return delivery.id;
}

describe('claiming', () => {
  it('claims due pending deliveries atomically with full claim state', async () => {
    const due = await seedDelivery();
    const future = await seedDelivery({ nextAttemptAt: new Date(Date.now() + 3_600_000) });
    // Seeded with the EARLIEST next_attempt_at of all: if the attempt-budget
    // guard were broken, this row would be claimed first. Batch size 1 keeps
    // the claim inside our fixtures.
    const exhausted = await seedDelivery({
      attemptCount: 3,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const claimed = await claimDueDeliveries('worker-A', 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(due); // exhausted outranked it — and was skipped

    const untouchedFuture = await prisma.delivery.findUnique({ where: { id: future } });
    const untouchedExhausted = await prisma.delivery.findUnique({ where: { id: exhausted } });
    expect(untouchedFuture?.status).toBe('pending');
    expect(untouchedExhausted?.status).toBe('pending');
    expect(untouchedExhausted?.attemptCount).toBe(3);

    const row = await prisma.delivery.findUnique({ where: { id: due } });
    expect(row?.status).toBe('processing');
    expect(row?.attemptCount).toBe(1); // incremented exactly at claim
    expect(row?.claimToken).toMatch(UUID_FORMAT);
    expect(row?.lockedBy).toBe('worker-A');
    expect(row?.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    const returned = claimed.find((c) => c.id === due)!;
    expect(returned.claimToken).toBe(row?.claimToken); // token handed to the worker
    expect(returned.attemptCount).toBe(1);
    expect(returned.endpointId).toBe(endpointId);
  });

  it('SKIP LOCKED: two workers claiming concurrently never share a delivery', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seedDelivery()));

    // 5 + 5 slots for exactly 10 fixture rows (which sort first): the two
    // workers partition OUR rows and can never spill onto foreign ones.
    const [a, b] = await Promise.all([
      claimDueDeliveries('worker-A', 5, 60_000),
      claimDueDeliveries('worker-B', 5, 60_000),
    ]);

    const setA = new Set(a.map((c) => c.id).filter((id) => ids.includes(id)));
    const setB = new Set(b.map((c) => c.id).filter((id) => ids.includes(id)));
    const overlap = [...setA].filter((id) => setB.has(id));

    expect(overlap).toHaveLength(0); // never the same delivery twice
    expect(setA.size + setB.size).toBe(10); // and nothing lost
  });
});

describe('lease expiry, reclaim and fencing', () => {
  it('expired leases with attempts left are reclaimed with a NEW token; stale CAS writes nothing', async () => {
    const id = await seedDelivery({ maxAttempts: 3 });

    const [first] = await claimDueDeliveries('worker-A', 1, 150); // 150 ms lease
    expect(first?.id).toBe(id);
    const oldToken = first!.claimToken;

    await sleep(600); // lease expires; worker-A is presumed dead

    const [reclaimed] = await claimDueDeliveries('worker-B', 1, 60_000);
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed!.claimToken).not.toBe(oldToken); // token REPLACED
    expect(reclaimed!.attemptCount).toBe(2); // reclaim consumed an attempt

    // worker-A wakes up late: its CAS must affect zero rows and change nothing.
    const staleAccepted = await extendLease({ deliveryId: id, claimToken: oldToken }, 60_000);
    expect(staleAccepted).toBe(false);

    const row = await prisma.delivery.findUnique({ where: { id } });
    expect(row?.lockedBy).toBe('worker-B');
    expect(row?.claimToken).toBe(reclaimed!.claimToken);

    // The CURRENT holder's CAS still works.
    const currentAccepted = await extendLease(
      { deliveryId: id, claimToken: reclaimed!.claimToken },
      60_000,
    );
    expect(currentAccepted).toBe(true);
  });

  it('lease expiry ALONE does not invalidate a token (un-reclaimed worker still owns its claim)', async () => {
    const id = await seedDelivery();

    const [claim] = await claimDueDeliveries('worker-slow', 1, 150);
    expect(claim?.id).toBe(id);

    await sleep(600); // lease long expired — but NOBODY reclaimed or swept

    const stillOwner = await extendLease({ deliveryId: id, claimToken: claim!.claimToken }, 60_000);
    expect(stillOwner).toBe(true); // the token dies by replacement, not by clock

    const row = await prisma.delivery.findUnique({ where: { id } });
    expect(row?.lockedBy).toBe('worker-slow');
    expect(row?.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });
});

describe('exhausted-lease sweep', () => {
  it('dead-letters only expired+exhausted processing deliveries, clearing lease/worker/token', async () => {
    const past = new Date(Date.now() - 3_600_000); // 1 h: immune to client/server clock skew
    const future = new Date(Date.now() + 60_000);

    const exhaustedExpired = await seedDelivery({
      status: 'processing',
      attemptCount: 3,
      maxAttempts: 3,
      leaseExpiresAt: past,
      claimToken: randomUUID(),
      lockedBy: 'worker-dead',
    });
    const expiredWithBudget = await seedDelivery({
      status: 'processing',
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: past,
      claimToken: randomUUID(),
      lockedBy: 'worker-dead',
    });
    const healthyProcessing = await seedDelivery({
      status: 'processing',
      attemptCount: 3,
      maxAttempts: 3,
      leaseExpiresAt: future,
      claimToken: randomUUID(),
      lockedBy: 'worker-alive',
    });

    const swept = await sweepExhaustedExpiredLeases();
    expect(swept).toBeGreaterThanOrEqual(1);

    const dead = await prisma.delivery.findUnique({ where: { id: exhaustedExpired } });
    expect(dead?.status).toBe('dead_lettered');
    expect(dead?.completedAt).not.toBeNull();
    expect(dead?.claimToken).toBeNull(); // fences the crashed worker
    expect(dead?.leaseExpiresAt).toBeNull();
    expect(dead?.lockedBy).toBeNull();
    expect(dead?.lastError).toBe('processor crashed on final attempt');

    // Attempts remaining → NOT swept (reclaimable instead).
    expect((await prisma.delivery.findUnique({ where: { id: expiredWithBudget } }))?.status).toBe(
      'processing',
    );
    // Live lease → untouched even though exhausted.
    const healthy = await prisma.delivery.findUnique({ where: { id: healthyProcessing } });
    expect(healthy?.status).toBe('processing');
    expect(healthy?.claimToken).not.toBeNull();
  });
});

describe('worker tick', () => {
  it('one bounded tick: sweeps first, then claims up to the batch size', async () => {
    const past = new Date(Date.now() - 3_600_000); // 1 h: immune to client/server clock skew

    const toSweep = await seedDelivery({
      status: 'processing',
      attemptCount: 2,
      maxAttempts: 2,
      leaseExpiresAt: past,
      claimToken: randomUUID(),
      lockedBy: 'worker-dead',
    });
    const toReclaim = await seedDelivery({
      status: 'processing',
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: past,
      claimToken: randomUUID(),
      lockedBy: 'worker-dead',
    });
    const fresh = await Promise.all([seedDelivery(), seedDelivery(), seedDelivery()]);

    const worker = createWorker({ batchSize: 2, leaseMs: 60_000 });
    expect(worker.workerId).toMatch(/^.+:\d+:[0-9a-f]{8}$/);

    const tick = await worker.runTick();
    expect(tick.workerId).toBe(worker.workerId);
    expect(tick.swept).toBeGreaterThanOrEqual(1);
    expect(tick.claimed).toHaveLength(2); // bounded by batchSize

    expect((await prisma.delivery.findUnique({ where: { id: toSweep } }))?.status).toBe(
      'dead_lettered',
    );

    for (const claimedDelivery of tick.claimed) {
      const row = await prisma.delivery.findUnique({ where: { id: claimedDelivery.id } });
      // Since 5B.2 the tick also EXECUTES its claims. These synthetic
      // fixtures carry an undecryptable signing secret, so they fail fast
      // (no HTTP, no attempt row) — which proves execution ran and
      // terminal transitions clear the claim fields.
      expect(row?.status).toBe('failed');
      expect(row?.lastError).toBe('configuration: signing secret unavailable');
      expect(row?.claimToken).toBeNull();
      expect(tick.outcomes[claimedDelivery.id]).toBe('failed');
    }

    // The reclaim candidate, the fresh pendings and this file's earlier
    // leftover (the expired-with-budget row) compete for the 2 slots; every
    // claim must come from this run's own fixtures.
    expect(fresh.length).toBeGreaterThan(0);
    expect([toReclaim, ...fresh].every((id) => created.deliveryIds.includes(id))).toBe(true);
    for (const claimedDelivery of tick.claimed) {
      expect(created.deliveryIds).toContain(claimedDelivery.id);
    }
  });
});
