import { Router } from 'express';
import { z } from 'zod';
import { many, one, type Db, type Queryable } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { decodeCursor, limitSchema, page } from '../../lib/pagination.js';
import { ok } from '../../lib/response.js';
import { currentUser } from '../../middleware/auth.js';
import type { NotificationType } from '../../lib/copy.ko.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  incident_id: string | null;
  submission_id: string | null;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Date;
}

export function toNotificationDto(n: NotificationRow) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    incidentId: n.incident_id,
    submissionId: n.submission_id,
    readAt: n.read_at ? n.read_at.toISOString() : null,
    createdAt: n.created_at.toISOString(),
  };
}

/** Inserts a notification; duplicates (same user/type/incident/submission) are ignored. Returns true when inserted. */
export async function insertNotification(
  q: Queryable,
  n: { userId: string; type: NotificationType; incidentId: string | null; submissionId?: string | null; title: string; body: string },
): Promise<boolean> {
  const r = await q.query(
    `insert into notifications (user_id, type, incident_id, submission_id, title, body)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id, type, incident_id, submission_id) do nothing
     returning id`,
    [n.userId, n.type, n.incidentId, n.submissionId ?? null, n.title, n.body],
  );
  return r.rows.length > 0;
}

export async function countUnread(q: Queryable, userId: string): Promise<number> {
  const row = await one<{ count: string }>(q, 'select count(*)::text as count from notifications where user_id = $1 and read_at is null', [userId]);
  return Number(row?.count ?? 0);
}

/** True when the user received a WITNESS_REQUEST for the incident (used for Y access checks). */
export async function wasNotifiedForIncident(q: Queryable, userId: string, incidentId: string): Promise<boolean> {
  const row = await one(q, `select 1 from notifications where user_id = $1 and incident_id = $2 and type = 'WITNESS_REQUEST' limit 1`, [
    userId,
    incidentId,
  ]);
  return row !== null;
}

const listSchema = z.object({ cursor: z.string().optional(), limit: limitSchema });

export function notificationsRouter(db: Db): Router {
  const r = Router();

  r.get('/me/notifications', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const { cursor, limit } = listSchema.parse(req.query);
      const c = decodeCursor(cursor);
      const rows = c
        ? await many<NotificationRow>(
            db,
            `select * from notifications where user_id = $1 and (created_at, id) < ($2::timestamptz, $3::uuid)
             order by created_at desc, id desc limit $4`,
            [user.id, c.createdAt, c.id, limit + 1],
          )
        : await many<NotificationRow>(db, `select * from notifications where user_id = $1 order by created_at desc, id desc limit $2`, [
            user.id,
            limit + 1,
          ]);
      const { items, nextCursor } = page(rows, limit);
      ok(res, items.map(toNotificationDto), 200, { nextCursor, unreadCount: await countUnread(db, user.id) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/notifications/:id/read', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const row = await one<NotificationRow>(
        db,
        `update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 returning *`,
        [id, user.id],
      );
      if (!row) throw ApiError.notFound('Notification not found');
      ok(res, toNotificationDto(row));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
