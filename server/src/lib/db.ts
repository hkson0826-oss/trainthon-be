import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Runs a multi-statement SQL script without parameters (simple protocol). */
  exec(text: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs fn inside BEGIN/COMMIT; rolls back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function one<T>(q: Queryable, text: string, params?: readonly unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function many<T>(q: Queryable, text: string, params?: readonly unknown[]): Promise<T[]> {
  return (await q.query<T>(text, params)).rows;
}

/* ------------------------------------------------------------------ */
/* node-postgres (production: Supabase Postgres via DATABASE_URL)      */
/* ------------------------------------------------------------------ */

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, opts: { max?: number; ssl?: boolean } = {}) {
    const needsSsl = opts.ssl ?? !/localhost|127\.0\.0\.1/.test(connectionString);
    this.pool = new pg.Pool({
      connectionString,
      max: opts.max ?? 10,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    const r = await this.pool.query(text, params as unknown[] | undefined);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }

  async exec(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Queryable = {
        async query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
          const r = await client.query(text, params as unknown[] | undefined);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
        },
        async exec(text: string) {
          await client.query(text);
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback failure, original error wins */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* ------------------------------------------------------------------ */
/* Generic single-connection wrapper (used for PGlite in tests)        */
/* ------------------------------------------------------------------ */

export interface SingleConnection {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  /** Multi-statement script runner; falls back to query() when absent. */
  exec?(text: string): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Serialises transactions on a single connection so BEGIN/COMMIT pairs never
 * interleave. Sufficient for PGlite and for single-process tests.
 */
/** UPDATE/DELETE without RETURNING yield no rows; prefer the driver's affected-row count. */
function rowCountOf(r: { rows: unknown[]; affectedRows?: number }): number {
  return r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0);
}

export class SingleConnectionDb implements Db {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly conn: SingleConnection) {}

  async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    const run = async () => {
      const r = await this.conn.query<T>(text, params);
      return { rows: r.rows, rowCount: rowCountOf(r) };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async exec(text: string): Promise<void> {
    const run = async () => {
      await this.rawExec(text);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async rawExec(text: string): Promise<void> {
    if (this.conn.exec) await this.conn.exec(text);
    else await this.conn.query(text);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const run = async () => {
      await this.conn.query('BEGIN');
      const tx: Queryable = {
        query: async <R = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
          const r = await this.conn.query<R>(text, params);
          return { rows: r.rows, rowCount: rowCountOf(r) };
        },
        exec: (text: string) => this.rawExec(text),
      };
      try {
        const result = await fn(tx);
        await this.conn.query('COMMIT');
        return result;
      } catch (err) {
        await this.conn.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async close(): Promise<void> {
    await this.conn.close?.();
  }
}
