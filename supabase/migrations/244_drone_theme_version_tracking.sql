-- ════════════════════════════════════════════════════════════════════
-- Drone theme version tracking + stale-render warning
-- ────────────────────────────────────────────────────────────────────
-- Adds:
--   drone_themes.version_int                 (BIGINT, auto-bump on update
--                                             when config or is_default changes)
--   drone_renders.theme_id_at_render         (which theme produced this render)
--   drone_renders.theme_version_int_at_render (which version of that theme)
--
-- Plus two RPCs:
--   drone_renders_stale_against_theme(p_shoot_id)  — used by the swimlane to
--     amber-badge each render whose stamped theme version is behind the
--     current theme version.
--   drone_theme_impacted_projects(p_theme_id)      — used by the theme save
--     dialog (Subagent B) to enumerate in-flight projects affected by an
--     edit, so the operator can choose to re-render or not.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Theme version column + auto-bump trigger ─────────────────────
ALTER TABLE drone_themes
  ADD COLUMN IF NOT EXISTS version_int BIGINT NOT NULL DEFAULT 1;

-- Auto-bump version_int on any UPDATE that changes config or is_default.
-- Status flips don't bump; archive/restore is a curation action, not a
-- content change so renders produced under it should NOT show as stale.
-- Other metadata edits (name/description) also don't bump — they're
-- annotations, not styling changes that would alter the render output.
CREATE OR REPLACE FUNCTION bump_drone_theme_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.config IS DISTINCT FROM OLD.config OR NEW.is_default IS DISTINCT FROM OLD.is_default THEN
    NEW.version_int = COALESCE(OLD.version_int, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drone_themes_bump_version ON drone_themes;
CREATE TRIGGER trg_drone_themes_bump_version
  BEFORE UPDATE ON drone_themes
  FOR EACH ROW
  EXECUTE FUNCTION bump_drone_theme_version();

-- ── 2. Render-side stamp columns ────────────────────────────────────
ALTER TABLE drone_renders
  ADD COLUMN IF NOT EXISTS theme_id_at_render UUID REFERENCES drone_themes(id),
  ADD COLUMN IF NOT EXISTS theme_version_int_at_render BIGINT;

CREATE INDEX IF NOT EXISTS idx_drone_renders_theme_lookup
  ON drone_renders(theme_id_at_render, theme_version_int_at_render);

-- ── 3. Stale-detection RPC (per-shoot) ──────────────────────────────
-- Returns one row per render in the shoot whose column_state is operator-
-- facing (proposed/adjustments/final). Skips 'preview' (informational
-- pre-edit thumbnails — they're disposable) and 'rejected' (already a
-- discard), so the badge only surfaces on cards that would actually
-- benefit from a re-render. is_stale is TRUE when both versions are
-- known AND the current theme's version_int is greater than what was
-- stamped at render time.
--
-- Renders pre-dating migration 244 have NULL theme_*_at_render — they
-- come back with is_stale=FALSE, which is the correct behaviour:
-- without a stamped baseline we can't claim staleness, so we leave the
-- card un-badged rather than show a confusing warning.
CREATE OR REPLACE FUNCTION drone_renders_stale_against_theme(p_shoot_id UUID)
RETURNS TABLE (
  render_id UUID,
  shot_id UUID,
  column_state TEXT,
  theme_id_at_render UUID,
  theme_version_int_at_render BIGINT,
  current_theme_version_int BIGINT,
  is_stale BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT
    dr.id AS render_id,
    dr.shot_id,
    dr.column_state,
    dr.theme_id_at_render,
    dr.theme_version_int_at_render,
    dt.version_int AS current_theme_version_int,
    (dt.version_int IS NOT NULL
      AND dr.theme_version_int_at_render IS NOT NULL
      AND dt.version_int > dr.theme_version_int_at_render) AS is_stale
  FROM drone_renders dr
  JOIN drone_shots ds ON ds.id = dr.shot_id
  LEFT JOIN drone_themes dt ON dt.id = dr.theme_id_at_render
  WHERE ds.shoot_id = p_shoot_id
    AND dr.column_state IN ('proposed','adjustments','final');
$$;

GRANT EXECUTE ON FUNCTION drone_renders_stale_against_theme(uuid) TO authenticated;

-- ── 4. Impact-list RPC (per-theme) ──────────────────────────────────
-- Returns one row per (project, shoot) pair with at least one operator-
-- facing render whose stamped theme_id_at_render === p_theme_id. Used by
-- the theme save dialog so the operator sees which in-flight work would
-- benefit from a re-render before they save.
--
-- in_flight: TRUE when the shoot has not yet hit terminal status. Per
-- the current drone_shoots status enum (migration 225) the only true
-- terminal status is 'delivered' — there is no archived/cancelled at
-- the shoot level. We still leave the column open-ended (NOT IN
-- ('delivered')) so future terminal additions are easy to fold in
-- without an RPC change.
--
-- For SYSTEM themes: matched renders are only those that resolved
-- specifically TO the system theme (i.e. no person/org override
-- existed). Renders that fell through from a person/org level wouldn't
-- have theme_id_at_render = system_theme_id, they'd have the more-
-- specific theme's id. So this naturally scopes impact to the truly-
-- impacted set rather than "every render in the database that uses the
-- fallback".
--
-- For org/person themes: scope is naturally narrow (only renders where
-- this exact theme was the resolved theme are matched).
--
-- Result is capped at LIMIT 200 inside the function — for system theme
-- changes touching deep history the count could be huge, and the save
-- dialog only needs the head of the list to show the operator. The
-- caller can detect a saturated cap by checking `array_length(rows, 1)
-- = 200` (no separate truncation flag — keep the contract simple).
CREATE OR REPLACE FUNCTION drone_theme_impacted_projects(p_theme_id UUID)
RETURNS TABLE (
  project_id UUID,
  project_address TEXT,
  shoot_id UUID,
  shoot_status TEXT,
  renders_count INT,
  in_flight BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH theme_renders AS (
    SELECT dr.id, dr.shot_id, ds.shoot_id, s.project_id, s.status AS shoot_status
    FROM drone_renders dr
    JOIN drone_shots ds ON ds.id = dr.shot_id
    JOIN drone_shoots s ON s.id = ds.shoot_id
    WHERE dr.theme_id_at_render = p_theme_id
      AND dr.column_state IN ('proposed','adjustments','final')
  )
  SELECT
    tr.project_id,
    p.property_address AS project_address,
    tr.shoot_id,
    tr.shoot_status,
    COUNT(*)::int AS renders_count,
    (tr.shoot_status NOT IN ('delivered'))::boolean AS in_flight
  FROM theme_renders tr
  JOIN projects p ON p.id = tr.project_id
  GROUP BY tr.project_id, p.property_address, tr.shoot_id, tr.shoot_status
  ORDER BY (tr.shoot_status NOT IN ('delivered')) DESC, COUNT(*) DESC
  LIMIT 200;
$$;

GRANT EXECUTE ON FUNCTION drone_theme_impacted_projects(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
