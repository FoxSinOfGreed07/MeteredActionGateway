import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.js';

export type Tx = Transaction<Database>;
export type DbOrTx = Kysely<Database> | Transaction<Database>;

export function withTx<T>(db: Kysely<Database>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}
