import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { runCleanup } from './cleanup-helper.js';

/**
 * Project management integration tests against the real database.
 * Non-destructive by construction: every row is created here, its id is
 * recorded in `created`, and afterAll removes EXACTLY those ids in FK-safe
 * order. No filter-based deletes — nothing outside these fixtures can be
 * touched.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  eventTypeIds: [] as string[],
  endpointIds: [] as string[],
  apiKeyIds: [] as string[],
  eventIds: [] as string[],
  deliveryIds: [] as string[],
  attemptIds: [] as string[],
};

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `p3-proj-${tag}-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `Proj ${tag}`, email, password: PASSWORD });
  expect(reg.status).toBe(201);
  const userId = reg.body.data.user.id as string;
  created.userIds.push(userId);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { token: login.body.data.token as string, userId };
}

let alice: { token: string; userId: string };
let bob: { token: string; userId: string };

beforeAll(async () => {
  alice = await makeUser('alice');
  bob = await makeUser('bob');
});

afterAll(() =>
  // Exact-id cleanup of this run's fixtures, children before parents.
  runCleanup('projects', [
    ['attempts', () => prisma.deliveryAttempt.deleteMany({ where: { id: { in: created.attemptIds } } })],
    ['deliveries', () => prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } })],
    ['events', () => prisma.event.deleteMany({ where: { id: { in: created.eventIds } } })],
    ['endpoints', () => prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } })],
    ['apiKeys', () => prisma.apiKey.deleteMany({ where: { id: { in: created.apiKeyIds } } })],
    ['eventTypes', () => prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } })],
    ['projects', () => prisma.project.deleteMany({ where: { id: { in: created.projectIds } } })],
    ['users', () => prisma.user.deleteMany({ where: { id: { in: created.userIds } } })],
  ]),
);

async function createProject(token: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, description: `${name} description` });
  expect(res.status).toBe(201);
  const id = res.body.data.project.id as string;
  created.projectIds.push(id);
  return id;
}

describe('project CRUD', () => {
  it('creates a project for the authenticated user', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Alpha', description: 'First project' });

    expect(res.status).toBe(201);
    expect(res.body.data.project).toMatchObject({ name: 'Alpha', description: 'First project' });
    created.projectIds.push(res.body.data.project.id as string);

    const stored = await prisma.project.findUnique({ where: { id: res.body.data.project.id } });
    expect(stored?.userId).toBe(alice.userId);
  });

  it('lists only the owner’s projects with pagination metadata', async () => {
    await createProject(alice.token, 'Beta');
    await createProject(bob.token, 'Bob Secret');

    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    const names = res.body.data.items.map((p: { name: string }) => p.name);
    expect(names).toContain('Alpha');
    expect(names).not.toContain('Bob Secret');
    expect(res.body.data.pagination).toMatchObject({ page: 1, pageSize: 20 });
    expect(res.body.data.pagination.totalItems).toBeGreaterThanOrEqual(2);

    const paged = await request(app)
      .get('/api/v1/projects?page=1&pageSize=1')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.pagination.totalPages).toBeGreaterThanOrEqual(2);
  });

  it('gets a project by id; cross-user access is an indistinguishable 404', async () => {
    const projectId = await createProject(alice.token, 'Gamma');

    const own = await request(app)
      .get(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(own.status).toBe(200);

    const foreignGet = await request(app)
      .get(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    const foreignPatch = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'Hijacked' });
    const foreignDelete = await request(app)
      .delete(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`);

    expect(foreignGet.status).toBe(404);
    expect(foreignPatch.status).toBe(404);
    expect(foreignDelete.status).toBe(404);

    const intact = await prisma.project.findUnique({ where: { id: projectId } });
    expect(intact?.name).toBe('Gamma');
    expect(intact?.deletedAt).toBeNull();
  });

  it('updates name/description; rejects empty and protected-field updates', async () => {
    const projectId = await createProject(alice.token, 'Delta');

    const ok = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Delta v2', description: null });
    expect(ok.status).toBe(200);
    expect(ok.body.data.project.name).toBe('Delta v2');
    expect(ok.body.data.project.description).toBeNull();

    const empty = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const protectedField = await request(app)
      .patch(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: bob.userId, deletedAt: new Date().toISOString() });
    expect(protectedField.status).toBe(400);

    const malformedId = await request(app)
      .get('/api/v1/projects/not-a-uuid')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(malformedId.status).toBe(400);
  });
});

describe('project soft deletion (approved cascade)', () => {
  it('soft-deletes, revokes keys, deactivates endpoints, cancels ONLY pending deliveries, preserves history', async () => {
    const projectId = await createProject(alice.token, 'Doomed');

    // --- fixtures built directly against the schema (composite-FK scalars) ---
    const eventType = await prisma.eventType.create({ data: { projectId, name: 'order.paid' } });
    created.eventTypeIds.push(eventType.id);

    const endpoint = await prisma.endpoint.create({
      data: {
        projectId,
        url: 'https://receiver.example.test/hook',
        signingSecret: 'enc:test-secret',
      },
    });
    created.endpointIds.push(endpoint.id);

    const apiKey = await prisma.apiKey.create({
      data: {
        projectId,
        name: 'test key',
        keyPrefix: `whk_${randomBytes(6).toString('hex')}`,
        keyHash: randomBytes(32).toString('hex'),
      },
    });
    created.apiKeyIds.push(apiKey.id);

    const [ev1, ev2, ev3] = await Promise.all(
      [1, 2, 3].map((n) =>
        prisma.event.create({
          data: {
            projectId,
            eventTypeId: eventType.id,
            payload: { n },
            payloadHash: randomBytes(32).toString('hex'),
            idempotencyKey: `idem-${randomUUID()}`,
          },
        }),
      ),
    );
    created.eventIds.push(ev1!.id, ev2!.id, ev3!.id);

    const pendingDelivery = await prisma.delivery.create({
      data: { projectId, eventId: ev1!.id, endpointId: endpoint.id, maxAttempts: 3 },
    });
    const processingDelivery = await prisma.delivery.create({
      data: {
        projectId,
        eventId: ev2!.id,
        endpointId: endpoint.id,
        maxAttempts: 3,
        status: 'processing',
        attemptCount: 1,
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        lockedBy: 'test-worker',
      },
    });
    const succeededDelivery = await prisma.delivery.create({
      data: {
        projectId,
        eventId: ev3!.id,
        endpointId: endpoint.id,
        maxAttempts: 3,
        status: 'succeeded',
        attemptCount: 1,
        completedAt: new Date(),
      },
    });
    created.deliveryIds.push(pendingDelivery.id, processingDelivery.id, succeededDelivery.id);

    const attempt = await prisma.deliveryAttempt.create({
      data: {
        deliveryId: succeededDelivery.id,
        attemptNumber: 1,
        outcome: 'success',
        responseStatus: 200,
        latencyMs: 42,
        requestUrl: 'https://receiver.example.test/hook',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    created.attemptIds.push(attempt.id);

    // --- the cascade ---
    const res = await request(app)
      .delete(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({
      apiKeysRevoked: 1,
      endpointsDeactivated: 1,
      pendingDeliveriesCancelled: 1,
    });

    // --- database truth ---
    const [projectRow, keyRow, endpointRow, d1, d2, d3, attemptRow, eventCount] =
      await Promise.all([
        prisma.project.findUnique({ where: { id: projectId } }),
        prisma.apiKey.findUnique({ where: { id: apiKey.id } }),
        prisma.endpoint.findUnique({ where: { id: endpoint.id } }),
        prisma.delivery.findUnique({ where: { id: pendingDelivery.id } }),
        prisma.delivery.findUnique({ where: { id: processingDelivery.id } }),
        prisma.delivery.findUnique({ where: { id: succeededDelivery.id } }),
        prisma.deliveryAttempt.findUnique({ where: { id: attempt.id } }),
        prisma.event.count({ where: { projectId } }),
      ]);

    expect(projectRow?.deletedAt).not.toBeNull(); // soft-deleted, not gone
    expect(keyRow?.revokedAt).not.toBeNull(); // key revoked
    expect(endpointRow?.isActive).toBe(false); // deactivated…
    expect(endpointRow?.deletedAt).toBeNull(); // …not endpoint-deleted
    expect(d1?.status).toBe('cancelled'); // pending → cancelled
    expect(d1?.completedAt).not.toBeNull();
    expect(d1?.lastError).toBe('cancelled: project deleted');
    expect(d2?.status).toBe('processing'); // in-flight untouched
    expect(d2?.claimToken).not.toBeNull();
    expect(d3?.status).toBe('succeeded'); // terminal history untouched
    expect(attemptRow).not.toBeNull(); // attempts preserved
    expect(eventCount).toBe(3); // events preserved

    // --- API-level invisibility ---
    const gone = await request(app)
      .get(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(gone.status).toBe(404);

    const list = await request(app)
      .get('/api/v1/projects?pageSize=100')
      .set('Authorization', `Bearer ${alice.token}`);
    const ids = list.body.data.items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(projectId);

    // deleting again: already-deleted is indistinguishable from absent
    const again = await request(app)
      .delete(`/api/v1/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(again.status).toBe(404);
  });
});
