import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

function toSafeNumber(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${v} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
}

// Must run before any pool is created: int8 (credits, counts) → number with a safe-integer check;
// numeric (SUM over bigint) → number. Credits never exceed 2^53.
pg.types.setTypeParser(20, toSafeNumber);
pg.types.setTypeParser(1700, (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RangeError(`numeric value ${v} is not finite`);
  return n;
});

export type Db = Kysely<Database>;

export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 20 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** JSON-encode a value for a jsonb column (see `Json` in schema.ts). */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
