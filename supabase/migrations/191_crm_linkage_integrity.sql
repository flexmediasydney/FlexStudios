-- 191_crm_linkage_integrity.sql
-- CRM-linkage integrity layer for pulse_agencies + pulse_agents.
--
-- ── Problem ─────────────────────────────────────────────────────────────────
-- pulse_agencies.is_in_crm is a boolean flag toggled by the Mappings tab (and
-- other human-in-the-loop flows) to mark an entity as "yes, this is one of
-- our clients". pulse_agencies.linked_agency_id is the actual FK to the CRM
-- org row that fires the price_matrix / package overrides. The two are
-- INDEPENDENT columns, set by different code paths. Today 3 of 11 flagged-
-- in-crm pulse_agencies have is_in_crm=true BUT linked_agency_id IS NULL —
-- meaning 225+ live listings silently miss their agency's price_matrix during
-- the Market Share / Missed Opportunity substrate computation. The broken
-- row for "Ray White United Group" (a hyphen-vs-no-hyphen mismatch with
-- CRM's "Ray White - United Group") is the prototype of the bug class.
--
-- ── What this migration installs ────────────────────────────────────────────
--   1. `pulse_linkage_issues` — append-only log of integrity violations with
--      detected_at / resolved_at / auto_fixed / proposed_crm_id columns so
--      the Mappings tab can render a worklist.
--   2. AFTER UPDATE trigger on pulse_agencies + pulse_agents that detects
--      the two inconsistency shapes ('flagged_but_unlinked' and
--      'linked_but_flag_false') and appends to pulse_linkage_issues. NEVER
--      blocks the write (RAISE WARNING only) so nothing upstream regresses.
--   3. `pulse_reconcile_crm_linkage(entity_type, auto_apply_threshold)` —
--      the actual repair RPC. Fuzzy-matches orphan pulse rows against the
--      CRM agencies/agents table using pg_trgm + Jaccard token + length-
--      normalised edit distance, auto-links at high confidence, stages
--      review items in the 0.7-threshold band, flags ambiguous.
--   4. AFTER UPDATE trigger on pulse_agencies.linked_agency_id + pulse_agents
--      .linked_agent_id — when a NULL→UUID transition happens, marks
--      pulse_listing_missed_opportunity rows for that agency's listings as
--      `quote_status='stale'` so `pulseComputeStaleQuotes` picks them up on
--      the next cron and re-applies the matrix.
--   5. Registration of new pulse_timeline event_types:
--        agency_linked_to_crm, agent_linked_to_crm, linkage_issue_detected
--   6. End-of-migration DO $$ block that calls pulse_reconcile_crm_linkage
--      for both 'agency' and 'agent' so the current 3 orphans get auto-
--      linked immediately (Ray White United Group should score 1.0 after
--      normalisation).
--
-- ── Safety ──────────────────────────────────────────────────────────────────
-- All creates are IF NOT EXISTS / CREATE OR REPLACE. Triggers use DROP-first
-- pattern so the migration is rerunnable.
--
-- ── Contract with parallel agents ───────────────────────────────────────────
-- Agent B (substrate invalidation) is adding triggers on price_matrices,
-- packages, products — my pulse_agencies/pulse_agents.linked_*_id trigger is
-- orthogonal (different source tables) and uses a separate function name
-- (`pulse_linkage_change_invalidate`) so there's no collision.
-- Agent C (legacy_projects) will emit linkage timeline events using the same
-- event_type taxonomy registered below.

BEGIN;

-- pg_trgm is already installed (see 001_initial_schema.sql + 114) but
-- re-declare defensively — this migration depends on similarity() being
-- available at execution time.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. pulse_linkage_issues — log of integrity violations
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pulse_linkage_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL CHECK (entity_type IN ('agency', 'agent')),
  entity_id       uuid NOT NULL,
  issue_type      text NOT NULL CHECK (issue_type IN (
                    'flagged_but_unlinked',
                    'linked_but_flag_false',
                    'name_mismatch'
                  )),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  auto_fixed      boolean NOT NULL DEFAULT false,
  proposed_crm_id uuid,
  proposed_confidence numeric,
  -- Runner-up candidate so the UI can show disambiguation context.
  runner_up_crm_id uuid,
  runner_up_confidence numeric,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Only one UNRESOLVED row per entity+issue_type at a time. The partial
-- unique index lets historical rows (resolved_at NOT NULL) stay in place
-- for audit but prevents double-logging on consecutive writes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_linkage_issues_live
  ON pulse_linkage_issues (entity_type, entity_id, issue_type)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_linkage_issues_entity
  ON pulse_linkage_issues (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pulse_linkage_issues_detected
  ON pulse_linkage_issues (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_pulse_linkage_issues_unresolved
  ON pulse_linkage_issues (detected_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE pulse_linkage_issues IS
  'Append-only log of pulse_agencies/pulse_agents CRM-linkage invariant '
  'violations. Populated by AFTER UPDATE triggers; consumed by the '
  'Mappings tab Linkage Integrity card and pulse_reconcile_crm_linkage.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. pulse_timeline event_type registration
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  ('agency_linked_to_crm', 'linkage',
   'pulse_agencies.linked_agency_id populated — agency now resolves to a CRM org'),
  ('agent_linked_to_crm', 'linkage',
   'pulse_agents.linked_agent_id populated — agent now resolves to a CRM contact'),
  ('linkage_issue_detected', 'linkage',
   'Integrity trigger detected an is_in_crm / linked_*_id inconsistency'),
  ('linkage_issue_resolved', 'linkage',
   'Reconciler or human resolved a previously-flagged linkage issue')
ON CONFLICT (event_type) DO UPDATE SET
  category = EXCLUDED.category,
  description = EXCLUDED.description;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. Helper — normalised comparable name
-- ══════════════════════════════════════════════════════════════════════════════
-- Rules:
--   * lowercase
--   * collapse runs of whitespace to a single space
--   * strip ` - ` separators (hyphen variants with surrounding whitespace)
--   * trim ends
-- This is intentionally narrower than a full slug: it keeps apostrophes and
-- ampersands so e.g. "Raine & Horne" stays distinguishable from "Raine Horne".

CREATE OR REPLACE FUNCTION pulse_normalize_linkage_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_name IS NULL THEN NULL
    ELSE btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(p_name), E'\\s*[-–—]\\s*', ' ', 'g'),
          E'\\s+', ' ', 'g'),
        E'^\\s+|\\s+$', '', 'g')
    )
  END
$fn$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. Helper — scoring ensemble
-- ══════════════════════════════════════════════════════════════════════════════
-- Returns a single score in [0,1] combining:
--   * pg_trgm similarity              (captures character-level distance)
--   * token Jaccard                   (captures word-order invariance)
--   * length-normalised edit distance (captures small-string precision)
-- Weighted 0.5 / 0.3 / 0.2.

CREATE OR REPLACE FUNCTION pulse_linkage_name_score(p_a text, p_b text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_a text := pulse_normalize_linkage_name(p_a);
  v_b text := pulse_normalize_linkage_name(p_b);
  v_trgm numeric;
  v_jaccard numeric;
  v_levlen numeric;
  v_tokens_a text[];
  v_tokens_b text[];
  v_intersect int;
  v_union int;
  v_maxlen int;
  v_dist int;
BEGIN
  IF v_a IS NULL OR v_b IS NULL OR v_a = '' OR v_b = '' THEN
    RETURN 0;
  END IF;

  -- Trigram similarity (pg_trgm built-in)
  v_trgm := similarity(v_a, v_b);

  -- Jaccard over word tokens
  v_tokens_a := string_to_array(v_a, ' ');
  v_tokens_b := string_to_array(v_b, ' ');
  SELECT count(DISTINCT t) INTO v_intersect
  FROM (SELECT unnest(v_tokens_a) INTERSECT SELECT unnest(v_tokens_b)) q(t);
  SELECT count(DISTINCT t) INTO v_union
  FROM (SELECT unnest(v_tokens_a) UNION SELECT unnest(v_tokens_b)) q(t);
  v_jaccard := CASE WHEN v_union = 0 THEN 0 ELSE v_intersect::numeric / v_union END;

  -- Length-normalised Levenshtein (1 - dist/maxlen)
  v_maxlen := greatest(length(v_a), length(v_b));
  v_dist := levenshtein(v_a, v_b);
  v_levlen := CASE WHEN v_maxlen = 0 THEN 0
                   ELSE 1 - (v_dist::numeric / v_maxlen) END;
  IF v_levlen < 0 THEN v_levlen := 0; END IF;

  RETURN round(
    (v_trgm * 0.5) + (v_jaccard * 0.3) + (v_levlen * 0.2),
    4
  );
END;
$fn$;

-- `levenshtein` lives in fuzzystrmatch — declare defensively in case it's
-- not already installed. pg_trgm + fuzzystrmatch together ship on Supabase.
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. Invariant trigger — detects is_in_crm / linked_*_id inconsistencies
-- ══════════════════════════════════════════════════════════════════════════════
-- Fires AFTER UPDATE. Never blocks the write — just RAISE WARNING + log.
-- Two shapes checked:
--   * is_in_crm=true  AND linked_*_id IS NULL      → 'flagged_but_unlinked'
--   * is_in_crm=false AND linked_*_id IS NOT NULL  → 'linked_but_flag_false'
--
-- ON CONFLICT (live partial unique) DO UPDATE refreshes detected_at so the
-- UI keeps a freshness signal without the table growing unboundedly.

CREATE OR REPLACE FUNCTION pulse_agency_linkage_invariant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Shape 1: flagged but unlinked
  IF NEW.is_in_crm = true AND NEW.linked_agency_id IS NULL THEN
    RAISE WARNING 'pulse_agencies % is_in_crm=true but linked_agency_id IS NULL (name=%)',
      NEW.id, NEW.name;
    INSERT INTO pulse_linkage_issues (entity_type, entity_id, issue_type, detected_at, notes)
    VALUES ('agency', NEW.id, 'flagged_but_unlinked', now(),
            'Trigger: is_in_crm flipped true but FK still NULL — pricing matrix will not apply.')
    ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
    DO UPDATE SET detected_at = now(), updated_at = now();
  -- Shape 2: linked but flag says false
  ELSIF NEW.is_in_crm = false AND NEW.linked_agency_id IS NOT NULL THEN
    RAISE WARNING 'pulse_agencies % is_in_crm=false but linked_agency_id=% (name=%)',
      NEW.id, NEW.linked_agency_id, NEW.name;
    INSERT INTO pulse_linkage_issues (entity_type, entity_id, issue_type, detected_at, notes)
    VALUES ('agency', NEW.id, 'linked_but_flag_false', now(),
            'Trigger: FK set but is_in_crm flipped false — CRM flag out of sync.')
    ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
    DO UPDATE SET detected_at = now(), updated_at = now();
  ELSE
    -- Consistent state — resolve any outstanding issues on this entity.
    UPDATE pulse_linkage_issues
       SET resolved_at = now(), updated_at = now()
     WHERE entity_type = 'agency'
       AND entity_id = NEW.id
       AND resolved_at IS NULL
       AND issue_type IN ('flagged_but_unlinked', 'linked_but_flag_false');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- NEVER block the caller's write. Log + move on.
  RAISE WARNING 'pulse_agency_linkage_invariant non-fatal error on agency %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION pulse_agent_linkage_invariant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.is_in_crm = true AND NEW.linked_agent_id IS NULL THEN
    RAISE WARNING 'pulse_agents % is_in_crm=true but linked_agent_id IS NULL (name=%)',
      NEW.id, NEW.full_name;
    INSERT INTO pulse_linkage_issues (entity_type, entity_id, issue_type, detected_at, notes)
    VALUES ('agent', NEW.id, 'flagged_but_unlinked', now(),
            'Trigger: is_in_crm flipped true but FK still NULL.')
    ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
    DO UPDATE SET detected_at = now(), updated_at = now();
  ELSIF NEW.is_in_crm = false AND NEW.linked_agent_id IS NOT NULL THEN
    RAISE WARNING 'pulse_agents % is_in_crm=false but linked_agent_id=% (name=%)',
      NEW.id, NEW.linked_agent_id, NEW.full_name;
    INSERT INTO pulse_linkage_issues (entity_type, entity_id, issue_type, detected_at, notes)
    VALUES ('agent', NEW.id, 'linked_but_flag_false', now(),
            'Trigger: FK set but is_in_crm flipped false.')
    ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
    DO UPDATE SET detected_at = now(), updated_at = now();
  ELSE
    UPDATE pulse_linkage_issues
       SET resolved_at = now(), updated_at = now()
     WHERE entity_type = 'agent'
       AND entity_id = NEW.id
       AND resolved_at IS NULL
       AND issue_type IN ('flagged_but_unlinked', 'linked_but_flag_false');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pulse_agent_linkage_invariant non-fatal error on agent %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS pulse_agency_linkage_invariant_trg ON pulse_agencies;
CREATE TRIGGER pulse_agency_linkage_invariant_trg
  AFTER UPDATE OF is_in_crm, linked_agency_id ON pulse_agencies
  FOR EACH ROW
  WHEN (
    OLD.is_in_crm IS DISTINCT FROM NEW.is_in_crm
    OR OLD.linked_agency_id IS DISTINCT FROM NEW.linked_agency_id
  )
  EXECUTE FUNCTION pulse_agency_linkage_invariant();

DROP TRIGGER IF EXISTS pulse_agent_linkage_invariant_trg ON pulse_agents;
CREATE TRIGGER pulse_agent_linkage_invariant_trg
  AFTER UPDATE OF is_in_crm, linked_agent_id ON pulse_agents
  FOR EACH ROW
  WHEN (
    OLD.is_in_crm IS DISTINCT FROM NEW.is_in_crm
    OR OLD.linked_agent_id IS DISTINCT FROM NEW.linked_agent_id
  )
  EXECUTE FUNCTION pulse_agent_linkage_invariant();

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. Substrate invalidation — linkage change marks matrix-eligible listings stale
-- ══════════════════════════════════════════════════════════════════════════════
-- Context: `pulse_listing_missed_opportunity` is the per-listing substrate
-- that caches the computed engine price. When a NULL→UUID transition on
-- pulse_agencies.linked_agency_id happens, the price_matrix for that CRM
-- agency_id suddenly becomes VISIBLE to the engine for that agency's listings.
-- Mark their substrate rows `quote_status='stale'` — the `pulse-compute-
-- stale-quotes` cron (every 10min) will re-run the engine and apply the
-- matrix on the next pass.
--
-- Same for pulse_agents.linked_agent_id (agent-level matrices cover the
-- single agent dimension).
--
-- Orthogonal to Agent B's price_matrices/packages/products triggers: those
-- invalidate based on matrix changes. Ours invalidates based on the LINK
-- itself being created. Both invalidation paths converge on the same
-- pulse_listing_missed_opportunity.quote_status column; the cron doesn't
-- care who flipped it.

CREATE OR REPLACE FUNCTION pulse_linkage_change_invalidate_agency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_count integer := 0;
BEGIN
  -- Only care about NULL→UUID transition. Setting linked_agency_id to a
  -- different CRM id is rare (would be a re-mapping) — handle that too
  -- since it changes which matrix applies. NULL→NULL and UUID→NULL don't
  -- require invalidation here (matrix going away just means prior cached
  -- quote stays — cron will recompute next pass anyway via stale_quotes).
  IF NEW.linked_agency_id IS NOT NULL
     AND NEW.linked_agency_id IS DISTINCT FROM OLD.linked_agency_id THEN

    UPDATE pulse_listing_missed_opportunity pmo
       SET quote_status = 'stale',
           updated_at = now()
      FROM pulse_listings pl
     WHERE pmo.listing_id = pl.id
       AND pl.agency_rea_id = NEW.rea_agency_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- Emit a timeline row for auditability. Metadata captures the method
    -- so downstream analytics can distinguish cron auto-linkage from
    -- human Mappings-tab action.
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      new_value, metadata, source, idempotency_key, created_at
    )
    VALUES (
      'agency', NEW.id, NEW.rea_agency_id,
      'agency_linked_to_crm', 'linkage',
      COALESCE(NEW.name, 'Unknown agency') || ' linked to CRM',
      'Agency now resolves to CRM org — ' || v_count ||
        ' listing substrate rows marked stale for matrix re-apply.',
      jsonb_build_object('linked_agency_id', NEW.linked_agency_id,
                         'substrate_rows_invalidated', v_count),
      jsonb_build_object(
        'pulse_id', NEW.id,
        'crm_id', NEW.linked_agency_id,
        'method', 'trigger_auto',
        'previous_state', jsonb_build_object(
          'linked_agency_id', OLD.linked_agency_id,
          'is_in_crm', OLD.is_in_crm
        )
      ),
      'pulse_linkage_change_invalidate_agency',
      'agency_linked_to_crm:' || NEW.id || ':' || extract(epoch from now())::text,
      now()
    );

    -- Resolve any outstanding flagged_but_unlinked rows.
    UPDATE pulse_linkage_issues
       SET resolved_at = now(),
           auto_fixed = COALESCE(auto_fixed, false),
           updated_at = now()
     WHERE entity_type = 'agency'
       AND entity_id = NEW.id
       AND issue_type = 'flagged_but_unlinked'
       AND resolved_at IS NULL;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pulse_linkage_change_invalidate_agency non-fatal error on agency %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION pulse_linkage_change_invalidate_agent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_count integer := 0;
BEGIN
  IF NEW.linked_agent_id IS NOT NULL
     AND NEW.linked_agent_id IS DISTINCT FROM OLD.linked_agent_id THEN

    UPDATE pulse_listing_missed_opportunity pmo
       SET quote_status = 'stale',
           updated_at = now()
      FROM pulse_listings pl
     WHERE pmo.listing_id = pl.id
       AND pl.agent_rea_id = NEW.rea_agent_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      new_value, metadata, source, idempotency_key, created_at
    )
    VALUES (
      'agent', NEW.id, NEW.rea_agent_id,
      'agent_linked_to_crm', 'linkage',
      COALESCE(NEW.full_name, 'Unknown agent') || ' linked to CRM',
      'Agent now resolves to CRM contact — ' || v_count ||
        ' listing substrate rows marked stale.',
      jsonb_build_object('linked_agent_id', NEW.linked_agent_id,
                         'substrate_rows_invalidated', v_count),
      jsonb_build_object(
        'pulse_id', NEW.id,
        'crm_id', NEW.linked_agent_id,
        'method', 'trigger_auto',
        'previous_state', jsonb_build_object(
          'linked_agent_id', OLD.linked_agent_id,
          'is_in_crm', OLD.is_in_crm
        )
      ),
      'pulse_linkage_change_invalidate_agent',
      'agent_linked_to_crm:' || NEW.id || ':' || extract(epoch from now())::text,
      now()
    );

    UPDATE pulse_linkage_issues
       SET resolved_at = now(),
           updated_at = now()
     WHERE entity_type = 'agent'
       AND entity_id = NEW.id
       AND issue_type = 'flagged_but_unlinked'
       AND resolved_at IS NULL;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pulse_linkage_change_invalidate_agent non-fatal error on agent %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS pulse_linkage_change_invalidate_agency_trg ON pulse_agencies;
CREATE TRIGGER pulse_linkage_change_invalidate_agency_trg
  AFTER UPDATE OF linked_agency_id ON pulse_agencies
  FOR EACH ROW
  WHEN (OLD.linked_agency_id IS DISTINCT FROM NEW.linked_agency_id)
  EXECUTE FUNCTION pulse_linkage_change_invalidate_agency();

DROP TRIGGER IF EXISTS pulse_linkage_change_invalidate_agent_trg ON pulse_agents;
CREATE TRIGGER pulse_linkage_change_invalidate_agent_trg
  AFTER UPDATE OF linked_agent_id ON pulse_agents
  FOR EACH ROW
  WHEN (OLD.linked_agent_id IS DISTINCT FROM NEW.linked_agent_id)
  EXECUTE FUNCTION pulse_linkage_change_invalidate_agent();

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. pulse_reconcile_crm_linkage — the repair RPC
-- ══════════════════════════════════════════════════════════════════════════════
-- For every orphan (is_in_crm=true but linked_*_id IS NULL), fuzzy-match
-- against the CRM agencies/agents table and either:
--   * auto-apply if top score ≥ threshold AND unambiguous
--     (runner-up ≤ 0.7  OR  top-runner_up delta > 0.2)
--   * stage for review in the 0.7-threshold band
--   * mark ambiguous if top ≥ threshold but runner-up too close
--   * mark unmatchable if nothing crosses 0.5 floor
--
-- Returns jsonb {scanned, auto_applied, proposed_for_review, ambiguous,
-- unmatchable}. Idempotent: rerunning after an auto-link is a no-op because
-- the orphan list becomes empty. Rerunning with stale proposed rows just
-- refreshes their detected_at + proposed_confidence.

CREATE OR REPLACE FUNCTION pulse_reconcile_crm_linkage(
  p_entity_type text,
  p_auto_apply_threshold numeric DEFAULT 0.9
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_orphan record;
  v_cand   record;
  v_top_id uuid;
  v_top_score numeric;
  v_runnerup_id uuid;
  v_runnerup_score numeric;
  v_scanned int := 0;
  v_applied int := 0;
  v_proposed int := 0;
  v_ambiguous int := 0;
  v_unmatchable int := 0;
  v_candidates jsonb;
  v_floor numeric := 0.5;
  v_is_unambiguous boolean;
BEGIN
  IF p_entity_type NOT IN ('agency', 'agent') THEN
    RAISE EXCEPTION 'pulse_reconcile_crm_linkage: entity_type must be agency or agent, got %', p_entity_type;
  END IF;

  IF p_entity_type = 'agency' THEN
    -- ── AGENCY BRANCH ────────────────────────────────────────────────────
    FOR v_orphan IN
      SELECT id, name, rea_agency_id
      FROM pulse_agencies
      WHERE is_in_crm = true AND linked_agency_id IS NULL
    LOOP
      v_scanned := v_scanned + 1;
      v_top_id := NULL;      v_top_score := 0;
      v_runnerup_id := NULL; v_runnerup_score := 0;
      v_candidates := '[]'::jsonb;

      -- Score every CRM agency; keep top 2 + full top-5 in jsonb for audit.
      FOR v_cand IN
        SELECT a.id, a.name,
               pulse_linkage_name_score(v_orphan.name, a.name) AS score
          FROM agencies a
         WHERE a.name IS NOT NULL
         ORDER BY pulse_linkage_name_score(v_orphan.name, a.name) DESC
         LIMIT 5
      LOOP
        v_candidates := v_candidates || jsonb_build_object(
          'crm_id', v_cand.id,
          'crm_name', v_cand.name,
          'score', v_cand.score
        );
        IF v_cand.score > v_top_score THEN
          v_runnerup_id := v_top_id;
          v_runnerup_score := v_top_score;
          v_top_id := v_cand.id;
          v_top_score := v_cand.score;
        ELSIF v_cand.score > v_runnerup_score THEN
          v_runnerup_id := v_cand.id;
          v_runnerup_score := v_cand.score;
        END IF;
      END LOOP;

      v_is_unambiguous := (
        v_runnerup_score <= 0.7
        OR (v_top_score - v_runnerup_score) > 0.2
      );

      IF v_top_score >= p_auto_apply_threshold AND v_is_unambiguous THEN
        -- Auto-apply. The linkage-change trigger fires next and handles
        -- timeline event + substrate invalidation.
        UPDATE pulse_agencies
           SET linked_agency_id = v_top_id,
               updated_at = now()
         WHERE id = v_orphan.id;
        v_applied := v_applied + 1;

        -- Mark the outstanding issue resolved + auto_fixed.
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, resolved_at, auto_fixed,
          proposed_crm_id, proposed_confidence,
          runner_up_crm_id, runner_up_confidence,
          notes
        )
        VALUES (
          'agency', v_orphan.id, 'flagged_but_unlinked',
          now(), now(), true,
          v_top_id, v_top_score,
          v_runnerup_id, v_runnerup_score,
          'Auto-applied by pulse_reconcile_crm_linkage (score >= ' ||
            p_auto_apply_threshold || ', unambiguous)'
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET resolved_at = now(), auto_fixed = true,
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      runner_up_crm_id = EXCLUDED.runner_up_crm_id,
                      runner_up_confidence = EXCLUDED.runner_up_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();

      ELSIF v_top_score >= 0.7 AND v_top_score < p_auto_apply_threshold AND v_is_unambiguous THEN
        -- Stage for review.
        v_proposed := v_proposed + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, proposed_crm_id, proposed_confidence,
          runner_up_crm_id, runner_up_confidence, notes
        )
        VALUES (
          'agency', v_orphan.id, 'flagged_but_unlinked',
          now(), v_top_id, v_top_score,
          v_runnerup_id, v_runnerup_score,
          'Proposed for manual review — confidence ' || v_top_score ||
            ' below auto-apply threshold ' || p_auto_apply_threshold
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET detected_at = now(),
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      runner_up_crm_id = EXCLUDED.runner_up_crm_id,
                      runner_up_confidence = EXCLUDED.runner_up_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();

      ELSIF v_top_score >= p_auto_apply_threshold AND NOT v_is_unambiguous THEN
        -- High score but runner-up too close — staged for human disambiguation.
        v_ambiguous := v_ambiguous + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, proposed_crm_id, proposed_confidence,
          runner_up_crm_id, runner_up_confidence, notes
        )
        VALUES (
          'agency', v_orphan.id, 'flagged_but_unlinked',
          now(), v_top_id, v_top_score,
          v_runnerup_id, v_runnerup_score,
          'Ambiguous — top ' || v_top_score || ', runner-up ' ||
            v_runnerup_score || '; delta <= 0.2'
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET detected_at = now(),
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      runner_up_crm_id = EXCLUDED.runner_up_crm_id,
                      runner_up_confidence = EXCLUDED.runner_up_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();

      ELSE
        -- Nothing crossed the 0.5 floor — no confident match in CRM.
        v_unmatchable := v_unmatchable + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, proposed_crm_id, proposed_confidence, notes
        )
        VALUES (
          'agency', v_orphan.id, 'flagged_but_unlinked',
          now(), v_top_id, v_top_score,
          'Unmatchable — best score ' || v_top_score ||
            ' below floor ' || v_floor
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET detected_at = now(),
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();
      END IF;
    END LOOP;

  ELSE
    -- ── AGENT BRANCH ─────────────────────────────────────────────────────
    FOR v_orphan IN
      SELECT id, full_name, rea_agent_id
      FROM pulse_agents
      WHERE is_in_crm = true AND linked_agent_id IS NULL
    LOOP
      v_scanned := v_scanned + 1;
      v_top_id := NULL;      v_top_score := 0;
      v_runnerup_id := NULL; v_runnerup_score := 0;

      FOR v_cand IN
        SELECT a.id, a.name,
               pulse_linkage_name_score(v_orphan.full_name, a.name) AS score
          FROM agents a
         WHERE a.name IS NOT NULL
         ORDER BY pulse_linkage_name_score(v_orphan.full_name, a.name) DESC
         LIMIT 5
      LOOP
        IF v_cand.score > v_top_score THEN
          v_runnerup_id := v_top_id;
          v_runnerup_score := v_top_score;
          v_top_id := v_cand.id;
          v_top_score := v_cand.score;
        ELSIF v_cand.score > v_runnerup_score THEN
          v_runnerup_id := v_cand.id;
          v_runnerup_score := v_cand.score;
        END IF;
      END LOOP;

      v_is_unambiguous := (
        v_runnerup_score <= 0.7
        OR (v_top_score - v_runnerup_score) > 0.2
      );

      IF v_top_score >= p_auto_apply_threshold AND v_is_unambiguous THEN
        UPDATE pulse_agents
           SET linked_agent_id = v_top_id,
               updated_at = now()
         WHERE id = v_orphan.id;
        v_applied := v_applied + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, resolved_at, auto_fixed,
          proposed_crm_id, proposed_confidence,
          runner_up_crm_id, runner_up_confidence, notes
        )
        VALUES (
          'agent', v_orphan.id, 'flagged_but_unlinked',
          now(), now(), true,
          v_top_id, v_top_score,
          v_runnerup_id, v_runnerup_score,
          'Auto-applied by pulse_reconcile_crm_linkage.'
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET resolved_at = now(), auto_fixed = true,
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      runner_up_crm_id = EXCLUDED.runner_up_crm_id,
                      runner_up_confidence = EXCLUDED.runner_up_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();
      ELSIF v_top_score >= 0.7 AND v_top_score < p_auto_apply_threshold AND v_is_unambiguous THEN
        v_proposed := v_proposed + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, proposed_crm_id, proposed_confidence,
          runner_up_crm_id, runner_up_confidence, notes
        )
        VALUES (
          'agent', v_orphan.id, 'flagged_but_unlinked',
          now(), v_top_id, v_top_score,
          v_runnerup_id, v_runnerup_score,
          'Proposed for manual review.'
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET detected_at = now(),
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      runner_up_crm_id = EXCLUDED.runner_up_crm_id,
                      runner_up_confidence = EXCLUDED.runner_up_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();
      ELSIF v_top_score >= p_auto_apply_threshold AND NOT v_is_unambiguous THEN
        v_ambiguous := v_ambiguous + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, proposed_crm_id, proposed_confidence,
          runner_up_crm_id, runner_up_confidence, notes
        )
        VALUES (
          'agent', v_orphan.id, 'flagged_but_unlinked',
          now(), v_top_id, v_top_score,
          v_runnerup_id, v_runnerup_score,
          'Ambiguous — top and runner-up too close.'
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET detected_at = now(),
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      runner_up_crm_id = EXCLUDED.runner_up_crm_id,
                      runner_up_confidence = EXCLUDED.runner_up_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();
      ELSE
        v_unmatchable := v_unmatchable + 1;
        INSERT INTO pulse_linkage_issues (
          entity_type, entity_id, issue_type,
          detected_at, proposed_crm_id, proposed_confidence, notes
        )
        VALUES (
          'agent', v_orphan.id, 'flagged_but_unlinked',
          now(), v_top_id, v_top_score,
          'Unmatchable — best score below floor.'
        )
        ON CONFLICT (entity_type, entity_id, issue_type) WHERE resolved_at IS NULL
        DO UPDATE SET detected_at = now(),
                      proposed_crm_id = EXCLUDED.proposed_crm_id,
                      proposed_confidence = EXCLUDED.proposed_confidence,
                      notes = EXCLUDED.notes,
                      updated_at = now();
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'entity_type', p_entity_type,
    'scanned', v_scanned,
    'auto_applied', v_applied,
    'proposed_for_review', v_proposed,
    'ambiguous', v_ambiguous,
    'unmatchable', v_unmatchable,
    'auto_apply_threshold', p_auto_apply_threshold,
    'completed_at', now()
  );
END;
$fn$;

COMMENT ON FUNCTION pulse_reconcile_crm_linkage IS
  'Reconciles pulse_agencies / pulse_agents orphan rows (is_in_crm=true but '
  'linked_*_id NULL) against the CRM agencies/agents table using a trigram + '
  'Jaccard + length-normalised edit distance ensemble. Auto-applies above '
  'threshold when unambiguous, stages review in the 0.7–threshold band, '
  'marks ambiguous / unmatchable otherwise.';

GRANT EXECUTE ON FUNCTION pulse_reconcile_crm_linkage(text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION pulse_reconcile_crm_linkage(text, numeric) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. Apply reconciliation to current orphans
-- ══════════════════════════════════════════════════════════════════════════════
-- At migration time: 3 orphan agencies ("Ray White United Group",
-- "LJ Hooker United Group", "Belle Property - Balmain"). All three have
-- exact-match CRM counterparts after hyphen normalization and should
-- auto-link cleanly. Agents already 15/15 linked — the call is defensive
-- (future regressions).
DO $$
DECLARE
  v_agency_result jsonb;
  v_agent_result  jsonb;
BEGIN
  v_agency_result := pulse_reconcile_crm_linkage('agency');
  v_agent_result  := pulse_reconcile_crm_linkage('agent');
  RAISE NOTICE 'Migration 191 reconciliation results: agencies=% agents=%',
    v_agency_result, v_agent_result;
END $$;

COMMIT;
