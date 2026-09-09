import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pendingMigrations } from '../../src/db/migrate.js';
import { TEST_IDS, TOKENS, bearer, createTestContext, type TestContext } from '../helpers/testApp.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('migrations', () => {
  it('are idempotent and leave nothing pending', async () => {
    const second = await migrate(ctx.db);
    expect(second.applied).toEqual([]);
    expect(await pendingMigrations(ctx.db)).toEqual([]);
  });
});

describe('F0 config/health/ready', () => {
  it('GET /config is public and exposes limits and aiMode', async () => {
    const res = await request(ctx.app).get('/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.body.data.aiMode).toBe('fake');
    expect(res.body.data.demoMode).toBe(true);
    expect(res.body.data.limits.videoMimeTypes).toEqual(['video/mp4']);
    expect(res.body.data.settlement.witnessReward).toBe(80_000);
    expect(res.body.meta.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('GET /health and /ready succeed', async () => {
    expect((await request(ctx.app).get('/api/v1/health')).status).toBe(200);
    const ready = await request(ctx.app).get('/api/v1/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data.checks.database.ok).toBe(true);
    expect(ready.body.data.checks.migrations.ok).toBe(true);
  });

  it('echoes a safe X-Request-Id and generates one otherwise', async () => {
    const res = await request(ctx.app).get('/api/v1/health').set('X-Request-Id', 'client-req-0001');
    expect(res.headers['x-request-id']).toBe('client-req-0001');
    const res2 = await request(ctx.app).get('/api/v1/health').set('X-Request-Id', 'bad id!');
    expect(res2.headers['x-request-id']).not.toBe('bad id!');
  });

  it('returns the error envelope for unknown routes', async () => {
    // Unknown routes under the prefix still pass through auth first (401 when anonymous).
    expect((await request(ctx.app).get('/api/v1/nope')).status).toBe(401);
    const res = await request(ctx.app).get('/api/v1/nope').set(bearer(TOKENS.requester));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.retryable).toBe(false);
    expect(res.body.meta.requestId).toBeTruthy();
  });
});

describe('F1 auth + /me', () => {
  it('rejects missing, malformed and unknown tokens with 401', async () => {
    expect((await request(ctx.app).get('/api/v1/me')).status).toBe(401);
    expect((await request(ctx.app).get('/api/v1/me').set('Authorization', 'Basic abc')).status).toBe(401);
    const res = await request(ctx.app).get('/api/v1/me').set(bearer('forged'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the seeded profile for a valid token', async () => {
    const res = await request(ctx.app).get('/api/v1/me').set(bearer(TOKENS.witness));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: TEST_IDS.witness,
      role: 'WITNESS',
      displayName: '박목격',
      notificationConsent: true,
      payoutReady: true,
      unreadNotificationCount: 0,
    });
  });

  it('creates a REQUESTER profile on first sight of a new identity', async () => {
    const res = await request(ctx.app).get('/api/v1/me').set(bearer(TOKENS.stranger));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(TEST_IDS.stranger);
    expect(res.body.data.role).toBe('REQUESTER');
    expect(res.body.data.displayName).toBe('stranger');
  });

  it('PATCH /me only accepts notificationConsent', async () => {
    const okRes = await request(ctx.app).patch('/api/v1/me').set(bearer(TOKENS.witness)).send({ notificationConsent: false });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.notificationConsent).toBe(false);

    const bad = await request(ctx.app).patch('/api/v1/me').set(bearer(TOKENS.witness)).send({ role: 'OPERATOR' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const me = await request(ctx.app).get('/api/v1/me').set(bearer(TOKENS.witness));
    expect(me.body.data.role).toBe('WITNESS');

    await request(ctx.app).patch('/api/v1/me').set(bearer(TOKENS.witness)).send({ notificationConsent: true });
  });

  it('rejects malformed JSON with VALIDATION_ERROR', async () => {
    const res = await request(ctx.app)
      .patch('/api/v1/me')
      .set(bearer(TOKENS.witness))
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
