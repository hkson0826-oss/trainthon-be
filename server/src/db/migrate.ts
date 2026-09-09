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

/**
 * Applies pending SQL migrations in filename order. Each file runs in its own
 * transaction; a checksum mismatch on an already-applied file is an error.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureTable(db);
  const files = await listMigrationFiles(dir);
  const existing = new Map(
    (await db.query<AppliedMigration>('select version, checksum from schema_migrations')).rows.map((r) => [r.version, r.checksum]),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = existing.get(file);
    if (prev) {
      if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
      skipped.push(file);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (version, checksum) values ($1, $2)', [file, checksum]);
    });
    applied.push(file);
  }
  return { applied, skipped };
}

export async function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await ensureTable(db);
  const files = await listMigrationFiles(dir);
  const existing = new Set((await db.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version));
  return files.filter((f) => !existing.has(f));
}
