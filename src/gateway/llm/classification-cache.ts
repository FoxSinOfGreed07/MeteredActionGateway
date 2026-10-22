import { json } from '../../db/kysely.js';
import type { ClassificationRow } from '../../db/schema.js';
import type { DbOrTx } from '../../db/tx.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import { sha256Hex } from '../../shared/hash.js';
import type { NormalizedInput } from './normalize.js';
import { SCHEMA_VERSION, TASK } from './taxonomy.js';

/**
 * A13: deterministic at the boundary. Key = sha256(canonical {tenant, task, schema version, normalized input,
 * model, prompt version}). Tenant-scoped (a shared cache leaks: a hit reveals another tenant saw the text);
 * versions in the key (a prompt/model upgrade takes effect, old answers stay auditable).
 */
export function cacheKey(o: {
  tenantId: string;
  input: NormalizedInput;
  model: string;
  promptVersion: string;
}): string {
  return sha256Hex(
    canonicalJson({
      tenant_id: o.tenantId,
      task: TASK,
      schema_version: SCHEMA_VERSION,
      input: o.input,
      model: o.model,
      prompt_version: o.promptVersion,
    }),
  );
}

export function getCached(db: DbOrTx, key: string): Promise<ClassificationRow | undefined> {
  return db.selectFrom('classification_cache').selectAll().where('cache_key', '=', key).executeTakeFirst();
}

/** First writer wins; a stored answer never changes (immutable trigger, I12). Returns true if OUR row won. */
export async function putIfAbsent(
  db: DbOrTx,
  row: {
    key: string;
    tenantId: string;
    input: NormalizedInput;
    result: unknown;
    model: string;
    promptVersion: string;
    actionId: string;
  },
): Promise<boolean> {
  const r = await db
    .insertInto('classification_cache')
    .values({
      cache_key: row.key,
      tenant_id: row.tenantId,
      input: json(row.input),
      result: json(row.result),
      model: row.model,
      prompt_version: row.promptVersion,
      source_action_id: row.actionId,
    })
    .onConflict((oc) => oc.column('cache_key').doNothing())
    .returning('cache_key')
    .executeTakeFirst();
  return r !== undefined;
}
