import { Router } from 'express';
import { z } from 'zod';
import { many, one, type Db, type Queryable } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { ok } from '../../lib/response.js';
import { currentUser, requireRole } from '../../middleware/auth.js';

export interface VisitRow {
  id: string;
  user_id: string;
  place_id: string;
  place_name: string;
  entered_at: Date;
  exited_at: Date;
  source: 'SEED' | 'MANUAL';
  retain_until: Date;
  created_at: Date;
}

export function toVisitDto(v: VisitRow) {
  return {
    id: v.id,
    place: { id: v.place_id, name: v.place_name },
    enteredAt: v.entered_at.toISOString(),
    exitedAt: v.exited_at.toISOString(),
    source: v.source,
    retainUntil: v.retain_until.toISOString(),
    createdAt: v.created_at.toISOString(),
  };
}

export async function upsertVisit(
  q: Queryable,
  v: { id: string; userId: string; placeId: string; enteredAt: Date; exitedAt: Date; source: 'SEED' | 'MANUAL'; retainUntil: Date },
): Promise<void> {
  await q.query(
    `insert into visits (id, user_id, place_id, entered_at, exited_at, source, retain_until)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set place_id = excluded.place_id, entered_at = excluded.entered_at, exited_at = excluded.exited_at,
       source = excluded.source, retain_until = excluded.retain_until, updated_at = now()`,
    [v.id, v.userId, v.placeId, v.enteredAt, v.exitedAt, v.source, v.retainUntil],
  );
}

export function visitsRouter(db: Db): Router {
  const r = Router();
  const witnessOnly = requireRole('WITNESS');

  r.get('/me/visits', witnessOnly, async (req, res, next) => {
    try {
      const user = currentUser(req);
      const rows = await many<VisitRow>(
        db,
        `select v.*, p.name as place_name from visits v join places p on p.id = v.place_id
         where v.user_id = $1 order by v.entered_at desc limit 100`,
        [user.id],
      );
      ok(res, rows.map(toVisitDto));
    } catch (err) {
      next(err);
    }
  });

  r.delete('/me/visits/:id', witnessOnly, async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const row = await one<{ id: string }>(db, 'delete from visits where id = $1 and user_id = $2 returning id', [id, user.id]);
      if (!row) throw ApiError.notFound('Visit not found');
      await audit(db, { actorId: user.id, action: 'visit.delete', targetType: 'visit', targetId: id });
      ok(res, { id, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
