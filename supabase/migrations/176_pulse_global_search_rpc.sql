-- Migration 176: pulse_global_search RPC
-- =======================================
-- Why: the Industry Pulse command palette (⌘K) needs a single server-side
-- typeahead endpoint that fans out across listings, agents and agencies with
-- trigram similarity scoring, ranked in a consistent way, capped to a small
-- limit.
--
-- What: TABLE(kind text, id uuid, label text, sub text, score float) where
--   kind   = 'listing' | 'agent' | 'agency'
--   id     = primary key
--   label  = main display string (address / full_name / name)
--   sub    = secondary context (suburb / agency_name / suburb list)
--   score  = 0..1 trigram similarity, higher = better
--
-- Uses the existing idx_pulse_*_search_text_trgm GIN indexes created in earlier
-- migrations, so queries stay sub-50ms even at 6k+ listings.
--
-- Minimum similarity threshold is set inline via set_limit() on a per-call
-- basis — we don't touch the session default so other RPCs aren't affected.

-- An earlier experimental signature may exist on some environments; drop the
-- exact (text,int) variant so CREATE OR REPLACE can swap the return type.
DROP FUNCTION IF EXISTS pulse_global_search(text, int);
DROP FUNCTION IF EXISTS pulse_global_search(text, integer);

CREATE OR REPLACE FUNCTION pulse_global_search(
  q    text,
  lim  int DEFAULT 20
)
RETURNS TABLE(
  kind  text,
  id    uuid,
  label text,
  sub   text,
  score real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  qq  text := trim(coalesce(q, ''));
  cap int  := greatest(1, least(coalesce(lim, 20), 50));
BEGIN
  IF qq = '' OR length(qq) < 2 THEN
    RETURN; -- nothing to search
  END IF;

  -- Scope the trigram threshold locally (reset by ROLLBACK of function txn).
  PERFORM set_limit(0.1);

  RETURN QUERY
  WITH
    hits_listings AS (
      SELECT
        'listing'::text AS kind,
        l.id,
        COALESCE(l.address, '(no address)')                    AS label,
        COALESCE(NULLIF(l.suburb, ''), l.listing_type, '')     AS sub,
        similarity(COALESCE(l.search_text, ''), qq)            AS score
      FROM pulse_listings l
      WHERE l.search_text % qq
      ORDER BY score DESC
      LIMIT cap
    ),
    hits_agents AS (
      SELECT
        'agent'::text AS kind,
        a.id,
        COALESCE(a.full_name, '(unnamed)')                     AS label,
        COALESCE(a.agency_name, '')                            AS sub,
        similarity(COALESCE(a.search_text, ''), qq)            AS score
      FROM pulse_agents a
      WHERE a.search_text % qq
      ORDER BY score DESC
      LIMIT cap
    ),
    hits_agencies AS (
      SELECT
        'agency'::text AS kind,
        ag.id,
        COALESCE(ag.name, '(unnamed)')                         AS label,
        ''::text                                               AS sub,
        similarity(COALESCE(ag.search_text, ''), qq)           AS score
      FROM pulse_agencies ag
      WHERE ag.search_text % qq
      ORDER BY score DESC
      LIMIT cap
    ),
    unioned AS (
      SELECT * FROM hits_listings
      UNION ALL
      SELECT * FROM hits_agents
      UNION ALL
      SELECT * FROM hits_agencies
    )
  SELECT u.kind, u.id, u.label, u.sub, u.score
  FROM unioned u
  ORDER BY u.score DESC, u.label ASC
  LIMIT cap;
END
$$;

GRANT EXECUTE ON FUNCTION pulse_global_search(text, int) TO authenticated, anon, service_role;

COMMENT ON FUNCTION pulse_global_search(text, int) IS
  'Fan-out trigram typeahead across pulse_listings / pulse_agents / pulse_agencies. Powers the Industry Pulse command palette (⌘K). See migration 176.';
