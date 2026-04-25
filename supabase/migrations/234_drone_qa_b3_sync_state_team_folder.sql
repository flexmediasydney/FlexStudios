-- Migration 234: B3 audit fix — webhook auto-ingest was silently broken
--
-- After commit 9e842eb (the Dropbox account swap from joseph@flexmedia.sydney
-- to joseph.saad91@gmail.com / Flex Media team), dropbox-webhook started
-- using WATCH_PATH='/Flex Media Team Folder/Projects'. But the
-- dropbox_sync_state table only had a row for the old path
-- '/FlexMedia/Projects' from the personal-account era.
--
-- processDropboxDelta looks up state by watch_path, finds NULL on the new
-- path, and falls into the initial-seed branch which intentionally emits
-- ZERO project_folder_events (it just records the cursor). Subsequent
-- webhooks then call list_folder/continue from a cursor with no pending
-- changes — so file uploads after the seed never produce events, and the
-- ingest-debounce step queues nothing.
--
-- Fix: insert a row for the new team-folder path. The next webhook fire
-- seeds it; the one after that emits real events.
--
-- The stale '/FlexMedia/Projects' row is harmless (never queried with the
-- new WATCH_PATH constant) but we mark it for cleanup with a comment.

INSERT INTO dropbox_sync_state (watch_path)
VALUES ('/Flex Media Team Folder/Projects')
ON CONFLICT (watch_path) DO NOTHING;

COMMENT ON TABLE dropbox_sync_state IS
  'Per-watch-path Dropbox cursor. The /FlexMedia/Projects row is legacy from '
  'the personal-account era (pre-9e842eb) and can be deleted manually after a '
  'few weeks of confirmed team-account operation. The active watch path is '
  '/Flex Media Team Folder/Projects.';
