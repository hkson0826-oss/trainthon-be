import type { Env } from '../../config/env.js';
import { one, type Queryable } from '../../lib/db.js';

export type SettlementStatus =
  | 'DEPOSIT_PENDING'
  | 'DEPOSITED'
  | 'ADOPTION_PENDING'
  | 'PAYOUT_SCHEDULED'
  | 'PAID'
  | 'REFUNDED'
  | 'PAYOUT_FAILED'
  | 'DISPUTED';

export interface SettlementRow {
  id: string;
  incident_id: string;
  deposit_amount: number;
  platform_fee: number;
  witness_reward: number;
  status: SettlementStatus;
  payout_user_id: string | null;
  payout_submission_id: string | null;
  payout_scheduled_at: Date | null;
  dedupe_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toSettlementDto(s: SettlementRow) {
  return {
    id: s.id,
    incidentId: s.incident_id,
    status: s.status,
    depositAmount: s.deposit_amount,
    platformFee: s.platform_fee,
    witnessReward: s.witness_reward,
    payoutScheduledAt: s.payout_scheduled_at ? s.payout_scheduled_at.toISOString() : null,
    mock: true as const,
    label: '데모: 실제 결제·송금 없음',
  };
}

/** F3 rule 3 / F9: demo deposit is recorded as DEPOSITED immediately (no real payment). */
export async function createDeposit(q: Queryable, env: Env, incidentId: string): Promise<SettlementRow> {
  const fee = Math.min(env.DEMO_PLATFORM_FEE, env.DEMO_DEPOSIT_AMOUNT);
  const row = await one<SettlementRow>(
    q,
    `insert into settlements (incident_id, deposit_amount, platform_fee, witness_reward, status)
     values ($1, $2, $3, $4, 'DEPOSITED') returning *`,
    [incidentId, env.DEMO_DEPOSIT_AMOUNT, fee, env.DEMO_DEPOSIT_AMOUNT - fee],
  );
  if (!row) throw new Error('createDeposit returned no row');
  return row;
}

export async function findSettlementByIncident(q: Queryable, incidentId: string): Promise<SettlementRow | null> {
  return one<SettlementRow>(q, 'select * from settlements where incident_id = $1', [incidentId]);
}

/** F9: SUBMITTED → ADOPTION_PENDING (idempotent when already pending). */
export async function markAdoptionPending(q: Queryable, incidentId: string): Promise<SettlementRow | null> {
  return one<SettlementRow>(
    q,
    `update settlements set status = 'ADOPTION_PENDING', updated_at = now()
      where incident_id = $1 and status in ('DEPOSITED', 'ADOPTION_PENDING') returning *`,
    [incidentId],
  );
}

/** F9: rejected while pending → back to DEPOSITED so another submission can be reviewed. */
export async function revertToDeposited(q: Queryable, incidentId: string): Promise<SettlementRow | null> {
  return one<SettlementRow>(q, `update settlements set status = 'DEPOSITED', updated_at = now() where incident_id = $1 and status = 'ADOPTION_PENDING' returning *`, [
    incidentId,
  ]);
}

/**
 * F9: adoption schedules the payout to the witness. `dedupe_key = incidentId:submissionId` (UNIQUE)
 * guarantees the same evidence is never paid twice; a repeat call is a no-op returning null.
 */
export async function schedulePayout(
  q: Queryable,
  p: { incidentId: string; submissionId: string; witnessId: string; disputeWindowHours: number },
): Promise<SettlementRow | null> {
  return one<SettlementRow>(
    q,
    `update settlements
        set status = 'PAYOUT_SCHEDULED', payout_user_id = $2, payout_submission_id = $3, dedupe_key = $4,
            payout_scheduled_at = now() + ($5::int * interval '1 hour'), updated_at = now()
      where incident_id = $1 and status in ('DEPOSITED', 'ADOPTION_PENDING') and dedupe_key is null
      returning *`,
    [p.incidentId, p.witnessId, p.submissionId, `${p.incidentId}:${p.submissionId}`, p.disputeWindowHours],
  );
}

export interface RewardRow extends SettlementRow {
  place_name: string;
}

export async function listRewardsForWitness(q: Queryable, witnessId: string): Promise<RewardRow[]> {
  const r = await q.query<RewardRow>(
    `select s.*, p.name as place_name
       from settlements s
       join incidents i on i.id = s.incident_id
       join places p on p.id = i.place_id
      where s.payout_user_id = $1
      order by s.payout_scheduled_at desc nulls last, s.updated_at desc`,
    [witnessId],
  );
  return r.rows;
}
