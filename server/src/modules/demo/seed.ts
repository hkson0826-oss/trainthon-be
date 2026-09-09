import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { upsertPlace } from '../places/index.js';
import { upsertVisit } from '../visits/index.js';

/** Fixed ids so seed and reset are idempotent (MOCK_DATA_AND_ASSETS.md §3). */
export const DEMO_PLACE_A = '11111111-1111-4111-8111-111111111111';
export const DEMO_PLACE_B = '11111111-1111-4111-8111-222222222222';
export const DEMO_VISIT_ID = '22222222-2222-4222-8222-222222222222';

export const DEMO_PLACES = [
  { id: DEMO_PLACE_A, name: 'A주차장', kind: 'PARKING_LOT' as const, address: '서울특별시 강남구 테헤란로 000 지하 2층', lat: 37.501, lng: 127.0396 },
  { id: DEMO_PLACE_B, name: 'B아파트 지하주차장', kind: 'APARTMENT' as const, address: '서울특별시 송파구 올림픽로 000', lat: 37.5145, lng: 127.1059 },
];

/** `YYYY-MM-DD` of "today" in the demo time zone; the presenter re-seeds on the morning of the demo. */
export function resolveDemoDate(env: Pick<Env, 'DEMO_DATE' | 'DEMO_TIMEZONE'>, now = new Date()): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(env.DEMO_DATE)) return env.DEMO_DATE;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: env.DEMO_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset string (`+09:00`) of a zone for a given date. Handles fixed-offset zones such as Asia/Seoul. */
export function zoneOffset(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = /GMT([+-]\d{2}:\d{2})?/.exec(raw);
  return m?.[1] ?? '+00:00';
}

export async function seedDemoPlaces(db: Db): Promise<void> {
  for (const p of DEMO_PLACES) await upsertPlace(db, p);
}

/** Y's visit to A주차장, {DEMO_DATE} 13:58–14:12 local; overlaps X's "today 14:00–14:10" request. */
export async function seedDemoVisit(db: Db, witnessId: string, demoDate: string, timeZone: string): Promise<{ enteredAt: Date; exitedAt: Date }> {
  const offset = zoneOffset(timeZone, new Date(`${demoDate}T12:00:00Z`));
  const enteredAt = new Date(`${demoDate}T13:58:00${offset}`);
  const exitedAt = new Date(`${demoDate}T14:12:00${offset}`);
  await upsertVisit(db, {
    id: DEMO_VISIT_ID,
    userId: witnessId,
    placeId: DEMO_PLACE_A,
    enteredAt,
    exitedAt,
    source: 'SEED',
    retainUntil: new Date(enteredAt.getTime() + 30 * 86_400_000),
  });
  return { enteredAt, exitedAt };
}

export interface ResetDeps {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  logger: Logger;
}

export interface ResetSummary {
  incidentsDeleted: number;
  submissionsDeleted: number;
  notificationsDeleted: number;
  visitsDeleted: number;
  storageObjectsRemoved: number;
  storageErrors: number;
}

/**
 * F10 reset: wipe the demo accounts' incidents/submissions/analyses/insurer_reviews/settlements/notifications
 * (FK cascades from `incidents` and `evidence_submissions`), remove their storage objects, and re-insert seed visits.
 * `places` are kept. Only rows owned by `userIds` are touched, so a shared database is safe.
 */
export async function resetDemoData(deps: ResetDeps, userIds: string[], opts: { witnessId: string | null; demoDate: string }): Promise<ResetSummary> {
  const { db, env, storage, logger } = deps;
  if (userIds.length === 0) {
    return { incidentsDeleted: 0, submissionsDeleted: 0, notificationsDeleted: 0, visitsDeleted: 0, storageObjectsRemoved: 0, storageErrors: 0 };
  }

  const photoPaths = await db.query<{ object_path: string }>(
    `select p.object_path from incident_photos p join incidents i on i.id = p.incident_id where i.requester_id = any($1::uuid[])`,
    [userIds],
  );
  const submissionCount = await db.query<{ n: string }>(
    `select count(*)::text as n from evidence_submissions s join incidents i on i.id = s.incident_id
      where s.witness_id = any($1::uuid[]) or i.requester_id = any($1::uuid[])`,
    [userIds],
  );
  const videoPaths = await db.query<{ object_path: string }>(
    `select s.object_path from evidence_submissions s join incidents i on i.id = s.incident_id
      where s.witness_id = any($1::uuid[]) or i.requester_id = any($1::uuid[])`,
    [userIds],
  );

  // 1) Storage first, while the object paths are still referenced by rows. A failed removal aborts the
  //    reset (rows keep their paths) so a retry can still find and delete the objects instead of orphaning them.
  let removed = 0;
  const failures: string[] = [];
  const removeAll = async (bucket: string, paths: string[]) => {
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      try {
        await storage.remove(bucket, chunk);
        removed += chunk.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${bucket}: ${message}`);
        logger.warn({ bucket, count: chunk.length, err: message }, 'demo reset: storage remove failed');
      }
    }
  };
  await removeAll(env.SUPABASE_BUCKET_PHOTOS, photoPaths.rows.map((r) => r.object_path));
  await removeAll(env.SUPABASE_BUCKET_VIDEOS, videoPaths.rows.map((r) => r.object_path));
  for (const uid of userIds) {
    try {
      const staged = await storage.listObjects(env.SUPABASE_BUCKET_PHOTOS, `staging/${uid}/`);
      await removeAll(env.SUPABASE_BUCKET_PHOTOS, staged.map((o) => o.path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`staging/${uid}: ${message}`);
      logger.warn({ uid, err: message }, 'demo reset: staging list failed');
    }
  }
  if (failures.length) {
    throw new ApiError(
      'PROVIDER_UNAVAILABLE',
      `Demo reset aborted: storage cleanup failed (${failures.length}: ${failures.join('; ').slice(0, 300)}); database rows were kept so the reset can be retried`,
    );
  }

  // 2) Database. Order matters: notifications before the cascades so they are counted; incidents before
  //    submissions so `settlements.payout_submission_id` (no cascade) is removed together with its incident.
  const counts = await db.transaction(async (tx) => {
    const notes = await tx.query<{ id: string }>(`delete from notifications where user_id = any($1::uuid[]) returning id`, [userIds]);
    const incs = await tx.query<{ id: string }>(`delete from incidents where requester_id = any($1::uuid[]) returning id`, [userIds]);
    // Submissions the demo witness made on someone else's incident: detach any settlement that points at them first.
    await tx.query(
      `update settlements set payout_submission_id = null
        where payout_submission_id in (select id from evidence_submissions where witness_id = any($1::uuid[]))`,
      [userIds],
    );
    const subs = await tx.query<{ id: string }>(`delete from evidence_submissions where witness_id = any($1::uuid[]) returning id`, [userIds]);
    const visits = await tx.query<{ id: string }>(`delete from visits where user_id = any($1::uuid[]) returning id`, [userIds]);
    await tx.query(`delete from audit_logs where actor_id = any($1::uuid[])`, [userIds]);
    return { subs: Number(submissionCount.rows[0]?.n ?? 0) || subs.rows.length, incs: incs.rows.length, notes: notes.rows.length, visits: visits.rows.length };
  });

  if (opts.witnessId) await seedDemoVisit(db, opts.witnessId, opts.demoDate, env.DEMO_TIMEZONE);

  return {
    incidentsDeleted: counts.incs,
    submissionsDeleted: counts.subs,
    notificationsDeleted: counts.notes,
    visitsDeleted: counts.visits,
    storageObjectsRemoved: removed,
    storageErrors: 0,
  };
}
