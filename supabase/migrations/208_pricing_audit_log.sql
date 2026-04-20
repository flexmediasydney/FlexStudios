-- 208_pricing_audit_log.sql
-- Immutable audit trail for every change to a project's calculated_price.
--
-- Rationale: we now have several paths that mutate calculated_price —
-- recalculateProjectPricingServerSide, applyRevisionPricingImpact,
-- revertRevisionPricingImpact, bulkRecomputeProjectsByMatrix (phase 3c),
-- direct form save via ProjectPricingTable, Tonomo webhook recomputes.
-- When a number shifts in production we need to answer "who/what/when/why"
-- in one query, not by cross-referencing five tables.
--
-- This table is append-only. Each row captures the delta + the matrix version
-- in play at both sides, plus a reason enum that maps 1:1 to the write path.
-- Reads by dashboards/admin, writes by edge functions (SECURITY DEFINER RPC
-- so we don't need to grant INSERT on the table directly).
--
-- Retention: keep forever (small table; ~1 row per project recompute; ~100s
-- of rows/month in steady state). Old rows have historical/audit value.

BEGIN;

CREATE TABLE IF NOT EXISTS pricing_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  old_price numeric,
  new_price numeric NOT NULL,
  price_delta numeric GENERATED ALWAYS AS (new_price - COALESCE(old_price, 0)) STORED,
  old_version_id uuid REFERENCES price_matrix_versions(id) ON DELETE SET NULL,
  new_version_id uuid REFERENCES price_matrix_versions(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN (
    'initial',                 -- project creation / first compute
    'user_edit',               -- save via ProjectPricingTable / ProjectForm
    'revision_apply',          -- applyRevisionPricingImpact
    'revision_revert',         -- revertRevisionPricingImpact
    'tonomo_webhook',          -- Tonomo delta / order update
    'bulk_matrix_recompute',   -- bulkRecomputeProjectsByMatrix
    'manual_admin_override',   -- explicit admin override
    'system_reconcile'         -- cron-driven reconciliation
  )),
  triggered_by text NOT NULL CHECK (triggered_by IN (
    'user', 'system', 'webhook', 'cron', 'revision', 'bulk'
  )),
  actor_id uuid,               -- supabase auth user if known, else null
  actor_name text,             -- denormalised for audit readability
  engine_version text,         -- copied from PricingResult
  notes text,                  -- freeform — revision id, webhook id, etc.
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_audit_project_time
  ON pricing_audit_log (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_reason_time
  ON pricing_audit_log (reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_audit_new_version
  ON pricing_audit_log (new_version_id) WHERE new_version_id IS NOT NULL;

COMMENT ON TABLE pricing_audit_log IS
  'Append-only audit of every change to projects.calculated_price. Written by edge functions via record_pricing_audit() RPC.';

-- ── Write helper — security-definer RPC ─────────────────────────────────
-- Edge functions invoke this via PostgREST. Single parameterised signature
-- avoids each caller having to match the column set exactly.
CREATE OR REPLACE FUNCTION record_pricing_audit(
  p_project_id uuid,
  p_old_price numeric,
  p_new_price numeric,
  p_old_version_id uuid,
  p_new_version_id uuid,
  p_reason text,
  p_triggered_by text,
  p_actor_id uuid DEFAULT NULL,
  p_actor_name text DEFAULT NULL,
  p_engine_version text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Skip no-op writes — we only care when the price actually moved.
  IF p_old_price IS NOT NULL AND ABS(COALESCE(p_new_price,0) - COALESCE(p_old_price,0)) < 0.01 THEN
    RETURN NULL;
  END IF;

  INSERT INTO pricing_audit_log (
    project_id, old_price, new_price,
    old_version_id, new_version_id,
    reason, triggered_by, actor_id, actor_name, engine_version, notes
  ) VALUES (
    p_project_id, p_old_price, p_new_price,
    p_old_version_id, p_new_version_id,
    p_reason, p_triggered_by, p_actor_id, p_actor_name, p_engine_version, p_notes
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_pricing_audit TO service_role, authenticated;

COMMIT;
