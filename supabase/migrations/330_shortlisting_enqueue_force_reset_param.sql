-- Wave 6 P-audit-fix-2 Class F: mig 330: enqueue_shortlisting_ingest_job adds p_force_reset
--
-- Audit defect #30 (P1): manual "Run now" button doesn't fire if a webhook
-- tick already ratcheted scheduled_for forward. Add p_force_reset BOOL that
-- bypasses the GREATEST ratchet on conflict.
--
-- Approach: drop the old 2-arg overload then recreate with the 3-arg sig.
-- Callers that pass only 2 args still hit the new signature via the DEFAULT.
-- Webhook + cron continue to omit the new arg -> behaviour unchanged.

DROP FUNCTION IF EXISTS enqueue_shortlisting_ingest_job(UUID, INT);

CREATE OR REPLACE FUNCTION enqueue_shortlisting_ingest_job(
  p_project_id UUID,
  p_debounce_seconds INT DEFAULT 7200,
  p_force_reset BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_time TIMESTAMPTZ := NOW() + make_interval(secs => p_debounce_seconds);
  v_job_id UUID;
BEGIN
  IF p_force_reset THEN
    INSERT INTO shortlisting_jobs (project_id, kind, status, payload, scheduled_for)
    VALUES (
      p_project_id,
      'ingest',
      'pending',
      jsonb_build_object('project_id', p_project_id, 'force_reset', TRUE),
      v_target_time
    )
    ON CONFLICT (project_id) WHERE (status = 'pending' AND kind = 'ingest')
    DO UPDATE SET
      scheduled_for = EXCLUDED.scheduled_for,
      payload = COALESCE(shortlisting_jobs.payload, '{}'::jsonb)
                || jsonb_build_object('last_force_reset_at', NOW(), 'force_reset', TRUE)
    RETURNING id INTO v_job_id;
  ELSE
    INSERT INTO shortlisting_jobs (project_id, kind, status, payload, scheduled_for)
    VALUES (
      p_project_id,
      'ingest',
      'pending',
      jsonb_build_object('project_id', p_project_id),
      v_target_time
    )
    ON CONFLICT (project_id) WHERE (status = 'pending' AND kind = 'ingest')
    DO UPDATE SET
      scheduled_for = GREATEST(shortlisting_jobs.scheduled_for, EXCLUDED.scheduled_for),
      payload = COALESCE(shortlisting_jobs.payload, '{}'::jsonb)
                || jsonb_build_object('last_debounced_at', NOW())
    RETURNING id INTO v_job_id;
  END IF;

  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION enqueue_shortlisting_ingest_job(UUID, INT, BOOLEAN) IS
  'Wave 6 P-audit-fix-2 #30: added p_force_reset BOOL. When TRUE, scheduled_for is overwritten unconditionally (manual UI override). When FALSE (default — webhook/cron), the GREATEST ratchet preserves debounce semantics. EXECUTE granted only to service_role per mig 328.';

GRANT EXECUTE ON FUNCTION enqueue_shortlisting_ingest_job(UUID, INT, BOOLEAN)
  TO service_role;

NOTIFY pgrst, 'reload schema';
