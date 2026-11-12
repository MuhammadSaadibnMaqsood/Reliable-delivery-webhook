import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';

/**
 * Integration tests against the real database configured in .env.
 * Non-destructive: every row touched is created here with unique values and
 * removed in afterAll.
 */

const app = buildApp();
const createdEmails: string[] = [];

function uniqueEmail(tag: string): string {
  const email = `p3-${tag}-${randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
}

const PASSWORD = 'correct-horse-battery';

async function registerAndLogin(tag: string): Promise<{ email: string; token: string; userId: string }> {
  const email = uniqueEmail(tag);
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `Test ${tag}`, email, password: PASSWORD });
  expect(reg.status).toBe(201);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { email, token: login.body.data.token as string, userId: reg.body.data.user.id as string };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.$disconnect();
});

describe('registration', () => {
  it('registers a new user, normalizes the email, never leaks the hash', async () => {
    const email = uniqueEmail('reg');
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: '  Alice  ', email: `  ${email.toUpperCase()}  `, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.name).toBe('Alice');
    expect(res.body.data.user.role).toBe('user');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('$argon2');

    const stored = await prisma.user.findUnique({ where: { email } });
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.status).toBe('active');
  });

  it('rejects a duplicate email with 409 CONFLICT', async () => {
    const email = uniqueEmail('dup');
    await request(app).post('/api/v1/auth/register').send({ name: 'A', email, password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'B', email: email.toUpperCase(), password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid input with field-level details', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.email', 'body.password']));
  });
});

describe('login', () => {
  it('returns a signed JWT and safe user for valid credentials', async () => {
    const email = uniqueEmail('login');
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Login User', email, password: PASSWORD });

    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });

    expect(res.status).toBe(200);
    const { token, user } = res.body.data;
    expect(user.id).toBe(reg.body.data.user.id);
    expect(JSON.stringify(res.body)).not.toContain('$argon2');

    const decoded = jwt.verify(token, env.JWT_SECRET) as { sub: string; exp: number };
    expect(decoded.sub).toBe(user.id);
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('uses one generic message for wrong password AND unknown email', async () => {
    const email = uniqueEmail('generic');
    await request(app).post('/api/v1/auth/register').send({ name: 'G', email, password: PASSWORD });

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'definitely-wrong' });
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail('ghost'), password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identical body = no account enumeration.
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
  });

  it('rejects a disabled account (and its previously issued tokens)', async () => {
    const { email, token } = await registerAndLogin('disabled');
    await prisma.user.update({ where: { email }, data: { status: 'disabled' } });

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(403);

    // Token issued before disabling must stop working immediately (DB re-check).
    const probe = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`);
    expect(probe.status).toBe(401);
  });
});

describe('protected routes', () => {
  it('401 without a token', async () => {
    const res = await request(app).get('/api/v1/projects');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 for a malformed token', async () => {
    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('401 for an expired token', async () => {
    const { userId } = await registerAndLogin('expired');
    const expired = jwt.sign({}, env.JWT_SECRET, {
      subject: userId,
      algorithm: 'HS256',
      expiresIn: '-10s',
    });
    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('401 for a token signed with the wrong secret', async () => {
    const { userId } = await registerAndLogin('forged');
    const forged = jwt.sign({}, 'a'.repeat(48), {
      subject: userId,
      algorithm: 'HS256',
      expiresIn: '5m',
    });
    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
