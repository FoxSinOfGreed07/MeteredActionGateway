import type { ActionEventRow, ActionRow } from '../../db/schema.js';

type ViewSource = Pick<
  ActionRow,
  | 'id'
  | 'tenant_id'
  | 'action_type'
  | 'idempotency_key'
  | 'lane_id'
  | 'state'
  | 'payload'
  | 'hold_amount'
  | 'captured_amount'
  | 'result'
  | 'failure_code'
  | 'failure_message'
  | 'created_at'
  | 'updated_at'
  | 'completed_at'
>;

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** ActionView (plans/00-architecture.md §8): the shape of submit responses and GET /v1/actions/:id. */
export function toActionView(a: ViewSource) {
  return {
    id: a.id,
    tenant_id: a.tenant_id,
    action_type: a.action_type,
    idempotency_key: a.idempotency_key,
    lane_id: a.lane_id,
    state: a.state,
    payload: a.payload,
    pricing: { hold: a.hold_amount, captured: a.captured_amount },
    result: a.result ?? null,
    failure: a.failure_code ? { code: a.failure_code, message: a.failure_message ?? '' } : null,
    created_at: iso(a.created_at),
    updated_at: iso(a.updated_at),
    completed_at: iso(a.completed_at),
  };
}

export type ActionView = ReturnType<typeof toActionView>;

export function toActionDetail(
  a: ActionRow,
  events: ActionEventRow[],
  ledger: { kind: string; amount: number; reason: string; created_at: Date }[],
) {
  return {
    ...toActionView(a),
    events: events.map((e) => ({
      from: e.from_state,
      to: e.to_state,
      reason: e.reason,
      details: e.details ?? null,
      at: iso(e.created_at),
    })),
    ledger: ledger.map((l) => ({ kind: l.kind, amount: l.amount, reason: l.reason, at: iso(l.created_at) })),
    attempts: {
      dispatch_count: a.dispatch_count,
      retry_count: a.retry_count,
      ambiguous_count: a.ambiguous_count,
      reconcile_attempts: a.reconcile_attempts,
    },
    unknown:
      a.state === 'UNKNOWN'
        ? {
            since: iso(a.unknown_since),
            trust_not_found_after: iso(a.trust_not_found_after),
            next_reconcile_at: iso(a.next_reconcile_at),
          }
        : null,
  };
}
