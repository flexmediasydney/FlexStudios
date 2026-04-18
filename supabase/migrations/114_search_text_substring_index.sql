-- 114_search_text_substring_index.sql
-- Fix B14: UI global search `.or()` jsonb containment only matches EXACT
-- alternate values. Typing "smith" won't find john.smith@example.com in
-- alternate_emails. Solution: add a trigger-maintained `search_text`
-- denorm column + GIN trigram index for real substring `ilike` queries.
--
-- Same pattern applied to pulse_agents and pulse_agencies so both tabs'
-- global search works across primary + all alternate contacts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── pulse_agents.search_text ─────────────────────────────────────────────
ALTER TABLE pulse_agents ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE OR REPLACE FUNCTION pulse_agents_build_search_text() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := LOWER(
    COALESCE(NEW.full_name, '') || ' ' ||
    COALESCE(NEW.email, '') || ' ' ||
    COALESCE(NEW.mobile, '') || ' ' ||
    COALESCE(NEW.business_phone, '') || ' ' ||
    COALESCE(NEW.agency_name, '') || ' ' ||
    COALESCE(NEW.rea_agent_id, '') || ' ' ||
    COALESCE((
      SELECT string_agg(e->>'value', ' ')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.alternate_emails)='array' THEN NEW.alternate_emails ELSE '[]'::jsonb END) e
    ), '') || ' ' ||
    COALESCE((
      SELECT string_agg(e->>'value', ' ')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.alternate_mobiles)='array' THEN NEW.alternate_mobiles ELSE '[]'::jsonb END) e
    ), '') || ' ' ||
    COALESCE((
      SELECT string_agg(e->>'value', ' ')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.alternate_phones)='array' THEN NEW.alternate_phones ELSE '[]'::jsonb END) e
    ), '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_agents_search_text_trg ON pulse_agents;
CREATE TRIGGER pulse_agents_search_text_trg
  BEFORE INSERT OR UPDATE ON pulse_agents
  FOR EACH ROW EXECUTE FUNCTION pulse_agents_build_search_text();

-- Backfill existing rows (trigger fires on UPDATE)
UPDATE pulse_agents SET search_text = search_text WHERE search_text IS NULL OR search_text = '';

COMMENT ON COLUMN pulse_agents.search_text IS
  'Trigger-maintained concat of primary contacts + all alternate values, '
  'lowercased. UI global search uses ilike on this. Backed by GIN trigram.';

-- ── pulse_agencies.search_text ───────────────────────────────────────────
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE OR REPLACE FUNCTION pulse_agencies_build_search_text() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := LOWER(
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW.email, '') || ' ' ||
    COALESCE(NEW.phone, '') || ' ' ||
    COALESCE(NEW.website, '') || ' ' ||
    COALESCE(NEW.rea_agency_id, '') || ' ' ||
    COALESCE(NEW.suburb, '') || ' ' ||
    COALESCE(NEW.address_street, '') || ' ' ||
    COALESCE((
      SELECT string_agg(e->>'value', ' ')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.alternate_emails)='array' THEN NEW.alternate_emails ELSE '[]'::jsonb END) e
    ), '') || ' ' ||
    COALESCE((
      SELECT string_agg(e->>'value', ' ')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.alternate_phones)='array' THEN NEW.alternate_phones ELSE '[]'::jsonb END) e
    ), '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_agencies_search_text_trg ON pulse_agencies;
CREATE TRIGGER pulse_agencies_search_text_trg
  BEFORE INSERT OR UPDATE ON pulse_agencies
  FOR EACH ROW EXECUTE FUNCTION pulse_agencies_build_search_text();

UPDATE pulse_agencies SET search_text = search_text WHERE search_text IS NULL OR search_text = '';

COMMENT ON COLUMN pulse_agencies.search_text IS
  'Trigger-maintained concat for substring search. Includes email, phone, '
  'website, address_street + all alternates.';

COMMIT;

-- ── GIN trigram indexes (CREATE INDEX CONCURRENTLY outside tx) ─────────
-- These will be created via separate statements at migration-runner level.
-- Management API does per-statement execution so we can't put them here.
