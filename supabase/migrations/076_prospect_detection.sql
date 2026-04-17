-- 076: Upgrade re-listing trigger to detect prospect opportunities
--
-- Business insight: a property re-listing is only valuable when the NEW agent/agency
-- is different from the previous one we worked with. That's when it's a prospect
-- opportunity — target the new (non-client) agent with a case-study campaign
-- comparing our prior media vs their current media.
--
-- Logic: when firing the activity event, compare the new listing's agent to:
--   - The project's current agent (via projects.agent_id → agents.rea_agent_id)
--   - The project's current agency_id
-- If different → flag metadata.is_prospect_opportunity = true

CREATE OR REPLACE FUNCTION notify_projects_of_new_listing() RETURNS TRIGGER AS $$
DECLARE
  matching_project record;
  project_agent_rea_id text;
  project_agency_id uuid;
  is_different_agent boolean;
  is_different_agency boolean;
  type_label text;
  price_str text;
  prospect_marker text;
BEGIN
  IF NEW.property_key IS NULL THEN RETURN NEW; END IF;

  type_label := CASE NEW.listing_type
    WHEN 'for_sale' THEN 'For Sale'
    WHEN 'for_rent' THEN 'For Rent'
    WHEN 'sold' THEN 'Sold'
    WHEN 'under_contract' THEN 'Under Contract'
    ELSE 'Listed'
  END;

  price_str := CASE
    WHEN NEW.asking_price >= 1000000 THEN '$' || to_char(NEW.asking_price/1000000.0, 'FM999.0') || 'M'
    WHEN NEW.asking_price >= 1000 THEN '$' || to_char(NEW.asking_price/1000.0, 'FM999') || 'K'
    WHEN NEW.asking_price > 0 THEN '$' || to_char(NEW.asking_price, 'FM999')
    ELSE NULL
  END;

  FOR matching_project IN
    SELECT p.id, p.title, p.agent_id, p.agency_id,
           a.rea_agent_id AS agent_rea_id
    FROM projects p
    LEFT JOIN agents a ON a.id = p.agent_id
    WHERE p.property_key = NEW.property_key
      AND p.status NOT IN ('cancelled', 'archived')
  LOOP
    project_agent_rea_id := matching_project.agent_rea_id;
    project_agency_id := matching_project.agency_id;

    -- Different agent/agency = prospect opportunity
    is_different_agent := (
      NEW.agent_rea_id IS NOT NULL
      AND project_agent_rea_id IS NOT NULL
      AND NEW.agent_rea_id::text != project_agent_rea_id::text
    );
    is_different_agency := (
      NEW.agency_rea_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM agencies ag
        WHERE ag.id = project_agency_id
          AND ag.rea_agency_id::text != NEW.agency_rea_id::text
      )
    );

    prospect_marker := CASE
      WHEN is_different_agent OR is_different_agency THEN ' 🎯 Prospect opportunity — different agent'
      ELSE ''
    END;

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
        || coalesce(' — ' || price_str, '')
        || prospect_marker,
      'system',
      'pulse_relisting_trigger',
      jsonb_build_object(
        'listing_id', NEW.id,
        'source_listing_id', NEW.source_listing_id,
        'listing_type', NEW.listing_type,
        'asking_price', NEW.asking_price,
        'agent_name', NEW.agent_name,
        'agent_rea_id', NEW.agent_rea_id,
        'agency_name', NEW.agency_name,
        'agency_rea_id', NEW.agency_rea_id,
        'source_url', NEW.source_url,
        'property_key', NEW.property_key,
        'is_prospect_opportunity', is_different_agent OR is_different_agency,
        'project_agent_rea_id', project_agent_rea_id
      )
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-emit prospect marker on existing backfilled events using the same logic
UPDATE project_activities pa
SET
  metadata = pa.metadata || jsonb_build_object(
    'is_prospect_opportunity',
    (
      SELECT (
        NEW_AGENT.agent_rea_id IS NOT NULL
        AND a.rea_agent_id IS NOT NULL
        AND NEW_AGENT.agent_rea_id::text != a.rea_agent_id::text
      )
      FROM projects p
      LEFT JOIN agents a ON a.id = p.agent_id
      LEFT JOIN pulse_listings NEW_AGENT ON NEW_AGENT.id = (pa.metadata->>'listing_id')::uuid
      WHERE p.id = pa.project_id
      LIMIT 1
    )
  )
WHERE pa.action = 'pulse_relisting_detected';
