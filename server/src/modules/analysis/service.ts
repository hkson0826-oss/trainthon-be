import { ProviderError, type ProviderErrorCode } from '../../adapters/twelvelabs/client.js';
import { parseTimestampSeconds, type AnalysisResult } from '../../adapters/twelvelabs/schema.js';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { AI_DISCLAIMER, formatTimestampLabel, renderCopy } from '../../lib/copy.ko.js';
import type { Db, Queryable } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { AuthedUser } from '../../middleware/auth.js';
import { findIncident, listPhotos } from '../incidents/repo.js';
import { insertNotification } from '../notifications/index.js';
import { findSubmission, transitionSubmission, type SubmissionRow } from '../submissions/repo.js';
import type { PrerecordedStore } from './prerecorded.js';
import type { AnalysisProvider, ProviderOutcome } from './provider.js';
import {
  bumpAttempt,
  enqueueAnalysis,
  findAnalysisBySubmission,
  findStaleInFlight,
  IN_FLIGHT,
  markAnalyzing,
  markFailed,
  markFinalizing,
  markReady,
  type AnalysisRow,
} from './repo.js';

export interface AnalysisDeps {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  provider: AnalysisProvider;
  prerecorded: PrerecordedStore;
  logger: Logger;
  /** Called after the DB row is QUEUED; the queue runs `runAnalysis` for the id. */
  enqueue: (analysisId: string) => void;
}

const RETRYABLE: readonly ProviderErrorCode[] = ['INVALID_RESPONSE', 'PROVIDER_UNAVAILABLE'];
const FALLBACK_ELIGIBLE: readonly ProviderErrorCode[] = ['PROVIDER_UNAVAILABLE', 'TIMEOUT'];
const MIN_CALL_BUDGET_MS = 5_000;

export function toAnalysisDto(a: AnalysisRow) {
  return {
    id: a.id,
    submissionId: a.submission_id,
    status: a.status,
    source: a.source,
    result: a.result,
    error: a.error_code ? { code: a.error_code, message: a.error_message } : null,
    attempts: a.attempts,
    model: a.model,
    promptVersion: a.prompt_version,
    provider: a.provider,
    startedAt: a.started_at ? a.started_at.toISOString() : null,
    finishedAt: a.finished_at ? a.finished_at.toISOString() : null,
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at.toISOString(),
  };
}

/**
 * F6 step 1: creates (or re-queues) the analysis for a submission and moves the submission to
 * ANALYZING. Idempotent for concurrent calls: an in-flight analysis is returned unchanged.
 */
export async function requestAnalysis(
  deps: AnalysisDeps,
  submission: SubmissionRow,
  user: AuthedUser,
  opts: { retryOnly?: boolean } = {},
): Promise<{ analysis: AnalysisRow; existing: boolean }> {
  const { db, env } = deps;
  const outcome = await db.transaction(async (tx) => {
    const current = await findSubmission(tx, submission.id);
    if (!current) throw ApiError.notFound('Submission not found');
    const existing = await findAnalysisBySubmission(tx, current.id);
    if (existing && IN_FLIGHT.includes(existing.status)) return { analysis: existing, existing: true };
    if (opts.retryOnly && existing?.status !== 'FAILED') {
      throw ApiError.invalidState(`Retry is only allowed for FAILED analyses (current: ${existing?.status ?? 'none'})`);
    }
    if (!['UPLOADED', 'ANALYSIS_FAILED'].includes(current.status)) {
      throw ApiError.invalidState(`Submission is ${current.status}; analysis can start from UPLOADED or ANALYSIS_FAILED`);
    }
    const analysis = await enqueueAnalysis(tx, {
      submissionId: current.id,
      model: env.TWELVELABS_MODEL,
      promptVersion: env.ANALYSIS_PROMPT_VERSION,
      requestedBy: user.id,
    });
    if (!analysis) throw ApiError.invalidState('Analysis already in progress');
    const moved = await transitionSubmission(tx, current.id, ['UPLOADED', 'ANALYSIS_FAILED'], 'ANALYZING');
    if (!moved) throw ApiError.invalidState('Submission state changed concurrently');
    await audit(tx, {
      actorId: user.id,
      action: existing ? 'analysis.retry' : 'analysis.request',
      targetType: 'analysis',
      targetId: analysis.id,
      metadata: { submissionId: current.id, attemptsSoFar: analysis.attempts },
    });
    return { analysis, existing: false };
  });
  if (!outcome.existing) deps.enqueue(outcome.analysis.id);
  return outcome;
}

/** Worker body (F6 steps 2-8). Safe to call for any id: no-ops unless the row is QUEUED. */
export async function runAnalysis(deps: AnalysisDeps, analysisId: string): Promise<void> {
  const { db, env, logger } = deps;
  const analysis = await markAnalyzing(db, analysisId);
  if (!analysis) return;
  const deadline = Date.now() + env.ANALYSIS_TIMEOUT_MS;
  const log = logger.child({ analysisId, submissionId: analysis.submission_id });

  try {
    const submission = await findSubmission(db, analysis.submission_id);
    if (!submission || !submission.sha256) throw new ProviderError('PROVIDER_REJECTED', 'Submission has no completed upload');
    const incident = await findIncident(db, submission.incident_id);
    if (!incident) throw new ProviderError('PROVIDER_REJECTED', 'Incident not found for submission');

    const outcome = await callProviderWithRetries(deps, analysis, submission, incident, deadline, log);
    if (!outcome.ok) {
      await failAnalysis(deps, analysis.id, submission.id, outcome.error.code, outcome.error.message, outcome.error.details);
      return;
    }

    if (!(await markFinalizing(db, analysis.id))) return; // swept meanwhile
    const result = normalizeResult(outcome.value, submission);
    if (!result.ok) {
      await failAnalysis(deps, analysis.id, submission.id, 'INVALID_RESPONSE', result.error, outcome.value.raw);
      return;
    }

    await db.transaction(async (tx) => {
      const ready = await markReady(tx, analysis.id, {
        source: outcome.value.source,
        raw: outcome.value.raw,
        result: result.value,
        model: outcome.value.model,
        promptVersion: outcome.value.promptVersion,
      });
      if (!ready) throw new Error('analysis no longer finalizing');
      await transitionSubmission(tx, submission.id, ['ANALYZING'], 'READY');
      await notifyRequester(tx, incident.requester_id, incident.id, submission.id, incident.place_name, result.value);
      await audit(tx, {
        actorId: null,
        action: 'analysis.ready',
        targetType: 'analysis',
        targetId: analysis.id,
        metadata: { source: outcome.value.source, incidentDetected: result.value.incidentDetected, attempts: analysis.attempts + 1 },
      });
    });
    log.info({ source: outcome.value.source, incidentDetected: result.value.incidentDetected }, 'analysis ready');
  } catch (err) {
    const code: ProviderErrorCode = err instanceof ProviderError ? err.code : 'PROVIDER_UNAVAILABLE';
    log.error({ err, code }, 'analysis failed unexpectedly');
    await failAnalysis(deps, analysis.id, analysis.submission_id, code, err instanceof Error ? err.message : 'unknown error').catch((e: unknown) =>
      log.error({ err: e }, 'failed to record analysis failure'),
    );
  }
}

type CallOutcome = { ok: true; value: ProviderOutcome } | { ok: false; error: { code: ProviderErrorCode; message: string; details?: unknown } };

async function callProviderWithRetries(
  deps: AnalysisDeps,
  analysis: AnalysisRow,
  submission: SubmissionRow,
  incident: NonNullable<Awaited<ReturnType<typeof findIncident>>>,
  deadline: number,
  log: Logger,
): Promise<CallOutcome> {
  const { db, env, storage, provider, prerecorded } = deps;
  const bucket = env.SUPABASE_BUCKET_VIDEOS;
  const signedTtl = Math.max(env.VIDEO_SIGNED_URL_TTL_SEC, Math.ceil(env.ANALYSIS_TIMEOUT_MS / 1000) + 60);

  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= env.ANALYSIS_MAX_ATTEMPTS; attempt++) {
    const budget = deadline - Date.now();
    if (budget < MIN_CALL_BUDGET_MS) {
      lastError = new ProviderError('TIMEOUT', `Analysis budget of ${env.ANALYSIS_TIMEOUT_MS}ms exhausted`);
      break;
    }
    try {
      const videoUrl = await storage.createSignedUrl(bucket, submission.object_path, signedTtl);
      const photos = env.ANALYSIS_USE_REFERENCE_IMAGES ? await listPhotos(db, incident.id) : [];
      const photoUrls = await Promise.all(photos.map((p) => storage.createSignedUrl(env.SUPABASE_BUCKET_PHOTOS, p.object_path, signedTtl)));
      const outcome = await provider.analyze(
        {
          submission: { id: submission.id, sha256: submission.sha256 ?? '', bytes: Number(submission.bytes), durationSec: submission.duration_sec },
          incident: {
            placeName: incident.place_name,
            occurredFrom: incident.occurred_from,
            occurredTo: incident.occurred_to,
            vehicleColor: incident.vehicle_color,
            vehicleModel: incident.vehicle_model,
            damageArea: incident.damage_area,
            description: incident.description,
          },
          videoUrl,
          loadVideo: () => storage.download(bucket, submission.object_path),
          photoUrls,
        },
        budget,
      );
      await bumpAttempt(db, analysis.id, outcome.requestHash);
      return { ok: true, value: outcome };
    } catch (err) {
      const perr = err instanceof ProviderError ? err : new ProviderError('PROVIDER_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      await bumpAttempt(db, analysis.id, null);
      lastError = perr;
      log.warn({ attempt, code: perr.code, message: perr.message }, 'provider call failed');
      if (!RETRYABLE.includes(perr.code)) break;
    }
  }

  const error = lastError ?? new ProviderError('PROVIDER_UNAVAILABLE', 'provider produced no result');
  if (env.PRERECORDED_FALLBACK_ENABLED && FALLBACK_ELIGIBLE.includes(error.code) && submission.sha256) {
    const fixture = prerecorded.findBySha256(submission.sha256);
    if (fixture) {
      log.warn({ code: error.code, fixture: fixture.file }, 'provider unavailable; using PRERECORDED fixture matched by sha256');
      return {
        ok: true,
        value: {
          source: 'PRERECORDED',
          raw: fixture.rawResponse ?? { fixture: fixture.file, fallbackFor: error.code },
          parsed: {
            incidentDetected: fixture.result.incidentDetected,
            incidentTimestampSeconds: fixture.result.incidentTimestampSeconds ?? 0,
            victimVehicle: fixture.result.victimVehicle,
            otherVehicle: fixture.result.otherVehicle,
            event: fixture.result.event,
            relevance: fixture.result.relevance,
            evidence: fixture.result.evidence,
          },
          requestHash: null,
          promptVersion: fixture.promptVersion,
          model: fixture.model,
        },
      };
    }
  }
  return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
}

/** F6 step 6: server-side normalisation and sanity checks of the provider result. */
export function normalizeResult(outcome: ProviderOutcome, submission: { duration_sec: number | null }): { ok: true; value: AnalysisResult } | { ok: false; error: string } {
  const p = outcome.parsed;
  const duration = submission.duration_sec;
  let ts: number | null = null;
  if (p.incidentDetected) {
    ts = parseTimestampSeconds(p.incidentTimestampSeconds);
    if (ts === null || ts < 0) return { ok: false, error: `incidentTimestampSeconds invalid: ${String(p.incidentTimestampSeconds)}` };
    if (duration !== null && ts > duration + 1) return { ok: false, error: `incidentTimestampSeconds ${ts} exceeds video duration ${duration}` };
    ts = Math.round(ts * 10) / 10;
  }
  return {
    ok: true,
    value: {
      incidentDetected: p.incidentDetected,
      incidentTimestampSeconds: ts,
      incidentTimestampLabel: ts === null ? null : formatTimestampLabel(ts),
      victimVehicle: p.victimVehicle,
      otherVehicle: p.otherVehicle ?? null,
      event: p.event,
      relevance: p.relevance,
      evidence: p.evidence,
      videoDurationSec: duration,
      disclaimer: AI_DISCLAIMER,
    },
  };
}

async function notifyRequester(tx: Queryable, requesterId: string, incidentId: string, submissionId: string, placeName: string, result: AnalysisResult): Promise<void> {
  if (result.incidentDetected) {
    const copy = renderCopy('CANDIDATE_FOUND', { place: placeName, timestampLabel: result.incidentTimestampLabel ?? '00:00' });
    await insertNotification(tx, { userId: requesterId, type: 'CANDIDATE_FOUND', incidentId, submissionId, ...copy });
  } else {
    const copy = renderCopy('NO_CANDIDATE', { place: placeName });
    await insertNotification(tx, { userId: requesterId, type: 'NO_CANDIDATE', incidentId, submissionId, ...copy });
  }
}

async function failAnalysis(deps: AnalysisDeps, analysisId: string, submissionId: string, code: ProviderErrorCode, message: string, raw?: unknown): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await markFailed(tx, analysisId, code, message, raw);
    await transitionSubmission(tx, submissionId, ['ANALYZING'], 'ANALYSIS_FAILED');
    await audit(tx, { actorId: null, action: 'analysis.failed', targetType: 'analysis', targetId: analysisId, metadata: { code, message: message.slice(0, 300) } });
  });
}

/** F6 step 9: orphaned in-flight analyses become FAILED(TIMEOUT); submissions return to ANALYSIS_FAILED. */
export async function sweepStaleAnalyses(deps: Pick<AnalysisDeps, 'db' | 'env' | 'logger'>): Promise<string[]> {
  const stale = await findStaleInFlight(deps.db, deps.env.ANALYSIS_TIMEOUT_MS + 30_000);
  const swept: string[] = [];
  for (const a of stale) {
    await deps.db.transaction(async (tx) => {
      const failed = await markFailed(tx, a.id, 'TIMEOUT', `No completion within ${deps.env.ANALYSIS_TIMEOUT_MS + 30_000}ms (swept)`);
      if (!failed) return;
      await transitionSubmission(tx, a.submission_id, ['ANALYZING'], 'ANALYSIS_FAILED');
      await audit(tx, { actorId: null, action: 'analysis.swept', targetType: 'analysis', targetId: a.id, metadata: { previousStatus: a.status } });
      swept.push(a.id);
    });
  }
  if (swept.length) deps.logger.warn({ swept }, 'stale analyses marked FAILED(TIMEOUT)');
  return swept;
}

/** On boot: rows still QUEUED were never picked up (process died before the worker ran); re-enqueue them. */
export async function recoverQueuedAnalyses(deps: Pick<AnalysisDeps, 'db' | 'enqueue' | 'logger'>): Promise<number> {
  const rows = await deps.db.query<{ id: string }>(`select id from analyses where status = 'QUEUED' order by created_at asc`);
  for (const r of rows.rows) deps.enqueue(r.id);
  if (rows.rows.length) deps.logger.info({ count: rows.rows.length }, 're-enqueued QUEUED analyses');
  return rows.rows.length;
}
