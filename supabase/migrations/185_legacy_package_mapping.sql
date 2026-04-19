-- 185_legacy_package_mapping.sql
-- Record-linkage layer that maps legacy_projects.package_name_legacy (raw
-- text from Pipedrive / spreadsheets / older CRMs) onto FlexStudios'
-- canonical 6-package catalog with std/prm tiers.
--
-- Three moving parts:
--
--   1. legacy_package_aliases — user-maintainable alias dictionary. Seeded
--      with common Pipedrive label patterns; grows via the admin UI in
--      SettingsLegacyPackageMapping when reviewers confirm a mapping.
--   2. legacy_map_package(raw, source_hint) — pure fuzzy matcher. Tries
--      exact → prefix → contains → regex → pg_trgm similarity in order,
--      returns the highest-confidence match.
--   3. legacy_map_packages_batch(batch_id, limit) — worker that walks the
--      unmapped queue on legacy_projects, calls the matcher row-by-row,
--      stores the result in legacy_projects.mapped_package_id et al, and
--      returns {attempted, mapped, unmapped}. Wired to a cron in 186.
--
-- Anti-scope note: legacy_projects is owned by a parallel agent. This
-- migration NEVER creates or reshapes that table; it only ADDs the four
-- mapping columns if the table exists but those columns don't, so it's
-- safe to deploy before OR after the sibling migration lands.
--
-- pg_trgm is already installed on this project (verified via
-- pg_extension query) so we only guard against the edge case of a fresh
-- environment missing it.

BEGIN;

-- ── Extension guard ────────────────────────────────────────────────────────
-- pg_trgm gives us similarity() for fuzzy matching. It's already on prod
-- but this line keeps the migration idempotent across environments.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Alias dictionary ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legacy_package_aliases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_pattern         text NOT NULL,
  match_mode            text NOT NULL CHECK (match_mode IN ('exact','prefix','contains','regex','fuzzy')),
  canonical_package_id  uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  canonical_tier        text CHECK (canonical_tier IN ('standard','premium')),
  source_hint           text,
  confidence            numeric DEFAULT 0.9,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  created_by            uuid,
  notes                 text
);

CREATE INDEX IF NOT EXISTS idx_legacy_pkg_aliases_pattern
  ON legacy_package_aliases (lower(alias_pattern));

CREATE INDEX IF NOT EXISTS idx_legacy_pkg_aliases_mode
  ON legacy_package_aliases (match_mode);

CREATE INDEX IF NOT EXISTS idx_legacy_pkg_aliases_source_hint
  ON legacy_package_aliases (source_hint)
  WHERE source_hint IS NOT NULL;

ALTER TABLE legacy_package_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "legacy_pkg_aliases_read" ON legacy_package_aliases;
CREATE POLICY "legacy_pkg_aliases_read"
  ON legacy_package_aliases FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "legacy_pkg_aliases_write" ON legacy_package_aliases;
CREATE POLICY "legacy_pkg_aliases_write"
  ON legacy_package_aliases FOR ALL
  USING (auth.role() IN ('authenticated','service_role'))
  WITH CHECK (auth.role() IN ('authenticated','service_role'));

-- ── Mapping columns on legacy_projects (defensive) ────────────────────────
-- Only touches legacy_projects if the sibling agent has already created
-- the table. We add the four mapping columns if they aren't already
-- there. If the table doesn't exist yet, we skip — agent 1's migration
-- is expected to include these columns from the start, and this block
-- exists purely to make the worker RPC below deployable in either order.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
  ) THEN
    -- mapped_package_id
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'legacy_projects'
        AND column_name = 'mapped_package_id'
    ) THEN
      ALTER TABLE legacy_projects
        ADD COLUMN mapped_package_id uuid REFERENCES packages(id);
    END IF;

    -- mapped_package_name
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'legacy_projects'
        AND column_name = 'mapped_package_name'
    ) THEN
      ALTER TABLE legacy_projects
        ADD COLUMN mapped_package_name text;
    END IF;

    -- mapped_package_tier
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'legacy_projects'
        AND column_name = 'mapped_package_tier'
    ) THEN
      ALTER TABLE legacy_projects
        ADD COLUMN mapped_package_tier text;
    END IF;

    -- mapping_confidence
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'legacy_projects'
        AND column_name = 'mapping_confidence'
    ) THEN
      ALTER TABLE legacy_projects
        ADD COLUMN mapping_confidence numeric;
    END IF;

    -- mapping_source
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'legacy_projects'
        AND column_name = 'mapping_source'
    ) THEN
      ALTER TABLE legacy_projects
        ADD COLUMN mapping_source text;
    END IF;

    -- mapped_at
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'legacy_projects'
        AND column_name = 'mapped_at'
    ) THEN
      ALTER TABLE legacy_projects
        ADD COLUMN mapped_at timestamptz;
    END IF;

    -- Helper indexes for the worker + admin UI
    CREATE INDEX IF NOT EXISTS idx_legacy_projects_unmapped
      ON legacy_projects (id)
      WHERE mapped_package_id IS NULL AND package_name_legacy IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_legacy_projects_package_name_legacy
      ON legacy_projects (lower(package_name_legacy));

    CREATE INDEX IF NOT EXISTS idx_legacy_projects_mapping_confidence
      ON legacy_projects (mapping_confidence)
      WHERE mapping_confidence IS NOT NULL;
  END IF;
END $$;

-- ── Seed the alias dictionary ─────────────────────────────────────────────
-- Educated-guess patterns based on common Pipedrive labelling conventions.
-- All seeded rows use match_mode='contains' with lower() normalization.
-- Pattern order matters for humans reading it, not for the matcher.
--
-- Guiding heuristics:
--   • "premium" / "prm" / "plus" tokens → prm tier
--   • default tier is std unless AI (which has no prm)
--   • specific package keywords ("dusk video", "day video", "flex",
--     "silver", "gold", "ai") map direct to the canonical name
--
-- These are seeded only on first run (ON CONFLICT DO NOTHING on a
-- synthetic unique key via WHERE NOT EXISTS).

DO $$
DECLARE
  v_silver uuid;
  v_gold   uuid;
  v_ai     uuid;
  v_day    uuid;
  v_dusk   uuid;
  v_flex   uuid;
BEGIN
  SELECT id INTO v_silver FROM packages WHERE name ILIKE 'Silver%'    LIMIT 1;
  SELECT id INTO v_gold   FROM packages WHERE name ILIKE 'Gold%'      LIMIT 1;
  SELECT id INTO v_ai     FROM packages WHERE name ILIKE 'AI%'        LIMIT 1;
  SELECT id INTO v_day    FROM packages WHERE name ILIKE 'Day Video%' LIMIT 1;
  SELECT id INTO v_dusk   FROM packages WHERE name ILIKE 'Dusk Video%' LIMIT 1;
  SELECT id INTO v_flex   FROM packages WHERE name ILIKE 'Flex%'      LIMIT 1;

  -- Don't re-seed on re-run
  IF EXISTS (SELECT 1 FROM legacy_package_aliases LIMIT 1) THEN
    RETURN;
  END IF;

  -- ── Silver ─────────────────────────────────────────────────────────────
  IF v_silver IS NOT NULL THEN
    INSERT INTO legacy_package_aliases (alias_pattern, match_mode, canonical_package_id, canonical_tier, confidence, notes) VALUES
      ('silver premium',    'contains', v_silver, 'premium',  0.95, 'seed'),
      ('premium silver',    'contains', v_silver, 'premium',  0.95, 'seed'),
      ('silver prm',        'contains', v_silver, 'premium',  0.95, 'seed — "prm" marker beats bare-tier fallback'),
      ('silver+',           'contains', v_silver, 'premium',  0.95, 'seed — "+" marker beats bare-tier fallback'),
      ('silver plus',       'contains', v_silver, 'premium',  0.95, 'seed — "plus" marker beats bare-tier fallback'),
      ('silver',            'contains', v_silver, 'standard', 0.90, 'seed: fallback — if "premium" also matched it will outrank'),
      ('standard pack',     'contains', v_silver, 'standard', 0.80, 'seed: "standard pack"/"basic" historically = entry-level Silver'),
      ('basic pack',        'contains', v_silver, 'standard', 0.75, 'seed'),
      ('starter',           'contains', v_silver, 'standard', 0.70, 'seed'),
      ('entry',             'contains', v_silver, 'standard', 0.65, 'seed'),
      ('10 photos',         'contains', v_silver, 'standard', 0.70, 'seed: photo-count heuristic');
  END IF;

  -- ── Gold ───────────────────────────────────────────────────────────────
  IF v_gold IS NOT NULL THEN
    INSERT INTO legacy_package_aliases (alias_pattern, match_mode, canonical_package_id, canonical_tier, confidence, notes) VALUES
      ('gold premium',      'contains', v_gold, 'premium',  0.95, 'seed'),
      ('premium gold',      'contains', v_gold, 'premium',  0.95, 'seed'),
      ('gold prm',          'contains', v_gold, 'premium',  0.95, 'seed — "prm" marker beats bare-tier fallback'),
      ('gold plus',         'contains', v_gold, 'premium',  0.95, 'seed — "plus" marker beats bare-tier fallback'),
      ('gold+',             'contains', v_gold, 'premium',  0.95, 'seed — "+" marker beats bare-tier fallback'),
      ('gold',              'contains', v_gold, 'standard', 0.90, 'seed'),
      ('15 photos',         'contains', v_gold, 'standard', 0.70, 'seed: photo-count heuristic'),
      ('photos+drone',      'contains', v_gold, 'standard', 0.65, 'seed'),
      ('photography+drone', 'contains', v_gold, 'standard', 0.65, 'seed');
  END IF;

  -- ── AI (no premium tier) ───────────────────────────────────────────────
  IF v_ai IS NOT NULL THEN
    INSERT INTO legacy_package_aliases (alias_pattern, match_mode, canonical_package_id, canonical_tier, confidence, notes) VALUES
      ('ai package',        'contains', v_ai, 'standard', 0.95, 'seed'),
      ('ai video',          'contains', v_ai, 'standard', 0.90, 'seed'),
      ('ai pack',           'contains', v_ai, 'standard', 0.92, 'seed'),
      (' ai ',              'contains', v_ai, 'standard', 0.70, 'seed: word boundary — avoids matching "train" etc.'),
      ('digital dusk',      'contains', v_ai, 'standard', 0.80, 'seed: unique to AI package'),
      ('artificial',        'contains', v_ai, 'standard', 0.65, 'seed');
  END IF;

  -- ── Day Video ──────────────────────────────────────────────────────────
  IF v_day IS NOT NULL THEN
    INSERT INTO legacy_package_aliases (alias_pattern, match_mode, canonical_package_id, canonical_tier, confidence, notes) VALUES
      ('day video premium', 'contains', v_day, 'premium',  0.95, 'seed'),
      ('premium day video', 'contains', v_day, 'premium',  0.95, 'seed'),
      ('day video+',        'contains', v_day, 'premium',  0.95, 'seed — "+" marker beats bare-tier fallback'),
      ('day video plus',    'contains', v_day, 'premium',  0.95, 'seed — "plus" marker beats bare-tier fallback'),
      ('day video prm',     'contains', v_day, 'premium',  0.95, 'seed — "prm" marker beats bare-tier fallback'),
      ('day video',         'contains', v_day, 'standard', 0.95, 'seed'),
      ('video day',         'contains', v_day, 'standard', 0.85, 'seed: word-order variant'),
      ('daytime video',     'contains', v_day, 'standard', 0.82, 'seed');
  END IF;

  -- ── Dusk Video ─────────────────────────────────────────────────────────
  IF v_dusk IS NOT NULL THEN
    INSERT INTO legacy_package_aliases (alias_pattern, match_mode, canonical_package_id, canonical_tier, confidence, notes) VALUES
      ('dusk video premium','contains', v_dusk, 'premium',  0.95, 'seed'),
      ('premium dusk video','contains', v_dusk, 'premium',  0.95, 'seed'),
      ('dusk video+',       'contains', v_dusk, 'premium',  0.95, 'seed — "+" marker beats bare-tier fallback'),
      ('dusk video plus',   'contains', v_dusk, 'premium',  0.95, 'seed — "plus" marker beats bare-tier fallback'),
      ('dusk video prm',    'contains', v_dusk, 'premium',  0.95, 'seed — "prm" marker beats bare-tier fallback'),
      ('dusk video',        'contains', v_dusk, 'standard', 0.95, 'seed'),
      ('video dusk',        'contains', v_dusk, 'standard', 0.85, 'seed: word-order variant'),
      ('twilight video',    'contains', v_dusk, 'standard', 0.80, 'seed'),
      ('sunset video',      'contains', v_dusk, 'standard', 0.75, 'seed'),
      ('dusk images',       'contains', v_dusk, 'standard', 0.60, 'seed: covers Dusk Video AND AI — lower confidence so tier/keyword match wins');
  END IF;

  -- ── Flex (no standard tier) ────────────────────────────────────────────
  IF v_flex IS NOT NULL THEN
    INSERT INTO legacy_package_aliases (alias_pattern, match_mode, canonical_package_id, canonical_tier, confidence, notes) VALUES
      ('flex package',      'contains', v_flex, 'premium', 0.95, 'seed'),
      ('flex video',        'contains', v_flex, 'premium', 0.92, 'seed'),
      ('flex premium',      'contains', v_flex, 'premium', 0.95, 'seed'),
      ('the flex',          'contains', v_flex, 'premium', 0.90, 'seed'),
      ('photography full',  'contains', v_flex, 'premium', 0.80, 'seed: "Photography Full Suite" = flex in practice'),
      ('full suite',        'contains', v_flex, 'premium', 0.78, 'seed'),
      ('everything pack',   'contains', v_flex, 'premium', 0.75, 'seed'),
      ('complete pack',     'contains', v_flex, 'premium', 0.72, 'seed'),
      ('ultimate',          'contains', v_flex, 'premium', 0.70, 'seed');
  END IF;
END $$;

-- ── Normalisation helper ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION legacy_pkg_normalize(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    lower(trim(coalesce(p_input, ''))),
    '\s+', ' ', 'g'
  );
$$;

-- ── Fuzzy single-row matcher ───────────────────────────────────────────────
-- Returns { package_id, package_name, tier, confidence, match_mode,
--           matched_alias }. Tries each strategy in order, keeps the
-- highest-scoring match.
--
-- IMPORTANT: 'contains' is biased towards *more specific* matches — we
-- pick the alias whose pattern is longest (most specific wins) to avoid
-- "silver" beating "silver premium" for a "premium silver pack" input.

CREATE OR REPLACE FUNCTION legacy_map_package(
  p_raw_name     text,
  p_source_hint  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_norm          text;
  v_pkg_id        uuid;
  v_tier          text;
  v_alias_pattern text;
  v_match_mode    text;
  v_score         numeric;
BEGIN
  v_norm := legacy_pkg_normalize(p_raw_name);

  IF v_norm IS NULL OR v_norm = '' THEN
    RETURN jsonb_build_object('package_id', NULL, 'confidence', 0);
  END IF;

  -- Walk all aliases, compute a per-row score + matched flag, pick
  -- the strongest. A single CTE with UNION ALL would work too but the
  -- SELECT-with-CASE-then-ORDER-BY form below keeps the scoring rules
  -- visible in one place.
  WITH scored AS (
    SELECT
      a.canonical_package_id,
      a.canonical_tier,
      a.alias_pattern,
      a.match_mode,
      a.confidence,
      CASE
        WHEN a.match_mode = 'exact' AND legacy_pkg_normalize(a.alias_pattern) = v_norm
          THEN 1.00
        WHEN a.match_mode = 'prefix' AND v_norm LIKE legacy_pkg_normalize(a.alias_pattern) || '%'
          THEN 0.90
        WHEN a.match_mode = 'contains' AND position(legacy_pkg_normalize(a.alias_pattern) IN v_norm) > 0
          THEN 0.85
        WHEN a.match_mode = 'regex' AND v_norm ~ a.alias_pattern
          THEN 0.80
        WHEN a.match_mode = 'fuzzy' AND similarity(v_norm, legacy_pkg_normalize(a.alias_pattern)) >= 0.4
          THEN similarity(v_norm, legacy_pkg_normalize(a.alias_pattern))
        ELSE NULL
      END AS raw_score,
      -- Tie-breaker: longer alias pattern is more specific
      length(legacy_pkg_normalize(a.alias_pattern)) AS pattern_len
    FROM legacy_package_aliases a
    WHERE p_source_hint IS NULL
       OR a.source_hint IS NULL
       OR a.source_hint = p_source_hint
  ),
  ranked AS (
    SELECT
      canonical_package_id, canonical_tier, alias_pattern, match_mode,
      -- Blend the per-alias authored confidence with the mode score.
      -- Multiply them: a 0.85 contains-match on a 0.95-confidence alias
      -- yields ~0.81. Clamp to [0,1].
      LEAST(1.0, GREATEST(0.0, raw_score * COALESCE(confidence, 0.9))) AS final_score,
      pattern_len
    FROM scored
    WHERE raw_score IS NOT NULL
  )
  SELECT canonical_package_id, canonical_tier, alias_pattern, match_mode, final_score
    INTO v_pkg_id, v_tier, v_alias_pattern, v_match_mode, v_score
    FROM ranked
   ORDER BY final_score DESC, pattern_len DESC
   LIMIT 1;

  IF v_pkg_id IS NULL THEN
    -- Fallback pass: fuzzy-match against the packages.name itself, no
    -- alias required. Lets brand-new catalog items match with zero
    -- seeding as long as trigram similarity clears 0.4.
    SELECT p.id, NULL::text, NULL::text, 'fuzzy', similarity(v_norm, legacy_pkg_normalize(p.name))
      INTO v_pkg_id, v_tier, v_alias_pattern, v_match_mode, v_score
      FROM packages p
     WHERE COALESCE(p.is_active, TRUE)
       AND similarity(v_norm, legacy_pkg_normalize(p.name)) >= 0.4
     ORDER BY similarity(v_norm, legacy_pkg_normalize(p.name)) DESC
     LIMIT 1;

    IF v_pkg_id IS NULL THEN
      RETURN jsonb_build_object('package_id', NULL, 'confidence', 0);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'package_id',    v_pkg_id,
    'package_name',  (SELECT name FROM packages WHERE id = v_pkg_id),
    'tier',          v_tier,
    'confidence',    round(v_score, 3),
    'match_mode',    v_match_mode,
    'matched_alias', v_alias_pattern
  );
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_map_package(text, text) TO authenticated, service_role;

-- ── Batch worker ───────────────────────────────────────────────────────────
-- Walks unmapped legacy_projects rows, calls legacy_map_package row-by-
-- row, writes results back. Returns {attempted, mapped, unmapped}.
--
-- Gracefully no-ops if legacy_projects doesn't exist yet (agent 1 hasn't
-- landed their migration). That lets us deploy the cron on day one.

CREATE OR REPLACE FUNCTION legacy_map_packages_batch(
  p_batch_id uuid DEFAULT NULL,
  p_limit    int  DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_attempted int := 0;
  v_mapped    int := 0;
  v_row       record;
  v_match     jsonb;
  v_has_table boolean;
  v_has_batch_col boolean;
  v_has_source_col boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
  ) INTO v_has_table;

  IF NOT v_has_table THEN
    RETURN jsonb_build_object(
      'attempted', 0,
      'mapped',    0,
      'unmapped',  0,
      'skipped_reason', 'legacy_projects table does not exist'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
      AND column_name = 'import_batch_id'
  ) INTO v_has_batch_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
      AND column_name = 'source'
  ) INTO v_has_source_col;

  -- Dynamic SELECT so we don't break if agent 1's table schema differs
  -- slightly (missing batch_id or source columns).
  FOR v_row IN EXECUTE format(
    'SELECT id, package_name_legacy%s%s
       FROM legacy_projects
      WHERE mapped_package_id IS NULL
        AND package_name_legacy IS NOT NULL
        AND package_name_legacy <> %L
        %s
      LIMIT %s',
    CASE WHEN v_has_batch_col  THEN ', import_batch_id AS batch_id' ELSE '' END,
    CASE WHEN v_has_source_col THEN ', source'   ELSE '' END,
    '',
    CASE WHEN p_batch_id IS NOT NULL AND v_has_batch_col
         THEN format('AND import_batch_id = %L', p_batch_id)
         ELSE '' END,
    p_limit
  )
  LOOP
    v_attempted := v_attempted + 1;

    v_match := legacy_map_package(
      v_row.package_name_legacy,
      CASE WHEN v_has_source_col THEN v_row.source ELSE NULL END
    );

    IF (v_match->>'package_id') IS NOT NULL THEN
      UPDATE legacy_projects
         SET mapped_package_id   = (v_match->>'package_id')::uuid,
             mapped_package_name = v_match->>'package_name',
             mapped_package_tier = v_match->>'tier',
             mapping_confidence  = (v_match->>'confidence')::numeric,
             mapping_source      = 'auto_fuzzy',
             mapped_at           = now()
       WHERE id = v_row.id;

      v_mapped := v_mapped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'attempted', v_attempted,
    'mapped',    v_mapped,
    'unmapped',  v_attempted - v_mapped
  );
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_map_packages_batch(uuid, int) TO authenticated, service_role;

-- ── Admin stats RPC (drives stat strip in UI) ──────────────────────────────

CREATE OR REPLACE FUNCTION legacy_package_mapping_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total       bigint := 0;
  v_mapped_auto bigint := 0;
  v_mapped_manual bigint := 0;
  v_unmapped    bigint := 0;
  v_ambiguous   bigint := 0;
  v_has_table   boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
  ) INTO v_has_table;

  IF NOT v_has_table THEN
    RETURN jsonb_build_object(
      'total', 0, 'mapped_auto', 0, 'mapped_manual', 0,
      'unmapped', 0, 'ambiguous', 0,
      'table_exists', false
    );
  END IF;

  EXECUTE $q$
    SELECT
      count(*),
      count(*) FILTER (WHERE mapping_source = 'auto_fuzzy'),
      count(*) FILTER (WHERE mapping_source IN ('manual','admin_confirmed')),
      count(*) FILTER (WHERE mapped_package_id IS NULL AND package_name_legacy IS NOT NULL),
      count(*) FILTER (WHERE mapping_confidence IS NOT NULL
                         AND mapping_confidence BETWEEN 0.4 AND 0.7)
    FROM legacy_projects
  $q$
  INTO v_total, v_mapped_auto, v_mapped_manual, v_unmapped, v_ambiguous;

  RETURN jsonb_build_object(
    'total',         v_total,
    'mapped_auto',   v_mapped_auto,
    'mapped_manual', v_mapped_manual,
    'unmapped',      v_unmapped,
    'ambiguous',     v_ambiguous,
    'table_exists',  true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_package_mapping_stats() TO authenticated, service_role;

-- ── Review-queue RPC ──────────────────────────────────────────────────────
-- Returns one row per DISTINCT raw package_name_legacy with the current
-- auto-suggestion + a count of how many legacy_projects share that
-- raw name. Drives the review table in the admin UI.
--
-- p_status: 'unmapped' | 'low_confidence' | 'auto' | 'manual' | 'all'

CREATE OR REPLACE FUNCTION legacy_package_mapping_review(
  p_status   text DEFAULT 'unmapped',
  p_batch_id uuid DEFAULT NULL,
  p_search   text DEFAULT NULL,
  p_limit    int  DEFAULT 200,
  p_offset   int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_has_table boolean;
  v_has_batch boolean;
  v_has_source boolean;
  v_sql       text;
  v_where     text := 'WHERE package_name_legacy IS NOT NULL';
  v_result    jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
  ) INTO v_has_table;

  IF NOT v_has_table THEN
    RETURN jsonb_build_object('rows', '[]'::jsonb, 'table_exists', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
      AND column_name = 'import_batch_id'
  ) INTO v_has_batch;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
      AND column_name = 'source'
  ) INTO v_has_source;

  IF p_status = 'unmapped' THEN
    v_where := v_where || ' AND mapped_package_id IS NULL';
  ELSIF p_status = 'low_confidence' THEN
    v_where := v_where || ' AND mapping_confidence IS NOT NULL AND mapping_confidence < 0.7';
  ELSIF p_status = 'auto' THEN
    v_where := v_where || ' AND mapping_source = ''auto_fuzzy''';
  ELSIF p_status = 'manual' THEN
    v_where := v_where || ' AND mapping_source IN (''manual'',''admin_confirmed'')';
  END IF;

  IF p_batch_id IS NOT NULL AND v_has_batch THEN
    v_where := v_where || format(' AND import_batch_id = %L', p_batch_id);
  END IF;

  IF p_search IS NOT NULL AND length(trim(p_search)) > 0 THEN
    v_where := v_where || format(' AND lower(package_name_legacy) LIKE %L',
      '%' || lower(trim(p_search)) || '%');
  END IF;

  v_sql := format($q$
    WITH grouped AS (
      SELECT
        package_name_legacy                                     AS raw_name,
        count(*)                                                AS row_count,
        max(mapped_package_id::text)::uuid                      AS sample_mapped_pkg_id,
        max(mapped_package_name)                                AS sample_mapped_pkg_name,
        max(mapped_package_tier)                                AS sample_mapped_tier,
        avg(mapping_confidence)                                 AS avg_confidence,
        max(mapping_source)                                     AS sample_source,
        %s
        %s
        min(mapped_at)                                          AS first_mapped_at
      FROM legacy_projects
      %s
      GROUP BY package_name_legacy
      ORDER BY count(*) DESC, package_name_legacy
      LIMIT %s OFFSET %s
    )
    SELECT jsonb_agg(jsonb_build_object(
      'raw_name',               raw_name,
      'row_count',              row_count,
      'mapped_package_id',      sample_mapped_pkg_id,
      'mapped_package_name',    sample_mapped_pkg_name,
      'mapped_package_tier',    sample_mapped_tier,
      'confidence',             avg_confidence,
      'mapping_source',         sample_source,
      'batch_ids',              COALESCE(batch_id_list, '[]'::jsonb),
      'sources',                COALESCE(source_list,   '[]'::jsonb),
      'first_mapped_at',        first_mapped_at
    ))
    FROM grouped
  $q$,
    CASE WHEN v_has_batch
         THEN 'to_jsonb(array_agg(DISTINCT import_batch_id)) AS batch_id_list,'
         ELSE 'NULL::jsonb AS batch_id_list,' END,
    CASE WHEN v_has_source
         THEN 'to_jsonb(array_agg(DISTINCT source)) AS source_list,'
         ELSE 'NULL::jsonb AS source_list,' END,
    v_where,
    p_limit, p_offset
  );

  EXECUTE v_sql INTO v_result;

  RETURN jsonb_build_object(
    'rows',         COALESCE(v_result, '[]'::jsonb),
    'table_exists', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_package_mapping_review(text, uuid, text, int, int) TO authenticated, service_role;

-- ── Manual override helper ────────────────────────────────────────────────
-- Applies a user-chosen mapping to every legacy_projects row sharing the
-- same raw package name. If p_create_alias is true, also inserts a
-- permanent alias rule so future imports match automatically.

CREATE OR REPLACE FUNCTION legacy_package_apply_override(
  p_raw_name        text,
  p_package_id      uuid,
  p_tier            text DEFAULT NULL,
  p_create_alias    boolean DEFAULT true,
  p_source_hint     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated   int := 0;
  v_pkg_name  text;
  v_alias_id  uuid;
  v_has_table boolean;
BEGIN
  IF p_raw_name IS NULL OR trim(p_raw_name) = '' THEN
    RETURN jsonb_build_object('error', 'raw_name required');
  END IF;
  IF p_package_id IS NULL THEN
    RETURN jsonb_build_object('error', 'package_id required');
  END IF;

  SELECT name INTO v_pkg_name FROM packages WHERE id = p_package_id;
  IF v_pkg_name IS NULL THEN
    RETURN jsonb_build_object('error', 'package not found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'legacy_projects'
  ) INTO v_has_table;

  IF v_has_table THEN
    UPDATE legacy_projects
       SET mapped_package_id   = p_package_id,
           mapped_package_name = v_pkg_name,
           mapped_package_tier = p_tier,
           mapping_confidence  = 1.0,
           mapping_source      = 'admin_confirmed',
           mapped_at           = now()
     WHERE package_name_legacy = p_raw_name;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  IF p_create_alias THEN
    INSERT INTO legacy_package_aliases
      (alias_pattern, match_mode, canonical_package_id, canonical_tier,
       confidence, source_hint, notes, created_by)
    VALUES
      (legacy_pkg_normalize(p_raw_name), 'exact', p_package_id, p_tier,
       1.0, p_source_hint, 'admin-confirmed override', auth.uid())
    RETURNING id INTO v_alias_id;
  END IF;

  RETURN jsonb_build_object(
    'updated_rows', v_updated,
    'alias_id',     v_alias_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_package_apply_override(text, uuid, text, boolean, text) TO authenticated, service_role;

COMMIT;
