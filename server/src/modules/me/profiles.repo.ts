import { one, type Queryable } from '../../lib/db.js';

export type Role = 'REQUESTER' | 'WITNESS' | 'OPERATOR';

export interface ProfileRow {
  id: string;
  role: Role;
  display_name: string;
  email: string | null;
  notification_consent: boolean;
  payout_ready: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function findProfile(q: Queryable, id: string): Promise<ProfileRow | null> {
  return one<ProfileRow>(q, 'select * from profiles where id = $1', [id]);
}

/** Creates the profile on first sight; existing rows are returned untouched. */
export async function ensureProfile(q: Queryable, id: string, email: string | null): Promise<ProfileRow> {
  const row = await one<ProfileRow>(
    q,
    `insert into profiles (id, email, display_name)
     values ($1, $2, coalesce(split_part($2, '@', 1), ''))
     on conflict (id) do update set email = coalesce(profiles.email, excluded.email)
     returning *`,
    [id, email],
  );
  if (!row) throw new Error('ensureProfile returned no row');
  return row;
}

export async function updateNotificationConsent(q: Queryable, id: string, consent: boolean): Promise<ProfileRow | null> {
  return one<ProfileRow>(
    q,
    `update profiles set notification_consent = $2, updated_at = now() where id = $1 returning *`,
    [id, consent],
  );
}

export async function upsertProfile(
  q: Queryable,
  p: { id: string; role: Role; displayName: string; email: string | null; notificationConsent: boolean; payoutReady: boolean },
): Promise<ProfileRow> {
  const row = await one<ProfileRow>(
    q,
    `insert into profiles (id, role, display_name, email, notification_consent, payout_ready)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set
       role = excluded.role,
       display_name = excluded.display_name,
       email = excluded.email,
       notification_consent = excluded.notification_consent,
       payout_ready = excluded.payout_ready,
       updated_at = now()
     returning *`,
    [p.id, p.role, p.displayName, p.email, p.notificationConsent, p.payoutReady],
  );
  if (!row) throw new Error('upsertProfile returned no row');
  return row;
}
