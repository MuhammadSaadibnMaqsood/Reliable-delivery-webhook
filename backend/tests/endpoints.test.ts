import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { runCleanup } from './cleanup-helper.js';
import { decryptSecret, parseEncryptionKey } from '../src/utils/crypto.js';
import { validateDestinationUrl } from '../src/utils/destination-url.js';

/**
 * Phase 4B endpoint tests against the real database.
 * Non-destructive: unique fixtures, exact-id cleanup, children first.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';
const VALID_URL = 'https://example.com/hooks/receiver';
const SECRET_FORMAT = /^whsec_[A-Za-z0-9_-]{43}$/;
const ENDPOINT_FIELDS = [
  'createdAt',
  'description',
  'id',
  'isActive',
  'maxAttempts',
  'timeoutMs',
  'updatedAt',
  'url',
].sort();

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  endpointIds: [] as string[],
  eventTypeIds: [] as string[],
  eventIds: [] as string[],
  deliveryIds: [] as string[],
  attemptIds: [] as string[],
};

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `p4b-ep-${tag}-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `Ep ${tag}`, email, password: PASSWORD });
  expect(reg.status).toBe(201);
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.data.token as string, userId: reg.body.data.user.id as string };
}

let alice: { token: string; userId: string };
let bob: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  const proj = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${alice.token}`)
    .send({ name: 'Endpoint Project' });
  projectId = proj.body.data.project.id as string;
  created.projectIds.push(projectId);
});

afterAll(() =>
  runCleanup('endpoints', [
    ['attempts', () => prisma.deliveryAttempt.deleteMany({ where: { id: { in: created.attemptIds } } })],
    ['deliveries', () => prisma.delivery.deleteMany({ where: { id: { in: created.deliveryIds } } })],
    ['events', () => prisma.event.deleteMany({ where: { id: { in: created.eventIds } } })],
    ['endpoints', () => prisma.endpoint.deleteMany({ where: { id: { in: created.endpointIds } } })],
    ['eventTypes', () => prisma.eventType.deleteMany({ where: { id: { in: created.eventTypeIds } } })],
    ['projects', () => prisma.project.deleteMany({ where: { id: { in: created.projectIds } } })],
    ['users', () => prisma.user.deleteMany({ where: { id: { in: created.userIds } } })],
  ]),
);

async function registerEndpoint(url = VALID_URL): Promise<{ id: string; secret: string }> {
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/endpoints`)
    .set('Authorization', `Bearer ${alice.token}`)
    .send({ url });
  expect(res.status).toBe(201);
  const id = res.body.data.endpoint.id as string;
  created.endpointIds.push(id);
  return { id, secret: res.body.data.signingSecret as string };
}

describe('endpoint registration & secret handling', () => {
  it('registers an endpoint, returns the signing secret once, stores it encrypted', async () => {
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ url: VALID_URL, description: 'Primary receiver', timeoutMs: 5000, maxAttempts: 5 });

    expect(res.status).toBe(201);
    const { endpoint, signingSecret } = res.body.data;
    created.endpointIds.push(endpoint.id as string);

    expect(signingSecret).toMatch(SECRET_FORMAT);
    expect(endpoint.isActive).toBe(true);
    expect(endpoint.timeoutMs).toBe(5000);
    expect(endpoint.maxAttempts).toBe(5);
    expect(Object.keys(endpoint).sort()).toEqual(ENDPOINT_FIELDS); // no signingSecret field

    const stored = await prisma.endpoint.findUnique({ where: { id: endpoint.id } });
    expect(stored?.signingSecret.startsWith('v1:')).toBe(true); // encrypted format
    expect(stored?.signingSecret).not.toBe(signingSecret); // ciphertext ≠ plaintext
    expect(stored?.signingSecret).not.toContain(signingSecret.slice(6)); // no plaintext embedded
    expect(decryptSecret(stored!.signingSecret)).toBe(signingSecret); // roundtrip works
  });

  it('never exposes secrets in list or detail responses', async () => {
    const { id } = await registerEndpoint();

    const list = await request(app)
      .get(`/api/v1/projects/${projectId}/endpoints`)
      .set('Authorization', `Bearer ${alice.token}`);
    const detail = await request(app)
      .get(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${alice.token}`);

    for (const res of [list, detail]) {
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('whsec_');
      expect(serialized).not.toContain('signingSecret');
      expect(serialized).not.toContain('"v1:');
    }
    expect(Object.keys(detail.body.data.endpoint).sort()).toEqual(ENDPOINT_FIELDS);

    // Foreign access: indistinguishable 404s.
    const foreignList = await request(app)
      .get(`/api/v1/projects/${projectId}/endpoints`)
      .set('Authorization', `Bearer ${bob.token}`);
    const foreignDetail = await request(app)
      .get(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(foreignList.status).toBe(404);
    expect(foreignDetail.status).toBe(404);
  });
});

describe('SSRF protection', () => {
  it.each([
    ['http (not https)', 'http://example.com/hook'],
    ['not a URL', 'not-a-url-at-all'],
    ['localhost', 'https://localhost/hook'],
    ['.localhost suffix', 'https://evil.localhost/hook'],
    ['IPv4 loopback', 'https://127.0.0.1/hook'],
    ['private 10/8', 'https://10.1.2.3/hook'],
    ['private 192.168/16', 'https://192.168.1.10/hook'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/hook'],
    ['cloud metadata (link-local)', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv6 unique-local', 'https://[fd00::1]/hook'],
    ['embedded credentials', 'https://user:pass@example.com/hook'],
  ])('rejects %s', async (_label, url) => {
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ url });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('body.url');
  });

  it('DNS resolution inspects returned addresses (IPv4/IPv6) and crypto config fails safely', async () => {
    // localtest.me publicly resolves to 127.0.0.1 — hostname looks fine,
    // resolved address is loopback → rejected. (A failed resolution is also
    // a rejection, so this assertion is network-robust.)
    const rebindish = await validateDestinationUrl('https://localtest.me/hook');
    expect(rebindish.valid).toBe(false);

    // Public hostname passes and reports every resolved address.
    const ok = await validateDestinationUrl('https://example.com/hook');
    expect(ok.valid).toBe(true);
    if (ok.valid) expect(ok.addresses.length).toBeGreaterThanOrEqual(1);

    // Invalid encryption keys throw — never a silent fallback to plaintext.
    expect(() => parseEncryptionKey('not-hex-at-all')).toThrow();
    expect(() => parseEncryptionKey('abcd1234')).toThrow();
    expect(() => parseEncryptionKey(randomBytes(16).toString('hex'))).toThrow(); // 32 hex ≠ 64 hex
  });
});

describe('endpoint update', () => {
  it('updates config, revalidates URLs, blocks protected fields and empty updates', async () => {
    const { id } = await registerEndpoint();

    const ok = await request(app)
      .patch(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ description: 'Updated', timeoutMs: 8000, maxAttempts: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.endpoint).toMatchObject({
      description: 'Updated',
      timeoutMs: 8000,
      maxAttempts: 3,
    });

    const clearOverride = await request(app)
      .patch(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ timeoutMs: null });
    expect(clearOverride.status).toBe(200);
    expect(clearOverride.body.data.endpoint.timeoutMs).toBeNull();

    const newUrl = await request(app)
      .patch(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ url: 'https://example.org/hooks/new' });
    expect(newUrl.status).toBe(200);

    const badUrl = await request(app)
      .patch(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ url: 'http://example.com/downgrade' });
    expect(badUrl.status).toBe(400);

    const empty = await request(app)
      .patch(`/api/v1/projects/${projectId}/endpoints/${id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({});
    expect(empty.status).toBe(400);

    for (const protectedBody of [{ isActive: false }, { signingSecret: 'x' }, { deletedAt: null }]) {
      const res = await request(app)
        .patch(`/api/v1/projects/${projectId}/endpoints/${id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send(protectedBody);
      expect(res.status).toBe(400); // strict schema: unknown/protected keys rejected
    }
  });
});

describe('activation, deactivation and deletion vs deliveries', () => {
  it('deactivation cancels pending only; activation never restores; deletion is soft and final', async () => {
    const { id: endpointId } = await registerEndpoint();

    const eventType = await prisma.eventType.create({
      data: { projectId, name: `lifecycle.${randomUUID().slice(0, 8)}` },
    });
    created.eventTypeIds.push(eventType.id);

    const makeEvent = async () => {
      const event = await prisma.event.create({
        data: {
          projectId,
          eventTypeId: eventType.id,
          payload: { t: 1 },
          payloadHash: randomBytes(32).toString('hex'),
          idempotencyKey: `idem-${randomUUID()}`,
        },
      });
      created.eventIds.push(event.id);
      return event;
    };

    const [e1, e2] = [await makeEvent(), await makeEvent()];
    const pending = await prisma.delivery.create({
      data: { projectId, eventId: e1.id, endpointId, maxAttempts: 3 },
    });
    const processing = await prisma.delivery.create({
      data: {
        projectId,
        eventId: e2.id,
        endpointId,
        maxAttempts: 3,
        status: 'processing',
        attemptCount: 1,
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    created.deliveryIds.push(pending.id, processing.id);
    const attempt = await prisma.deliveryAttempt.create({
      data: {
        deliveryId: processing.id,
        attemptNumber: 1,
        outcome: 'failed_retryable',
        responseStatus: 503,
        requestUrl: VALID_URL,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    created.attemptIds.push(attempt.id);

    // --- deactivate ---
    const deact = await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints/${endpointId}/deactivate`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(deact.status).toBe(200);
    expect(deact.body.data.pendingDeliveriesCancelled).toBe(1);
    expect(deact.body.data.endpoint.isActive).toBe(false);

    const d1 = await prisma.delivery.findUnique({ where: { id: pending.id } });
    const d2 = await prisma.delivery.findUnique({ where: { id: processing.id } });
    expect(d1?.status).toBe('cancelled');
    expect(d1?.completedAt).not.toBeNull();
    expect(d1?.lastError).toBe('cancelled: endpoint deactivated');
    expect(d2?.status).toBe('processing'); // in-flight untouched
    expect(d2?.claimToken).not.toBeNull();

    // --- activate again: state flips back, cancelled deliveries stay cancelled ---
    const act = await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints/${endpointId}/activate`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(act.status).toBe(200);
    expect(act.body.data.endpoint.isActive).toBe(true);
    expect((await prisma.delivery.findUnique({ where: { id: pending.id } }))?.status).toBe(
      'cancelled',
    );

    // --- soft delete with a fresh pending delivery ---
    const e3 = await makeEvent();
    const pending2 = await prisma.delivery.create({
      data: { projectId, eventId: e3.id, endpointId, maxAttempts: 3 },
    });
    created.deliveryIds.push(pending2.id);

    const del = await request(app)
      .delete(`/api/v1/projects/${projectId}/endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(del.status).toBe(200);
    expect(del.body.data.summary.pendingDeliveriesCancelled).toBe(1);

    const endpointRow = await prisma.endpoint.findUnique({ where: { id: endpointId } });
    expect(endpointRow?.deletedAt).not.toBeNull();
    expect(endpointRow?.isActive).toBe(false);

    const d3 = await prisma.delivery.findUnique({ where: { id: pending2.id } });
    expect(d3?.status).toBe('cancelled');
    expect(d3?.lastError).toBe('cancelled: endpoint deleted');

    // History preserved: processing delivery, its attempt, all events.
    expect((await prisma.delivery.findUnique({ where: { id: processing.id } }))?.status).toBe(
      'processing',
    );
    expect(await prisma.deliveryAttempt.findUnique({ where: { id: attempt.id } })).not.toBeNull();
    expect(await prisma.event.count({ where: { projectId } })).toBe(3);

    // Gone from the API; activation can never resurrect it.
    const detail = await request(app)
      .get(`/api/v1/projects/${projectId}/endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(detail.status).toBe(404);

    const revive = await request(app)
      .post(`/api/v1/projects/${projectId}/endpoints/${endpointId}/activate`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(revive.status).toBe(404);
    expect((await prisma.endpoint.findUnique({ where: { id: endpointId } }))?.isActive).toBe(false);
  });
});
