-- ============================================================================
-- 009_enable_realtime.sql
-- Enable Supabase Realtime on key tables for live subscriptions
-- ============================================================================
-- This allows the frontend to subscribe to postgres_changes events
-- via the Supabase Realtime engine. Without this, the subscribe() calls
-- in base44Client.js will connect but receive no events.
--
-- Tables chosen are those actively subscribed to in the frontend:
--   - notifications           → NotificationContext, NotificationsPulse, TeamPulsePage
--   - projects                → StagePipeline, KanbanBoard, ConcurrentEditDetector
--   - project_tasks           → TaskManagement, ActiveTimersPanel
--   - calendar_events         → Calendar page, ProjectCalendarEvents
--   - email_messages          → EmailThreadViewer, EmailInboxMain
--   - task_time_logs          → TaskTimeLoggerRobust, EffortTimersTab
--   - project_activities      → RealtimeActivityStream, ProjectActivityFeed
--   - team_activity_feeds     → TeamPulsePage live feed
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE projects,
                                              project_tasks,
                                              calendar_events,
                                              email_messages,
                                              notifications,
                                              task_time_logs,
                                              project_activities,
                                              team_activity_feeds;
