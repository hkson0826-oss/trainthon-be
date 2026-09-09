import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { ok } from '../../lib/response.js';
import { currentUser } from '../../middleware/auth.js';
import { findProfile, updateNotificationConsent, type ProfileRow } from './profiles.repo.js';

export interface MeDeps {
  db: Db;
  unreadNotificationCount?: (userId: string) => Promise<number>;
}

export function toMeDto(p: ProfileRow, unreadNotificationCount: number) {
  return {
    id: p.id,
    role: p.role,
    displayName: p.display_name,
    email: p.email,
    notificationConsent: p.notification_consent,
    payoutReady: p.payout_ready,
    unreadNotificationCount,
    createdAt: p.created_at.toISOString(),
  };
}

const patchMeSchema = z
  .object({ notificationConsent: z.boolean() })
  .strict();

export function meRouter(deps: MeDeps): Router {
  const r = Router();
  const unread = deps.unreadNotificationCount ?? (async () => 0);

  r.get('/me', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const profile = await findProfile(deps.db, user.id);
      if (!profile) throw ApiError.notFound('Profile not found');
      ok(res, toMeDto(profile, await unread(user.id)));
    } catch (err) {
      next(err);
    }
  });

  r.patch('/me', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const body = patchMeSchema.parse(req.body);
      const profile = await updateNotificationConsent(deps.db, user.id, body.notificationConsent);
      if (!profile) throw ApiError.notFound('Profile not found');
      ok(res, toMeDto(profile, await unread(user.id)));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
