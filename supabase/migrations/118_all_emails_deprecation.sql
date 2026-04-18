-- 118_all_emails_deprecation.sql
-- Fix B21: pulse_agents.all_emails + alternate_emails are both written by
-- different code paths and drift out of sync. Migration 103 backfilled
-- alternate_emails from all_emails; going forward all_emails is deprecated.
--
-- Strategy:
--  (1) Install a BEFORE INSERT/UPDATE trigger on pulse_agents that mirrors
--      any all_emails write into alternate_emails (so legacy writers don't
--      silently drift).
--  (2) Add a COMMENT marking all_emails deprecated so developers know to
--      migrate off.
--  (3) Do NOT drop all_emails yet — pulseDataSync writes to it at line
--      ~1507. Until that code is migrated, we need the column intact. The
--      trigger keeps alternate_emails authoritative.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_agents_mirror_all_emails_to_alt() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_emails_arr TEXT[];
  v_existing_alts JSONB;
  v_new_alts JSONB;
  v_email TEXT;
BEGIN
  -- Only act when all_emails is being set and is a valid array
  IF NEW.all_emails IS NULL OR jsonb_typeof(NEW.all_emails) <> 'array' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.all_emails IS NOT DISTINCT FROM NEW.all_emails) THEN
    -- No change to all_emails; don't re-mirror
    RETURN NEW;
  END IF;

  -- Cast to text[] for iteration
  SELECT array_agg(value) FROM jsonb_array_elements_text(NEW.all_emails) value
  INTO v_emails_arr;

  v_existing_alts := COALESCE(NEW.alternate_emails, '[]'::jsonb);

  -- For each email in all_emails, ensure it exists in alternate_emails.
  -- If not present, append with legacy source marker.
  IF v_emails_arr IS NOT NULL THEN
    FOREACH v_email IN ARRAY v_emails_arr LOOP
      IF v_email IS NULL OR trim(v_email) = '' OR position('@' IN v_email) = 0 THEN
        CONTINUE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_existing_alts) e
        WHERE e->>'value' = lower(trim(v_email))
      ) THEN
        v_existing_alts := v_existing_alts || jsonb_build_object(
          'value',         lower(trim(v_email)),
          'sources',       '["all_emails_mirror"]'::jsonb,
          'confidence',    50,
          'first_seen_at', COALESCE(NEW.first_seen_at, now()),
          'last_seen_at',  now()
        );
      END IF;
    END LOOP;
  END IF;

  -- Apply LRU cap to keep under 10
  NEW.alternate_emails := pulse_alts_lru_cap(v_existing_alts, 10);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_agents_mirror_all_emails_trg ON pulse_agents;
CREATE TRIGGER pulse_agents_mirror_all_emails_trg
  BEFORE INSERT OR UPDATE OF all_emails ON pulse_agents
  FOR EACH ROW EXECUTE FUNCTION pulse_agents_mirror_all_emails_to_alt();

COMMENT ON COLUMN pulse_agents.all_emails IS
  'DEPRECATED — use alternate_emails going forward. Writes to this column are '
  'automatically mirrored into alternate_emails by pulse_agents_mirror_all_emails_trg. '
  'Will be dropped in a future migration once pulseDataSync + cleanAgentEmails '
  'stop reading it.';

COMMIT;
