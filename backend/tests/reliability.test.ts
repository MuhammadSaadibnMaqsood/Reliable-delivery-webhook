import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { executeClaimedDelivery } from '../src/services/delivery-executor.service.js';
import { claimDueDeliveries } from '../src/services/delivery-queue.service.js';
import { createWorker } from '../src/services/worker.service.js';
import { encryptSecret } from '../src/utils/crypto.js';
import { WEBHOOK_HEADERS } from '../src/utils/webhook-signature.js';

/**
 * Phase 5B.4 reliability verification: the COMPLETE lifecycle through the
 * real APIs, the real queue and a local mock receiver, against Neon.
 * Same safety discipline as every worker suite: far-past next_attempt_at,
 * claims bounded to our own eligible rows, exact-id cleanup.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';
const SIGNING_SECRET = `whsec_${randomBytes(32).toString('base64url')}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: http.Server;
let port: number;

/** Mock receiver state. */
let flakyRemainingFailures = 0; // /flaky returns 500 while > 0, then 200
const seenDeliveryIds = new Map<string, number>(); // receiver-side dedupe ledger

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
let eventTypeId: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const deliveryId = String(req.headers[WEBHOOK_HEADERS.id] ?? '');
    if (deliveryId) {
      seenDeliveryIds.set(deliveryId, (seenDeliveryIds.get(deliveryId) ?? 0) + 1);
    }
    req.resume();
    req.on('end', () => {
      switch (req.url) {
        case '/flaky':
          if (flakyRemainingFailures > 0) {
            flakyRemainingFailures -= 1;
            res.writeHead(500).end();
          } else {
            res.writeHead(200).end('{"ok":true}');
          }
          return;
        case '/gone':
          res.writeHead(410).end();
          return;
        case '/slow-ok':
          setTimeout(() => res.writeHead(200).end('{"ok":true}'), 800);
          return;
        default:
          res.writeHead(200).end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });

  const email = `p5b4-rel-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Reliability', email, password: PASSWORD });
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  token = login.body.data.token as string;

  const proj = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Reliability Project' });
  projectId = proj.body.data.project.id as string;
  created.projectIds.push(projectId);

  const key = await request(app)
    .post(`/api/v1/projects/${projectId}/api-keys`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Reliability Key' });
  created.apiKeyIds.push(key.body.data.apiKey.id as string);
  apiKey = key.body.data.plaintextKey as string;

  const et = await request(app)
    .post(`/api/v1/projects/${projectId}/event-types`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'order.created' });
  eventTypeId = et.body.data.eventType.id as string;
  created.eventTypeIds.push(eventTypeId);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  const deliveries = await prisma.delivery.findMany({
    where: { eventId: { in: created.eventIds } },
    select: { id: true },
  });
  const deliveryIds = deliveries.map((d) => d.id);
  await prisma.deliveryAttempt.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
  await prisma.delivery.deleteMany({ where: { id: { in: deliveryIds } } });
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: created.subscriptionIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } });
  await prisma.apiKey.deleteMany({ where: { id: { in: created.apiKeyIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

/** Endpoint + subscription straight in the DB (local mock URL). */
async function wireEndpoint(path: string, maxAttempts?: number): Promise<string> {
  const endpoint = await prisma.endpoint.create({
    data: {
      projectId,
      url: `http://127.0.0.1:${port}${path}`,
      signingSecret: encryptSecret(SIGNING_SECRET),
      maxAttempts: maxAttempts ?? null,
    },
  });
  created.endpointIds.push(endpoint.id);
  const sub = await prisma.subscription.create({
    data: { projectId, endpointId: endpoint.id, eventTypeId },
  });
  created.subscriptionIds.push(sub.id);
  return endpoint.id;
}

async function unwireEndpoint(endpointId: string): Promise<void> {
  await prisma.subscription.deleteMany({
    where: { id: { in: created.subscriptionIds }, endpointId },
  });
}

async function ingest(payload: object): Promise<{ eventId: string; deliveriesCreated: number }> {
  const res = await request(app)
    .post('/api/v1/events')
    .set('X-API-Key', apiKey)
    .set('Idempotency-Key', `idem-${randomUUID()}`)
    .send({ eventType: 'order.created', payload });
  expect(res.status).toBe(202);
  created.eventIds.push(res.body.data.event.id as string);
  return {
    eventId: res.body.data.event.id as string,
    deliveriesCreated: res.body.data.deliveriesCreated as number,
  };
}

async function forceDue(deliveryId: string): Promise<void> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { nextAttemptAt: new Date(Date.now() - 86_400_000) },
  });
}

const deliveryOf = async (eventId: string) =>
  (await prisma.delivery.findFirst({ where: { eventId }, include: { attempts: true } }))!;

describe('complete lifecycle', () => {
  it('ingest → fan-out → claim → deliver (steps 1–4, no lost events, no partial fan-out)', async () => {
    const endpointId = await wireEndpoint('/ok');
    const { eventId, deliveriesCreated } = await ingest({ step: '1-4' });
    expect(deliveriesCreated).toBe(1); // full fan-out, atomically with the event

    let delivery = await deliveryOf(eventId);
    expect(delivery.status).toBe('pending');
    await forceDue(delivery.id);

    const tick = await createWorker({ batchSize: 1, leaseMs: 60_000 }).runTick();
    expect(tick.outcomes[delivery.id]).toBe('succeeded');

    delivery = await deliveryOf(eventId);
    expect(delivery.status).toBe('succeeded');
    expect(delivery.attempts).toHaveLength(1);
    expect(seenDeliveryIds.get(delivery.id)).toBe(1);
    await unwireEndpoint(endpointId);
  });

  it('retryable failure → automatic retry → dead-letter → MANUAL retry → success (steps 5–10)', async () => {
    const endpointId = await wireEndpoint('/flaky', 2); // snapshot budget: 2
    flakyRemainingFailures = 99; // fail for now

    const { eventId } = await ingest({ step: '5-10' });
    const deliveryId = (await deliveryOf(eventId)).id;

    // attempt 1: 500 → retrying (pending, backoff scheduled)
    await forceDue(deliveryId);
    let tick = await createWorker({ batchSize: 1 }).runTick();
    expect(tick.outcomes[deliveryId]).toBe('retrying');
    let row = await deliveryOf(eventId);
    expect(row.status).toBe('pending');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(row.updatedAt.getTime()); // backoff

    // attempt 2 (= max): 500 → dead_lettered
    await forceDue(deliveryId);
    tick = await createWorker({ batchSize: 1 }).runTick();
    expect(tick.outcomes[deliveryId]).toBe('dead_lettered');
    row = await deliveryOf(eventId);
    expect(row.status).toBe('dead_lettered');
    expect(row.attempts).toHaveLength(2);

    // manual retry via the API: +1 attempt, due now
    flakyRemainingFailures = 0; // receiver is healthy again
    const retryRes = await request(app)
      .post(`/api/v1/projects/${projectId}/deliveries/${deliveryId}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.data.delivery.maxAttempts).toBe(3);

    // the granted attempt succeeds
    tick = await createWorker({ batchSize: 1 }).runTick();
    expect(tick.outcomes[deliveryId]).toBe('succeeded');
    row = await deliveryOf(eventId);
    expect(row.status).toBe('succeeded');
    expect(row.attempts.map((a) => a.attemptNumber).sort()).toEqual([1, 2, 3]); // full history
    await unwireEndpoint(endpointId);
  });

  it('permanent failure short-circuits; manual retry hits the same wall honestly', async () => {
    const endpointId = await wireEndpoint('/gone', 3);
    const { eventId } = await ingest({ step: 'permanent' });
    const deliveryId = (await deliveryOf(eventId)).id;

    await forceDue(deliveryId);
    const tick = await createWorker({ batchSize: 1 }).runTick();
    expect(tick.outcomes[deliveryId]).toBe('failed'); // 410 → permanent

    const retryRes = await request(app)
      .post(`/api/v1/projects/${projectId}/deliveries/${deliveryId}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(retryRes.status).toBe(200);

    const tick2 = await createWorker({ batchSize: 1 }).runTick();
    expect(tick2.outcomes[deliveryId]).toBe('failed'); // still 410

    const row = await deliveryOf(eventId);
    expect(row.attempts).toHaveLength(2);
    expect(row.attempts.every((a) => a.outcome === 'failed_permanent')).toBe(true);
    await unwireEndpoint(endpointId);
  });
});

describe('concurrency and crash behavior', () => {
  it('multiple concurrent workers drain the queue with no duplicates and no losses', async () => {
    const endpointId = await wireEndpoint('/ok');
    const eventIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      eventIds.push((await ingest({ n: i })).eventId);
    }
    const deliveries = await prisma.delivery.findMany({ where: { eventId: { in: eventIds } } });
    expect(deliveries).toHaveLength(6); // no partial fan-out
    await Promise.all(deliveries.map((d) => forceDue(d.id)));

    const [tickA, tickB] = await Promise.all([
      createWorker({ batchSize: 3 }).runTick(),
      createWorker({ batchSize: 3 }).runTick(),
    ]);

    const claimedIds = [...tickA.claimed, ...tickB.claimed].map((c) => c.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // zero overlap
    const rows = await prisma.delivery.findMany({
      where: { eventId: { in: eventIds } },
      include: { attempts: true },
    });
    expect(rows.every((r) => r.status === 'succeeded')).toBe(true); // none lost
    expect(rows.every((r) => r.attempts.length === 1)).toBe(true); // exactly once each here
    await unwireEndpoint(endpointId);
  });

  it('lease expiry mid-flight: duplicate HTTP is possible, bookkeeping is exactly-once, receiver dedupes by stable id', async () => {
    const endpointId = await wireEndpoint('/slow-ok'); // 800 ms responder
    const { eventId } = await ingest({ dup: true });
    const deliveryId = (await deliveryOf(eventId)).id;
    await forceDue(deliveryId);

    // Worker A claims with a tiny lease and will be slow; B reclaims and races.
    const [claimA] = await claimDueDeliveries('worker-A', 1, 150);
    expect(claimA?.id).toBe(deliveryId);
    await sleep(600); // A's lease is gone (presumed dead — but it is alive)
    const [claimB] = await claimDueDeliveries('worker-B', 1, 60_000);
    expect(claimB?.id).toBe(deliveryId);

    const [outcomeA, outcomeB] = await Promise.all([
      executeClaimedDelivery(claimA!),
      executeClaimedDelivery(claimB!),
    ]);

    // At-least-once: the destination saw the SAME delivery id twice…
    expect(seenDeliveryIds.get(deliveryId)).toBe(2);
    // …which is exactly what receiver-side dedupe keys on (NFR-07/27).

    // Exactly-once bookkeeping: B holds the current token and records; A is fenced.
    expect(outcomeB).toBe('succeeded');
    expect(outcomeA).toBe('stale');
    const row = await deliveryOf(eventId);
    expect(row.status).toBe('succeeded');
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]!.attemptNumber).toBe(2); // attempt 1 = A's fenced gap
    await unwireEndpoint(endpointId);
  });

  it('endpoint deactivation and project deletion during processing cancel at the pre-send gate', async () => {
    // -- endpoint deactivated while a claim is in flight
    const endpointId = await wireEndpoint('/ok');
    const { eventId } = await ingest({ gate: 'endpoint' });
    const deliveryId = (await deliveryOf(eventId)).id;
    await forceDue(deliveryId);
    const [claim] = await claimDueDeliveries('worker-gate', 1, 60_000);
    expect(claim?.id).toBe(deliveryId);

    await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints/${endpointId}/deactivate`)
      .set('Authorization', `Bearer ${token}`);

    expect(await executeClaimedDelivery(claim!)).toBe('cancelled');
    const row = await deliveryOf(eventId);
    expect(row.status).toBe('cancelled');
    expect(row.attempts).toHaveLength(0); // no HTTP was sent
    await unwireEndpoint(endpointId);

    // -- project deleted while a claim is in flight (separate project)
    const proj2 = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Doomed Reliability Project' });
    const project2 = proj2.body.data.project.id as string;
    created.projectIds.push(project2);
    const et2 = await prisma.eventType.create({ data: { projectId: project2, name: 'doom.ev' } });
    created.eventTypeIds.push(et2.id);
    const ep2 = await prisma.endpoint.create({
      data: {
        projectId: project2,
        url: `http://127.0.0.1:${port}/ok`,
        signingSecret: encryptSecret(SIGNING_SECRET),
      },
    });
    created.endpointIds.push(ep2.id);
    const ev2 = await prisma.event.create({
      data: {
        projectId: project2,
        eventTypeId: et2.id,
        payload: { doomed: true },
        payloadHash: randomBytes(32).toString('hex'),
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    created.eventIds.push(ev2.id);
    const d2 = await prisma.delivery.create({
      data: {
        projectId: project2,
        eventId: ev2.id,
        endpointId: ep2.id,
        maxAttempts: 3,
        nextAttemptAt: new Date(Date.now() - 86_400_000),
      },
    });

    const [claim2] = await claimDueDeliveries('worker-doom', 1, 60_000);
    expect(claim2?.id).toBe(d2.id);

    const del = await request(app)
      .delete(`/api/v1/projects/${project2}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200); // cascade: keys revoked, endpoints deactivated

    expect(await executeClaimedDelivery(claim2!)).toBe('cancelled');
    const row2 = await prisma.delivery.findUnique({ where: { id: d2.id } });
    expect(row2?.status).toBe('cancelled');
  });
});
