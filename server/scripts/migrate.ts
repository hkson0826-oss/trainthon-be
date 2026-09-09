import { loadEnv } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { PgDb } from '../src/lib/db.js';

const env = loadEnv();
const db = new PgDb(env.DATABASE_URL);
try {
  const { applied, skipped } = await migrate(db);
  console.log(`applied: ${applied.length ? applied.join(', ') : '(none)'}`);
  console.log(`already applied: ${skipped.length}`);
} finally {
  await db.close();
}
