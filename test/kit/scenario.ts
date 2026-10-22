import { randomUUID } from 'node:crypto';
import type { ActionRow, ActionState } from '../../src/db/schema.js';
import { tenantClient } from './clients.js';
import { createTenant, type TenantFixture } from './fixtures.js';
import type { Stack } from './stack.js';
import { waitFor } from './wait.js';

export interface ScenarioTenant extends TenantFixture {
  api: ReturnType<typeof tenantClient>;
  invoiceIds: string[];
  amountMinor: number;
}

/** A tenant on a fresh company code, with `invoices` OPEN invoices of `amountMinor` created in the mock ERP. */
export async function tenantWithInvoices(
  stack: Stack,
  o: { credits: number; invoices: number; amountMinor?: number; maxPending?: number; id?: string },
): Promise<ScenarioTenant> {
  const t = await createTenant(stack.db, {
    credits: o.credits,
    ...(o.maxPending === undefined ? {} : { maxPending: o.maxPending }),
    ...(o.id === undefined ? {} : { id: o.id }),
  });
  const amountMinor = o.amountMinor ?? 100_000;
  const { invoice_ids } = o.invoices
    ? await stack.mockErp!.admin.createInvoices(t.companyCode, {
        count: o.invoices,
        amount_minor: amountMinor,
      })
    : { invoice_ids: [] };
  return { ...t, api: tenantClient(stack, t.apiKey), invoiceIds: invoice_ids, amountMinor };
}

export const payPayload = (invoiceId: string, amountMinor: number) => ({
  invoice_id: invoiceId,
  amount_minor: amountMinor,
  currency: 'INR',
});

export const newKey = () => `k-${randomUUID()}`;

export function getAction(stack: Stack, id: string): Promise<ActionRow | undefined> {
  return stack.db.selectFrom('actions').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function waitForState(
  stack: Stack,
  id: string,
  states: ActionState | ActionState[],
  timeoutMs = 15_000,
): Promise<ActionRow> {
  const want = Array.isArray(states) ? states : [states];
  return waitFor(
    async () => {
      const a = await getAction(stack, id);
      return a && want.includes(a.state) ? a : undefined;
    },
    { timeoutMs, message: `action ${id} → ${want.join('|')}` },
  );
}

export async function eventsOf(stack: Stack, id: string) {
  const rows = await stack.db
    .selectFrom('action_events')
    .select(['from_state', 'to_state', 'reason'])
    .where('action_id', '=', id)
    .orderBy('id')
    .execute();
  return rows;
}

export async function ledgerOf(stack: Stack, id: string) {
  return stack.db
    .selectFrom('ledger_entries')
    .select(['kind', 'amount', 'reason'])
    .where('action_id', '=', id)
    .orderBy('id')
    .execute();
}

/** Run async tasks with bounded concurrency (avoid exhausting sockets / pool on bulk submits). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}
