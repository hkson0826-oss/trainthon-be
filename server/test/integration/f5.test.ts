import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeMp4, notAVideo } from '../helpers/fixtures.js';
import { PLACE_A, TEST_IDS, TOKENS, bearer, createTestContext, type TestContext } from '../helpers/testApp.js';

let ctx: TestContext;
const VIDEO_BUCKET = 'evidence-videos';

beforeAll(async () => {
  ctx = await createTestContext({ MAX_VIDEO_BYTES: String(1024 * 1024) });
});
afterAll(async () => {
  await ctx.close();
});

async function createIncident(): Promise<string> {
  const res = await request(ctx.app)
    .post('/api/v1/incidents')
    .set(bearer(TOKENS.requester))
    .send({
      placeId: PLACE_A,
      type: 'HIT_AND_RUN',
      occurredFrom: '2026-09-09T14:00:00+09:00',
      occurredTo: '2026-09-09T14:10:00+09:00',
      vehicle: { color: '흰색', model: '세단', damageArea: '우측 후면' },
      description: '주차 후 돌아오니 범퍼가 긁혀 있었습니다.',
      photoObjectPaths: [],
      consent: { evidenceUse: true, privacy: true },
    });
  expect(res.status).toBe(201);
  expect(res.body.data.matching.matchedWitnessCount).toBe(1);
  return res.body.data.id as string;
}

async function requestUploadUrl(incidentId: string, body: Record<string, unknown>, token: string = TOKENS.witness) {
  return request(ctx.app).post(`/api/v1/incidents/${incidentId}/submissions`).set(bearer(token)).send(body);
}

describe('F5 evidence submissions', () => {
  let incidentId: string;
  let submissionId: string;
  let objectPath: string;

  it('Y requests a signed upload URL for an incident they were notified about', async () => {
    incidentId = await createIncident();
    const res = await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 500_000, durationSec: 20, recordedAt: '2026-09-09T14:03:00+09:00' });
    expect(res.status).toBe(201);
    const d = res.body.data;
    submissionId = d.submissionId;
    objectPath = d.objectPath;
    expect(d.status).toBe('UPLOADING');
    expect(objectPath).toBe(`incidents/${incidentId}/submissions/${submissionId}/original.mp4`);
    expect(d.uploadUrl).toContain(objectPath);
    expect(d.limits).toEqual({ maxBytes: 1024 * 1024, minSeconds: 4, maxSeconds: 3600, mime: 'video/mp4' });

    // X now sees the submission counted, Y sees mySubmissionId
    const asX = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester));
    expect(asX.body.data.submissions).toEqual({ total: 1, ready: 0 });
    const asY = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.witness));
    expect(asY.body.data.mySubmissionId).toBe(submissionId);
  });

  it('rejects declared metadata that violates limits', async () => {
    const other = await createIncident();
    expect((await requestUploadUrl(other, { mime: 'video/quicktime', bytes: 1000 })).body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await requestUploadUrl(other, { mime: 'video/mp4', bytes: 2 * 1024 * 1024 })).status).toBe(413);
    expect((await requestUploadUrl(other, { mime: 'video/mp4', bytes: 1000, durationSec: 2 })).body.error.code).toBe('VIDEO_UNANALYZABLE');
    expect((await requestUploadUrl(other, { mime: 'video/mp4', bytes: 1000, durationSec: 4000 })).status).toBe(422);
    expect((await requestUploadUrl(other, { mime: 'video/mp4' })).status).toBe(400);
  });

  it('only notified witnesses may submit; requester and non-notified witnesses get 403/404', async () => {
    expect((await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 1000 }, TOKENS.requester)).status).toBe(403);
    // a WITNESS who never received a WITNESS_REQUEST for this incident must not learn it exists
    await request(ctx.app).get('/api/v1/me').set(bearer(TOKENS.stranger)); // first login creates the profile
    await ctx.db.query(`update profiles set role = 'WITNESS' where id = $1`, [TEST_IDS.stranger]);
    const res = await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 1000 }, TOKENS.stranger);
    expect(res.status).toBe(404);
    expect((await requestUploadUrl('00000000-0000-4000-8000-0000000000ff', { mime: 'video/mp4', bytes: 1000 })).status).toBe(404);
  });

  it('re-issues the upload URL while still UPLOADING (same submission, 200)', async () => {
    const res = await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 600_000 });
    expect(res.status).toBe(200);
    expect(res.body.data.submissionId).toBe(submissionId);
  });

  it('complete-upload fails when nothing was uploaded yet', async () => {
    const res = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('UPLOAD_NOT_FOUND');
  });

  it('complete-upload rejects non-MP4 bytes, too-short, too-small resolution and oversized files', async () => {
    const complete = () => request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness));

    ctx.storage.put(VIDEO_BUCKET, objectPath, notAVideo(2048), 'video/mp4');
    expect((await complete()).status).toBe(415);

    ctx.storage.put(VIDEO_BUCKET, objectPath, fakeMp4({ durationSec: 2 }), 'video/mp4');
    const short = await complete();
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('VIDEO_UNANALYZABLE');

    ctx.storage.put(VIDEO_BUCKET, objectPath, fakeMp4({ width: 320, height: 240 }), 'video/mp4');
    expect((await complete()).status).toBe(422);

    ctx.storage.put(VIDEO_BUCKET, objectPath, fakeMp4({ padBytes: 2 * 1024 * 1024 }), 'video/mp4');
    expect((await complete()).status).toBe(413);

    // ftyp-only blob: MP4 signature but no readable moov → cannot be trusted even if client declared durationSec
    ctx.storage.put(VIDEO_BUCKET, objectPath, fakeMp4().subarray(0, 32), 'video/mp4');
    const opaque = await complete();
    expect(opaque.status).toBe(422);
    expect(opaque.body.error.message).toContain('duration and resolution');

    // valid MP4 stored with a wrong Content-Type is rejected before download
    ctx.storage.put(VIDEO_BUCKET, objectPath, fakeMp4(), 'application/octet-stream');
    expect((await complete()).status).toBe(415);

    // still UPLOADING after all failures
    const view = await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.witness));
    expect(view.body.data.status).toBe('UPLOADING');
  });

  it('video-url is unavailable while UPLOADING', async () => {
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/video-url`).set(bearer(TOKENS.witness))).status).toBe(409);
  });

  it('complete-upload probes the MP4, stores sha256 and moves the incident to COLLECTING', async () => {
    const data = fakeMp4({ durationSec: 20, width: 1920, height: 1080 });
    ctx.storage.put(VIDEO_BUCKET, objectPath, data, 'video/mp4');
    const res = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: submissionId,
      incidentId,
      status: 'UPLOADED',
      bytes: data.length,
      durationSec: 20,
      width: 1920,
      height: 1080,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      redactionApplied: false,
      analysis: null,
      witness: { self: true },
    });
    expect(res.body.data.uploadCompletedAt).toEqual(expect.any(String));

    const inc = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester));
    expect(inc.body.data.status).toBe('COLLECTING');

    // second completion is rejected
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness))).status).toBe(409);
    // and a new upload URL is refused (already exists, not in a re-uploadable state)
    const again = await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 1000 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_EXISTS');
  });

  it('GET /submissions/:id: witness sees own, requester sees masked witness, operator sees all, stranger 404', async () => {
    const asX = await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.requester));
    expect(asX.status).toBe(200);
    expect(asX.body.data.witness).toEqual({ maskedId: '제보자 #1', self: false });
    expect(asX.body.data.objectPath).toBeUndefined();
    expect(JSON.stringify(asX.body)).not.toContain('박목격');

    const asOp = await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.operator));
    expect(asOp.status).toBe(200);
    expect(asOp.body.data.objectPath).toBe(objectPath);

    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.stranger))).status).toBe(404);
  });

  it('video-url: witness and operator can view UPLOADED footage; requester cannot until READY', async () => {
    const own = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/video-url`).set(bearer(TOKENS.witness));
    expect(own.status).toBe(200);
    expect(own.body.data.url).toContain(objectPath);
    expect(own.body.data.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/video-url`).set(bearer(TOKENS.operator))).status).toBe(200);
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/video-url`).set(bearer(TOKENS.requester))).status).toBe(404);

    // once READY (set by the analysis pipeline in F6), the requester can view
    await ctx.db.query(`update evidence_submissions set status = 'READY' where id = $1`, [submissionId]);
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/video-url`).set(bearer(TOKENS.requester))).status).toBe(200);
    const inc = await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester));
    expect(inc.body.data.submissions).toEqual({ total: 1, ready: 1 });
  });

  it('ANALYSIS_FAILED re-upload refuses to proceed when the stale object cannot be removed', async () => {
    await ctx.db.query(`update evidence_submissions set status = 'ANALYSIS_FAILED' where id = $1`, [submissionId]);
    const original = ctx.storage.remove.bind(ctx.storage);
    ctx.storage.remove = async () => {
      throw new Error('storage down');
    };
    try {
      const res = await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 700_000 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      ctx.storage.remove = original;
    }
    // row untouched, old object still there, still ANALYSIS_FAILED (not silently reopened)
    const view = await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.witness));
    expect(view.body.data.status).toBe('ANALYSIS_FAILED');
    expect(await ctx.storage.getObjectInfo(VIDEO_BUCKET, objectPath)).not.toBeNull();
  });

  it('ANALYSIS_FAILED submissions can request a fresh upload URL and re-complete', async () => {
    const res = await requestUploadUrl(incidentId, { mime: 'video/mp4', bytes: 700_000 });
    expect(res.status).toBe(200);
    expect(res.body.data.submissionId).toBe(submissionId);
    expect(res.body.data.status).toBe('UPLOADING');
    // previous object was removed
    expect(await ctx.storage.getObjectInfo(VIDEO_BUCKET, objectPath)).toBeNull();

    ctx.storage.put(VIDEO_BUCKET, objectPath, fakeMp4({ durationSec: 30 }), 'video/mp4');
    const done = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness));
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'UPLOADED', durationSec: 30 });
  });

  it('concurrent first requests for the same incident/witness yield one submission (no 500)', async () => {
    const other = await createIncident();
    const results = await Promise.all([
      requestUploadUrl(other, { mime: 'video/mp4', bytes: 1000 }),
      requestUploadUrl(other, { mime: 'video/mp4', bytes: 1000 }),
      requestUploadUrl(other, { mime: 'video/mp4', bytes: 1000 }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.data.submissionId)).size).toBe(1);
    const rows = await ctx.db.query<{ n: string }>('select count(*)::text as n from evidence_submissions where incident_id = $1', [other]);
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it('refuses new submissions once the incident stopped collecting', async () => {
    const other = await createIncident();
    await ctx.db.query(`update incidents set status = 'REVIEWING' where id = $1`, [other]);
    const res = await requestUploadUrl(other, { mime: 'video/mp4', bytes: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('records audit entries for upload lifecycle and signed URL issuance', async () => {
    const rows = await ctx.db.query<{ action: string }>(
      `select action from audit_logs where target_type = 'submission' and target_id = $1 order by created_at asc`,
      [submissionId],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['submission.create', 'submission.reupload_url', 'submission.upload_complete', 'video.signed_url']));
  });
});
