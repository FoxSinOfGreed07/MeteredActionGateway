import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

/**
 * Hand-written Kysely types mirroring migrations/0001_init.sql (plans/00-architecture.md §5) column for column.
 * snake_case on purpose (A2): TypeScript reads like the SQL. `test/integration/foundation.test.ts` checks
 * SCHEMA_COLUMNS against information_schema, so drift fails a test.
 */

export type ActionState = 'QUEUED' | 'DISPATCHING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'REJECTED';
export type LedgerKind = 'GRANT' | 'HOLD' | 'CAPTURE' | 'RELEASE' | 'REFUND';
export type LaneKind = 'erp' | 'llm';

/** jsonb: selected as parsed JSON; written as a JSON string (pg would turn JS arrays into PG arrays). */
export type Json = ColumnType<unknown, string, string>;
export type NullableJson = ColumnType<unknown | null, string | null | undefined, string | null>;
export type Ts = ColumnType<Date, Date | string, Date | string>;
export type GenTs = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface LanesTable {
  id: string;
  kind: LaneKind;
  base_url: string | null;
  rate_per_sec: number;
  burst: number;
  max_in_flight: number;
  request_timeout_ms: number;
  lease_ms: number;
  max_read_lag_ms: Generated<number>;
  webhook_secret: string | null;
  created_at: GenTs;
}

export interface LaneHealthTable {
  lane_id: string;
  stale_suspected_until: NullableTs;
  last_evidence: NullableJson;
  updated_at: GenTs;
}

export interface TenantsTable {
  id: string;
  name: string;
  api_key_hash: string;
  erp_lane_id: string;
  erp_company_code: string;
  max_pending: Generated<number>;
  created_at: GenTs;
}

export interface PriceListTable {
  action_type: string;
  hold_amount: number;
  capture_amount: number;
  cache_hit_capture_amount: number | null;
}

export interface WalletsTable {
  tenant_id: string;
  available: Generated<number>;
  held: Generated<number>;
  updated_at: GenTs;
}

export interface ActionsTable {
  id: string;
  tenant_id: string;
  lane_id: string;
  action_type: string;
  idempotency_key: string;
  payload: Json;
  payload_hash: string;
  conflict_key: string | null;
  state: ActionState;
  hold_amount: Generated<number>;
  captured_amount: number | null;
  dispatch_count: Generated<number>;
  retry_count: Generated<number>;
  ambiguous_count: Generated<number>;
  next_attempt_at: GenTs;
  lease_owner: string | null;
  lease_until: NullableTs;
  dispatched_at: NullableTs;
  unknown_since: NullableTs;
  trust_not_found_after: NullableTs;
  not_found_count: Generated<number>;
  next_reconcile_at: NullableTs;
  reconcile_attempts: Generated<number>;
  result: NullableJson;
  failure_code: string | null;
  failure_message: string | null;
  confirmed_via: 'response' | 'reconcile' | null;
  response_status: number;
  response_body: Json;
  created_at: GenTs;
  updated_at: GenTs;
  completed_at: NullableTs;
}

export interface ActionEventsTable {
  id: Generated<number>;
  action_id: string;
  from_state: ActionState | null;
  to_state: ActionState;
  reason: string;
  details: NullableJson;
  created_at: GenTs;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  tenant_id: string;
  action_id: string | null;
  kind: LedgerKind;
  amount: number;
  available_delta: number;
  held_delta: number;
  reason: string;
  created_at: GenTs;
}

export interface LaneTenantCursorTable {
  lane_id: string;
  tenant_id: string;
  last_dispatched_at: Ts;
}

export interface ErpEventsTable {
  id: Generated<number>;
  lane_id: string;
  event_id: string;
  company_code: string;
  object_type: 'vendor' | 'invoice' | 'payment';
  object_id: string;
  seq: number;
  occurred_at: Ts;
  received_at: GenTs;
}

export interface ClassificationCacheTable {
  cache_key: string;
  tenant_id: string;
  input: Json;
  result: Json;
  model: string;
  prompt_version: string;
  source_action_id: string | null;
  created_at: GenTs;
}

export interface SchemaMigrationsTable {
  version: string;
  applied_at: GenTs;
}

export interface Database {
  lanes: LanesTable;
  lane_health: LaneHealthTable;
  tenants: TenantsTable;
  price_list: PriceListTable;
  wallets: WalletsTable;
  actions: ActionsTable;
  action_events: ActionEventsTable;
  ledger_entries: LedgerEntriesTable;
  lane_tenant_cursor: LaneTenantCursorTable;
  erp_events: ErpEventsTable;
  classification_cache: ClassificationCacheTable;
  schema_migrations: SchemaMigrationsTable;
}

export type LaneRow = Selectable<LanesTable>;
export type TenantRow = Selectable<TenantsTable>;
export type PriceRow = Selectable<PriceListTable>;
export type WalletRow = Selectable<WalletsTable>;
export type ActionRow = Selectable<ActionsTable>;
export type NewAction = Insertable<ActionsTable>;
export type ActionEventRow = Selectable<ActionEventsTable>;
export type LedgerEntryRow = Selectable<LedgerEntriesTable>;
export type ErpEventRow = Selectable<ErpEventsTable>;
export type ClassificationRow = Selectable<ClassificationCacheTable>;

/** Column lists per table: kept next to the interfaces and checked against the live schema in a test. */
export const SCHEMA_COLUMNS: { [T in keyof Database]: (keyof Database[T])[] } = {
  lanes: [
    'id',
    'kind',
    'base_url',
    'rate_per_sec',
    'burst',
    'max_in_flight',
    'request_timeout_ms',
    'lease_ms',
    'max_read_lag_ms',
    'webhook_secret',
    'created_at',
  ],
  lane_health: ['lane_id', 'stale_suspected_until', 'last_evidence', 'updated_at'],
  tenants: ['id', 'name', 'api_key_hash', 'erp_lane_id', 'erp_company_code', 'max_pending', 'created_at'],
  price_list: ['action_type', 'hold_amount', 'capture_amount', 'cache_hit_capture_amount'],
  wallets: ['tenant_id', 'available', 'held', 'updated_at'],
  actions: [
    'id',
    'tenant_id',
    'lane_id',
    'action_type',
    'idempotency_key',
    'payload',
    'payload_hash',
    'conflict_key',
    'state',
    'hold_amount',
    'captured_amount',
    'dispatch_count',
    'retry_count',
    'ambiguous_count',
    'next_attempt_at',
    'lease_owner',
    'lease_until',
    'dispatched_at',
    'unknown_since',
    'trust_not_found_after',
    'not_found_count',
    'next_reconcile_at',
    'reconcile_attempts',
    'result',
    'failure_code',
    'failure_message',
    'confirmed_via',
    'response_status',
    'response_body',
    'created_at',
    'updated_at',
    'completed_at',
  ],
  action_events: ['id', 'action_id', 'from_state', 'to_state', 'reason', 'details', 'created_at'],
  ledger_entries: [
    'id',
    'tenant_id',
    'action_id',
    'kind',
    'amount',
    'available_delta',
    'held_delta',
    'reason',
    'created_at',
  ],
  lane_tenant_cursor: ['lane_id', 'tenant_id', 'last_dispatched_at'],
  erp_events: [
    'id',
    'lane_id',
    'event_id',
    'company_code',
    'object_type',
    'object_id',
    'seq',
    'occurred_at',
    'received_at',
  ],
  classification_cache: [
    'cache_key',
    'tenant_id',
    'input',
    'result',
    'model',
    'prompt_version',
    'source_action_id',
    'created_at',
  ],
  schema_migrations: ['version', 'applied_at'],
};
