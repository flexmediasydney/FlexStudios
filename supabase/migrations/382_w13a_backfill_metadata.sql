-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 382 — Wave 13a: Historical FlexMedia backfill metadata
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W13a-historical-flexmedia-goldmine.md
-- Wave: W13a — manual-trigger backfill of legacy FlexMedia projects through the
--             Shape D engine, generating training_examples for W14 calibration
--             and populating object_registry.market_frequency for W12.
--
-- ─── WHAT SHIPS HERE ──────────────────────────────────────────────────────────
--
--   1. shortlisting_rounds gains:
--        - is_synthetic_backfill BOOLEAN NOT NULL DEFAULT FALSE
--        - backfill_source_paths JSONB
--        - status CHECK constraint extended to allow 'backfilled'
--   2. composition_groups gains:
--        - synthetic_finals_match_stem TEXT
--   3. shortlisting_backfill_log table (status tracking + cost ledger)
--   4. RLS for shortlisting_backfill_log (master_admin SELECT/UPDATE; INSERT/
--      DELETE service-role only).
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. Why a NEW status value `backfilled` (not reusing `proposed` / `delivered`):
--    Backfilled rounds are post-hoc — they never went through the normal
--    pending → processing → proposed → locked → delivered lifecycle. The
--    dispatcher must NEVER see them as candidates for normal lifecycle work
--    (no notification on completion, no UI prompt to lock, no auto-shortlist).
--    A dedicated terminal status keeps the synthetic round visible for audit
--    + analytics queries while excluded from production flows.
--
-- 2. Why `is_synthetic_backfill` BOOLEAN in addition to the status:
--    Status answers "what stage is the round at"; the boolean answers "is this
--    a real round at all". Multiple status values may eventually be backfill-
--    flavoured (e.g. `backfilled_failed`); the boolean is the stable filter
--    for "exclude synthetic from training-data extraction queries".
--
-- 3. Why `backfill_source_paths` JSONB (not two TEXT columns):
--    Backfill source semantics may evolve (e.g. add a `_AUDIT` path, multiple
--    raws subfolders for multi-shoot projects). JSONB lets the schema absorb
--    those without DDL. Shape today: { raws: TEXT, finals: TEXT }.
--
-- 4. Why `synthetic_finals_match_stem` on composition_groups (not a separate
--    table): the composition group IS the row that the editor's chosen final
--    matches against. Storing the matched final's stem inline makes joins
--    trivial for the W14 calibration extractor: one row per composition with
--    the boolean signal "did the editor pick this composition's lineage?".
--    A separate finals_matches table would force a JOIN on every analytics
--    query for negligible gain.
--
-- 5. shortlisting_backfill_log is a standalone table (not just a column on
--    shortlisting_rounds). Reasons:
--      (a) Idempotent retry: failed attempts archive to log rows with
--          status='failed', a retry creates a NEW log row — preserves attempt
--          history. shortlisting_rounds.id is round-once; we'd lose the
--          history if we stuffed retry attempts into the round row.
--      (b) Pre-flight rejections (project not delivered, paths missing, cost
--          exceeded) need to log even when no synthetic round exists. The
--          log row is created BEFORE the synthetic round, so it can carry
--          status='failed' with a NULL round_id when pre-flight rejects.
--      (c) Cost reconciliation lives in the log row, not on the round, so
--          downstream cost reports query one focused table.
--
-- 6. Cost cap belt-and-braces:
--    The edge fn enforces three layers:
--      - Pre-flight estimate vs caller-supplied `cost_cap_usd` (request-level)
--      - engine_settings.cost_cap_per_round_usd (system-level circuit breaker)
--      - Background watchdog: actual_cost_usd > 1.5x estimate → abort + mark
--        log row 'failed'
--    The schema doesn't enforce these — it just provides the columns the edge
--    fn writes to.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. shortlisting_rounds: synthetic-backfill columns + status enum ────────

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS is_synthetic_backfill BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS backfill_source_paths JSONB;

COMMENT ON COLUMN shortlisting_rounds.is_synthetic_backfill IS
  'Wave 13a (P2-4): TRUE when this round was created by '
  'shortlisting-historical-backfill — a synthetic round tied to a delivered '
  'legacy project, processed through the Shape D engine to generate training '
  'examples for W14 calibration and seed object_registry.market_frequency. '
  'Always paired with status=''backfilled''. Excluded from normal '
  'shortlisting flows (no auto-lock, no agent notification).';

COMMENT ON COLUMN shortlisting_rounds.backfill_source_paths IS
  'Wave 13a (P2-4): { raws: TEXT, finals: TEXT } Dropbox paths captured at '
  'backfill request time. NULL on non-backfill rounds. Source-of-truth for '
  '"where did this synthetic round get its source data" replay queries.';

-- Extend the status CHECK constraint to include 'backfilled'. The constraint
-- was last updated in mig 341 (added 'manual'); we now extend it to add
-- 'backfilled' too. Both DROP+ADD keep the existing values.

ALTER TABLE shortlisting_rounds
  DROP CONSTRAINT IF EXISTS shortlisting_rounds_status_check;

ALTER TABLE shortlisting_rounds
  ADD CONSTRAINT shortlisting_rounds_status_check
  CHECK (status IN (
    'pending',
    'processing',
    'proposed',
    'locked',
    'delivered',
    'manual',
    'backfilled'
  ));

COMMENT ON COLUMN shortlisting_rounds.status IS
  'Wave 13a (P2-4): added ''backfilled'' for synthetic rounds created by '
  'shortlisting-historical-backfill. ''backfilled'' is a TERMINAL status — the '
  'dispatcher excludes these from its candidate queries; lock/delivery flows '
  'skip them. Other values: pending|processing|proposed|locked|delivered '
  '(normal lifecycle, mig 282/289), manual (W7.13, mig 341 — synthetic round '
  'when shortlisting unsupported / no photo products).';

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_synthetic_backfill
  ON shortlisting_rounds(is_synthetic_backfill, project_id)
  WHERE is_synthetic_backfill = TRUE;

-- 1b. Extend trigger_source CHECK to include 'historical_backfill'.
-- The synthetic round inserted by shortlisting-historical-backfill carries
-- trigger_source='historical_backfill' to distinguish from manual / auto /
-- reshoot. The original CHECK constraint (mig 282 era) only allowed
-- {auto_settling, manual, reshoot}; this is an additive relaxation.

ALTER TABLE shortlisting_rounds
  DROP CONSTRAINT IF EXISTS shortlisting_rounds_trigger_source_check;

ALTER TABLE shortlisting_rounds
  ADD CONSTRAINT shortlisting_rounds_trigger_source_check
  CHECK (
    trigger_source IS NULL OR trigger_source = ANY (ARRAY[
      'auto_settling',
      'manual',
      'reshoot',
      'historical_backfill'
    ])
  );

COMMENT ON COLUMN shortlisting_rounds.trigger_source IS
  'Wave 13a (P2-4): how the round was initiated. auto_settling (Wave 7) | '
  'manual (operator) | reshoot | historical_backfill (Wave 13a — synthetic '
  'round from shortlisting-historical-backfill, paired with status=backfilled).';

-- ─── 2. composition_groups: backfilled-finals match-stem ─────────────────────

ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS synthetic_finals_match_stem TEXT;

COMMENT ON COLUMN composition_groups.synthetic_finals_match_stem IS
  'Wave 13a (P2-4): when this composition (from a synthetic backfill round) '
  'matches a final the human editor delivered, this column carries the '
  'final''s filename stem (e.g. "12_smith_st_mosman_03_kitchen_island"). '
  'Populated by shortlisting-historical-backfill''s post-Stage-4 enrichment. '
  'NULL for non-backfill compositions OR for backfill compositions where no '
  'final matched (signal: "the editor did NOT pick this composition"). This '
  'is the ground-truth signal that powers W14 calibration: under fixed engine '
  'inputs, did the engine''s top-N selection align with the editor''s '
  'top-N delivery?';

CREATE INDEX IF NOT EXISTS idx_composition_groups_finals_match
  ON composition_groups(synthetic_finals_match_stem)
  WHERE synthetic_finals_match_stem IS NOT NULL;

-- ─── 3. shortlisting_backfill_log ────────────────────────────────────────────
--
-- One row per backfill attempt. Tracks lifecycle (queued → running →
-- succeeded|failed), cost, attribution, and source paths. Retry-friendly:
-- a failed attempt's row stays for audit; a fresh retry creates a NEW row.

CREATE TABLE IF NOT EXISTS shortlisting_backfill_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The legacy project being backfilled. Required at every status; the log
  -- row exists even when pre-flight rejects (status='failed' with no round).
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- The synthetic round produced (NULL while queued; populated when round
  -- is inserted; nullable when pre-flight rejects before round creation).
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE SET NULL,

  -- Source paths from the request (mirrored on the round.backfill_source_paths
  -- but kept here so failed pre-flights still capture them for diagnostics).
  raws_dropbox_path TEXT NOT NULL,
  finals_dropbox_path TEXT NOT NULL,

  -- Lifecycle status
  status TEXT NOT NULL DEFAULT 'queued',
  CONSTRAINT shortlisting_backfill_log_status_chk
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'aborted')),

  -- Cost discipline
  cost_cap_usd NUMERIC(8, 4) NOT NULL,           -- caller-supplied cap
  estimated_cost_usd NUMERIC(8, 4),              -- pre-flight estimate
  cost_usd NUMERIC(8, 4),                         -- actual; populated on terminal status
  raws_count INT,
  finals_count INT,

  -- Attribution
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,                         -- when status moved to 'running'
  completed_at TIMESTAMPTZ,                       -- when status moved terminal
  failure_reason TEXT,                            -- short human-readable; richer detail in shortlisting_events

  -- Audit
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE shortlisting_backfill_log IS
  'Wave 13a (P2-4): per-attempt log for shortlisting-historical-backfill. '
  'One row per backfill request — including pre-flight rejections that never '
  'reached round creation. Retry-friendly: a failed attempt''s row freezes '
  'for audit; a fresh retry creates a new row. Cost ledger lives here (cap '
  'requested + estimate + actual) so cost reports query one table.';

COMMENT ON COLUMN shortlisting_backfill_log.status IS
  'queued (request accepted, synthetic round + ingest job queued) | running '
  '(ingest fired; chain in flight) | succeeded (Stage 4 + persistence both '
  'completed; cost recorded) | failed (any stage errored or cost exceeded) | '
  'aborted (operator-cancelled mid-run; reserved, currently unused).';

COMMENT ON COLUMN shortlisting_backfill_log.cost_cap_usd IS
  'Caller-supplied per-request cost cap. Pre-flight rejects if estimate > cap; '
  'background watchdog rejects if actual > 1.5×estimate. Schema doesn''t '
  'enforce; the edge fn does.';

CREATE INDEX IF NOT EXISTS idx_backfill_log_project
  ON shortlisting_backfill_log(project_id);
CREATE INDEX IF NOT EXISTS idx_backfill_log_round
  ON shortlisting_backfill_log(round_id) WHERE round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_backfill_log_status
  ON shortlisting_backfill_log(status);
CREATE INDEX IF NOT EXISTS idx_backfill_log_requested_at
  ON shortlisting_backfill_log(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_backfill_log_active_per_project
  ON shortlisting_backfill_log(project_id)
  WHERE status IN ('queued', 'running');

-- updated_at auto-bump trigger (matches mig 376 engine_run_audit pattern).

CREATE OR REPLACE FUNCTION shortlisting_backfill_log_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shortlisting_backfill_log_updated_at_trigger
  ON shortlisting_backfill_log;
CREATE TRIGGER shortlisting_backfill_log_updated_at_trigger
  BEFORE UPDATE ON shortlisting_backfill_log
  FOR EACH ROW
  EXECUTE FUNCTION shortlisting_backfill_log_set_updated_at();

-- ─── 4. RLS for shortlisting_backfill_log ────────────────────────────────────
-- Pattern mirrors mig 376 engine_run_audit:
--   * SELECT to master_admin + admin (read for ops dashboards)
--   * UPDATE to master_admin only (correcting status/notes)
--   * INSERT/DELETE service-role only (the edge fn writes; never hand-deleted)

ALTER TABLE shortlisting_backfill_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shortlisting_backfill_log_select_admin"
  ON shortlisting_backfill_log;
CREATE POLICY "shortlisting_backfill_log_select_admin"
  ON shortlisting_backfill_log
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

DROP POLICY IF EXISTS "shortlisting_backfill_log_update_master"
  ON shortlisting_backfill_log;
CREATE POLICY "shortlisting_backfill_log_update_master"
  ON shortlisting_backfill_log
  FOR UPDATE TO authenticated USING (
    get_user_role() = 'master_admin'
  );
-- INSERT/DELETE: no policy → denied for authenticated; service-role bypasses
-- RLS via the service key (the edge fn always uses getAdminClient()).

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP TRIGGER IF EXISTS shortlisting_backfill_log_updated_at_trigger
--   ON shortlisting_backfill_log;
-- DROP FUNCTION IF EXISTS shortlisting_backfill_log_set_updated_at();
--
-- ALTER TABLE shortlisting_backfill_log DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS shortlisting_backfill_log;
--
-- DROP INDEX IF EXISTS idx_composition_groups_finals_match;
-- ALTER TABLE composition_groups
--   DROP COLUMN IF EXISTS synthetic_finals_match_stem;
--
-- DROP INDEX IF EXISTS idx_shortlisting_rounds_synthetic_backfill;
-- ALTER TABLE shortlisting_rounds
--   DROP CONSTRAINT IF EXISTS shortlisting_rounds_status_check;
-- ALTER TABLE shortlisting_rounds
--   ADD CONSTRAINT shortlisting_rounds_status_check
--   CHECK (status IN ('pending','processing','proposed','locked','delivered','manual'));
-- ALTER TABLE shortlisting_rounds
--   DROP COLUMN IF EXISTS backfill_source_paths;
-- ALTER TABLE shortlisting_rounds
--   DROP COLUMN IF EXISTS is_synthetic_backfill;
--
-- Rollback is data-lossy if any backfill runs have been recorded. Pre-rollback
-- dump:
--   CREATE TABLE _rollback_w13a_backfill_log AS
--     SELECT * FROM shortlisting_backfill_log;
