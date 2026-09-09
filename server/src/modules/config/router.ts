import { Router } from 'express';
import type { Env } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { pendingMigrations } from '../../db/migrate.js';
import { ok } from '../../lib/response.js';

export interface ReadinessDeps {
  db: Db;
  migrationsDir?: string;
}

export function publicConfig(env: Env) {
  return {
    demoMode: env.DEMO_MODE,
    aiMode: env.AI_MODE,
    provider: env.AI_PROVIDER,
    model: env.TWELVELABS_MODEL,
    promptVersion: env.ANALYSIS_PROMPT_VERSION,
    limits: {
      photoMaxBytes: env.MAX_PHOTO_BYTES,
      photoMaxCount: env.MAX_PHOTO_COUNT,
      photoMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      videoMaxBytes: env.MAX_VIDEO_BYTES,
      videoMinSeconds: env.MIN_VIDEO_SECONDS,
      videoMaxSeconds: env.MAX_VIDEO_SECONDS,
      videoMimeTypes: ['video/mp4'],
    },
    features: {
      prerecordedFallback: env.PRERECORDED_FALLBACK_ENABLED,
      referenceImages: env.ANALYSIS_USE_REFERENCE_IMAGES,
    },
    matching: { timePaddingMinutes: env.MATCH_TIME_PADDING_MIN },
    settlement: {
      depositAmount: env.DEMO_DEPOSIT_AMOUNT,
      platformFee: env.DEMO_PLATFORM_FEE,
      witnessReward: env.DEMO_DEPOSIT_AMOUNT - env.DEMO_PLATFORM_FEE,
      disputeWindowHours: env.DISPUTE_WINDOW_HOURS,
      mock: true,
    },
  };
}

export function configRouter(env: Env, deps: ReadinessDeps): Router {
  const r = Router();

  r.get('/config', (_req, res) => ok(res, publicConfig(env)));

  r.get('/health', (_req, res) => ok(res, { status: 'ok' }));

  r.get('/ready', async (_req, res, next) => {
    try {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      try {
        await deps.db.query('select 1');
        checks.database = { ok: true };
      } catch (err) {
        checks.database = { ok: false, detail: err instanceof Error ? err.message : 'query failed' };
      }
      if (checks.database?.ok) {
        try {
          const pending = await pendingMigrations(deps.db, deps.migrationsDir);
          checks.migrations = pending.length === 0 ? { ok: true } : { ok: false, detail: `${pending.length} pending` };
        } catch (err) {
          checks.migrations = { ok: false, detail: err instanceof Error ? err.message : 'check failed' };
        }
      } else {
        checks.migrations = { ok: false, detail: 'database unavailable' };
      }
      checks.config = {
        ok: env.AI_MODE !== 'live' || env.TWELVELABS_API_KEY.length > 0,
        ...(env.AI_MODE === 'live' && !env.TWELVELABS_API_KEY ? { detail: 'TWELVELABS_API_KEY missing' } : {}),
      };
      const ready = Object.values(checks).every((c) => c.ok);
      res.status(ready ? 200 : 503).json({
        data: { status: ready ? 'ready' : 'not_ready', checks },
        meta: { requestId: res.locals.requestId as string },
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
