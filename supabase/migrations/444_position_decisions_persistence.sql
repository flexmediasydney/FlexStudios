-- ─────────────────────────────────────────────────────────────────────────────
-- Mig 444 — position_decisions persistence + auto-promotion (engine rewrite)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Companion migration to R1's mig 443. R1 ships:
--   - public.gallery_positions          (constraint tuples, scope-resolved)
--   - rename shortlisting_tiers -> shortlisting_grades
--   - engine_mode_override on packages + products
--   - purge of unused slot_allocations + deactivation of 33 stub slots
--
-- This migration ships the OUTBOUND half of the new engine: where Stage 4
-- writes its position-by-position decisions, where it suggests new templates,
-- and the auto-promotion fn that turns recurring suggestions into saved
-- shortlisting_slot_definitions (initially is_active=false so an operator
-- review still gates the promotion).
--
-- ─── Tables ─────────────────────────────────────────────────────────────────
--   shortlisting_position_decisions
--     One row per (round_id, position_index). Persisted by Stage 4's
--     persistPositionDecisions() helper after each successful Gemini call.
--
--   shortlisting_position_template_suggestions
--     One row per (label, constraint_pattern signature) ACROSS rounds.
--     Coalesced via shortlisting_record_position_template_suggestion() so
--     N observations of the same pattern accumulate evidence on one row.
--
-- ─── Functions ──────────────────────────────────────────────────────────────
--   shortlisting_record_position_template_suggestion(...)
--     Insert-or-coalesce called by Stage 4 for each emitted template.
--
--   shortlisting_promote_position_template_suggestions()
--     Weekly auto-promotion: for each suggestion with evidence_round_count
--     >= 5 AND evidence_total_proposals >= 15, INSERT a stub row in
--     shortlisting_slot_definitions with is_active=false + notes='auto-promoted
--     from suggestion <id>'. Updates suggestion status to 'approved' + emits
--     a shortlisting_events row per promotion.
--
-- ─── Cron ───────────────────────────────────────────────────────────────────
--   pg_cron schedule: '0 18 * * 1'  (Mondays 18:00 UTC = ~Tue 04:00 Sydney).
--
-- ─── Rollback ───────────────────────────────────────────────────────────────
-- Reversible via DROP TABLE / DROP FUNCTION. The shortlisting_slot_definitions
-- rows promoted by this fn will remain; that's intentional (they're operator-
-- review-eligible regardless of whether the auto-promoter is still running).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. shortlisting_position_decisions ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.shortlisting_position_decisions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id                 uuid NOT NULL REFERENCES public.shortlisting_rounds(id) ON DELETE CASCADE,
  project_id               uuid NOT NULL,
  position_index           integer NOT NULL,
  phase                    text NOT NULL,
  position_constraints     jsonb,
  winner_group_id          uuid REFERENCES public.composition_groups(id) ON DELETE SET NULL,
  winner_stem              text,
  winner_rationale         text,
  constraint_match_score   numeric,
  slot_fit_score           numeric,
  alternatives             jsonb,
  rejected_near_duplicates jsonb,
  template_slot_id         text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortlisting_position_decisions_phase_chk
    CHECK (phase IN ('mandatory', 'conditional', 'optional')),
  CONSTRAINT shortlisting_position_decisions_position_index_chk
    CHECK (position_index >= 0),
  CONSTRAINT shortlisting_position_decisions_round_position_uq
    UNIQUE (round_id, position_index)
);

COMMENT ON TABLE public.shortlisting_position_decisions IS
  'Mig 444: Stage 4 position-by-position decisions for the constraint-based '
  'engine. One row per (round_id, position_index). Replaces the slot_id-keyed '
  'shortlisting_overrides as Stage 4''s primary output during the cutover '
  'window; legacy slot_decisions[] remain on shortlisting_overrides for one '
  'deploy cycle so the swimlane keeps working.';

CREATE INDEX IF NOT EXISTS idx_shortlisting_position_decisions_round
  ON public.shortlisting_position_decisions (round_id);

CREATE INDEX IF NOT EXISTS idx_shortlisting_position_decisions_project
  ON public.shortlisting_position_decisions (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shortlisting_position_decisions_template
  ON public.shortlisting_position_decisions (template_slot_id)
  WHERE template_slot_id IS NOT NULL;

ALTER TABLE public.shortlisting_position_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shortlisting_position_decisions_read
  ON public.shortlisting_position_decisions;
CREATE POLICY shortlisting_position_decisions_read
  ON public.shortlisting_position_decisions
  FOR SELECT
  USING (
    public.get_user_role() IN ('master_admin', 'admin', 'manager')
    -- my_project_ids() is set-returning; wrap in subquery (set-returning fns
    -- aren't allowed in policy expressions directly).
    OR project_id IN (SELECT public.my_project_ids())
  );

DROP POLICY IF EXISTS shortlisting_position_decisions_admin_write
  ON public.shortlisting_position_decisions;
CREATE POLICY shortlisting_position_decisions_admin_write
  ON public.shortlisting_position_decisions
  FOR ALL
  USING (public.get_user_role() = 'master_admin')
  WITH CHECK (public.get_user_role() = 'master_admin');

GRANT SELECT ON public.shortlisting_position_decisions TO authenticated;
-- service_role bypasses RLS automatically.

-- ─── 2. shortlisting_position_template_suggestions ────────────────────────

CREATE TABLE IF NOT EXISTS public.shortlisting_position_template_suggestions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_template_label     text NOT NULL,
  constraint_pattern          jsonb NOT NULL,
  evidence_round_count        integer NOT NULL DEFAULT 0,
  evidence_total_proposals    integer NOT NULL DEFAULT 0,
  sample_round_ids            uuid[] NOT NULL DEFAULT '{}'::uuid[],
  status                      text NOT NULL DEFAULT 'pending',
  -- SOFT reference: shortlisting_slot_definitions.slot_id is not unique on its
  -- own (versioned via UNIQUE(slot_id, version)) so we can't FK here. We rely
  -- on the auto-promotion fn to populate this column with a slot_id that
  -- exists in shortlisting_slot_definitions; orphan cleanup is handled by the
  -- operator review surface (manual or via a cleanup migration).
  approved_template_slot_id   text,
  reviewed_by                 uuid,
  reviewed_at                 timestamptz,
  reviewer_notes              text,
  first_observed_at           timestamptz NOT NULL DEFAULT now(),
  last_observed_at            timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortlisting_position_template_suggestions_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged'))
);

COMMENT ON TABLE public.shortlisting_position_template_suggestions IS
  'Mig 444: pending Stage 4 proposals for new position templates. Coalesces '
  'evidence ACROSS rounds so the auto-promoter fn can apply a deterministic '
  'threshold (>= 5 distinct rounds AND >= 15 total proposals) before promoting '
  'a pattern into shortlisting_slot_definitions (initially is_active=false).';

-- Deterministic uniqueness: same label + same canonical constraint_pattern
-- collapses to one row across rounds.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shortlisting_position_template_label_pattern
  ON public.shortlisting_position_template_suggestions
  (proposed_template_label, (md5(constraint_pattern::text)));

CREATE INDEX IF NOT EXISTS idx_shortlisting_position_template_status
  ON public.shortlisting_position_template_suggestions (status, last_observed_at DESC);

ALTER TABLE public.shortlisting_position_template_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shortlisting_position_template_suggestions_read
  ON public.shortlisting_position_template_suggestions;
CREATE POLICY shortlisting_position_template_suggestions_read
  ON public.shortlisting_position_template_suggestions
  FOR SELECT
  USING (public.get_user_role() IN ('master_admin', 'admin'));

DROP POLICY IF EXISTS shortlisting_position_template_suggestions_admin_write
  ON public.shortlisting_position_template_suggestions;
CREATE POLICY shortlisting_position_template_suggestions_admin_write
  ON public.shortlisting_position_template_suggestions
  FOR ALL
  USING (public.get_user_role() = 'master_admin')
  WITH CHECK (public.get_user_role() = 'master_admin');

GRANT SELECT ON public.shortlisting_position_template_suggestions TO authenticated;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.shortlisting_position_template_suggestions_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.shortlisting_position_template_suggestions_set_updated_at()
  SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS shortlisting_position_template_suggestions_updated_at_t
  ON public.shortlisting_position_template_suggestions;
CREATE TRIGGER shortlisting_position_template_suggestions_updated_at_t
  BEFORE UPDATE ON public.shortlisting_position_template_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.shortlisting_position_template_suggestions_set_updated_at();

-- ─── 3. RPC: record one suggestion (insert-or-coalesce) ────────────────────

CREATE OR REPLACE FUNCTION public.shortlisting_record_position_template_suggestion(
  p_round_id           uuid,
  p_label              text,
  p_constraint_pattern jsonb,
  p_candidate_stems    jsonb,
  p_reasoning          text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id uuid;
  v_pattern jsonb;
BEGIN
  -- Normalise NULL pattern -> empty object so the unique index can hash.
  v_pattern := COALESCE(p_constraint_pattern, '{}'::jsonb);

  -- Atomic upsert via ON CONFLICT against the (label, md5(pattern)) unique
  -- index. On insert: evidence_round_count=1, sample includes p_round_id.
  -- On conflict: increment counts; append round_id to sample if not already
  -- present (cap at 50 rounds for privacy / size); refresh last_observed_at.
  INSERT INTO public.shortlisting_position_template_suggestions (
    proposed_template_label,
    constraint_pattern,
    evidence_round_count,
    evidence_total_proposals,
    sample_round_ids,
    status,
    last_observed_at
  )
  VALUES (
    p_label,
    v_pattern,
    1,
    1,
    ARRAY[p_round_id]::uuid[],
    'pending',
    now()
  )
  ON CONFLICT (proposed_template_label, (md5(constraint_pattern::text)))
  DO UPDATE SET
    evidence_round_count =
      shortlisting_position_template_suggestions.evidence_round_count
      + CASE WHEN p_round_id = ANY (shortlisting_position_template_suggestions.sample_round_ids)
             THEN 0 ELSE 1 END,
    evidence_total_proposals =
      shortlisting_position_template_suggestions.evidence_total_proposals + 1,
    sample_round_ids =
      CASE
        WHEN p_round_id = ANY (shortlisting_position_template_suggestions.sample_round_ids)
          THEN shortlisting_position_template_suggestions.sample_round_ids
        WHEN array_length(shortlisting_position_template_suggestions.sample_round_ids, 1) >= 50
          THEN shortlisting_position_template_suggestions.sample_round_ids
        ELSE shortlisting_position_template_suggestions.sample_round_ids || ARRAY[p_round_id]::uuid[]
      END,
    last_observed_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.shortlisting_record_position_template_suggestion(
  uuid, text, jsonb, jsonb, text
) SET search_path = public, pg_temp;

-- service_role + master_admin can call. Keep the candidate_stems param as
-- jsonb for forward-compat; current callers pass JSON arrays of strings.
COMMENT ON FUNCTION public.shortlisting_record_position_template_suggestion(
  uuid, text, jsonb, jsonb, text
) IS
  'Mig 444: Stage 4 calls this once per emitted proposed_position_template. '
  'Atomically upserts the (label, constraint_pattern) row, incrementing '
  'evidence counters and tracking distinct rounds (sample_round_ids capped '
  'at 50). Returns the suggestion row id.';

-- ─── 4. Auto-promotion fn ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.shortlisting_promote_position_template_suggestions(
  p_min_rounds    integer DEFAULT 5,
  p_min_proposals integer DEFAULT 15
) RETURNS TABLE (
  suggestion_id  uuid,
  promoted_slot_id text,
  promoted_label   text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  v_slot_id text;
BEGIN
  FOR rec IN
    SELECT *
    FROM public.shortlisting_position_template_suggestions
    WHERE status = 'pending'
      AND evidence_round_count >= p_min_rounds
      AND evidence_total_proposals >= p_min_proposals
    ORDER BY last_observed_at ASC
  LOOP
    -- Build a deterministic slot_id from the label: lowercase, snake_case,
    -- alphanumeric only; collide-prefix with `auto_` so operator-curated
    -- slots don't accidentally clash. Truncate to 60 chars (slot_id col limit
    -- across the codebase is 60).
    v_slot_id := left(
      'auto_' || regexp_replace(
        lower(rec.proposed_template_label),
        '[^a-z0-9]+', '_', 'g'
      ),
      60
    );
    -- Strip trailing underscore from truncation
    v_slot_id := regexp_replace(v_slot_id, '_+$', '');
    -- Avoid collision with an existing slot_id
    IF EXISTS (SELECT 1 FROM public.shortlisting_slot_definitions WHERE slot_id = v_slot_id) THEN
      v_slot_id := left(v_slot_id, 50) || '_' || substring(rec.id::text, 1, 8);
    END IF;

    INSERT INTO public.shortlisting_slot_definitions (
      slot_id,
      display_name,
      phase,
      eligible_when_engine_roles,
      eligible_room_types,
      max_images,
      min_images,
      notes,
      version,
      is_active,
      selection_mode
    ) VALUES (
      v_slot_id,
      rec.proposed_template_label,
      3,                                      -- conservative phase-3 default
      ARRAY[]::text[],                        -- operator must enable engine roles
      ARRAY[]::text[],
      1,
      0,
      format('auto-promoted from suggestion %s; constraint_pattern=%s',
             rec.id, rec.constraint_pattern::text),
      1,
      false,                                  -- inactive until operator review
      'ai_decides'
    )
    -- shortlisting_slot_definitions UNIQUE is on (slot_id, version), not
    -- slot_id alone, so target the composite. Auto-promotion always inserts
    -- with version=1; subsequent versions are operator-curated.
    ON CONFLICT (slot_id, version) DO NOTHING;

    UPDATE public.shortlisting_position_template_suggestions
    SET status = 'approved',
        approved_template_slot_id = v_slot_id,
        reviewed_at = now(),
        reviewer_notes = format('auto-promoted by shortlisting_promote_position_template_suggestions on %s', now())
    WHERE id = rec.id;

    -- Audit event so operators see promotions in the engine event stream.
    INSERT INTO public.shortlisting_events (
      project_id, round_id, event_type, actor_type, actor_id, payload, created_at
    ) VALUES (
      NULL,
      NULL,
      'position_template_auto_promoted',
      'system',
      NULL,
      jsonb_build_object(
        'suggestion_id', rec.id,
        'promoted_slot_id', v_slot_id,
        'label', rec.proposed_template_label,
        'evidence_round_count', rec.evidence_round_count,
        'evidence_total_proposals', rec.evidence_total_proposals,
        'is_active', false
      ),
      now()
    );

    suggestion_id := rec.id;
    promoted_slot_id := v_slot_id;
    promoted_label := rec.proposed_template_label;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$;
ALTER FUNCTION public.shortlisting_promote_position_template_suggestions(integer, integer)
  SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.shortlisting_promote_position_template_suggestions(integer, integer) IS
  'Mig 444: weekly auto-promotion sweep. Reads pending position template '
  'suggestions, promotes those that cleared the evidence threshold into '
  'shortlisting_slot_definitions (is_active=false), updates suggestion status '
  'to ''approved'', and emits one position_template_auto_promoted event per '
  'promotion. Default thresholds: >= 5 distinct rounds AND >= 15 total '
  'proposals. Cron: ''0 18 * * 1'' (Mondays 18:00 UTC).';

REVOKE EXECUTE ON FUNCTION public.shortlisting_promote_position_template_suggestions(integer, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shortlisting_promote_position_template_suggestions(integer, integer)
  TO service_role;

-- ─── 5. pg_cron schedule ────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Drop any existing schedule (idempotent re-run support).
    PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'shortlisting_promote_position_template_suggestions_weekly';

    PERFORM cron.schedule(
      'shortlisting_promote_position_template_suggestions_weekly',
      '0 18 * * 1',  -- Mondays 18:00 UTC = ~Tue 04:00 Sydney
      $cron$
        SELECT public.shortlisting_promote_position_template_suggestions();
      $cron$
    );
  END IF;
END
$$;

COMMIT;

-- ─── Rollback (manual; do NOT run as part of the up migration) ─────────────
--
--   BEGIN;
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule(jobid) FROM cron.job
--         WHERE jobname = 'shortlisting_promote_position_template_suggestions_weekly';
--     END IF;
--   END $$;
--   DROP FUNCTION IF EXISTS public.shortlisting_promote_position_template_suggestions(integer, integer);
--   DROP FUNCTION IF EXISTS public.shortlisting_record_position_template_suggestion(uuid, text, jsonb, jsonb, text);
--   DROP TABLE IF EXISTS public.shortlisting_position_template_suggestions CASCADE;
--   DROP TABLE IF EXISTS public.shortlisting_position_decisions CASCADE;
--   DROP FUNCTION IF EXISTS public.shortlisting_position_template_suggestions_set_updated_at();
--   COMMIT;
