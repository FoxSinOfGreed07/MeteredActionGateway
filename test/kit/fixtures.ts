import { randomBytes } from 'node:crypto';
import type { Insertable } from 'kysely';
import type { Db } from '../../src/db/kysely.js';
import { json } from '../../src/db/kysely.js';
import type { ActionState, LanesTable } from '../../src/db/schema.js';
import { grant } from '../../src/gateway/wallet/ledger.js';
import { sha256Hex } from '../../src/shared/hash.js';

export const DEFAULT_PRICES = [
  { action_type: 'pay_invoice', hold_amount: 300, capture_amount: 300, cache_hit_capture_amount: null },
  { action_type: 'classify_invoice_line', hold_amount: 20, capture_amount: 20, cache_hit_capture_amount: 2 },
];

export async function seedPriceList(db: Db): Promise<void> {
  for (const p of DEFAULT_PRICES) {
    await db
      .insertInto('price_list')
      .values(p)
      .onConflict((oc) => oc.column('action_type').doNothing())
      .execute();
  }
}

export type LaneInput = Partial<Insertable<LanesTable>> & { id: string };

export async function createLane(db: Db, lane: LaneInput): Promise<void> {
  const isLlm = lane.kind === 'llm' || lane.id === 'llm';
  await db
    .insertInto('lanes')
    .values({
      kind: isLlm ? 'llm' : 'erp',
      base_url: null,
      rate_per_sec: isLlm ? 20 : 50,
      burst: isLlm ? 20 : 50,
      max_in_flight: isLlm ? 8 : 16,
      request_timeout_ms: isLlm ? 20_000 : 5000,
      lease_ms: isLlm ? 60_000 : 20_000,
      max_read_lag_ms: isLlm ? 0 : 5000,
      webhook_secret: null,
      ...lane,
    })
    .execute();
}

export interface TenantFixture {
  id: string;
  apiKey: string;
  companyCode: string;
  laneId: string;
}

let tenantCounter = 0;

export async function createTenant(
  db: Db,
  opts: {
    id?: string;
    lane?: string;
    companyCode?: string;
    credits?: number;
    maxPending?: number;
    apiKey?: string;
  } = {},
): Promise<TenantFixture> {
  tenantCounter += 1;
  const id = opts.id ?? `t${tenantCounter}_${randomBytes(3).toString('hex')}`;
  const apiKey = opts.apiKey ?? `${id}-key`;
  const laneId = opts.lane ?? 'sap-main';
  // tenants are unique per (lane, company): default to a fresh company code; the mock ERP creates companies on demand.
  const companyCode = opts.companyCode ?? `X${randomBytes(3).toString('hex').toUpperCase()}`;
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('tenants')
      .values({
        id,
        name: id,
        api_key_hash: sha256Hex(apiKey),
        erp_lane_id: laneId,
        erp_company_code: companyCode,
        ...(opts.maxPending === undefined ? {} : { max_pending: opts.maxPending }),
      })
      .execute();
    await tx.insertInto('wallets').values({ tenant_id: id }).execute();
    const credits = opts.credits ?? 0;
    if (credits > 0) await grant(tx, { tenantId: id, amount: credits, reason: 'test' });
  });
  return { id, apiKey, companyCode, laneId };
}

/**
 * A minimal `actions` row for tests that run before/without the intake path (ledger tests need an action
 * id for the FK). Fills NOT NULL columns with dummies.
 */
export async function insertBareAction(
  db: Db,
  o: {
    tenantId: string;
    holdAmount: number;
    state?: Extract<ActionState, 'QUEUED' | 'REJECTED'>;
    laneId?: string;
    actionType?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insertInto('actions')
    .values({
      id,
      tenant_id: o.tenantId,
      lane_id: o.laneId ?? 'sap-main',
      action_type: o.actionType ?? 'pay_invoice',
      idempotency_key: `bare-${id}`,
      payload: json({}),
      payload_hash: 'bare',
      state: o.state ?? 'QUEUED',
      hold_amount: o.holdAmount,
      response_status: 202,
      response_body: json({ bare: true }),
    })
    .execute();
  return id;
}
