-- ============================================================================
-- Migration 178 — Source-Aware Field Resolution (SAFR) — schema + policies
-- ============================================================================
-- Creates `entity_field_sources` (per-(entity, field, value, source) ledger),
-- `field_merge_policies` (per-(entity_type, field) resolution rules),
-- `safr_legacy_field_map` (data-driven mirror config), and the resolver /
-- recorder / promote / lock / dismiss RPCs. Also seeds default policies and
-- runs inline self-tests.
--
-- Design rules (hard contract for the 4 parallel agents):
--   · RPC signatures below are FROZEN — do not change names or param orders.
--   · Default merge policy is AUTO: scrapes can supersede older values. A
--     human lock (`lock_entity_field`) freezes the value until unlocked.
--   · Every promoted value mirrors to the legacy column via
--     `safr_mirror_to_legacy` so existing reads continue to work.
--   · Every promotion, dismissal, lock, unlock emits a pulse_timeline row.
-- ============================================================================

BEGIN;

-- ── 1. Core ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_field_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('contact','organization','agent','agency','prospect')),
  entity_id uuid NOT NULL,
  field_name text NOT NULL,
  value_normalized text NOT NULL,
  value_display text,
  source text NOT NULL,
  source_ref_type text,
  source_ref_id uuid,
  confidence numeric NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  observed_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  times_seen int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','promoted','dismissed','superseded')),
  promoted_at timestamptz,
  dismissed_at timestamptz,
  locked_at timestamptz,
  locked_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, field_name, value_normalized, source)
);

CREATE INDEX IF NOT EXISTS idx_efs_entity
  ON entity_field_sources(entity_type, entity_id, field_name)
  WHERE status NOT IN ('dismissed','superseded');

CREATE INDEX IF NOT EXISTS idx_efs_promoted
  ON entity_field_sources(entity_type, entity_id, field_name)
  WHERE status='promoted';

CREATE INDEX IF NOT EXISTS idx_efs_source_ref
  ON entity_field_sources(source_ref_type, source_ref_id)
  WHERE source_ref_id IS NOT NULL;

ALTER TABLE entity_field_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_full_access" ON entity_field_sources;
CREATE POLICY "authenticated_full_access" ON entity_field_sources
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── 2. Policies ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_merge_policies (
  entity_type text NOT NULL,
  field_name text NOT NULL,
  policy text NOT NULL CHECK (policy IN ('manual_always_wins','latest_observed','highest_confidence','consensus_of_sources','multi_value')),
  conflict_grace_days int NOT NULL DEFAULT 30,
  auto_promote_threshold numeric NOT NULL DEFAULT 0.75,
  multi_value_max int NOT NULL DEFAULT 1,
  source_priors jsonb NOT NULL DEFAULT '{"manual":1.0,"email_sync":0.9,"rea_scrape":0.7,"rea_listing_detail":0.75,"domain_scrape":0.65,"import_csv":0.8,"enrichment_clearbit":0.6,"tonomo_webhook":0.85}'::jsonb,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, field_name)
);

ALTER TABLE field_merge_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_full_access" ON field_merge_policies;
CREATE POLICY "authenticated_full_access" ON field_merge_policies
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── 3. Legacy field mapping (data-driven mirror target) ───────────────────
CREATE TABLE IF NOT EXISTS safr_legacy_field_map (
  entity_type text NOT NULL,
  field_name text NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  PRIMARY KEY (entity_type, field_name)
);

ALTER TABLE safr_legacy_field_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_full_access" ON safr_legacy_field_map;
CREATE POLICY "authenticated_full_access" ON safr_legacy_field_map
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Seed legacy-field mappings. NOTE: the CRM `agents` / `agencies` tables are
-- the canonical "contact" / "organization" entities. `pulse_agents` /
-- `pulse_agencies` mirror the scraped shadow (the `agent` / `agency` entity
-- types in SAFR).
INSERT INTO safr_legacy_field_map (entity_type, field_name, table_name, column_name) VALUES
  -- CRM contact (= agents)
  ('contact','mobile','agents','phone'),
  ('contact','phone','agents','phone'),
  ('contact','email','agents','email'),
  ('contact','full_name','agents','name'),
  ('contact','job_title','agents','title'),
  -- (profile_image / linkedin_url have no agents column; mirror is skipped)
  -- CRM organization (= agencies)
  ('organization','name','agencies','name'),
  ('organization','phone','agencies','phone'),
  ('organization','email','agencies','email'),
  ('organization','address','agencies','address'),
  -- (website / logo_url have no agencies column; mirror skipped)
  -- Pulse agent
  ('agent','mobile','pulse_agents','mobile'),
  ('agent','phone','pulse_agents','business_phone'),
  ('agent','email','pulse_agents','email'),
  ('agent','full_name','pulse_agents','full_name'),
  ('agent','job_title','pulse_agents','job_title'),
  ('agent','profile_image','pulse_agents','profile_image'),
  ('agent','agency_name','pulse_agents','agency_name'),
  ('agent','agency_rea_id','pulse_agents','agency_rea_id'),
  -- Pulse agency
  ('agency','name','pulse_agencies','name'),
  ('agency','phone','pulse_agencies','phone'),
  ('agency','email','pulse_agencies','email'),
  ('agency','website','pulse_agencies','website'),
  ('agency','address','pulse_agencies','address'),
  ('agency','logo_url','pulse_agencies','logo_url')
ON CONFLICT (entity_type, field_name) DO UPDATE
  SET table_name = EXCLUDED.table_name, column_name = EXCLUDED.column_name;

-- Seed policies — default is AUTO (scrapes drive fresh data). Manual lock
-- freezes via lock_entity_field.
INSERT INTO field_merge_policies (entity_type, field_name, policy, multi_value_max, notes) VALUES
  -- Contact
  ('contact','mobile','latest_observed',1,'Latest mobile wins unless locked'),
  ('contact','email','multi_value',3,'Up to 3 emails tracked'),
  ('contact','phone','latest_observed',1,'Landline/direct'),
  ('contact','full_name','manual_always_wins',1,'Humans correct spellings'),
  ('contact','job_title','latest_observed',1,'Career changes'),
  ('contact','profile_image','latest_observed',1,'Latest scrape wins'),
  ('contact','linkedin_url','highest_confidence',1,'LinkedIn profile URL'),
  -- Organization
  ('organization','name','manual_always_wins',1,'Agency rename is high-friction'),
  ('organization','phone','manual_always_wins',1,'Main line is human-managed'),
  ('organization','email','multi_value',2,'Agency email + fallback'),
  ('organization','website','highest_confidence',1,'Web URL — trust highest source'),
  ('organization','address','highest_confidence',1,'Physical address'),
  ('organization','logo_url','latest_observed',1,'Scrape-updated'),
  -- Agent (pulse mirror)
  ('agent','mobile','latest_observed',1,NULL),
  ('agent','email','multi_value',3,NULL),
  ('agent','phone','latest_observed',1,NULL),
  ('agent','full_name','manual_always_wins',1,NULL),
  ('agent','job_title','latest_observed',1,NULL),
  ('agent','profile_image','latest_observed',1,NULL),
  ('agent','linkedin_url','highest_confidence',1,NULL),
  ('agent','agency_name','latest_observed',1,'Drives movement signal'),
  ('agent','agency_rea_id','latest_observed',1,'Drives movement signal'),
  -- Agency (pulse mirror)
  ('agency','name','manual_always_wins',1,NULL),
  ('agency','phone','manual_always_wins',1,NULL),
  ('agency','email','multi_value',2,NULL),
  ('agency','website','highest_confidence',1,NULL),
  ('agency','address','highest_confidence',1,NULL),
  ('agency','logo_url','latest_observed',1,NULL),
  -- Prospect
  ('prospect','mobile','latest_observed',1,NULL),
  ('prospect','email','multi_value',3,NULL),
  ('prospect','phone','latest_observed',1,NULL),
  ('prospect','full_name','manual_always_wins',1,NULL),
  ('prospect','job_title','latest_observed',1,NULL),
  ('prospect','profile_image','latest_observed',1,NULL),
  ('prospect','linkedin_url','highest_confidence',1,NULL)
ON CONFLICT (entity_type, field_name) DO UPDATE
  SET policy = EXCLUDED.policy,
      multi_value_max = EXCLUDED.multi_value_max,
      notes = EXCLUDED.notes,
      updated_at = now();

-- ── 4. Normalization helper ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION safr_normalize(p_field_name text, p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  digits text;
BEGIN
  IF p_value IS NULL OR length(btrim(p_value)) = 0 THEN
    RETURN NULL;
  END IF;

  IF p_field_name IN ('mobile','phone') THEN
    -- Strip everything except digits and leading plus.
    digits := regexp_replace(p_value, '[^0-9+]', '', 'g');
    -- 0xxxxxxxxx  ->  +61xxxxxxxxx
    digits := regexp_replace(digits, '^0', '+61');
    -- 61xxxxxxxxx (no plus) -> +61xxxxxxxxx
    IF digits ~ '^61[0-9]{9}$' THEN
      digits := '+' || digits;
    END IF;
    RETURN digits;
  ELSIF p_field_name = 'email' THEN
    RETURN lower(btrim(p_value));
  ELSIF p_field_name = 'website' THEN
    RETURN regexp_replace(lower(btrim(p_value)), '^https?://(www\.)?|/$', '', 'g');
  ELSIF p_field_name = 'full_name' THEN
    RETURN regexp_replace(btrim(lower(p_value)), '\s+', ' ', 'g');
  ELSE
    RETURN btrim(p_value);
  END IF;
END;
$fn$;

-- ── 5. Legacy mirror ───────────────────────────────────────────────────────
-- Writes the promoted value back to the canonical legacy column so existing
-- frontend reads keep working. Silently no-ops when no mapping exists.
CREATE OR REPLACE FUNCTION safr_mirror_to_legacy(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_value text
) RETURNS boolean LANGUAGE plpgsql AS $fn$
DECLARE
  m record;
  sql text;
BEGIN
  SELECT * INTO m FROM safr_legacy_field_map
    WHERE entity_type = p_entity_type AND field_name = p_field_name;
  IF NOT FOUND THEN RETURN false; END IF;

  sql := format(
    'UPDATE %I SET %I = $1, updated_at = now() WHERE id = $2',
    m.table_name, m.column_name
  );
  BEGIN
    EXECUTE sql USING p_value, p_entity_id;
  EXCEPTION WHEN undefined_column THEN
    -- Some target tables (e.g. pulse_agents) may not have updated_at in all
    -- environments; fall back to a no-updated_at update.
    sql := format('UPDATE %I SET %I = $1 WHERE id = $2', m.table_name, m.column_name);
    EXECUTE sql USING p_value, p_entity_id;
  END;
  RETURN true;
END;
$fn$;

-- ── 6. Timeline emission helper ────────────────────────────────────────────
-- Emits a pulse_timeline row for a field-level event. Best effort: errors
-- are swallowed so the primary RPC path never fails because of telemetry.
CREATE OR REPLACE FUNCTION safr_emit_timeline(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_event_type text,
  p_before jsonb,
  p_after jsonb,
  p_source text,
  p_user_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_timeline_entity text;
  v_pulse_id uuid;
  v_crm_id uuid;
  v_idem text;
BEGIN
  -- Map SAFR entity_type -> pulse_timeline entity_type column
  v_timeline_entity := CASE
    WHEN p_entity_type IN ('contact','organization') THEN 'crm_' || p_entity_type
    ELSE p_entity_type
  END;

  IF p_entity_type IN ('agent','agency','prospect') THEN
    v_pulse_id := p_entity_id;
  ELSE
    v_crm_id := p_entity_id;
  END IF;

  v_idem := format('safr:%s:%s:%s:%s:%s',
    p_event_type, p_entity_type, p_entity_id, p_field_name,
    coalesce((p_after->>'value_normalized'), 'null'));

  BEGIN
    INSERT INTO pulse_timeline (
      event_type, entity_type, pulse_entity_id, crm_entity_id,
      title, description, previous_value, new_value, source, metadata,
      idempotency_key
    ) VALUES (
      p_event_type, v_timeline_entity, v_pulse_id, v_crm_id,
      format('%s · %s', p_entity_type, p_field_name),
      format('Field %s %s (source=%s)', p_field_name, p_event_type, coalesce(p_source,'unknown')),
      p_before, p_after, p_source,
      jsonb_build_object('field', p_field_name, 'user_id', p_user_id),
      v_idem
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Best effort only.
    NULL;
  END;
END;
$fn$;

-- Register new timeline event types (idempotent).
INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  ('field_promoted','field','SAFR: field value promoted as canonical'),
  ('field_dismissed','field','SAFR: field source dismissed'),
  ('field_locked','field','SAFR: field value locked by user'),
  ('field_unlocked','field','SAFR: field value unlocked, auto-resolution restored')
ON CONFLICT (event_type) DO NOTHING;

-- ── 7. Scoring + resolution ────────────────────────────────────────────────
-- Internal: given all active rows for a (entity, field) triple, pick the
-- winner per the policy and return the winning row id.
CREATE OR REPLACE FUNCTION safr_pick_winner(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text
) RETURNS TABLE (winner_id uuid, is_multi boolean, winners uuid[])
LANGUAGE plpgsql AS $fn$
DECLARE
  v_policy record;
  v_multi_max int;
BEGIN
  SELECT * INTO v_policy FROM field_merge_policies
    WHERE entity_type = p_entity_type AND field_name = p_field_name;
  v_multi_max := COALESCE(v_policy.multi_value_max, 1);

  IF v_policy IS NULL OR v_policy.policy = 'latest_observed' THEN
    RETURN QUERY
      SELECT efs.id, false, ARRAY[efs.id]::uuid[]
      FROM entity_field_sources efs
      WHERE efs.entity_type = p_entity_type
        AND efs.entity_id = p_entity_id
        AND efs.field_name = p_field_name
        AND efs.status IN ('active','promoted')
      ORDER BY efs.last_seen_at DESC, efs.confidence DESC
      LIMIT 1;
    RETURN;
  ELSIF v_policy.policy = 'highest_confidence' THEN
    RETURN QUERY
      SELECT efs.id, false, ARRAY[efs.id]::uuid[]
      FROM entity_field_sources efs
      WHERE efs.entity_type = p_entity_type
        AND efs.entity_id = p_entity_id
        AND efs.field_name = p_field_name
        AND efs.status IN ('active','promoted')
      ORDER BY efs.confidence DESC, efs.last_seen_at DESC
      LIMIT 1;
    RETURN;
  ELSIF v_policy.policy = 'manual_always_wins' THEN
    -- Prefer source='manual' row; fall back to latest_observed if none.
    RETURN QUERY
      SELECT efs.id, false, ARRAY[efs.id]::uuid[]
      FROM entity_field_sources efs
      WHERE efs.entity_type = p_entity_type
        AND efs.entity_id = p_entity_id
        AND efs.field_name = p_field_name
        AND efs.status IN ('active','promoted')
      ORDER BY (efs.source = 'manual') DESC, efs.last_seen_at DESC, efs.confidence DESC
      LIMIT 1;
    RETURN;
  ELSIF v_policy.policy = 'consensus_of_sources' THEN
    -- Value with the most distinct sources wins.
    RETURN QUERY
      WITH scored AS (
        SELECT efs.value_normalized,
               COUNT(DISTINCT efs.source) AS n_sources,
               MAX(efs.confidence) AS max_conf,
               MAX(efs.last_seen_at) AS last_seen
        FROM entity_field_sources efs
        WHERE efs.entity_type = p_entity_type
          AND efs.entity_id = p_entity_id
          AND efs.field_name = p_field_name
          AND efs.status IN ('active','promoted')
        GROUP BY efs.value_normalized
      ), winner_val AS (
        SELECT value_normalized FROM scored
        ORDER BY n_sources DESC, max_conf DESC, last_seen DESC LIMIT 1
      )
      SELECT efs.id, false, ARRAY[efs.id]::uuid[]
      FROM entity_field_sources efs
      JOIN winner_val wv ON wv.value_normalized = efs.value_normalized
      WHERE efs.entity_type = p_entity_type
        AND efs.entity_id = p_entity_id
        AND efs.field_name = p_field_name
        AND efs.status IN ('active','promoted')
      ORDER BY efs.confidence DESC, efs.last_seen_at DESC
      LIMIT 1;
    RETURN;
  ELSIF v_policy.policy = 'multi_value' THEN
    RETURN QUERY
      WITH ranked AS (
        SELECT efs.id, efs.confidence, efs.last_seen_at,
               ROW_NUMBER() OVER (
                 PARTITION BY efs.value_normalized
                 ORDER BY efs.confidence DESC, efs.last_seen_at DESC
               ) AS rn_val
        FROM entity_field_sources efs
        WHERE efs.entity_type = p_entity_type
          AND efs.entity_id = p_entity_id
          AND efs.field_name = p_field_name
          AND efs.status IN ('active','promoted')
      ), top AS (
        SELECT id FROM ranked WHERE rn_val = 1
        ORDER BY confidence DESC, last_seen_at DESC
        LIMIT v_multi_max
      )
      SELECT (SELECT id FROM top LIMIT 1), true, ARRAY(SELECT id FROM top);
    RETURN;
  END IF;
END;
$fn$;

-- Internal: given a (entity, field), enforce resolver state by promoting the
-- winner and superseding any other currently promoted rows. Mirrors to legacy.
-- Emits timeline when promoted value actually changes.
CREATE OR REPLACE FUNCTION safr_reresolve(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  v_policy record;
  v_locked record;
  v_current_promoted record;
  v_winner record;
  v_winners uuid[];
  v_is_multi boolean;
  v_changed boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_mirror_value text;
BEGIN
  SELECT * INTO v_policy FROM field_merge_policies
    WHERE entity_type = p_entity_type AND field_name = p_field_name;

  -- Locked row short-circuit
  SELECT * INTO v_locked FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND locked_at IS NOT NULL
      AND status <> 'dismissed'
    ORDER BY locked_at DESC
    LIMIT 1;

  IF v_locked.id IS NOT NULL THEN
    -- Mirror the locked value just in case the legacy column drifted.
    PERFORM safr_mirror_to_legacy(p_entity_type, p_entity_id, p_field_name, v_locked.value_normalized);
    RETURN jsonb_build_object(
      'promoted_id', v_locked.id,
      'promotion_changed', false,
      'locked', true
    );
  END IF;

  SELECT * INTO v_current_promoted FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND status = 'promoted'
    LIMIT 1;

  SELECT * INTO v_winner FROM safr_pick_winner(p_entity_type, p_entity_id, p_field_name);
  v_winners := v_winner.winners;
  v_is_multi := COALESCE(v_winner.is_multi, false);

  IF v_winner.winner_id IS NULL THEN
    RETURN jsonb_build_object('promoted_id', NULL, 'promotion_changed', false);
  END IF;

  IF v_is_multi THEN
    -- Multi-value: promote every winner in set, supersede rows outside.
    UPDATE entity_field_sources
      SET status = 'promoted', promoted_at = now(), updated_at = now()
      WHERE id = ANY(v_winners) AND status <> 'promoted';
    UPDATE entity_field_sources
      SET status = CASE WHEN status='dismissed' THEN 'dismissed' ELSE 'active' END,
          updated_at = now()
      WHERE entity_type = p_entity_type AND entity_id = p_entity_id
        AND field_name = p_field_name
        AND status = 'promoted' AND NOT (id = ANY(v_winners));
    -- Mirror primary (first) winner.
    SELECT value_normalized INTO v_mirror_value FROM entity_field_sources
      WHERE id = v_winner.winner_id;
    PERFORM safr_mirror_to_legacy(p_entity_type, p_entity_id, p_field_name, v_mirror_value);
    RETURN jsonb_build_object('promoted_ids', to_jsonb(v_winners), 'promotion_changed', true, 'multi_value', true);
  END IF;

  -- Single-value: check if winner differs from current promoted.
  IF v_current_promoted.id IS NULL OR v_current_promoted.id <> v_winner.winner_id THEN
    v_changed := true;
    v_before := CASE WHEN v_current_promoted.id IS NULL THEN NULL ELSE jsonb_build_object(
      'value_normalized', v_current_promoted.value_normalized,
      'source', v_current_promoted.source,
      'confidence', v_current_promoted.confidence
    ) END;

    -- Supersede old promoted row (if any).
    IF v_current_promoted.id IS NOT NULL THEN
      UPDATE entity_field_sources
        SET status = 'superseded', updated_at = now()
        WHERE id = v_current_promoted.id;
    END IF;

    UPDATE entity_field_sources
      SET status = 'promoted', promoted_at = now(), updated_at = now()
      WHERE id = v_winner.winner_id
      RETURNING value_normalized INTO v_mirror_value;

    v_after := jsonb_build_object('value_normalized', v_mirror_value);

    PERFORM safr_mirror_to_legacy(p_entity_type, p_entity_id, p_field_name, v_mirror_value);
    -- Emit timeline only on value change (not first-time promotion), so
    -- backfills and first-observation paths don't drown the timeline.
    IF v_current_promoted.id IS NOT NULL THEN
      PERFORM safr_emit_timeline(p_entity_type, p_entity_id, p_field_name,
        'field_promoted', v_before, v_after, NULL, NULL);
    END IF;
  ELSE
    -- Winner is already the promoted row — re-mirror defensively.
    PERFORM safr_mirror_to_legacy(p_entity_type, p_entity_id, p_field_name,
      v_current_promoted.value_normalized);
  END IF;

  RETURN jsonb_build_object(
    'promoted_id', v_winner.winner_id,
    'promotion_changed', v_changed
  );
END;
$fn$;

-- ── 8. Public RPC: record_field_observation ────────────────────────────────
CREATE OR REPLACE FUNCTION record_field_observation(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_value text,
  p_source text,
  p_source_ref_type text DEFAULT NULL,
  p_source_ref_id uuid DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_observed_at timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_norm text;
  v_disp text;
  v_policy record;
  v_prior numeric;
  v_final_conf numeric;
  v_existing record;
  v_inserted boolean := false;
  v_updated boolean := false;
  v_resolve jsonb;
  v_new_row_id uuid;
  v_new_promoted_id uuid;
  v_new_promoted record;
  v_conflict boolean := false;
BEGIN
  v_norm := safr_normalize(p_field_name, p_value);
  IF v_norm IS NULL OR v_norm = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_value');
  END IF;
  v_disp := btrim(p_value);

  SELECT * INTO v_policy FROM field_merge_policies
    WHERE entity_type = p_entity_type AND field_name = p_field_name;

  IF p_confidence IS NULL THEN
    v_prior := COALESCE(
      (v_policy.source_priors ->> p_source)::numeric,
      0.5
    );
  ELSE
    v_prior := p_confidence;
  END IF;
  v_final_conf := GREATEST(LEAST(v_prior, 1.0), 0.0);

  SELECT * INTO v_existing FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND value_normalized = v_norm
      AND source = p_source;

  IF v_existing.id IS NULL THEN
    INSERT INTO entity_field_sources (
      entity_type, entity_id, field_name, value_normalized, value_display,
      source, source_ref_type, source_ref_id, confidence,
      observed_at, first_seen_at, last_seen_at, times_seen
    ) VALUES (
      p_entity_type, p_entity_id, p_field_name, v_norm, v_disp,
      p_source, p_source_ref_type, p_source_ref_id, v_final_conf,
      p_observed_at, p_observed_at, p_observed_at, 1
    )
    RETURNING id INTO v_new_row_id;
    v_inserted := true;
  ELSE
    UPDATE entity_field_sources
      SET last_seen_at = GREATEST(last_seen_at, p_observed_at),
          observed_at = GREATEST(observed_at, p_observed_at),
          times_seen = times_seen + 1,
          confidence = GREATEST(confidence, v_final_conf),
          value_display = COALESCE(value_display, v_disp),
          source_ref_type = COALESCE(source_ref_type, p_source_ref_type),
          source_ref_id = COALESCE(source_ref_id, p_source_ref_id),
          updated_at = now(),
          status = CASE WHEN status = 'superseded' THEN 'active' ELSE status END
      WHERE id = v_existing.id
      RETURNING id INTO v_new_row_id;
    v_updated := true;
  END IF;

  v_resolve := safr_reresolve(p_entity_type, p_entity_id, p_field_name);
  v_new_promoted_id := (v_resolve ->> 'promoted_id')::uuid;

  IF v_new_promoted_id IS NOT NULL THEN
    SELECT * INTO v_new_promoted FROM entity_field_sources WHERE id = v_new_promoted_id;
  END IF;

  -- Conflict: at least one other active row within grace window with conf > 0.5
  SELECT EXISTS (
    SELECT 1 FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name
      AND efs.status = 'active'
      AND efs.confidence > 0.5
      AND efs.value_normalized <> COALESCE(v_new_promoted.value_normalized, '')
      AND efs.last_seen_at > now() - make_interval(days => COALESCE(v_policy.conflict_grace_days, 30))
  ) INTO v_conflict;

  RETURN jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated', v_updated,
    'promotion_changed', (v_resolve ->> 'promotion_changed')::boolean,
    'new_promoted_value', v_new_promoted.value_normalized,
    'conflict_detected', v_conflict,
    'row_id', v_new_row_id
  );
END;
$fn$;

-- ── 9. Public RPC: resolve_entity_field ────────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_entity_field(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_policy record;
  v_locked record;
  v_promoted record;
  v_alternates jsonb;
  v_values jsonb;
  v_conflict boolean := false;
  v_top record;
  v_second record;
BEGIN
  SELECT * INTO v_policy FROM field_merge_policies
    WHERE entity_type = p_entity_type AND field_name = p_field_name;

  SELECT * INTO v_locked FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND locked_at IS NOT NULL
      AND status <> 'dismissed'
    ORDER BY locked_at DESC LIMIT 1;

  IF v_locked.id IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
      'value', efs.value_normalized,
      'display', efs.value_display,
      'source', efs.source,
      'confidence', efs.confidence,
      'times_seen', efs.times_seen,
      'last_seen_at', efs.last_seen_at,
      'dismissed', (efs.status = 'dismissed')
    ) ORDER BY efs.confidence DESC, efs.last_seen_at DESC)
    INTO v_alternates
    FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name AND efs.id <> v_locked.id;

    RETURN jsonb_build_object(
      'value', v_locked.value_normalized,
      'display', v_locked.value_display,
      'source', v_locked.source,
      'confidence', v_locked.confidence,
      'observed_at', v_locked.observed_at,
      'promoted_at', v_locked.promoted_at,
      'locked', true,
      'locked_by_user_id', v_locked.locked_by_user_id,
      'alternates', COALESCE(v_alternates, '[]'::jsonb),
      'conflict', false,
      'policy', COALESCE(v_policy.policy, 'latest_observed')
    );
  END IF;

  IF COALESCE(v_policy.policy,'') = 'multi_value' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'value', efs.value_normalized,
      'display', efs.value_display,
      'source', efs.source,
      'confidence', efs.confidence,
      'times_seen', efs.times_seen,
      'last_seen_at', efs.last_seen_at
    ) ORDER BY efs.confidence DESC, efs.last_seen_at DESC)
    INTO v_values
    FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name AND efs.status = 'promoted';

    SELECT jsonb_agg(jsonb_build_object(
      'value', efs.value_normalized,
      'display', efs.value_display,
      'source', efs.source,
      'confidence', efs.confidence,
      'times_seen', efs.times_seen,
      'last_seen_at', efs.last_seen_at,
      'dismissed', (efs.status='dismissed')
    ) ORDER BY efs.confidence DESC, efs.last_seen_at DESC)
    INTO v_alternates
    FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name AND efs.status IN ('active','dismissed');

    RETURN jsonb_build_object(
      'values', COALESCE(v_values, '[]'::jsonb),
      'alternates', COALESCE(v_alternates, '[]'::jsonb),
      'locked', false,
      'conflict', false,
      'policy', v_policy.policy
    );
  END IF;

  SELECT * INTO v_promoted FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND status = 'promoted'
    LIMIT 1;

  SELECT jsonb_agg(jsonb_build_object(
    'value', efs.value_normalized,
    'display', efs.value_display,
    'source', efs.source,
    'confidence', efs.confidence,
    'times_seen', efs.times_seen,
    'last_seen_at', efs.last_seen_at,
    'dismissed', (efs.status='dismissed')
  ) ORDER BY efs.confidence DESC, efs.last_seen_at DESC)
  INTO v_alternates
  FROM entity_field_sources efs
  WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
    AND efs.field_name = p_field_name
    AND (v_promoted.id IS NULL OR efs.id <> v_promoted.id);

  -- Conflict detection: top two candidates differ, both > 0.5, within grace.
  SELECT efs.* INTO v_top FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name AND efs.status IN ('active','promoted')
    ORDER BY efs.confidence DESC, efs.last_seen_at DESC LIMIT 1;
  SELECT efs.* INTO v_second FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name AND efs.status IN ('active','promoted')
      AND (v_top.id IS NULL OR efs.id <> v_top.id)
      AND efs.value_normalized <> COALESCE(v_top.value_normalized,'')
    ORDER BY efs.confidence DESC, efs.last_seen_at DESC LIMIT 1;

  IF v_top.id IS NOT NULL AND v_second.id IS NOT NULL
     AND v_top.confidence > 0.5 AND v_second.confidence > 0.5
     AND abs(EXTRACT(EPOCH FROM (v_top.last_seen_at - v_second.last_seen_at)))
         < COALESCE(v_policy.conflict_grace_days, 30) * 86400
  THEN
    v_conflict := true;
  END IF;

  IF v_promoted.id IS NULL THEN
    RETURN jsonb_build_object(
      'value', NULL,
      'display', NULL,
      'source', NULL,
      'confidence', NULL,
      'observed_at', NULL,
      'promoted_at', NULL,
      'locked', false,
      'alternates', COALESCE(v_alternates, '[]'::jsonb),
      'conflict', v_conflict,
      'policy', COALESCE(v_policy.policy, 'latest_observed')
    );
  END IF;

  RETURN jsonb_build_object(
    'value', v_promoted.value_normalized,
    'display', v_promoted.value_display,
    'source', v_promoted.source,
    'confidence', v_promoted.confidence,
    'observed_at', v_promoted.observed_at,
    'promoted_at', v_promoted.promoted_at,
    'locked', false,
    'alternates', COALESCE(v_alternates, '[]'::jsonb),
    'conflict', v_conflict,
    'policy', COALESCE(v_policy.policy, 'latest_observed')
  );
END;
$fn$;

-- ── 10. Public RPC: promote_entity_field ───────────────────────────────────
CREATE OR REPLACE FUNCTION promote_entity_field(
  p_source_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_row record;
  v_old_promoted record;
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT * INTO v_row FROM entity_field_sources WHERE id = p_source_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_old_promoted FROM entity_field_sources
    WHERE entity_type = v_row.entity_type AND entity_id = v_row.entity_id
      AND field_name = v_row.field_name AND status = 'promoted'
      AND id <> v_row.id;

  IF v_old_promoted.id IS NOT NULL THEN
    UPDATE entity_field_sources SET status = 'superseded', updated_at = now()
      WHERE id = v_old_promoted.id;
    v_before := jsonb_build_object(
      'value_normalized', v_old_promoted.value_normalized,
      'source', v_old_promoted.source,
      'confidence', v_old_promoted.confidence
    );
  END IF;

  UPDATE entity_field_sources
    SET status = 'promoted', promoted_at = now(), updated_at = now()
    WHERE id = p_source_id;

  v_after := jsonb_build_object(
    'value_normalized', v_row.value_normalized,
    'source', v_row.source,
    'confidence', v_row.confidence
  );

  PERFORM safr_mirror_to_legacy(v_row.entity_type, v_row.entity_id, v_row.field_name, v_row.value_normalized);
  PERFORM safr_emit_timeline(v_row.entity_type, v_row.entity_id, v_row.field_name,
    'field_promoted', v_before, v_after, v_row.source, p_user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'resolved', resolve_entity_field(v_row.entity_type, v_row.entity_id, v_row.field_name)
  );
END;
$fn$;

-- ── 11. Public RPC: lock_entity_field ──────────────────────────────────────
CREATE OR REPLACE FUNCTION lock_entity_field(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_value_normalized text,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_target record;
  v_old_promoted record;
  v_norm text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_norm := safr_normalize(p_field_name, p_value_normalized);
  IF v_norm IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_value');
  END IF;

  SELECT * INTO v_target FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND value_normalized = v_norm
    ORDER BY confidence DESC, last_seen_at DESC
    LIMIT 1;

  IF v_target.id IS NULL THEN
    -- Synthesize a manual row so locks always have a target.
    INSERT INTO entity_field_sources (
      entity_type, entity_id, field_name, value_normalized, value_display,
      source, confidence, status
    ) VALUES (
      p_entity_type, p_entity_id, p_field_name, v_norm, p_value_normalized,
      'manual', 1.0, 'active'
    ) RETURNING * INTO v_target;
  END IF;

  -- Supersede any existing promoted row with a different value.
  SELECT * INTO v_old_promoted FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND status = 'promoted'
      AND id <> v_target.id;
  IF v_old_promoted.id IS NOT NULL THEN
    UPDATE entity_field_sources SET status='superseded', updated_at=now()
      WHERE id = v_old_promoted.id;
    v_before := jsonb_build_object(
      'value_normalized', v_old_promoted.value_normalized,
      'source', v_old_promoted.source);
  END IF;

  UPDATE entity_field_sources
    SET locked_at = now(), locked_by_user_id = p_user_id,
        status = 'promoted', promoted_at = COALESCE(promoted_at, now()),
        updated_at = now()
    WHERE id = v_target.id;

  v_after := jsonb_build_object('value_normalized', v_norm, 'locked', true);

  PERFORM safr_mirror_to_legacy(p_entity_type, p_entity_id, p_field_name, v_norm);
  PERFORM safr_emit_timeline(p_entity_type, p_entity_id, p_field_name,
    'field_locked', v_before, v_after, v_target.source, p_user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'resolved', resolve_entity_field(p_entity_type, p_entity_id, p_field_name)
  );
END;
$fn$;

-- ── 12. Public RPC: unlock_entity_field (+ restore_field_auto_resolution) ──
CREATE OR REPLACE FUNCTION unlock_entity_field(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_locked record;
  v_before jsonb;
BEGIN
  SELECT * INTO v_locked FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND locked_at IS NOT NULL
    ORDER BY locked_at DESC LIMIT 1;

  IF v_locked.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'not_locked');
  END IF;

  v_before := jsonb_build_object('value_normalized', v_locked.value_normalized, 'locked', true);

  UPDATE entity_field_sources
    SET locked_at = NULL, locked_by_user_id = NULL, updated_at = now()
    WHERE id = v_locked.id;

  PERFORM safr_reresolve(p_entity_type, p_entity_id, p_field_name);
  PERFORM safr_emit_timeline(p_entity_type, p_entity_id, p_field_name,
    'field_unlocked', v_before, jsonb_build_object('locked', false),
    v_locked.source, p_user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'resolved', resolve_entity_field(p_entity_type, p_entity_id, p_field_name)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION restore_field_auto_resolution(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN unlock_entity_field(p_entity_type, p_entity_id, p_field_name, p_user_id);
END;
$fn$;

-- ── 13. Public RPC: dismiss_field_source ───────────────────────────────────
CREATE OR REPLACE FUNCTION dismiss_field_source(
  p_source_id uuid,
  p_user_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_row record;
  v_before jsonb;
BEGIN
  SELECT * INTO v_row FROM entity_field_sources WHERE id = p_source_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_before := jsonb_build_object(
    'value_normalized', v_row.value_normalized,
    'source', v_row.source, 'status', v_row.status);

  UPDATE entity_field_sources
    SET status = 'dismissed', dismissed_at = now(), updated_at = now()
    WHERE id = p_source_id;

  PERFORM safr_reresolve(v_row.entity_type, v_row.entity_id, v_row.field_name);
  PERFORM safr_emit_timeline(v_row.entity_type, v_row.entity_id, v_row.field_name,
    'field_dismissed', v_before,
    jsonb_build_object('status','dismissed','reason',p_reason),
    v_row.source, p_user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'resolved', resolve_entity_field(v_row.entity_type, v_row.entity_id, v_row.field_name)
  );
END;
$fn$;

COMMIT;

-- ── 14. Self-tests ─────────────────────────────────────────────────────────
DO $tests$
DECLARE
  v_n1 text;
  v_n2 text;
  v_n3 text;
  v_n4 text;
  v_id uuid;
  v_resolved jsonb;
  v_test_entity uuid := gen_random_uuid();
BEGIN
  -- Normalization
  SELECT safr_normalize('mobile', '0404 123 456') INTO v_n1;
  ASSERT v_n1 = '+61404123456', format('normalize mobile got %s', v_n1);

  SELECT safr_normalize('email', '  Foo@Bar.COM  ') INTO v_n2;
  ASSERT v_n2 = 'foo@bar.com', format('normalize email got %s', v_n2);

  SELECT safr_normalize('website', 'HTTPS://www.Example.com/') INTO v_n3;
  ASSERT v_n3 = 'example.com', format('normalize website got %s', v_n3);

  SELECT safr_normalize('full_name', '  JOHN    SMITH  ') INTO v_n4;
  ASSERT v_n4 = 'john smith', format('normalize full_name got %s', v_n4);

  -- Record + resolve on a synthetic contact
  PERFORM record_field_observation(
    'contact', v_test_entity, 'mobile', '0404 123 456',
    'rea_scrape', NULL, NULL, NULL, now());
  v_resolved := resolve_entity_field('contact', v_test_entity, 'mobile');
  ASSERT (v_resolved ->> 'value') = '+61404123456',
    format('resolve returned %s', v_resolved);

  -- Newer observation from manual wins under latest_observed policy
  PERFORM record_field_observation(
    'contact', v_test_entity, 'mobile', '0412 987 654',
    'manual', NULL, NULL, NULL, now() + interval '1 second');
  v_resolved := resolve_entity_field('contact', v_test_entity, 'mobile');
  ASSERT (v_resolved ->> 'value') = '+61412987654',
    format('latest_observed failed: %s', v_resolved);

  -- Lock the original scrape value — it should stick regardless of newer ones
  PERFORM lock_entity_field('contact', v_test_entity, 'mobile', '0404 123 456', NULL);
  v_resolved := resolve_entity_field('contact', v_test_entity, 'mobile');
  ASSERT (v_resolved ->> 'value') = '+61404123456',
    format('lock failed: %s', v_resolved);
  ASSERT (v_resolved ->> 'locked')::boolean = true,
    format('locked flag missing: %s', v_resolved);

  -- Newer observation must NOT displace a locked row
  PERFORM record_field_observation(
    'contact', v_test_entity, 'mobile', '0499 111 222',
    'rea_scrape', NULL, NULL, NULL, now() + interval '2 second');
  v_resolved := resolve_entity_field('contact', v_test_entity, 'mobile');
  ASSERT (v_resolved ->> 'value') = '+61404123456',
    format('lock leaked: %s', v_resolved);

  -- Unlock should let latest observed win again
  PERFORM unlock_entity_field('contact', v_test_entity, 'mobile', NULL);
  v_resolved := resolve_entity_field('contact', v_test_entity, 'mobile');
  ASSERT (v_resolved ->> 'value') = '+61499111222',
    format('unlock+re-resolve failed: %s', v_resolved);

  -- Cleanup synthetic rows
  DELETE FROM entity_field_sources WHERE entity_id = v_test_entity;
  DELETE FROM pulse_timeline WHERE metadata->>'user_id' IS NULL
    AND idempotency_key LIKE 'safr:%';  -- best-effort

  RAISE NOTICE 'SAFR migration 178 self-tests passed.';
END;
$tests$;
