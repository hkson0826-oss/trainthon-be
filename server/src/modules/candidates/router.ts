import { Router } from 'express';
import { z } from 'zod';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import type { Db, Queryable } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { ok } from '../../lib/response.js';
import { currentUser } from '../../middleware/auth.js';
import { findAnalysesBySubmissions, type AnalysisRow } from '../analysis/repo.js';
import { loadIncidentForViewer } from '../incidents/router.js';
import { listSubmissionsByIncident, type SubmissionRow } from '../submissions/repo.js';

export interface CandidatesDeps {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  logger?: Logger;
  /** Filled by the insurer module (F8): review summary for a submission, or null. */
  insurerReview?: (q: Queryable, submissionId: string) => Promise<unknown | null>;
}

/** Submission states in which a READY analysis has been produced (F5 §4.2, READY and later). */
export const CANDIDATE_STATUSES: readonly string[] = ['READY', 'SUBMITTED', 'ADOPTED', 'REJECTED'];

export function isCandidate(s: SubmissionRow, a: AnalysisRow | undefined): a is AnalysisRow {
  return !!a && CANDIDATE_STATUSES.includes(s.status) && a.status === 'READY' && a.result?.incidentDetected === true;
}

export function candidatesRouter(deps: CandidatesDeps): Router {
  const r = Router();
  const { db, env, storage } = deps;

  r.get('/incidents/:id/candidates', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { incident, access } = await loadIncidentForViewer(db, id, user);
      // Y (notified witness) can read the incident summary but never other witnesses' candidates.
      if (access !== 'OWNER') throw ApiError.notFound('Incident not found');

      const submissions = await listSubmissionsByIncident(db, incident.id);
      const analyses = await findAnalysesBySubmissions(db, submissions.map((s) => s.id));

      const items = [];
      let witnessIndex = 0;
      let noCandidateCount = 0;
      for (const s of submissions) {
        const a = analyses.get(s.id);
        if (a?.status === 'READY' && a.result && !a.result.incidentDetected) noCandidateCount++;
        if (!isCandidate(s, a)) continue;
        witnessIndex++;
        const videoUrl = await storage.createSignedUrl(env.SUPABASE_BUCKET_VIDEOS, s.object_path, env.VIDEO_SIGNED_URL_TTL_SEC).catch((err: unknown) => {
          deps.logger?.warn({ err, submissionId: s.id }, 'candidate video signed URL failed');
          return null;
        });
        if (videoUrl) {
          await audit(db, {
            actorId: user.id,
            action: 'video.signed_url',
            targetType: 'submission',
            targetId: s.id,
            metadata: { access: 'CANDIDATES', ttlSec: env.VIDEO_SIGNED_URL_TTL_SEC },
          });
        }
        items.push({
          submissionId: s.id,
          status: s.status,
          analysis: {
            id: a.id,
            source: a.source,
            result: a.result,
            model: a.model,
            promptVersion: a.prompt_version,
            finishedAt: a.finished_at ? a.finished_at.toISOString() : null,
          },
          videoUrl,
          video: { url: videoUrl, mime: s.mime, durationSec: s.duration_sec, sha256: s.sha256, expiresAt: videoUrl ? new Date(Date.now() + env.VIDEO_SIGNED_URL_TTL_SEC * 1000).toISOString() : null },
          witness: { maskedId: `제보자 #${witnessIndex}` },
          insurerReview: deps.insurerReview ? await deps.insurerReview(db, s.id) : null,
          humanReviewed: false as const,
          uploadCompletedAt: s.upload_completed_at ? s.upload_completed_at.toISOString() : null,
        });
      }
      ok(res, items, 200, { noCandidateCount, total: submissions.length });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
