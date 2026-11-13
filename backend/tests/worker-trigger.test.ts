import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { runCleanup } from './cleanup-helper.js';

/**
 * Scheduler-trigger endpoint tests against the real database.
 *
 * The trigger runs a GLOBAL tick (batch size = WORKER_BATCH_SIZE, pinned to
 * 2 in vitest.config), so every test that lets a tick run first seeds
 * enough far-past, fail-fast fixtures to fully occupy the batch — the tick
 * can then never touch rows outside this suite (shared-database safety,
 * same discipline as the other worker suites). Fixture endpoints carry an
 * undecryptable signing secret, so execution fails immediately with no
 * HTTP traffic and no attempt rows.
 */

const app = buildApp();
const SECRET = env.WORKER_TRIGGER_SECRET;

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
    data: { email: `p5c-${randomUUID()}@example.test`, passwordHash: 'x', name: 'Trigger Tester' },
  });
  created.userIds.push(user.id);
  const project = await prisma.project.create({
    data: { userId: user.id, name: 'Trigger Project' },
  });
  projectId = project.id;
  created.projectIds.push(projectId);
  const eventType = await prisma.eventType.create({ data: { projectId, name: 'trigger.test' } });
  eventTypeId = eventType.id;
  created.eventTypeIds.push(eventTypeId);
  const endpoint = await prisma.endpoint.create({
    data: {
      projectId,
      url: 'https://receiver.example.test/trigger',
      signingSecret: 'v1:unused:unused:unused', // undecryptable → fail fast, no HTTP
    },
  });
  endpointId = endpoint.id;
  created.endpointIds.push(endpointId);
});

afterAll(() =>
  runCleanup('worker-trigger', [
    ['deliveries', () => prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } })],
    ['events', () => prisma.event.deleteMany({ where: { id: { in: created.eventIds } } })],
    ['endpoints', () => prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } })],
    ['eventTypes', () => prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } })],
    ['projects', () => prisma.project.deleteMany({ where: { id: { in: created.projectIds } } })],
    ['users', () => prisma.user.deleteMany({ where: { id: { in: created.userIds } } })],
  ]),
);

async function seedDueDelivery(): Promise<string> {
  const event = await prisma.event.create({
    data: {
      projectId,
      eventTypeId,
      payload: { t: 1 },
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
      nextAttemptAt: new Date(Date.now() - 86_400_000), // sorts before anything real
    },
  });
  created.deliveryIds.push(delivery.id);
  return delivery.id;
}

const trigger = (secret?: string) => {
  const req = request(app).post('/internal/worker/tick');
  return secret === undefined ? req : req.set('X-Worker-Secret', secret);
};

describe('authentication', () => {
  it('rejects a missing secret, an invalid secret and a wrong-length secret with 401', async () => {
    const missing = await trigger();
    const invalid = await trigger('a'.repeat(SECRET.length));
    const wrongLength = await trigger('short');

    for (const res of [missing, invalid, wrongLength]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
    // No tick ran: nothing of ours was claimed.
    const touched = await prisma.delivery.count({
      where: { id: { in: created.deliveryIds }, NOT: { status: 'pending' } },
    });
    expect(touched).toBe(0);
  });

  it('rejects unsupported methods on the tick path', async () => {
    expect((await request(app).get('/internal/worker/tick')).status).toBe(404);
    expect((await request(app).delete('/internal/worker/tick')).status).toBe(404);
  });
});

describe('tick execution', () => {
  it('a valid secret runs one bounded tick and returns a minimal summary', async () => {
    const [d1, d2] = [await seedDueDelivery(), await seedDueDelivery()]; // fills batch (2)

    const res = await trigger(SECRET);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { workerId, swept, claimed, outcomes } = res.body.data;
    expect(typeof workerId).toBe('string');
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(claimed).toBe(2); // exactly our fixtures — batch fully occupied
    expect(outcomes.failed).toBe(2); // undecryptable secret → fail fast

    // Minimal summary: counts only — no ids, URLs, payloads or stack traces.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(d1!);
    expect(serialized).not.toContain(d2!);
    expect(serialized).not.toContain('receiver.example.test');
    expect(serialized).not.toContain(SECRET);

    const rows = await prisma.delivery.findMany({ where: { id: { in: [d1!, d2!] } } });
    expect(rows.every((r) => r.status === 'failed' && r.attemptCount === 1)).toBe(true);
  });

  it('concurrent triggers never double-claim (existing safeguards hold through the endpoint)', async () => {
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => seedDueDelivery()), // 2 ticks × batch 2
    );

    const [a, b] = await Promise.all([trigger(SECRET), trigger(SECRET)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.claimed + b.body.data.claimed).toBe(4); // nothing lost…

    const rows = await prisma.delivery.findMany({ where: { id: { in: ids } } });
    // …and nothing claimed twice: exactly one consumed attempt per delivery.
    expect(rows.every((r) => r.status === 'failed' && r.attemptCount === 1)).toBe(true);
  });

  it('worker failures surface as an opaque 500, never internals', async () => {
    // First queue statement of a tick is the sweep ($executeRaw) — make it blow up.
    const spy = vi
      .spyOn(prisma, '$executeRaw')
      .mockRejectedValueOnce(new Error('synthetic database outage (test)'));

    try {
      const res = await trigger(SECRET);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.message).toBe('Something went wrong'); // opaque to the caller
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    } finally {
      spy.mockRestore();
    }
  });
});
