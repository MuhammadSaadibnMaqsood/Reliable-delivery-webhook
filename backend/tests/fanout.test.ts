import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';

/**
 * Phase 5A.3 transactional fan-out tests against the real database.
 * Every assertion checks actual database state, not just HTTP responses.
 * Non-destructive: unique fixtures, exact-id cleanup (delivery ids are
 * collected from this run's own events before deletion).
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';
const URL_BASE = 'https://example.com/hooks';

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  apiKeyIds: [] as string[],
  eventTypeIds: [] as string[],
  endpointIds: [] as string[],
  subscriptionIds: [] as string[],
  eventIds: [] as string[],
};

let token: string;
let projectId: string;
let apiKey: string;
let epA: string; // no override
let epB: string; // maxAttempts override 7
let epC: string; // will be deactivated
let epD: string; // will be soft-deleted
let epMulti: string; // subscribed to two event types
let subAId: string; // epA -> fan.one (unsubscribed later)

beforeAll(async () => {
  const email = `p5a3-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Fanout Tester', email, password: PASSWORD });
  expect(reg.status).toBe(201);
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  token = login.body.data.token as string;

  const proj = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Fanout Project' });
  projectId = proj.body.data.project.id as string;
  created.projectIds.push(projectId);

  const key = await request(app)
    .post(`/api/v1/projects/${projectId}/api-keys`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Fanout Key' });
  created.apiKeyIds.push(key.body.data.apiKey.id as string);
  apiKey = key.body.data.plaintextKey as string;

  for (const name of ['fan.one', 'fan.multi', 'fan.second', 'fan.none']) {
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/event-types`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
    expect(res.status).toBe(201);
    created.eventTypeIds.push(res.body.data.eventType.id as string);
  }

  const mkEndpoint = async (suffix: string, body: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints`)
      .set('Authorization', `Bearer ${token}`)
      .send({ url: `${URL_BASE}/${suffix}`, ...body });
    expect(res.status).toBe(201);
    const id = res.body.data.endpoint.id as string;
    created.endpointIds.push(id);
    return id;
  };
  epA = await mkEndpoint('a');
  epB = await mkEndpoint('b', { maxAttempts: 7 });
  epC = await mkEndpoint('c');
  epD = await mkEndpoint('d');
  epMulti = await mkEndpoint('multi');
});

afterAll(async () => {
  const deliveries = await prisma.delivery.findMany({
    where: { eventId: { in: created.eventIds } },
    select: { id: true },
  });
  await prisma.delivery.deleteMany({ where: { id: { in: deliveries.map((d) => d.id) } } });
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: created.subscriptionIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } });
  await prisma.apiKey.deleteMany({ where: { id: { in: created.apiKeyIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

async function subscribe(endpointId: string, eventTypeName: string): Promise<string> {
  const types = await prisma.eventType.findMany({
    where: { id: { in: created.eventTypeIds }, name: eventTypeName },
    select: { id: true },
  });
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/endpoints/${endpointId}/subscriptions`)
    .set('Authorization', `Bearer ${token}`)
    .send({ eventTypeId: types[0]!.id });
  expect(res.status).toBe(201);
  const id = res.body.data.subscription.id as string;
  created.subscriptionIds.push(id);
  return id;
}

async function ingest(eventType: string, payload: object, idempotencyKey?: string) {
  const res = await request(app)
    .post('/api/v1/events')
    .set('X-API-Key', apiKey)
    .set('Idempotency-Key', idempotencyKey ?? `idem-${randomUUID()}`)
    .send({ eventType, payload });
  if (res.body?.data?.event?.id && !created.eventIds.includes(res.body.data.event.id)) {
    created.eventIds.push(res.body.data.event.id as string);
  }
  return res;
}

const deliveriesOf = (eventId: string) =>
  prisma.delivery.findMany({ where: { eventId }, orderBy: { createdAt: 'asc' } });

describe('transactional delivery fan-out', () => {
  it('1 eligible endpoint → exactly one pending delivery with the exact initial state', async () => {
    subAId = await subscribe(epA, 'fan.one');

    const res = await ingest('fan.one', { n: 1 });
    expect(res.status).toBe(202);
    expect(res.body.data.deliveriesCreated).toBe(1);

    const rows = await deliveriesOf(res.body.data.event.id);
    expect(rows).toHaveLength(1);
    const d = rows[0]!;
    expect(d.endpointId).toBe(epA);
    expect(d.projectId).toBe(projectId);
    expect(d.status).toBe('pending');
    expect(d.attemptCount).toBe(0);
    expect(d.maxAttempts).toBe(env.DELIVERY_MAX_ATTEMPTS_DEFAULT); // platform default snapshot
    expect(Math.abs(d.nextAttemptAt.getTime() - Date.now())).toBeLessThan(120_000);
    expect(d.leaseExpiresAt).toBeNull();
    expect(d.lockedBy).toBeNull();
    expect(d.claimToken).toBeNull();
    expect(d.completedAt).toBeNull();
    expect(d.lastError).toBeNull();
  });

  it('multiple eligible endpoints → one delivery each, max_attempts snapshots overrides', async () => {
    await subscribe(epB, 'fan.one');
    await subscribe(epC, 'fan.one');

    const res = await ingest('fan.one', { n: 2 });
    expect(res.body.data.deliveriesCreated).toBe(3);

    const rows = await deliveriesOf(res.body.data.event.id);
    expect(rows).toHaveLength(3);
    const byEndpoint = new Map(rows.map((r) => [r.endpointId, r]));
    expect(byEndpoint.get(epB)?.maxAttempts).toBe(7); // endpoint override
    expect(byEndpoint.get(epA)?.maxAttempts).toBe(env.DELIVERY_MAX_ATTEMPTS_DEFAULT);
    expect(byEndpoint.get(epC)?.maxAttempts).toBe(env.DELIVERY_MAX_ATTEMPTS_DEFAULT);
  });

  it('inactive endpoints are excluded from new fan-out', async () => {
    await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints/${epC}/deactivate`)
      .set('Authorization', `Bearer ${token}`);

    const res = await ingest('fan.one', { n: 3 });
    expect(res.body.data.deliveriesCreated).toBe(2); // epA + epB only

    const rows = await deliveriesOf(res.body.data.event.id);
    expect(rows.map((r) => r.endpointId).sort()).toEqual([epA, epB].sort());
  });

  it('soft-deleted endpoints are excluded from new fan-out', async () => {
    await subscribe(epD, 'fan.one');
    await request(app)
      .delete(`/api/v1/projects/${projectId}/endpoints/${epD}`)
      .set('Authorization', `Bearer ${token}`);

    const res = await ingest('fan.one', { n: 4 });
    expect(res.body.data.deliveriesCreated).toBe(2);
    const rows = await deliveriesOf(res.body.data.event.id);
    expect(rows.some((r) => r.endpointId === epD)).toBe(false);
  });

  it('events with no matching subscriptions are stored with zero deliveries', async () => {
    const res = await ingest('fan.none', { lonely: true });
    expect(res.status).toBe(202);
    expect(res.body.data.deliveriesCreated).toBe(0);

    const event = await prisma.event.findUnique({ where: { id: res.body.data.event.id } });
    expect(event).not.toBeNull(); // stored (AC-01)
    expect(await deliveriesOf(res.body.data.event.id)).toHaveLength(0);
  });

  it('an endpoint with several subscriptions gets ONE delivery per event; the unique constraint is the final guard', async () => {
    await subscribe(epMulti, 'fan.multi');
    await subscribe(epMulti, 'fan.second'); // second subscription, different type

    const res = await ingest('fan.multi', { m: 1 });
    expect(res.body.data.deliveriesCreated).toBe(1); // one event ⇒ one delivery
    const rows = await deliveriesOf(res.body.data.event.id);
    expect(rows).toHaveLength(1);

    // Belt-and-braces proof: a duplicate (event_id, endpoint_id) row is
    // unrepresentable at the database layer.
    await expect(
      prisma.delivery.create({
        data: {
          projectId,
          eventId: res.body.data.event.id as string,
          endpointId: epMulti,
          maxAttempts: 3,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('unsubscribing never touches existing deliveries, only future fan-out', async () => {
    const before = await prisma.delivery.findMany({
      where: { eventId: { in: created.eventIds }, endpointId: epA },
    });
    expect(before.length).toBeGreaterThanOrEqual(1);

    const del = await request(app)
      .delete(`/api/v1/projects/${projectId}/endpoints/${epA}/subscriptions/${subAId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);

    // Existing deliveries byte-identical in the fields that matter.
    const after = await prisma.delivery.findMany({
      where: { eventId: { in: created.eventIds }, endpointId: epA },
    });
    expect(after.map((d) => ({ id: d.id, status: d.status, completedAt: d.completedAt }))).toEqual(
      before.map((d) => ({ id: d.id, status: d.status, completedAt: d.completedAt })),
    );

    // Future events skip epA now: only epB remains eligible for fan.one.
    const res = await ingest('fan.one', { n: 5 });
    expect(res.body.data.deliveriesCreated).toBe(1);
    expect((await deliveriesOf(res.body.data.event.id))[0]!.endpointId).toBe(epB);
  });

  it('delivery-creation failure rolls back the WHOLE transaction — no event, no deliveries', async () => {
    const idempotencyKey = `idem-rollback-${randomUUID()}`;
    const originalTransaction = prisma.$transaction.bind(prisma);

    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
      arg: unknown,
      opts?: unknown,
    ) => {
      if (typeof arg !== 'function') {
        return originalTransaction(arg as never, opts as never);
      }
      return originalTransaction(async (tx: Prisma.TransactionClient) => {
        const sabotaged = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'delivery') {
              return new Proxy(target.delivery, {
                get(delegate, method, r) {
                  if (method === 'createMany') {
                    return () => Promise.reject(new Error('forced fan-out failure (test)'));
                  }
                  return Reflect.get(delegate, method, r);
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        return (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(sabotaged);
      }, opts as never);
    }) as never);

    try {
      const res = await ingest('fan.one', { boom: true }, idempotencyKey);
      expect(res.status).toBe(500); // unexpected error, opaque to the client
    } finally {
      spy.mockRestore();
    }

    // Rollback proof at the database: the event never committed.
    const event = await prisma.event.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
    expect(event).toBeNull();
  });

  it('idempotent replay creates no additional deliveries', async () => {
    const idempotencyKey = `idem-replay-${randomUUID()}`;
    const payload = { r: 1 };

    const first = await ingest('fan.one', payload, idempotencyKey);
    expect(first.status).toBe(202);
    expect(first.body.data.deliveriesCreated).toBe(1); // epB
    const eventId = first.body.data.event.id as string;

    const replay = await ingest('fan.one', payload, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.event.id).toBe(eventId);

    expect(await deliveriesOf(eventId)).toHaveLength(1); // unchanged
  });
});
