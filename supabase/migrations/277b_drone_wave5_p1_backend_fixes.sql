-- ════════════════════════════════════════════════════════════════════════
-- Migration 277 — Wave 5 P1 backend fixes (drone module)
-- ────────────────────────────────────────────────────────────────────────
-- Three independent backend fixes that share a release window:
--
-- 1) enqueue_drone_ingest_job — GREATEST not LEAST (QC2-1 #9 / QC2-6 #8)
--    Migration 260 set this to LEAST as "starvation guard". The actual
--    documented intent is "ratchet forward to NEWEST upload + 120s
--    window" — i.e. wait 120s after the LAST file lands. LEAST does the
--    opposite: pulls the deadline EARLIER on every call, firing the job
--    BEFORE all the files in a burst have arrived. The starvation guard
--    is then re-introduced by capping at now() + 15 minutes — even if
--    an attacker uploads a fresh file every second, the job fires at
--    most 15 minutes after the first call.
--
-- 2) drone_pois_acquire_lock / drone_pois_release_lock (QC2-8 #9)
--    Session-scoped advisory locks keyed by hashtext('drone-pois:' ||
--    project_id) so two concurrent drone-pois invocations for the same
--    project serialise their materialise-into-drone_custom_pins block.
--    Without this, invocation A's supersede pass clobbers invocation
--    B's freshly-inserted row.
--
-- 3) drone_pois_supersede_stale (QC2-8 #9 + QC2-4 F49)
--    Single-SQL supersede pass that mirrors what the JS used to do
--    iteratively (read existing → diff against fresh → bulk-update),
--    PLUS the QC2-4 F49 operator-preservation clause:
--    `AND updated_by IS NULL` — never supersede a pin that a human
--    has touched, even if Google's latest fetch no longer returns its
--    place_id (could be a transient gap; let the next refresh decide).
-- ════════════════════════════════════════════════════════════════════════


-- ── 1) enqueue_drone_ingest_job: GREATEST + 15-minute cap ──────────────
CREATE OR REPLACE FUNCTION public.enqueue_drone_ingest_job(
  p_project_id UUID,
  p_debounce_seconds INT DEFAULT 120
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_time TIMESTAMPTZ := NOW() + make_interval(secs => p_debounce_seconds);
  v_job_id UUID;
BEGIN
  INSERT INTO drone_jobs (project_id, kind, status, payload, scheduled_for)
  VALUES (
    p_project_id,
    'ingest',
    'pending',
    jsonb_build_object('project_id', p_project_id),
    v_target_time
  )
  ON CONFLICT (project_id) WHERE (status = 'pending' AND kind = 'ingest')
  DO UPDATE SET
    -- W5 P1 fix: GREATEST ratchets the deadline FORWARD to (newest upload
    -- + 120s) so the ingest worker waits for the whole burst to land.
    -- The LEAST(..., NOW() + 15min) cap prevents indefinite push: even a
    -- pathological client that uploads a file every second can't keep
    -- the job pinned for more than 15 minutes after the first event.
    -- The 15-minute cap is generous: realistic 50-file drone uploads
    -- complete in ~3-5 minutes, so this only kicks in for misbehaving
    -- clients or stuck uploaders.
    scheduled_for = LEAST(
      GREATEST(drone_jobs.scheduled_for, EXCLUDED.scheduled_for),
      NOW() + interval '15 minutes'
    ),
    payload = COALESCE(drone_jobs.payload, '{}'::jsonb)
              || jsonb_build_object('last_debounced_at', NOW())
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_drone_ingest_job IS
  'Debounced upsert of a pending kind=ingest drone_jobs row for a project. The unique partial index uniq_drone_jobs_pending_ingest_per_project enforces at-most-one pending ingest per project; subsequent calls within the debounce window ratchet scheduled_for FORWARD to (newest upload + p_debounce_seconds), capped at NOW()+15min to prevent indefinite-push abuse (W5 P1 fix — supersedes mig 260 LEAST semantics).';

GRANT EXECUTE ON FUNCTION public.enqueue_drone_ingest_job(UUID, INT) TO authenticated, service_role;


-- ── 2) drone_pois advisory lock helpers ────────────────────────────────
-- Session-scoped (pg_advisory_lock, not pg_advisory_xact_lock) because a
-- PostgREST RPC call wraps each invocation in its own transaction — the
-- Edge Function holds the lock across multiple supabase-js calls inside
-- the materialiseAiPins JS block. Lock key is hashtext('drone-pois:' ||
-- project_id) — buckets per project, never collides with other modules.
--
-- Both functions are SECURITY DEFINER + GRANT to service_role so only
-- the Edge Function (which uses the service-role JWT) can acquire/
-- release the lock — random users can't DoS the materialise path.

CREATE OR REPLACE FUNCTION public.drone_pois_acquire_lock(
  p_project_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_lock(hashtext('drone-pois:' || p_project_id::text));
END;
$$;

COMMENT ON FUNCTION public.drone_pois_acquire_lock IS
  'Acquire a session-scoped advisory lock for drone-pois materialise on this project. Serialises concurrent webhook invocations so supersede passes do not clobber freshly-inserted rows. Always pair with drone_pois_release_lock in a finally block. (W5 P1 / QC2-8 #9)';

GRANT EXECUTE ON FUNCTION public.drone_pois_acquire_lock(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.drone_pois_release_lock(
  p_project_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_unlock(hashtext('drone-pois:' || p_project_id::text));
END;
$$;

COMMENT ON FUNCTION public.drone_pois_release_lock IS
  'Release the session-scoped advisory lock paired with drone_pois_acquire_lock. Safe to call even if the lock was not held (returns false). (W5 P1 / QC2-8 #9)';

GRANT EXECUTE ON FUNCTION public.drone_pois_release_lock(UUID) TO service_role;


-- ── 3) drone_pois_supersede_stale: atomic supersede + operator preserve ─
-- Replaces the JS-side stale-list build + bulk-update from drone-pois
-- materialiseAiPins. Runs in one atomic UPDATE so the supersede sweep
-- never sees a half-state from a concurrent invocation.
--
-- Key invariants:
--   - source = 'ai'           : never touch operator-created pins
--   - lifecycle = 'active'    : already-superseded rows are no-op
--   - external_ref IS NOT NULL: defensive — should be true for every
--                               source='ai' row by construction
--   - external_ref NOT IN $2  : the fresh-fetch place_id set
--   - updated_by IS NULL      : QC2-4 F49 — never supersede a pin a
--                               human has edited, even if it vanished
--                               from the latest Google fetch (could be
--                               transient; let next refresh decide)
--
-- Returns the count of rows superseded so the caller can populate
-- summary.superseded.

CREATE OR REPLACE FUNCTION public.drone_pois_supersede_stale(
  p_project_id UUID,
  p_fresh_refs TEXT[]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  WITH updated AS (
    UPDATE drone_custom_pins
       SET lifecycle = 'superseded',
           updated_at = NOW()
     WHERE project_id   = p_project_id
       AND source       = 'ai'
       AND lifecycle    = 'active'
       AND external_ref IS NOT NULL
       AND updated_by   IS NULL
       AND (
         p_fresh_refs IS NULL
         OR cardinality(p_fresh_refs) = 0
         OR external_ref <> ALL(p_fresh_refs)
       )
    RETURNING 1
  )
  SELECT COUNT(*)::INT INTO v_count FROM updated;

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.drone_pois_supersede_stale IS
  'Atomic supersede pass for AI pins no longer in the fresh Google Places fetch. Preserves operator-edited rows (updated_by IS NOT NULL) per QC2-4 F49. Returns the count superseded. (W5 P1 / QC2-8 #9)';

GRANT EXECUTE ON FUNCTION public.drone_pois_supersede_stale(UUID, TEXT[]) TO service_role;


NOTIFY pgrst, 'reload schema';
