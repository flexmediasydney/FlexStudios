-- 075: Auto-detect re-listings of properties we've previously shot
--
-- Business problem: When a former client (or anyone whose property we shot)
-- re-lists, we should know immediately. The property_key bridge makes this trivial.
--
-- Implementation: AFTER INSERT trigger on pulse_listings that fires on truly
-- new rows (not updates from re-scrapes). For each new listing, find any
-- projects with the same property_key and write a project_activity row to
-- each. The project's activity feed will show a re-engagement prompt.
--
-- Idempotency: trigger only fires on INSERT, not UPDATE. Same listingId
-- being re-scraped won't re-trigger because ON CONFLICT DO UPDATE doesn't
-- fire INSERT triggers.

CREATE OR REPLACE FUNCTION notify_projects_of_new_listing() RETURNS TRIGGER AS $$
DECLARE
  matching_project record;
  type_label text;
  price_str text;
BEGIN
  -- Only fire if this listing has a property_key (otherwise no link possible)
  IF NEW.property_key IS NULL THEN RETURN NEW; END IF;

  -- Pretty labels for the activity message
  type_label := CASE NEW.listing_type
    WHEN 'for_sale' THEN 'For Sale'
    WHEN 'for_rent' THEN 'For Rent'
    WHEN 'sold' THEN 'Sold'
    WHEN 'under_contract' THEN 'Under Contract'
    ELSE 'Listed'
  END;

  price_str := CASE
    WHEN NEW.asking_price >= 1000000 THEN '$' || round(NEW.asking_price / 1000000.0, 2)::text || 'M'
    WHEN NEW.asking_price >= 1000 THEN '$' || round(NEW.asking_price / 1000.0)::text || 'K'
    WHEN NEW.asking_price > 0 THEN '$' || NEW.asking_price::text
    ELSE NULL
  END;

  -- Find every project at this property_key
  FOR matching_project IN
    SELECT id, title FROM projects
    WHERE property_key = NEW.property_key
      AND status NOT IN ('cancelled', 'archived')
  LOOP
    -- Write activity entry to that project's feed
    INSERT INTO project_activities (
      project_id, project_title, action, activity_type, description,
      actor_type, actor_source, metadata
    ) VALUES (
      matching_project.id,
      matching_project.title,
      'pulse_relisting_detected',
      'pulse_relisting_detected',
      'REA detected a new ' || type_label || ' listing at this address: '
        || coalesce(NEW.agent_name, 'Unknown agent')
        || coalesce(' (' || NEW.agency_name || ')', '')
        || coalesce(' — ' || price_str, ''),
      'system',
      'pulse_relisting_trigger',
      jsonb_build_object(
        'listing_id', NEW.id,
        'source_listing_id', NEW.source_listing_id,
        'listing_type', NEW.listing_type,
        'asking_price', NEW.asking_price,
        'agent_name', NEW.agent_name,
        'agency_name', NEW.agency_name,
        'source_url', NEW.source_url,
        'property_key', NEW.property_key
      )
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the listing insert if activity write fails
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_projects_of_new_listing ON pulse_listings;
CREATE TRIGGER trg_notify_projects_of_new_listing
  AFTER INSERT ON pulse_listings
  FOR EACH ROW
  EXECUTE FUNCTION notify_projects_of_new_listing();

-- ──────────────────────────────────────────────────────────────────────────
-- Bonus: backfill activity events for the 3 currently-linked properties
-- so their project pages show the re-engagement signal immediately
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO project_activities (
  project_id, project_title, action, activity_type, description,
  actor_type, actor_source, metadata, timestamp
)
SELECT
  p.id,
  p.title,
  'pulse_relisting_detected',
  'pulse_relisting_detected',
  'REA detected a ' || CASE l.listing_type
    WHEN 'for_sale' THEN 'For Sale'
    WHEN 'for_rent' THEN 'For Rent'
    WHEN 'sold' THEN 'Sold'
    ELSE 'Listed'
  END || ' listing at this address: '
    || coalesce(l.agent_name, 'Unknown agent')
    || coalesce(' (' || l.agency_name || ')', '')
    || coalesce(' — $' || (l.asking_price/1000)::text || 'K', ''),
  'system',
  'pulse_relisting_backfill',
  jsonb_build_object(
    'listing_id', l.id,
    'source_listing_id', l.source_listing_id,
    'listing_type', l.listing_type,
    'asking_price', l.asking_price,
    'agent_name', l.agent_name,
    'agency_name', l.agency_name,
    'source_url', l.source_url,
    'property_key', l.property_key
  ),
  coalesce(l.listed_date::timestamptz, l.first_seen_at, now())
FROM projects p
JOIN pulse_listings l ON l.property_key = p.property_key
WHERE p.status NOT IN ('cancelled', 'archived')
  AND NOT EXISTS (
    SELECT 1 FROM project_activities pa
    WHERE pa.project_id = p.id
      AND pa.action = 'pulse_relisting_detected'
      AND (pa.metadata->>'listing_id')::uuid = l.id
  );
