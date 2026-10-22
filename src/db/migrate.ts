import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_ID = 727272;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies migrations/*.sql in sorted order, each in its own transaction, recording versions in
 * schema_migrations. Serialized across processes with an advisory lock (compose + tests can race).
 */
export async function migrate(connectionString: string): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const result: MigrateResult = { applied: [], skipped: [] };
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) {
        result.skipped.push(version);
        continue;
      }
      const sqlText = await readFile(`${MIGRATIONS_DIR}${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [
          version,
        ]);
        await client.query('COMMIT');
        result.applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}
