import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisInput, AnalysisProvider, ProviderOutcome } from '../../src/modules/analysis/provider.js';
import { resolveDemoDate, zoneOffset } from '../../src/modules/demo/seed.js';
import { fakeMp4 } from '../helpers/fixtures.js';
import { PLACE_A, TEST_IDS, TOKENS, bearer, createTestContext, type TestContext } from '../helpers/testApp.js';

class AlwaysDetects implements AnalysisProvider {
  readonly kind = 'live' as const;
  async analyze(_input: AnalysisInput): Promise<ProviderOutcome> {
    return {
      source: 'LIVE',
      raw: { data: '{}' },
      parsed: { incidentDetected: true, incidentTimestampSeconds: 12, victimVehicle: '흰색 세단', otherVehicle: '검은색 SUV', event: '접촉', relevance: 'HIGH', evidence: [] },
      requestHash: 'h',
      promptVersion: 'v1',
      model: 'pegasus1.5',
    };
  }
}

function incidentBody(demoDate = '2026-09-09') {
  return {
    placeId: PLACE_A,
    type: 'CONTACT',
    occurredFrom: `${demoDate}T14:00:00+09:00`,
    occurredTo: `${demoDate}T14:10:00+09:00`,
    vehicle: { color: '흰색', model: '세단', damageArea: '우측 후면' },
    description: '데모 리셋 테스트용 사고 요청입니다.',
    photoObjectPaths: [],
    consent: { evidenceUse: true, privacy: true },
  };
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ DEMO_DATE: '2026-09-09' }, {}, { provider: new AlwaysDetects() });
});

async function readyDetectedSubmission() {
  const inc = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(incidentBody());
  const incidentId = inc.body.data.id as string;
  const video = fakeMp4({ durationSec: 20, padBytes: 2048 + Math.floor(Math.random() * 1000) });
  const sub = await request(ctx.app).post(`/api/v1/incidents/${incidentId}/submissions`).set(bearer(TOKENS.witness)).send({ mime: 'video/mp4', bytes: video.length });
  const submissionId = sub.body.data.submissionId as string;
  ctx.storage.put(ctx.env.SUPABASE_BUCKET_VIDEOS, sub.body.data.objectPath, video, 'video/mp4');
  expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness))).status).toBe(200);
  expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness))).status).toBe(202);
  await ctx.analysis.queue.onIdle();
  return { incidentId, submissionId };
}
afterAll(async () => {
  await ctx.close();
});

describe('F10 demo ops', () => {
  it('seed helpers: DEMO_DATE override / zone-local today; Asia/Seoul offset', () => {
    expect(resolveDemoDate({ DEMO_DATE: '2026-09-09', DEMO_TIMEZONE: 'Asia/Seoul' })).toBe('2026-09-09');
    // 2026-09-09T23:30Z is already 09-10 in Seoul
    expect(resolveDemoDate({ DEMO_DATE: '', DEMO_TIMEZONE: 'Asia/Seoul' }, new Date('2026-09-09T23:30:00Z'))).toBe('2026-09-10');
    expect(zoneOffset('Asia/Seoul', new Date('2026-09-09T00:00:00Z'))).toBe('+09:00');
    expect(zoneOffset('UTC', new Date('2026-09-09T00:00:00Z'))).toBe('+00:00');
  });

  it('GET /demo/accounts is public, returns emails only (no password)', async () => {
    const res = await request(ctx.app).get('/api/v1/demo/accounts');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      requester: { email: 'demo.requester@lumina.local', role: 'REQUESTER' },
      witness: { email: 'demo.witness@lumina.local', role: 'WITNESS' },
      timeZone: 'Asia/Seoul',
    });
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('password');
  });

  it('POST /demo/reset requires the admin token', async () => {
    expect((await request(ctx.app).post('/api/v1/demo/reset')).status).toBe(401);
    expect((await request(ctx.app).post('/api/v1/demo/reset').set('X-Demo-Admin-Token', 'wrong')).status).toBe(401);
    expect((await request(ctx.app).post('/api/v1/demo/reset').set(bearer(TOKENS.operator))).status).toBe(401);
  });

  it('POST /demo/reset wipes demo incidents/submissions/notifications + storage and restores the seed visit; places kept', async () => {
    // build some state: incident with a photo, submission with a video, notification
    const inc = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send({
        placeId: PLACE_A,
        type: 'CONTACT',
        occurredFrom: '2026-09-09T14:00:00+09:00',
        occurredTo: '2026-09-09T14:10:00+09:00',
        vehicle: { color: '흰색', model: '세단', damageArea: '우측 후면' },
        description: '데모 리셋 테스트용 사고 요청입니다.',
        photoObjectPaths: [],
        consent: { evidenceUse: true, privacy: true },
      });
    expect(inc.status).toBe(201);
    const incidentId = inc.body.data.id as string;
    const video = fakeMp4({ durationSec: 20 });
    const sub = await request(ctx.app).post(`/api/v1/incidents/${incidentId}/submissions`).set(bearer(TOKENS.witness)).send({ mime: 'video/mp4', bytes: video.length });
    expect(sub.status).toBe(201);
    ctx.storage.put(ctx.env.SUPABASE_BUCKET_VIDEOS, sub.body.data.objectPath, video, 'video/mp4');
    ctx.storage.put(ctx.env.SUPABASE_BUCKET_PHOTOS, `staging/${TEST_IDS.witness}/abandoned.jpg`, Buffer.from('x'), 'image/jpeg');
    // manually edit Y's visit so we can see it restored
    await ctx.db.query(`update visits set exited_at = entered_at + interval '1 minute' where user_id = $1`, [TEST_IDS.witness]);

    const before = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.witness));
    expect(before.body.data.length).toBeGreaterThan(0);

    const res = await request(ctx.app).post('/api/v1/demo/reset').set('X-Demo-Admin-Token', 'demo-admin');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ incidentsDeleted: 1, submissionsDeleted: 1, seededVisit: true, accountsFound: 3, storageErrors: 0 });
    expect(res.body.data.notificationsDeleted).toBeGreaterThan(0);
    expect(res.body.data.storageObjectsRemoved).toBe(2);

    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester))).status).toBe(404);
    expect((await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.witness))).body.data).toEqual([]);
    expect((await request(ctx.app).get('/api/v1/me/incidents').set(bearer(TOKENS.requester))).body.data).toEqual([]);
    expect(await ctx.storage.getObjectInfo(ctx.env.SUPABASE_BUCKET_VIDEOS, sub.body.data.objectPath)).toBeNull();
    expect(await ctx.storage.getObjectInfo(ctx.env.SUPABASE_BUCKET_PHOTOS, `staging/${TEST_IDS.witness}/abandoned.jpg`)).toBeNull();

    const places = await request(ctx.app).get('/api/v1/places').set(bearer(TOKENS.requester));
    expect(places.body.data.map((p: { id: string }) => p.id)).toContain(PLACE_A);

    const visits = await request(ctx.app).get('/api/v1/me/visits').set(bearer(TOKENS.witness));
    expect(visits.body.data).toHaveLength(1);
    const v = visits.body.data[0];
    expect(new Date(v.exitedAt).getTime() - new Date(v.enteredAt).getTime()).toBe(14 * 60_000);
    expect(new Date(v.enteredAt).toISOString()).toMatch(/T04:58:00\.000Z$/); // 13:58 KST

    // the world still works after reset: a fresh incident matches Y again
    const again = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send({
        placeId: PLACE_A,
        type: 'CONTACT',
        occurredFrom: `${res.body.data.demoDate}T14:00:00+09:00`,
        occurredTo: `${res.body.data.demoDate}T14:10:00+09:00`,
        vehicle: { color: '흰색', model: '세단', damageArea: '우측 후면' },
        description: '리셋 이후 다시 등록한 사고 요청입니다.',
        photoObjectPaths: [],
        consent: { evidenceUse: true, privacy: true },
      });
    expect(again.status).toBe(201);
    expect(again.body.data.matchedWitnessCount).toBe(1);
  });

  it('reset works after the full ADOPTED path (settlement.payout_submission_id has no cascade)', async () => {
    const { incidentId, submissionId } = await readyDetectedSubmission();
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester))).status).toBe(201);
    const adopt = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.requester)).send({ decision: 'ADOPTED' });
    expect(adopt.status).toBe(200);
    expect(adopt.body.data.settlement.status).toBe('PAYOUT_SCHEDULED');

    const res = await request(ctx.app).post('/api/v1/demo/reset').set('X-Demo-Admin-Token', 'demo-admin');
    expect(res.status).toBe(200);
    expect(res.body.data.incidentsDeleted).toBeGreaterThanOrEqual(1);
    expect(res.body.data.submissionsDeleted).toBeGreaterThanOrEqual(1);
    const left = await ctx.db.query<{ n: string }>(
      `select (select count(*) from settlements where incident_id = $1) + (select count(*) from insurer_reviews where incident_id = $1) + (select count(*) from analyses where submission_id = $2) as n`,
      [incidentId, submissionId],
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
    expect((await request(ctx.app).get('/api/v1/me/rewards').set(bearer(TOKENS.witness))).body.data).toEqual([]);
  });

  it('storage failure aborts the reset with 503 and keeps the rows (retryable, no orphaned objects)', async () => {
    const inc = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(incidentBody());
    const incidentId = inc.body.data.id as string;
    const video = fakeMp4({ durationSec: 20 });
    const sub = await request(ctx.app).post(`/api/v1/incidents/${incidentId}/submissions`).set(bearer(TOKENS.witness)).send({ mime: 'video/mp4', bytes: video.length });
    ctx.storage.put(ctx.env.SUPABASE_BUCKET_VIDEOS, sub.body.data.objectPath, video, 'video/mp4');

    const original = ctx.storage.remove.bind(ctx.storage);
    ctx.storage.remove = async () => {
      throw new Error('storage down');
    };
    try {
      const res = await request(ctx.app).post('/api/v1/demo/reset').set('X-Demo-Admin-Token', 'demo-admin');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    } finally {
      ctx.storage.remove = original;
    }
    // nothing was deleted, so a retry can still find the object paths
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester))).status).toBe(200);
    expect(await ctx.storage.getObjectInfo(ctx.env.SUPABASE_BUCKET_VIDEOS, sub.body.data.objectPath)).not.toBeNull();
    const retry = await request(ctx.app).post('/api/v1/demo/reset').set('X-Demo-Admin-Token', 'demo-admin');
    expect(retry.status).toBe(200);
    expect(await ctx.storage.getObjectInfo(ctx.env.SUPABASE_BUCKET_VIDEOS, sub.body.data.objectPath)).toBeNull();
  });

  it('DEMO_MODE=false: demo routes are not mounted (404 / auth-gated)', async () => {
    const strict = await createTestContext({ DEMO_MODE: 'false' });
    try {
      // public router is not registered, so the request falls through to the authed router → 401
      expect((await request(strict.app).get('/api/v1/demo/accounts')).status).toBe(401);
      expect((await request(strict.app).get('/api/v1/demo/accounts').set(bearer(TOKENS.operator))).status).toBe(404);
      expect((await request(strict.app).post('/api/v1/demo/reset').set('X-Demo-Admin-Token', 'demo-admin').set(bearer(TOKENS.operator))).status).toBe(404);
    } finally {
      await strict.close();
    }
  });
});
