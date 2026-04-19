-- 195_legacy_projects_crm_linkage.sql
-- Entity-resolution layer for legacy_projects → CRM (agents + agencies).
--
-- Until now legacy_projects kept only raw strings (agent_name, agency_name,
-- client_email). Market Share correctly credits them via property_key match,
-- but per-agent / per-agency rollups are blind: an agent who shot 50 legacy
-- properties shows 0 legacy portfolio on their profile because there's no
-- foreign key back to `agents.id` / `agencies.id`.
--
-- This migration closes that gap with two linkage passes:
--
--   1. PROPERTY-CHAIN (highest confidence)
--      For each unlinked legacy row whose property_key matches a pulse_listings
--      row, chase: pulse_listings.agent_pulse_id → pulse_agents.linked_agent_id
--      → CRM agents.id. If resolved → link at confidence 0.95.
--      Rationale: same property + downstream agent linkage means the legacy
--      project was almost certainly by that CRM agent. The address alone isn't
--      enough (agents change over time), but address + current-linked agent on
--      a listing that exists there is near-deterministic.
--
--   2. FUZZY NAME (fallback)
--      For each remaining unlinked row, normalize raw agent_name / agency_name
--      and fuzzy-match via pg_trgm similarity + email-hit boost. Auto-link
--      above threshold (default 0.85). Lower scores land in a review queue.
--
-- Both passes are idempotent. A nightly cron (migration 196) re-runs
-- reconciliation so rows that were blocked by an unlinked pulse_agent get
-- picked up the next night once Agent A's workers auto-link the upstream
-- entity.
--
-- Contract to Agent B (substrate invalidation): a trigger on legacy_projects
-- marks affected pulse_listing_missed_opportunity rows stale whenever a
-- linkage is written, so the substrate re-aggregates per-agent rollups on
-- the next pulseRecomputeLegacy tick.
--
-- Anti-scope: does NOT touch pulse_agents/pulse_agencies schema, does NOT
-- touch pricing / packages, does NOT modify projects table.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Schema extensions
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE legacy_projects
  ADD COLUMN IF NOT EXISTS linked_contact_id          uuid,
  ADD COLUMN IF NOT EXISTS linked_agency_id           uuid,
  ADD COLUMN IF NOT EXISTS agent_linkage_confidence   numeric,
  ADD COLUMN IF NOT EXISTS agency_linkage_confidence  numeric,
  ADD COLUMN IF NOT EXISTS agent_linkage_source       text,
  ADD COLUMN IF NOT EXISTS agency_linkage_source      text,
  ADD COLUMN IF NOT EXISTS linkage_reviewed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS linkage_reviewed_by        uuid;

-- Foreign keys wired as NOT VALID to avoid slow full-table validate on prod;
-- VALIDATE in-place once (this is a 3.5k row table — trivial either way).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'legacy_projects' AND constraint_name = 'legacy_projects_linked_contact_fk'
  ) THEN
    ALTER TABLE legacy_projects
      ADD CONSTRAINT legacy_projects_linked_contact_fk
      FOREIGN KEY (linked_contact_id) REFERENCES agents(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE legacy_projects VALIDATE CONSTRAINT legacy_projects_linked_contact_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'legacy_projects' AND constraint_name = 'legacy_projects_linked_agency_fk'
  ) THEN
    ALTER TABLE legacy_projects
      ADD CONSTRAINT legacy_projects_linked_agency_fk
      FOREIGN KEY (linked_agency_id) REFERENCES agencies(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE legacy_projects VALIDATE CONSTRAINT legacy_projects_linked_agency_fk;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lp_linked_contact ON legacy_projects(linked_contact_id) WHERE linked_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lp_linked_agency  ON legacy_projects(linked_agency_id)  WHERE linked_agency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lp_linkage_unresolved
  ON legacy_projects (id) WHERE linked_contact_id IS NULL OR linked_agency_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_lp_linkage_source
  ON legacy_projects (agent_linkage_source, agency_linkage_source);

-- pg_trgm index on normalized agent/agency names speeds fuzzy-name lookups.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_lp_agent_name_trgm
  ON legacy_projects USING gin (lower(coalesce(agent_name,'')) gin_trgm_ops)
  WHERE agent_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lp_agency_name_trgm
  ON legacy_projects USING gin (lower(coalesce(agency_name,'')) gin_trgm_ops)
  WHERE agency_name IS NOT NULL;

COMMENT ON COLUMN legacy_projects.linked_contact_id IS
  'FK to agents(id) once the legacy project has been attributed to a CRM contact. Null while unlinked.';
COMMENT ON COLUMN legacy_projects.linked_agency_id IS
  'FK to agencies(id) once the legacy project has been attributed to a CRM agency.';
COMMENT ON COLUMN legacy_projects.agent_linkage_source IS
  'How linked_contact_id was set: property_chain (listing address match), fuzzy_name, or manual. Null when unlinked.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Helpers
-- ════════════════════════════════════════════════════════════════════════════

-- Normalize raw names for fuzzy matching: lowercase, strip punctuation, collapse
-- duplicate tokens ("Charles Charles Charles" → "Charles"). Uses the same
-- dedupe loop as legacy_normalize_address() in migration 183 for consistency.
CREATE OR REPLACE FUNCTION legacy_normalize_person_name(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s text;
  prev text;
  i int;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN NULL;
  END IF;
  s := lower(trim(p_name));
  -- Strip punctuation (keep letters, digits, spaces, hyphens, apostrophes)
  s := regexp_replace(s, '[^a-z0-9\- '']', ' ', 'g');
  -- Collapse whitespace
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := trim(s);
  -- Dedupe adjacent duplicated tokens up to 3 words long (repeat 3x to chain)
  FOR i IN 1..3 LOOP
    prev := s;
    s := regexp_replace(s, '\m(\w+(?:\s+\w+){0,2})\s+\1\M', '\1', 'gi');
    EXIT WHEN s = prev;
  END LOOP;
  -- Drop common honorifics / role words
  s := regexp_replace(s, '\m(mr|mrs|ms|miss|dr|the|team|group|property|real estate|realty|properties|pty ltd|pty|ltd)\M', ' ', 'gi');
  s := regexp_replace(s, '\s+', ' ', 'g');
  RETURN NULLIF(trim(s), '');
END;
$$;

COMMENT ON FUNCTION legacy_normalize_person_name IS
  'Normalize raw agent/agency name for fuzzy matching: lowercase, strip punctuation, dedupe adjacent tokens.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Property-chain reconciliation (highest confidence)
-- ════════════════════════════════════════════════════════════════════════════
--
-- For every unlinked legacy_project that has a property_key, find a matching
-- pulse_listings row. If that listing's agent_pulse_id / agency_pulse_id
-- resolves to a CRM-linked pulse_agent / pulse_agency, write the linkage.
--
-- Multiple listings may exist at the same property_key (re-listings over
-- time). Prefer the MOST RECENT listing that has a CRM-linked entity.

CREATE OR REPLACE FUNCTION legacy_reconcile_by_property_chain()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_scanned           int := 0;
  v_linked_agent      int := 0;
  v_linked_agency     int := 0;
  v_already_linked    int := 0;
  v_no_property_match int := 0;
BEGIN
  -- Materialize candidate matches: for each unlinked legacy row, find the
  -- most-recent pulse_listings row at the same property_key whose agent or
  -- agency has a non-null linked_*_id on pulse_agents / pulse_agencies.
  WITH candidates AS (
    SELECT
      lp.id AS legacy_id,
      lp.linked_contact_id IS NOT NULL AS had_agent,
      lp.linked_agency_id  IS NOT NULL AS had_agency,
      -- Best listing for AGENT (most recent with a CRM-linked pulse_agent)
      (
        SELECT pa.linked_agent_id
        FROM pulse_listings l
        JOIN pulse_agents pa ON pa.id = l.agent_pulse_id
        WHERE l.property_key = lp.property_key
          AND pa.linked_agent_id IS NOT NULL
        ORDER BY l.first_seen_at DESC NULLS LAST
        LIMIT 1
      ) AS crm_agent_id,
      -- Best listing for AGENCY
      (
        SELECT pag.linked_agency_id
        FROM pulse_listings l
        JOIN pulse_agencies pag ON pag.id = l.agency_pulse_id
        WHERE l.property_key = lp.property_key
          AND pag.linked_agency_id IS NOT NULL
        ORDER BY l.first_seen_at DESC NULLS LAST
        LIMIT 1
      ) AS crm_agency_id,
      -- Whether the property_key matches ANY listing at all (for stats)
      EXISTS (
        SELECT 1 FROM pulse_listings l WHERE l.property_key = lp.property_key
      ) AS has_any_listing_match
    FROM legacy_projects lp
    WHERE lp.property_key IS NOT NULL
      AND (lp.linked_contact_id IS NULL OR lp.linked_agency_id IS NULL)
  ),
  scan_stats AS (
    SELECT
      count(*)                                                  AS total,
      count(*) FILTER (WHERE NOT has_any_listing_match)         AS no_match,
      count(*) FILTER (WHERE crm_agent_id  IS NOT NULL AND NOT had_agent)  AS will_link_agent,
      count(*) FILTER (WHERE crm_agency_id IS NOT NULL AND NOT had_agency) AS will_link_agency
    FROM candidates
  ),
  upd AS (
    UPDATE legacy_projects lp
    SET
      linked_contact_id         = CASE WHEN lp.linked_contact_id IS NULL AND c.crm_agent_id IS NOT NULL
                                       THEN c.crm_agent_id ELSE lp.linked_contact_id END,
      agent_linkage_confidence  = CASE WHEN lp.linked_contact_id IS NULL AND c.crm_agent_id IS NOT NULL
                                       THEN 0.95 ELSE lp.agent_linkage_confidence END,
      agent_linkage_source      = CASE WHEN lp.linked_contact_id IS NULL AND c.crm_agent_id IS NOT NULL
                                       THEN 'property_chain' ELSE lp.agent_linkage_source END,
      linked_agency_id          = CASE WHEN lp.linked_agency_id  IS NULL AND c.crm_agency_id IS NOT NULL
                                       THEN c.crm_agency_id ELSE lp.linked_agency_id END,
      agency_linkage_confidence = CASE WHEN lp.linked_agency_id  IS NULL AND c.crm_agency_id IS NOT NULL
                                       THEN 0.95 ELSE lp.agency_linkage_confidence END,
      agency_linkage_source     = CASE WHEN lp.linked_agency_id  IS NULL AND c.crm_agency_id IS NOT NULL
                                       THEN 'property_chain' ELSE lp.agency_linkage_source END,
      updated_at                = now()
    FROM candidates c
    WHERE lp.id = c.legacy_id
      AND (
        (lp.linked_contact_id IS NULL AND c.crm_agent_id  IS NOT NULL) OR
        (lp.linked_agency_id  IS NULL AND c.crm_agency_id IS NOT NULL)
      )
    RETURNING lp.id, lp.linked_contact_id, lp.linked_agency_id, lp.property_key, lp.raw_address
  ),
  tl AS (
    -- Emit a timeline event per linked row (idempotency_key prevents dupes)
    INSERT INTO pulse_timeline (
      entity_type, event_type, event_category,
      title, description,
      new_value, source, idempotency_key, created_at
    )
    SELECT
      'legacy_project',
      'legacy_project_linked_via_property',
      'system',
      'Legacy project linked via property chain',
      'Legacy project at ' || COALESCE(upd.raw_address, upd.property_key, '(unknown)')
        || ' attributed to CRM entities via matching pulse_listings row.',
      jsonb_build_object(
        'legacy_project_id', upd.id,
        'linked_contact_id', upd.linked_contact_id,
        'linked_agency_id',  upd.linked_agency_id,
        'property_key',      upd.property_key,
        'confidence',        0.95,
        'method',            'property_chain'
      ),
      'legacy_reconcile_by_property_chain',
      'legacy_project_linked_via_property:' || upd.id::text,
      now()
    FROM upd
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT total FROM scan_stats),
    (SELECT will_link_agent FROM scan_stats),
    (SELECT will_link_agency FROM scan_stats),
    (SELECT count(*) FROM upd),
    (SELECT no_match FROM scan_stats)
  INTO
    v_scanned, v_linked_agent, v_linked_agency, v_already_linked, v_no_property_match;

  RETURN jsonb_build_object(
    'method',             'property_chain',
    'scanned',            v_scanned,
    'linked_agent',       v_linked_agent,
    'linked_agency',      v_linked_agency,
    'already_linked',     v_already_linked,
    'no_property_match',  v_no_property_match,
    'ran_at',             now()
  );
END;
$$;

COMMENT ON FUNCTION legacy_reconcile_by_property_chain IS
  'Highest-confidence legacy→CRM linkage via property_key chain through pulse_listings. Idempotent. Confidence=0.95 on match.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Fuzzy-name reconciliation (fallback)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION legacy_reconcile_by_fuzzy_name(
  p_auto_threshold numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_scanned        int := 0;
  v_linked_agent   int := 0;
  v_linked_agency  int := 0;
  v_queued_review  int := 0;
BEGIN
  -- ── AGENT (contact) fuzzy match ──────────────────────────────────────────
  WITH
  candidates AS (
    SELECT lp.id AS legacy_id,
           legacy_normalize_person_name(lp.agent_name) AS norm_name,
           lp.client_email,
           lp.agent_name
    FROM legacy_projects lp
    WHERE lp.linked_contact_id IS NULL
      AND lp.agent_name IS NOT NULL
      AND length(trim(lp.agent_name)) >= 3
  ),
  scored AS (
    SELECT
      c.legacy_id,
      a.id AS candidate_id,
      a.name AS candidate_name,
      similarity(c.norm_name, legacy_normalize_person_name(a.name)) AS name_sim,
      -- Email signal: +0.15 when the legacy client_email matches the agent email
      CASE WHEN c.client_email IS NOT NULL AND a.email IS NOT NULL
                AND lower(trim(c.client_email)) = lower(trim(a.email))
           THEN 0.15 ELSE 0 END AS email_boost,
      ROW_NUMBER() OVER (
        PARTITION BY c.legacy_id
        ORDER BY
          similarity(c.norm_name, legacy_normalize_person_name(a.name)) DESC,
          CASE WHEN c.client_email IS NOT NULL AND a.email IS NOT NULL
                    AND lower(trim(c.client_email)) = lower(trim(a.email))
               THEN 0 ELSE 1 END
      ) AS rn
    FROM candidates c
    CROSS JOIN agents a
    WHERE a.name IS NOT NULL
      AND legacy_normalize_person_name(a.name) IS NOT NULL
      AND similarity(c.norm_name, legacy_normalize_person_name(a.name)) > 0.3
  ),
  winners AS (
    SELECT legacy_id, candidate_id, candidate_name,
           LEAST(1.0, name_sim + email_boost) AS score
    FROM scored
    WHERE rn = 1
  ),
  upd AS (
    UPDATE legacy_projects lp
    SET
      linked_contact_id        = w.candidate_id,
      agent_linkage_confidence = round(w.score::numeric, 3),
      agent_linkage_source     = 'fuzzy_name',
      updated_at               = now()
    FROM winners w
    WHERE lp.id = w.legacy_id
      AND w.score >= p_auto_threshold
      AND lp.linked_contact_id IS NULL
    RETURNING lp.id, lp.linked_contact_id, lp.agent_linkage_confidence, lp.raw_address, lp.agent_name
  ),
  tl AS (
    INSERT INTO pulse_timeline (
      entity_type, event_type, event_category,
      title, description, new_value, source, idempotency_key, created_at
    )
    SELECT
      'legacy_project',
      'legacy_project_linked_via_fuzzy',
      'system',
      'Legacy project auto-linked via fuzzy name',
      'Raw agent name "' || COALESCE(upd.agent_name,'') || '" matched to CRM agent id='
        || upd.linked_contact_id::text || ' (confidence ' || upd.agent_linkage_confidence::text || ').',
      jsonb_build_object(
        'legacy_project_id', upd.id,
        'linked_contact_id', upd.linked_contact_id,
        'raw_name',          upd.agent_name,
        'confidence',        upd.agent_linkage_confidence,
        'method',            'fuzzy_name'
      ),
      'legacy_reconcile_by_fuzzy_name',
      'legacy_project_linked_via_fuzzy:' || upd.id::text || ':agent',
      now()
    FROM upd
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM candidates), (SELECT count(*) FROM upd)
  INTO v_scanned, v_linked_agent;

  -- ── AGENCY fuzzy match ───────────────────────────────────────────────────
  WITH
  candidates AS (
    SELECT lp.id AS legacy_id,
           legacy_normalize_person_name(lp.agency_name) AS norm_name,
           lp.agency_name
    FROM legacy_projects lp
    WHERE lp.linked_agency_id IS NULL
      AND lp.agency_name IS NOT NULL
      AND length(trim(lp.agency_name)) >= 3
  ),
  scored AS (
    SELECT
      c.legacy_id,
      ag.id AS candidate_id,
      similarity(c.norm_name, legacy_normalize_person_name(ag.name)) AS name_sim,
      ROW_NUMBER() OVER (
        PARTITION BY c.legacy_id
        ORDER BY similarity(c.norm_name, legacy_normalize_person_name(ag.name)) DESC
      ) AS rn
    FROM candidates c
    CROSS JOIN agencies ag
    WHERE ag.name IS NOT NULL
      AND legacy_normalize_person_name(ag.name) IS NOT NULL
      AND similarity(c.norm_name, legacy_normalize_person_name(ag.name)) > 0.3
  ),
  winners AS (
    SELECT legacy_id, candidate_id, name_sim AS score FROM scored WHERE rn = 1
  ),
  upd AS (
    UPDATE legacy_projects lp
    SET
      linked_agency_id          = w.candidate_id,
      agency_linkage_confidence = round(w.score::numeric, 3),
      agency_linkage_source     = 'fuzzy_name',
      updated_at                = now()
    FROM winners w
    WHERE lp.id = w.legacy_id
      AND w.score >= p_auto_threshold
      AND lp.linked_agency_id IS NULL
    RETURNING lp.id, lp.linked_agency_id, lp.agency_linkage_confidence, lp.agency_name
  ),
  tl AS (
    INSERT INTO pulse_timeline (
      entity_type, event_type, event_category,
      title, description, new_value, source, idempotency_key, created_at
    )
    SELECT
      'legacy_project',
      'legacy_project_linked_via_fuzzy',
      'system',
      'Legacy project agency auto-linked via fuzzy name',
      'Raw agency name "' || COALESCE(upd.agency_name,'') || '" matched to CRM agency id='
        || upd.linked_agency_id::text || ' (confidence ' || upd.agency_linkage_confidence::text || ').',
      jsonb_build_object(
        'legacy_project_id', upd.id,
        'linked_agency_id',  upd.linked_agency_id,
        'raw_name',          upd.agency_name,
        'confidence',        upd.agency_linkage_confidence,
        'method',            'fuzzy_name'
      ),
      'legacy_reconcile_by_fuzzy_name',
      'legacy_project_linked_via_fuzzy:' || upd.id::text || ':agency',
      now()
    FROM upd
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM upd) INTO v_linked_agency;

  -- Remaining unlinked rows (both contact + agency still null) go to review
  SELECT count(*)
  INTO v_queued_review
  FROM legacy_projects lp
  WHERE (lp.linked_contact_id IS NULL AND lp.agent_name  IS NOT NULL)
     OR (lp.linked_agency_id  IS NULL AND lp.agency_name IS NOT NULL);

  RETURN jsonb_build_object(
    'method',           'fuzzy_name',
    'auto_threshold',   p_auto_threshold,
    'scanned',          v_scanned,
    'linked_agent',     v_linked_agent,
    'linked_agency',    v_linked_agency,
    'queued_review',    v_queued_review,
    'ran_at',           now()
  );
END;
$$;

COMMENT ON FUNCTION legacy_reconcile_by_fuzzy_name IS
  'Fallback legacy→CRM linkage via pg_trgm similarity on agent/agency names + email signal. Threshold default 0.85.';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Convenience: run both passes
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION legacy_reconcile_all(
  p_auto_threshold numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_prop  jsonb;
  v_fuzz  jsonb;
BEGIN
  v_prop := legacy_reconcile_by_property_chain();
  v_fuzz := legacy_reconcile_by_fuzzy_name(p_auto_threshold);

  RETURN jsonb_build_object(
    'property_chain', v_prop,
    'fuzzy_name',     v_fuzz,
    'combined', jsonb_build_object(
      'linked_agent_total',  COALESCE((v_prop->>'linked_agent')::int, 0)
                           + COALESCE((v_fuzz->>'linked_agent')::int, 0),
      'linked_agency_total', COALESCE((v_prop->>'linked_agency')::int, 0)
                           + COALESCE((v_fuzz->>'linked_agency')::int, 0)
    ),
    'ran_at', now()
  );
END;
$$;

COMMENT ON FUNCTION legacy_reconcile_all IS
  'Runs property_chain then fuzzy_name reconciliation. Idempotent. Wired to nightly cron pulse-legacy-reconcile (migration 196).';

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Admin-review RPCs (consumed by SettingsLegacyCrmReconciliation.jsx)
-- ════════════════════════════════════════════════════════════════════════════

-- 6a. Stat strip
CREATE OR REPLACE FUNCTION legacy_reconciliation_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH lp AS (
    SELECT
      linked_contact_id IS NOT NULL AS has_agent,
      linked_agency_id  IS NOT NULL AS has_agency,
      agent_linkage_source,
      agency_linkage_source,
      agent_linkage_confidence,
      agency_linkage_confidence
    FROM legacy_projects
  )
  SELECT jsonb_build_object(
    'total',             count(*),
    'fully_linked',      count(*) FILTER (WHERE has_agent AND has_agency),
    'agent_only',        count(*) FILTER (WHERE has_agent AND NOT has_agency),
    'agency_only',       count(*) FILTER (WHERE has_agency AND NOT has_agent),
    'unlinked',          count(*) FILTER (WHERE NOT has_agent AND NOT has_agency),
    'by_source', jsonb_build_object(
      'property_chain', count(*) FILTER (WHERE agent_linkage_source = 'property_chain' OR agency_linkage_source = 'property_chain'),
      'fuzzy_name',     count(*) FILTER (WHERE agent_linkage_source = 'fuzzy_name'     OR agency_linkage_source = 'fuzzy_name'),
      'manual',         count(*) FILTER (WHERE agent_linkage_source = 'manual'         OR agency_linkage_source = 'manual')
    ),
    'confidence_bands', jsonb_build_object(
      'high',   count(*) FILTER (WHERE (agent_linkage_confidence >= 0.85) OR (agency_linkage_confidence >= 0.85)),
      'medium', count(*) FILTER (WHERE (agent_linkage_confidence >= 0.6 AND agent_linkage_confidence < 0.85)
                                    OR (agency_linkage_confidence >= 0.6 AND agency_linkage_confidence < 0.85)),
      'low',    count(*) FILTER (WHERE (agent_linkage_confidence < 0.6 AND agent_linkage_confidence IS NOT NULL)
                                    OR (agency_linkage_confidence < 0.6 AND agency_linkage_confidence IS NOT NULL))
    )
  )
  FROM lp;
$$;

-- 6b. Review queue — returns unlinked rows with top-3 suggestions
DROP FUNCTION IF EXISTS legacy_reconciliation_review(text, text, int, int);
CREATE OR REPLACE FUNCTION legacy_reconciliation_review(
  p_filter  text DEFAULT 'unlinked',   -- 'unlinked' | 'agent_only' | 'agency_only' | 'linked' | 'all'
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
        WHEN 'unlinked'    THEN lp.linked_contact_id IS NULL AND lp.linked_agency_id IS NULL
        WHEN 'agent_only'  THEN lp.linked_contact_id IS NOT NULL AND lp.linked_agency_id IS NULL
        WHEN 'agency_only' THEN lp.linked_agency_id  IS NOT NULL AND lp.linked_contact_id IS NULL
        WHEN 'linked'      THEN lp.linked_contact_id IS NOT NULL AND lp.linked_agency_id IS NOT NULL
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
      -- Top 3 candidate CRM agents by name similarity
      COALESCE((
        SELECT jsonb_agg(sub ORDER BY sub->>'score' DESC)
        FROM (
          SELECT jsonb_build_object(
                   'id',    a.id,
                   'name',  a.name,
                   'email', a.email,
                   'score', round(similarity(
                              legacy_normalize_person_name(f.agent_name),
                              legacy_normalize_person_name(a.name))::numeric, 3)
                 ) AS sub
          FROM agents a
          WHERE a.name IS NOT NULL
            AND legacy_normalize_person_name(f.agent_name) IS NOT NULL
            AND similarity(
                  legacy_normalize_person_name(f.agent_name),
                  legacy_normalize_person_name(a.name)) > 0.25
          ORDER BY similarity(
            legacy_normalize_person_name(f.agent_name),
            legacy_normalize_person_name(a.name)) DESC
          LIMIT 3
        ) sx
      ), '[]'::jsonb) AS candidate_agents,
      COALESCE((
        SELECT jsonb_agg(sub ORDER BY sub->>'score' DESC)
        FROM (
          SELECT jsonb_build_object(
                   'id',    ag.id,
                   'name',  ag.name,
                   'score', round(similarity(
                              legacy_normalize_person_name(f.agency_name),
                              legacy_normalize_person_name(ag.name))::numeric, 3)
                 ) AS sub
          FROM agencies ag
          WHERE ag.name IS NOT NULL
            AND legacy_normalize_person_name(f.agency_name) IS NOT NULL
            AND similarity(
                  legacy_normalize_person_name(f.agency_name),
                  legacy_normalize_person_name(ag.name)) > 0.25
          ORDER BY similarity(
            legacy_normalize_person_name(f.agency_name),
            legacy_normalize_person_name(ag.name)) DESC
          LIMIT 3
        ) sx
      ), '[]'::jsonb) AS candidate_agencies
    FROM filtered f
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',                        e.id,
      'raw_address',               e.raw_address,
      'agent_name',                e.agent_name,
      'agency_name',               e.agency_name,
      'client_name',               e.client_name,
      'client_email',              e.client_email,
      'completed_date',            e.completed_date,
      'property_key',              e.property_key,
      'linked_contact_id',         e.linked_contact_id,
      'linked_agency_id',          e.linked_agency_id,
      'agent_linkage_confidence',  e.agent_linkage_confidence,
      'agency_linkage_confidence', e.agency_linkage_confidence,
      'agent_linkage_source',      e.agent_linkage_source,
      'agency_linkage_source',     e.agency_linkage_source,
      'candidate_agents',          e.candidate_agents,
      'candidate_agencies',        e.candidate_agencies
    )) FROM enriched e), '[]'::jsonb),
    'limit',  p_limit,
    'offset', p_offset,
    'filter', p_filter
  );
$$;

-- 6c. Manual apply/clear
CREATE OR REPLACE FUNCTION legacy_reconciliation_apply_manual(
  p_legacy_id uuid,
  p_contact_id uuid DEFAULT NULL,
  p_agency_id  uuid DEFAULT NULL,
  p_reviewer   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row legacy_projects%ROWTYPE;
BEGIN
  UPDATE legacy_projects
  SET
    linked_contact_id         = COALESCE(p_contact_id, linked_contact_id),
    agent_linkage_source      = CASE WHEN p_contact_id IS NOT NULL THEN 'manual' ELSE agent_linkage_source END,
    agent_linkage_confidence  = CASE WHEN p_contact_id IS NOT NULL THEN 1.0      ELSE agent_linkage_confidence END,
    linked_agency_id          = COALESCE(p_agency_id,  linked_agency_id),
    agency_linkage_source     = CASE WHEN p_agency_id IS NOT NULL THEN 'manual' ELSE agency_linkage_source END,
    agency_linkage_confidence = CASE WHEN p_agency_id IS NOT NULL THEN 1.0      ELSE agency_linkage_confidence END,
    linkage_reviewed_at       = now(),
    linkage_reviewed_by       = p_reviewer,
    updated_at                = now()
  WHERE id = p_legacy_id
  RETURNING * INTO v_row;

  INSERT INTO pulse_timeline (
    entity_type, event_type, event_category,
    title, description, new_value, source, idempotency_key, created_at
  ) VALUES (
    'legacy_project',
    'legacy_project_linked_manual',
    'system',
    'Legacy project linked manually',
    'Reviewer applied manual linkage for legacy_project ' || p_legacy_id::text || '.',
    jsonb_build_object(
      'legacy_project_id', p_legacy_id,
      'linked_contact_id', v_row.linked_contact_id,
      'linked_agency_id',  v_row.linked_agency_id,
      'reviewer',          p_reviewer
    ),
    'legacy_reconciliation_apply_manual',
    'legacy_project_linked_manual:' || p_legacy_id::text || ':' || extract(epoch FROM now())::text,
    now()
  );

  RETURN jsonb_build_object(
    'ok',                true,
    'id',                v_row.id,
    'linked_contact_id', v_row.linked_contact_id,
    'linked_agency_id',  v_row.linked_agency_id
  );
END;
$$;

-- 6d. Bulk confirm at or above a confidence threshold (applies to rows that
-- already have a suggested linkage above the threshold but have not yet been
-- confirmed — in practice this is a no-op on already-linked rows since
-- auto-linking above 0.85 happens in the reconcile RPCs, but it's the way
-- reviewers say "trust the engine for everything above X" on the UI.)
CREATE OR REPLACE FUNCTION legacy_reconciliation_apply_threshold(
  p_min_confidence numeric DEFAULT 0.85,
  p_reviewer       uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE v_marked int;
BEGIN
  UPDATE legacy_projects
  SET linkage_reviewed_at = now(),
      linkage_reviewed_by = p_reviewer,
      updated_at = now()
  WHERE (
    (linked_contact_id IS NOT NULL AND agent_linkage_confidence  >= p_min_confidence) OR
    (linked_agency_id  IS NOT NULL AND agency_linkage_confidence >= p_min_confidence)
  )
    AND linkage_reviewed_at IS NULL;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RETURN jsonb_build_object('marked_reviewed', v_marked, 'threshold', p_min_confidence);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Substrate invalidation trigger (contract for Agent B)
-- ════════════════════════════════════════════════════════════════════════════
-- When a legacy_project gets its linked_contact_id / linked_agency_id set or
-- cleared, mark affected pulse_listing_missed_opportunity rows stale so the
-- substrate re-aggregates per-agent / per-agency rollups on the next
-- pulseRecomputeLegacy tick. Per-agent rollups filter on legacy via the new
-- linkage, so any change ripples.
--
-- We implement "stale" as setting captured_by_legacy = NULL momentarily so
-- the recompute worker picks it up. Since migration 187 defined
-- captured_by_legacy as boolean, we bump updated_at instead — the legacy
-- recompute worker's stale_only mode keys off updated_at.

CREATE OR REPLACE FUNCTION legacy_projects_invalidate_substrate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only care about linkage changes, not cosmetic edits.
  IF TG_OP = 'UPDATE'
     AND NEW.linked_contact_id IS NOT DISTINCT FROM OLD.linked_contact_id
     AND NEW.linked_agency_id  IS NOT DISTINCT FROM OLD.linked_agency_id THEN
    RETURN NEW;
  END IF;

  -- Touch substrate rows that share this property_key — the legacy recompute
  -- worker's "stale_only" mode (see pulseRecomputeLegacy edge function, wired
  -- by migration 188) will re-evaluate these rows on the next tick.
  IF NEW.property_key IS NOT NULL THEN
    UPDATE pulse_listing_missed_opportunity
    SET updated_at = now()
    WHERE property_key = NEW.property_key;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legacy_projects_invalidate_substrate ON legacy_projects;
CREATE TRIGGER trg_legacy_projects_invalidate_substrate
  AFTER INSERT OR UPDATE OF linked_contact_id, linked_agency_id ON legacy_projects
  FOR EACH ROW EXECUTE FUNCTION legacy_projects_invalidate_substrate();

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Initial reconciliation — link current 3,480 rows where possible
-- ════════════════════════════════════════════════════════════════════════════

DO $init$
DECLARE
  v_res jsonb;
BEGIN
  v_res := legacy_reconcile_all(0.85);
  RAISE NOTICE '[195] legacy_reconcile_all result: %', v_res;
END $init$;

COMMIT;
