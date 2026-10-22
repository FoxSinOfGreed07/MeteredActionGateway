-- 0001_init: full schema. Source of truth: plans/00-architecture.md §5. Never edit once committed; add 000N files.
-- ===== enums =====
CREATE TYPE action_state AS ENUM ('QUEUED','DISPATCHING','UNKNOWN','SUCCEEDED','FAILED','REJECTED');
CREATE TYPE ledger_kind  AS ENUM ('GRANT','HOLD','CAPTURE','RELEASE','REFUND');

-- ===== lanes: one outbound dependency (an ERP endpoint, or the LLM provider) =====
CREATE TABLE lanes (
  id                 text PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('erp','llm')),
  base_url           text,                                   -- erp lanes only
  rate_per_sec       integer NOT NULL CHECK (rate_per_sec > 0),
  burst              integer NOT NULL CHECK (burst > 0),
  max_in_flight      integer NOT NULL CHECK (max_in_flight > 0),
  request_timeout_ms integer NOT NULL CHECK (request_timeout_ms > 0),
  lease_ms           integer NOT NULL,
  max_read_lag_ms    integer NOT NULL DEFAULT 0 CHECK (max_read_lag_ms >= 0),
  webhook_secret     text,                                   -- HMAC secret (A17); NULL = not verified
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (lease_ms > request_timeout_ms)
);

-- stale-read suspicion protects money (D2), so it lives in Postgres, not Redis
CREATE TABLE lane_health (
  lane_id               text PRIMARY KEY REFERENCES lanes(id),
  stale_suspected_until timestamptz,
  last_evidence         jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  api_key_hash     text NOT NULL UNIQUE,                     -- sha256 hex of the bearer key
  erp_lane_id      text NOT NULL REFERENCES lanes(id),
  erp_company_code text NOT NULL,
  max_pending      integer NOT NULL DEFAULT 10000,           -- backpressure cap (A7)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (erp_lane_id, erp_company_code)
);

CREATE TABLE price_list (
  action_type              text PRIMARY KEY,
  hold_amount              bigint NOT NULL CHECK (hold_amount > 0),
  capture_amount           bigint NOT NULL CHECK (capture_amount > 0 AND capture_amount <= hold_amount),
  cache_hit_capture_amount bigint CHECK (cache_hit_capture_amount > 0 AND cache_hit_capture_amount <= hold_amount)
);

-- projection of the ledger (D7); the ledger is the truth
CREATE TABLE wallets (
  tenant_id  text PRIMARY KEY REFERENCES tenants(id),
  available  bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  held       bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== actions: durable record AND the queue (D8) =====
CREATE TABLE actions (
  id                    uuid PRIMARY KEY,                    -- also the ERP reference
  tenant_id             text NOT NULL REFERENCES tenants(id),
  lane_id               text NOT NULL REFERENCES lanes(id),
  action_type           text NOT NULL,
  idempotency_key       text NOT NULL,
  payload               jsonb NOT NULL,
  payload_hash          text NOT NULL,                       -- sha256(canonical_json({action_type,payload}))
  conflict_key          text,                                -- e.g. 'invoice:INV-C100-00001' (A10)
  state                 action_state NOT NULL,
  hold_amount           bigint NOT NULL DEFAULT 0,
  captured_amount       bigint,
  dispatch_count        integer NOT NULL DEFAULT 0,          -- claims into DISPATCHING (sends attempted)
  retry_count           integer NOT NULL DEFAULT 0,          -- not-committed retries (429/503/unreachable)
  ambiguous_count       integer NOT NULL DEFAULT 0,          -- times entered UNKNOWN
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner           text,
  lease_until           timestamptz,
  dispatched_at         timestamptz,                         -- last claim time
  unknown_since         timestamptz,
  trust_not_found_after timestamptz,                         -- D2 rule (a)
  not_found_count       integer NOT NULL DEFAULT 0,          -- consecutive trusted not-founds, D2 rule (d)
  next_reconcile_at     timestamptz,
  reconcile_attempts    integer NOT NULL DEFAULT 0,
  result                jsonb,                               -- ERP payment / classification result
  failure_code          text,
  failure_message       text,
  confirmed_via         text CHECK (confirmed_via IN ('response','reconcile')),
  response_status       integer NOT NULL,                    -- stored submit response (immutable, A9)
  response_body         jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  CONSTRAINT actions_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX actions_one_active_per_target ON actions (tenant_id, conflict_key)
  WHERE conflict_key IS NOT NULL AND state IN ('QUEUED','DISPATCHING','UNKNOWN');
CREATE INDEX actions_ready_idx      ON actions (lane_id, tenant_id, next_attempt_at) WHERE state = 'QUEUED';
CREATE INDEX actions_lease_idx      ON actions (lease_until)       WHERE state = 'DISPATCHING';
CREATE INDEX actions_unknown_idx    ON actions (next_reconcile_at) WHERE state = 'UNKNOWN';
CREATE INDEX actions_pending_idx    ON actions (tenant_id)         WHERE state IN ('QUEUED','DISPATCHING','UNKNOWN');
CREATE INDEX actions_witness_idx    ON actions (lane_id, dispatched_at)
  WHERE state = 'SUCCEEDED' AND confirmed_via = 'response';

CREATE TABLE action_events (
  id         bigserial PRIMARY KEY,
  action_id  uuid NOT NULL REFERENCES actions(id),
  from_state action_state,                                   -- NULL on insert
  to_state   action_state NOT NULL,
  reason     text NOT NULL,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_events_action_idx ON action_events (action_id, id);

-- ===== ledger: append-only, with signed deltas per bucket =====
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id),
  action_id       uuid REFERENCES actions(id),
  kind            ledger_kind NOT NULL,
  amount          bigint NOT NULL CHECK (amount > 0),
  available_delta bigint NOT NULL,
  held_delta      bigint NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'GRANT'   AND available_delta =  amount AND held_delta = 0) OR
    (kind = 'HOLD'    AND available_delta = -amount AND held_delta = amount) OR
    (kind = 'CAPTURE' AND available_delta = 0       AND held_delta = -amount) OR
    (kind = 'RELEASE' AND available_delta =  amount AND held_delta = -amount) OR
    (kind = 'REFUND'  AND available_delta =  amount AND held_delta = 0)
  ),
  CHECK (kind IN ('GRANT','REFUND') OR action_id IS NOT NULL)
);
CREATE UNIQUE INDEX ledger_one_kind_per_action ON ledger_entries (action_id, kind) WHERE action_id IS NOT NULL;
CREATE INDEX ledger_tenant_idx ON ledger_entries (tenant_id, id);

-- ===== fairness cursor (A5) =====
CREATE TABLE lane_tenant_cursor (
  lane_id            text NOT NULL REFERENCES lanes(id),
  tenant_id          text NOT NULL REFERENCES tenants(id),
  last_dispatched_at timestamptz NOT NULL,
  PRIMARY KEY (lane_id, tenant_id)
);

-- ===== webhook log (D5): durable, deduped =====
CREATE TABLE erp_events (
  id           bigserial PRIMARY KEY,
  lane_id      text NOT NULL REFERENCES lanes(id),
  event_id     text NOT NULL,
  company_code text NOT NULL,
  object_type  text NOT NULL CHECK (object_type IN ('vendor','invoice','payment')),
  object_id    text NOT NULL,
  seq          bigint NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lane_id, event_id)
);

-- ===== LLM classification cache (A13): immutable =====
CREATE TABLE classification_cache (
  cache_key        text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id),
  input            jsonb NOT NULL,
  result           jsonb NOT NULL,
  model            text NOT NULL,
  prompt_version   text NOT NULL,
  source_action_id uuid REFERENCES actions(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ===== guards =====
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON action_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON action_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER classification_immutable BEFORE UPDATE OR DELETE ON classification_cache
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION guard_action_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY[
    'QUEUED>DISPATCHING', 'QUEUED>FAILED',
    'DISPATCHING>SUCCEEDED', 'DISPATCHING>FAILED', 'DISPATCHING>QUEUED', 'DISPATCHING>UNKNOWN',
    'UNKNOWN>SUCCEEDED', 'UNKNOWN>QUEUED', 'UNKNOWN>FAILED'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('QUEUED','REJECTED') THEN
      RAISE EXCEPTION 'actions must be inserted as QUEUED or REJECTED, got %', NEW.state;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.lane_id <> OLD.lane_id
     OR NEW.action_type <> OLD.action_type OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.payload <> OLD.payload OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.conflict_key IS DISTINCT FROM OLD.conflict_key OR NEW.hold_amount <> OLD.hold_amount
     OR NEW.response_status <> OLD.response_status OR NEW.response_body <> OLD.response_body
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable action column changed (action %)', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state::text || '>' || NEW.state::text) = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal transition % -> % (action %)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER actions_guard BEFORE INSERT OR UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION guard_action_row();
CREATE TRIGGER actions_no_delete BEFORE DELETE ON actions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
