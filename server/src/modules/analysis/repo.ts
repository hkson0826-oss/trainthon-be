import { many, one, type Queryable } from '../../lib/db.js';
import type { AnalysisResult } from '../../adapters/twelvelabs/schema.js';
import type { ProviderErrorCode } from '../../adapters/twelvelabs/client.js';

export type AnalysisStatus = 'QUEUED' | 'ANALYZING' | 'FINALIZING' | 'READY' | 'FAILED';
export const IN_FLIGHT: readonly AnalysisStatus[] = ['QUEUED', 'ANALYZING', 'FINALIZING'];

export interface AnalysisRow {
  id: string;
  submission_id: string;
  status: AnalysisStatus;
  source: 'LIVE' | 'PRERECORDED' | null;
  provider: string;
  model: string;
  prompt_version: string;
  request_payload_hash: string | null;
  raw_response: unknown | null;
  result: AnalysisResult | null;
  error_code: ProviderErrorCode | null;
  error_message: string | null;
  attempts: number;
  requested_by: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function findAnalysis(q: Queryable, id: string): Promise<AnalysisRow | null> {
  return one<AnalysisRow>(q, 'select * from analyses where id = $1', [id]);
}

export async function findAnalysisBySubmission(q: Queryable, submissionId: string): Promise<AnalysisRow | null> {
  return one<AnalysisRow>(q, 'select * from analyses where submission_id = $1', [submissionId]);
}

export async function findAnalysesBySubmissions(q: Queryable, submissionIds: string[]): Promise<Map<string, AnalysisRow>> {
  if (!submissionIds.length) return new Map();
  const rows = await many<AnalysisRow>(q, 'select * from analyses where submission_id = any($1::uuid[])', [submissionIds]);
  return new Map(rows.map((r) => [r.submission_id, r]));
}

/**
 * Creates the QUEUED row for a submission, or resets an existing FAILED row back to QUEUED.
 * Returns null when an in-flight analysis already exists (caller returns it as-is).
 */
export async function enqueueAnalysis(q: Queryable, p: { submissionId: string; model: string; promptVersion: string; requestedBy: string }): Promise<AnalysisRow | null> {
  return one<AnalysisRow>(
    q,
    `insert into analyses (submission_id, status, model, prompt_version, requested_by)
     values ($1, 'QUEUED', $2, $3, $4)
     on conflict (submission_id) do update
       set status = 'QUEUED', source = null, raw_response = null, result = null, error_code = null, error_message = null,
           started_at = null, finished_at = null, requested_by = excluded.requested_by, model = excluded.model,
           prompt_version = excluded.prompt_version, updated_at = now()
       where analyses.status = 'FAILED'
     returning *`,
    [p.submissionId, p.model, p.promptVersion, p.requestedBy],
  );
}

export async function markAnalyzing(q: Queryable, id: string): Promise<AnalysisRow | null> {
  return one<AnalysisRow>(
    q,
    `update analyses set status = 'ANALYZING', started_at = coalesce(started_at, now()), updated_at = now()
      where id = $1 and status = 'QUEUED' returning *`,
    [id],
  );
}

export async function bumpAttempt(q: Queryable, id: string, requestHash: string | null): Promise<void> {
  await q.query(`update analyses set attempts = attempts + 1, request_payload_hash = coalesce($2, request_payload_hash), updated_at = now() where id = $1`, [id, requestHash]);
}

export async function markFinalizing(q: Queryable, id: string): Promise<boolean> {
  const r = await q.query(`update analyses set status = 'FINALIZING', updated_at = now() where id = $1 and status = 'ANALYZING'`, [id]);
  return r.rowCount > 0;
}

export async function markReady(
  q: Queryable,
  id: string,
  p: { source: 'LIVE' | 'PRERECORDED'; raw: unknown; result: AnalysisResult; model: string; promptVersion: string },
): Promise<AnalysisRow | null> {
  return one<AnalysisRow>(
    q,
    `update analyses
        set status = 'READY', source = $2, raw_response = $3::jsonb, result = $4::jsonb, model = $5, prompt_version = $6,
            error_code = null, error_message = null, finished_at = now(), updated_at = now()
      where id = $1 and status in ('ANALYZING', 'FINALIZING') returning *`,
    [id, p.source, JSON.stringify(p.raw ?? null), JSON.stringify(p.result), p.model, p.promptVersion],
  );
}

export async function markFailed(q: Queryable, id: string, code: ProviderErrorCode, message: string, raw?: unknown): Promise<AnalysisRow | null> {
  return one<AnalysisRow>(
    q,
    `update analyses
        set status = 'FAILED', error_code = $2, error_message = left($3, 1000), raw_response = coalesce($4::jsonb, raw_response),
            finished_at = now(), updated_at = now()
      where id = $1 and status in ('QUEUED', 'ANALYZING', 'FINALIZING') returning *`,
    [id, code, message, raw === undefined ? null : JSON.stringify(raw)],
  );
}

/** Orphaned in-flight analyses (process died mid-run). */
export async function findStaleInFlight(q: Queryable, olderThanMs: number): Promise<AnalysisRow[]> {
  return many<AnalysisRow>(
    q,
    `select * from analyses
      where status in ('QUEUED', 'ANALYZING', 'FINALIZING')
        and coalesce(started_at, created_at) < now() - ($1::bigint * interval '1 millisecond')`,
    [olderThanMs],
  );
}
