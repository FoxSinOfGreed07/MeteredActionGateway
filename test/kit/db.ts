import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '../../src/db/kysely.js';
import { dbUrl, TEMPLATE_DB, TEST_DATABASE_ADMIN_URL } from './env.js';

export interface TestDatabase {
  name: string;
  url: string;
  db: Db;
  drop(): Promise<void>;
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A fresh database cloned from the migrated template. Never TRUNCATE: the ledger triggers forbid it. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `mag_t_${randomBytes(5).toString('hex')}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`));
      break;
    } catch (err) {
      // "source database is being accessed by other users" can happen transiently while another clone runs.
      if (attempt >= 10) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  const url = dbUrl(name);
  const db = createDb(url);
  return {
    name,
    url,
    db,
    async drop() {
      await db.destroy().catch(() => {});
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => {});
    },
  };
}
