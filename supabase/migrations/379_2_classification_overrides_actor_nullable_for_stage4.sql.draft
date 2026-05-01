-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 379_2 — W11.7 cleanup: composition_classification_overrides
--                   actor_user_id nullable for stage4_visual_override rows
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-5-human-reclassification-capture.md
--       docs/design-specs/W11-7-unified-shortlisting-architecture.md
--
-- ─── PROBLEM ──────────────────────────────────────────────────────────────────
--
-- The Stage 4 dual-write (shortlisting-shape-d-stage4 → mirror to
-- composition_classification_overrides with override_source='stage4_visual_
-- override') silently fails today when the operator who would attribute the
-- override doesn't exist in auth.users.
--
-- Root cause discovered during W11.7 cleanup audit:
--
--   * The `composition_classification_overrides.actor_user_id` column is
--     NOT NULL with a FK to auth.users(id).
--   * Stage 4 is a SYSTEM actor — there is no human operator behind a
--     stage4_visual_override row. The current code papers over this by
--     looking up "any master_admin" from public.users and using their id.
--   * On the Saladine smoke test (round 3ed54b53-9184-402f-9907-d168ed1968a4),
--     the first master_admin returned (joseph.saad91@gmail.com,
--     id=8e10f74b-...) does NOT exist in auth.users. The FK violation aborts
--     the upsert, the warning is swallowed, and the mirror count stays 0.
--
-- ─── DECISION ─────────────────────────────────────────────────────────────────
--
-- Allow NULL `actor_user_id` for rows where `override_source =
-- 'stage4_visual_override'`. Audit attribution for these rows is "the engine"
-- (specifically: the W11.7 Stage 4 visual master synthesis call). The
-- shortlisting_stage4_overrides audit table is the authoritative trail (it
-- doesn't require actor_user_id at all); composition_classification_overrides
-- is a derived mirror used by the project_memory prompt loader and dashboards.
--
-- Pros of this approach over alternatives:
--   * Doesn't require synthesizing a "system user" auth.users row (which
--     creates a real auth identity that could accidentally log in).
--   * Doesn't require the engine to randomly pick from existing master_admins
--     (which mis-attributes the override and creates audit-trail noise).
--   * Read-side queries already need to handle NULL author for "synthetic"
--     rows; one branch on override_source is the cleanest signal.
--
-- Pros of the alternative (synthesizing a service user):
--   * Single attribution path: every row has a user. (But this user is fake.)
--
-- ─── INVARIANT (enforced by CHECK) ────────────────────────────────────────────
--
-- After this migration:
--   * override_source IN ('stage1_correction', 'master_admin_correction')
--       → actor_user_id MUST be non-NULL (real human author).
--   * override_source = 'stage4_visual_override'
--       → actor_user_id MAY be NULL (system actor; engine attribution).
--
-- ─── BACKWARDS COMPATIBILITY ──────────────────────────────────────────────────
--
-- Drops the column-level NOT NULL constraint and adds a CHECK that enforces
-- the conditional invariant above. Existing rows are unaffected (all current
-- rows have non-NULL actor_user_id; the CHECK accepts that). Future stage1_*
-- and master_admin_* override rows still must specify a user.
--
-- The W11.5 spec (W11-5-human-reclassification-capture.md) is updated by the
-- accompanying commit to document this exception.
--
-- ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────
--
-- ALTER COLUMN ... DROP NOT NULL is idempotent.
-- The CHECK constraint uses DROP IF EXISTS + ADD CONSTRAINT.

ALTER TABLE composition_classification_overrides
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE composition_classification_overrides
  DROP CONSTRAINT IF EXISTS composition_classification_overrides_actor_required_chk;

ALTER TABLE composition_classification_overrides
  ADD CONSTRAINT composition_classification_overrides_actor_required_chk
  CHECK (
    -- Stage 1 corrections + master_admin corrections require a human author.
    -- Stage 4 visual overrides may be authored by the engine (NULL allowed).
    (override_source IN ('stage1_correction', 'master_admin_correction')
       AND actor_user_id IS NOT NULL)
    OR
    (override_source = 'stage4_visual_override')
  );

COMMENT ON COLUMN composition_classification_overrides.actor_user_id IS
  'Author of the override. Required (NOT NULL via CHECK) when '
  'override_source IN (''stage1_correction'', ''master_admin_correction'') — '
  'these are human-authored corrections. May be NULL when '
  'override_source = ''stage4_visual_override'' — those rows are authored by '
  'the W11.7 Stage 4 visual master synthesis engine, not a human. The '
  'authoritative audit trail for stage4 overrides lives in '
  'shortlisting_stage4_overrides.';

NOTIFY pgrst, 'reload schema';

-- ─── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE composition_classification_overrides
--   DROP CONSTRAINT IF EXISTS composition_classification_overrides_actor_required_chk;
-- ALTER TABLE composition_classification_overrides
--   ALTER COLUMN actor_user_id SET NOT NULL;
-- (Note: SET NOT NULL will FAIL if any stage4_visual_override rows with NULL
--  actor_user_id have been written. Pre-rollback, either DELETE those rows or
--  backfill them with a synthetic system-user id.)
