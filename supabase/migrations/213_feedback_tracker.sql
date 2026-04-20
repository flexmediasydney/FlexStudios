-- 213_feedback_tracker.sql
-- Internal-only feedback / bug tracker ("Canny-lite").
--
-- Three tables:
--   feedback_items     — bugs, improvements, feature requests
--   feedback_votes     — one vote per (item, user), upvote-only
--   feedback_comments  — threaded discussion on an item
--
-- All three enforce RLS. Reads are open to any authenticated internal user;
-- writes are scoped to the creator/author, with admin/manager override for
-- status changes + moderation.
--
-- Denormalized counts (vote_count, comment_count) are kept in sync by
-- AFTER INSERT/DELETE triggers so list views don't need aggregate subqueries.
-- Status transitions stamp accepted_at / shipped_at / declined_at via a
-- BEFORE UPDATE trigger.
--
-- Screenshots live in the `feedback-screenshots` storage bucket (created
-- separately via Management API); the `screenshots` jsonb column stores an
-- array of object paths inside that bucket.

BEGIN;

-- ─── feedback_items ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description text,
  type text NOT NULL CHECK (type IN ('bug','improvement','feature_request')),
  severity text NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical','high','medium','low')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','triaging','accepted','in_progress','shipped','declined','duplicate')),
  area text,                     -- free-text tag: 'pricing','pulse','tonomo','media','tasks','other'
  screenshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  page_url text,                 -- captured client-side at submit
  user_agent text,               -- captured client-side at submit
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text,          -- denormalized for audit readability
  created_by_email text,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  duplicate_of uuid REFERENCES feedback_items(id) ON DELETE SET NULL,
  related_commit_sha text,
  related_pr_url text,
  vote_count int NOT NULL DEFAULT 0,
  comment_count int NOT NULL DEFAULT 0,
  accepted_at timestamptz,
  shipped_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_items_status
  ON feedback_items (status);
CREATE INDEX IF NOT EXISTS idx_feedback_items_created_by
  ON feedback_items (created_by);
CREATE INDEX IF NOT EXISTS idx_feedback_items_assigned_to
  ON feedback_items (assigned_to);
CREATE INDEX IF NOT EXISTS idx_feedback_items_type_severity
  ON feedback_items (type, severity);
CREATE INDEX IF NOT EXISTS idx_feedback_items_vote_count
  ON feedback_items (vote_count DESC);

-- ─── feedback_votes ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feedback_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_votes_user
  ON feedback_votes (user_id);

-- ─── feedback_comments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  user_name text,
  user_email text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  is_internal_note boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_comments_feedback
  ON feedback_comments (feedback_id, created_at DESC);

-- ─── updated_at triggers (reuse existing update_updated_at()) ─────────────
DROP TRIGGER IF EXISTS set_updated_at_feedback_items ON feedback_items;
CREATE TRIGGER set_updated_at_feedback_items
  BEFORE UPDATE ON feedback_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_feedback_comments ON feedback_comments;
CREATE TRIGGER set_updated_at_feedback_comments
  BEFORE UPDATE ON feedback_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── vote count trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION feedback_votes_sync_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE feedback_items
       SET vote_count = vote_count + 1
     WHERE id = NEW.feedback_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE feedback_items
       SET vote_count = GREATEST(vote_count - 1, 0)
     WHERE id = OLD.feedback_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_feedback_votes_count ON feedback_votes;
CREATE TRIGGER trg_feedback_votes_count
  AFTER INSERT OR DELETE ON feedback_votes
  FOR EACH ROW EXECUTE FUNCTION feedback_votes_sync_count();

-- ─── comment count trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION feedback_comments_sync_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE feedback_items
       SET comment_count = comment_count + 1
     WHERE id = NEW.feedback_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE feedback_items
       SET comment_count = GREATEST(comment_count - 1, 0)
     WHERE id = OLD.feedback_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_feedback_comments_count ON feedback_comments;
CREATE TRIGGER trg_feedback_comments_count
  AFTER INSERT OR DELETE ON feedback_comments
  FOR EACH ROW EXECUTE FUNCTION feedback_comments_sync_count();

-- ─── status-timestamp trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION feedback_items_stamp_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'accepted' AND NEW.accepted_at IS NULL THEN
      NEW.accepted_at := now();
    END IF;
    IF NEW.status = 'shipped' AND NEW.shipped_at IS NULL THEN
      NEW.shipped_at := now();
    END IF;
    IF NEW.status = 'declined' AND NEW.declined_at IS NULL THEN
      NEW.declined_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feedback_items_stamp_status ON feedback_items;
CREATE TRIGGER trg_feedback_items_stamp_status
  BEFORE UPDATE ON feedback_items
  FOR EACH ROW EXECUTE FUNCTION feedback_items_stamp_status();

-- ─── Column-level write guards (RLS can't do per-column) ─────────────────
-- feedback_items: if the writer isn't an admin/manager, freeze the admin-
-- only columns (status, assignment, duplicate link, commit/PR, status
-- timestamps). Creators can still edit title / description / type /
-- severity / area / screenshots / page_url / user_agent.
CREATE OR REPLACE FUNCTION feedback_items_guard_creator_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text;
BEGIN
  -- Service role / internal writers bypass (auth.uid() is null).
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_role := get_user_role();
  IF v_role IN ('master_admin','admin','manager') THEN
    RETURN NEW;
  END IF;

  -- Non-admin writer: freeze admin-only columns to their old values.
  NEW.status              := OLD.status;
  NEW.assigned_to         := OLD.assigned_to;
  NEW.duplicate_of        := OLD.duplicate_of;
  NEW.related_commit_sha  := OLD.related_commit_sha;
  NEW.related_pr_url      := OLD.related_pr_url;
  NEW.accepted_at         := OLD.accepted_at;
  NEW.shipped_at          := OLD.shipped_at;
  NEW.declined_at         := OLD.declined_at;
  NEW.vote_count          := OLD.vote_count;
  NEW.comment_count       := OLD.comment_count;
  NEW.created_by          := OLD.created_by;
  NEW.created_by_name     := OLD.created_by_name;
  NEW.created_by_email    := OLD.created_by_email;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feedback_items_guard ON feedback_items;
CREATE TRIGGER trg_feedback_items_guard
  BEFORE UPDATE ON feedback_items
  FOR EACH ROW EXECUTE FUNCTION feedback_items_guard_creator_fields();

-- feedback_comments: authors may edit body only; freeze everything else.
CREATE OR REPLACE FUNCTION feedback_comments_guard_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.feedback_id      := OLD.feedback_id;
  NEW.user_id          := OLD.user_id;
  NEW.user_name        := OLD.user_name;
  NEW.user_email       := OLD.user_email;
  NEW.is_internal_note := OLD.is_internal_note;
  NEW.created_at       := OLD.created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feedback_comments_guard ON feedback_comments;
CREATE TRIGGER trg_feedback_comments_guard
  BEFORE UPDATE ON feedback_comments
  FOR EACH ROW EXECUTE FUNCTION feedback_comments_guard_fields();

-- ─── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE feedback_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_votes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_comments ENABLE ROW LEVEL SECURITY;

-- feedback_items policies ------------------------------------------------
DROP POLICY IF EXISTS feedback_items_select ON feedback_items;
CREATE POLICY feedback_items_select ON feedback_items
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS feedback_items_insert ON feedback_items;
CREATE POLICY feedback_items_insert ON feedback_items
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- UPDATE is allowed for:
--   (a) the creator of the row (editing their own submission), OR
--   (b) an admin/manager (can change status, assignment, etc.).
-- RLS itself can't enforce column-level restrictions, so the trigger
-- `feedback_items_guard_creator_fields` below freezes status / assigned_to /
-- duplicate_of / related_commit_sha / related_pr_url / the *_at timestamps
-- when the writer is a plain creator (non-admin/manager).
DROP POLICY IF EXISTS feedback_items_update ON feedback_items;
CREATE POLICY feedback_items_update ON feedback_items
  FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid()
    OR get_user_role() IN ('master_admin','admin','manager')
  )
  WITH CHECK (
    created_by = auth.uid()
    OR get_user_role() IN ('master_admin','admin','manager')
  );

DROP POLICY IF EXISTS feedback_items_delete_admin ON feedback_items;
CREATE POLICY feedback_items_delete_admin ON feedback_items
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'));

-- feedback_votes policies ------------------------------------------------
DROP POLICY IF EXISTS feedback_votes_select ON feedback_votes;
CREATE POLICY feedback_votes_select ON feedback_votes
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS feedback_votes_insert ON feedback_votes;
CREATE POLICY feedback_votes_insert ON feedback_votes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS feedback_votes_delete ON feedback_votes;
CREATE POLICY feedback_votes_delete ON feedback_votes
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- feedback_comments policies ---------------------------------------------
DROP POLICY IF EXISTS feedback_comments_select ON feedback_comments;
CREATE POLICY feedback_comments_select ON feedback_comments
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS feedback_comments_insert ON feedback_comments;
CREATE POLICY feedback_comments_insert ON feedback_comments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Author may update their own comment. The guard trigger
-- `feedback_comments_guard_fields` freezes every column except `body`,
-- so this policy just needs to scope write access to the author.
DROP POLICY IF EXISTS feedback_comments_update_author ON feedback_comments;
CREATE POLICY feedback_comments_update_author ON feedback_comments
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS feedback_comments_delete ON feedback_comments;
CREATE POLICY feedback_comments_delete ON feedback_comments
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR get_user_role() IN ('master_admin','admin')
  );

-- ─── Storage bucket RLS policies ──────────────────────────────────────────
-- Bucket itself is created via the Management API (see deploy script).
-- These policies on storage.objects scope access by bucket_id.

DROP POLICY IF EXISTS "feedback_screenshots_select" ON storage.objects;
CREATE POLICY "feedback_screenshots_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'feedback-screenshots');

DROP POLICY IF EXISTS "feedback_screenshots_insert" ON storage.objects;
CREATE POLICY "feedback_screenshots_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'feedback-screenshots'
    AND owner = auth.uid()
  );

DROP POLICY IF EXISTS "feedback_screenshots_update" ON storage.objects;
CREATE POLICY "feedback_screenshots_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'feedback-screenshots' AND owner = auth.uid())
  WITH CHECK (bucket_id = 'feedback-screenshots' AND owner = auth.uid());

DROP POLICY IF EXISTS "feedback_screenshots_delete" ON storage.objects;
CREATE POLICY "feedback_screenshots_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'feedback-screenshots' AND owner = auth.uid());

COMMENT ON TABLE feedback_items    IS 'Internal feedback/bug tracker — user submissions with status workflow.';
COMMENT ON TABLE feedback_votes    IS 'One row per (feedback_id,user_id) upvote. Vote count denormalized onto feedback_items.';
COMMENT ON TABLE feedback_comments IS 'Threaded comments on feedback items. is_internal_note reserved for admin-only notes.';

COMMIT;
