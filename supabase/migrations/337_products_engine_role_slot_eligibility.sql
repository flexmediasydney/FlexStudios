-- Wave 7 P1-8: products.engine_role + slot.eligible_when_engine_roles + backfill.
--
-- Replaces the brittle "string-match shortlisting_slot_definitions.package_types
-- against shortlisting_rounds.package_type" with a data-driven join through
-- the products table. Each shortlisting-relevant product gets an explicit
-- `engine_role` enum value; each slot definition declares which engine roles
-- it serves. The Pass 2 builder unions the project's package's products' roles
-- and filters slots by overlap.
--
-- Spec: docs/design-specs/W7-8-product-driven-slot-eligibility.md
--
-- Why TEXT not a DB enum?
--   Forward-compat. Marketing adds a new product category ("thermal_imaging",
--   "twilight_shortlist", whatever) without a schema migration. The frontend
--   constant + the Deno engine_role list give the canonical set; unknown
--   values are dropped at the resolver level (slotEligibility.ts) rather
--   than failing with a CHECK violation that requires emergency surgery.
--
-- Data quality note (orchestrator 2026-04-27):
--   Real packages today (e.g. "Day Video Package") embed products via the
--   `packages.products` JSONB column. Slot rows declared `package_types`
--   like ["Gold Package","Silver Package","Flex Package"] which don't
--   line up with current marketing labels. Audit defect #53 already added
--   a substring fallback in shortlisting-pass2's pkgMatches() to keep
--   things running. We DO NOT touch existing rows' package_types in this
--   migration — that fallback path stays alive during the engine-role
--   transition. Once every slot has a non-empty eligible_when_engine_roles
--   list and the orchestrator confirms zero rounds rely on the fallback,
--   a future subtractive migration can drop package_types entirely.
--
-- ─── Forward ────────────────────────────────────────────────────────────────

-- 1. products.engine_role
--    Nullable: addon products (Editing/Fees) and any product not relevant to
--    shortlisting carry NULL. The resolver treats NULL as "no engine impact".
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS engine_role TEXT;

COMMENT ON COLUMN products.engine_role IS
  'Wave 7 P1-8: which shortlisting engine role this product triggers. NULL = no engine impact (Editing/Fees addons). Known values: photo_day_shortlist, photo_dusk_shortlist, drone_shortlist, floorplan_qa, video_day_shortlist, video_dusk_shortlist, agent_portraits. Stored as TEXT (no DB enum) for forward-compat with new product categories.';

-- 2. shortlisting_slot_definitions.eligible_when_engine_roles
--    NOT NULL with default '{}' so the resolver can distinguish "I''ve been
--    backfilled to no engine roles" (impossible to match → drop) from "the
--    column wasn''t backfilled" (impossible — DEFAULT covers it). Empty array
--    semantically means "no engine-role constraint expressed; fall back to
--    package_types".
ALTER TABLE shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS eligible_when_engine_roles TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN shortlisting_slot_definitions.eligible_when_engine_roles IS
  'Wave 7 P1-8: array of engine_role values this slot is eligible for. Resolver (slotEligibility.ts) filters slots where the array overlaps the project''s union of products.engine_role. Empty array means "no engine-role rule; fall back to package_types substring match" (legacy slots during the migration window).';

-- 3. Backfill products.engine_role.
--    Rules per the design spec, applied only where engine_role IS NULL so a
--    re-run is idempotent. Rules:
--      - Agent portraits FIRST (name-based) so they don''t fall into the
--        category=Images bucket below.
--      - Then category-based rules.
--    `category` is case-sensitive in production seed data ("Images", "Drones",
--    "Floorplan", "Video", "Editing", "Fees"). We add lower-case fallbacks
--    in case the column gets renormalised in the future, but the canonical
--    values are the title-cased ones.
UPDATE products
SET engine_role = CASE
  -- Agent portraits (name-based) — match BEFORE the generic Images rule.
  WHEN name ILIKE '%agent%portrait%'
    OR name ILIKE '%individual%portrait%'
    OR name ILIKE '%team%portrait%'
    OR name ILIKE '%headshot%' THEN 'agent_portraits'

  -- Photo (Images category)
  WHEN category IN ('Images', 'images') AND COALESCE(dusk_only, false) = false THEN 'photo_day_shortlist'
  WHEN category IN ('Images', 'images') AND COALESCE(dusk_only, false) = true  THEN 'photo_dusk_shortlist'

  -- Drones
  WHEN category IN ('Drones', 'drones', 'Drone', 'drone') THEN 'drone_shortlist'

  -- Floorplan (consumed by the QA tab, not a slot)
  WHEN category IN ('Floorplan', 'floorplan') THEN 'floorplan_qa'

  -- Video
  WHEN category IN ('Video', 'video') AND COALESCE(dusk_only, false) = false THEN 'video_day_shortlist'
  WHEN category IN ('Video', 'video') AND COALESCE(dusk_only, false) = true  THEN 'video_dusk_shortlist'

  -- Editing + Fees + everything else → NULL (no engine impact)
  ELSE NULL
END
WHERE engine_role IS NULL;

-- 4. Backfill shortlisting_slot_definitions.eligible_when_engine_roles.
--    Conservative default per the orchestrator's brief: every existing slot
--    gets ['photo_day_shortlist', 'photo_dusk_shortlist'] unless its slot_id
--    or display_name unambiguously says drone / agent_portraits. We DO NOT
--    try to be clever about the difference between day-only vs dusk-only
--    slots — the Pass 2 resolver still respects the existing package_types
--    fallback, so over-provisioning slots here doesn't break behaviour. The
--    audit comment block below catalogues every row so a human can tighten
--    the mapping in a follow-up migration.
UPDATE shortlisting_slot_definitions
SET eligible_when_engine_roles = CASE
  -- Drone slots (slot_id starts with drone_).
  WHEN slot_id LIKE 'drone_%'
    OR display_name ILIKE '%drone%'
    THEN ARRAY['drone_shortlist']::text[]

  -- Floorplan slots (if any exist — orchestrator says floorplan_qa is a
  -- TAB not a slot; this is defensive in case a stray row exists).
  WHEN slot_id LIKE 'floorplan%'
    OR display_name ILIKE '%floorplan%'
    THEN ARRAY['floorplan_qa']::text[]

  -- Video slots (slot_id starts with video_).
  WHEN slot_id LIKE 'video_%'
    OR display_name ILIKE '%video%'
    THEN ARRAY['video_day_shortlist', 'video_dusk_shortlist']::text[]

  -- Agent portrait slots (name-based).
  WHEN display_name ILIKE '%headshot%'
    OR display_name ILIKE '%agent%portrait%'
    THEN ARRAY['agent_portraits']::text[]

  -- Conservative default: every other photo slot is eligible for either
  -- day or dusk products. Pass 2's package_types fallback will narrow further.
  ELSE ARRAY['photo_day_shortlist', 'photo_dusk_shortlist']::text[]
END
WHERE eligible_when_engine_roles = '{}'::text[]
  OR eligible_when_engine_roles IS NULL;

-- 5. Index for the array-overlap lookup the engine does on every Pass 2 run.
--    GIN supports `&&` (overlap) on TEXT[]. Partial index on is_active=true
--    cuts the index size — Pass 2 only ever queries active rows.
CREATE INDEX IF NOT EXISTS idx_slot_defs_eligible_when_engine_roles_gin
  ON shortlisting_slot_definitions USING GIN (eligible_when_engine_roles)
  WHERE is_active = true;

-- 6. Lighter B-tree index on products.engine_role for the per-round product
--    lookup (the round resolver does `WHERE id = ANY($1) AND is_active=true`
--    and reads engine_role; B-tree on engine_role itself isn't on the hot
--    path, but a partial index on is_active speeds the resolver's filter).
CREATE INDEX IF NOT EXISTS idx_products_active_engine_role
  ON products (engine_role)
  WHERE is_active = true AND engine_role IS NOT NULL;

-- 7. Widen shortlisting_quarantine.reason CHECK to admit two new values:
--      'out_of_scope'         — Pass 0 has been emitting this since seed but
--                               the original CHECK in mig 283 only allowed
--                               agent_headshot/test_shot/bts/other. This is
--                               a latent bug discovered during W7.8 review
--                               (Pass 0 INSERTs would 23514 today).
--      'out_of_scope_content' — Wave 7 P1-8: emitted when Pass 0 detects
--                               content that doesn't match any product
--                               engine_role on the round's package (warn
--                               policy — requires_human_review=true; do
--                               NOT auto-reject; editor decides).
--    Per Postgres semantics we drop the old CHECK and re-add a wider one.
ALTER TABLE shortlisting_quarantine
  DROP CONSTRAINT IF EXISTS shortlisting_quarantine_reason_check;
ALTER TABLE shortlisting_quarantine
  ADD CONSTRAINT shortlisting_quarantine_reason_check CHECK (reason IN (
    'agent_headshot',
    'test_shot',
    'bts',
    'other',
    'out_of_scope',
    'out_of_scope_content'
  ));

COMMENT ON CONSTRAINT shortlisting_quarantine_reason_check ON shortlisting_quarantine IS
  'Wave 7 P1-8: widened from the mig 283 list to also admit out_of_scope (Pass 0 hard-reject reason; was being emitted against a CHECK that excluded it) and out_of_scope_content (Pass 0 product-engine_role mismatch warning).';

-- ─── Audit (read-only, executed at migration time) ──────────────────────────
--
-- The block below is a comment-only catalogue of the auto-mapped slot rows.
-- A future maintainer can run the same SELECT to spot-check the mapping and
-- (if anything looks off) ship a targeted UPDATE in a follow-up migration.
-- We deliberately do NOT execute the SELECT at migration time — output goes
-- nowhere and we don't want to bloat the migration log.
--
-- Reference query (run manually against prod or staging to inspect):
--
--   SELECT
--     slot_id,
--     display_name,
--     phase,
--     package_types,
--     eligible_when_engine_roles AS new_engine_roles
--   FROM shortlisting_slot_definitions
--   WHERE is_active = true
--   ORDER BY phase, slot_id;
--
-- Expected mapping fingerprint (per the rules above):
--
--   slot_id LIKE 'drone_%'         → ['drone_shortlist']
--   slot_id LIKE 'floorplan%'      → ['floorplan_qa']
--   slot_id LIKE 'video_%'         → ['video_day_shortlist','video_dusk_shortlist']
--   display_name ILIKE '%headshot%' → ['agent_portraits']
--   everything else                → ['photo_day_shortlist','photo_dusk_shortlist']
--
-- Counts at migration time will appear in the apply log as
-- "UPDATE <n>" lines. Sanity check those against a fresh row count from
-- shortlisting_slot_definitions before declaring victory.

-- ─── Backfill counters (read-only, for the apply summary) ───────────────────
--
-- Forward-callers (Pass 2 etc.) will start consuming the new column as soon
-- as the corresponding edge function deploy lands. Until then, the engine-
-- role-driven path is dormant: empty `eligible_when_engine_roles` triggers
-- the package_types fallback, exactly matching pre-migration behaviour.

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (run MANUALLY if this migration breaks production) ────────────
--
-- DROP INDEX IF EXISTS idx_products_active_engine_role;
-- DROP INDEX IF EXISTS idx_slot_defs_eligible_when_engine_roles_gin;
-- ALTER TABLE shortlisting_slot_definitions DROP COLUMN IF EXISTS eligible_when_engine_roles;
-- ALTER TABLE products DROP COLUMN IF EXISTS engine_role;
-- NOTIFY pgrst, 'reload schema';
--
-- Rollback is data-lossy for any rows that have been edited via the admin UI
-- after the column landed. To preserve audit history before dropping:
--
--   CREATE TABLE _rollback_w7_8_products AS
--     SELECT id, engine_role FROM products WHERE engine_role IS NOT NULL;
--   CREATE TABLE _rollback_w7_8_slot_defs AS
--     SELECT id, slot_id, eligible_when_engine_roles
--     FROM shortlisting_slot_definitions
--     WHERE eligible_when_engine_roles <> '{}'::text[];
--
-- Then DROP COLUMN. Forward callers (slotEligibility.ts in shortlisting-pass2)
-- MUST be re-deployed at the prior commit BEFORE dropping the column or
-- every Pass 2 run 500s on the missing field.
