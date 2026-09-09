/**
 * npm run seed:demo [-- --reset]
 *
 * Idempotent demo seed (MOCK_DATA_AND_ASSETS.md §2–§3):
 *  1. Supabase Auth users for X / Y / operator via the Admin API (skipped when they already exist).
 *  2. `profiles` upsert with fixed roles/display names.
 *  3. `places` (A주차장, B아파트) and Y's visit to A주차장 on DEMO_DATE 13:58–14:12 (DEMO_TIMEZONE).
 *  --reset additionally wipes the demo accounts' incidents/submissions/analyses/notifications/settlements
 *  and their storage objects before re-seeding the visit (same as POST /demo/reset).
 *
 * Never runs automatically at server start.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStorageAdapter } from '../src/adapters/storage/index.js';
import { loadDotenv } from '../src/config/dotenv.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { PgDb } from '../src/lib/db.js';
import { createLogger } from '../src/lib/logger.js';
import { resetDemoData, resolveDemoDate, seedDemoPlaces, seedDemoVisit } from '../src/modules/demo/seed.js';
import { upsertProfile, type Role } from '../src/modules/me/profiles.repo.js';

loadDotenv();
const env = loadEnv();
const reset = process.argv.includes('--reset');
if (!env.DEMO_ACCOUNT_PASSWORD) {
  console.error('DEMO_ACCOUNT_PASSWORD is required to create the demo accounts.');
  process.exit(1);
}

const logger = createLogger(env.LOG_LEVEL);
const db = new PgDb(env.DATABASE_URL);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

interface DemoAccount {
  key: 'requester' | 'witness' | 'operator';
  email: string;
  role: Role;
  displayName: string;
  notificationConsent: boolean;
  payoutReady: boolean;
}

const ACCOUNTS: DemoAccount[] = [
  { key: 'requester', email: env.DEMO_REQUESTER_EMAIL, role: 'REQUESTER', displayName: '김피해', notificationConsent: true, payoutReady: false },
  { key: 'witness', email: env.DEMO_WITNESS_EMAIL, role: 'WITNESS', displayName: '박목격', notificationConsent: true, payoutReady: true },
  { key: 'operator', email: env.DEMO_OPERATOR_EMAIL, role: 'OPERATOR', displayName: '운영자', notificationConsent: false, payoutReady: false },
];

async function findUserIdByEmail(client: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureAuthUser(client: SupabaseClient, e: Env, account: DemoAccount): Promise<{ id: string; created: boolean }> {
  const existing = await findUserIdByEmail(client, account.email);
  if (existing) return { id: existing, created: false };
  const { data, error } = await client.auth.admin.createUser({
    email: account.email,
    password: e.DEMO_ACCOUNT_PASSWORD,
    email_confirm: true,
    user_metadata: { displayName: account.displayName, demo: true },
  });
  if (error || !data.user) throw new Error(`createUser(${account.email}) failed: ${error?.message ?? 'no user'}`);
  return { id: data.user.id, created: true };
}

try {
  const migrated = await migrate(db);
  if (migrated.applied.length) console.log(`migrations applied: ${migrated.applied.join(', ')}`);

  const ids: Record<DemoAccount['key'], string> = { requester: '', witness: '', operator: '' };
  for (const account of ACCOUNTS) {
    const { id, created } = await ensureAuthUser(supabase, env, account);
    ids[account.key] = id;
    await upsertProfile(db, {
      id,
      role: account.role,
      displayName: account.displayName,
      email: account.email,
      notificationConsent: account.notificationConsent,
      payoutReady: account.payoutReady,
    });
    console.log(`${created ? 'created' : 'exists '} ${account.role.padEnd(9)} ${account.email} (${id})`);
  }

  const demoDate = resolveDemoDate(env);
  if (reset) {
    const storage = new SupabaseStorageAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const summary = await resetDemoData({ env, db, storage, logger }, Object.values(ids), { witnessId: ids.witness, demoDate });
    console.log('reset:', JSON.stringify(summary));
  }

  await seedDemoPlaces(db);
  const visit = await seedDemoVisit(db, ids.witness, demoDate, env.DEMO_TIMEZONE);
  console.log(`places: A주차장, B아파트 지하주차장`);
  console.log(`visit : Y @ A주차장 ${visit.enteredAt.toISOString()} ~ ${visit.exitedAt.toISOString()} (DEMO_DATE=${demoDate} ${env.DEMO_TIMEZONE})`);
} finally {
  await db.close();
}
