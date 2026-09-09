import { z } from 'zod';
import { ApiError } from './errors.js';

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    return z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).parse(parsed);
  } catch {
    throw ApiError.validation('Invalid cursor', { cursor: 'malformed' });
  }
}

export const limitSchema = z.coerce.number().int().min(1).max(50).default(20);

/** Applies keyset pagination on rows already sorted by (created_at desc, id desc) and fetched with limit+1. */
export function page<T extends { created_at: Date; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return { items, nextCursor: encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) };
}
