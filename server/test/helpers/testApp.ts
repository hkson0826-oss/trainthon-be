import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { StaticAuthAdapter, type VerifiedIdentity } from '../../src/adapters/auth/index.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/index.js';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { migrate } from '../../src/db/migrate.js';
import { SingleConnectionDb, type Db } from '../../src/lib/db.js';
import { silentLogger } from '../../src/lib/logger.js';
import { upsertProfile, type Role } from '../../src/modules/me/profiles.repo.js';
import { upsertPlace } from '../../src/modules/places/index.js';
import { upsertVisit } from '../../src/modules/visits/index.js';

export const TEST_IDS = {
  requester: '00000000-0000-4000-8000-000000000001',
  witness: '00000000-0000-4000-8000-000000000002',
  operator: '00000000-0000-4000-8000-000000000003',
  stranger: '00000000-0000-4000-8000-000000000004',
} as const;

export const TOKENS = {
  requester: 'tok-requester',
  witness: 'tok-witness',
  operator: 'tok-operator',
  stranger: 'tok-stranger',
} as const;

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv(
    {
      NODE_ENV: 'test',
      AI_MODE: 'fake',
      DEMO_MODE: 'true',
      DEMO_ADMIN_TOKEN: 'demo-admin',
      CORS_ORIGINS: 'http://localhost:3000',
      RATE_LIMIT_PER_MINUTE: '0',
      ...overrides,
    },
    { requireInfra: false },
  );
}

export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  await pglite.waitReady;
  const db = new SingleConnectionDb({
    query: async <T>(text: string, params?: readonly unknown[]) => {
      const r = await pglite.query<T>(text, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    exec: async (text: string) => {
      await pglite.exec(text);
    },
    close: () => pglite.close(),
  });
  await migrate(db);
  return db;
}

export interface TestContext {
  app: Express;
  db: Db;
  env: Env;
  auth: StaticAuthAdapter;
  storage: MemoryStorageAdapter;
  close(): Promise<void>;
}

export const PLACE_A = '11111111-1111-4111-8111-111111111111';
export const PLACE_B = '11111111-1111-4111-8111-222222222222';

/** Seeds A/B places and Y's A-parking visit 13:58~14:12 KST on the given date. */
export async function seedDemoWorld(db: Db, demoDate = '2026-09-09'): Promise<void> {
  await upsertPlace(db, { id: PLACE_A, name: 'A주차장', kind: 'PARKING_LOT', address: '서울특별시 강남구 테헤란로 000 지하 2층', lat: 37.501, lng: 127.0396 });
  await upsertPlace(db, { id: PLACE_B, name: 'B아파트 지하주차장', kind: 'APARTMENT', address: '서울특별시 송파구 올림픽로 000', lat: 37.5145, lng: 127.1059 });
  const entered = new Date(`${demoDate}T13:58:00+09:00`);
  const exited = new Date(`${demoDate}T14:12:00+09:00`);
  await upsertVisit(db, {
    id: '22222222-2222-4222-8222-222222222222',
    userId: TEST_IDS.witness,
    placeId: PLACE_A,
    enteredAt: entered,
    exitedAt: exited,
    source: 'SEED',
    retainUntil: new Date(Date.now() + 30 * 86_400_000),
  });
}

export async function seedTestProfiles(db: Db): Promise<void> {
  const rows: Array<{ id: string; role: Role; displayName: string; email: string; notificationConsent: boolean; payoutReady: boolean }> = [
    { id: TEST_IDS.requester, role: 'REQUESTER', displayName: '김피해', email: 'x@test.local', notificationConsent: true, payoutReady: false },
    { id: TEST_IDS.witness, role: 'WITNESS', displayName: '박목격', email: 'y@test.local', notificationConsent: true, payoutReady: true },
    { id: TEST_IDS.operator, role: 'OPERATOR', displayName: '운영자', email: 'op@test.local', notificationConsent: false, payoutReady: false },
  ];
  for (const r of rows) await upsertProfile(db, r);
}

export async function createTestContext(
  envOverrides: Record<string, string> = {},
  extra: Partial<Omit<AppDeps, 'env' | 'db' | 'auth' | 'logger' | 'storage'>> = {},
): Promise<TestContext> {
  const env = testEnv(envOverrides);
  const db = await createTestDb();
  await seedTestProfiles(db);
  await seedDemoWorld(db);
  const storage = new MemoryStorageAdapter();
  const tokens = new Map<string, VerifiedIdentity>([
    [TOKENS.requester, { userId: TEST_IDS.requester, email: 'x@test.local' }],
    [TOKENS.witness, { userId: TEST_IDS.witness, email: 'y@test.local' }],
    [TOKENS.operator, { userId: TEST_IDS.operator, email: 'op@test.local' }],
    [TOKENS.stranger, { userId: TEST_IDS.stranger, email: 'stranger@test.local' }],
  ]);
  const auth = new StaticAuthAdapter(tokens);
  const app = createApp({ env, db, auth, storage, logger: silentLogger, ...extra });
  return { app, db, env, auth, storage, close: () => db.close() };
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
