-- 081_inbox_summary_counts_rpc.sql
--
-- Problem: the inbox sidebar showed counts derived from the CURRENT PAGE of
-- threads (e.g. "All Inboxes 50 total" and per-account 7/10/15/4/14 summing
-- to 50), not true totals across the whole inbox. Same issue for the Folders
-- ("Inbox 50"), which was showing the visible page size rather than the
-- 2,248 conversations that actually exist.
--
-- Fix: a single RPC returning per-folder AND per-account totals (plus unread
-- counts) in one round-trip. Backed by `email_conversations` (one row per
-- thread) so each total is COUNT() over rows directly — no message grouping.
--
-- The frontend calls this with a 60s staleTime / refetchInterval via React
-- Query, so we're not hammering the DB.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_inbox_summary_counts(
  p_account_ids UUID[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_folder_counts JSONB;
  v_account_counts JSONB;
  v_total BIGINT;
  v_total_unread BIGINT;
BEGIN
  -- Folder counts: total + unread for each bucket across the scoped accounts.
  -- "sent" / "draft" require peeking at individual messages (flags live there).
  WITH scoped AS (
    SELECT *
    FROM email_conversations ec
    WHERE p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids)
  ),
  sent_threads AS (
    SELECT DISTINCT em.email_account_id, em.gmail_thread_id
    FROM email_messages em
    WHERE em.is_sent = true
      AND (p_account_ids IS NULL OR em.email_account_id = ANY(p_account_ids))
  ),
  draft_threads AS (
    SELECT DISTINCT em.email_account_id, em.gmail_thread_id
    FROM email_messages em
    WHERE em.is_draft = true
      AND (p_account_ids IS NULL OR em.email_account_id = ANY(p_account_ids))
  )
  SELECT jsonb_build_object(
    'inbox', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'unread', COUNT(*) FILTER (WHERE unread_count > 0)
      )
      FROM scoped
      WHERE is_archived = false AND is_deleted = false
    ),
    'archived', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'unread', COUNT(*) FILTER (WHERE unread_count > 0)
      )
      FROM scoped
      WHERE is_archived = true AND is_deleted = false
    ),
    'deleted', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'unread', COUNT(*) FILTER (WHERE unread_count > 0)
      )
      FROM scoped
      WHERE is_deleted = true
    ),
    'sent', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'unread', 0
      )
      FROM sent_threads
    ),
    'draft', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'unread', 0
      )
      FROM draft_threads
    ),
    'unread', (
      SELECT jsonb_build_object(
        'total', COUNT(*),
        'unread', COUNT(*)
      )
      FROM scoped
      WHERE unread_count > 0 AND is_archived = false AND is_deleted = false
    )
  ) INTO v_folder_counts;

  -- Per-account counts (inbox only — matches "All Inboxes" semantics).
  -- Returned as an array so the client can preserve order if it wants.
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'account_id',     x.email_account_id,
      'email_address',  x.email_address,
      'display_name',   x.display_name,
      'total',          x.total,
      'unread',         x.unread
    )
    ORDER BY x.total DESC
  ), '[]'::jsonb)
  INTO v_account_counts
  FROM (
    SELECT
      ec.email_account_id,
      ea.email_address,
      ea.display_name,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ec.unread_count > 0) AS unread
    FROM email_conversations ec
    JOIN email_accounts ea ON ea.id = ec.email_account_id
    WHERE ec.is_archived = false
      AND ec.is_deleted = false
      AND (p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids))
    GROUP BY ec.email_account_id, ea.email_address, ea.display_name
  ) x;

  -- Grand totals (inbox folder — unarchived, undeleted) for "All Inboxes".
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE unread_count > 0)
  INTO v_total, v_total_unread
  FROM email_conversations ec
  WHERE ec.is_archived = false
    AND ec.is_deleted = false
    AND (p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids));

  RETURN jsonb_build_object(
    'folder_counts',   v_folder_counts,
    'account_counts',  v_account_counts,
    'all_inboxes', jsonb_build_object(
      'total',  v_total,
      'unread', v_total_unread
    )
  );
END;
$$;

COMMENT ON FUNCTION public.get_inbox_summary_counts IS
  'Returns true per-folder and per-account thread totals for the inbox sidebar. Fixes the bug where sidebar counts reflected the current page of threads instead of the full mailbox.';

GRANT EXECUTE ON FUNCTION public.get_inbox_summary_counts TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inbox_summary_counts TO service_role;
GRANT EXECUTE ON FUNCTION public.get_inbox_summary_counts TO anon;

COMMIT;
