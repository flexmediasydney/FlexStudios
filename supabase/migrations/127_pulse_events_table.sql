-- Migration 127 — PulseEvents table hardening
--
-- ── Problem ───────────────────────────────────────────────────────────────
-- Industry Pulse EV01: The pulse_events table exists (6 seed rows) but is
-- missing:
--   - CHECK constraints for category / source / status enums
--   - Secondary indexes for event_date / category / status filtering
--   - Columns: attended (bool), created_by (uuid), assigned_to_id (uuid,
--     renamed from assigned_to_user_id)
--   - Expanded category enum: auction, expo, industry_meetup
--   - Expanded source enum: linkedin, domain, realestate
--
-- ── Notes ─────────────────────────────────────────────────────────────────
-- * Kept event_date as TIMESTAMPTZ (not split into DATE + TIME) because the
--   UI already binds to <input type="datetime-local"> against a single
--   combined field and 6 production rows store datetimes there. The spec's
--   DATE + TIME + event_time_known split would require rewriting the UI
--   form — deferred.
-- * Kept tags as JSONB (not TEXT[]) for the same reason — existing rows
--   store [] and the UI reads via Array.isArray().
-- * Hardening is idempotent (IF NOT EXISTS / DO blocks).

-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE pulse_events ADD COLUMN IF NOT EXISTS attended          BOOLEAN;
ALTER TABLE pulse_events ADD COLUMN IF NOT EXISTS created_by        UUID;
ALTER TABLE pulse_events ADD COLUMN IF NOT EXISTS assigned_to_id    UUID;

-- Migrate legacy assigned_to_user_id → assigned_to_id, then drop the old col
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='pulse_events' AND column_name='assigned_to_user_id'
  ) THEN
    UPDATE pulse_events
       SET assigned_to_id = COALESCE(assigned_to_id, assigned_to_user_id);
    ALTER TABLE pulse_events DROP COLUMN assigned_to_user_id;
  END IF;
END $$;

-- ── Defaults / NOT NULLs to match spec ────────────────────────────────────
ALTER TABLE pulse_events ALTER COLUMN title    SET NOT NULL;
ALTER TABLE pulse_events ALTER COLUMN category SET DEFAULT 'other';
ALTER TABLE pulse_events ALTER COLUMN source   SET DEFAULT 'manual';
ALTER TABLE pulse_events ALTER COLUMN status   SET DEFAULT 'upcoming';
ALTER TABLE pulse_events ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE pulse_events ALTER COLUMN updated_at SET NOT NULL;

-- Any rows with NULL category/source/status (shouldn't be any) get defaults
UPDATE pulse_events SET category='other'    WHERE category IS NULL;
UPDATE pulse_events SET source='manual'     WHERE source IS NULL;
UPDATE pulse_events SET status='upcoming'   WHERE status IS NULL;

ALTER TABLE pulse_events ALTER COLUMN category SET NOT NULL;
ALTER TABLE pulse_events ALTER COLUMN source   SET NOT NULL;
ALTER TABLE pulse_events ALTER COLUMN status   SET NOT NULL;

-- ── CHECK constraints (expanded enums) ────────────────────────────────────
ALTER TABLE pulse_events DROP CONSTRAINT IF EXISTS pulse_events_category_chk;
ALTER TABLE pulse_events DROP CONSTRAINT IF EXISTS pulse_events_source_chk;
ALTER TABLE pulse_events DROP CONSTRAINT IF EXISTS pulse_events_status_chk;

ALTER TABLE pulse_events ADD CONSTRAINT pulse_events_category_chk
  CHECK (category IN (
    'conference','networking','training','cpd','awards',
    'auction','expo','industry_meetup','other'
  ));

ALTER TABLE pulse_events ADD CONSTRAINT pulse_events_source_chk
  CHECK (source IN (
    'reinsw','reb','arec','eventbrite',
    'linkedin','domain','realestate','manual'
  ));

ALTER TABLE pulse_events ADD CONSTRAINT pulse_events_status_chk
  CHECK (status IN ('upcoming','attended','skipped','cancelled'));

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pulse_events_event_date ON pulse_events (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_pulse_events_category   ON pulse_events (category);
CREATE INDEX IF NOT EXISTS idx_pulse_events_status     ON pulse_events (status);

-- ── updated_at trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pulse_events_set_updated_at() RETURNS TRIGGER
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_events_updated_at_trg ON pulse_events;
CREATE TRIGGER pulse_events_updated_at_trg
  BEFORE UPDATE ON pulse_events
  FOR EACH ROW EXECUTE FUNCTION pulse_events_set_updated_at();

COMMENT ON TABLE pulse_events IS
  'Industry events (conferences, CPD, auctions, expos). EV01/EV02/EV03 hardening in migration 123.';

-- ── Bonus backfill: pulse_timeline auction_scheduled → pulse_events ───────
-- Expose scheduled auctions discovered via listing detail enrich as
-- prospecting events in the Events tab. Idempotent via unique source_url
-- keyed by the underlying pulse_listings.id.
INSERT INTO pulse_events (
  title, event_date, category, source, source_url,
  location, venue, description, tags, status, created_by
)
SELECT
  CONCAT('Auction: ',
    COALESCE(NULLIF(pl.address, ''), 'listing'),
    CASE WHEN pl.suburb IS NOT NULL AND pl.suburb <> ''
         THEN ' (' || pl.suburb || ')' ELSE '' END
  )                                              AS title,
  pl.auction_date                                AS event_date,
  'auction'                                      AS category,
  'domain'                                       AS source,
  -- Stable pseudo-URL keyed by listing id — used for idempotency
  'pulse-listing://' || pl.id::text              AS source_url,
  pl.suburb                                      AS location,
  pl.address                                     AS venue,
  'Auto-discovered from pulse_timeline listing_auction_scheduled'
                                                 AS description,
  '["auction","prospecting"]'::jsonb             AS tags,
  CASE WHEN pl.auction_date < now() THEN 'attended' ELSE 'upcoming' END AS status,
  NULL                                           AS created_by
FROM pulse_listings pl
WHERE pl.auction_date IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pulse_timeline pt
     WHERE pt.event_type = 'listing_auction_scheduled'
       AND pt.pulse_entity_id = pl.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM pulse_events pe
     WHERE pe.source_url = 'pulse-listing://' || pl.id::text
  );

