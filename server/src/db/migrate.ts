import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../lib/db.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');

export interface AppliedMigration {
  version: string;
  checksum: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function migrationChecksums(sql: string): { canonical: string; compatible: Set<string> } {
  const canonicalSql = sql.replace(/\r\n?/g, '\n');
  return {
    canonical: sha256(canonicalSql),
    compatible: new Set([sha256(sql), sha256(canonicalSql), sha256(canonicalSql.replace(/\n/g, '\r\n'))]),
  };
}

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function ensureTable(db: Db): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
}

/** Arbitrary constant; all instances must use the same key. */
const MIGRATION_LOCK_KEY = 7_248_113_901;

/**
 * Applies pending SQL migrations in filename order inside one transaction that
 * holds a transaction-scoped advisory lock, so concurrently starting instances
 * serialise: the second waits, re-reads schema_migrations and finds nothing
 * pending. A checksum mismatch on an already-applied file is an error.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureTable(db);
  const files = await listMigrationFiles(dir);
  const contents = new Map<string, { sql: string; checksum: string; compatibleChecksums: Set<string> }>();
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksums = migrationChecksums(sql);
    contents.set(file, { sql, checksum: checksums.canonical, compatibleChecksums: checksums.compatible });
  }

  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    const existing = new Map(
      (await tx.query<AppliedMigration>('select version, checksum from schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const { sql, checksum, compatibleChecksums } = contents.get(file)!;
      const prev = existing.get(file);
      if (prev) {
        if (!compatibleChecksums.has(prev)) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        skipped.push(file);
        continue;
      }
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (version, checksum) values ($1, $2)', [file, checksum]);
      applied.push(file);
    }
    return { applied, skipped };
  });
}

export async function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await ensureTable(db);
  const files = await listMigrationFiles(dir);
  const existing = new Set((await db.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version));
  return files.filter((f) => !existing.has(f));
}
