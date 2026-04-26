-- 285_drone_pois_cache_deprecation
--
-- Wave 5 Phase 2 / S1: mark drone_pois_cache as deprecated and install a
-- write-blocking trigger. Canonical AI POIs now live in drone_custom_pins
-- WHERE source='ai'. Scheduled for DROP in Wave 6 (~2026-05-15).
--
-- Pre-flight (in worktree agitated-mclean-e59b14, ts 2026-04-26):
--   git grep "drone_pois_cache" supabase/ flexmedia-src/ confirmed the only
--   live writer is supabase/functions/drone-pois/index.ts (the cache owner
--   itself, lines ~457 read / ~535 upsert). Per architect: drone-pois will
--   be updated in S2 to stop writing the cache; until then this trigger
--   ensures any other accidental writer is blocked. Cache reads continue
--   to work (trigger is on INSERT/UPDATE/DELETE only).

COMMENT ON TABLE drone_pois_cache IS
  'DEPRECATED Wave 5 (2026-04-26). Canonical AI POIs live in drone_custom_pins WHERE source=''ai''. '
  'Scheduled for DROP in Wave 6 (~2026-05-15). DO NOT WRITE.';

CREATE OR REPLACE FUNCTION drone_pois_cache_block_writes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'drone_pois_cache is deprecated; write to drone_custom_pins WHERE source=''ai'' instead';
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

CREATE TRIGGER trg_drone_pois_cache_block_writes
  BEFORE INSERT OR UPDATE OR DELETE ON drone_pois_cache
  FOR EACH ROW EXECUTE FUNCTION drone_pois_cache_block_writes();
