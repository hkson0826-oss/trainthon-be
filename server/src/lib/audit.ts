import type { Queryable } from './db.js';

export async function audit(
  q: Queryable,
  entry: { actorId: string | null; action: string; targetType: string; targetId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await q.query(
    'insert into audit_logs (actor_id, action, target_type, target_id, metadata) values ($1, $2, $3, $4, $5::jsonb)',
    [entry.actorId, entry.action, entry.targetType, entry.targetId ?? null, JSON.stringify(entry.metadata ?? {})],
  );
}
