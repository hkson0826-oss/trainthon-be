import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jpegWithExif, notAnImage, pngWithText } from '../helpers/fixtures.js';
import { PLACE_A, PLACE_B, TEST_IDS, TOKENS, bearer, createTestContext, type TestContext } from '../helpers/testApp.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const PHOTO_BUCKET = 'incident-photos';

async function stagePhoto(token: string, data: Buffer, mime: string): Promise<string> {
  const res = await request(ctx.app).post('/api/v1/uploads/photo-url').set(bearer(token)).send({ mime, bytes: data.length });
  expect(res.status).toBe(201);
  expect(res.body.data.objectPath).toMatch(/^staging\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/);
  expect(res.body.data.uploadUrl).toContain(res.body.data.objectPath);
  // simulate the browser PUT to the signed URL
  ctx.storage.put(PHOTO_BUCKET, res.body.data.objectPath, data, mime);
  return res.body.data.objectPath as string;
}

function incidentBody(overrides: Record<string, unknown> = {}) {
  return {
    placeId: PLACE_A,
    type: 'HIT_AND_RUN',
    occurredFrom: '2026-09-09T14:00:00+09:00',
    occurredTo: '2026-09-09T14:10:00+09:00',
    vehicle: { color: '흰색', model: '세단(아반떼)', damageArea: '우측 후면 범퍼' },
    description: '지하 2층에 주차하고 40분 뒤 돌아왔는데 우측 뒤 범퍼가 긁혀 있었습니다.',
    photoObjectPaths: [],
    consent: { evidenceUse: true, privacy: true },
    ...overrides,
  };
}

describe('F2 places', () => {
  it('lists seeded places and filters by query', async () => {
    const all = await request(ctx.app).get('/api/v1/places').set(bearer(TOKENS.requester));
    expect(all.status).toBe(200);
    expect(all.body.data.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['A주차장', 'B아파트 지하주차장']));
    const filtered = await request(ctx.app).get('/api/v1/places?query=A주차').set(bearer(TOKENS.requester));
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].id).toBe(PLACE_A);
  });
});

describe('F3 incidents + F4 matching', () => {
  let incidentId: string;

  it('S1: X creates an incident with 2 photos, deposit is recorded and Y is matched', async () => {
    const p1 = await stagePhoto(TOKENS.requester, jpegWithExif(1600, 1200), 'image/jpeg');
    const p2 = await stagePhoto(TOKENS.requester, pngWithText(), 'image/png');

    const res = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send(incidentBody({ photoObjectPaths: [p1, p2] }));
    expect(res.status).toBe(201);
    const d = res.body.data;
    incidentId = d.id;
    expect(d.status).toBe('OPEN');
    expect(d.reviewMode).toBe('AUTO_DEMO');
    expect(d.matching).toEqual({ matchedWitnessCount: 1, notifiedAt: expect.any(String) });
    expect(d.matchedWitnessCount).toBe(1);
    expect(d.settlement).toMatchObject({ status: 'DEPOSITED', depositAmount: 100_000, platformFee: 20_000, witnessReward: 80_000, mock: true });
    expect(d.photos).toHaveLength(2);
    expect(d.photos[0]).toMatchObject({ position: 0, mime: 'image/jpeg', width: 1600, height: 1200 });
    expect(d.photos[0].url).toContain(`incidents/${incidentId}/0.jpg`);

    // staged objects were moved to the incident path and metadata stripped
    expect(await ctx.storage.getObjectInfo(PHOTO_BUCKET, p1)).toBeNull();
    const finalJpeg = await ctx.storage.download(PHOTO_BUCKET, `incidents/${incidentId}/0.jpg`);
    expect(finalJpeg.includes(Buffer.from('FAKE-GPS-DATA'))).toBe(false);
  });

  it('Y sees exactly one WITNESS_REQUEST without requester personal data and /me unread count reflects it', async () => {
    const list = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.witness));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const n = list.body.data[0];
    expect(n.type).toBe('WITNESS_REQUEST');
    expect(n.incidentId).toBe(incidentId);
    expect(n.body).toContain('A주차장');
    expect(n.body).toContain('14:00~14:10');
    expect(n.body).not.toContain('김피해');
    expect(n.body).not.toContain('x@test.local');
    expect(list.body.meta.unreadCount).toBe(1);

    const me = await request(ctx.app).get('/api/v1/me').set(bearer(TOKENS.witness));
    expect(me.body.data.unreadNotificationCount).toBe(1);

    const read = await request(ctx.app).post(`/api/v1/notifications/${n.id}/read`).set(bearer(TOKENS.witness));
    expect(read.status).toBe(200);
    expect(read.body.data.readAt).toBeTruthy();
    expect((await request(ctx.app).get('/api/v1/me').set(bearer(TOKENS.witness))).body.data.unreadNotificationCount).toBe(0);

    // X cannot read Y's notification
    expect((await request(ctx.app).post(`/api/v1/notifications/${n.id}/read`).set(bearer(TOKENS.requester))).status).toBe(404);
  });

  it('GET /incidents/:id returns owner DTO to X, masked DTO to notified Y, 404 to strangers', async () => {
    const owner = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester));
    expect(owner.status).toBe(200);
    expect(owner.body.data.description).toContain('지하 2층');
    expect(owner.body.data.settlement.status).toBe('DEPOSITED');

    const witness = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.witness));
    expect(witness.status).toBe(200);
    expect(witness.body.data.masked).toBe(true);
    expect(witness.body.data.rewardPreview).toEqual({ amount: 80_000, mock: true });
    expect(witness.body.data.mySubmissionId).toBeNull();
    expect(witness.body.data).not.toHaveProperty('settlement');
    expect(witness.body.data).not.toHaveProperty('requesterId');
    expect(witness.body.data.photos).toHaveLength(2);
    expect(witness.body.data.photos[0]).not.toHaveProperty('id');

    const operator = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.operator));
    expect(operator.status).toBe(200);
    expect(operator.body.data.description).toContain('지하 2층');

    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.stranger))).status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/incidents/00000000-0000-4000-8000-0000000000ff`).set(bearer(TOKENS.requester))).status).toBe(404);
  });

  it('GET /me/incidents lists X incidents; witness role is rejected', async () => {
    const res = await request(ctx.app).get('/api/v1/me/incidents').set(bearer(TOKENS.requester));
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { id: string }) => i.id)).toContain(incidentId);
    expect(res.body.data[0]).not.toHaveProperty('photos');
    expect((await request(ctx.app).get('/api/v1/me/incidents').set(bearer(TOKENS.witness))).status).toBe(403);
  });

  it('F1 (failure flow): non-overlapping window or other place yields 0 matches and no notification', async () => {
    const later = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send(incidentBody({ occurredFrom: '2026-09-09T16:00:00+09:00', occurredTo: '2026-09-09T16:10:00+09:00' }));
    expect(later.status).toBe(201);
    expect(later.body.data.matching.matchedWitnessCount).toBe(0);

    const elsewhere = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(incidentBody({ placeId: PLACE_B }));
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.body.data.matching.matchedWitnessCount).toBe(0);

    const list = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.witness));
    expect(list.body.data).toHaveLength(1);
  });

  it('padding: a window 10 minutes after the visit still matches (MATCH_TIME_PADDING_MIN=15)', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send(incidentBody({ occurredFrom: '2026-09-09T14:20:00+09:00', occurredTo: '2026-09-09T14:25:00+09:00' }));
    expect(res.status).toBe(201);
    expect(res.body.data.matching.matchedWitnessCount).toBe(1);
  });

  it('F8: re-running matching for the same incident adds no duplicate notification (NULLS NOT DISTINCT)', async () => {
    const { runMatching } = await import('../../src/modules/matching/index.js');
    const before = Number((await ctx.db.query<{ c: string }>('select count(*)::text as c from notifications')).rows[0]!.c);
    const r = await runMatching(ctx.db, ctx.env, {
      incidentId,
      requesterId: TEST_IDS.requester,
      placeId: PLACE_A,
      placeName: 'A주차장',
      occurredFrom: new Date('2026-09-09T14:00:00+09:00'),
      occurredTo: new Date('2026-09-09T14:10:00+09:00'),
    });
    expect(r.matchedWitnessCount).toBe(1);
    expect(r.newNotifications).toBe(0);
    const after = Number((await ctx.db.query<{ c: string }>('select count(*)::text as c from notifications')).rows[0]!.c);
    expect(after).toBe(before);
  });

  it('users without notification consent are not matched', async () => {
    await request(ctx.app).patch('/api/v1/me').set(bearer(TOKENS.witness)).send({ notificationConsent: false });
    const res = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send(incidentBody({ occurredFrom: '2026-09-09T14:01:00+09:00', occurredTo: '2026-09-09T14:09:00+09:00' }));
    expect(res.body.data.matching.matchedWitnessCount).toBe(0);
    await request(ctx.app).patch('/api/v1/me').set(bearer(TOKENS.witness)).send({ notificationConsent: true });
  });

  it('validation: reversed time, >24h window, missing consent, unknown place, too many photos → 400', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ occurredFrom: '2026-09-09T14:10:00+09:00', occurredTo: '2026-09-09T14:00:00+09:00' }, 'occurredTo'],
      [{ occurredFrom: '2026-09-08T14:00:00+09:00', occurredTo: '2026-09-09T14:10:00+09:00' }, 'occurredTo'],
      [{ consent: { evidenceUse: true, privacy: false } }, 'consent.privacy'],
      [{ placeId: '00000000-0000-4000-8000-0000000000aa' }, 'placeId'],
      [{ photoObjectPaths: ['staging/x/1.jpg', 'staging/x/2.jpg', 'staging/x/3.jpg'] }, 'photoObjectPaths'],
    ];
    for (const [override, field] of cases) {
      const res = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(incidentBody(override));
      expect(res.status, JSON.stringify(override)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Object.keys(res.body.error.fieldErrors)).toContain(field);
    }
  });

  it('photos: rejects non-image content, foreign staging paths, missing objects and oversized declarations', async () => {
    const bad = await stagePhoto(TOKENS.requester, notAnImage(), 'image/jpeg');
    const r1 = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(incidentBody({ photoObjectPaths: [bad] }));
    expect(r1.status).toBe(415);
    expect(r1.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const foreign = `staging/${TEST_IDS.witness}/x.jpg`;
    ctx.storage.put(PHOTO_BUCKET, foreign, jpegWithExif(), 'image/jpeg');
    const r2 = await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.requester)).send(incidentBody({ photoObjectPaths: [foreign] }));
    expect(r2.status).toBe(400);
    expect(r2.body.error.fieldErrors['photoObjectPaths.0']).toBe('not_owned');

    const r3 = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send(incidentBody({ photoObjectPaths: [`staging/${TEST_IDS.requester}/missing.jpg`] }));
    expect(r3.status).toBe(400);
    expect(r3.body.error.fieldErrors['photoObjectPaths.0']).toBe('not_found');

    const big = await request(ctx.app).post('/api/v1/uploads/photo-url').set(bearer(TOKENS.requester)).send({ mime: 'image/jpeg', bytes: 11 * 1024 * 1024 });
    expect(big.status).toBe(413);
    const gif = await request(ctx.app).post('/api/v1/uploads/photo-url').set(bearer(TOKENS.requester)).send({ mime: 'image/gif', bytes: 100 });
    expect(gif.status).toBe(415);

    // nothing leaked into incidents/ from the failed attempts
    const incidentCount = Number((await ctx.db.query<{ c: string }>('select count(*)::text as c from incidents')).rows[0]!.c);
    const finalObjects = (await ctx.storage.list(PHOTO_BUCKET, 'incidents/')).length;
    expect(finalObjects).toBe(2); // only the two photos from S1
    expect(incidentCount).toBeGreaterThan(0);
  });

  it('role gates: Y cannot create incidents or request photo URLs', async () => {
    expect((await request(ctx.app).post('/api/v1/incidents').set(bearer(TOKENS.witness)).send(incidentBody())).status).toBe(403);
    expect((await request(ctx.app).post('/api/v1/uploads/photo-url').set(bearer(TOKENS.witness)).send({ mime: 'image/jpeg', bytes: 10 })).status).toBe(403);
  });
});

describe('F4 visits', () => {
  it('Y can list and delete own visits; X is rejected; deleting removes future matches', async () => {
    const list = await request(ctx.app).get('/api/v1/me/visits').set(bearer(TOKENS.witness));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ place: { id: PLACE_A, name: 'A주차장' }, source: 'SEED' });
    expect((await request(ctx.app).get('/api/v1/me/visits').set(bearer(TOKENS.requester))).status).toBe(403);

    const del = await request(ctx.app).delete(`/api/v1/me/visits/${list.body.data[0].id}`).set(bearer(TOKENS.witness));
    expect(del.status).toBe(200);
    expect((await request(ctx.app).delete(`/api/v1/me/visits/${list.body.data[0].id}`).set(bearer(TOKENS.witness))).status).toBe(404);

    const res = await request(ctx.app)
      .post('/api/v1/incidents')
      .set(bearer(TOKENS.requester))
      .send(incidentBody({ occurredFrom: '2026-09-09T14:02:00+09:00', occurredTo: '2026-09-09T14:08:00+09:00' }));
    expect(res.body.data.matching.matchedWitnessCount).toBe(0);
  });
});
