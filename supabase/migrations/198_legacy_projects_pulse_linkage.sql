-- 198_legacy_projects_pulse_linkage.sql
-- ═════════════════════════════════════════════════════════════════════════
-- Re-layer legacy_projects reconciliation: link to the BROAD pulse layer
-- (pulse_agents / pulse_agencies) instead of the TIGHTLY-CURATED CRM layer
-- (agents / agencies). Rationale:
--
--   Migration 195 linked legacy_projects.linked_contact_id -> agents.id and
--   linked_agency_id -> agencies.id. The CRM has only ~31 contacts / ~24
--   agencies (curated list of active customers). Result: only 740 / 1,043
--   of 3,480 legacy rows got linked (65% unlinked) — not because the engine
--   was wrong, but because most historical agents simply aren't in CRM.
--
--   Correct model: link to pulse_agents (8,810 candidates) / pulse_agencies
--   (2,557 candidates) — ~280x broader. CRM-ness is DERIVED TRANSITIVELY
--   via pulse_agents.linked_agent_id / pulse_agencies.linked_agency_id
--   (already set up in migration 191). When a pulse entity gets CRM-promoted
--   via the Mappings tab, every legacy_project referencing that pulse entity
--   inherits the CRM link automatically — no re-reconciliation needed.
--
--       legacy_projects
--         linked_pulse_agent_id  -> pulse_agents.id    (8,810 candidates)
--         linked_pulse_agency_id -> pulse_agencies.id  (2,557 candidates)
--                                     |
--                                     +- linked_agent_id / linked_agency_id
--                                        (the CRM link, auto-inherited)
--
-- What changes:
--
--   * NEW columns on legacy_projects:
--       linked_pulse_agent_id, linked_pulse_agency_id (FK to pulse layer)
--       pulse_agent_linkage_confidence, pulse_agency_linkage_confidence
--       pulse_agent_linkage_source, pulse_agency_linkage_source
--
--   * OLD columns (linked_contact_id, linked_agency_id, agent_linkage_*,
--     agency_linkage_*) are PRESERVED but cleared for this pass so they
--     don't misrepresent coverage. They'll continue to exist as a cached
--     derived-CRM column that a future migration may remove once downstream
--     consumers fully move to the new view.
--
--   * NEW RPCs: legacy_reconcile_by_property_chain_pulse(),
--     legacy_reconcile_by_fuzzy_name_pulse(numeric),
--     legacy_reconcile_all_pulse(numeric).
--
--   * Old RPCs (legacy_reconcile_by_property_chain, _by_fuzzy_name, _all)
--     are REPLACED as thin shims that call the pulse versions, so any
--     external call site still works. Timeline event_type changes to
--     legacy_project_linked_via_property_pulse / _fuzzy_pulse.
--
--   * NEW VIEW legacy_projects_with_crm: transitively resolves derived CRM
--     link via the pulse chain. Admin UI and retention RPCs read this view
--     instead of the stale cached columns.
--
--   * Market Share / retention RPCs (pulse_get_agent_retention,
--     pulse_get_agency_retention, pulse_get_retention_agent_scope_v2,
--     pulse_get_retention_agency_scope_v2) are rewritten to compute
--     total_legacy_projects_ever via linked_pulse_agent_id /
--     linked_pulse_agency_id rather than stale CRM FKs.
--
--   * Substrate invalidation trigger on legacy_projects is extended to
--     also fire on linked_pulse_* column changes so Agent B's downstream
--     recompute picks up linkage mutations.
--
--   * Cron pulse-legacy-reconcile is re-registered to call
--     legacy_reconcile_all_pulse.
--
--   * Admin review RPCs (stats, review, apply_manual, apply_threshold)
--     rewritten to target pulse layer and include an "in_crm" chip
--     signal per candidate.
--
-- Anti-scope: does not modify pulse_agents / pulse_agencies / pulse_listings
-- schema, does not touch price_matrices / packages / products / projects
-- triggers, does not modify the CRM tables themselves.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1. Schema additions — pulse-layer FKs
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE legacy_projects
  ADD COLUMN IF NOT EXISTS linked_pulse_agent_id            uuid,
  ADD COLUMN IF NOT EXISTS linked_pulse_agency_id           uuid,
  ADD COLUMN IF NOT EXISTS pulse_agent_linkage_confidence   numeric,
  ADD COLUMN IF NOT EXISTS pulse_agency_linkage_confidence  numeric,
  ADD COLUMN IF NOT EXISTS pulse_agent_linkage_source       text,
  ADD COLUMN IF NOT EXISTS pulse_agency_linkage_source      text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'legacy_projects'
      AND constraint_name = 'legacy_projects_linked_pulse_agent_fk'
  ) THEN
    ALTER TABLE legacy_projects
      ADD CONSTRAINT legacy_projects_linked_pulse_agent_fk
      FOREIGN KEY (linked_pulse_agent_id) REFERENCES pulse_agents(id)
      ON DELETE SET NULL NOT VALID;
    ALTER TABLE legacy_projects
      VALIDATE CONSTRAINT legacy_projects_linked_pulse_agent_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'legacy_projects'
      AND constraint_name = 'legacy_projects_linked_pulse_agency_fk'
  ) THEN
    ALTER TABLE legacy_projects
      ADD CONSTRAINT legacy_projects_linked_pulse_agency_fk
      FOREIGN KEY (linked_pulse_agency_id) REFERENCES pulse_agencies(id)
      ON DELETE SET NULL NOT VALID;
    ALTER TABLE legacy_projects
      VALIDATE CONSTRAINT legacy_projects_linked_pulse_agency_fk;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lp_linked_pulse_agent
  ON legacy_projects(linked_pulse_agent_id)
  WHERE linked_pulse_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lp_linked_pulse_agency
  ON legacy_projects(linked_pulse_agency_id)
  WHERE linked_pulse_agency_id IS NOT NULL;

COMMENT ON COLUMN legacy_projects.linked_pulse_agent_id IS
  'FK to pulse_agents(id). The BROAD (8,810 candidate) scrape-layer link. CRM linkage flows through pulse_agents.linked_agent_id transitively via the legacy_projects_with_crm view.';

COMMENT ON COLUMN legacy_projects.linked_pulse_agency_id IS
  'FK to pulse_agencies(id). The BROAD (2,557 candidate) scrape-layer link. CRM linkage flows through pulse_agencies.linked_agency_id transitively.';

COMMENT ON COLUMN legacy_projects.pulse_agent_linkage_source IS
  'How linked_pulse_agent_id was set: property_chain | fuzzy_name | manual.';

-- Trigram GIN indexes on pulse_agents.full_name / pulse_agencies.name so the
-- fuzzy matcher can use the `%` operator + `<->` ordering to prune candidates
-- via index-only LATERAL lookups instead of a full 3k x 8k cartesian scan.
-- Idempotent — no-op if already present.
CREATE INDEX IF NOT EXISTS idx_pulse_agents_full_name_trgm
  ON pulse_agents USING gin (lower(full_name) gin_trgm_ops)
  WHERE full_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_agencies_name_trgm
  ON pulse_agencies USING gin (lower(name) gin_trgm_ops)
  WHERE name IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Clear stale CRM-layer linkage from migration 195 pass
-- ════════════════════════════════════════════════════════════════════════
-- Migration 195 linked against the tiny CRM layer (31 contacts, 24 agencies)
-- and got 740 / 1,043 linked — most of those rows are actually wrong because
-- the true agent/agency isn't in CRM at all. Clear everything that wasn't
-- manually reviewed; keep manually-reviewed links intact (zero rows are
-- manually reviewed today, but the guard future-proofs the migration).

UPDATE legacy_projects
SET
  linked_contact_id         = NULL,
  agent_linkage_confidence  = NULL,
  agent_linkage_source      = NULL,
  linked_agency_id          = NULL,
  agency_linkage_confidence = NULL,
  agency_linkage_source     = NULL,
  updated_at                = now()
WHERE linkage_reviewed_at IS NULL
  AND (linked_contact_id IS NOT NULL OR linked_agency_id IS NOT NULL);

-- ════════════════════════════════════════════════════════════════════════
-- 3. Helpers — reuse legacy_normalize_person_name from migration 195
-- ════════════════════════════════════════════════════════════════════════
-- (function already defined, nothing to do.)

-- ════════════════════════════════════════════════════════════════════════
-- 4. Property-chain reconciliation against pulse layer
-- ════════════════════════════════════════════════════════════════════════
-- For each legacy_project with a property_key, find any pulse_listings at
-- that property_key and pull their agent_pulse_id / agency_pulse_id
-- directly (they are already FKs into pulse_agents / pulse_agencies on the
-- scraped listings — no CRM dependency). Confidence 0.95.
-- Multiple listings may exist at the same property; prefer the most recent.

CREATE OR REPLACE FUNCTION legacy_reconcile_by_property_chain_pulse()
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_linked_agent      int := 0;
  v_linked_agency     int := 0;
  v_scanned           int := 0;
  v_no_property_match int := 0;
BEGIN
  WITH candidates AS (
    SELECT
      lp.id AS legacy_id,
      lp.linked_pulse_agent_id  IS NOT NULL AS had_agent,
      lp.linked_pulse_agency_id IS NOT NULL AS had_agency,
      -- Most recent pulse_listings row at this property with an agent
      (
        SELECT l.agent_pulse_id
        FROM pulse_listings l
        WHERE l.property_key = lp.property_key
          AND l.agent_pulse_id IS NOT NULL
        ORDER BY l.first_seen_at DESC NULLS LAST
        LIMIT 1
      ) AS pulse_agent_id,
      (
        SELECT l.agency_pulse_id
        FROM pulse_listings l
        WHERE l.property_key = lp.property_key
          AND l.agency_pulse_id IS NOT NULL
        ORDER BY l.first_seen_at DESC NULLS LAST
        LIMIT 1
      ) AS pulse_agency_id,
      EXISTS (
        SELECT 1 FROM pulse_listings l WHERE l.property_key = lp.property_key
      ) AS has_any_listing
    FROM legacy_projects lp
    WHERE lp.property_key IS NOT NULL
      AND (lp.linked_pulse_agent_id IS NULL OR lp.linked_pulse_agency_id IS NULL)
  ),
  scan_stats AS (
    SELECT
      count(*)                                               AS total,
      count(*) FILTER (WHERE NOT has_any_listing)            AS no_match,
      count(*) FILTER (WHERE pulse_agent_id  IS NOT NULL
                         AND NOT had_agent)                  AS will_link_agent,
      count(*) FILTER (WHERE pulse_agency_id IS NOT NULL
                         AND NOT had_agency)                 AS will_link_agency
    FROM candidates
  ),
  upd AS (
    UPDATE legacy_projects lp
    SET
      linked_pulse_agent_id           = CASE WHEN lp.linked_pulse_agent_id IS NULL
                                              AND c.pulse_agent_id IS NOT NULL
                                             THEN c.pulse_agent_id
                                             ELSE lp.linked_pulse_agent_id END,
      pulse_agent_linkage_confidence  = CASE WHEN lp.linked_pulse_agent_id IS NULL
                                              AND c.pulse_agent_id IS NOT NULL
                                             THEN 0.95
                                             ELSE lp.pulse_agent_linkage_confidence END,
      pulse_agent_linkage_source      = CASE WHEN lp.linked_pulse_agent_id IS NULL
                                              AND c.pulse_agent_id IS NOT NULL
                                             THEN 'property_chain'
                                             ELSE lp.pulse_agent_linkage_source END,
      linked_pulse_agency_id          = CASE WHEN lp.linked_pulse_agency_id IS NULL
                                              AND c.pulse_agency_id IS NOT NULL
                                             THEN c.pulse_agency_id
                                             ELSE lp.linked_pulse_agency_id END,
      pulse_agency_linkage_confidence = CASE WHEN lp.linked_pulse_agency_id IS NULL
                                              AND c.pulse_agency_id IS NOT NULL
                                             THEN 0.95
                                             ELSE lp.pulse_agency_linkage_confidence END,
      pulse_agency_linkage_source     = CASE WHEN lp.linked_pulse_agency_id IS NULL
                                              AND c.pulse_agency_id IS NOT NULL
                                             THEN 'property_chain'
                                             ELSE lp.pulse_agency_linkage_source END,
      updated_at                      = now()
    FROM candidates c
    WHERE lp.id = c.legacy_id
      AND (
        (lp.linked_pulse_agent_id  IS NULL AND c.pulse_agent_id  IS NOT NULL) OR
        (lp.linked_pulse_agency_id IS NULL AND c.pulse_agency_id IS NOT NULL)
      )
    RETURNING lp.id, lp.linked_pulse_agent_id, lp.linked_pulse_agency_id,
              lp.property_key, lp.raw_address
  ),
  tl AS (
    INSERT INTO pulse_timeline (
      entity_type, event_type, event_category,
      title, description, new_value, source, idempotency_key, created_at
    )
    SELECT
      'legacy_project',
      'legacy_project_linked_via_property_pulse',
      'system',
      'Legacy project linked via property chain (pulse layer)',
      'Legacy project at ' || COALESCE(upd.raw_address, upd.property_key, '(unknown)')
        || ' attributed to pulse_agent/pulse_agency via matching pulse_listings row.',
      jsonb_build_object(
        'legacy_project_id',       upd.id,
        'linked_pulse_agent_id',   upd.linked_pulse_agent_id,
        'linked_pulse_agency_id',  upd.linked_pulse_agency_id,
        'property_key',            upd.property_key,
        'confidence',              0.95,
        'method',                  'property_chain_pulse'
      ),
      'legacy_reconcile_by_property_chain_pulse',
      'legacy_project_linked_via_property_pulse:' || upd.id::text,
      now()
    FROM upd
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT total FROM scan_stats),
    (SELECT will_link_agent FROM scan_stats),
    (SELECT will_link_agency FROM scan_stats),
    (SELECT no_match FROM scan_stats)
  INTO v_scanned, v_linked_agent, v_linked_agency, v_no_property_match;

  RETURN jsonb_build_object(
    'method',            'property_chain_pulse',
    'scanned',           v_scanned,
    'linked_agent',      v_linked_agent,
    'linked_agency',     v_linked_agency,
    'no_property_match', v_no_property_match,
    'ran_at',            now()
  );
END;
$fn$;

COMMENT ON FUNCTION legacy_reconcile_by_property_chain_pulse IS
  'Highest-confidence legacy -> pulse layer linkage via property_key chain through pulse_listings. Idempotent. Confidence=0.95 on match. Migration 198.';

-- ════════════════════════════════════════════════════════════════════════
-- 5. Fuzzy-name reconciliation against pulse layer
-- ════════════════════════════════════════════════════════════════════════
-- Match legacy_project.agent_name against pulse_agents.full_name and
-- legacy_project.agency_name against pulse_agencies.name via pg_trgm
-- similarity. Apply a next-candidate gap requirement (>= 0.15 edge) so we
-- only auto-link when the top candidate clearly beats #2. Email boost of
-- +0.15 for agents when legacy_project.client_email matches
-- pulse_agents.email (rare, but strong signal).

CREATE OR REPLACE FUNCTION legacy_reconcile_by_fuzzy_name_pulse(
  p_auto_threshold numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_scanned_agent   int := 0;
  v_linked_agent    int := 0;
  v_scanned_agency  int := 0;
  v_linked_agency   int := 0;
  v_queued_review   int := 0;
BEGIN
  -- Strategy: use the % trigram operator to prune candidates via the GIN
  -- index on lower(full_name) / lower(name), LATERAL-LIMIT to top-5 per
  -- legacy row, then score/rank in a tiny set. This avoids a 3k x 8k
  -- cartesian scan and keeps the query inside statement_timeout.

  -- ── AGENT fuzzy against pulse_agents.full_name ─────────────────────────
  WITH
  candidates AS (
    SELECT lp.id AS legacy_id,
           lower(coalesce(lp.agent_name,'')) AS raw_lower,
           legacy_normalize_person_name(lp.agent_name) AS norm_name,
           lp.client_email,
           lp.agent_name
    FROM legacy_projects lp
    WHERE lp.linked_pulse_agent_id IS NULL
      AND lp.agent_name IS NOT NULL
      AND length(trim(lp.agent_name)) >= 3
  ),
  top_candidates AS (
    SELECT
      c.legacy_id,
      c.norm_name,
      c.client_email,
      c.agent_name,
      top.id          AS candidate_id,
      top.full_name   AS candidate_name,
      top.email       AS candidate_email,
      top.sim_score,
      ROW_NUMBER() OVER (PARTITION BY c.legacy_id ORDER BY top.sim_score DESC) AS rn
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT pa.id, pa.full_name, pa.email,
             similarity(legacy_normalize_person_name(pa.full_name), c.norm_name) AS sim_score
      FROM pulse_agents pa
      WHERE pa.full_name IS NOT NULL
        AND lower(pa.full_name) % c.raw_lower
      ORDER BY lower(pa.full_name) <-> c.raw_lower
      LIMIT 5
    ) top
  ),
  top_two AS (
    SELECT
      tc.legacy_id,
      max(CASE WHEN rn = 1 THEN tc.sim_score + CASE
                 WHEN tc.client_email IS NOT NULL AND tc.candidate_email IS NOT NULL
                      AND lower(trim(tc.client_email)) = lower(trim(tc.candidate_email))
                 THEN 0.15 ELSE 0 END
           END) AS top_score,
      max(CASE WHEN rn = 2 THEN tc.sim_score + CASE
                 WHEN tc.client_email IS NOT NULL AND tc.candidate_email IS NOT NULL
                      AND lower(trim(tc.client_email)) = lower(trim(tc.candidate_email))
                 THEN 0.15 ELSE 0 END
           END) AS runner_score
    FROM top_candidates tc
    WHERE rn <= 2
    GROUP BY tc.legacy_id
  ),
  winners AS (
    SELECT tc.legacy_id, tc.candidate_id, tc.candidate_name,
           LEAST(1.0, tc.sim_score + CASE
                 WHEN tc.client_email IS NOT NULL AND tc.candidate_email IS NOT NULL
                      AND lower(trim(tc.client_email)) = lower(trim(tc.candidate_email))
                 THEN 0.15 ELSE 0 END) AS score,
           tt.runner_score,
           tc.agent_name
    FROM top_candidates tc
    JOIN top_two tt ON tt.legacy_id = tc.legacy_id
    WHERE tc.rn = 1
  ),
  upd AS (
    UPDATE legacy_projects lp
    SET
      linked_pulse_agent_id          = w.candidate_id,
      pulse_agent_linkage_confidence = round(w.score::numeric, 3),
      pulse_agent_linkage_source     = 'fuzzy_name',
      updated_at                     = now()
    FROM winners w
    WHERE lp.id = w.legacy_id
      AND lp.linked_pulse_agent_id IS NULL
      AND w.score >= p_auto_threshold
      AND (w.runner_score IS NULL OR (w.score - w.runner_score) >= 0.15)
    RETURNING lp.id, lp.linked_pulse_agent_id, lp.pulse_agent_linkage_confidence,
              lp.raw_address, lp.agent_name
  ),
  tl AS (
    INSERT INTO pulse_timeline (
      entity_type, event_type, event_category,
      title, description, new_value, source, idempotency_key, created_at
    )
    SELECT
      'legacy_project',
      'legacy_project_linked_via_fuzzy_pulse',
      'system',
      'Legacy project auto-linked to pulse_agent via fuzzy name',
      'Raw agent name "' || COALESCE(upd.agent_name,'')
        || '" matched to pulse_agent id=' || upd.linked_pulse_agent_id::text
        || ' (confidence ' || upd.pulse_agent_linkage_confidence::text || ').',
      jsonb_build_object(
        'legacy_project_id',     upd.id,
        'linked_pulse_agent_id', upd.linked_pulse_agent_id,
        'raw_name',              upd.agent_name,
        'confidence',            upd.pulse_agent_linkage_confidence,
        'method',                'fuzzy_name_pulse'
      ),
      'legacy_reconcile_by_fuzzy_name_pulse',
      'legacy_project_linked_via_fuzzy_pulse:' || upd.id::text || ':agent',
      now()
    FROM upd
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM upd)
  INTO v_scanned_agent, v_linked_agent;

  -- ── AGENCY fuzzy against pulse_agencies.name ───────────────────────────
  WITH
  candidates AS (
    SELECT lp.id AS legacy_id,
           lower(coalesce(lp.agency_name,'')) AS raw_lower,
           legacy_normalize_person_name(lp.agency_name) AS norm_name,
           lp.agency_name
    FROM legacy_projects lp
    WHERE lp.linked_pulse_agency_id IS NULL
      AND lp.agency_name IS NOT NULL
      AND length(trim(lp.agency_name)) >= 3
  ),
  top_candidates AS (
    SELECT
      c.legacy_id,
      c.agency_name,
      top.id          AS candidate_id,
      top.name        AS candidate_name,
      top.sim_score,
      ROW_NUMBER() OVER (PARTITION BY c.legacy_id ORDER BY top.sim_score DESC) AS rn
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT pag.id, pag.name,
             similarity(legacy_normalize_person_name(pag.name), c.norm_name) AS sim_score
      FROM pulse_agencies pag
      WHERE pag.name IS NOT NULL
        AND lower(pag.name) % c.raw_lower
      ORDER BY lower(pag.name) <-> c.raw_lower
      LIMIT 5
    ) top
  ),
  top_two AS (
    SELECT legacy_id,
           max(sim_score) FILTER (WHERE rn = 1) AS top_score,
           max(sim_score) FILTER (WHERE rn = 2) AS runner_score
    FROM top_candidates
    WHERE rn <= 2
    GROUP BY legacy_id
  ),
  winners AS (
    SELECT tc.legacy_id, tc.candidate_id, tc.candidate_name,
           tc.sim_score AS score, tt.runner_score, tc.agency_name
    FROM top_candidates tc
    JOIN top_two tt ON tt.legacy_id = tc.legacy_id
    WHERE tc.rn = 1
  ),
  upd AS (
    UPDATE legacy_projects lp
    SET
      linked_pulse_agency_id          = w.candidate_id,
      pulse_agency_linkage_confidence = round(w.score::numeric, 3),
      pulse_agency_linkage_source     = 'fuzzy_name',
      updated_at                      = now()
    FROM winners w
    WHERE lp.id = w.legacy_id
      AND lp.linked_pulse_agency_id IS NULL
      AND w.score >= p_auto_threshold
      AND (w.runner_score IS NULL OR (w.score - w.runner_score) >= 0.15)
    RETURNING lp.id, lp.linked_pulse_agency_id, lp.pulse_agency_linkage_confidence,
              lp.agency_name
  ),
  tl AS (
    INSERT INTO pulse_timeline (
      entity_type, event_type, event_category,
      title, description, new_value, source, idempotency_key, created_at
    )
    SELECT
      'legacy_project',
      'legacy_project_linked_via_fuzzy_pulse',
      'system',
      'Legacy project agency auto-linked to pulse_agency via fuzzy name',
      'Raw agency name "' || COALESCE(upd.agency_name,'')
        || '" matched to pulse_agency id=' || upd.linked_pulse_agency_id::text
        || ' (confidence ' || upd.pulse_agency_linkage_confidence::text || ').',
      jsonb_build_object(
        'legacy_project_id',      upd.id,
        'linked_pulse_agency_id', upd.linked_pulse_agency_id,
        'raw_name',               upd.agency_name,
        'confidence',             upd.pulse_agency_linkage_confidence,
        'method',                 'fuzzy_name_pulse'
      ),
      'legacy_reconcile_by_fuzzy_name_pulse',
      'legacy_project_linked_via_fuzzy_pulse:' || upd.id::text || ':agency',
      now()
    FROM upd
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM upd)
  INTO v_scanned_agency, v_linked_agency;

  -- Rows still unlinked that have a raw name land in the review queue
  SELECT count(*)
  INTO v_queued_review
  FROM legacy_projects lp
  WHERE (lp.linked_pulse_agent_id  IS NULL AND lp.agent_name  IS NOT NULL)
     OR (lp.linked_pulse_agency_id IS NULL AND lp.agency_name IS NOT NULL);

  RETURN jsonb_build_object(
    'method',         'fuzzy_name_pulse',
    'auto_threshold', p_auto_threshold,
    'scanned_agent',  v_scanned_agent,
    'scanned_agency', v_scanned_agency,
    'linked_agent',   v_linked_agent,
    'linked_agency',  v_linked_agency,
    'queued_review',  v_queued_review,
    'ran_at',         now()
  );
END;
$fn$;

COMMENT ON FUNCTION legacy_reconcile_by_fuzzy_name_pulse IS
  'Fallback legacy -> pulse layer linkage via pg_trgm similarity on names + email signal + runner-up gap requirement. Threshold default 0.85. Migration 198.';

-- ════════════════════════════════════════════════════════════════════════
-- 6. Combined wrapper
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION legacy_reconcile_all_pulse(
  p_auto_threshold numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_prop jsonb;
  v_fuzz jsonb;
BEGIN
  v_prop := legacy_reconcile_by_property_chain_pulse();
  v_fuzz := legacy_reconcile_by_fuzzy_name_pulse(p_auto_threshold);

  RETURN jsonb_build_object(
    'property_chain_pulse', v_prop,
    'fuzzy_name_pulse',     v_fuzz,
    'combined', jsonb_build_object(
      'linked_agent_total',  COALESCE((v_prop->>'linked_agent')::int, 0)
                           + COALESCE((v_fuzz->>'linked_agent')::int, 0),
      'linked_agency_total', COALESCE((v_prop->>'linked_agency')::int, 0)
                           + COALESCE((v_fuzz->>'linked_agency')::int, 0)
    ),
    'ran_at', now()
  );
END;
$fn$;

COMMENT ON FUNCTION legacy_reconcile_all_pulse IS
  'Runs property_chain_pulse then fuzzy_name_pulse. Idempotent. Wired to nightly cron pulse-legacy-reconcile (re-registered in migration 198).';

-- ════════════════════════════════════════════════════════════════════════
-- 7. Back-compat shims — the old RPC names now delegate to the new impls
-- ════════════════════════════════════════════════════════════════════════
-- Any external caller (UI, edge function, cron) that still references the
-- old names keeps working without changes. The new return payload has a
-- superset of fields. We preserve the legacy_reconcile_all wrapper shape
-- (property_chain / fuzzy_name / combined) so UI toast code does not break.

CREATE OR REPLACE FUNCTION legacy_reconcile_by_property_chain()
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT legacy_reconcile_by_property_chain_pulse();
$$;

CREATE OR REPLACE FUNCTION legacy_reconcile_by_fuzzy_name(
  p_auto_threshold numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT legacy_reconcile_by_fuzzy_name_pulse(p_auto_threshold);
$$;

CREATE OR REPLACE FUNCTION legacy_reconcile_all(
  p_auto_threshold numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_all jsonb;
BEGIN
  v_all := legacy_reconcile_all_pulse(p_auto_threshold);
  -- Remap to the field names the pre-198 UI expects.
  RETURN jsonb_build_object(
    'property_chain', v_all->'property_chain_pulse',
    'fuzzy_name',     v_all->'fuzzy_name_pulse',
    'combined',       v_all->'combined',
    'ran_at',         v_all->'ran_at'
  );
END;
$fn$;

-- ════════════════════════════════════════════════════════════════════════
-- 8. Derived-CRM view
-- ════════════════════════════════════════════════════════════════════════
-- Transitively resolves: legacy_project -> linked_pulse_agent -> CRM agent
-- so downstream consumers don't need to re-reconcile when a pulse entity
-- gets CRM-promoted via the Mappings tab.

CREATE OR REPLACE VIEW legacy_projects_with_crm AS
SELECT
  lp.*,
  pa.linked_agent_id                   AS derived_crm_contact_id,
  pag.linked_agency_id                 AS derived_crm_agency_id,
  COALESCE(pa.is_in_crm,  false)       AS agent_in_crm,
  COALESCE(pag.is_in_crm, false)       AS agency_in_crm,
  pa.full_name                         AS derived_pulse_agent_name,
  pag.name                             AS derived_pulse_agency_name
FROM legacy_projects lp
LEFT JOIN pulse_agents   pa  ON pa.id  = lp.linked_pulse_agent_id
LEFT JOIN pulse_agencies pag ON pag.id = lp.linked_pulse_agency_id;

COMMENT ON VIEW legacy_projects_with_crm IS
  'Transitive CRM resolution: legacy_projects -> linked_pulse_agent -> CRM. Read derived_crm_contact_id / derived_crm_agency_id to get the freshest CRM link. Migration 198.';

-- ════════════════════════════════════════════════════════════════════════
-- 9. Admin review RPCs — rewrite against pulse layer
-- ════════════════════════════════════════════════════════════════════════

-- 9a. Stat strip
CREATE OR REPLACE FUNCTION legacy_reconciliation_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH lp AS (
    SELECT
      linked_pulse_agent_id  IS NOT NULL AS has_agent,
      linked_pulse_agency_id IS NOT NULL AS has_agency,
      pulse_agent_linkage_source,
      pulse_agency_linkage_source,
      pulse_agent_linkage_confidence,
      pulse_agency_linkage_confidence
    FROM legacy_projects
  )
  SELECT jsonb_build_object(
    'total',        count(*),
    'fully_linked', count(*) FILTER (WHERE has_agent AND has_agency),
    'agent_only',   count(*) FILTER (WHERE has_agent AND NOT has_agency),
    'agency_only',  count(*) FILTER (WHERE has_agency AND NOT has_agent),
    'unlinked',     count(*) FILTER (WHERE NOT has_agent AND NOT has_agency),
    'by_source', jsonb_build_object(
      'property_chain', count(*) FILTER (
        WHERE pulse_agent_linkage_source  = 'property_chain'
           OR pulse_agency_linkage_source = 'property_chain'),
      'fuzzy_name',     count(*) FILTER (
        WHERE pulse_agent_linkage_source  = 'fuzzy_name'
           OR pulse_agency_linkage_source = 'fuzzy_name'),
      'manual',         count(*) FILTER (
        WHERE pulse_agent_linkage_source  = 'manual'
           OR pulse_agency_linkage_source = 'manual')
    ),
    'confidence_bands', jsonb_build_object(
      'high',   count(*) FILTER (
        WHERE (pulse_agent_linkage_confidence  >= 0.85)
           OR (pulse_agency_linkage_confidence >= 0.85)),
      'medium', count(*) FILTER (
        WHERE (pulse_agent_linkage_confidence  >= 0.6
           AND pulse_agent_linkage_confidence  < 0.85)
           OR (pulse_agency_linkage_confidence >= 0.6
           AND pulse_agency_linkage_confidence < 0.85)),
      'low',    count(*) FILTER (
        WHERE (pulse_agent_linkage_confidence  < 0.6
           AND pulse_agent_linkage_confidence  IS NOT NULL)
           OR (pulse_agency_linkage_confidence < 0.6
           AND pulse_agency_linkage_confidence IS NOT NULL))
    )
  )
  FROM lp;
$$;

-- 9b. Review queue — returns unlinked rows with top-3 pulse-layer suggestions
DROP FUNCTION IF EXISTS legacy_reconciliation_review(text, text, int, int);
CREATE OR REPLACE FUNCTION legacy_reconciliation_review(
  p_filter  text DEFAULT 'unlinked',
  p_search  text DEFAULT NULL,
  p_limit   int  DEFAULT 50,
  p_offset  int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH filtered AS (
    SELECT lp.*
    FROM legacy_projects lp
    WHERE
      CASE p_filter
        WHEN 'unlinked'    THEN lp.linked_pulse_agent_id IS NULL
                              AND lp.linked_pulse_agency_id IS NULL
        WHEN 'agent_only'  THEN lp.linked_pulse_agent_id IS NOT NULL
                              AND lp.linked_pulse_agency_id IS NULL
        WHEN 'agency_only' THEN lp.linked_pulse_agency_id IS NOT NULL
                              AND lp.linked_pulse_agent_id IS NULL
        WHEN 'linked'      THEN lp.linked_pulse_agent_id IS NOT NULL
                              AND lp.linked_pulse_agency_id IS NOT NULL
        ELSE TRUE
      END
      AND (p_search IS NULL
           OR lp.agent_name   ILIKE '%' || p_search || '%'
           OR lp.agency_name  ILIKE '%' || p_search || '%'
           OR lp.raw_address  ILIKE '%' || p_search || '%'
           OR lp.client_email ILIKE '%' || p_search || '%')
    ORDER BY lp.completed_date DESC NULLS LAST, lp.imported_at DESC
    LIMIT p_limit OFFSET p_offset
  ),
  enriched AS (
    SELECT f.*,
      -- Top 3 pulse_agent candidates
      COALESCE((
        SELECT jsonb_agg(sub ORDER BY sub->>'score' DESC)
        FROM (
          SELECT jsonb_build_object(
                   'id',         pa.id,
                   'name',       pa.full_name,
                   'email',      pa.email,
                   'is_in_crm',  COALESCE(pa.is_in_crm, false),
                   'crm_agent_id', pa.linked_agent_id,
                   'score', round(similarity(
                              legacy_normalize_person_name(f.agent_name),
                              legacy_normalize_person_name(pa.full_name))::numeric, 3)
                 ) AS sub
          FROM pulse_agents pa
          WHERE pa.full_name IS NOT NULL
            AND legacy_normalize_person_name(f.agent_name) IS NOT NULL
            AND similarity(
                  legacy_normalize_person_name(f.agent_name),
                  legacy_normalize_person_name(pa.full_name)) > 0.25
          ORDER BY similarity(
            legacy_normalize_person_name(f.agent_name),
            legacy_normalize_person_name(pa.full_name)) DESC
          LIMIT 3
        ) sx
      ), '[]'::jsonb) AS candidate_agents,
      -- Top 3 pulse_agency candidates
      COALESCE((
        SELECT jsonb_agg(sub ORDER BY sub->>'score' DESC)
        FROM (
          SELECT jsonb_build_object(
                   'id',           pag.id,
                   'name',         pag.name,
                   'is_in_crm',    COALESCE(pag.is_in_crm, false),
                   'crm_agency_id', pag.linked_agency_id,
                   'score', round(similarity(
                              legacy_normalize_person_name(f.agency_name),
                              legacy_normalize_person_name(pag.name))::numeric, 3)
                 ) AS sub
          FROM pulse_agencies pag
          WHERE pag.name IS NOT NULL
            AND legacy_normalize_person_name(f.agency_name) IS NOT NULL
            AND similarity(
                  legacy_normalize_person_name(f.agency_name),
                  legacy_normalize_person_name(pag.name)) > 0.25
          ORDER BY similarity(
            legacy_normalize_person_name(f.agency_name),
            legacy_normalize_person_name(pag.name)) DESC
          LIMIT 3
        ) sx
      ), '[]'::jsonb) AS candidate_agencies,
      -- Resolved current linkage (derived CRM via pulse chain)
      (SELECT full_name FROM pulse_agents WHERE id = f.linked_pulse_agent_id) AS linked_pulse_agent_name,
      (SELECT name      FROM pulse_agencies WHERE id = f.linked_pulse_agency_id) AS linked_pulse_agency_name,
      (SELECT linked_agent_id  FROM pulse_agents   WHERE id = f.linked_pulse_agent_id)  AS derived_crm_contact_id,
      (SELECT linked_agency_id FROM pulse_agencies WHERE id = f.linked_pulse_agency_id) AS derived_crm_agency_id,
      (SELECT is_in_crm FROM pulse_agents   WHERE id = f.linked_pulse_agent_id)  AS agent_in_crm,
      (SELECT is_in_crm FROM pulse_agencies WHERE id = f.linked_pulse_agency_id) AS agency_in_crm
    FROM filtered f
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',                                e.id,
      'raw_address',                       e.raw_address,
      'agent_name',                        e.agent_name,
      'agency_name',                       e.agency_name,
      'client_name',                       e.client_name,
      'client_email',                      e.client_email,
      'completed_date',                    e.completed_date,
      'property_key',                      e.property_key,
      'linked_pulse_agent_id',             e.linked_pulse_agent_id,
      'linked_pulse_agent_name',           e.linked_pulse_agent_name,
      'linked_pulse_agency_id',            e.linked_pulse_agency_id,
      'linked_pulse_agency_name',          e.linked_pulse_agency_name,
      'pulse_agent_linkage_confidence',    e.pulse_agent_linkage_confidence,
      'pulse_agency_linkage_confidence',   e.pulse_agency_linkage_confidence,
      'pulse_agent_linkage_source',        e.pulse_agent_linkage_source,
      'pulse_agency_linkage_source',       e.pulse_agency_linkage_source,
      'derived_crm_contact_id',            e.derived_crm_contact_id,
      'derived_crm_agency_id',             e.derived_crm_agency_id,
      'agent_in_crm',                      e.agent_in_crm,
      'agency_in_crm',                     e.agency_in_crm,
      'candidate_agents',                  e.candidate_agents,
      'candidate_agencies',                e.candidate_agencies
    )) FROM enriched e), '[]'::jsonb),
    'limit',  p_limit,
    'offset', p_offset,
    'filter', p_filter
  );
$$;

-- 9c. Manual apply — now targets pulse layer
CREATE OR REPLACE FUNCTION legacy_reconciliation_apply_manual(
  p_legacy_id  uuid,
  p_contact_id uuid DEFAULT NULL,   -- re-purposed: pulse_agent_id
  p_agency_id  uuid DEFAULT NULL,   -- re-purposed: pulse_agency_id
  p_reviewer   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row legacy_projects%ROWTYPE;
BEGIN
  UPDATE legacy_projects
  SET
    linked_pulse_agent_id           = COALESCE(p_contact_id, linked_pulse_agent_id),
    pulse_agent_linkage_source      = CASE WHEN p_contact_id IS NOT NULL THEN 'manual'
                                            ELSE pulse_agent_linkage_source END,
    pulse_agent_linkage_confidence  = CASE WHEN p_contact_id IS NOT NULL THEN 1.0
                                            ELSE pulse_agent_linkage_confidence END,
    linked_pulse_agency_id          = COALESCE(p_agency_id, linked_pulse_agency_id),
    pulse_agency_linkage_source     = CASE WHEN p_agency_id IS NOT NULL THEN 'manual'
                                            ELSE pulse_agency_linkage_source END,
    pulse_agency_linkage_confidence = CASE WHEN p_agency_id IS NOT NULL THEN 1.0
                                            ELSE pulse_agency_linkage_confidence END,
    linkage_reviewed_at             = now(),
    linkage_reviewed_by             = p_reviewer,
    updated_at                      = now()
  WHERE id = p_legacy_id
  RETURNING * INTO v_row;

  INSERT INTO pulse_timeline (
    entity_type, event_type, event_category,
    title, description, new_value, source, idempotency_key, created_at
  ) VALUES (
    'legacy_project',
    'legacy_project_linked_manual_pulse',
    'system',
    'Legacy project linked manually (pulse layer)',
    'Reviewer applied manual pulse-layer linkage for legacy_project '
      || p_legacy_id::text || '.',
    jsonb_build_object(
      'legacy_project_id',      p_legacy_id,
      'linked_pulse_agent_id',  v_row.linked_pulse_agent_id,
      'linked_pulse_agency_id', v_row.linked_pulse_agency_id,
      'reviewer',               p_reviewer
    ),
    'legacy_reconciliation_apply_manual',
    'legacy_project_linked_manual_pulse:' || p_legacy_id::text
      || ':' || extract(epoch FROM now())::text,
    now()
  );

  RETURN jsonb_build_object(
    'ok',                     true,
    'id',                     v_row.id,
    'linked_pulse_agent_id',  v_row.linked_pulse_agent_id,
    'linked_pulse_agency_id', v_row.linked_pulse_agency_id
  );
END;
$fn$;

-- 9d. Bulk threshold apply
CREATE OR REPLACE FUNCTION legacy_reconciliation_apply_threshold(
  p_min_confidence numeric DEFAULT 0.85,
  p_reviewer       uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE v_marked int;
BEGIN
  UPDATE legacy_projects
  SET linkage_reviewed_at = now(),
      linkage_reviewed_by = p_reviewer,
      updated_at          = now()
  WHERE (
    (linked_pulse_agent_id  IS NOT NULL AND pulse_agent_linkage_confidence  >= p_min_confidence) OR
    (linked_pulse_agency_id IS NOT NULL AND pulse_agency_linkage_confidence >= p_min_confidence)
  )
    AND linkage_reviewed_at IS NULL;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RETURN jsonb_build_object('marked_reviewed', v_marked, 'threshold', p_min_confidence);
END;
$fn$;

-- ════════════════════════════════════════════════════════════════════════
-- 10. Substrate invalidation — extend trigger to pulse-layer columns
-- ════════════════════════════════════════════════════════════════════════
-- Recreate the function so it also wakes up when linked_pulse_* change. The
-- guard still short-circuits on cosmetic UPDATEs that leave all four
-- linkage columns untouched.

CREATE OR REPLACE FUNCTION legacy_projects_invalidate_substrate()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.linked_contact_id       IS NOT DISTINCT FROM OLD.linked_contact_id
     AND NEW.linked_agency_id        IS NOT DISTINCT FROM OLD.linked_agency_id
     AND NEW.linked_pulse_agent_id   IS NOT DISTINCT FROM OLD.linked_pulse_agent_id
     AND NEW.linked_pulse_agency_id  IS NOT DISTINCT FROM OLD.linked_pulse_agency_id THEN
    RETURN NEW;
  END IF;

  IF NEW.property_key IS NOT NULL THEN
    UPDATE pulse_listing_missed_opportunity
    SET updated_at = now()
    WHERE property_key = NEW.property_key;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_legacy_projects_invalidate_substrate ON legacy_projects;
CREATE TRIGGER trg_legacy_projects_invalidate_substrate
  AFTER INSERT OR UPDATE OF
    linked_contact_id,
    linked_agency_id,
    linked_pulse_agent_id,
    linked_pulse_agency_id
  ON legacy_projects
  FOR EACH ROW EXECUTE FUNCTION legacy_projects_invalidate_substrate();

-- ════════════════════════════════════════════════════════════════════════
-- 11. Retention RPCs — rewrite against pulse layer
-- ════════════════════════════════════════════════════════════════════════
-- total_legacy_projects_ever now counts legacy_projects linked via
-- linked_pulse_agent_id / linked_pulse_agency_id. The CRM-in-scope filter
-- stays on pulse_agents.is_in_crm / pulse_agencies.is_in_crm as before,
-- but the denominator (legacy portfolio) is accurate because we count
-- ALL legacy rows attributed to the pulse entity regardless of CRM state.

-- 11a. pulse_get_agent_retention
CREATE OR REPLACE FUNCTION pulse_get_agent_retention(
  p_agent_rea_id text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agent_ctx AS (
    SELECT pa.id              AS agent_pulse_id,
           pa.linked_agent_id AS crm_agent_id
    FROM pulse_agents pa
    WHERE pa.rea_agent_id = p_agent_rea_id
    LIMIT 1
  ),
  agent_listings AS (
    SELECT q.*,
      l.agent_name, l.agent_rea_id, l.agent_pulse_id, l.agency_pulse_id,
      l.address, l.source_url, l.agency_name, l.detail_enriched_at,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp WHERE lp.property_key = q.property_key
      ) AS cap_legacy
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agent_rea_id = p_agent_rea_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  agent_listings_enriched AS (
    SELECT al.*,
           (cap_active OR cap_legacy) AS is_captured,
           CASE
             WHEN cap_active AND cap_legacy THEN 'both'
             WHEN cap_active THEN 'active'
             WHEN cap_legacy THEN 'legacy'
             ELSE NULL
           END AS captured_by
    FROM agent_listings al
  ),
  legacy_ever AS (
    -- FULL legacy portfolio for this pulse_agent (regardless of CRM state).
    SELECT count(*) AS n, max(completed_date) AS last_completed
    FROM legacy_projects lp
    WHERE lp.linked_pulse_agent_id = (SELECT agent_pulse_id FROM agent_ctx)
      AND (SELECT agent_pulse_id FROM agent_ctx) IS NOT NULL
  )
  SELECT jsonb_build_object(
    'agent_rea_id',      p_agent_rea_id,
    'agent_pulse_id',    (SELECT agent_pulse_id FROM agent_ctx),
    'crm_agent_id',      (SELECT crm_agent_id FROM agent_ctx),
    'agency_pulse_id',   (SELECT max(agency_pulse_id::text)::uuid FROM agent_listings_enriched),
    'window_from',       p_from,
    'window_to',         p_to,
    'total_listings',    (SELECT count(*) FROM agent_listings_enriched),
    'captured',          (SELECT count(*) FROM agent_listings_enriched WHERE is_captured),
    'captured_active',   (SELECT count(*) FROM agent_listings_enriched WHERE cap_active),
    'captured_legacy',   (SELECT count(*) FROM agent_listings_enriched WHERE cap_legacy),
    'missed',            (SELECT count(*) FROM agent_listings_enriched WHERE NOT is_captured),
    'retention_rate_pct', CASE
      WHEN (SELECT count(*) FROM agent_listings_enriched) = 0 THEN 0
      ELSE round(100.0 * (SELECT count(*) FROM agent_listings_enriched WHERE is_captured)
               / (SELECT count(*) FROM agent_listings_enriched), 2)
    END,
    'missed_opportunity_value',
       COALESCE((SELECT sum(quoted_price) FROM agent_listings_enriched
                 WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0),
    'total_legacy_projects_ever', COALESCE((SELECT n FROM legacy_ever), 0),
    'last_legacy_completed_date', (SELECT last_completed FROM legacy_ever),
    'missed_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',         listing_id,
        'address',            address,
        'suburb',             suburb,
        'first_seen_at',      first_seen_at,
        'package',            classified_package_name,
        'tier',               resolved_tier,
        'quoted_price',       quoted_price,
        'source_url',         source_url,
        'quote_status',       quote_status,
        'agent_pulse_id',     agent_pulse_id,
        'agency_pulse_id',    agency_pulse_id,
        'detail_enriched_at', detail_enriched_at,
        'captured_by',        captured_by
      ) ORDER BY quoted_price DESC NULLS LAST)
      FROM agent_listings_enriched WHERE NOT is_captured
    ), '[]'::jsonb),
    'captured_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',         listing_id,
        'address',            address,
        'suburb',             suburb,
        'first_seen_at',      first_seen_at,
        'package',            classified_package_name,
        'agent_pulse_id',     agent_pulse_id,
        'agency_pulse_id',    agency_pulse_id,
        'detail_enriched_at', detail_enriched_at,
        'captured_by',        captured_by
      ) ORDER BY first_seen_at DESC)
      FROM agent_listings_enriched WHERE is_captured
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION pulse_get_agent_retention IS
  'Per-agent retention + market-share rollup. total_legacy_projects_ever derived from legacy_projects.linked_pulse_agent_id (pulse layer) — migration 198.';

-- 11b. pulse_get_agency_retention
CREATE OR REPLACE FUNCTION pulse_get_agency_retention(
  p_agency_pulse_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agency_ctx AS (
    SELECT id AS agency_pulse_id, linked_agency_id AS crm_agency_id
    FROM pulse_agencies
    WHERE id = p_agency_pulse_id
  ),
  agency_listings AS (
    SELECT
      q.*,
      l.agent_name, l.agent_rea_id, l.agent_pulse_id,
      l.address, l.source_url, l.agency_name, l.agency_pulse_id,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agency_pulse_id = p_agency_pulse_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE is_captured) AS captured,
      count(*) FILTER (WHERE NOT is_captured) AS missed,
      COALESCE(sum(quoted_price) FILTER (
        WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured), 0) AS missed_value_incl_pending
    FROM agency_listings
  ),
  by_package AS (
    SELECT classified_package_name AS package, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings WHERE NOT is_captured
    GROUP BY classified_package_name
  ),
  by_tier AS (
    SELECT resolved_tier AS tier, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings WHERE NOT is_captured
    GROUP BY resolved_tier
  ),
  agents_rollup AS (
    SELECT
      al.agent_rea_id,
      al.agent_pulse_id,
      max(al.agent_name) AS agent_name,
      count(*) AS total_listings,
      count(*) FILTER (WHERE al.is_captured) AS captured,
      count(*) FILTER (WHERE NOT al.is_captured) AS missed,
      COALESCE(sum(al.quoted_price) FILTER (
        WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value
    FROM agency_listings al
    WHERE al.agent_rea_id IS NOT NULL OR al.agent_pulse_id IS NOT NULL
    GROUP BY al.agent_rea_id, al.agent_pulse_id
  ),
  agents_enriched AS (
    SELECT
      ar.agent_rea_id,
      ar.agent_pulse_id,
      COALESCE(ar.agent_name, pa.full_name) AS agent_name,
      pa.profile_image,
      ar.total_listings,
      ar.captured,
      ar.missed,
      CASE WHEN ar.total_listings = 0 THEN 0
           ELSE round(100.0 * ar.captured / ar.total_listings, 2) END AS retention_rate_pct,
      ar.missed_value
    FROM agents_rollup ar
    LEFT JOIN pulse_agents pa ON pa.id = ar.agent_pulse_id
  ),
  top_missed AS (
    SELECT
      al.listing_id, al.address, al.suburb, al.first_seen_at,
      al.asking_price_numeric AS asking_price,
      al.classified_package_name, al.resolved_tier, al.pricing_method,
      al.quoted_price, al.photo_count, al.has_video,
      al.agency_name, al.agent_name, al.agent_rea_id, al.agent_pulse_id,
      al.source_url, al.quote_status, al.data_gap_flag
    FROM agency_listings al
    WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
    ORDER BY al.quoted_price DESC NULLS LAST, al.first_seen_at DESC
    LIMIT 20
  ),
  legacy_ever AS (
    -- FULL legacy portfolio for this pulse_agency (regardless of CRM state).
    SELECT count(*) AS n, max(completed_date) AS last_completed
    FROM legacy_projects lp
    WHERE lp.linked_pulse_agency_id = p_agency_pulse_id
  )
  SELECT jsonb_build_object(
    'agency_pulse_id',   p_agency_pulse_id,
    'crm_agency_id',     (SELECT crm_agency_id FROM agency_ctx),
    'window_from',       p_from,
    'window_to',         p_to,
    'total_listings',    (SELECT total_listings FROM totals),
    'captured',          (SELECT captured FROM totals),
    'missed',            (SELECT missed FROM totals),
    'retention_rate_pct', CASE
      WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * (SELECT captured FROM totals) / (SELECT total_listings FROM totals), 2)
    END,
    'missed_opportunity_value',             (SELECT missed_value FROM totals),
    'missed_opportunity_including_pending', (SELECT missed_value_incl_pending FROM totals),
    'total_legacy_projects_ever', COALESCE((SELECT n FROM legacy_ever), 0),
    'last_legacy_completed_date', (SELECT last_completed FROM legacy_ever),
    'by_package', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('package', package, 'listings', listings, 'value', value) ORDER BY value DESC) FROM by_package),
      '[]'::jsonb
    ),
    'by_tier', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('tier', tier, 'listings', listings, 'value', value) ORDER BY value DESC) FROM by_tier),
      '[]'::jsonb
    ),
    'agents', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'agent_rea_id',             agent_rea_id,
        'agent_pulse_id',           agent_pulse_id,
        'agent_name',               agent_name,
        'profile_image',            profile_image,
        'total_listings',           total_listings,
        'captured',                 captured,
        'missed',                   missed,
        'retention_rate_pct',       retention_rate_pct,
        'missed_opportunity_value', missed_value
      ) ORDER BY missed_value DESC, total_listings DESC) FROM agents_enriched),
      '[]'::jsonb
    ),
    'top_missed_listings', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'listing_id',              listing_id,
        'address',                 address,
        'suburb',                  suburb,
        'first_seen_at',           first_seen_at,
        'asking_price',            asking_price,
        'classified_package_name', classified_package_name,
        'resolved_tier',           resolved_tier,
        'pricing_method',          pricing_method,
        'quoted_price',            quoted_price,
        'photo_count',             photo_count,
        'has_video',               has_video,
        'agency_name',             agency_name,
        'agent_name',              agent_name,
        'agent_rea_id',            agent_rea_id,
        'agent_pulse_id',          agent_pulse_id,
        'source_url',              source_url,
        'quote_status',            quote_status,
        'data_gap_flag',           data_gap_flag
      )) FROM top_missed),
      '[]'::jsonb
    )
  );
$$;

COMMENT ON FUNCTION pulse_get_agency_retention IS
  'Per-agency retention + market-share rollup. total_legacy_projects_ever derived from legacy_projects.linked_pulse_agency_id (pulse layer) — migration 198.';

-- 11c. pulse_get_retention_agent_scope_v2
DROP FUNCTION IF EXISTS pulse_get_retention_agent_scope_v2(timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION pulse_get_retention_agent_scope_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agent_rea_id text,
  agent_pulse_id uuid,
  agent_name text,
  agency_name text,
  agency_pulse_id uuid,
  profile_image text,
  email text,
  mobile text,
  current_listings bigint,
  current_captured bigint,
  current_missed bigint,
  current_retention_pct numeric,
  current_missed_value numeric,
  sold_listings bigint,
  sold_captured bigint,
  sold_missed bigint,
  sold_retention_pct numeric,
  sold_missed_value numeric,
  projects_in_window bigint,
  last_project_date date,
  last_listing_date date,
  total_legacy_projects_ever bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH crm_agents AS (
    SELECT pa.id            AS agent_pulse_id,
           pa.rea_agent_id,
           pa.linked_agent_id AS crm_agent_id,
           pa.full_name      AS agent_name,
           pa.agency_name    AS agency_name,
           pa.profile_image,
           pa.email,
           pa.mobile,
           (SELECT id FROM pulse_agencies WHERE rea_agency_id = pa.agency_rea_id LIMIT 1) AS agency_pulse_id
    FROM pulse_agents pa
    WHERE pa.is_in_crm = true
      AND pa.rea_agent_id IS NOT NULL
  ),
  curr AS (
    SELECT l.agent_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           COALESCE(sum(q.quoted_price) FILTER (
             WHERE q.quote_status IN ('fresh','data_gap')
               AND NOT EXISTS (SELECT 1 FROM projects pr
                 WHERE pr.property_key = l.property_key
                   AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ), 0) AS missed_value,
           max(l.first_seen_at::date) AS last_seen
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
    GROUP BY l.agent_rea_id
  ),
  sold AS (
    SELECT l.agent_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           0::numeric AS missed_value,
           max(l.sold_date)::date AS last_sold
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= p_from::date
      AND l.sold_date < p_to::date
    GROUP BY l.agent_rea_id
  ),
  proj AS (
    SELECT pa.rea_agent_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM pulse_agents pa
    JOIN pulse_crm_mappings m ON m.entity_type = 'agent'
                              AND (m.pulse_entity_id = pa.id OR m.rea_id = pa.rea_agent_id)
    JOIN projects pr ON pr.agent_id = m.crm_entity_id
    WHERE pa.is_in_crm = true
      AND pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= p_from::date
      AND pr.shoot_date < p_to::date
    GROUP BY pa.rea_agent_id
  ),
  legacy_ever AS (
    -- Per pulse_agent full legacy portfolio (CRM-attributed via pulse chain).
    SELECT linked_pulse_agent_id AS agent_pulse_id, count(*) AS n
    FROM legacy_projects
    WHERE linked_pulse_agent_id IS NOT NULL
    GROUP BY linked_pulse_agent_id
  )
  SELECT
    ca.rea_agent_id   AS agent_rea_id,
    ca.agent_pulse_id,
    ca.agent_name,
    ca.agency_name,
    ca.agency_pulse_id,
    ca.profile_image,
    ca.email,
    ca.mobile,
    COALESCE(c.total, 0) AS current_listings,
    COALESCE(c.captured, 0) AS current_captured,
    COALESCE(c.total, 0) - COALESCE(c.captured, 0) AS current_missed,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(c.captured, 0) / c.total, 2) END AS current_retention_pct,
    COALESCE(c.missed_value, 0) AS current_missed_value,
    COALESCE(s.total, 0) AS sold_listings,
    COALESCE(s.captured, 0) AS sold_captured,
    COALESCE(s.total, 0) - COALESCE(s.captured, 0) AS sold_missed,
    CASE WHEN COALESCE(s.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(s.captured, 0) / s.total, 2) END AS sold_retention_pct,
    COALESCE(s.missed_value, 0) AS sold_missed_value,
    COALESCE(p.n, 0) AS projects_in_window,
    p.last_date AS last_project_date,
    GREATEST(c.last_seen, s.last_sold) AS last_listing_date,
    COALESCE(le.n, 0) AS total_legacy_projects_ever
  FROM crm_agents ca
  LEFT JOIN curr c        ON c.agent_rea_id = ca.rea_agent_id
  LEFT JOIN sold s        ON s.agent_rea_id = ca.rea_agent_id
  LEFT JOIN proj p        ON p.rea_agent_id = ca.rea_agent_id
  LEFT JOIN legacy_ever le ON le.agent_pulse_id = ca.agent_pulse_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agent_name;
$$;

-- 11d. pulse_get_retention_agency_scope_v2
DROP FUNCTION IF EXISTS pulse_get_retention_agency_scope_v2(timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION pulse_get_retention_agency_scope_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agency_pulse_id uuid,
  crm_agency_id uuid,
  agency_name text,
  logo_url text,
  suburb text,
  rea_agency_id text,
  agents_in_agency bigint,
  current_listings bigint,
  current_captured bigint,
  current_missed bigint,
  current_retention_pct numeric,
  current_missed_value numeric,
  sold_listings bigint,
  sold_captured bigint,
  sold_missed bigint,
  sold_retention_pct numeric,
  sold_missed_value numeric,
  projects_in_window bigint,
  last_project_date date,
  last_listing_date date,
  total_legacy_projects_ever bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH crm_agencies AS (
    SELECT pa.id                 AS agency_pulse_id,
           pa.linked_agency_id   AS crm_agency_id,
           pa.name               AS agency_name,
           pa.logo_url,
           pa.suburb,
           pa.rea_agency_id
    FROM pulse_agencies pa
    WHERE pa.is_in_crm = true
  ),
  agents_count AS (
    SELECT agency_rea_id, count(*)::bigint AS n
    FROM pulse_agents
    WHERE agency_rea_id IS NOT NULL
    GROUP BY agency_rea_id
  ),
  curr AS (
    SELECT l.agency_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           COALESCE(sum(q.quoted_price) FILTER (
             WHERE q.quote_status IN ('fresh','data_gap')
               AND NOT EXISTS (SELECT 1 FROM projects pr
                 WHERE pr.property_key = l.property_key
                   AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ), 0) AS missed_value,
           max(l.first_seen_at::date) AS last_seen
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
    GROUP BY l.agency_rea_id
  ),
  sold AS (
    SELECT l.agency_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           0::numeric AS missed_value,
           max(l.sold_date)::date AS last_sold
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= p_from::date
      AND l.sold_date < p_to::date
    GROUP BY l.agency_rea_id
  ),
  proj AS (
    SELECT ca.rea_agency_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM crm_agencies ca
    JOIN projects pr ON pr.agency_id = ca.crm_agency_id
    WHERE pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= p_from::date
      AND pr.shoot_date < p_to::date
    GROUP BY ca.rea_agency_id
  ),
  legacy_ever AS (
    SELECT linked_pulse_agency_id AS agency_pulse_id, count(*) AS n
    FROM legacy_projects
    WHERE linked_pulse_agency_id IS NOT NULL
    GROUP BY linked_pulse_agency_id
  )
  SELECT
    ca.agency_pulse_id,
    ca.crm_agency_id,
    ca.agency_name,
    ca.logo_url,
    ca.suburb,
    ca.rea_agency_id,
    COALESCE(ac.n, 0) AS agents_in_agency,
    COALESCE(c.total, 0) AS current_listings,
    COALESCE(c.captured, 0) AS current_captured,
    COALESCE(c.total, 0) - COALESCE(c.captured, 0) AS current_missed,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(c.captured, 0) / c.total, 2) END AS current_retention_pct,
    COALESCE(c.missed_value, 0) AS current_missed_value,
    COALESCE(s.total, 0) AS sold_listings,
    COALESCE(s.captured, 0) AS sold_captured,
    COALESCE(s.total, 0) - COALESCE(s.captured, 0) AS sold_missed,
    CASE WHEN COALESCE(s.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(s.captured, 0) / s.total, 2) END AS sold_retention_pct,
    COALESCE(s.missed_value, 0) AS sold_missed_value,
    COALESCE(p.n, 0) AS projects_in_window,
    p.last_date AS last_project_date,
    GREATEST(c.last_seen, s.last_sold) AS last_listing_date,
    COALESCE(le.n, 0) AS total_legacy_projects_ever
  FROM crm_agencies ca
  LEFT JOIN agents_count ac ON ac.agency_rea_id = ca.rea_agency_id
  LEFT JOIN curr c          ON c.agency_rea_id  = ca.rea_agency_id
  LEFT JOIN sold s          ON s.agency_rea_id  = ca.rea_agency_id
  LEFT JOIN proj p          ON p.rea_agency_id  = ca.rea_agency_id
  LEFT JOIN legacy_ever le  ON le.agency_pulse_id = ca.agency_pulse_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agency_name;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 12. Cron re-registration
-- ════════════════════════════════════════════════════════════════════════
DO $cron$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'pulse-legacy-reconcile';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $cron$;

SELECT cron.schedule(
  'pulse-legacy-reconcile',
  '10 4 * * *',
  $sch$ SELECT public.legacy_reconcile_all_pulse(0.85); $sch$
);

-- ════════════════════════════════════════════════════════════════════════
-- 13. Initial re-reconciliation
-- ════════════════════════════════════════════════════════════════════════
DO $init$
DECLARE v_res jsonb;
BEGIN
  v_res := legacy_reconcile_all_pulse(0.85);
  RAISE NOTICE '[198] legacy_reconcile_all_pulse result: %', v_res;
END $init$;

-- ════════════════════════════════════════════════════════════════════════
-- 14. Operator notification
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO pulse_timeline (
  entity_type, event_type, event_category,
  title, description, new_value, source, idempotency_key
) VALUES (
  'system',
  'legacy_reconciliation_relayered_to_pulse',
  'system',
  'Legacy reconciliation re-layered: CRM -> pulse',
  'legacy_projects now links to pulse_agents / pulse_agencies (8,810 + 2,557 candidates). CRM membership is derived transitively via pulse chain. Migration 198.',
  jsonb_build_object(
    'migration',     '198_legacy_projects_pulse_linkage',
    'new_rpcs', jsonb_build_array(
      'legacy_reconcile_by_property_chain_pulse',
      'legacy_reconcile_by_fuzzy_name_pulse',
      'legacy_reconcile_all_pulse'
    ),
    'rewritten_rpcs', jsonb_build_array(
      'pulse_get_agent_retention',
      'pulse_get_agency_retention',
      'pulse_get_retention_agent_scope_v2',
      'pulse_get_retention_agency_scope_v2',
      'legacy_reconciliation_stats',
      'legacy_reconciliation_review',
      'legacy_reconciliation_apply_manual',
      'legacy_reconciliation_apply_threshold'
    ),
    'new_view', 'legacy_projects_with_crm'
  ),
  '198_legacy_projects_pulse_linkage',
  '198_legacy_projects_pulse_linkage:shift'
)
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
