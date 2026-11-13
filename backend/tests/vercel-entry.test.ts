import request from 'supertest';
import { describe, expect, it } from 'vitest';
import apiEntry from '../api/index.js';
import workerEntry from '../api/worker-tick.js';

/**
 * Verifies the two Vercel Function entry points wire the existing app
 * correctly: routing, auth and the error envelope — without ever running a
 * global tick (the trigger behavior itself is covered by
 * worker-trigger.test.ts). No fixtures, no cleanup needed.
 */

describe('vercel function entries', () => {
  it('both entries default-export literal handler functions (the shape @vercel/node validates)', () => {
    expect(typeof apiEntry).toBe('function');
    expect(typeof workerEntry).toBe('function');
    // Named function declarations, not computed values — a regression here
    // reproduces the "Invalid export found in module src/app.js" deploy error.
    expect(apiEntry.name).toBe('handler');
    expect(workerEntry.name).toBe('handler');
  });

  it('api/index serves the full API with the standard envelopes', async () => {
    const health = await request(apiEntry).get('/health');
    expect([200, 503]).toContain(health.status); // healthy or degraded, never broken
    expect(health.body).toHaveProperty('success');

    const missing = await request(apiEntry).get('/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('api/worker-tick exposes ONLY the guarded trigger', async () => {
    // Auth is wired (and nothing runs without the secret)…
    const unauthorized = await request(workerEntry).post('/internal/worker/tick');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.code).toBe('UNAUTHORIZED');

    // …and no other surface exists on this function.
    expect((await request(workerEntry).get('/internal/worker/tick')).status).toBe(404);
    expect((await request(workerEntry).get('/health')).status).toBe(404);
    expect((await request(workerEntry).post('/api/v1/auth/login')).status).toBe(404);
  });
});
