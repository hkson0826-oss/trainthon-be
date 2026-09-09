import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { formatKrw, renderCopy } from '../../lib/copy.ko.js';
import { many, one, type Db, type Queryable } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { created, ok } from '../../lib/response.js';
import { currentUser, requireRole } from '../../middleware/auth.js';
import { findAnalysisBySubmission } from '../analysis/repo.js';
import { findIncident, updateIncidentStatus } from '../incidents/repo.js';
import { loadIncidentForViewer } from '../incidents/router.js';
import { insertNotification } from '../notifications/index.js';
import {
  findSettlementByIncident,
  listRewardsForWitness,
  markAdoptionPending,
  revertToDeposited,
  schedulePayout,
  toSettlementDto,
} from '../settlement/repo.js';
import { findSubmission, transitionSubmission } from '../submissions/repo.js';
import { loadSubmissionForViewer } from '../submissions/router.js';

export type InsurerReviewStatus = 'REVIEWING' | 'ADOPTED' | 'REJECTED';

export interface InsurerReviewRow {
  id: string;
  submission_id: string;
  incident_id: string;
  status: InsurerReviewStatus;
  submitted_by: string | null;
  submitted_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  note: string | null;
  evidence_sha256: string | null;
  created_at: Date;
  updated_at: Date;
}

export const INSURER_MOCK_LABEL = '데모 보험사 채택';

export function toInsurerReviewDto(r: InsurerReviewRow) {
  return {
    id: r.id,
    submissionId: r.submission_id,
    incidentId: r.incident_id,
    status: r.status,
    submittedAt: r.submitted_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    note: r.note,
    integrity: { sha256: r.evidence_sha256, submittedAt: r.submitted_at.toISOString() },
    mock: true as const,
    label: INSURER_MOCK_LABEL,
  };
}

export async function findInsurerReviewBySubmission(q: Queryable, submissionId: string): Promise<InsurerReviewRow | null> {
  return one<InsurerReviewRow>(q, 'select * from insurer_reviews where submission_id = $1', [submissionId]);
}

export async function listInsurerReviewsByIncident(q: Queryable, incidentId: string): Promise<InsurerReviewRow[]> {
  return many<InsurerReviewRow>(q, 'select * from insurer_reviews where incident_id = $1 order by submitted_at asc', [incidentId]);
}

/** Hook for F7 candidates: review summary or null. */
export async function insurerReviewSummary(q: Queryable, submissionId: string) {
  const r = await findInsurerReviewBySubmission(q, submissionId);
  return r ? toInsurerReviewDto(r) : null;
}

export interface InsurerDeps {
  env: Env;
  db: Db;
}

const decisionSchema = z.object({ decision: z.enum(['ADOPTED', 'REJECTED']), note: z.string().trim().max(500).optional() }).strict();

export function insurerRouter(deps: InsurerDeps): Router {
  const r = Router();
  const { db, env } = deps;

  // F8: X submits a READY + incidentDetected candidate to the (mock) insurer.
  r.post('/submissions/:id/submit-to-insurer', requireRole('REQUESTER', 'OPERATOR'), async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission, incident, access } = await loadSubmissionForViewer(db, id, user);
      if (access === 'WITNESS') throw ApiError.notFound('Submission not found');

      const review = await db.transaction(async (tx) => {
        const current = await findSubmission(tx, submission.id);
        if (!current) throw ApiError.notFound('Submission not found');
        if (current.status !== 'READY') throw ApiError.invalidState(`Submission is ${current.status}; only READY submissions can be submitted`);
        const analysis = await findAnalysisBySubmission(tx, current.id);
        if (!analysis || analysis.status !== 'READY' || !analysis.result?.incidentDetected) {
          throw ApiError.invalidState('NO_CANDIDATE: analysis found no incident scene in this submission');
        }
        const existing = await findInsurerReviewBySubmission(tx, current.id);
        if (existing) throw new ApiError('ALREADY_EXISTS', `Already submitted (status ${existing.status})`);

        const row = await one<InsurerReviewRow>(
          tx,
          `insert into insurer_reviews (submission_id, incident_id, status, submitted_by, evidence_sha256)
           values ($1, $2, 'REVIEWING', $3, $4) returning *`,
          [current.id, incident.id, user.id, current.sha256],
        );
        if (!row) throw new Error('insert insurer_reviews returned no row');
        const moved = await transitionSubmission(tx, current.id, ['READY'], 'SUBMITTED');
        if (!moved) throw ApiError.invalidState('Submission state changed concurrently');
        await updateIncidentStatus(tx, incident.id, ['OPEN', 'COLLECTING'], 'REVIEWING');
        await markAdoptionPending(tx, incident.id);
        await audit(tx, {
          actorId: user.id,
          action: 'insurer.submit',
          targetType: 'submission',
          targetId: current.id,
          metadata: { incidentId: incident.id, sha256: current.sha256, mock: true },
        });
        return row;
      });
      created(res, toInsurerReviewDto(review));
    } catch (err) {
      next(err);
    }
  });

  // F8: human decision. OPERATOR always; the incident's requester only in DEMO_MODE (presenter plays the insurer).
  r.post('/submissions/:id/insurer-decision', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const body = decisionSchema.parse(req.body);
      const { submission, incident, access } = await loadSubmissionForViewer(db, id, user);
      if (access === 'WITNESS') throw ApiError.notFound('Submission not found');
      if (user.role !== 'OPERATOR' && !(env.DEMO_MODE && incident.requester_id === user.id)) {
        throw ApiError.forbiddenRole('Insurer decisions require OPERATOR (or the requester in DEMO_MODE)');
      }

      const result = await db.transaction(async (tx) => {
        const review = await one<InsurerReviewRow>(
          tx,
          `update insurer_reviews set status = $2, note = $3, decided_at = now(), decided_by = $4, updated_at = now()
            where submission_id = $1 and status = 'REVIEWING' returning *`,
          [submission.id, body.decision, body.note ?? null, user.id],
        );
        if (!review) {
          const existing = await findInsurerReviewBySubmission(tx, submission.id);
          if (!existing) throw ApiError.invalidState('Submission has not been submitted to the insurer');
          throw ApiError.invalidState(`Decision already made: ${existing.status}`);
        }

        let settlement = null;
        if (body.decision === 'ADOPTED') {
          await transitionSubmission(tx, submission.id, ['SUBMITTED'], 'ADOPTED');
          await updateIncidentStatus(tx, incident.id, ['REVIEWING', 'COLLECTING', 'OPEN'], 'ADOPTED');
          settlement = await schedulePayout(tx, {
            incidentId: incident.id,
            submissionId: submission.id,
            witnessId: submission.witness_id,
            disputeWindowHours: env.DISPUTE_WINDOW_HOURS,
          });
          if (!settlement) settlement = await findSettlementByIncident(tx, incident.id);
          const adoption = renderCopy('ADOPTION_UPDATED', { decisionLabel: '채택' });
          await insertNotification(tx, { userId: submission.witness_id, type: 'ADOPTION_UPDATED', incidentId: incident.id, submissionId: submission.id, ...adoption });
          if (settlement) {
            const reward = renderCopy('REWARD_SCHEDULED', { place: incident.place_name, amount: formatKrw(settlement.witness_reward) });
            await insertNotification(tx, { userId: submission.witness_id, type: 'REWARD_SCHEDULED', incidentId: incident.id, submissionId: submission.id, ...reward });
          }
        } else {
          await transitionSubmission(tx, submission.id, ['SUBMITTED'], 'REJECTED');
          await updateIncidentStatus(tx, incident.id, ['REVIEWING'], 'COLLECTING');
          settlement = await revertToDeposited(tx, incident.id);
          const rejection = renderCopy('ADOPTION_UPDATED', { decisionLabel: '미채택' });
          await insertNotification(tx, { userId: submission.witness_id, type: 'ADOPTION_UPDATED', incidentId: incident.id, submissionId: submission.id, ...rejection });
        }
        await audit(tx, {
          actorId: user.id,
          action: 'insurer.decision',
          targetType: 'submission',
          targetId: submission.id,
          metadata: { decision: body.decision, incidentId: incident.id, mock: true },
        });
        return { review, settlement };
      });
      ok(res, { ...toInsurerReviewDto(result.review), settlement: result.settlement ? toSettlementDto(result.settlement) : null });
    } catch (err) {
      next(err);
    }
  });

  r.get('/submissions/:id/insurer-review', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission } = await loadSubmissionForViewer(db, id, user);
      const review = await findInsurerReviewBySubmission(db, submission.id);
      if (!review) throw ApiError.notFound('Not submitted to the insurer yet');
      ok(res, toInsurerReviewDto(review));
    } catch (err) {
      next(err);
    }
  });

  // F9
  r.get('/incidents/:id/settlement', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { incident, access } = await loadIncidentForViewer(db, id, user);
      if (access !== 'OWNER') throw ApiError.notFound('Incident not found');
      const settlement = await findSettlementByIncident(db, incident.id);
      if (!settlement) throw ApiError.notFound('No settlement for this incident');
      ok(res, toSettlementDto(settlement));
    } catch (err) {
      next(err);
    }
  });

  r.get('/me/rewards', requireRole('WITNESS'), async (req, res, next) => {
    try {
      const user = currentUser(req);
      const rows = await listRewardsForWitness(db, user.id);
      ok(
        res,
        rows.map((s) => ({
          incidentId: s.incident_id,
          submissionId: s.payout_submission_id,
          placeName: s.place_name,
          amount: s.witness_reward,
          status: s.status,
          scheduledAt: s.payout_scheduled_at ? s.payout_scheduled_at.toISOString() : null,
          mock: true as const,
          label: '데모: 실제 송금 없음',
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  return r;
}
