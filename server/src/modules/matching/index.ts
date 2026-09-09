import type { Env } from '../../config/env.js';
import { many, type Queryable } from '../../lib/db.js';
import { formatDateKo, formatTimeKo, renderCopy } from '../../lib/copy.ko.js';
import { insertNotification } from '../notifications/index.js';

export interface MatchInput {
  incidentId: string;
  requesterId: string;
  placeId: string;
  placeName: string;
  occurredFrom: Date;
  occurredTo: Date;
}

export interface MatchResult {
  matchedWitnessCount: number;
  notifiedUserIds: string[];
  newNotifications: number;
  notifiedAt: string;
}

/**
 * F4: finds consenting users whose visit to the same place overlaps the incident
 * window (padded by MATCH_TIME_PADDING_MIN) and creates one WITNESS_REQUEST
 * notification each. Re-running for the same incident adds no rows.
 */
export async function runMatching(q: Queryable, env: Env, input: MatchInput): Promise<MatchResult> {
  const paddingMs = env.MATCH_TIME_PADDING_MIN * 60_000;
  const windowFrom = new Date(input.occurredFrom.getTime() - paddingMs);
  const windowTo = new Date(input.occurredTo.getTime() + paddingMs);

  const rows = await many<{ user_id: string }>(
    q,
    `select distinct v.user_id
       from visits v
       join profiles p on p.id = v.user_id
      where v.place_id = $1
        and v.user_id <> $2
        and p.notification_consent = true
        and v.retain_until > now()
        and tstzrange(v.entered_at, v.exited_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
    [input.placeId, input.requesterId, windowFrom, windowTo],
  );

  const copy = renderCopy('WITNESS_REQUEST', {
    date: formatDateKo(input.occurredFrom, env.DEMO_TIMEZONE),
    from: formatTimeKo(input.occurredFrom, env.DEMO_TIMEZONE),
    to: formatTimeKo(input.occurredTo, env.DEMO_TIMEZONE),
    place: input.placeName,
  });

  let newNotifications = 0;
  for (const { user_id } of rows) {
    const inserted = await insertNotification(q, {
      userId: user_id,
      type: 'WITNESS_REQUEST',
      incidentId: input.incidentId,
      submissionId: null,
      title: copy.title,
      body: copy.body,
    });
    if (inserted) newNotifications += 1;
  }

  await q.query('update incidents set matched_witness_count = $2, updated_at = now() where id = $1', [input.incidentId, rows.length]);

  return {
    matchedWitnessCount: rows.length,
    notifiedUserIds: rows.map((r) => r.user_id),
    newNotifications,
    notifiedAt: new Date().toISOString(),
  };
}
