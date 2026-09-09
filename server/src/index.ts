import { SupabaseAuthAdapter } from './adapters/auth/index.js';
import { createApp } from './app.js';
import { EnvError, envWarnings, loadEnv } from './config/env.js';
import { migrate } from './db/migrate.js';
import { PgDb } from './lib/db.js';
import { createLogger } from './lib/logger.js';

async function main(): Promise<void> {
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
  for (const w of envWarnings(env)) logger.warn(w);

  const db = new PgDb(env.DATABASE_URL);
  const { applied } = await migrate(db);
  if (applied.length) logger.info({ applied }, 'migrations applied');

  const auth = new SupabaseAuthAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const app = createApp({ env, db, auth, logger });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, prefix: env.API_PREFIX, aiMode: env.AI_MODE, demoMode: env.DEMO_MODE }, 'server listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
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
