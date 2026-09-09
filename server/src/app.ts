import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import type { AuthAdapter } from './adapters/auth/index.js';
import type { Env } from './config/env.js';
import type { Db } from './lib/db.js';
import type { Logger } from './lib/logger.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { configRouter } from './modules/config/router.js';
import { meRouter } from './modules/me/router.js';

export interface AppDeps {
  env: Env;
  db: Db;
  auth: AuthAdapter;
  logger: Logger;
  migrationsDir?: string;
  /** Extra authenticated routers mounted under API_PREFIX (feature modules). */
  authedRouters?: RequestHandler[];
  /** Extra public routers mounted under API_PREFIX. */
  publicRouters?: RequestHandler[];
  unreadNotificationCount?: (userId: string) => Promise<number>;
}

export function createApp(deps: AppDeps): Express {
  const { env, db, auth, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    cors({
      origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false,
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Demo-Admin-Token'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setTimeout(env.REQUEST_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        res.status(503).json({
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'Request timed out', retryable: true },
          meta: { requestId: res.locals.requestId },
        });
      }
    });
    const started = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          requestId: res.locals.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - started,
          actorId: req.user?.id,
        },
        'request',
      );
    });
    next();
  });

  const api = express.Router();

  // Public (F0)
  api.use(configRouter(env, { db, ...(deps.migrationsDir ? { migrationsDir: deps.migrationsDir } : {}) }));
  for (const r of deps.publicRouters ?? []) api.use(r);

  // Authenticated
  const authed = express.Router();
  authed.use(requireAuth(auth, db));
  authed.use(rateLimit(env.RATE_LIMIT_PER_MINUTE));
  authed.use(
    meRouter({ db, ...(deps.unreadNotificationCount ? { unreadNotificationCount: deps.unreadNotificationCount } : {}) }),
  );
  for (const r of deps.authedRouters ?? []) authed.use(r);
  api.use(authed);

  app.use(env.API_PREFIX, api);
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
