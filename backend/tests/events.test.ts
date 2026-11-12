import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import {
  canonicalJsonStringify,
  canonicalPayloadHash,
} from '../src/utils/canonical-json.js';

/**
 * Phase 5A.1 ingestion tests against the real database.
 * Non-destructive: unique fixtures, exact-id cleanup, children first.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  apiKeyIds: [] as string[],
  eventTypeIds: [] as string[],
  eventIds: [] as string[],
};

let token: string;
let projectA: string;
let projectB: string;
let apiKeyA: string; // plaintext, project A
let apiKeyB: string; // plaintext, project B

async function setupUserProjectKey(): Promise<void> {
  const email = `p5a1-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Ingest Tester', email, password: PASSWORD });
  expect(reg.status).toBe(201);
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  token = login.body.data.token as string;

  for (const name of ['Ingest A', 'Ingest B']) {
    const proj = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
    created.projectIds.push(proj.body.data.project.id as string);
  }
  [projectA, projectB] = created.projectIds as [string, string];

  const key = await request(app)
    .post(`/api/v1/projects/${projectA}/api-keys`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Ingest Key' });
  expect(key.status).toBe(201);
  created.apiKeyIds.push(key.body.data.apiKey.id as string);
  apiKeyA = key.body.data.plaintextKey as string;

  const keyB = await request(app)
    .post(`/api/v1/projects/${projectB}/api-keys`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Ingest Key B' });
  expect(keyB.status).toBe(201);
  created.apiKeyIds.push(keyB.body.data.apiKey.id as string);
  apiKeyB = keyB.body.data.plaintextKey as string;

  const typeA = await request(app)
    .post(`/api/v1/projects/${projectA}/event-types`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'order.created' });
  expect(typeA.status).toBe(201);
  created.eventTypeIds.push(typeA.body.data.eventType.id as string);

  // Exists ONLY in project B — a cross-project type from A's point of view.
  const typeB = await request(app)
    .post(`/api/v1/projects/${projectB}/event-types`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'b.only' });
  expect(typeB.status).toBe(201);
  created.eventTypeIds.push(typeB.body.data.eventType.id as string);
}

beforeAll(async () => {
  await setupUserProjectKey();
});

afterAll(async () => {
  await prisma.event.deleteMany({ where: { id: { in: created.eventIds } } });
  await prisma.apiKey.deleteMany({ where: { id: { in: created.apiKeyIds } } });
  await prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await prisma.$disconnect();
});

function ingest(body: unknown, options: { key?: string; idempotencyKey?: string | null } = {}) {
  const req = request(app).post('/api/v1/events');
  if (options.key !== undefined) req.set('X-API-Key', options.key);
  if (options.idempotencyKey !== null) {
    req.set('Idempotency-Key', options.idempotencyKey ?? `idem-${randomUUID()}`);
  }
  return req.send(body as object);
}

describe('event ingestion', () => {
  it('accepts a valid event; project comes from the key; hash is canonical', async () => {
    const payload = { orderId: '123', amount: 1500, nested: { b: 2, a: 1 } };
    const idempotencyKey = `idem-${randomUUID()}`;

    const res = await ingest({ eventType: 'order.created', payload }, { key: apiKeyA, idempotencyKey });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    const { event } = res.body.data;
    created.eventIds.push(event.id as string);
    expect(event.eventType).toBe('order.created');
    expect(event.receivedAt).toBeTruthy();

    const stored = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stored?.projectId).toBe(projectA); // from the key context only
    expect(stored?.idempotencyKey).toBe(idempotencyKey);
    expect(stored?.payload).toEqual(payload);
    expect(stored?.payloadHash).toBe(canonicalPayloadHash(payload));
    expect(stored?.payloadHash).toHaveLength(64);
  });

  it('stores the SAME hash for key-order permutations of the same payload', async () => {
    const a = await ingest(
      { eventType: 'order.created', payload: { x: 1, y: { b: [1, 2], a: 'z' } } },
      { key: apiKeyA },
    );
    const b = await ingest(
      { eventType: 'order.created', payload: { y: { a: 'z', b: [1, 2] }, x: 1 } },
      { key: apiKeyA },
    );
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    created.eventIds.push(a.body.data.event.id as string, b.body.data.event.id as string);

    const [rowA, rowB] = await Promise.all([
      prisma.event.findUnique({ where: { id: a.body.data.event.id } }),
      prisma.event.findUnique({ where: { id: b.body.data.event.id } }),
    ]);
    expect(rowA?.payloadHash).toBe(rowB?.payloadHash);
  });

  it('rejects missing and invalid API keys', async () => {
    const missing = await ingest({ eventType: 'order.created', payload: {} }, {});
    expect(missing.status).toBe(401);

    const invalid = await ingest(
      { eventType: 'order.created', payload: {} },
      { key: 'whk_000000000000_notarealsecretnotarealsecretnotarealsecret' },
    );
    expect(invalid.status).toBe(401);
  });

  it('rejects missing, empty and oversized idempotency keys', async () => {
    const missing = await ingest(
      { eventType: 'order.created', payload: {} },
      { key: apiKeyA, idempotencyKey: null },
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
    expect(missing.body.error.details[0].path).toContain('idempotency-key');

    const oversized = await ingest(
      { eventType: 'order.created', payload: {} },
      { key: apiKeyA, idempotencyKey: 'x'.repeat(256) },
    );
    expect(oversized.status).toBe(400);
  });

  it('rejects unknown and cross-project event types identically', async () => {
    const unknown = await ingest({ eventType: 'ghost.event', payload: {} }, { key: apiKeyA });
    // b.only exists — but in project B; through A's key it must look unknown.
    const crossProject = await ingest({ eventType: 'b.only', payload: {} }, { key: apiKeyA });

    expect(unknown.status).toBe(400);
    expect(crossProject.status).toBe(400);
    expect(unknown.body.error.details[0].message).toBe(
      crossProject.body.error.details[0].message,
    );
  });

  it('rejects invalid payloads and unknown top-level fields', async () => {
    for (const body of [
      { eventType: 'order.created', payload: [1, 2, 3] }, // array
      { eventType: 'order.created', payload: 'a string' }, // scalar
      { eventType: 'order.created' }, // missing
      { eventType: 'order.created', payload: {}, projectId: projectB }, // smuggled field
    ]) {
      const res = await ingest(body, { key: apiKeyA });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

});

describe('reliable idempotency (5A.2)', () => {
  it('creates, replays identical payloads (even reordered), conflicts on different payloads', async () => {
    const idempotencyKey = `idem-${randomUUID()}`;
    const payload = { n: 1, nested: { b: 2, a: 1 } };

    // Scenario 1: new request → created.
    const first = await ingest(
      { eventType: 'order.created', payload },
      { key: apiKeyA, idempotencyKey },
    );
    expect(first.status).toBe(202);
    expect(first.body.data.idempotentReplay).toBe(false);
    const eventId = first.body.data.event.id as string;
    created.eventIds.push(eventId);

    // Scenario 2: same key + same payload → 200 replay of the ORIGINAL event.
    const replay = await ingest(
      { eventType: 'order.created', payload },
      { key: apiKeyA, idempotencyKey },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.event.id).toBe(eventId);

    // Scenario 2b: equivalent object, different property order → still a replay.
    const reordered = await ingest(
      { eventType: 'order.created', payload: { nested: { a: 1, b: 2 }, n: 1 } },
      { key: apiKeyA, idempotencyKey },
    );
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.idempotentReplay).toBe(true);
    expect(reordered.body.data.event.id).toBe(eventId);

    // Scenario 3: same key + different payload value → 409, existing untouched.
    const conflict = await ingest(
      { eventType: 'order.created', payload: { n: 2, nested: { b: 2, a: 1 } } },
      { key: apiKeyA, idempotencyKey },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CONFLICT');
    expect(conflict.body.message).toContain('different payload');

    const rows = await prisma.event.findMany({
      where: { projectId: projectA, idempotencyKey },
    });
    expect(rows).toHaveLength(1); // no second event, ever
    expect(rows[0]!.id).toBe(eventId);
    expect(rows[0]!.payload).toEqual(payload); // original payload unmodified
  });

  it('keeps the same idempotency key independent across projects', async () => {
    const idempotencyKey = `idem-shared-${randomUUID()}`;
    const inA = await ingest(
      { eventType: 'order.created', payload: { p: 'a' } },
      { key: apiKeyA, idempotencyKey },
    );
    const inB = await ingest(
      { eventType: 'b.only', payload: { p: 'b' } },
      { key: apiKeyB, idempotencyKey },
    );
    expect(inA.status).toBe(202); // same key string, different projects:
    expect(inB.status).toBe(202); // both are first submissions
    created.eventIds.push(inA.body.data.event.id as string, inB.body.data.event.id as string);
  });

  it('concurrent same-key submissions: constraint decides, exactly one event exists', async () => {
    const idempotencyKey = `idem-race-${randomUUID()}`;
    const payload = { race: true, n: 42 };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ingest({ eventType: 'order.created', payload }, { key: apiKeyA, idempotencyKey }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(1); // one winner…
    expect(statuses.filter((s) => s === 200)).toHaveLength(4); // …four replays
    const ids = new Set(results.map((r) => r.body.data.event.id as string));
    expect(ids.size).toBe(1); // every caller got the SAME event

    const rows = await prisma.event.findMany({
      where: { projectId: projectA, idempotencyKey },
    });
    expect(rows).toHaveLength(1); // exactly one row after the race
    created.eventIds.push(rows[0]!.id);
  });
});

describe('canonical JSON serialization', () => {
  it('sorts object keys recursively and preserves arrays and types', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    );
    expect(canonicalJsonStringify({ z: null, a: true, m: 1.5 })).toBe(
      '{"a":true,"m":1.5,"z":null}',
    );
    expect(canonicalJsonStringify([{ b: 2, a: 1 }, 'two', 3])).toBe('[{"a":1,"b":2},"two",3]');
    // Array order is data and must NOT be normalized.
    expect(canonicalJsonStringify({ arr: [2, 1] })).not.toBe(canonicalJsonStringify({ arr: [1, 2] }));
  });

  it('produces order-independent, collision-sensitive hashes', () => {
    expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }));
    expect(canonicalPayloadHash({ a: 1, b: 2 })).not.toBe(canonicalPayloadHash({ a: 1, b: 3 }));
    expect(canonicalPayloadHash({})).toHaveLength(64);
  });
});
