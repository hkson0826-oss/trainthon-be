import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisInput, AnalysisProvider, ProviderOutcome } from '../../src/modules/analysis/provider.js';
import { fakeMp4 } from '../helpers/fixtures.js';
import { PLACE_A, TOKENS, bearer, createTestContext, type TestContext } from '../helpers/testApp.js';

const VIDEO_BUCKET = 'evidence-videos';

/** Deterministic provider: detects unless the video is shorter than 10s. */
class ScriptedProvider implements AnalysisProvider {
  readonly kind = 'live' as const;
  async analyze(input: AnalysisInput): Promise<ProviderOutcome> {
    const detected = (input.submission.durationSec ?? 0) >= 10;
    return {
      source: 'LIVE',
      raw: { data: '{}' },
      parsed: {
        incidentDetected: detected,
        incidentTimestampSeconds: detected ? 12 : 0,
        victimVehicle: '흰색 세단',
        otherVehicle: detected ? '검은색 SUV' : null,
        event: detected ? '접촉 장면' : '없음',
        relevance: detected ? 'HIGH' : 'LOW',
        evidence: ['색상 일치'],
      },
      requestHash: 'h',
      promptVersion: 'v1',
      model: 'pegasus1.5',
    };
  }
}

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({}, {}, { provider: new ScriptedProvider() });
});
afterAll(async () => {
  await ctx.close();
});

async function readySubmission(durationSec = 20) {
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
  const incidentId = inc.body.data.id as string;
  const video = fakeMp4({ durationSec, padBytes: 2048 + Math.floor(Math.random() * 1000) });
  const sub = await request(ctx.app).post(`/api/v1/incidents/${incidentId}/submissions`).set(bearer(TOKENS.witness)).send({ mime: 'video/mp4', bytes: video.length });
  const submissionId = sub.body.data.submissionId as string;
  ctx.storage.put(VIDEO_BUCKET, sub.body.data.objectPath, video, 'video/mp4');
  expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/complete-upload`).set(bearer(TOKENS.witness))).status).toBe(200);
  expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/analyze`).set(bearer(TOKENS.witness))).status).toBe(202);
  await ctx.analysis.queue.onIdle();
  return { incidentId, submissionId };
}

describe('F8 insurer (mock) + F9 settlement/rewards', () => {
  it('S1 happy path: submit → REVIEWING/SUBMITTED/ADOPTION_PENDING → ADOPTED → PAYOUT_SCHEDULED + Y notifications + rewards', async () => {
    const { incidentId, submissionId } = await readySubmission();

    // before submit: settlement is DEPOSITED, Y cannot read it, X can
    const s0 = await request(ctx.app).get(`/api/v1/incidents/${incidentId}/settlement`).set(bearer(TOKENS.requester));
    expect(s0.status).toBe(200);
    expect(s0.body.data).toMatchObject({ status: 'DEPOSITED', depositAmount: 100_000, platformFee: 20_000, witnessReward: 80_000, mock: true });
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}/settlement`).set(bearer(TOKENS.witness))).status).toBe(404);

    // Y cannot submit; X can
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.witness))).status).toBe(403);
    const submit = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester));
    expect(submit.status).toBe(201);
    expect(submit.body.data).toMatchObject({ status: 'REVIEWING', mock: true, label: '데모 보험사 채택', integrity: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), submittedAt: expect.any(String) } });

    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.requester))).body.data.status).toBe('SUBMITTED');
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester))).body.data.status).toBe('REVIEWING');
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}/settlement`).set(bearer(TOKENS.requester))).body.data.status).toBe('ADOPTION_PENDING');
    // duplicate submit → 409 (already SUBMITTED)
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester))).status).toBe(409);

    // candidates now carry the insurer review
    const cands = await request(ctx.app).get(`/api/v1/incidents/${incidentId}/candidates`).set(bearer(TOKENS.requester));
    expect(cands.body.data[0]).toMatchObject({ status: 'SUBMITTED', insurerReview: { status: 'REVIEWING', mock: true } });

    // review visible to X, Y, OPERATOR; stranger 404
    for (const t of [TOKENS.requester, TOKENS.witness, TOKENS.operator]) {
      expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/insurer-review`).set(bearer(t))).status).toBe(200);
    }
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}/insurer-review`).set(bearer(TOKENS.stranger))).status).toBe(404);

    // decision: Y forbidden (404 – not their call), X allowed in DEMO_MODE, validation
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.witness)).send({ decision: 'ADOPTED' })).status).toBe(404);
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.requester)).send({ decision: 'MAYBE' })).status).toBe(400);
    const adopt = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.requester)).send({ decision: 'ADOPTED', note: '영상 확인' });
    expect(adopt.status).toBe(200);
    expect(adopt.body.data).toMatchObject({ status: 'ADOPTED', note: '영상 확인', mock: true, label: '데모 보험사 채택' });
    expect(adopt.body.data.settlement).toMatchObject({ status: 'PAYOUT_SCHEDULED', witnessReward: 80_000, mock: true });
    const scheduledAt = new Date(adopt.body.data.settlement.payoutScheduledAt).getTime();
    expect(scheduledAt - Date.now()).toBeGreaterThan(71 * 3600 * 1000); // DISPUTE_WINDOW_HOURS=72

    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.requester))).body.data.status).toBe('ADOPTED');
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester))).body.data.status).toBe('ADOPTED');

    // Y notifications: ADOPTION_UPDATED + REWARD_SCHEDULED, no requester identity
    const notes = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.witness));
    const mine = notes.body.data.filter((n: { incidentId: string }) => n.incidentId === incidentId).map((n: { type: string }) => n.type);
    expect(mine).toEqual(expect.arrayContaining(['ADOPTION_UPDATED', 'REWARD_SCHEDULED', 'WITNESS_REQUEST']));
    const reward = notes.body.data.find((n: { type: string; incidentId: string }) => n.type === 'REWARD_SCHEDULED' && n.incidentId === incidentId);
    expect(reward.body).toContain('80,000');
    expect(JSON.stringify(notes.body)).not.toContain('김피해');

    // Y rewards
    const rewards = await request(ctx.app).get('/api/v1/me/rewards').set(bearer(TOKENS.witness));
    expect(rewards.status).toBe(200);
    expect(rewards.body.data.find((r: { incidentId: string }) => r.incidentId === incidentId)).toMatchObject({
      submissionId,
      amount: 80_000,
      status: 'PAYOUT_SCHEDULED',
      scheduledAt: expect.any(String),
      mock: true,
    });
    expect((await request(ctx.app).get('/api/v1/me/rewards').set(bearer(TOKENS.requester))).status).toBe(403);

    // decisions are one-way
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.requester)).send({ decision: 'REJECTED' })).status).toBe(409);
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.operator)).send({ decision: 'ADOPTED' })).status).toBe(409);
  });

  it('REJECTED: submission REJECTED, incident back to COLLECTING, settlement back to DEPOSITED, Y notified', async () => {
    const { incidentId, submissionId } = await readySubmission();
    expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester))).status).toBe(201);
    const rej = await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.operator)).send({ decision: 'REJECTED', note: '장면 불명확' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    expect(rej.body.data.settlement.status).toBe('DEPOSITED');
    expect((await request(ctx.app).get(`/api/v1/submissions/${submissionId}`).set(bearer(TOKENS.requester))).body.data.status).toBe('REJECTED');
    expect((await request(ctx.app).get(`/api/v1/incidents/${incidentId}`).set(bearer(TOKENS.requester))).body.data.status).toBe('COLLECTING');
    const notes = await request(ctx.app).get('/api/v1/me/notifications').set(bearer(TOKENS.witness));
    const n = notes.body.data.find((x: { type: string; incidentId: string }) => x.type === 'ADOPTION_UPDATED' && x.incidentId === incidentId);
    expect(n.body).toContain('미채택');
    expect((await request(ctx.app).get('/api/v1/me/rewards').set(bearer(TOKENS.witness))).body.data.some((r: { incidentId: string }) => r.incidentId === incidentId)).toBe(false);
  });

  it('gating: not READY → 409; READY but incidentDetected=false → 409 NO_CANDIDATE; decision before submit → 409', async () => {
    const none = await readySubmission(5); // provider reports no detection
    const a = await request(ctx.app).get(`/api/v1/submissions/${none.submissionId}/analysis`).set(bearer(TOKENS.requester));
    expect(a.body.data.result.incidentDetected).toBe(false);
    const res = await request(ctx.app).post(`/api/v1/submissions/${none.submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('NO_CANDIDATE');

    expect((await request(ctx.app).post(`/api/v1/submissions/${none.submissionId}/insurer-decision`).set(bearer(TOKENS.operator)).send({ decision: 'ADOPTED' })).status).toBe(409);
    expect((await request(ctx.app).get(`/api/v1/submissions/${none.submissionId}/insurer-review`).set(bearer(TOKENS.requester))).status).toBe(404);

    // UPLOADED (not analysed) → 409
    await ctx.db.query(`update evidence_submissions set status = 'UPLOADED' where id = $1`, [none.submissionId]);
    expect((await request(ctx.app).post(`/api/v1/submissions/${none.submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester))).status).toBe(409);
  });

  it('DEMO_MODE=false: requester may not decide; OPERATOR still can', async () => {
    const strict = await createTestContext({ DEMO_MODE: 'false' }, {}, { provider: new ScriptedProvider() });
    try {
      const prev = ctx;
      ctx = strict;
      const { submissionId } = await readySubmission();
      expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester))).status).toBe(201);
      expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.requester)).send({ decision: 'ADOPTED' })).status).toBe(403);
      expect((await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.operator)).send({ decision: 'ADOPTED' })).status).toBe(200);
      ctx = prev;
    } finally {
      await strict.close();
    }
  });

  it('dedupe: payout can never be scheduled twice for the same incident', async () => {
    const { incidentId, submissionId } = await readySubmission();
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/submit-to-insurer`).set(bearer(TOKENS.requester));
    await request(ctx.app).post(`/api/v1/submissions/${submissionId}/insurer-decision`).set(bearer(TOKENS.operator)).send({ decision: 'ADOPTED' });
    const row = await ctx.db.query<{ dedupe_key: string; status: string }>('select dedupe_key, status from settlements where incident_id = $1', [incidentId]);
    expect(row.rows[0]).toEqual({ dedupe_key: `${incidentId}:${submissionId}`, status: 'PAYOUT_SCHEDULED' });
    // a second schedule attempt is a no-op (guarded by dedupe_key IS NULL)
    const again = await ctx.db.query(
      `update settlements set status = 'PAYOUT_SCHEDULED' where incident_id = $1 and status in ('DEPOSITED','ADOPTION_PENDING') and dedupe_key is null returning id`,
      [incidentId],
    );
    expect(again.rows).toHaveLength(0);
  });
});
