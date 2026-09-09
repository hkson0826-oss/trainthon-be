import { many, one, type Queryable } from '../../lib/db.js';

export type SubmissionStatus = 'UPLOADING' | 'UPLOADED' | 'ANALYZING' | 'READY' | 'ANALYSIS_FAILED' | 'SUBMITTED' | 'ADOPTED' | 'REJECTED';

export interface SubmissionRow {
  id: string;
  incident_id: string;
  witness_id: string;
  object_path: string;
  mime: string;
  bytes: number;
  declared_bytes: number;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  recorded_at: Date | null;
  status: SubmissionStatus;
  upload_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function findSubmission(q: Queryable, id: string): Promise<SubmissionRow | null> {
  return one<SubmissionRow>(q, 'select * from evidence_submissions where id = $1', [id]);
}

export async function findSubmissionByIncidentAndWitness(q: Queryable, incidentId: string, witnessId: string): Promise<SubmissionRow | null> {
  return one<SubmissionRow>(q, 'select * from evidence_submissions where incident_id = $1 and witness_id = $2', [incidentId, witnessId]);
}

export async function listSubmissionsByIncident(q: Queryable, incidentId: string): Promise<SubmissionRow[]> {
  return many<SubmissionRow>(q, 'select * from evidence_submissions where incident_id = $1 order by created_at asc', [incidentId]);
}

export async function insertSubmission(
  q: Queryable,
  s: { id: string; incidentId: string; witnessId: string; objectPath: string; mime: string; declaredBytes: number; durationSec: number | null; recordedAt: Date | null },
): Promise<SubmissionRow> {
  const row = await one<SubmissionRow>(
    q,
    `insert into evidence_submissions (id, incident_id, witness_id, object_path, mime, declared_bytes, duration_sec, recorded_at, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'UPLOADING') returning *`,
    [s.id, s.incidentId, s.witnessId, s.objectPath, s.mime, s.declaredBytes, s.durationSec, s.recordedAt],
  );
  if (!row) throw new Error('insertSubmission returned no row');
  return row;
}

export async function resetForReupload(q: Queryable, id: string, declaredBytes: number, durationSec: number | null, recordedAt: Date | null): Promise<SubmissionRow | null> {
  return one<SubmissionRow>(
    q,
    `update evidence_submissions
        set status = 'UPLOADING', declared_bytes = $2, duration_sec = $3, recorded_at = $4,
            bytes = 0, sha256 = null, width = null, height = null, upload_completed_at = null, updated_at = now()
      where id = $1 and status in ('UPLOADING', 'ANALYSIS_FAILED')
      returning *`,
    [id, declaredBytes, durationSec, recordedAt],
  );
}

export async function markUploaded(
  q: Queryable,
  id: string,
  meta: { bytes: number; sha256: string; durationSec: number | null; width: number | null; height: number | null },
): Promise<SubmissionRow | null> {
  return one<SubmissionRow>(
    q,
    `update evidence_submissions
        set status = 'UPLOADED', bytes = $2, sha256 = $3, duration_sec = coalesce($4, duration_sec), width = $5, height = $6,
            upload_completed_at = now(), updated_at = now()
      where id = $1 and status in ('UPLOADING', 'ANALYSIS_FAILED')
      returning *`,
    [id, meta.bytes, meta.sha256, meta.durationSec, meta.width, meta.height],
  );
}

/** Conditional status transition; returns the updated row or null when the current status was not in `from`. */
export async function transitionSubmission(q: Queryable, id: string, from: SubmissionStatus[], to: SubmissionStatus): Promise<SubmissionRow | null> {
  return one<SubmissionRow>(
    q,
    `update evidence_submissions set status = $2, updated_at = now() where id = $1 and status = any($3::text[]) returning *`,
    [id, to, from],
  );
}

export interface IncidentSubmissionCounts {
  total: number;
  ready: number;
}

export async function countSubmissions(q: Queryable, incidentId: string): Promise<IncidentSubmissionCounts> {
  const row = await one<{ total: string; ready: string }>(
    q,
    `select count(*)::text as total,
            count(*) filter (where status in ('READY', 'SUBMITTED', 'ADOPTED', 'REJECTED'))::text as ready
       from evidence_submissions where incident_id = $1`,
    [incidentId],
  );
  return { total: Number(row?.total ?? 0), ready: Number(row?.ready ?? 0) };
}
