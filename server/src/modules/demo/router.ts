import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import type { Db } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { ok } from '../../lib/response.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { resetDemoData, resolveDemoDate } from './seed.js';

export interface DemoDeps {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  logger: Logger;
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * F10 – mounted on the *public* router only when DEMO_MODE=true (otherwise these paths 404).
 * `/demo/accounts` is unauthenticated so the FE can render the account switcher before login.
 * `/demo/reset` is guarded by the shared X-Demo-Admin-Token header instead of a user session.
 */
export function demoRouter(deps: DemoDeps): Router {
  const r = Router();
  const { env, db } = deps;
  const limiter = rateLimit(30);

  r.get('/demo/accounts', limiter, (_req, res) => {
    ok(res, {
      requester: { email: env.DEMO_REQUESTER_EMAIL, displayName: '김피해', role: 'REQUESTER' },
      witness: { email: env.DEMO_WITNESS_EMAIL, displayName: '박목격', role: 'WITNESS' },
      demoDate: resolveDemoDate(env),
      timeZone: env.DEMO_TIMEZONE,
    });
  });

  r.post('/demo/reset', limiter, async (req, res, next) => {
    try {
      const given = req.header('x-demo-admin-token');
      if (!tokenMatches(given, env.DEMO_ADMIN_TOKEN)) throw ApiError.unauthenticated('Invalid X-Demo-Admin-Token');

      const emails = [env.DEMO_REQUESTER_EMAIL, env.DEMO_WITNESS_EMAIL, env.DEMO_OPERATOR_EMAIL].map((e) => e.toLowerCase());
      const profiles = await db.query<{ id: string; email: string | null }>(`select id, email from profiles where lower(email) = any($1::text[])`, [emails]);
      const witness = profiles.rows.find((p) => p.email?.toLowerCase() === env.DEMO_WITNESS_EMAIL.toLowerCase());
      const demoDate = resolveDemoDate(env);
      const summary = await resetDemoData(
        deps,
        profiles.rows.map((p) => p.id),
        { witnessId: witness?.id ?? null, demoDate },
      );
      await audit(db, { actorId: null, action: 'demo.reset', targetType: 'demo', targetId: null, metadata: { ...summary, demoDate } });
      ok(res, { ...summary, demoDate, seededVisit: Boolean(witness), accountsFound: profiles.rows.length });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
