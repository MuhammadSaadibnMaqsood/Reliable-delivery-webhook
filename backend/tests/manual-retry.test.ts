import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

/**
 * Phase 5B.4 manual-retry API tests (UC-30) against the real database.
 * Fixtures built with Prisma in precise states; exact-id cleanup.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  eventTypeIds: [] as string[],
  endpointIds: [] as string[],
  eventIds: [] as string[],
  deliveryIds: [] as string[],
  attemptIds: [] as string[],
};

let alice: { token: string; userId: string };
let mallory: { token: string };
let projectId: string;
let eventTypeId: string;
let liveEndpointId: string;
let deadEndpointId: string;

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `p5b4-${tag}-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `Retry ${tag}`, email, password: PASSWORD });
  expect(reg.status).toBe(201);
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.data.token as string, userId: reg.body.data.user.id as string };
}

beforeAll(async () => {
  alice = await makeUser('alice');
  mallory = await makeUser('mallory');

  const proj = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${alice.token}`)
    .send({ name: 'Manual Retry Project' });
  projectId = proj.body.data.project.id as string;
  created.projectIds.push(projectId);

  const eventType = await prisma.eventType.create({ data: { projectId, name: 'manual.retry' } });
  eventTypeId = eventType.id;
  created.eventTypeIds.push(eventTypeId);

  const live = await prisma.endpoint.create({
    data: { projectId, url: 'https://receiver.example.test/live', signingSecret: 'v1:x:x:x' },
  });
  liveEndpointId = live.id;
  const dead = await prisma.endpoint.create({
    data: {
      projectId,
      url: 'https://receiver.example.test/dead',
      signingSecret: 'v1:x:x:x',
      isActive: false,
    },
  });
  deadEndpointId = dead.id;
  created.endpointIds.push(live.id, dead.id);
});

afterAll(async () => {
  await prisma.deliveryAttempt.deleteMany({ where: { id: { in: created.attemptIds } } });
  await prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } });
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

type DeliveryState = 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead_lettered' | 'cancelled';

async function seedDelivery(
  endpointId: string,
  status: DeliveryState,
  attemptCount: number,
  maxAttempts: number,
  withAttemptRows = 0,
): Promise<string> {
  const event = await prisma.event.create({
    data: {
      projectId,
      eventTypeId,
      payload: { m: 1 },
      payloadHash: randomBytes(32).toString('hex'),
      idempotencyKey: `idem-${randomUUID()}`,
    },
  });
  created.eventIds.push(event.id);

  const terminal = status === 'succeeded' || status === 'failed' || status === 'dead_lettered' || status === 'cancelled';
  const delivery = await prisma.delivery.create({
    data: {
      projectId,
      eventId: event.id,
      endpointId,
      status,
      attemptCount,
      maxAttempts,
      nextAttemptAt: new Date(Date.now() - 86_400_000),
      completedAt: terminal ? new Date() : null,
      lastError: terminal && status !== 'succeeded' ? 'seeded failure' : null,
      ...(status === 'processing'
        ? { claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }
        : {}),
    },
  });
  created.deliveryIds.push(delivery.id);

  for (let n = 1; n <= withAttemptRows; n += 1) {
    const attempt = await prisma.deliveryAttempt.create({
      data: {
        deliveryId: delivery.id,
        attemptNumber: n,
        outcome: 'failed_retryable',
        responseStatus: 500,
        requestUrl: 'https://receiver.example.test/live',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    created.attemptIds.push(attempt.id);
  }
  return delivery.id;
}

const retry = (token: string, pid: string, did: string) =>
  request(app)
    .post(`/api/v1/projects/${pid}/deliveries/${did}/retry`)
    .set('Authorization', `Bearer ${token}`);

describe('manual retry API', () => {
  it('re-opens a dead_lettered delivery: +1 attempt, completed_at cleared, history preserved', async () => {
    const id = await seedDelivery(liveEndpointId, 'dead_lettered', 3, 3, 3);

    const res = await retry(alice.token, projectId, id);
    expect(res.status).toBe(200);
    expect(res.body.data.delivery).toMatchObject({
      status: 'pending',
      attemptCount: 3, // NEVER reset
      maxAttempts: 4, // exactly one more attempt
    });

    const row = await prisma.delivery.findUnique({
      where: { id },
      include: { attempts: true },
    });
    expect(row?.completedAt).toBeNull();
    expect(row?.claimToken).toBeNull();
    expect(row?.lockedBy).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.attempts).toHaveLength(3); // history untouched
    // Due immediately (server-side now()).
    expect(row!.nextAttemptAt.getTime() - row!.updatedAt.getTime()).toBeLessThanOrEqual(1000);
  });

  it('works for failed and for cancelled-with-reactivated-endpoint deliveries', async () => {
    const failed = await seedDelivery(liveEndpointId, 'failed', 1, 3, 1);
    expect((await retry(alice.token, projectId, failed)).status).toBe(200);

    const cancelled = await seedDelivery(liveEndpointId, 'cancelled', 0, 3);
    const res = await retry(alice.token, projectId, cancelled);
    expect(res.status).toBe(200);
    expect(res.body.data.delivery.maxAttempts).toBe(1); // 0 consumed + 1 granted
  });

  it('rejects ineligible states with 409 and foreign access with 404', async () => {
    const succeeded = await seedDelivery(liveEndpointId, 'succeeded', 1, 3);
    const pending = await seedDelivery(liveEndpointId, 'pending', 0, 3);
    const processing = await seedDelivery(liveEndpointId, 'processing', 1, 3);
    const onDeadEndpoint = await seedDelivery(deadEndpointId, 'failed', 1, 3);

    expect((await retry(alice.token, projectId, succeeded)).status).toBe(409);
    expect((await retry(alice.token, projectId, pending)).status).toBe(409);
    expect((await retry(alice.token, projectId, processing)).status).toBe(409);

    const deadEp = await retry(alice.token, projectId, onDeadEndpoint);
    expect(deadEp.status).toBe(409);
    expect(deadEp.body.message).toContain('not active');

    // Tenant isolation: indistinguishable 404s; and 401 without a token.
    expect((await retry(mallory.token, projectId, succeeded)).status).toBe(404);
    const noAuth = await request(app).post(
      `/api/v1/projects/${projectId}/deliveries/${succeeded}/retry`,
    );
    expect(noAuth.status).toBe(401);

    // Nothing about the succeeded delivery changed.
    expect((await prisma.delivery.findUnique({ where: { id: succeeded } }))?.status).toBe(
      'succeeded',
    );
  });

  it('concurrent duplicate retries collapse to one winner', async () => {
    const id = await seedDelivery(liveEndpointId, 'dead_lettered', 2, 2, 2);

    const results = await Promise.all([
      retry(alice.token, projectId, id),
      retry(alice.token, projectId, id),
      retry(alice.token, projectId, id),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1); // exactly one grant
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);

    const row = await prisma.delivery.findUnique({ where: { id } });
    expect(row?.status).toBe('pending');
    expect(row?.maxAttempts).toBe(3); // granted ONCE: 2+1, not 2+3
  });
});
