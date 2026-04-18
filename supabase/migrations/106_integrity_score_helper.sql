-- 106_integrity_score_helper.sql
-- Extract the pulse_agents.data_integrity_score calculation into a single
-- SQL function. Kills the drift between pulseDataSync:619 (initial) vs
-- pulseDataSync:1500 (cross-enrich recalc) — and makes it trivial for the
-- new pulseDetailEnrich (third caller) to compute the same score without
-- copy-pasting the formula.
--
-- Formula v3 (incorporates detail-source bonus + multi-source bonus):
--   Base:
--     +30 if no REA profile (listing-only agent)
--     +50 if REA profile exists
--   Plus:
--     +10 mobile present
--     + 3 mobile detail-sourced
--     +15 email present AND clean (non-middleman)
--     + 5 email detail-sourced
--     + 3 email verified by 2+ sources
--     +10 profile_image present
--     + 5 email AND photo bonus
--     + 5 agency link present
--     +10 rea_agent_id present
-- Max theoretical cap: 30 + 10+3 + 15+5+3 + 10+5 + 5 + 10 = 96 (listing-only)
--                      50 + 10+3 + 15+5+3 + 10+5 + 5 + 10 = 116 → clamped to 100
-- Result is clamped to [0, 100].

BEGIN;

CREATE OR REPLACE FUNCTION pulse_compute_integrity_score(
  p_has_rea_profile       BOOLEAN,
  p_has_email             BOOLEAN,
  p_email_is_clean        BOOLEAN,
  p_email_is_detail       BOOLEAN,  -- from email_source = 'detail_page_lister' / 'detail_page_agency'
  p_email_multi_source    BOOLEAN,  -- alternate_emails entry for current primary has 2+ sources
  p_has_mobile            BOOLEAN,
  p_mobile_is_detail      BOOLEAN,
  p_has_photo             BOOLEAN,
  p_has_agency            BOOLEAN,
  p_has_rea_agent_id      BOOLEAN
) RETURNS SMALLINT LANGUAGE SQL IMMUTABLE AS $$
  SELECT LEAST(100, GREATEST(0,
      (CASE WHEN p_has_rea_profile THEN 50 ELSE 30 END)
    + (CASE WHEN p_has_mobile THEN 10 ELSE 0 END)
    + (CASE WHEN p_has_mobile AND p_mobile_is_detail THEN 3 ELSE 0 END)
    + (CASE WHEN p_has_email AND p_email_is_clean THEN 15 ELSE 0 END)
    + (CASE WHEN p_has_email AND p_email_is_clean AND p_email_is_detail THEN 5 ELSE 0 END)
    + (CASE WHEN p_has_email AND p_email_is_clean AND p_email_multi_source THEN 3 ELSE 0 END)
    + (CASE WHEN p_has_photo THEN 10 ELSE 0 END)
    + (CASE WHEN p_has_email AND p_email_is_clean AND p_has_photo THEN 5 ELSE 0 END)
    + (CASE WHEN p_has_agency THEN 5 ELSE 0 END)
    + (CASE WHEN p_has_rea_agent_id THEN 10 ELSE 0 END)
  ))::SMALLINT;
$$;

COMMENT ON FUNCTION pulse_compute_integrity_score IS
  'Single source of truth for pulse_agents.data_integrity_score. Called by '
  'pulseDataSync (initial + cross-enrich), pulseDetailEnrich, and future '
  'recalc helpers. Takes boolean flags rather than row itself so callers '
  'can pass already-computed state without re-querying. Max 100 (clamped).';

-- ── Convenience wrapper that reads from a pulse_agents row ────────────────
-- Use when the caller just wants to recompute from DB state. Not for the
-- hot write paths (too many field reads).
CREATE OR REPLACE FUNCTION pulse_recompute_agent_score(p_agent_id UUID)
RETURNS SMALLINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
  v_row           RECORD;
  v_email_clean   BOOLEAN;
  v_email_multi   BOOLEAN;
  v_score         SMALLINT;
BEGIN
  SELECT id, rea_profile_url, email, email_source, mobile, mobile_source,
         profile_image, agency_name, rea_agent_id, alternate_emails
    INTO v_row
    FROM pulse_agents
   WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Email "clean" = not a middleman / role-account pattern. The DB doesn''t
  -- have the full domain blocklist (lives in emailCleanup.ts) — here we
  -- approximate: non-null, contains @, no obvious role-account prefix.
  -- The edge function caller does the real check and overrides if needed.
  v_email_clean := v_row.email IS NOT NULL
    AND v_row.email LIKE '%@%'
    AND v_row.email NOT LIKE 'noreply%'
    AND v_row.email NOT LIKE 'no-reply%'
    AND v_row.email NOT LIKE 'donotreply%'
    AND v_row.email NOT LIKE 'capture@%'
    AND v_row.email NOT LIKE 'leaddrop@%';

  -- Multi-source: the primary value appears in alternate_emails with >= 2 sources
  v_email_multi := EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_row.alternate_emails, '[]'::jsonb)) entry
     WHERE (entry ->> 'value') = lower(trim(v_row.email))
       AND jsonb_array_length(entry -> 'sources') >= 2
  );

  v_score := pulse_compute_integrity_score(
    p_has_rea_profile    := v_row.rea_profile_url IS NOT NULL,
    p_has_email          := v_row.email IS NOT NULL,
    p_email_is_clean     := v_email_clean,
    p_email_is_detail    := v_row.email_source IN ('detail_page_lister', 'detail_page_agency'),
    p_email_multi_source := v_email_multi,
    p_has_mobile         := v_row.mobile IS NOT NULL,
    p_mobile_is_detail   := v_row.mobile_source IN ('detail_page_lister', 'detail_page_agency'),
    p_has_photo          := v_row.profile_image IS NOT NULL,
    p_has_agency         := v_row.agency_name IS NOT NULL,
    p_has_rea_agent_id   := v_row.rea_agent_id IS NOT NULL
  );

  UPDATE pulse_agents SET data_integrity_score = v_score WHERE id = p_agent_id;

  RETURN v_score;
END;
$func$;

COMMENT ON FUNCTION pulse_recompute_agent_score IS
  'Recomputes + persists data_integrity_score for a single agent from '
  'current DB state. Used by: pulseDetailEnrich post-merge, and admin UI.';

COMMIT;
