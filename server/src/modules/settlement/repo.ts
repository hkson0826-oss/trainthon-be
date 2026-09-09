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
