-- Missing indexes for common calendar queries
CREATE INDEX IF NOT EXISTS idx_calendar_events_agent_id ON calendar_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_agency_id ON calendar_events(agency_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_event_source ON calendar_events(event_source);
CREATE INDEX IF NOT EXISTS idx_calendar_events_is_done ON calendar_events(is_done);
CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_start ON calendar_events(owner_user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_project_start ON calendar_events(project_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_owner ON calendar_connections(owner_user_id, is_enabled);
