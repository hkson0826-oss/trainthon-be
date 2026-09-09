import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import type { Db, Queryable } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { ffprobeInfo } from '../../lib/ffprobe.js';
import { isMp4, readMp4Info, type Mp4Info } from '../../lib/mp4.js';
import { created, ok } from '../../lib/response.js';
import { currentUser, requireRole, type AuthedUser } from '../../middleware/auth.js';
import { findIncident, updateIncidentStatus, type IncidentWithPlace } from '../incidents/repo.js';
import type { SubmissionSummary } from '../incidents/router.js';
import { wasNotifiedForIncident } from '../notifications/index.js';
import {
  countSubmissions,
  findSubmission,
  findSubmissionByIncidentAndWitness,
  insertSubmission,
  listSubmissionsByIncident,
  markUploaded,
  resetForReupload,
  type SubmissionRow,
} from './repo.js';

export interface SubmissionsDeps {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  /** Filled by the analysis module (F6): summary of the submission's analysis for DTOs. */
  analysisSummary?: (q: Queryable, submissionId: string) => Promise<unknown | null>;
}

const MIN_VIDEO_DIMENSION = 360;
const VIEWABLE_BY_REQUESTER: readonly string[] = ['READY', 'SUBMITTED', 'ADOPTED', 'REJECTED'];

const createSchema = z
  .object({
    mime: z.string().min(1).max(100),
    bytes: z.number().int().positive(),
    durationSec: z.number().positive().max(24 * 3600).optional(),
    recordedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export function submissionObjectPath(incidentId: string, submissionId: string): string {
  return `incidents/${incidentId}/submissions/${submissionId}/original.mp4`;
}

export function toSubmissionDto(s: SubmissionRow, viewer: AuthedUser, analysis: unknown | null = null) {
  const isOwner = s.witness_id === viewer.id;
  return {
    id: s.id,
    incidentId: s.incident_id,
    status: s.status,
    mime: s.mime,
    bytes: Number(s.bytes),
    durationSec: s.duration_sec,
    width: s.width,
    height: s.height,
    sha256: s.sha256,
    recordedAt: s.recorded_at ? s.recorded_at.toISOString() : null,
    uploadCompletedAt: s.upload_completed_at ? s.upload_completed_at.toISOString() : null,
    objectPath: isOwner || viewer.role === 'OPERATOR' ? s.object_path : undefined,
    witness: isOwner ? { self: true as const } : { maskedId: '제보자 #1', self: false as const },
    redactionApplied: false as const,
    humanReviewed: false as const,
    analysis,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
  };
}

export type SubmissionAccess = 'WITNESS' | 'REQUESTER' | 'OPERATOR';

/** Witness owner, the incident's requester and OPERATOR may see a submission; everyone else gets 404. */
export async function loadSubmissionForViewer(
  q: Queryable,
  id: string,
  viewer: AuthedUser,
): Promise<{ submission: SubmissionRow; incident: IncidentWithPlace; access: SubmissionAccess }> {
  const submission = await findSubmission(q, id);
  if (!submission) throw ApiError.notFound('Submission not found');
  const incident = await findIncident(q, submission.incident_id);
  if (!incident) throw ApiError.notFound('Submission not found');
  let access: SubmissionAccess | null = null;
  if (submission.witness_id === viewer.id) access = 'WITNESS';
  else if (viewer.role === 'OPERATOR') access = 'OPERATOR';
  else if (incident.requester_id === viewer.id) access = 'REQUESTER';
  if (!access) throw ApiError.notFound('Submission not found');
  return { submission, incident, access };
}

function validateDeclared(env: Env, body: z.infer<typeof createSchema>): void {
  if (body.mime !== 'video/mp4') throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Only video/mp4 is accepted');
  if (body.bytes > env.MAX_VIDEO_BYTES) throw new ApiError('FILE_TOO_LARGE', `Video exceeds ${env.MAX_VIDEO_BYTES} bytes`);
  if (body.durationSec !== undefined) {
    if (body.durationSec < env.MIN_VIDEO_SECONDS) throw new ApiError('VIDEO_UNANALYZABLE', `Video must be at least ${env.MIN_VIDEO_SECONDS} seconds`);
    if (body.durationSec > env.MAX_VIDEO_SECONDS) throw new ApiError('VIDEO_UNANALYZABLE', `Video must be at most ${env.MAX_VIDEO_SECONDS} seconds`);
  }
}

function validateProbed(env: Env, info: Mp4Info): void {
  if (info.durationSec !== null) {
    if (info.durationSec < env.MIN_VIDEO_SECONDS) throw new ApiError('VIDEO_UNANALYZABLE', `Video must be at least ${env.MIN_VIDEO_SECONDS} seconds (got ${info.durationSec.toFixed(1)})`);
    if (info.durationSec > env.MAX_VIDEO_SECONDS) throw new ApiError('VIDEO_UNANALYZABLE', `Video must be at most ${env.MAX_VIDEO_SECONDS} seconds`);
  }
  if (info.width !== null && info.height !== null && (info.width < MIN_VIDEO_DIMENSION || info.height < MIN_VIDEO_DIMENSION)) {
    throw new ApiError('VIDEO_UNANALYZABLE', `Video resolution must be at least ${MIN_VIDEO_DIMENSION}x${MIN_VIDEO_DIMENSION}`);
  }
}

export function submissionSummaryProvider() {
  return async (q: Queryable, incidentId: string, viewerId: string): Promise<SubmissionSummary> => {
    const counts = await countSubmissions(q, incidentId);
    const mine = await findSubmissionByIncidentAndWitness(q, incidentId, viewerId);
    return { total: counts.total, ready: counts.ready, mySubmissionId: mine?.id ?? null };
  };
}

export function submissionsRouter(deps: SubmissionsDeps): Router {
  const r = Router();
  const { db, env, storage } = deps;
  const analysisOf = deps.analysisSummary ?? (async () => null);

  r.post('/incidents/:id/submissions', requireRole('WITNESS'), async (req, res, next) => {
    try {
      const user = currentUser(req);
      const incidentId = z.string().uuid().parse(req.params.id);
      const body = createSchema.parse(req.body);
      validateDeclared(env, body);

      const incident = await findIncident(db, incidentId);
      if (!incident || !(await wasNotifiedForIncident(db, user.id, incidentId))) throw ApiError.notFound('Incident not found');
      if (!['OPEN', 'COLLECTING'].includes(incident.status)) throw ApiError.invalidState(`Incident is ${incident.status}; no longer collecting evidence`);

      const recordedAt = body.recordedAt ? new Date(body.recordedAt) : null;
      const durationSec = body.durationSec ?? null;
      const existing = await findSubmissionByIncidentAndWitness(db, incidentId, user.id);
      let submission: SubmissionRow;
      let isNew = false;
      if (existing) {
        const reset = await resetForReupload(db, existing.id, body.bytes, durationSec, recordedAt);
        if (!reset) throw new ApiError('ALREADY_EXISTS', `You already submitted evidence for this incident (status ${existing.status})`);
        submission = reset;
        await storage.remove(env.SUPABASE_BUCKET_VIDEOS, [existing.object_path]).catch(() => undefined);
      } else {
        const id = randomUUID();
        submission = await insertSubmission(db, {
          id,
          incidentId,
          witnessId: user.id,
          objectPath: submissionObjectPath(incidentId, id),
          mime: body.mime,
          declaredBytes: body.bytes,
          durationSec,
          recordedAt,
        });
        isNew = true;
      }

      const signed = await storage.createSignedUploadUrl(env.SUPABASE_BUCKET_VIDEOS, submission.object_path, env.UPLOAD_SIGNED_URL_TTL_SEC);
      await audit(db, {
        actorId: user.id,
        action: isNew ? 'submission.create' : 'submission.reupload_url',
        targetType: 'submission',
        targetId: submission.id,
        metadata: { incidentId, declaredBytes: body.bytes },
      });
      const payload = {
        submissionId: submission.id,
        incidentId,
        status: submission.status,
        objectPath: submission.object_path,
        uploadUrl: signed.signedUrl,
        token: signed.token,
        expiresAt: signed.expiresAt.toISOString(),
        limits: { maxBytes: env.MAX_VIDEO_BYTES, minSeconds: env.MIN_VIDEO_SECONDS, maxSeconds: env.MAX_VIDEO_SECONDS, mime: 'video/mp4' },
      };
      if (isNew) created(res, payload);
      else ok(res, payload);
    } catch (err) {
      next(err);
    }
  });

  r.post('/submissions/:id/complete-upload', requireRole('WITNESS'), async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission, access } = await loadSubmissionForViewer(db, id, user);
      if (access !== 'WITNESS') throw ApiError.notFound('Submission not found');
      if (!['UPLOADING', 'ANALYSIS_FAILED'].includes(submission.status)) {
        throw ApiError.invalidState(`Submission is ${submission.status}; upload already completed`);
      }

      const info = await storage.getObjectInfo(env.SUPABASE_BUCKET_VIDEOS, submission.object_path);
      if (!info || info.size <= 0) throw ApiError.invalidState('UPLOAD_NOT_FOUND: no object at the signed upload path yet');
      if (info.size > env.MAX_VIDEO_BYTES) throw new ApiError('FILE_TOO_LARGE', `Video exceeds ${env.MAX_VIDEO_BYTES} bytes`);

      const data = await storage.download(env.SUPABASE_BUCKET_VIDEOS, submission.object_path);
      if (data.length > env.MAX_VIDEO_BYTES) throw new ApiError('FILE_TOO_LARGE', `Video exceeds ${env.MAX_VIDEO_BYTES} bytes`);
      if (!isMp4(data)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Uploaded file is not an MP4 container');

      let probed: Mp4Info = readMp4Info(data);
      if (env.VIDEO_PROBE_ENABLED) {
        const ff = await ffprobeInfo(data, env.FFPROBE_PATH);
        if (ff) probed = { durationSec: ff.durationSec ?? probed.durationSec, width: ff.width ?? probed.width, height: ff.height ?? probed.height };
      }
      const effective: Mp4Info = { ...probed, durationSec: probed.durationSec ?? submission.duration_sec };
      validateProbed(env, effective);

      const sha256 = createHash('sha256').update(data).digest('hex');
      const updated = await db.transaction(async (tx) => {
        const row = await markUploaded(tx, submission.id, { bytes: data.length, sha256, durationSec: probed.durationSec, width: probed.width, height: probed.height });
        if (!row) throw ApiError.invalidState('Submission state changed during upload completion');
        await updateIncidentStatus(tx, submission.incident_id, ['OPEN'], 'COLLECTING');
        await audit(tx, {
          actorId: user.id,
          action: 'submission.upload_complete',
          targetType: 'submission',
          targetId: submission.id,
          metadata: { bytes: data.length, sha256, durationSec: effective.durationSec, width: probed.width, height: probed.height },
        });
        return row;
      });
      ok(res, toSubmissionDto(updated, user, await analysisOf(db, updated.id)));
    } catch (err) {
      next(err);
    }
  });

  r.get('/submissions/:id', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission } = await loadSubmissionForViewer(db, id, user);
      ok(res, toSubmissionDto(submission, user, await analysisOf(db, submission.id)));
    } catch (err) {
      next(err);
    }
  });

  r.get('/submissions/:id/video-url', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission, access } = await loadSubmissionForViewer(db, id, user);
      if (submission.status === 'UPLOADING') throw ApiError.invalidState('Upload not completed');
      if (access === 'REQUESTER' && !VIEWABLE_BY_REQUESTER.includes(submission.status)) {
        // Original footage is not shown to the requester before analysis candidates exist.
        throw ApiError.notFound('Submission not found');
      }
      const url = await storage.createSignedUrl(env.SUPABASE_BUCKET_VIDEOS, submission.object_path, env.VIDEO_SIGNED_URL_TTL_SEC);
      await audit(db, {
        actorId: user.id,
        action: 'video.signed_url',
        targetType: 'submission',
        targetId: submission.id,
        metadata: { access, ttlSec: env.VIDEO_SIGNED_URL_TTL_SEC },
      });
      ok(res, { url, expiresAt: new Date(Date.now() + env.VIDEO_SIGNED_URL_TTL_SEC * 1000).toISOString(), mime: submission.mime, sha256: submission.sha256 });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

export { listSubmissionsByIncident };
