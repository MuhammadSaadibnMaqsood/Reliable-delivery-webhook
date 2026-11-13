import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { runCleanup } from './cleanup-helper.js';
import { generateApiKey } from '../src/utils/api-key.js';

/**
 * Phase 4A integration tests against the real database.
 * Non-destructive: every row is created here, tracked by exact id, and
 * removed in afterAll (children before parents). No filter-based deletes.
 */

const app = buildApp();
const PASSWORD = 'correct-horse-battery';
const PLAINTEXT_FORMAT = /^whk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;

const created = {
  userIds: [] as string[],
  projectIds: [] as string[],
  apiKeyIds: [] as string[],
};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `p4a-${tag}-${randomUUID()}@example.test`;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `Key ${tag}`, email, password: PASSWORD });
  expect(reg.status).toBe(201);
  created.userIds.push(reg.body.data.user.id as string);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { token: login.body.data.token as string, userId: reg.body.data.user.id as string };
}

async function makeProject(token: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  expect(res.status).toBe(201);
  const id = res.body.data.project.id as string;
  created.projectIds.push(id);
  return id;
}

async function makeKey(
  token: string,
  projectId: string,
  name: string,
): Promise<{ id: string; plaintext: string; keyPrefix: string }> {
  const res = await request(app)
    .post(`/api/v1/projects/${projectId}/api-keys`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  expect(res.status).toBe(201);
  const id = res.body.data.apiKey.id as string;
  created.apiKeyIds.push(id);
  return {
    id,
    plaintext: res.body.data.plaintextKey as string,
    keyPrefix: res.body.data.apiKey.keyPrefix as string,
  };
}

const probe = (key?: string) => {
  const req = request(app).get('/__dev/apikey-probe');
  return key === undefined ? req : req.set('X-API-Key', key);
};

let alice: { token: string; userId: string };
let bob: { token: string; userId: string };
let aliceProject: string;
let bobProject: string;

beforeAll(async () => {
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  aliceProject = await makeProject(alice.token, 'Key Project A');
  bobProject = await makeProject(bob.token, 'Key Project B');
});

afterAll(() =>
  runCleanup('api-keys', [
    ['apiKeys', () => prisma.apiKey.deleteMany({ where: { id: { in: created.apiKeyIds } } })],
    ['projects', () => prisma.project.deleteMany({ where: { id: { in: created.projectIds } } })],
    ['users', () => prisma.user.deleteMany({ where: { id: { in: created.userIds } } })],
  ]),
);

describe('key generation', () => {
  it('creates a key, returns plaintext exactly once, stores only prefix + SHA-256', async () => {
    const res = await request(app)
      .post(`/api/v1/projects/${aliceProject}/api-keys`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Production Key' });

    expect(res.status).toBe(201);
    const { apiKey, plaintextKey } = res.body.data;
    created.apiKeyIds.push(apiKey.id as string);

    expect(plaintextKey).toMatch(PLAINTEXT_FORMAT);
    expect(plaintextKey.startsWith(`${apiKey.keyPrefix}_`)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('keyHash');

    const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
    expect(stored?.keyHash).toBe(sha256(plaintextKey)); // SHA-256 of the COMPLETE key
    expect(stored?.keyHash).toHaveLength(64);
    expect(stored?.keyPrefix).toBe(apiKey.keyPrefix);
    // Plaintext appears nowhere in the stored row.
    expect(JSON.stringify(stored)).not.toContain(plaintextKey.split('_')[2]);
  });

  it('the returned key authenticates; identity comes from the key record', async () => {
    const key = await makeKey(alice.token, aliceProject, 'Probe Key');
    const res = await probe(key.plaintext);
    expect(res.status).toBe(200);
    expect(res.body.data.projectId).toBe(aliceProject);
    expect(res.body.data.apiKeyId).toBe(key.id);

    // Bob's key can never authenticate as Alice's project: the attached
    // project is read from the key record, not from anything client-sent.
    const bobKey = await makeKey(bob.token, bobProject, 'Bob Key');
    const bobRes = await probe(bobKey.plaintext);
    expect(bobRes.status).toBe(200);
    expect(bobRes.body.data.projectId).toBe(bobProject);
    expect(bobRes.body.data.projectId).not.toBe(aliceProject);
  });

  it('generates unique keys', async () => {
    const keys = [
      await makeKey(alice.token, aliceProject, 'U1'),
      await makeKey(alice.token, aliceProject, 'U2'),
      await makeKey(alice.token, aliceProject, 'U3'),
    ];
    const prefixes = new Set(keys.map((k) => k.keyPrefix));
    const plaintexts = new Set(keys.map((k) => k.plaintext));
    expect(prefixes.size).toBe(3);
    expect(plaintexts.size).toBe(3);
  });

  it('rejects generation on foreign and on soft-deleted projects', async () => {
    const foreign = await request(app)
      .post(`/api/v1/projects/${aliceProject}/api-keys`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'Intruder' });
    expect(foreign.status).toBe(404);

    const doomed = await makeProject(alice.token, 'Doomed Key Project');
    const del = await request(app)
      .delete(`/api/v1/projects/${doomed}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(del.status).toBe(200);

    const afterDelete = await request(app)
      .post(`/api/v1/projects/${doomed}/api-keys`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Too Late' });
    expect(afterDelete.status).toBe(404);
  });
});

describe('key listing', () => {
  it('lists safe fields only, for the owner only', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${aliceProject}/api-keys`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.apiKeys.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toMatch(/whk_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}/); // no plaintext anywhere
    for (const key of res.body.data.apiKeys) {
      expect(Object.keys(key).sort()).toEqual(
        ['createdAt', 'id', 'keyPrefix', 'lastUsedAt', 'name', 'revokedAt'].sort(),
      );
    }

    const foreign = await request(app)
      .get(`/api/v1/projects/${aliceProject}/api-keys`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(foreign.status).toBe(404);
  });
});

describe('key revocation', () => {
  it('revokes idempotently; other keys and projects unaffected; revoked key cannot authenticate', async () => {
    const victim = await makeKey(alice.token, aliceProject, 'To Revoke');
    const survivor = await makeKey(alice.token, aliceProject, 'Survivor');

    const first = await request(app)
      .delete(`/api/v1/projects/${aliceProject}/api-keys/${victim.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(first.status).toBe(200);
    const revokedAt = first.body.data.apiKey.revokedAt as string;
    expect(revokedAt).toBeTruthy();

    expect((await probe(victim.plaintext)).status).toBe(401); // dead immediately
    expect((await probe(survivor.plaintext)).status).toBe(200); // others unaffected

    const second = await request(app)
      .delete(`/api/v1/projects/${aliceProject}/api-keys/${victim.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(second.status).toBe(200); // idempotent
    expect(second.body.data.apiKey.revokedAt).toBe(revokedAt); // same terminal state

    const list = await request(app)
      .get(`/api/v1/projects/${aliceProject}/api-keys`)
      .set('Authorization', `Bearer ${alice.token}`);
    const listed = list.body.data.apiKeys.find((k: { id: string }) => k.id === victim.id);
    expect(listed.revokedAt).toBeTruthy();

    const row = await prisma.apiKey.findUnique({ where: { id: victim.id } });
    expect(row).not.toBeNull(); // never hard-deleted

    // Key from another project under this project's path → 404.
    const bobKey = await makeKey(bob.token, bobProject, 'Bob Other');
    const crossProject = await request(app)
      .delete(`/api/v1/projects/${aliceProject}/api-keys/${bobKey.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(crossProject.status).toBe(404);

    // And Bob cannot revoke Alice's keys at all.
    const foreign = await request(app)
      .delete(`/api/v1/projects/${aliceProject}/api-keys/${survivor.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(foreign.status).toBe(404);
  });
});

describe('authentication middleware', () => {
  it('rejects missing, malformed, unknown, tampered and revoked keys with one generic 401', async () => {
    const real = await makeKey(alice.token, aliceProject, 'Edge Key');

    const missing = await probe();
    expect(missing.status).toBe(401);

    const malformed = await probe('whk_not-a-real-shape');
    const unknown = await probe(generateApiKey().plaintext); // valid shape, never stored
    const tampered = await probe(
      real.plaintext.slice(0, -1) + (real.plaintext.endsWith('A') ? 'B' : 'A'),
    );

    expect(malformed.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(tampered.status).toBe(401);
    // Identical bodies: no oracle for "this prefix exists" or "wrong secret".
    expect(unknown.body).toEqual(tampered.body);
    expect(malformed.body).toEqual(unknown.body);

    expect((await probe(real.plaintext)).status).toBe(200); // control
  });

  it('rejects keys of soft-deleted projects even if somehow un-revoked', async () => {
    const doomed = await makeProject(alice.token, 'Doomed Probe Project');
    const key = await makeKey(alice.token, doomed, 'Doomed Key');

    await request(app)
      .delete(`/api/v1/projects/${doomed}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect((await probe(key.plaintext)).status).toBe(401); // revoked by cascade

    // Defense in depth: restore revoked_at on OUR OWN fixture row — the
    // project-deleted check must still refuse authentication.
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: null } });
    expect((await probe(key.plaintext)).status).toBe(401);
  });
});
