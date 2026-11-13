import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { runCleanup } from './cleanup-helper.js';

/**
 * Phase 4B event type + subscription tests against the real database.
 * Non-destructive: unique fixtures, exact-id cleanup, children first.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';
const VALID_URL = 'https://example.com/hooks/subs';

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  endpointIds: [] as string[],
  eventTypeIds: [] as string[],
  subscriptionIds: [] as string[],
  eventIds: [] as string[],
  deliveryIds: [] as string[],
};

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `p4b-sub-${tag}-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `Sub ${tag}`, email, password: PASSWORD });
  expect(reg.status).toBe(201);
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.data.token as string, userId: reg.body.data.user.id as string };
}

async function makeProject(token: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  const id = res.body.data.project.id as string;
  created.projectIds.push(id);
  return id;
}

async function makeEndpoint(token: string, projectId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/endpoints`)
    .set('Authorization', `Bearer ${token}`)
    .send({ url: VALID_URL });
  expect(res.status).toBe(201);
  const id = res.body.data.endpoint.id as string;
  created.endpointIds.push(id);
  return id;
}

async function makeEventType(token: string, projectId: string, name: string): Promise<string> {
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/event-types`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  expect(res.status).toBe(201);
  const id = res.body.data.eventType.id as string;
  created.eventTypeIds.push(id);
  return id;
}

let alice: { token: string; userId: string };
let bob: { token: string; userId: string };
let projectA1: string;
let projectA2: string;
let projectB: string;
let endpointId: string;

beforeAll(async () => {
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  projectA1 = await makeProject(alice.token, 'Subs A1');
  projectA2 = await makeProject(alice.token, 'Subs A2');
  projectB = await makeProject(bob.token, 'Subs B');
  endpointId = await makeEndpoint(alice.token, projectA1);
});

afterAll(() =>
  runCleanup('subscriptions', [
    ['deliveries', () => prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } })],
    ['events', () => prisma.event.deleteMany({ where: { id: { in: created.eventIds } } })],
    ['subscriptions', () => prisma.subscription.deleteMany({ where: { id: { in: created.subscriptionIds } } })],
    ['endpoints', () => prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } })],
    ['eventTypes', () => prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } })],
    ['projects', () => prisma.project.deleteMany({ where: { id: { in: created.projectIds } } })],
    ['users', () => prisma.user.deleteMany({ where: { id: { in: created.userIds } } })],
  ]),
);

describe('event types', () => {
  it('creates, enforces per-project uniqueness, allows same name across projects', async () => {
    const res = await request(app)
      .post(`/api/v1/projects/${projectA1}/event-types`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'order.paid', description: 'Order settled' });
    expect(res.status).toBe(201);
    created.eventTypeIds.push(res.body.data.eventType.id as string);
    expect(res.body.data.eventType.name).toBe('order.paid');

    const dup = await request(app)
      .post(`/api/v1/projects/${projectA1}/event-types`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'order.paid' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const sameNameOtherProject = await request(app)
      .post(`/api/v1/projects/${projectA2}/event-types`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'order.paid' });
    expect(sameNameOtherProject.status).toBe(201);
    created.eventTypeIds.push(sameNameOtherProject.body.data.eventType.id as string);

    const badName = await request(app)
      .post(`/api/v1/projects/${projectA1}/event-types`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Bad Name!!' });
    expect(badName.status).toBe(400);

    const foreign = await request(app)
      .post(`/api/v1/projects/${projectA1}/event-types`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'intruder.event' });
    expect(foreign.status).toBe(404);

    const list = await request(app)
      .get(`/api/v1/projects/${projectA1}/event-types`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(list.status).toBe(200);
    const names = list.body.data.eventTypes.map((t: { name: string }) => t.name);
    expect(names).toContain('order.paid');

    const foreignList = await request(app)
      .get(`/api/v1/projects/${projectA1}/event-types`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(foreignList.status).toBe(404);
  });

  it('deletes unused types; refuses deletion when subscriptions or events reference them', async () => {
    const unused = await makeEventType(alice.token, projectA1, 'temp.unused');
    const delUnused = await request(app)
      .delete(`/api/v1/projects/${projectA1}/event-types/${unused}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(delUnused.status).toBe(200);

    // Referenced by a subscription → 409.
    const subbed = await makeEventType(alice.token, projectA1, 'temp.subscribed');
    const sub = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId: subbed });
    expect(sub.status).toBe(201);
    created.subscriptionIds.push(sub.body.data.subscription.id as string);

    const delSubbed = await request(app)
      .delete(`/api/v1/projects/${projectA1}/event-types/${subbed}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(delSubbed.status).toBe(409);

    // Referenced by a historical event → 409.
    const withEvent = await makeEventType(alice.token, projectA1, 'temp.with-event');
    const event = await prisma.event.create({
      data: {
        projectId: projectA1,
        eventTypeId: withEvent,
        payload: { n: 1 },
        payloadHash: randomBytes(32).toString('hex'),
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    created.eventIds.push(event.id);

    const delWithEvent = await request(app)
      .delete(`/api/v1/projects/${projectA1}/event-types/${withEvent}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(delWithEvent.status).toBe(409);
    expect(await prisma.event.findUnique({ where: { id: event.id } })).not.toBeNull();
  });
});

describe('subscriptions', () => {
  it('subscribes an active endpoint; rejects duplicates, cross-project and dead endpoints', async () => {
    const eventTypeId = await makeEventType(alice.token, projectA1, 'invoice.created');

    const res = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId });
    expect(res.status).toBe(201);
    created.subscriptionIds.push(res.body.data.subscription.id as string);
    expect(res.body.data.subscription.eventType.name).toBe('invoice.created');

    const dup = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId });
    expect(dup.status).toBe(409);

    // Event type from another project (even the same owner) → 404.
    const otherProjectType = await makeEventType(alice.token, projectA2, 'cross.project');
    const cross = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId: otherProjectType });
    expect(cross.status).toBe(404);

    // Bob cannot subscribe anything on Alice's project.
    const foreign = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ eventTypeId });
    expect(foreign.status).toBe(404);

    // Inactive endpoint → 409; soft-deleted endpoint → 404.
    const inactiveEp = await makeEndpoint(alice.token, projectA1);
    await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${inactiveEp}/deactivate`)
      .set('Authorization', `Bearer ${alice.token}`);
    const onInactive = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${inactiveEp}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId });
    expect(onInactive.status).toBe(409);

    const deletedEp = await makeEndpoint(alice.token, projectA1);
    await request(app)
      .delete(`/api/v1/projects/${projectA1}/endpoints/${deletedEp}`)
      .set('Authorization', `Bearer ${alice.token}`);
    const onDeleted = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${deletedEp}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId });
    expect(onDeleted.status).toBe(404);
  });

  it('lists subscriptions with event type details', async () => {
    const list = await request(app)
      .get(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.subscriptions.length).toBeGreaterThanOrEqual(1);
    for (const sub of list.body.data.subscriptions) {
      expect(sub.endpointId).toBe(endpointId);
      expect(sub.eventType.id).toBeTruthy();
      expect(sub.eventType.name).toBeTruthy();
    }
  });

  it('unsubscribes without touching existing deliveries', async () => {
    const eventTypeId = await makeEventType(alice.token, projectA1, 'refund.issued');
    const sub = await request(app)
      .post(`/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ eventTypeId });
    expect(sub.status).toBe(201);
    const subscriptionId = sub.body.data.subscription.id as string;
    created.subscriptionIds.push(subscriptionId);

    // A delivery that exists BEFORE unsubscription (as if fanned out earlier).
    const event = await prisma.event.create({
      data: {
        projectId: projectA1,
        eventTypeId,
        payload: { r: 1 },
        payloadHash: randomBytes(32).toString('hex'),
        idempotencyKey: `idem-${randomUUID()}`,
      },
    });
    created.eventIds.push(event.id);
    const delivery = await prisma.delivery.create({
      data: { projectId: projectA1, eventId: event.id, endpointId, maxAttempts: 3 },
    });
    created.deliveryIds.push(delivery.id);

    // Bob cannot unsubscribe Alice's subscription.
    const foreign = await request(app)
      .delete(
        `/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions/${subscriptionId}`,
      )
      .set('Authorization', `Bearer ${bob.token}`);
    expect(foreign.status).toBe(404);

    const del = await request(app)
      .delete(
        `/api/v1/projects/${projectA1}/endpoints/${endpointId}/subscriptions/${subscriptionId}`,
      )
      .set('Authorization', `Bearer ${alice.token}`);
    expect(del.status).toBe(200);

    // Subscription row gone; the pre-existing delivery is untouched.
    expect(
      await prisma.subscription.findUnique({ where: { id: subscriptionId } }),
    ).toBeNull();
    const survivingDelivery = await prisma.delivery.findUnique({ where: { id: delivery.id } });
    expect(survivingDelivery?.status).toBe('pending');
    expect(survivingDelivery?.completedAt).toBeNull();
  });
});
