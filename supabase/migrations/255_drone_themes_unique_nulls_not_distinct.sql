-- ════════════════════════════════════════════════════════════════════════
-- Migration 255 — drone_themes (owner_kind, owner_id, name) UNIQUE
-- with NULLS NOT DISTINCT (QC6 #8)
--
-- The existing constraint `drone_themes_owner_kind_owner_id_name_key`
-- declares UNIQUE (owner_kind, owner_id, name). On PG ≥15, NULLs in
-- composite UNIQUE constraints are DISTINCT by default — so two system
-- themes (owner_kind='system', owner_id=NULL, name='FlexMedia Default')
-- can coexist, defeating the intended uniqueness.
--
-- PG 17.6 confirmed (production version), so NULLS NOT DISTINCT is
-- supported. We DROP + ADD with the new clause.
--
-- Pre-flight: there are currently no duplicate (owner_kind, owner_id, name)
-- tuples for system themes (verified — see project_themes inspection in the
-- QC6 report), so the new constraint will not refuse to create. If a future
-- duplicate ever sneaks in, the ALTER TABLE will fail loudly and the
-- offending rows must be deduped before retrying.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_themes
  DROP CONSTRAINT IF EXISTS drone_themes_owner_kind_owner_id_name_key;

ALTER TABLE drone_themes
  ADD CONSTRAINT drone_themes_owner_kind_owner_id_name_key
  UNIQUE NULLS NOT DISTINCT (owner_kind, owner_id, name);

NOTIFY pgrst, 'reload schema';
