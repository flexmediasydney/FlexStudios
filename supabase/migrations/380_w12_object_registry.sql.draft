-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 380 — Wave 12: canonical object/attribute registry foundation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W12-object-attribute-registry.md
--       docs/design-specs/W12-trigger-thresholds.md
--       docs/design-specs/W11-7-unified-shortlisting-architecture.md (§"Canonical registry")
--
-- ─── WHY THIS WAVE EXISTS ─────────────────────────────────────────────────────
--
-- The shortlisting engine emits per-image classifications with free-text
-- `key_elements TEXT[]` like "white shaker-style cabinet doors" and
-- "variegated red-brown brick veneer". Today these strings are unstructured
-- text — there is no canonical vocabulary, no cross-shoot frequency table,
-- no way to ask "how often do we see Caesarstone benchtops in $3M+ Mosman
-- properties" without scanning every analysis paragraph in every round.
--
-- W12 lifts these free-text observations into a normalised registry. Each
-- Stage 1 emits raw observations into `raw_attribute_observations`; the
-- canonical-rollup batch (manual-trigger per Joseph 2026-04-27, same pattern
-- as W13a/W13b) embeds + cosine-matches them against `object_registry`. High
-- similarity → auto-normalise. Mid → discovery queue for human review. Low →
-- new observation for clustering.
--
-- The registry compounds: every shoot enriches it; every enrichment improves
-- Stage 1's grounding via the canonical-feature-registry prompt block; better
-- grounding produces better Stage 4 master synthesis; better masters produce
-- richer training_examples. This is the institutional-memory substrate.
--
-- ─── DESIGN DECISIONS DOCUMENTED HERE ─────────────────────────────────────────
--
-- 1. **5-level hierarchy** (level_0_class → level_4_detail). The original spec
--    proposed a flat registry; the dispatch directive escalates to a 5-level
--    decomposition because it lets the studio answer queries at any depth:
--      level_0_class:       'kitchen' | 'bathroom' | 'living' | 'exterior' | ...
--      level_1_functional:  'benchtop' | 'cabinetry' | 'tap' | 'rangehood' | ...
--      level_2_material:    'stone' | 'shaker_cabinetry' | 'gooseneck' | ...
--      level_3_specific:    'marble' | 'white_shaker' | 'chrome_gooseneck' | ...
--      level_4_detail:      'calacatta_waterfall' | 'shaker_panel_white' | ...
--    Plus an explicit `parent_canonical_id` link for navigating the tree
--    bottom-up. NULLs at deeper levels are fine — a row at level_2 simply has
--    NULL at levels 3/4. Queries like "all stone benchtops" filter on
--    level_2_material='stone' AND level_1_functional='benchtop'.
--
-- 2. **pgvector at native dim 1536** for `embedding_vector`. The spec's R3
--    resolution stands: native dim avoids PCA edge-fn complexity, preserves
--    similarity precision at the 0.92 / 0.75 thresholds, and 6KB/row at the
--    seed scale (~200) is 1.2MB — trivial. HNSW index for sub-millisecond
--    cosine lookup at production scale. We pick HNSW (not IVFFlat) because:
--      - Build-once cost; no need to rebuild as the tree grows
--      - Better recall for low-cardinality registries (≤10k rows)
--      - Simpler maintenance (no list-count tuning)
--
-- 3. **Aliases as TEXT[] on the canonical row, not a separate synonym table.**
--    Synonyms emerge naturally from normalisation; storing them inline keeps
--    queries simple ("array_contains(aliases, 'caesarstone')"). When an alias
--    accumulates enough independent observations, it can be promoted to a
--    canonical of its own and the parent's aliases list is updated. We avoid
--    a separate synonym graph table until evidence demands one.
--
-- 4. **`signal_room_type` + `signal_confidence`** for objects that strongly
--    signal a specific room_type. e.g. 'hills_hoist' → exterior_rear, 0.92.
--    The Stage 1 prompt block surfaces these as evidence anchors so the model
--    classifies room_type more consistently. Empty for objects that don't
--    signal a room type ('door_handle', 'wall_paint').
--
-- 5. **`raw_attribute_observations` keyed by (round_id, group_id, raw_label)**
--    with a UNIQUE partial index for round-sourced observations and a separate
--    one for pulse-sourced. Same idempotency story as the spec: re-running
--    the canonical-rollup is safe.
--
-- 6. **`market_frequency` is denormalised** on object_registry, bumped by the
--    canonical-rollup edge fn each time an observation auto-normalises into
--    a row. Indexed DESC for the Stage 1 prompt's "top 200 by frequency" query.
--
-- 7. **Manual-trigger only.** No pg_cron blocks in this migration. Joseph
--    fires the canonical-rollup edge fn when he wants observations processed.
--    Same pattern as W13a/W13b. The `archive_at` column on candidates is a
--    timestamp set at insert time; the auto-archive sweep is also a manual
--    edge-fn invocation, not a cron.
--
-- 8. **RLS:** master_admin SELECT/UPDATE; admin SELECT; service-role bypass
--    via SUPABASE_SERVICE_ROLE_KEY. Same pattern as mig 371.
--
-- ─── WHAT SHIPS HERE ──────────────────────────────────────────────────────────
--   1. pgvector extension (CREATE EXTENSION IF NOT EXISTS vector)
--   2. object_registry              (canonical objects with 5-level hierarchy + embedding)
--   3. raw_attribute_observations   (per-observation log; source-aware)
--   4. attribute_values             (object-keyed attribute key/value pairs)
--   5. object_registry_candidates   (discovery queue)
--   6. RLS policies (master_admin/admin SELECT; master_admin UPDATE; service-role bypass)
--   7. Indexes (status partial, market_frequency DESC, vector HNSW, hierarchy lookups)
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 0. pgvector extension ───────────────────────────────────────────────────
-- Required for VECTOR(1536) columns + HNSW similarity index.
-- Idempotent: CREATE EXTENSION IF NOT EXISTS is a no-op when already installed.
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── 1. object_registry ──────────────────────────────────────────────────────
-- Canonical objects observed across compositions. 5-level hierarchy +
-- explicit parent linkage + aliases for free-text variants + embedding for
-- similarity search.

CREATE TABLE IF NOT EXISTS object_registry (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical key (snake_case, lowercase, no spaces). Globally unique.
  -- e.g. 'obj_kitchen_island_marble_waterfall'
  canonical_id            TEXT UNIQUE NOT NULL,

  -- Human-readable label for UI display.
  -- e.g. 'Marble Waterfall Kitchen Island'
  display_name            TEXT NOT NULL,

  -- Optional short prose definition shown in admin UIs.
  description             TEXT,

  -- 5-level hierarchy. NULL at deeper levels is fine — a row that only goes
  -- to level_2 leaves levels 3/4 NULL.
  level_0_class           TEXT,                   -- 'kitchen' | 'bathroom' | 'living' | 'exterior' | ...
  level_1_functional      TEXT,                   -- 'benchtop' | 'tap' | 'cabinetry' | 'rangehood' | ...
  level_2_material        TEXT,                   -- 'stone' | 'shaker_cabinetry' | 'gooseneck' | ...
  level_3_specific        TEXT,                   -- 'marble' | 'white_shaker' | 'chrome_gooseneck' | ...
  level_4_detail          TEXT,                   -- 'calacatta_waterfall' | ...

  -- Explicit parent linkage. Rows at deeper levels point at their immediate
  -- parent — e.g. 'obj_kitchen_island_marble_waterfall' may point at
  -- 'obj_kitchen_island' as its parent. NULL means the row is itself a root.
  parent_canonical_id     UUID REFERENCES object_registry(id) ON DELETE SET NULL,

  -- Free-text variants observed in raw labels — used by the rollup as a
  -- secondary match signal alongside cosine similarity.
  -- e.g. ['caesarstone island', 'engineered stone bench', 'stone benchtop']
  aliases                 TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- pgvector embedding (Gemini text-embedding-004 native dim 1536).
  -- NULL is allowed — bootstrap rows may be inserted before embedding pipeline
  -- runs; the canonical-rollup fn populates NULL embeddings on demand.
  embedding_vector        VECTOR(1536),

  -- Denormalised observation count across all rounds + pulse + finals.
  -- Bumped by the canonical-rollup edge fn each time an observation
  -- auto-normalises to this row.
  market_frequency        INTEGER NOT NULL DEFAULT 0,

  -- When this object strongly signals a specific room_type, populate these.
  -- e.g. 'hills_hoist' → signal_room_type='exterior_rear', signal_confidence=0.92.
  -- The Stage 1 prompt block surfaces these as room-type evidence anchors.
  signal_room_type        TEXT,
  signal_confidence       NUMERIC(4,3),

  -- Lifecycle: 'canonical' = active; 'deprecated' = retired (audit only);
  -- 'merged' = absorbed into another canonical (provenance kept).
  status                  TEXT NOT NULL DEFAULT 'canonical'
                            CHECK (status IN ('canonical', 'deprecated', 'merged')),
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  merged_into_id          UUID REFERENCES object_registry(id) ON DELETE SET NULL,

  -- Audit trail.
  created_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  curated_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  curated_at              TIMESTAMPTZ,
  first_observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE object_registry IS
  'Wave 12: canonical objects observed across property compositions. 5-level hierarchy (level_0_class → level_4_detail) + parent_canonical_id for tree traversal. embedding_vector (Gemini text-embedding-004 native 1536) drives the canonical-rollup similarity match. market_frequency bumped by rollup; top 200 by frequency feed the Stage 1 prompt''s canonical-feature-registry block.';

COMMENT ON COLUMN object_registry.canonical_id IS
  'Snake_case unique key (e.g. obj_kitchen_island_marble_waterfall). Stable across migrations. Used by canonical_object_ids[] in composition_classifications when rollup writes back.';
COMMENT ON COLUMN object_registry.aliases IS
  'Free-text variants observed in raw labels (e.g. [''caesarstone island'', ''stone benchtop'']). Secondary match signal alongside cosine similarity in the rollup.';
COMMENT ON COLUMN object_registry.signal_room_type IS
  'When set, this object strongly signals a specific room_type. Stage 1 prompt surfaces (object, signal_room_type, signal_confidence) trios as evidence anchors.';
COMMENT ON COLUMN object_registry.market_frequency IS
  'Denormalised count of auto-normalised raw_attribute_observations pointing at this row. Indexed DESC for the Stage 1 top-200 query.';

-- Indexes ────────────────────────────────────────────────────────────────────
-- Active row partial index (most queries filter on this).
CREATE INDEX IF NOT EXISTS idx_object_registry_active
  ON object_registry(canonical_id) WHERE status = 'canonical' AND is_active = TRUE;

-- Top-N by market_frequency (Stage 1 prompt's "top 200 by frequency").
CREATE INDEX IF NOT EXISTS idx_object_registry_freq
  ON object_registry(market_frequency DESC) WHERE status = 'canonical' AND is_active = TRUE;

-- Hierarchy lookups (WHERE level_0_class='kitchen' AND level_1_functional='benchtop').
CREATE INDEX IF NOT EXISTS idx_object_registry_level_0
  ON object_registry(level_0_class) WHERE status = 'canonical' AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_object_registry_level_0_1
  ON object_registry(level_0_class, level_1_functional) WHERE status = 'canonical' AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_object_registry_parent
  ON object_registry(parent_canonical_id) WHERE parent_canonical_id IS NOT NULL;

-- Signal lookup (WHERE signal_room_type IS NOT NULL for the prompt block).
CREATE INDEX IF NOT EXISTS idx_object_registry_signal
  ON object_registry(signal_room_type, signal_confidence DESC)
  WHERE signal_room_type IS NOT NULL AND status = 'canonical' AND is_active = TRUE;

-- pgvector HNSW index for cosine similarity search.
-- Parameters: m=16 (default), ef_construction=64 (default). Tuned for ≤10k
-- rows; if registry grows past 100k a rebuild with higher ef_construction
-- may be warranted but that's a follow-up wave concern.
CREATE INDEX IF NOT EXISTS idx_object_registry_embedding
  ON object_registry USING hnsw (embedding_vector vector_cosine_ops)
  WHERE embedding_vector IS NOT NULL AND status = 'canonical' AND is_active = TRUE;

-- Aliases GIN for fast 'has-alias' queries.
CREATE INDEX IF NOT EXISTS idx_object_registry_aliases
  ON object_registry USING gin(aliases);

-- ─── 2. raw_attribute_observations ───────────────────────────────────────────
-- Per-observation log of "model emitted X for round Y group Z, raw text was Z".
-- Source-aware (internal_raw, internal_finals, pulse_listing, pulse_floorplan)
-- so the registry can answer cross-source frequency questions.

CREATE TABLE IF NOT EXISTS raw_attribute_observations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source FKs (exactly one of round_id or pulse_listing_id is non-NULL).
  round_id                    UUID REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  group_id                    UUID REFERENCES composition_groups(id) ON DELETE CASCADE,
  pulse_listing_id            UUID REFERENCES pulse_listings(id) ON DELETE SET NULL,

  -- The free-text label as the model wrote it.
  -- e.g. 'designer Caesarstone island bench'
  raw_label                   TEXT NOT NULL,

  -- Embedding of the raw label (Gemini text-embedding-004 native 1536).
  -- Computed at insert time by the canonical-rollup edge fn (or null if the
  -- observation was inserted by an upstream extractor that doesn't embed).
  raw_label_embedding         VECTOR(1536),

  -- After rollup, points at the auto-normalised canonical (if cosine ≥ 0.92).
  normalised_to_object_id     UUID REFERENCES object_registry(id) ON DELETE SET NULL,
  normalised_at               TIMESTAMPTZ,
  similarity_score            NUMERIC(5,4),

  -- Model's confidence on this observation at extraction time (0-1).
  confidence                  NUMERIC(4,3),

  -- Source taxonomy (drives filter in the rollup edge fn's source_type_filter param).
  source_type                 TEXT NOT NULL
                                CHECK (source_type IN ('internal_raw', 'internal_finals', 'pulse_listing', 'pulse_floorplan', 'manual_seed')),

  -- The sentence/paragraph the observation was drawn from (for audit + UI).
  source_excerpt              TEXT,

  -- Model's attribute hints attached to this observation (key/value pairs).
  -- e.g. {"material": "caesarstone", "edge_style": "waterfall"}
  -- Resolved into attribute_values rows by the canonical-rollup edge fn.
  attributes                  JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly one of round_id / pulse_listing_id must be populated (or NEITHER
  -- when source_type='manual_seed' — admin pre-populates without a real source).
  CONSTRAINT raw_obs_source_consistency CHECK (
    (source_type = 'manual_seed') OR
    ((round_id IS NOT NULL) <> (pulse_listing_id IS NOT NULL))
  )
);

COMMENT ON TABLE raw_attribute_observations IS
  'Wave 12: per-observation log of free-text labels emitted by Stage 1 / pulse extractor / finals importer. raw_label_embedding computed at extraction time prevents re-embedding at every rollup pass. normalised_to_object_id points at the canonical after the rollup batch processes the row.';

-- Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_raw_obs_pending
  ON raw_attribute_observations(created_at)
  WHERE normalised_to_object_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_object
  ON raw_attribute_observations(normalised_to_object_id)
  WHERE normalised_to_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_round
  ON raw_attribute_observations(round_id) WHERE round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_group
  ON raw_attribute_observations(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_pulse
  ON raw_attribute_observations(pulse_listing_id) WHERE pulse_listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_source_type
  ON raw_attribute_observations(source_type, created_at DESC);

-- Idempotency: same (round_id, group_id, raw_label) is a no-op re-insert
-- (UPSERT target). Without this, a re-trigger of the rollup against the same
-- round would create duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_obs_round_group_label
  ON raw_attribute_observations(round_id, group_id, raw_label)
  WHERE round_id IS NOT NULL AND group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_obs_pulse_label
  ON raw_attribute_observations(pulse_listing_id, raw_label)
  WHERE pulse_listing_id IS NOT NULL;

-- ─── 3. attribute_values ─────────────────────────────────────────────────────
-- Object-keyed attribute key/value pairs. e.g. (kitchen_island, 'edge_style', 'waterfall').

CREATE TABLE IF NOT EXISTS attribute_values (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id               UUID NOT NULL REFERENCES object_registry(id) ON DELETE CASCADE,
  attribute_key           TEXT NOT NULL,         -- 'edge_style', 'material', 'colour', 'finish'
  value_text              TEXT NOT NULL,         -- 'waterfall', 'caesarstone', 'matte_black'
  value_embedding         VECTOR(1536),

  -- Bumped each time the rollup auto-resolves an observation to this row.
  observation_count       INTEGER NOT NULL DEFAULT 0,

  status                  TEXT NOT NULL DEFAULT 'canonical'
                            CHECK (status IN ('canonical', 'deprecated', 'merged')),
  merged_into_id          UUID REFERENCES attribute_values(id) ON DELETE SET NULL,

  first_observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (object_id, attribute_key, value_text)
);

COMMENT ON TABLE attribute_values IS
  'Wave 12: attribute key/value pairs anchored to object_registry. (object_id, attribute_key, value_text) is the natural identity. observation_count drives the discovery UI''s frequent-attributes view.';

CREATE INDEX IF NOT EXISTS idx_attr_values_object
  ON attribute_values(object_id) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_attr_values_key
  ON attribute_values(attribute_key) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_attr_values_freq
  ON attribute_values(object_id, observation_count DESC) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_attr_values_embedding
  ON attribute_values USING hnsw (value_embedding vector_cosine_ops)
  WHERE value_embedding IS NOT NULL AND status = 'canonical';

-- ─── 4. object_registry_candidates ───────────────────────────────────────────
-- Discovery queue. Holds proposed canonical objects + attribute values that
-- the canonical-rollup batch couldn't auto-resolve (cosine 0.75-0.92 = ambiguous;
-- < 0.75 = potential new). Master_admin reviews via the object-registry-admin
-- edge fn; UI lives in Settings → Engine → Object Registry → Discovery Queue.

CREATE TABLE IF NOT EXISTS object_registry_candidates (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_type              TEXT NOT NULL
                                CHECK (candidate_type IN ('object', 'attribute_value')),

  -- Proposed canonical key. For attribute candidates, format is "key:value".
  proposed_canonical_label    TEXT NOT NULL,
  proposed_display_name       TEXT,
  proposed_description        TEXT,

  -- For object candidates: hierarchy hints (admin can edit on approval).
  proposed_level_0_class      TEXT,
  proposed_level_1_functional TEXT,
  proposed_level_2_material   TEXT,
  proposed_level_3_specific   TEXT,
  proposed_level_4_detail     TEXT,

  -- For attribute candidates: parent object + key/value.
  proposed_object_id          UUID REFERENCES object_registry(id) ON DELETE CASCADE,
  proposed_attribute_key      TEXT,
  proposed_value_text         TEXT,

  -- Embedding of the proposed label (used by 'merge_candidates' to surface
  -- duplicates among pending candidates).
  candidate_embedding         VECTOR(1536),

  -- Similarity context surfaced to the reviewer.
  similarity_to_existing      JSONB,

  -- Observation accumulation.
  observed_count              INTEGER NOT NULL DEFAULT 1,
  sample_observation_ids      UUID[],
  sample_excerpts             TEXT[],

  -- Workflow.
  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'auto_archived', 'deferred')),
  reviewed_by                 UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at                 TIMESTAMPTZ,
  reviewer_notes              TEXT,
  approved_object_id          UUID REFERENCES object_registry(id) ON DELETE SET NULL,
  approved_attribute_value_id UUID REFERENCES attribute_values(id) ON DELETE SET NULL,
  merged_into_object_id       UUID REFERENCES object_registry(id) ON DELETE SET NULL,
  merged_into_attribute_value_id UUID REFERENCES attribute_values(id) ON DELETE SET NULL,

  -- Auto-archive timestamp. Set at insert (first_proposed_at + 14 days). The
  -- archive sweep is a manual edge-fn invocation, NOT a cron.
  first_proposed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_proposed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  review_after_at             TIMESTAMPTZ,                                 -- defer pushes this forward
  archive_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE object_registry_candidates IS
  'Wave 12: discovery queue for candidates flagged by the canonical-rollup batch. Object candidates: cosine 0.75-0.92 against object_registry (ambiguous synonym?). Attribute candidates: similar pattern against attribute_values keyed by the parent object_id. Reviewed via object-registry-admin edge fn.';

-- Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_candidates_pending
  ON object_registry_candidates(observed_count DESC, last_proposed_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_candidates_archive_due
  ON object_registry_candidates(archive_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_candidates_review_after
  ON object_registry_candidates(review_after_at)
  WHERE status = 'deferred' AND review_after_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_type
  ON object_registry_candidates(candidate_type, status, observed_count DESC);

-- Unique partial indexes prevent duplicate proposals at the pending tier.
-- Object candidates: unique on (proposed_canonical_label) WHERE pending.
-- Attribute candidates: unique on (parent_object_id, key, value) WHERE pending.
-- The partial filter ensures that an archived candidate with the same label
-- doesn't block a new pending candidate from being created.
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_object_pending
  ON object_registry_candidates(proposed_canonical_label)
  WHERE candidate_type = 'object' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_attr_pending
  ON object_registry_candidates(proposed_object_id, proposed_attribute_key, proposed_value_text)
  WHERE candidate_type = 'attribute_value' AND status = 'pending';

-- ─── 5. updated_at triggers (idempotent) ─────────────────────────────────────
-- Reuse the existing `set_updated_at()` function (defined in earlier migrations)
-- if it exists; otherwise create a local one. This keeps mig 380 self-contained
-- but compatible with the project's existing trigger function naming.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'
  ) THEN
    EXECUTE $body$
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $f$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $f$ LANGUAGE plpgsql;
    $body$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_object_registry_updated_at ON object_registry;
CREATE TRIGGER trg_object_registry_updated_at
  BEFORE UPDATE ON object_registry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_attribute_values_updated_at ON attribute_values;
CREATE TRIGGER trg_attribute_values_updated_at
  BEFORE UPDATE ON attribute_values
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_candidates_updated_at ON object_registry_candidates;
CREATE TRIGGER trg_candidates_updated_at
  BEFORE UPDATE ON object_registry_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 6. RLS policies ─────────────────────────────────────────────────────────
-- Pattern (matching mig 371):
--   * SELECT: master_admin + admin (review UIs)
--   * UPDATE: master_admin only (curation actions)
--   * INSERT/DELETE: service-role only (edge fns bypass RLS via service key)
-- INSERT/DELETE policies are intentionally OMITTED — service-role bypasses
-- RLS, and authenticated users without an explicit policy are denied.

ALTER TABLE object_registry              ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_attribute_observations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_values             ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_registry_candidates   ENABLE ROW LEVEL SECURITY;

-- object_registry ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "object_registry_select_admin" ON object_registry;
CREATE POLICY "object_registry_select_admin"
  ON object_registry FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin', 'admin'));

DROP POLICY IF EXISTS "object_registry_update_master" ON object_registry;
CREATE POLICY "object_registry_update_master"
  ON object_registry FOR UPDATE TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

-- raw_attribute_observations ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "raw_obs_select_admin" ON raw_attribute_observations;
CREATE POLICY "raw_obs_select_admin"
  ON raw_attribute_observations FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin', 'admin'));

DROP POLICY IF EXISTS "raw_obs_update_master" ON raw_attribute_observations;
CREATE POLICY "raw_obs_update_master"
  ON raw_attribute_observations FOR UPDATE TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

-- attribute_values ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "attribute_values_select_admin" ON attribute_values;
CREATE POLICY "attribute_values_select_admin"
  ON attribute_values FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin', 'admin'));

DROP POLICY IF EXISTS "attribute_values_update_master" ON attribute_values;
CREATE POLICY "attribute_values_update_master"
  ON attribute_values FOR UPDATE TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

-- object_registry_candidates ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "candidates_select_admin" ON object_registry_candidates;
CREATE POLICY "candidates_select_admin"
  ON object_registry_candidates FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin', 'admin'));

DROP POLICY IF EXISTS "candidates_update_master" ON object_registry_candidates;
CREATE POLICY "candidates_update_master"
  ON object_registry_candidates FOR UPDATE TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

-- ─── 7. canonical_nearest_neighbors RPC ─────────────────────────────────────
-- pgvector cosine-similarity top-N helper. Wraps the `<=>` operator and
-- converts to similarity. Used by the canonical-rollup edge fn.

CREATE OR REPLACE FUNCTION canonical_nearest_neighbors(
  p_embedding TEXT,
  p_top_n     INTEGER DEFAULT 5
)
RETURNS TABLE (
  id                 UUID,
  canonical_id       TEXT,
  display_name       TEXT,
  similarity         NUMERIC,
  market_frequency   INTEGER,
  signal_room_type   TEXT,
  signal_confidence  NUMERIC,
  level_0_class      TEXT,
  level_1_functional TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $rpc$
  SELECT
    obj.id,
    obj.canonical_id,
    obj.display_name,
    (1 - (obj.embedding_vector <=> p_embedding::vector(1536)))::numeric AS similarity,
    obj.market_frequency,
    obj.signal_room_type,
    obj.signal_confidence,
    obj.level_0_class,
    obj.level_1_functional
  FROM object_registry obj
  WHERE obj.status = 'canonical'
    AND obj.is_active = TRUE
    AND obj.embedding_vector IS NOT NULL
  ORDER BY obj.embedding_vector <=> p_embedding::vector(1536)
  LIMIT GREATEST(p_top_n, 1);
$rpc$;

GRANT EXECUTE ON FUNCTION canonical_nearest_neighbors(TEXT, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION canonical_nearest_neighbors IS
  'Wave 12: pgvector cosine-similarity top-N nearest neighbors. Wraps the <=> operator and returns similarity (1 - distance). Used by canonical-rollup edge fn.';

-- ─── 8. PostgREST schema reload ──────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ──────────────────
--
-- DROP TABLE IF EXISTS object_registry_candidates;
-- DROP TABLE IF EXISTS attribute_values;
-- DROP TABLE IF EXISTS raw_attribute_observations;
-- DROP TABLE IF EXISTS object_registry;
-- (vector extension stays — harmless if no other tables use it)
