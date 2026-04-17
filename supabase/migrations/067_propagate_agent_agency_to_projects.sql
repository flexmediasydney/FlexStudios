-- When an agent's current_agency_id is updated, propagate to any of their projects that have no agency_id set
CREATE OR REPLACE FUNCTION propagate_agent_agency_to_projects()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_agency_id IS NOT NULL AND NEW.current_agency_id IS DISTINCT FROM OLD.current_agency_id THEN
    UPDATE projects
    SET agency_id = NEW.current_agency_id, updated_at = now()
    WHERE agent_id = NEW.id AND agency_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_agent_agency ON agents;
CREATE TRIGGER trg_propagate_agent_agency
  AFTER UPDATE OF current_agency_id ON agents
  FOR EACH ROW
  EXECUTE FUNCTION propagate_agent_agency_to_projects();
