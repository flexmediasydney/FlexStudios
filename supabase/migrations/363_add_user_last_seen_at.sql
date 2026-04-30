-- 363_add_user_last_seen_at.sql
-- Groundwork for offline notification email fallback.
--
-- Adds a global "last seen" timestamp on public.users plus an RPC the client
-- pings on a heartbeat while the tab is visible. Purely additive: no UI or
-- behavioral change yet; the value will be read later by the email-fallback
-- worker to decide whether a user is offline at delivery time.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Partial index — only rows with a last_seen value are interesting for the
-- "find users idle longer than N minutes" query that drives email fallback.
CREATE INDEX IF NOT EXISTS idx_users_last_seen_at
  ON public.users (last_seen_at DESC)
  WHERE last_seen_at IS NOT NULL;

-- RPC: caller stamps their own row. SECURITY DEFINER so we don't have to
-- carve a narrow UPDATE policy on users.last_seen_at — the function itself
-- is the boundary.
CREATE OR REPLACE FUNCTION public.record_user_presence()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  UPDATE public.users
     SET last_seen_at = now()
   WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.record_user_presence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_user_presence() TO authenticated;

COMMENT ON COLUMN public.users.last_seen_at IS
  'Last app heartbeat from this user (visible tab, ~60s cadence). Used to gate '
  'offline email fallback for in-app notifications.';

COMMENT ON FUNCTION public.record_user_presence() IS
  'Stamps users.last_seen_at = now() for the calling auth.uid(). Called by the '
  'client on a 60s heartbeat while the tab is visible.';

COMMIT;
