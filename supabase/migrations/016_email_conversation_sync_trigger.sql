-- ============================================================================
-- 016_email_conversation_sync_trigger.sql
-- Auto-sync email_conversations when email_messages are updated
--
-- BUG: When the frontend stars, archives, deletes, or links a project on
-- an email_message, the email_conversations summary row is NOT updated
-- until the next Gmail sync.  This trigger keeps them in sync immediately.
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_email_conversation_on_message_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_thread_id TEXT;
  v_account_id UUID;
  v_agg RECORD;
BEGIN
  -- Determine which thread/account to update
  IF TG_OP = 'DELETE' THEN
    v_thread_id  := OLD.gmail_thread_id;
    v_account_id := OLD.email_account_id;
  ELSE
    v_thread_id  := NEW.gmail_thread_id;
    v_account_id := NEW.email_account_id;
  END IF;

  -- Skip if no conversation row exists for this thread
  IF NOT EXISTS (
    SELECT 1 FROM email_conversations
    WHERE email_account_id = v_account_id AND gmail_thread_id = v_thread_id
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Aggregate current state from all non-deleted messages in the thread
  SELECT
    COUNT(*)                                         AS message_count,
    COUNT(*) FILTER (WHERE m.is_unread = true)       AS unread_count,
    BOOL_OR(COALESCE(m.is_starred, false))           AS is_starred,
    BOOL_OR(COALESCE(m.is_archived, false))          AS is_archived,
    BOOL_AND(COALESCE(m.is_deleted, false))          AS all_deleted,
    BOOL_OR(m.attachments IS NOT NULL
            AND jsonb_array_length(m.attachments) > 0) AS has_attachments,
    MAX(m.received_at)                               AS last_message_at,
    -- Use the first non-null project link found (from newest message)
    (SELECT m2.project_id FROM email_messages m2
     WHERE m2.email_account_id = v_account_id
       AND m2.gmail_thread_id  = v_thread_id
       AND m2.project_id IS NOT NULL
     ORDER BY m2.received_at DESC LIMIT 1)           AS project_id,
    (SELECT m2.project_title FROM email_messages m2
     WHERE m2.email_account_id = v_account_id
       AND m2.gmail_thread_id  = v_thread_id
       AND m2.project_id IS NOT NULL
     ORDER BY m2.received_at DESC LIMIT 1)           AS project_title,
    (SELECT m2.agent_id FROM email_messages m2
     WHERE m2.email_account_id = v_account_id
       AND m2.gmail_thread_id  = v_thread_id
       AND m2.agent_id IS NOT NULL
     ORDER BY m2.received_at DESC LIMIT 1)           AS agent_id,
    (SELECT m2.agency_id FROM email_messages m2
     WHERE m2.email_account_id = v_account_id
       AND m2.gmail_thread_id  = v_thread_id
       AND m2.agency_id IS NOT NULL
     ORDER BY m2.received_at DESC LIMIT 1)           AS agency_id
  INTO v_agg
  FROM email_messages m
  WHERE m.email_account_id = v_account_id
    AND m.gmail_thread_id  = v_thread_id
    AND (m.is_deleted IS NULL OR m.is_deleted = false);

  UPDATE email_conversations SET
    message_count   = COALESCE(v_agg.message_count, 0),
    unread_count    = COALESCE(v_agg.unread_count, 0),
    is_starred      = COALESCE(v_agg.is_starred, false),
    is_archived     = COALESCE(v_agg.is_archived, false),
    is_deleted      = COALESCE(v_agg.all_deleted, false),
    has_attachments = COALESCE(v_agg.has_attachments, false),
    last_message_at = COALESCE(v_agg.last_message_at, last_message_at),
    project_id      = v_agg.project_id,
    project_title   = v_agg.project_title,
    agent_id        = v_agg.agent_id,
    agency_id       = v_agg.agency_id
  WHERE email_account_id = v_account_id
    AND gmail_thread_id  = v_thread_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Fire AFTER any change to email_messages
CREATE TRIGGER sync_conversation_on_message_change
  AFTER INSERT OR UPDATE OR DELETE ON email_messages
  FOR EACH ROW
  EXECUTE FUNCTION sync_email_conversation_on_message_change();
