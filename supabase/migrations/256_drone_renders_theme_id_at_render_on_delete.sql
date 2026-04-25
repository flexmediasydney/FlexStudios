-- ════════════════════════════════════════════════════════════════════════
-- Migration 256 — drone_renders.theme_id_at_render FK ON DELETE SET NULL
-- (QC6 #9)
--
-- Sister column `drone_renders.theme_id` already declares ON DELETE SET NULL
-- (so deleting a theme nulls out the live pointer). The "at render" pointer
-- has no ON DELETE clause — defaults to NO ACTION — so a master_admin
-- attempting to delete a drone_themes row referenced by any historical
-- render's `theme_id_at_render` gets a 23503 FK violation and the delete
-- aborts.
--
-- Theme deletes are operator-driven (cleanup, sandbox cleanup) and the at-
-- render pointer is intentionally a SOFT historical reference — losing the
-- pointer just means we can't badge "render is N versions behind" for that
-- theme any more (acceptable). SET NULL matches the sister column's intent.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_renders
  DROP CONSTRAINT IF EXISTS drone_renders_theme_id_at_render_fkey;

ALTER TABLE drone_renders
  ADD CONSTRAINT drone_renders_theme_id_at_render_fkey
  FOREIGN KEY (theme_id_at_render)
  REFERENCES drone_themes(id)
  ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
