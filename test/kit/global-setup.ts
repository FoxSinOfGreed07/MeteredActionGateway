import { readdirSync } from 'node:fs';
import { Redis } from 'ioredis';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { dbUrl, TEMPLATE_DB, TEST_DATABASE_ADMIN_URL, TEST_REDIS_URL } from './env.js';

const HINT = 'Is the infra up? Run: docker compose up -d postgres redis';

/**
 * Builds (or reuses) the migrated template database every test file clones (`CREATE DATABASE … TEMPLATE`).
 * Idempotent and serialized with an advisory lock, because each vitest project runs its own globalSetup.
 */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Cannot reach Postgres at ${TEST_DATABASE_ADMIN_URL}. ${HINT}`, { cause: err });
  }
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`Cannot reach Redis at ${TEST_REDIS_URL}. ${HINT}`, { cause: err });
  } finally {
    redis.disconnect();
  }

  try {
    await admin.query('SELECT pg_advisory_lock(424242)');
    const wanted = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    if (!(await templateIsCurrent(wanted))) {
      await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
      await migrate(dbUrl(TEMPLATE_DB));
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    await admin.end();
  }
}

async function templateIsCurrent(wanted: string[]): Promise<boolean> {
  const c = new pg.Client({ connectionString: dbUrl(TEMPLATE_DB) });
  try {
    await c.connect();
  } catch {
    return false; // template doesn't exist yet
  }
  try {
    const rows = (
      await c.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
    ).rows;
    return rows.map((r) => r.version).join(',') === wanted.join(',');
  } catch {
    return false;
  } finally {
    await c.end();
  }
}
