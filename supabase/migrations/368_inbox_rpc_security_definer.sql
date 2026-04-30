-- 368_inbox_rpc_security_definer.sql
-- Symptom (2026-04-30): Production inbox renders "Your inbox is empty" even
-- though 2,972 inbox conversations exist and are syncing fresh.
--
-- Root cause: get_inbox_threads is SECURITY INVOKER. Under authenticated RLS
-- context (master_admin user) it ran in ~4,000 ms vs ~24 ms as service role
-- — a 168x slowdown driven by per-row email_messages RLS evaluation across
-- ~5,000 messages. PostgREST timeouts on the slow path; the frontend swallows
-- the error (console.error only) and shows the empty state.
--
-- Fix: switch both inbox helper RPCs to SECURITY DEFINER with an explicit
-- role guard at the top. The guard mirrors the email_conversations RLS
-- policy (master_admin / admin / manager / employee) and runs once per call
-- instead of once per row. RLS still protects direct table access from
-- PostgREST — only these two helper RPCs bypass it, and only after their
-- own authorization check. EXECUTE is revoked from anon and granted to
-- authenticated + service_role.
--
-- The function bodies are otherwise identical to the SECURITY INVOKER
-- versions they replace.

BEGIN;

-- ─── get_inbox_threads ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_inbox_threads(
  p_folder       text     DEFAULT 'inbox',
  p_account_ids  uuid[]   DEFAULT NULL,
  p_search       text     DEFAULT NULL,
  p_unread_only  boolean  DEFAULT false,
  p_limit        integer  DEFAULT 50,
  p_offset       integer  DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role           text;
  v_total          BIGINT;
  v_threads        JSONB;
  v_search_pattern TEXT;
BEGIN
  -- Authorization: same scope as the email_conversations / email_messages
  -- RLS policies. Once-per-call check; failure returns 403 to PostgREST.
  v_role := public.get_user_role();
  IF v_role IS NULL OR NOT (v_role = ANY (ARRAY['master_admin','admin','manager','employee'])) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_search IS NOT NULL AND length(trim(p_search)) > 0 THEN
    v_search_pattern := '%' || lower(trim(p_search)) || '%';
  ELSE
    v_search_pattern := NULL;
  END IF;

  WITH matching_threads AS (
    SELECT
      ec.id, ec.email_account_id, ec.gmail_thread_id, ec.subject, ec.snippet,
      ec.first_message_at, ec.last_message_at, ec.message_count, ec.unread_count,
      ec.participant_count, ec.participants, ec.is_archived, ec.is_deleted,
      ec.is_starred, ec.has_attachments, ec.last_sender, ec.last_sender_name,
      ec.project_id, ec.project_title, ec.agent_id, ec.agency_id, ec.labels,
      ec.created_at, ec.updated_at
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
            AND em.gmail_thread_id  = ec.gmail_thread_id
            AND em.is_sent = true
        )
        WHEN 'draft' THEN EXISTS (
          SELECT 1 FROM email_messages em
          WHERE em.email_account_id = ec.email_account_id
            AND em.gmail_thread_id  = ec.gmail_thread_id
            AND em.is_draft = true
        )
        ELSE true
      END
      AND (NOT p_unread_only OR ec.unread_count > 0)
      AND (
        v_search_pattern IS NULL
        OR lower(COALESCE(ec.subject, ''))          LIKE v_search_pattern
        OR lower(COALESCE(ec.last_sender, ''))      LIKE v_search_pattern
        OR lower(COALESCE(ec.last_sender_name, '')) LIKE v_search_pattern
        OR lower(COALESCE(ec.snippet, ''))          LIKE v_search_pattern
        OR lower(COALESCE(ec.project_title, ''))    LIKE v_search_pattern
      )
  ),
  paginated AS (
    SELECT * FROM matching_threads
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT p_limit OFFSET p_offset
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
            AND em.gmail_thread_id  = p.gmail_thread_id
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
          AND em.gmail_thread_id  = ec.gmail_thread_id
          AND em.is_sent = true
      )
      WHEN 'draft' THEN EXISTS (
        SELECT 1 FROM email_messages em
        WHERE em.email_account_id = ec.email_account_id
          AND em.gmail_thread_id  = ec.gmail_thread_id
          AND em.is_draft = true
      )
      ELSE true
    END
    AND (NOT p_unread_only OR ec.unread_count > 0)
    AND (
      v_search_pattern IS NULL
      OR lower(COALESCE(ec.subject, ''))          LIKE v_search_pattern
      OR lower(COALESCE(ec.last_sender, ''))      LIKE v_search_pattern
      OR lower(COALESCE(ec.last_sender_name, '')) LIKE v_search_pattern
      OR lower(COALESCE(ec.snippet, ''))          LIKE v_search_pattern
      OR lower(COALESCE(ec.project_title, ''))    LIKE v_search_pattern
    );

  RETURN jsonb_build_object(
    'threads',     COALESCE(v_threads -> 'threads', '[]'::jsonb),
    'total_count', v_total,
    'limit',       p_limit,
    'offset',      p_offset,
    'has_more',    (p_offset + p_limit) < v_total
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_inbox_threads(text, uuid[], text, boolean, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_inbox_threads(text, uuid[], text, boolean, integer, integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_inbox_threads(text, uuid[], text, boolean, integer, integer) TO authenticated, service_role;

-- ─── get_inbox_summary_counts ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_inbox_summary_counts(p_account_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role           text;
  v_folder_counts  JSONB;
  v_account_counts JSONB;
  v_total          BIGINT;
  v_total_unread   BIGINT;
BEGIN
  v_role := public.get_user_role();
  IF v_role IS NULL OR NOT (v_role = ANY (ARRAY['master_admin','admin','manager','employee'])) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

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
      SELECT jsonb_build_object('total', COUNT(*), 'unread', COUNT(*) FILTER (WHERE unread_count > 0))
      FROM scoped WHERE is_archived = false AND is_deleted = false
    ),
    'archived', (
      SELECT jsonb_build_object('total', COUNT(*), 'unread', COUNT(*) FILTER (WHERE unread_count > 0))
      FROM scoped WHERE is_archived = true AND is_deleted = false
    ),
    'deleted', (
      SELECT jsonb_build_object('total', COUNT(*), 'unread', COUNT(*) FILTER (WHERE unread_count > 0))
      FROM scoped WHERE is_deleted = true
    ),
    'sent',  (SELECT jsonb_build_object('total', COUNT(*), 'unread', 0) FROM sent_threads),
    'draft', (SELECT jsonb_build_object('total', COUNT(*), 'unread', 0) FROM draft_threads),
    'unread', (
      SELECT jsonb_build_object('total', COUNT(*), 'unread', COUNT(*))
      FROM scoped WHERE unread_count > 0 AND is_archived = false AND is_deleted = false
    )
  ) INTO v_folder_counts;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'account_id',    x.email_account_id,
      'email_address', x.email_address,
      'display_name',  x.display_name,
      'total',         x.total,
      'unread',        x.unread
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
      AND ec.is_deleted  = false
      AND (p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids))
    GROUP BY ec.email_account_id, ea.email_address, ea.display_name
  ) x;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE unread_count > 0)
  INTO v_total, v_total_unread
  FROM email_conversations ec
  WHERE ec.is_archived = false
    AND ec.is_deleted  = false
    AND (p_account_ids IS NULL OR ec.email_account_id = ANY(p_account_ids));

  RETURN jsonb_build_object(
    'folder_counts',  v_folder_counts,
    'account_counts', v_account_counts,
    'all_inboxes', jsonb_build_object('total', v_total, 'unread', v_total_unread)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_inbox_summary_counts(uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_inbox_summary_counts(uuid[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_inbox_summary_counts(uuid[]) TO authenticated, service_role;

COMMIT;
