-- 116_timeline_event_registry.sql
-- Fix B30: pulse_timeline.event_type is free-text. Any typo or case drift
-- writes silently. Add a lookup registry of known types + a trigger that
-- logs unknown types to stderr (non-fatal so scrapes don't break, but
-- visible in postgres logs for Ops to catch new drift).
--
-- Not a CHECK constraint — those would fail migrations mid-flight if
-- existing data has legacy values we haven't registered.

BEGIN;

CREATE TABLE IF NOT EXISTS pulse_timeline_event_types (
  event_type TEXT PRIMARY KEY,
  category   TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  -- Existing (pre-ship)
  ('first_seen',                 'system',  'Entity first detected'),
  ('agency_change',              'movement','Agent moved agencies'),
  ('new_listings_detected',      'market',  'Bulk new listings detected in sync'),
  ('client_new_listing',         'market',  'CRM client has new listing'),
  ('price_change',               'market',  'Listing price changed'),
  ('status_change',              'market',  'Listing status changed'),
  ('listing_new',                'market',  'Single new listing'),
  ('listing_sold',               'market',  'Listing marked as sold'),
  ('rating_change',              'agent',   'Agent rating changed'),
  ('title_change',               'agent',   'Agent job title changed'),
  ('crm_mapped',                 'mapping', 'Entity auto-mapped to CRM'),
  ('crm_added',                  'mapping', 'Entity added to CRM'),
  ('cron_dispatched',            'system',  'Cron fired'),
  ('scheduled_scrape_started',   'system',  'Scheduled scrape started'),
  ('scheduled_scrape_completed', 'system',  'Scheduled scrape completed'),
  ('data_sync',                  'system',  'Generic data sync event'),
  ('coverage_report',            'system',  'Coverage watchdog report'),
  ('tonomo_drift',               'system',  'Tonomo drift detection'),
  -- Detail-enrichment (migration 108+)
  ('detail_enriched',            'system',  'Listing fields refreshed via memo23'),
  ('agent_email_discovered',     'contact', 'New agent email added to alternates'),
  ('agent_mobile_discovered',    'contact', 'New agent mobile added to alternates'),
  ('agent_email_changed',        'contact', 'Agent primary email promoted (new>old confidence)'),
  ('agent_mobile_changed',       'contact', 'Agent primary mobile promoted'),
  ('agency_contact_discovered',  'contact', 'Agency email/phone first populated or added'),
  ('listing_auction_scheduled',  'market',  'Auction date captured from detail page'),
  ('listing_floorplan_added',    'media',   'Floorplan URL(s) captured'),
  ('listing_video_added',        'media',   'YouTube video URL captured'),
  ('listing_withdrawn',          'market',  'Listing disappeared from REA without being sold'),
  ('sold_date_captured',         'market',  'Exact sold_date obtained from detail page')
ON CONFLICT (event_type) DO UPDATE SET
  category = EXCLUDED.category,
  description = EXCLUDED.description;

-- ── Drift warning trigger ─────────────────────────────────────────────
-- Logs a WARNING when an unknown event_type is inserted. Non-fatal so
-- scrapes keep running; Ops can grep postgres logs for new types.
CREATE OR REPLACE FUNCTION pulse_timeline_event_type_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pulse_timeline_event_types WHERE event_type = NEW.event_type)
  THEN
    RAISE WARNING 'Unknown pulse_timeline.event_type: % (from source=%). Add to pulse_timeline_event_types.',
      NEW.event_type, COALESCE(NEW.source, 'unknown');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_timeline_event_type_guard_trg ON pulse_timeline;
CREATE TRIGGER pulse_timeline_event_type_guard_trg
  BEFORE INSERT ON pulse_timeline
  FOR EACH ROW EXECUTE FUNCTION pulse_timeline_event_type_guard();

COMMENT ON TABLE pulse_timeline_event_types IS
  'Registry of known event_type values. Inserts with unknown types get a '
  'WARNING log (non-fatal). Keep in sync with PulseTimeline.jsx EVENT_CONFIG.';

COMMIT;
