-- 112_integrity_score_v2_middleman_db.sql
-- Push the middleman-email blocklist from emailCleanup.ts into a DB table so
-- pulse_recompute_agent_score's "is_clean" check matches the TS layer.
-- Fixes B07 (score drift between paths).
--
-- ALSO fixes B33: normalize data_sources column type — every pulse_agents
-- row where data_sources was inserted as JSON.stringify() stored a jsonb
-- STRING not an ARRAY. Rewrite to array.
--
-- ALSO fixes B43: promote alternate_emails[0] to primary on agents where
-- primary is NULL but alternates exist. The migration 103 backfill
-- populated alternates from all_emails but never picked a primary.

BEGIN;

-- ── (1) Middleman domains blocklist ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS pulse_middleman_domains (
  domain           TEXT PRIMARY KEY,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'suffix')),
  category         TEXT,  -- 'crm' | 'forwarder' | 'generic_alias' | 'transactional'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed from the TS _shared/emailCleanup.ts MIDDLEMAN_DOMAINS + SUFFIXES
INSERT INTO pulse_middleman_domains (domain, match_type, category) VALUES
  ('agentbox.com.au', 'exact', 'crm'),
  ('agentboxmail.com.au', 'exact', 'crm'),
  ('agentboxcrm.com.au', 'exact', 'crm'),
  ('rexsoftware.com', 'exact', 'crm'),
  ('rex.com.au', 'exact', 'crm'),
  ('leaddrop.rexsoftware.com', 'exact', 'crm'),
  ('vaultrealestate.com.au', 'exact', 'crm'),
  ('vaultre.com.au', 'exact', 'crm'),
  ('vaultre.com', 'exact', 'crm'),
  ('eaglesoftware.com.au', 'exact', 'crm'),
  ('eagle-agency.net', 'exact', 'crm'),
  ('eagleagency.com.au', 'exact', 'crm'),
  ('ailoy.com.au', 'exact', 'crm'),
  ('ailo.io', 'exact', 'crm'),
  ('inspectrealestate.com.au', 'exact', 'crm'),
  ('mail.inspectrealestate.com.au', 'exact', 'crm'),
  ('inspect.com.au', 'exact', 'crm'),
  ('kolmeo.com', 'exact', 'crm'),
  ('kolmeo.io', 'exact', 'crm'),
  ('campaigntrack.com', 'exact', 'forwarder'),
  ('propertytree.com', 'exact', 'crm'),
  ('console.com.au', 'exact', 'crm'),
  ('sherlock.io', 'exact', 'forwarder'),
  ('box-digital.com', 'exact', 'forwarder'),
  ('reb-au.com', 'exact', 'forwarder'),
  ('rentmanager.com.au', 'exact', 'crm'),
  ('mailcampaigns.com.au', 'exact', 'forwarder'),
  ('mailchi.mp', 'exact', 'transactional'),
  ('mail.mailchimp.com', 'exact', 'transactional'),
  ('bossdata.com.au', 'exact', 'crm'),
  ('rpdata.com', 'exact', 'crm'),
  ('corelogic.com.au', 'exact', 'forwarder'),
  ('realestateview.com.au', 'exact', 'forwarder'),
  ('homely.com.au', 'exact', 'forwarder'),
  ('realty.com.au', 'exact', 'forwarder'),
  ('zenu.com.au', 'exact', 'crm'),
  ('lckdon.co', 'exact', 'forwarder'),
  ('boards.trello.com', 'exact', 'forwarder'),
  ('mandrillapp.com', 'exact', 'transactional'),
  ('sendgrid.net', 'exact', 'transactional'),
  ('sparkpostmail.com', 'exact', 'transactional'),
  ('amazonses.com', 'exact', 'transactional'),
  -- Suffixes (TS MIDDLEMAN_SUFFIXES)
  ('.agentbox.com.au', 'suffix', 'crm'),
  ('.agentboxmail.com.au', 'suffix', 'crm'),
  ('.agentboxcrm.com.au', 'suffix', 'crm'),
  ('.rex.com.au', 'suffix', 'crm'),
  ('.rexsoftware.com', 'suffix', 'crm'),
  ('.vaultre.com.au', 'suffix', 'crm'),
  ('.vaultrealestate.com.au', 'suffix', 'crm'),
  ('.kolmeo.com', 'suffix', 'crm'),
  ('.kolmeo.io', 'suffix', 'crm'),
  ('.inspectrealestate.com.au', 'suffix', 'crm'),
  ('.eaglesoftware.com.au', 'suffix', 'crm'),
  ('.campaigntrack.com', 'suffix', 'forwarder'),
  ('.propertytree.com', 'suffix', 'crm'),
  ('.mandrillapp.com', 'suffix', 'transactional'),
  ('.sendgrid.net', 'suffix', 'transactional'),
  ('.amazonses.com', 'suffix', 'transactional')
ON CONFLICT (domain) DO NOTHING;

-- Fast lookup by domain
CREATE INDEX IF NOT EXISTS idx_pulse_middleman_domains_match_type ON pulse_middleman_domains (match_type, domain);

-- ── (2) Server-side middleman check helper ───────────────────────────────
CREATE OR REPLACE FUNCTION pulse_is_middleman_email(p_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_email_lc  TEXT;
  v_at        INT;
  v_local     TEXT;
  v_domain    TEXT;
  v_hit       INT;
BEGIN
  IF p_email IS NULL THEN RETURN TRUE; END IF;
  v_email_lc := lower(trim(p_email));
  IF v_email_lc = '' OR position('@' IN v_email_lc) = 0 THEN RETURN TRUE; END IF;
  v_at := length(v_email_lc) - position('@' IN reverse(v_email_lc)) + 1;
  v_local  := substring(v_email_lc FROM 1 FOR v_at - 1);
  v_domain := substring(v_email_lc FROM v_at + 1);
  IF v_local = '' OR v_domain = '' THEN RETURN TRUE; END IF;

  -- Generic role local-parts (matches TS GENERIC_LOCAL_PATTERNS)
  IF v_local ~* '^(noreply|no-reply|donotreply|do-not-reply|notification|notifications|alert|alerts|bounce|bounces|mailer-daemon|postmaster|system|daemon|auto-reply|autoreply|capture|importcontact|leaddrop|leads-drop|reaenquiries|rea-enquiries|pwteam|portal\.leads)' THEN
    RETURN TRUE;
  END IF;

  -- Exact domain match
  SELECT 1 INTO v_hit FROM pulse_middleman_domains
    WHERE match_type = 'exact' AND domain = v_domain LIMIT 1;
  IF FOUND THEN RETURN TRUE; END IF;

  -- Suffix match
  SELECT 1 INTO v_hit FROM pulse_middleman_domains
    WHERE match_type = 'suffix' AND v_domain LIKE '%' || domain LIMIT 1;
  IF FOUND THEN RETURN TRUE; END IF;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION pulse_is_middleman_email IS
  'DB-side mirror of _shared/emailCleanup.ts isMiddlemanEmail. Sourced from '
  'pulse_middleman_domains. Keep in sync when TS blocklist changes.';

-- ── (3) Update pulse_recompute_agent_score to use DB middleman check ─────
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

  -- Email "clean" via the real middleman blocklist (migration 112)
  v_email_clean := NOT pulse_is_middleman_email(v_row.email);

  -- Multi-source bonus: primary value appears in alternates with >= 2 sources
  v_email_multi := v_row.email IS NOT NULL AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_row.alternate_emails, '[]'::jsonb)) entry
     WHERE (entry ->> 'value') = lower(trim(v_row.email))
       AND jsonb_typeof(entry -> 'sources') = 'array'
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

-- ── (4) B33 cleanup: fix data_sources where it's a jsonb string ──────────
UPDATE pulse_agents
SET data_sources = CASE
  WHEN jsonb_typeof(data_sources) = 'string' THEN
    CASE
      -- Try to parse the stringified JSON back into an array
      WHEN data_sources #>> '{}' ~ '^\[.*\]$' THEN
        (data_sources #>> '{}')::jsonb
      ELSE
        jsonb_build_array(data_sources #>> '{}')
    END
  ELSE data_sources
END
WHERE data_sources IS NOT NULL
  AND jsonb_typeof(data_sources) = 'string';

-- ── (5) B43 cleanup: promote an alternate to primary where primary is NULL
--        but alternates have entries
UPDATE pulse_agents a
SET email = alt.value,
    email_source = COALESCE(alt.source, 'legacy_promoted'),
    email_confidence = COALESCE(alt.confidence, 55)
FROM (
  SELECT a2.id AS agent_id,
         entry ->> 'value' AS value,
         CASE WHEN jsonb_typeof(entry -> 'sources') = 'array' AND jsonb_array_length(entry -> 'sources') > 0
              THEN entry -> 'sources' ->> 0 ELSE 'legacy_promoted' END AS source,
         (entry ->> 'confidence')::SMALLINT AS confidence
  FROM pulse_agents a2,
    LATERAL (
      SELECT entry FROM jsonb_array_elements(a2.alternate_emails) entry
      WHERE jsonb_typeof(a2.alternate_emails) = 'array'
      ORDER BY (entry ->> 'confidence')::INT DESC NULLS LAST, (entry ->> 'last_seen_at')::timestamptz DESC NULLS LAST
      LIMIT 1
    ) alt
  WHERE a2.email IS NULL
    AND jsonb_typeof(a2.alternate_emails) = 'array'
    AND jsonb_array_length(a2.alternate_emails) > 0
) alt
WHERE a.id = alt.agent_id;

COMMIT;
