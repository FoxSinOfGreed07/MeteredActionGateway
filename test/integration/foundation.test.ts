import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_COLUMNS } from '../../src/db/schema.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

describe('foundation', () => {
  it('migration created every table in the schema', async () => {
    const rows = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(stack.db);
    const tables = rows.rows.map((r) => r.table_name).sort();
    expect(tables).toEqual(Object.keys(SCHEMA_COLUMNS).sort());
  });

  it('schema.ts matches the live columns (A2 drift check)', async () => {
    for (const [table, cols] of Object.entries(SCHEMA_COLUMNS)) {
      const rows = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}`.execute(stack.db);
      expect(rows.rows.map((r) => r.column_name).sort(), table).toEqual([...(cols as string[])].sort());
    }
  });

  it('enums and guard triggers exist', async () => {
    const enums = await sql<{
      typname: string;
    }>`SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname`.execute(stack.db);
    expect(enums.rows.map((r) => r.typname)).toEqual(['action_state', 'ledger_kind']);
    const triggers = await sql<{ tgname: string }>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`.execute(stack.db);
    expect(triggers.rows.map((r) => r.tgname)).toEqual(
      expect.arrayContaining([
        'actions_guard',
        'actions_no_delete',
        'ledger_append_only',
        'ledger_no_truncate',
        'events_append_only',
      ]),
    );
  });

  it('ledger is append-only (UPDATE and DELETE rejected)', async () => {
    await stack.db
      .insertInto('tenants')
      .values({
        id: 'f1',
        name: 'f1',
        api_key_hash: 'h-f1',
        erp_lane_id: 'sap-main',
        erp_company_code: 'F1',
      })
      .execute();
    const { id } = await stack.db
      .insertInto('ledger_entries')
      .values({
        tenant_id: 'f1',
        kind: 'GRANT',
        amount: 10,
        available_delta: 10,
        held_delta: 0,
        reason: 'grant:test',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      stack.db.updateTable('ledger_entries').set({ amount: 11 }).where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(stack.db.deleteFrom('ledger_entries').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });

  it('GET /healthz is 200 with db + redis up', async () => {
    const res = await stack.api.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true });
  });
});
