-- ============================================================================
-- 041: Expand entity_access_rules with 10 additional entity types
-- ============================================================================
-- Adds: projects, agencies, agents, project_tasks, calendar_events,
--       email_messages, notifications, org_notes, interaction_logs,
--       external_listings, page_access
-- Total after: 22 entity types x 5 roles = 110 rows

INSERT INTO entity_access_rules (role, entity_type, access_level) VALUES
  -- projects
  ('master_admin', 'projects', 'edit'),
  ('admin', 'projects', 'edit'),
  ('manager', 'projects', 'edit'),
  ('employee', 'projects', 'edit'),
  ('contractor', 'projects', 'view'),
  -- agencies
  ('master_admin', 'agencies', 'edit'),
  ('admin', 'agencies', 'edit'),
  ('manager', 'agencies', 'edit'),
  ('employee', 'agencies', 'view'),
  ('contractor', 'agencies', 'none'),
  -- agents
  ('master_admin', 'agents', 'edit'),
  ('admin', 'agents', 'edit'),
  ('manager', 'agents', 'edit'),
  ('employee', 'agents', 'view'),
  ('contractor', 'agents', 'none'),
  -- project_tasks
  ('master_admin', 'project_tasks', 'edit'),
  ('admin', 'project_tasks', 'edit'),
  ('manager', 'project_tasks', 'edit'),
  ('employee', 'project_tasks', 'edit'),
  ('contractor', 'project_tasks', 'view'),
  -- calendar_events
  ('master_admin', 'calendar_events', 'edit'),
  ('admin', 'calendar_events', 'edit'),
  ('manager', 'calendar_events', 'edit'),
  ('employee', 'calendar_events', 'edit'),
  ('contractor', 'calendar_events', 'view'),
  -- email_messages
  ('master_admin', 'email_messages', 'edit'),
  ('admin', 'email_messages', 'edit'),
  ('manager', 'email_messages', 'edit'),
  ('employee', 'email_messages', 'edit'),
  ('contractor', 'email_messages', 'none'),
  -- notifications
  ('master_admin', 'notifications', 'edit'),
  ('admin', 'notifications', 'edit'),
  ('manager', 'notifications', 'edit'),
  ('employee', 'notifications', 'edit'),
  ('contractor', 'notifications', 'view'),
  -- org_notes
  ('master_admin', 'org_notes', 'edit'),
  ('admin', 'org_notes', 'edit'),
  ('manager', 'org_notes', 'edit'),
  ('employee', 'org_notes', 'edit'),
  ('contractor', 'org_notes', 'view'),
  -- interaction_logs
  ('master_admin', 'interaction_logs', 'edit'),
  ('admin', 'interaction_logs', 'edit'),
  ('manager', 'interaction_logs', 'edit'),
  ('employee', 'interaction_logs', 'view'),
  ('contractor', 'interaction_logs', 'none'),
  -- external_listings
  ('master_admin', 'external_listings', 'edit'),
  ('admin', 'external_listings', 'edit'),
  ('manager', 'external_listings', 'edit'),
  ('employee', 'external_listings', 'view'),
  ('contractor', 'external_listings', 'none'),
  -- page_access (unified with route access)
  ('master_admin', 'page_access', 'edit'),
  ('admin', 'page_access', 'edit'),
  ('manager', 'page_access', 'view'),
  ('employee', 'page_access', 'view'),
  ('contractor', 'page_access', 'view')
ON CONFLICT (role, entity_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
