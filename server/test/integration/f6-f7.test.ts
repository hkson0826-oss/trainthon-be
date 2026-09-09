import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrerecordedFixture } from '../../src/modules/analysis/prerecorded.js';
import { fakeMp4 } from '../helpers/fixtures.js';
import { PLACE_A, TOKENS, bearer, createTestContext, type TestContext } from '../helpers/testApp.js';

const VIDEO_BUCKET = 'evidence-videos';
const TL_URL = 'https://api.twelvelabs.io/v1.3/analyze';

type Script = (body: Record<string, unknown>, call: number, signal: AbortSignal | null) => Response | Promise<Response>;

/** Scriptable stand-in for fetch: records request bodies and returns TwelveLabs-shaped responses. */
function scriptedFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let script: Script = () => tlResponse({ incidentDetected: false, incidentTimestampSeconds: 0, victimVehicle: 'x', event: 'e', relevance: 'LOW', evidence: ['n'] });
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url: String(input), headers, body });
    return script(body, calls.length, init?.signal ?? null);
  };
  return { fetchImpl, calls, set: (s: Script) => (script = s) };
}

function tlResponse(data: unknown, finish: 'stop' | 'length' = 'stop', status = 200): Response {
  return new Response(JSON.stringify({ id: 'resp-1', data: typeof data === 'string' ? data : JSON.stringify(data), finish_reason: finish, usage: { output_tokens: 10 } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DETECTED = {
  incidentDetected: true,
  incidentTimestampSeconds: 12.4,
  victimVehicle: '흰색 세단',
  otherVehicle: '검은색 SUV',
  event: '검은색 SUV가 후진하며 흰색 세단 우측 후면에 접촉한 것으로 보이는 장면',
  relevance: 'HIGH',
  evidence: ['피해 차량의 색상과 차종이 사고 요청과 일치', '신고된 파손 부위와 접근 방향이 유사'],
};

async function setupIncidentWithUpload(ctx: TestContext, video = fakeMp4({ durationSec: 20, width: 1920, height: 1080 })) {
  const inc = await request(ctx.app)
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
  expect(inc.status).toBe(201);
  const incidentId = inc.body.data.id as string;
  const sub = await request(ctx.app).post(`/api/v1/incidents/${incidentId}/submissions`).set(bearer(TOKENS.witness)).send({ mime: 'video/mp4', bytes: video.length });
  expect(sub.status).toBe(201);
  const submissionId = sub.body.data.submissionId as string;
  ctx.storage.put(VIDEO_BUCKET, sub.body.data.objectPath, video, 'video/mp4');
  const done = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness));
  expect(done.status).toBe(200);
  return { incidentId, submissionId, sha256: createHash('sha256').update(video).digest('hex') };
}

describe('F6 analysis (live provider, scripted TwelveLabs) + F7 candidates', () => {
  let ctx: TestContext;
  const tl = scriptedFetch();

  beforeAll(async () => {
    ctx = await createTestContext({ AI_MODE: 'live', TWELVELABS_API_KEY: 'test-key', ANALYSIS_TIMEOUT_MS: '10000', PRERECORDED_FALLBACK_ENABLED: 'false' }, {}, { fetchImpl: tl.fetchImpl });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('S1: analyze → READY(LIVE) with normalized result, X gets CANDIDATE_FOUND, candidates lists it', async () => {
    const { incidentId, submissionId } = await setupIncidentWithUpload(ctx);
    tl.set(() => tlResponse(DETECTED));

    const res = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'QUEUED', existing: false });
    await ctx.analysis.queue.onIdle();

    const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness));
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({
      status: 'READY',
      source: 'LIVE',
      model: 'pegasus1.5',
      promptVersion: 'v1',
      attempts: 1,
      error: null,
      result: {
        incidentDetected: true,
        incidentTimestampSeconds: 12.4,
        incidentTimestampLabel: '00:12',
        otherVehicle: '검은색 SUV',
        relevance: 'HIGH',
        videoDurationSec: 20,
        disclaimer: expect.stringContaining('확정하지 않습니다'),
      },
    });

    // request shape sent to TwelveLabs
    const call = tl.calls.at(-1)!;
    expect(call.url).toBe(TL_URL);
    expect(call.headers['x-api-key']).toBe('test-key');
    expect(call.body).toMatchObject({ model_name: 'pegasus1.5', stream: false, temperature: 0.2, max_tokens: 1024 });
    expect((call.body.video as { type: string; url: string }).type).toBe('url');
    expect((call.body.video as { url: string }).url).toContain('original.mp4');
    expect(call.body.prompt).toContain('A주차장');
    expect(call.body.prompt_v2).toBeUndefined(); // no photos → plain prompt
    const schema = (call.body.response_format as { type: string; json_schema: { properties: Record<string, unknown>; required: string[] } }).json_schema;
    expect(schema.properties.incidentTimestampSeconds).toEqual({ type: 'timestamp', format: 'seconds' });
    expect(schema.required[0]).toBe('incidentDetected');
    expect(JSON.stringify(schema)).not.toMatch(/additionalProperties|maxItems|minLength/);

    // submission is READY and the requester got CANDIDATE_FOUND
    const sub = await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.requester));
    expect(sub.body.data.status).toBe('READY');
    expect(sub.body.data.analysis.result.incidentTimestampLabel).toBe('00:12');
    const notes = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.requester));
    const found = notes.body.data.find((n: { type: string; incidentId: string }) => n.type === 'CANDIDATE_FOUND' && n.incidentId === incidentId);
    expect(found).toBeDefined();
    expect(found.body).toContain('00:12');
    expect(found.submissionId).toBe(submissionId);

    // F7: candidates for X (and OPERATOR); Y and strangers get 404
    const cands = await request(ctx.app).get(`/api/v1/incidents/${incidentId}/candidates`).set(bearer(TOKENS.requester));
    expect(cands.status).toBe(200);
    expect(cands.body.meta).toMatchObject({ noCandidateCount: 0, total: 1 });
    expect(cands.body.data).toHaveLength(1);
    expect(cands.body.data[0]).toMatchObject({
      submissionId,
      status: 'READY',
      analysis: { source: 'LIVE', result: { incidentDetected: true } },
      witness: { maskedId: '제보자 #1' },
      humanReviewed: false,
      insurerReview: null,
    });
    expect(cands.body.data[0].videoUrl).toContain('original.mp4');
    expect(cands.body.data[0].video.url).toBe(cands.body.data[0].videoUrl);
    expect(JSON.stringify(cands.body)).not.toContain('박목격');
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}/candidates`).set(bearer(TOKENS.operator))).status).toBe(200);
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}/candidates`).set(bearer(TOKENS.witness))).status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}/candidates`).set(bearer(TOKENS.stranger))).status).toBe(404);

    // analyze again on READY → 409; second concurrent-style call while READY is not in-flight
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness))).status).toBe(409);
  });

  it('incidentDetected=false → READY, NO_CANDIDATE notification, excluded from candidates but counted in meta', async () => {
    const { incidentId, submissionId } = await setupIncidentWithUpload(ctx);
    tl.set(() => tlResponse({ ...DETECTED, incidentDetected: false, incidentTimestampSeconds: 0, relevance: 'LOW' }));
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
    await ctx.analysis.queue.onIdle();

    const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.requester));
    expect(a.body.data.status).toBe('READY');
    expect(a.body.data.result).toMatchObject({ incidentDetected: false, incidentTimestampSeconds: null, incidentTimestampLabel: null });

    const notes = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.requester));
    expect(notes.body.data.some((n: { type: string; incidentId: string }) => n.type === 'NO_CANDIDATE' && n.incidentId === incidentId)).toBe(true);

    const cands = await request(ctx.app).get(`/api/v1/incidents/${incidentId}/candidates`).set(bearer(TOKENS.requester));
    expect(cands.body.data).toEqual([]);
    expect(cands.body.meta.noCandidateCount).toBe(1);
  });

  it('broken JSON → INVALID_RESPONSE retried once (ANALYSIS_MAX_ATTEMPTS=2) then FAILED; retry endpoint re-runs', async () => {
    const { submissionId } = await setupIncidentWithUpload(ctx);
    tl.set(() => tlResponse('{"incidentDetected": tru'));
    const before = tl.calls.length;
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
    await ctx.analysis.queue.onIdle();
    expect(tl.calls.length - before).toBe(2);

    const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness));
    expect(a.body.data).toMatchObject({ status: 'FAILED', attempts: 2, error: { code: 'INVALID_RESPONSE' } });
    const sub = await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.witness));
    expect(sub.body.data.status).toBe('ANALYSIS_FAILED');

    // truncated output is also INVALID_RESPONSE
    tl.set(() => tlResponse(DETECTED, 'length'));
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze/retry`).set(bearer(TOKENS.witness));
    await ctx.analysis.queue.onIdle();
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness))).body.data.error.code).toBe('INVALID_RESPONSE');

    // retry with a good response succeeds
    tl.set(() => tlResponse(DETECTED));
    const retry = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze/retry`).set(bearer(TOKENS.witness));
    expect(retry.status).toBe(202);
    await ctx.analysis.queue.onIdle();
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness))).body.data.status).toBe('READY');
    // retry on READY → 409
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze/retry`).set(bearer(TOKENS.witness))).status).toBe(409);
  });

  it('timestamp beyond video duration → INVALID_RESPONSE (no retry loop on the finalize check)', async () => {
    const { submissionId } = await setupIncidentWithUpload(ctx);
    tl.set(() => tlResponse({ ...DETECTED, incidentTimestampSeconds: 500 }));
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
    await ctx.analysis.queue.onIdle();
    const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness));
    expect(a.body.data.status).toBe('FAILED');
    expect(a.body.data.error.message).toContain('exceeds video duration');
  });

  it('provider 503 on URL → base64 fallback attempt in the same call; 4xx is PROVIDER_REJECTED without retry', async () => {
    const { submissionId } = await setupIncidentWithUpload(ctx);
    tl.set((body) => ((body.video as { type: string }).type === 'url' ? new Response('upstream down', { status: 503 }) : tlResponse(DETECTED)));
    const before = tl.calls.length;
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
    await ctx.analysis.queue.onIdle();
    expect(tl.calls.length - before).toBe(2);
    expect((tl.calls.at(-1)!.body.video as { type: string }).type).toBe('base64_string');
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness))).body.data.status).toBe('READY');

    const second = await setupIncidentWithUpload(ctx, fakeMp4({ durationSec: 25, padBytes: 8000 }));
    tl.set(() => new Response('{"code":"parameter_invalid"}', { status: 400 }));
    const b2 = tl.calls.length;
    await request(ctx.app).post(`/api/v1/submissions/${second.submissionId}/analyze`).set(bearer(TOKENS.witness));
    await ctx.analysis.queue.onIdle();
    // url attempt rejected → one base64 retry (both 400) → no further attempts
    expect(tl.calls.length - b2).toBe(2);
    expect((await request(ctx.app).get(`/api/v1/submissions/${second.submissionId}/analysis`).set(bearer(TOKENS.witness))).body.data.error.code).toBe('PROVIDER_REJECTED');
  });

  it('access: only the witness may start analysis; X/OPERATOR may read it; analyze on UPLOADING → 409', async () => {
    const { incidentId, submissionId } = await setupIncidentWithUpload(ctx);
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.requester))).status).toBe(403);
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.requester))).status).toBe(404); // not requested yet
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.stranger))).status).toBe(404);

    await ctx.db.query(`update evidence_submissions set status = 'UPLOADING' where id = $1`, [submissionId]);
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness))).status).toBe(409);
    await ctx.db.query(`update evidence_submissions set status = 'UPLOADED' where id = $1`, [submissionId]);
    expect(incidentId).toBeDefined();
  });

  it('a provider that sends headers but stalls the body times out (TIMEOUT) instead of pinning the worker', async () => {
    const { submissionId } = await setupIncidentWithUpload(ctx);
    tl.set((_body, _call, signal) => {
      // never closes; like real fetch, the body read rejects when the request signal aborts
      const stalled = new ReadableStream<Uint8Array>({
        start(c) {
          signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')));
        },
      });
      return new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // shorten the budget for this case
    const saved = ctx.env.ANALYSIS_TIMEOUT_MS;
    (ctx.env as { ANALYSIS_TIMEOUT_MS: number }).ANALYSIS_TIMEOUT_MS = 1500;
    try {
      await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
      await ctx.analysis.queue.onIdle();
    } finally {
      (ctx.env as { ANALYSIS_TIMEOUT_MS: number }).ANALYSIS_TIMEOUT_MS = saved;
    }
    const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness));
    expect(a.body.data).toMatchObject({ status: 'FAILED', error: { code: 'TIMEOUT' } });
  });

  it('two analyze calls for the same submission → one analysis row, both 202 with the same id', async () => {
    const { submissionId } = await setupIncidentWithUpload(ctx);
    tl.set(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return tlResponse(DETECTED);
    });
    const [r1, r2] = await Promise.all([
      request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness)),
      request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness)),
    ]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    expect(r1.body.data.analysisId).toBe(r2.body.data.analysisId);
    expect([r1.body.data.existing, r2.body.data.existing].sort()).toEqual([false, true]);
    await ctx.analysis.queue.onIdle();
    const rows = await ctx.db.query<{ n: string }>('select count(*)::text as n from analyses where submission_id = $1', [submissionId]);
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it('sweep: orphaned ANALYZING analysis older than the timeout becomes FAILED(TIMEOUT) and submission ANALYSIS_FAILED', async () => {
    const { submissionId } = await setupIncidentWithUpload(ctx);
    await ctx.db.query(
      `insert into analyses (submission_id, status, model, prompt_version, started_at, created_at)
       values ($1, 'ANALYZING', 'pegasus1.5', 'v1', now() - interval '10 minutes', now() - interval '10 minutes')`,
      [submissionId],
    );
    await ctx.db.query(`update evidence_submissions set status = 'ANALYZING' where id = $1`, [submissionId]);
    const swept = await ctx.analysis.sweep();
    expect(swept).toHaveLength(1);
    const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness));
    expect(a.body.data).toMatchObject({ status: 'FAILED', error: { code: 'TIMEOUT' } });
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.witness))).body.data.status).toBe('ANALYSIS_FAILED');
    // fresh in-flight rows are left alone
    expect(await ctx.analysis.sweep()).toEqual([]);
  });
});

describe('F6 PRERECORDED rules', () => {
  const video = fakeMp4({ durationSec: 20, width: 1280, height: 720, padBytes: 3000 });
  const sha256 = createHash('sha256').update(video).digest('hex');
  const fixture: PrerecordedFixture = {
    file: 'dashcam-a-parking-01.json',
    videoFileName: 'dashcam-a-parking-01.mp4',
    videoSha256: sha256,
    provider: 'twelvelabs',
    model: 'pegasus1.5',
    promptVersion: 'v1',
    rawResponse: { data: '{}', finish_reason: 'stop' },
    result: {
      incidentDetected: true,
      incidentTimestampSeconds: 12,
      incidentTimestampLabel: '00:12',
      victimVehicle: '흰색 세단',
      otherVehicle: '검은색 SUV',
      event: '접촉 장면',
      relevance: 'HIGH',
      evidence: ['색상 일치'],
      videoDurationSec: 20,
      disclaimer: 'AI 결과는 확정하지 않습니다.',
    },
  };

  it('live provider unavailable + sha256 match → READY(source=PRERECORDED); no match → FAILED', async () => {
    const tl = scriptedFetch();
    tl.set(() => new Response('down', { status: 503 }));
    const ctx = await createTestContext(
      { AI_MODE: 'live', TWELVELABS_API_KEY: 'k', ANALYSIS_TIMEOUT_MS: '10000', PRERECORDED_FALLBACK_ENABLED: 'true', TWELVELABS_BASE64_MAX_BYTES: '1' },
      {},
      { fetchImpl: tl.fetchImpl, fixtures: [fixture] },
    );
    try {
      const matched = await setupIncidentWithUpload(ctx, video);
      await request(ctx.app).post(`/api/v1/submissions/${matched.submissionId}/analyze`).set(bearer(TOKENS.witness));
      await ctx.analysis.queue.onIdle();
      const a = await request(ctx.app).get(`/api/v1/submissions/${matched.submissionId}/analysis`).set(bearer(TOKENS.witness));
      expect(a.body.data).toMatchObject({ status: 'READY', source: 'PRERECORDED', attempts: 2, result: { incidentDetected: true, incidentTimestampLabel: '00:12' } });

      const unmatched = await setupIncidentWithUpload(ctx, fakeMp4({ durationSec: 30, padBytes: 5000 }));
      await request(ctx.app).post(`/api/v1/submissions/${unmatched.submissionId}/analyze`).set(bearer(TOKENS.witness));
      await ctx.analysis.queue.onIdle();
      const b = await request(ctx.app).get(`/api/v1/submissions/${unmatched.submissionId}/analysis`).set(bearer(TOKENS.witness));
      expect(b.body.data).toMatchObject({ status: 'FAILED', source: null, error: { code: 'PROVIDER_UNAVAILABLE' } });
    } finally {
      await ctx.close();
    }
  });

  it('INVALID_RESPONSE never falls back to the fixture even when sha256 matches', async () => {
    const tl = scriptedFetch();
    tl.set(() => tlResponse('not json'));
    const ctx = await createTestContext({ AI_MODE: 'live', TWELVELABS_API_KEY: 'k', ANALYSIS_TIMEOUT_MS: '10000' }, {}, { fetchImpl: tl.fetchImpl, fixtures: [fixture] });
    try {
      const { submissionId } = await setupIncidentWithUpload(ctx, video);
      await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness));
      await ctx.analysis.queue.onIdle();
      const a = await request(ctx.app).get(`/api/v1/submissions/${submissionId}/analysis`).set(bearer(TOKENS.witness));
      expect(a.body.data).toMatchObject({ status: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
    } finally {
      await ctx.close();
    }
  });

  it('AI_MODE=fake: never calls the provider; fixture by sha256 or fixed no-detection, always PRERECORDED', async () => {
    const tl = scriptedFetch();
    const ctx = await createTestContext({ AI_MODE: 'fake' }, {}, { fetchImpl: tl.fetchImpl, fixtures: [fixture] });
    try {
      expect(ctx.analysis.provider.kind).toBe('fake');
      const matched = await setupIncidentWithUpload(ctx, video);
      await request(ctx.app).post(`/api/v1/submissions/${matched.submissionId}/analyze`).set(bearer(TOKENS.witness));
      await ctx.analysis.queue.onIdle();
      const a = await request(ctx.app).get(`/api/v1/submissions/${matched.submissionId}/analysis`).set(bearer(TOKENS.witness));
      expect(a.body.data).toMatchObject({ status: 'READY', source: 'PRERECORDED', result: { incidentDetected: true } });

      const other = await setupIncidentWithUpload(ctx, fakeMp4({ durationSec: 9, padBytes: 777 }));
      await request(ctx.app).post(`/api/v1/submissions/${other.submissionId}/analyze`).set(bearer(TOKENS.witness));
      await ctx.analysis.queue.onIdle();
      const b = await request(ctx.app).get(`/api/v1/submissions/${other.submissionId}/analysis`).set(bearer(TOKENS.witness));
      expect(b.body.data).toMatchObject({ status: 'READY', source: 'PRERECORDED', result: { incidentDetected: false, incidentTimestampSeconds: null } });
      expect(tl.calls).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});
