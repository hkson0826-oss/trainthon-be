import { PGlite } from '@electric-sql/pglite';
import type { Express } from 'express';
import { StaticAuthAdapter, type VerifiedIdentity } from '../../src/adapters/auth/index.js';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { migrate } from '../../src/db/migrate.js';
import { SingleConnectionDb, type Db } from '../../src/lib/db.js';
import { silentLogger } from '../../src/lib/logger.js';
import { upsertProfile, type Role } from '../../src/modules/me/profiles.repo.js';

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
  close(): Promise<void>;
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
  extra: Partial<Omit<AppDeps, 'env' | 'db' | 'auth' | 'logger'>> = {},
): Promise<TestContext> {
  const env = testEnv(envOverrides);
  const db = await createTestDb();
  await seedTestProfiles(db);
  const tokens = new Map<string, VerifiedIdentity>([
    [TOKENS.requester, { userId: TEST_IDS.requester, email: 'x@test.local' }],
    [TOKENS.witness, { userId: TEST_IDS.witness, email: 'y@test.local' }],
    [TOKENS.operator, { userId: TEST_IDS.operator, email: 'op@test.local' }],
    [TOKENS.stranger, { userId: TEST_IDS.stranger, email: 'stranger@test.local' }],
  ]);
  const auth = new StaticAuthAdapter(tokens);
  const app = createApp({ env, db, auth, logger: silentLogger, ...extra });
  return { app, db, env, auth, close: () => db.close() };
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
