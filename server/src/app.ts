import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import type { AuthAdapter } from './adapters/auth/index.js';
import type { StorageAdapter } from './adapters/storage/index.js';
import type { Env } from './config/env.js';
import type { Db } from './lib/db.js';
import type { Logger } from './lib/logger.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import type { AnalysisRuntime } from './modules/analysis/index.js';
import { analysisRouter } from './modules/analysis/router.js';
import { candidatesRouter, type CandidatesDeps } from './modules/candidates/router.js';
import { configRouter } from './modules/config/router.js';
import { incidentsRouter, type IncidentsDeps } from './modules/incidents/router.js';
import { meRouter } from './modules/me/router.js';
import { countUnread, notificationsRouter } from './modules/notifications/index.js';
import { placesRouter } from './modules/places/index.js';
import { submissionSummaryProvider, submissionsRouter, type SubmissionsDeps } from './modules/submissions/router.js';
import { visitsRouter } from './modules/visits/index.js';

export interface AppDeps {
  env: Env;
  db: Db;
  auth: AuthAdapter;
  storage: StorageAdapter;
  logger: Logger;
  migrationsDir?: string;
  /** Extra authenticated routers mounted under API_PREFIX (feature modules). */
  authedRouters?: RequestHandler[];
  /** Extra public routers mounted under API_PREFIX. */
  publicRouters?: RequestHandler[];
  unreadNotificationCount?: (userId: string) => Promise<number>;
  submissionSummary?: IncidentsDeps['submissionSummary'];
  analysisSummary?: SubmissionsDeps['analysisSummary'];
  /** F6/F7 runtime (provider, queue). When omitted the analysis and candidates routes are not mounted. */
  analysis?: AnalysisRuntime;
  insurerReview?: CandidatesDeps['insurerReview'];
}

export function createApp(deps: AppDeps): Express {
  const { env, db, auth, storage, logger } = deps;
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
  authed.use(meRouter({ db, unreadNotificationCount: deps.unreadNotificationCount ?? ((userId) => countUnread(db, userId)) }));
  authed.use(placesRouter(db)); // F2
  authed.use(incidentsRouter({ env, db, storage, logger, submissionSummary: deps.submissionSummary ?? submissionSummaryProvider() })); // F3
  authed.use(notificationsRouter(db)); // F4
  authed.use(visitsRouter(db)); // F4
  const analysisSummary = deps.analysisSummary ?? deps.analysis?.analysisSummary;
  authed.use(submissionsRouter({ env, db, storage, ...(analysisSummary ? { analysisSummary } : {}) })); // F5
  if (deps.analysis) {
    authed.use(analysisRouter(deps.analysis.deps)); // F6
    authed.use(candidatesRouter({ env, db, storage, logger, ...(deps.insurerReview ? { insurerReview: deps.insurerReview } : {}) })); // F7
  }
  for (const r of deps.authedRouters ?? []) authed.use(r);
  api.use(authed);

  app.use(env.API_PREFIX, api);
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
