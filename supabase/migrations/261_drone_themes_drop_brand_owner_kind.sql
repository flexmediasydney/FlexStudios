-- ════════════════════════════════════════════════════════════════════════
-- Migration 261 — drone_themes drop dead 'brand' owner_kind support
-- (QC6 #20)
--
-- Migration 235 added `drone_themes_brand_not_yet_supported` CHECK that
-- forces owner_kind != 'brand'. Meanwhile the parent `drone_themes_owner_
-- kind_check` STILL allows 'brand' as a value. Either the brand entity ships
-- and we drop the brand_not_yet_supported guard, or it doesn't and we should
-- shrink the parent CHECK so the legal-set is honest. The brand entity has
-- not shipped and isn't on any near-term roadmap.
--
-- Plan:
--   1. Drop the redundant `drone_themes_brand_not_yet_supported` guard.
--   2. Redefine the parent CHECK without 'brand', so the legal set is just
--      ('system', 'person', 'organisation').
--
-- If brand support eventually ships, a follow-up migration will re-add it.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_themes
  DROP CONSTRAINT IF EXISTS drone_themes_brand_not_yet_supported;

ALTER TABLE drone_themes
  DROP CONSTRAINT IF EXISTS drone_themes_owner_kind_check;

ALTER TABLE drone_themes
  ADD CONSTRAINT drone_themes_owner_kind_check
  CHECK (owner_kind = ANY (ARRAY['system'::text, 'person'::text, 'organisation'::text]));

NOTIFY pgrst, 'reload schema';
