-- 071_email_inbox_threads_rpc.sql
--
-- Problem: The inbox displays email THREADS (messages grouped by gmail_thread_id)
-- but was paginating MESSAGES (LIMIT 50 on email_messages). With an average of
-- ~1.4 messages per thread, 50 messages collapsed into ~45 threads — so users
-- were seeing "only 45 emails" even though the DB held 3,029 visible messages
-- spanning ~1,735 threads.
--
-- Fix: introduce a server-side RPC that returns N whole THREADS per page, each
-- with its full message array pre-aggregated as JSONB. The frontend switches to
-- calling this RPC instead of filter-paginating raw messages. This fixes the
-- "45 emails" count AND removes the 3000-message client-side grouping pass from
-- the hot path.
--
-- Also: backfill `email_conversations` for the 680 thread-account pairs that
-- had messages but no conversation row, and add a trigger so any new message
-- immediately upserts its conversation row. This keeps conversation metadata
-- (last_message_at, message_count, unread_count) in sync even if the Gmail
-- sync function fails mid-run.

BEGIN;

-- ─── 1. Backfill missing email_conversations rows ───────────────────────────
-- For every (email_account_id, gmail_thread_id) pair present in email_messages
-- but missing from email_conversations, create a conversation summary row.

INSERT INTO email_conversations (
  email_account_id,
  gmail_thread_id,
  subject,
  snippet,
  first_message_at,
  last_message_at,
  message_count,
  unread_count,
  participant_count,
  participants,
  is_starred,
  is_archived,
  is_deleted,
  has_attachments,
  last_sender,
  last_sender_name,
  project_id,
  project_title,
  agent_id,
  agency_id,
  labels,
  created_at,
  updated_at
)
SELECT
  em.email_account_id,
  em.gmail_thread_id,
  (array_agg(em.subject ORDER BY em.received_at DESC) FILTER (WHERE em.subject IS NOT NULL))[1] AS subject,
  SUBSTRING(
    COALESCE(
      (array_agg(em.snippet ORDER BY em.received_at DESC) FILTER (WHERE em.snippet IS NOT NULL))[1],
      (array_agg(em.subject ORDER BY em.received_at DESC) FILTER (WHERE em.subject IS NOT NULL))[1],
      ''
    ) FROM 1 FOR 200
  ) AS snippet,
  MIN(em.received_at) AS first_message_at,
  MAX(em.received_at) AS last_message_at,
  COUNT(*) AS message_count,
  COUNT(*) FILTER (WHERE em.is_unread = true) AS unread_count,
  COUNT(DISTINCT em.from) AS participant_count,
  COALESCE(
    jsonb_agg(DISTINCT em.from) FILTER (WHERE em.from IS NOT NULL),
    '[]'::jsonb
  ) AS participants,
  bool_or(COALESCE(em.is_starred, false)) AS is_starred,
  bool_and(COALESCE(em.is_archived, false)) AS is_archived,
  bool_and(COALESCE(em.is_deleted, false)) AS is_deleted,
  bool_or(jsonb_array_length(COALESCE(em.attachments, '[]'::jsonb)) > 0) AS has_attachments,
  (array_agg(em.from ORDER BY em.received_at DESC) FILTER (WHERE em.from IS NOT NULL))[1] AS last_sender,
  (array_agg(em.from_name ORDER BY em.received_at DESC) FILTER (WHERE em.from_name IS NOT NULL))[1] AS last_sender_name,
  (array_agg(em.project_id ORDER BY em.received_at DESC) FILTER (WHERE em.project_id IS NOT NULL))[1] AS project_id,
  (array_agg(em.project_title ORDER BY em.received_at DESC) FILTER (WHERE em.project_title IS NOT NULL))[1] AS project_title,
  (array_agg(em.agent_id ORDER BY em.received_at DESC) FILTER (WHERE em.agent_id IS NOT NULL))[1] AS agent_id,
  (array_agg(em.agency_id ORDER BY em.received_at DESC) FILTER (WHERE em.agency_id IS NOT NULL))[1] AS agency_id,
  '[]'::jsonb AS labels,
  NOW() AS created_at,
  NOW() AS updated_at
FROM email_messages em
WHERE em.gmail_thread_id IS NOT NULL
  AND em.email_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM email_conversations ec
    WHERE ec.email_account_id = em.email_account_id
      AND ec.gmail_thread_id = em.gmail_thread_id
  )
GROUP BY em.email_account_id, em.gmail_thread_id
ON CONFLICT (email_account_id, gmail_thread_id) DO NOTHING;


-- ─── 2. Trigger: keep email_conversations in sync with email_messages ───────
-- Every insert/update/delete on email_messages recomputes the affected
-- conversation row. If the thread has no remaining messages, delete the
-- conversation. Otherwise, upsert summary fields.

CREATE OR REPLACE FUNCTION public.refresh_email_conversation(
  p_email_account_id UUID,
  p_gmail_thread_id TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_msg_count INT;
BEGIN
  IF p_email_account_id IS NULL OR p_gmail_thread_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_msg_count
  FROM email_messages
  WHERE email_account_id = p_email_account_id
    AND gmail_thread_id = p_gmail_thread_id;

  IF v_msg_count = 0 THEN
    DELETE FROM email_conversations
    WHERE email_account_id = p_email_account_id
      AND gmail_thread_id = p_gmail_thread_id;
    RETURN;
  END IF;

  INSERT INTO email_conversations (
    email_account_id,
    gmail_thread_id,
    subject,
    snippet,
    first_message_at,
    last_message_at,
    message_count,
    unread_count,
    participant_count,
    participants,
    is_starred,
    is_archived,
    is_deleted,
    has_attachments,
    last_sender,
    last_sender_name,
    project_id,
    project_title,
    agent_id,
    agency_id,
    updated_at
  )
  SELECT
    em.email_account_id,
    em.gmail_thread_id,
    (array_agg(em.subject ORDER BY em.received_at DESC) FILTER (WHERE em.subject IS NOT NULL))[1],
    SUBSTRING(
      COALESCE(
        (array_agg(em.snippet ORDER BY em.received_at DESC) FILTER (WHERE em.snippet IS NOT NULL))[1],
        (array_agg(em.subject ORDER BY em.received_at DESC) FILTER (WHERE em.subject IS NOT NULL))[1],
        ''
      ) FROM 1 FOR 200
    ),
    MIN(em.received_at),
    MAX(em.received_at),
    COUNT(*),
    COUNT(*) FILTER (WHERE em.is_unread = true),
    COUNT(DISTINCT em.from),
    COALESCE(jsonb_agg(DISTINCT em.from) FILTER (WHERE em.from IS NOT NULL), '[]'::jsonb),
    bool_or(COALESCE(em.is_starred, false)),
    bool_and(COALESCE(em.is_archived, false)),
    bool_and(COALESCE(em.is_deleted, false)),
    bool_or(jsonb_array_length(COALESCE(em.attachments, '[]'::jsonb)) > 0),
    (array_agg(em.from ORDER BY em.received_at DESC) FILTER (WHERE em.from IS NOT NULL))[1],
    (array_agg(em.from_name ORDER BY em.received_at DESC) FILTER (WHERE em.from_name IS NOT NULL))[1],
    (array_agg(em.project_id ORDER BY em.received_at DESC) FILTER (WHERE em.project_id IS NOT NULL))[1],
    (array_agg(em.project_title ORDER BY em.received_at DESC) FILTER (WHERE em.project_title IS NOT NULL))[1],
    (array_agg(em.agent_id ORDER BY em.received_at DESC) FILTER (WHERE em.agent_id IS NOT NULL))[1],
    (array_agg(em.agency_id ORDER BY em.received_at DESC) FILTER (WHERE em.agency_id IS NOT NULL))[1],
    NOW()
  FROM email_messages em
  WHERE em.email_account_id = p_email_account_id
    AND em.gmail_thread_id = p_gmail_thread_id
  GROUP BY em.email_account_id, em.gmail_thread_id
  ON CONFLICT (email_account_id, gmail_thread_id) DO UPDATE SET
    subject = EXCLUDED.subject,
    snippet = EXCLUDED.snippet,
    first_message_at = EXCLUDED.first_message_at,
    last_message_at = EXCLUDED.last_message_at,
    message_count = EXCLUDED.message_count,
    unread_count = EXCLUDED.unread_count,
    participant_count = EXCLUDED.participant_count,
    participants = EXCLUDED.participants,
    is_starred = EXCLUDED.is_starred,
    is_archived = EXCLUDED.is_archived,
    is_deleted = EXCLUDED.is_deleted,
    has_attachments = EXCLUDED.has_attachments,
    last_sender = EXCLUDED.last_sender,
    last_sender_name = EXCLUDED.last_sender_name,
    -- Only overwrite project/agent/agency fields if the new aggregate has values;
    -- otherwise keep the existing link so a single un-linked reply doesn't null
    -- out a whole thread's linkage.
    project_id = COALESCE(EXCLUDED.project_id, email_conversations.project_id),
    project_title = COALESCE(EXCLUDED.project_title, email_conversations.project_title),
    agent_id = COALESCE(EXCLUDED.agent_id, email_conversations.agent_id),
    agency_id = COALESCE(EXCLUDED.agency_id, email_conversations.agency_id),
    updated_at = NOW();
END;
$$;

-- Trigger function: dispatches to refresh_email_conversation after mutations
CREATE OR REPLACE FUNCTION public.trg_refresh_email_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_email_conversation(OLD.email_account_id, OLD.gmail_thread_id);
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE
  PERFORM refresh_email_conversation(NEW.email_account_id, NEW.gmail_thread_id);

  -- If the thread_id changed (rare, but possible when re-threading), also
  -- refresh the old thread to cleanup
  IF TG_OP = 'UPDATE' AND (
    OLD.email_account_id IS DISTINCT FROM NEW.email_account_id
    OR OLD.gmail_thread_id IS DISTINCT FROM NEW.gmail_thread_id
  ) THEN
    PERFORM refresh_email_conversation(OLD.email_account_id, OLD.gmail_thread_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_messages_refresh_conversation ON email_messages;
CREATE TRIGGER email_messages_refresh_conversation
AFTER INSERT OR UPDATE OR DELETE ON email_messages
FOR EACH ROW EXECUTE FUNCTION trg_refresh_email_conversation();


-- ─── 3. RPC: get_inbox_threads ──────────────────────────────────────────────
-- Returns N whole threads with their messages pre-aggregated as JSONB.
-- This replaces the "fetch 50 messages then group client-side" pattern that
-- caused the "only 45 emails" bug.
--
-- Parameters:
--   p_folder      text: 'inbox' | 'sent' | 'draft' | 'archived' | 'deleted'
--   p_account_ids uuid[]: filter to specific accounts, NULL = all
--   p_search      text: optional case-insensitive search across subject,
--                 last_sender, last_sender_name, snippet (use % wildcards,
--                 caller may pass NULL or '' to skip)
--   p_unread_only bool: only threads with at least 1 unread message
--   p_limit       int: page size (thread count)
--   p_offset      int: pagination offset (thread count)
--
-- Returns a single column `result` containing:
--   { threads: [{ ...thread fields, messages: [...] }, ...], total_count: N }

CREATE OR REPLACE FUNCTION public.get_inbox_threads(
  p_folder TEXT DEFAULT 'inbox',
  p_account_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_unread_only BOOLEAN DEFAULT false,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total BIGINT;
  v_threads JSONB;
  v_search_pattern TEXT;
BEGIN
  -- Normalize search
  IF p_search IS NOT NULL AND length(trim(p_search)) > 0 THEN
    v_search_pattern := '%' || lower(trim(p_search)) || '%';
  ELSE
    v_search_pattern := NULL;
  END IF;

  -- Build a CTE of matching threads (driven by email_conversations for speed)
  WITH matching_threads AS (
    SELECT
      ec.id,
      ec.email_account_id,
      ec.gmail_thread_id,
      ec.subject,
      ec.snippet,
      ec.first_message_at,
      ec.last_message_at,
      ec.message_count,
      ec.unread_count,
      ec.participant_count,
      ec.participants,
      ec.is_archived,
      ec.is_deleted,
      ec.is_starred,
      ec.has_attachments,
      ec.last_sender,
      ec.last_sender_name,
      ec.project_id,
      ec.project_title,
      ec.agent_id,
      ec.agency_id,
      ec.labels,
      ec.created_at,
      ec.updated_at
    FROM email_conversations ec
    WHERE
      -- Account filter
      (p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids))
      -- Folder filter
      AND CASE p_folder
        WHEN 'inbox'    THEN ec.is_archived = false AND ec.is_deleted = false
        WHEN 'archived' THEN ec.is_archived = true AND ec.is_deleted = false
        WHEN 'deleted'  THEN ec.is_deleted  = true
        -- For sent/draft, fall back to message-level check: include threads
        -- where ANY message matches the flag
        WHEN 'sent' THEN EXISTS (
          SELECT 1 FROM email_messages em
          WHERE em.email_account_id = ec.email_account_id
            AND em.gmail_thread_id = ec.gmail_thread_id
            AND em.is_sent = true
        )
        WHEN 'draft' THEN EXISTS (
          SELECT 1 FROM email_messages em
          WHERE em.email_account_id = ec.email_account_id
            AND em.gmail_thread_id = ec.gmail_thread_id
            AND em.is_draft = true
        )
        ELSE true
      END
      -- Unread filter
      AND (NOT p_unread_only OR ec.unread_count > 0)
      -- Search filter (subject, sender, snippet)
      AND (
        v_search_pattern IS NULL
        OR lower(COALESCE(ec.subject, '')) LIKE v_search_pattern
        OR lower(COALESCE(ec.last_sender, '')) LIKE v_search_pattern
        OR lower(COALESCE(ec.last_sender_name, '')) LIKE v_search_pattern
        OR lower(COALESCE(ec.snippet, '')) LIKE v_search_pattern
        OR lower(COALESCE(ec.project_title, '')) LIKE v_search_pattern
      )
  ),
  paginated AS (
    SELECT *
    FROM matching_threads
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT p_limit
    OFFSET p_offset
  ),
  with_messages AS (
    SELECT
      p.*,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', em.id,
              'email_account_id', em.email_account_id,
              'gmail_message_id', em.gmail_message_id,
              'gmail_thread_id', em.gmail_thread_id,
              'from', em.from,
              'from_name', em.from_name,
              'to', em.to,
              'cc', em.cc,
              'bcc', em.bcc,
              'subject', em.subject,
              'body', em.body,
              'snippet', em.snippet,
              'is_unread', em.is_unread,
              'is_starred', em.is_starred,
              'is_draft', em.is_draft,
              'is_sent', em.is_sent,
              'is_deleted', em.is_deleted,
              'is_archived', em.is_archived,
              'is_visible', em.is_visible,
              'attachments', em.attachments,
              'received_at', em.received_at,
              'received_date', em.received_at,
              'visibility', em.visibility,
              'project_id', em.project_id,
              'project_title', em.project_title,
              'label_ids', em.label_ids,
              'labels', em.labels,
              'header_message_id', em.header_message_id,
              'in_reply_to', em.in_reply_to,
              'references_header', em.references_header,
              'agent_id', em.agent_id,
              'agency_id', em.agency_id,
              'agent_name', em.agent_name,
              'agency_name', em.agency_name,
              'priority', em.priority,
              'snoozed_until', em.snoozed_until,
              'assigned_to', em.assigned_to,
              'created_at', em.created_at,
              'created_date', em.created_at,
              'updated_at', em.updated_at,
              'updated_date', em.updated_at
            )
            ORDER BY em.received_at ASC
          )
          FROM email_messages em
          WHERE em.email_account_id = p.email_account_id
            AND em.gmail_thread_id = p.gmail_thread_id
        ),
        '[]'::jsonb
      ) AS messages
    FROM paginated p
  )
  SELECT
    jsonb_build_object(
      'threads', COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', w.id,
          'email_account_id', w.email_account_id,
          'gmail_thread_id', w.gmail_thread_id,
          'threadId', w.gmail_thread_id,
          'uniqueKey', w.email_account_id || '|||' || w.gmail_thread_id,
          'subject', w.subject,
          'snippet', w.snippet,
          'first_message_at', w.first_message_at,
          'last_message_at', w.last_message_at,
          'lastMessage', w.last_message_at,
          'message_count', w.message_count,
          'unread_count', w.unread_count,
          'unreadCount', w.unread_count,
          'participant_count', w.participant_count,
          'participants', w.participants,
          'is_archived', w.is_archived,
          'is_deleted', w.is_deleted,
          'is_starred', w.is_starred,
          'has_attachments', w.has_attachments,
          'last_sender', w.last_sender,
          'last_sender_name', w.last_sender_name,
          'from', COALESCE(w.last_sender_name, w.last_sender),
          'from_name', w.last_sender_name,
          'from_email', w.last_sender,
          'project_id', w.project_id,
          'project_title', w.project_title,
          'agent_id', w.agent_id,
          'agency_id', w.agency_id,
          'agent_name', NULL,
          'agency_name', NULL,
          'labels', w.labels,
          'created_at', w.created_at,
          'updated_at', w.updated_at,
          'messages', w.messages
        )
        ORDER BY w.last_message_at DESC NULLS LAST
      ), '[]'::jsonb)
    )
  INTO v_threads
  FROM with_messages w;

  -- Get total count (for pagination metadata)
  SELECT COUNT(*) INTO v_total
  FROM email_conversations ec
  WHERE
    (p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids))
    AND CASE p_folder
      WHEN 'inbox'    THEN ec.is_archived = false AND ec.is_deleted = false
      WHEN 'archived' THEN ec.is_archived = true AND ec.is_deleted = false
      WHEN 'deleted'  THEN ec.is_deleted  = true
      WHEN 'sent' THEN EXISTS (
        SELECT 1 FROM email_messages em
        WHERE em.email_account_id = ec.email_account_id
          AND em.gmail_thread_id = ec.gmail_thread_id
          AND em.is_sent = true
      )
      WHEN 'draft' THEN EXISTS (
        SELECT 1 FROM email_messages em
        WHERE em.email_account_id = ec.email_account_id
          AND em.gmail_thread_id = ec.gmail_thread_id
          AND em.is_draft = true
      )
      ELSE true
    END
    AND (NOT p_unread_only OR ec.unread_count > 0)
    AND (
      v_search_pattern IS NULL
      OR lower(COALESCE(ec.subject, '')) LIKE v_search_pattern
      OR lower(COALESCE(ec.last_sender, '')) LIKE v_search_pattern
      OR lower(COALESCE(ec.last_sender_name, '')) LIKE v_search_pattern
      OR lower(COALESCE(ec.snippet, '')) LIKE v_search_pattern
      OR lower(COALESCE(ec.project_title, '')) LIKE v_search_pattern
    );

  RETURN jsonb_build_object(
    'threads', COALESCE(v_threads -> 'threads', '[]'::jsonb),
    'total_count', v_total,
    'limit', p_limit,
    'offset', p_offset,
    'has_more', (p_offset + p_limit) < v_total
  );
END;
$$;

COMMENT ON FUNCTION public.get_inbox_threads IS
  'Returns N whole email threads with messages pre-aggregated. Fixes the "45 emails" bug where paginating messages (50 per page) collapsed into only ~45 threads client-side. Always paginate by THREAD, not by message.';

-- Allow authenticated users (and service role) to call the function
GRANT EXECUTE ON FUNCTION public.get_inbox_threads TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inbox_threads TO service_role;
GRANT EXECUTE ON FUNCTION public.get_inbox_threads TO anon;

COMMIT;
