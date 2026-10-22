import type { LaneRow } from '../../db/schema.js';
import type { DbOrTx } from '../../db/tx.js';

const TTL_MS = 30_000;
const caches = new WeakMap<object, { at: number; lanes: Map<string, LaneRow> }>();

export async function loadLanes(db: DbOrTx): Promise<LaneRow[]> {
  return db.selectFrom('lanes').selectAll().orderBy('id').execute();
}

/** Lane config, cached per database handle for 30s. */
export async function getLane(db: DbOrTx, id: string): Promise<LaneRow> {
  let entry = caches.get(db);
  if (!entry || Date.now() - entry.at > TTL_MS || !entry.lanes.has(id)) {
    entry = { at: Date.now(), lanes: new Map((await loadLanes(db)).map((l) => [l.id, l])) };
    caches.set(db, entry);
  }
  const lane = entry.lanes.get(id);
  if (!lane) throw new Error(`unknown lane ${id}`);
  return lane;
}
