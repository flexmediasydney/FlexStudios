-- 086: pulse_target_suburbs validation constraints + uniqueness index
--
-- Backstops the Suburb Pool CRUD UI. Without these the frontend can prevent
-- bad rows but the DB itself will accept whatever a service-role caller sends.
-- These constraints make the rules absolute:
--   - name is non-empty, trimmed length >= 2 chars
--   - postcode (when present) is exactly 4 digits — REA URL builder REQUIRES
--     the format Suburb,+STATE+POSTCODE; a missing/malformed postcode skips
--     the suburb in pulseFireScrapes (see actorInputUsesPostcode branch).
--   - priority is in 1..10 — beyond that range the cron `min_priority` filter
--     either ignores everything or is meaningless.
--   - (lower(name), state, postcode) must be unique — prevents the same
--     "Strathfield NSW 2135" being entered twice with different casings.
--
-- IMPORTANT: postcode constraint is conditional on NOT NULL because we have at
-- least one legacy row ("bondi") that predates the postcode requirement. The
-- UI surfaces those rows in the Validate Pool report and prompts the user to
-- fix them. Future enforcement (NOT NULL) can land once those are cleaned up.

-- Trim helper: ensure name has actual content
ALTER TABLE pulse_target_suburbs
  DROP CONSTRAINT IF EXISTS pulse_target_suburbs_name_nonempty;
ALTER TABLE pulse_target_suburbs
  ADD CONSTRAINT pulse_target_suburbs_name_nonempty
    CHECK (length(trim(name)) >= 2);

-- Postcode format (only when set — see legacy row note above)
ALTER TABLE pulse_target_suburbs
  DROP CONSTRAINT IF EXISTS pulse_target_suburbs_postcode_format;
ALTER TABLE pulse_target_suburbs
  ADD CONSTRAINT pulse_target_suburbs_postcode_format
    CHECK (postcode IS NULL OR postcode ~ '^\d{4}$');

-- Priority range 1..10
-- (existing rows must be in range; if they're not, the migration will fail
--  loudly — fix the data first and re-run.)
ALTER TABLE pulse_target_suburbs
  DROP CONSTRAINT IF EXISTS pulse_target_suburbs_priority_range;
ALTER TABLE pulse_target_suburbs
  ADD CONSTRAINT pulse_target_suburbs_priority_range
    CHECK (priority IS NULL OR priority BETWEEN 1 AND 10);

-- Uniqueness: lower(name) + state + postcode. Allows nulls in postcode but
-- treats them as distinct rows (Postgres default), so the legacy "bondi" row
-- doesn't collide with a future "Bondi/2026" entry.
CREATE UNIQUE INDEX IF NOT EXISTS pulse_target_suburbs_unique_name_state_postcode
  ON pulse_target_suburbs (lower(name), state, postcode);
