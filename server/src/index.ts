import { SupabaseAuthAdapter } from './adapters/auth/index.js';
import { SupabaseStorageAdapter } from './adapters/storage/index.js';
import { createApp } from './app.js';
import { loadDotenv } from './config/dotenv.js';
import { EnvError, envWarnings, loadEnv } from './config/env.js';
import { migrate } from './db/migrate.js';
import { PgDb } from './lib/db.js';
import { createLogger } from './lib/logger.js';
import { sweepStagingUploads } from './modules/incidents/photos.service.js';

async function main(): Promise<void> {
  const dotenvPath = loadDotenv();
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(`[startup] ${err.message}`);
      if (err.missing.length) console.error(`[startup] missing: ${err.missing.join(', ')}`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(env.LOG_LEVEL);
  if (dotenvPath) logger.info({ dotenvPath }, 'loaded .env file');
  for (const w of envWarnings(env)) logger.warn(w);

  const db = new PgDb(env.DATABASE_URL);
  const { applied } = await migrate(db);
  if (applied.length) logger.info({ applied }, 'migrations applied');

  const auth = new SupabaseAuthAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const storage = new SupabaseStorageAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const app = createApp({ env, db, auth, storage, logger });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, prefix: env.API_PREFIX, aiMode: env.AI_MODE, demoMode: env.DEMO_MODE }, 'server listening');
  });

  const runStagingSweep = async () => {
    try {
      const { scanned, removed } = await sweepStagingUploads({ env, storage });
      if (removed.length) logger.info({ scanned, removed: removed.length }, 'staging sweep removed abandoned uploads');
    } catch (err) {
      logger.warn({ err }, 'staging sweep failed');
    }
  };
  void runStagingSweep();
  const sweepTimer = setInterval(() => void runStagingSweep(), env.STAGING_SWEEP_INTERVAL_MIN * 60 * 1000);
  sweepTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweepTimer);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[startup] fatal', err);
  process.exit(1);
});
