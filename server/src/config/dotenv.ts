import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads KEY=VALUE pairs from a .env file into process.env without overriding
 * variables that are already set. Silent when the file does not exist, so
 * production deployments that inject real env vars are unaffected.
 */
export function loadDotenv(file = path.resolve(process.cwd(), '.env')): string | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return file;
}
