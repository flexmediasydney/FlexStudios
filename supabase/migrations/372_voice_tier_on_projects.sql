-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 372 — Wave 11.7.8: voice tier modulation on projects
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-8-voice-tier-modulation.md
--
-- Adds property_tier + property_voice_anchor_override to the projects table
-- (project-level defaults) and a trigger that copies those values onto each
-- shortlisting_round at round-start (so historical rounds preserve their
-- original tier even if the project's default changes later).
--
-- DEPENDS ON: mig 371 (which adds the round-level columns this trigger writes
-- to). Apply 371 → 372 in order.
--
-- ─── DESIGN NOTES ─────────────────────────────────────────────────────────────
--
-- 1. Default 'standard' on the projects.property_tier column is intentional.
--    Per W11.7.8 §"Default": pretentious copy on a suburban home is a worse
--    outcome than competent copy on a luxury home, so 'standard' is the safer
--    fallback when the operator hasn't picked.
--
-- 2. The CHECK constraint enforces the 3 known tier values. Tier values are
--    likely to expand (W11.7.8 §"Open question Q4" considers a 'standard_plus'
--    mid-tier; recommendation was no, but the door is left open). When a new
--    tier is added, this constraint is the place to update it.
--
-- 3. property_voice_anchor_override is plain TEXT — no length cap at the DB
--    level. The application layer (project setup UI + project edit UI) caps
--    at 2000 chars per W11.7.8 §"Schema". A DB-level length CHECK is rejected
--    here because the override blob may legitimately want trailing whitespace
--    or pasted markup that the UI sanitises but the DB shouldn't reject.
--
-- 4. The trigger COALESCEs into the round only when the round's column is
--    NULL. This means if the orchestrator pre-populates the round with an
--    explicit tier (e.g. master_admin overrode for this single round), the
--    trigger does NOT clobber it. The round's tier is sticky once set.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD COLUMNS ──────────────────────────────────────────────────────────

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS property_tier TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS property_voice_anchor_override TEXT;

COMMENT ON COLUMN projects.property_tier IS
  'Wave 11.7.8: voice tier for listing-copy synthesis. "premium" | "standard" '
  '| "approachable". Default "standard". Project-level default; copied onto '
  'each shortlisting_round at round-start by trigger copy_property_tier_to_'
  'round so historical rounds preserve their tier even if the project default '
  'changes later. Operator picks at project setup; tier coercion table from '
  'W11.7.8 §"Tier coercion at scale" pre-fills based on price_guide_band.';

COMMENT ON COLUMN projects.property_voice_anchor_override IS
  'Wave 11.7.8: optional free-text rubric override that replaces the tier '
  'preset block in the prompt. 50-1000 chars typical; UI caps at 2000. NULL '
  'when no override (use tier preset). Forbidden patterns from the standard '
  'tier rubric still apply at synthesis-time (operator can''t paste an '
  'override that approves "stunning" or exclamation marks).';

-- ─── 2. BACKFILL EXISTING PROJECTS to 'standard' ─────────────────────────────
-- Batched per MIGRATION_SAFETY.md §"Backfill in batches". Production projects
-- volume is in the low thousands; batched loop is the safe pattern.

DO $$
DECLARE
  batch_size CONSTANT INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE projects
       SET property_tier = 'standard'
     WHERE id IN (
       SELECT id FROM projects
        WHERE property_tier IS NULL
        LIMIT batch_size
     );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- ─── 3. ADD CHECK CONSTRAINT (after backfill so it doesn't reject NULL rows) ─
-- DEFAULT applied separately so future INSERTs that omit property_tier still
-- get 'standard'. This is the additive-then-enforce pattern from
-- MIGRATION_SAFETY.md §"Adding a NOT NULL constraint to an existing nullable
-- column" (not making it NOT NULL — keeping nullable to allow the trigger
-- pattern to skip rows that haven't been backfilled — but using the same
-- careful sequencing).

ALTER TABLE projects
  ALTER COLUMN property_tier SET DEFAULT 'standard';

-- Constraint added with NOT VALID first so existing rows aren't re-validated
-- (we just backfilled them). The VALIDATE step then runs without holding a
-- write lock for the duration of the constraint check. This is the standard
-- production-safe pattern for adding a CHECK to a populated table.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_property_tier_chk'
       AND conrelid = 'projects'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE projects
             ADD CONSTRAINT projects_property_tier_chk
             CHECK (property_tier IS NULL OR property_tier IN (''premium'', ''standard'', ''approachable''))
             NOT VALID';
    EXECUTE 'ALTER TABLE projects VALIDATE CONSTRAINT projects_property_tier_chk';
  END IF;
END $$;

-- ─── 4. BACKFILL existing shortlisting_rounds.property_tier from project ─────
-- Per W11.7.8 §"Backfill rounds". Existing rounds get the project's tier
-- (which we just backfilled to 'standard' for everyone).
-- Depends on shortlisting_rounds.property_tier column from mig 371.

DO $$
DECLARE
  batch_size CONSTANT INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE shortlisting_rounds r
       SET property_tier = p.property_tier
      FROM projects p
     WHERE r.project_id = p.id
       AND r.property_tier IS NULL
       AND r.id IN (
         SELECT id FROM shortlisting_rounds
          WHERE property_tier IS NULL
          LIMIT batch_size
       );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- ─── 5. TRIGGER copy_property_tier_to_round ──────────────────────────────────
-- Fires BEFORE INSERT on shortlisting_rounds. If the round's property_tier (or
-- override) is NULL, copy from the project. If the orchestrator has already
-- set them (master_admin per-round override), the trigger respects the value
-- and does not clobber.

CREATE OR REPLACE FUNCTION copy_property_tier_to_round()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  proj_tier TEXT;
  proj_override TEXT;
BEGIN
  -- Only look up when at least one column is NULL.
  IF NEW.property_tier IS NULL OR NEW.property_voice_anchor_override IS NULL THEN
    SELECT property_tier, property_voice_anchor_override
      INTO proj_tier, proj_override
      FROM projects
     WHERE id = NEW.project_id;

    IF NEW.property_tier IS NULL THEN
      NEW.property_tier := COALESCE(proj_tier, 'standard');
    END IF;

    -- override is genuinely allowed to be NULL on the round even when the
    -- project has one set (e.g. master_admin disabled the override for a
    -- single round). So we ONLY copy when round has NULL override AND
    -- project has a value to copy.
    IF NEW.property_voice_anchor_override IS NULL AND proj_override IS NOT NULL THEN
      NEW.property_voice_anchor_override := proj_override;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION copy_property_tier_to_round() IS
  'Wave 11.7.8: BEFORE INSERT trigger that copies projects.property_tier + '
  'property_voice_anchor_override onto a new shortlisting_round when the '
  'round''s columns are NULL. Lets the orchestrator pre-populate these for '
  'per-round overrides without being clobbered.';

DROP TRIGGER IF EXISTS copy_property_tier_to_round_trigger ON shortlisting_rounds;
CREATE TRIGGER copy_property_tier_to_round_trigger
  BEFORE INSERT ON shortlisting_rounds
  FOR EACH ROW
  EXECUTE FUNCTION copy_property_tier_to_round();

-- ─── 6. INDEXES ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_projects_property_tier
  ON projects(property_tier)
  WHERE property_tier IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP TRIGGER IF EXISTS copy_property_tier_to_round_trigger ON shortlisting_rounds;
-- DROP FUNCTION IF EXISTS copy_property_tier_to_round();
-- DROP INDEX IF EXISTS idx_projects_property_tier;
--
-- ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_property_tier_chk;
-- ALTER TABLE projects ALTER COLUMN property_tier DROP DEFAULT;
-- ALTER TABLE projects DROP COLUMN IF EXISTS property_voice_anchor_override;
-- ALTER TABLE projects DROP COLUMN IF EXISTS property_tier;
--
-- Note: dropping the columns is data-lossy if any project has a non-default
-- tier or an explicit override set. Pre-rollback dump:
--   CREATE TABLE _rollback_projects_voice_tier AS
--     SELECT id, property_tier, property_voice_anchor_override
--       FROM projects
--      WHERE property_tier <> 'standard' OR property_voice_anchor_override IS NOT NULL;
