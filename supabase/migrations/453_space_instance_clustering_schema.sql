-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 453 — W11.8 Space Instance Clustering: schema additions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: W11.8 Space Instance Clustering (Joseph signed off 2026-05-02).
--
-- Two physically-different rooms of the same `space_type` (e.g. downstairs vs
-- upstairs lounge, two kitchens in a duplex) currently look identical to the
-- engine. This migration introduces `space_instance_id` — a per-round
-- identifier shared by all composition_groups that depict the SAME PHYSICAL
-- ROOM. Detection happens via an LLM clustering pass between Stage 1 and
-- Stage 4 (new edge fn `shortlisting-detect-instances`).
--
-- ─── TRACK A — adds ─────────────────────────────────────────────────────────
-- 1. composition_groups: + space_instance_id (UUID, nullable),
--                        + space_instance_confidence (NUMERIC, nullable)
-- 2. shortlisting_space_instances (NEW): one row per detected instance per
--    round.
-- 3. shortlisting_position_decisions: + space_instance_id (UUID, nullable) so
--    Stage 4 can record which instance fed each position.
--
-- ─── DESIGN DECISIONS ───────────────────────────────────────────────────────
-- 1. UUID instead of integer for space_instance_id: aligns with existing
--    composition_groups identifier patterns + lets us reference rows directly
--    once `shortlisting_space_instances` is populated.
-- 2. RLS read = master_admin/admin/manager (matches shortlisting_rounds);
--    write = master_admin/admin (operator merge/split/rename); service_role
--    full (engine writes).
-- 3. UNIQUE (round_id, space_type, instance_index) prevents the engine from
--    racing two detect_instances jobs into duplicate rows for the same round.
-- 4. operator_split_from / operator_merged_into: nullable self-FKs let an
--    audit trail trace splits and merges without needing a separate table.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- DROP TABLE public.shortlisting_space_instances CASCADE;
-- ALTER TABLE composition_groups
--   DROP COLUMN IF EXISTS space_instance_id,
--   DROP COLUMN IF EXISTS space_instance_confidence;
-- ALTER TABLE shortlisting_position_decisions
--   DROP COLUMN IF EXISTS space_instance_id;
-- (Rollback drops detected instances; re-run shortlisting-detect-instances to
-- repopulate.)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. composition_groups: per-group instance assignment ───────────────────

ALTER TABLE public.composition_groups
  ADD COLUMN IF NOT EXISTS space_instance_id UUID,
  ADD COLUMN IF NOT EXISTS space_instance_confidence NUMERIC;

COMMENT ON COLUMN public.composition_groups.space_instance_id IS
  'W11.8: FK-by-convention (no DB FK because rows are written before the '
  'shortlisting_space_instances row exists in some race orderings) to '
  'shortlisting_space_instances.id. Identifies which physical-room cluster '
  'this group belongs to. NULL until shortlisting-detect-instances runs.';

COMMENT ON COLUMN public.composition_groups.space_instance_confidence IS
  'W11.8: 0-1 confidence the LLM clusterer assigned to this group''s instance '
  'membership. <0.5 emits a space_instance_low_confidence event for operator '
  'review.';

CREATE INDEX IF NOT EXISTS idx_composition_groups_space_instance_id
  ON public.composition_groups(space_instance_id)
  WHERE space_instance_id IS NOT NULL;

-- ─── 2. shortlisting_space_instances ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.shortlisting_space_instances (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id                 UUID NOT NULL REFERENCES public.shortlisting_rounds(id) ON DELETE CASCADE,
  project_id               UUID NOT NULL,
  space_type               TEXT NOT NULL,
  instance_index           INT  NOT NULL,
  display_label            TEXT,
  display_label_source     TEXT NOT NULL DEFAULT 'auto_derived'
                            CHECK (display_label_source IN ('auto_derived','operator_renamed')),
  dominant_colors          JSONB,
  distinctive_features     TEXT[],
  representative_group_id  UUID REFERENCES public.composition_groups(id) ON DELETE SET NULL,
  member_group_count       INT  NOT NULL,
  member_group_ids         UUID[] NOT NULL,
  cluster_confidence       NUMERIC NOT NULL,
  operator_renamed         BOOLEAN NOT NULL DEFAULT FALSE,
  operator_split_from      UUID REFERENCES public.shortlisting_space_instances(id) ON DELETE SET NULL,
  operator_merged_into     UUID REFERENCES public.shortlisting_space_instances(id) ON DELETE SET NULL,
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shortlisting_space_instances_round_space_index_uq
    UNIQUE (round_id, space_type, instance_index),
  CONSTRAINT shortlisting_space_instances_index_chk
    CHECK (instance_index >= 1),
  CONSTRAINT shortlisting_space_instances_member_count_chk
    CHECK (member_group_count >= 1)
);

COMMENT ON TABLE public.shortlisting_space_instances IS
  'W11.8: one row per detected physical-room INSTANCE per round. Two kitchens '
  'in a duplex → two rows with space_type=''kitchen'', instance_index 1 and 2. '
  'Populated by shortlisting-detect-instances between Stage 1 and Stage 4. '
  'Operators can rename, merge, or split via the audit panel RPCs (INST-C).';

COMMENT ON COLUMN public.shortlisting_space_instances.instance_index IS
  '1-indexed ordering within the (round_id, space_type) bucket. Populated by '
  'the LLM clusterer in member-count-desc order. Stable across re-runs.';

COMMENT ON COLUMN public.shortlisting_space_instances.display_label IS
  'Operator-readable name. Auto-derived format: "<Space type>" for instance '
  '1, "<Space type> 2" for instance 2, etc. Operator override sets '
  'display_label_source=''operator_renamed''.';

COMMENT ON COLUMN public.shortlisting_space_instances.member_group_ids IS
  'Array of composition_groups.id values that belong to this instance. '
  'Maintained alongside composition_groups.space_instance_id (the array is '
  'denormalised for fast read-back without a JOIN).';

COMMENT ON COLUMN public.shortlisting_space_instances.cluster_confidence IS
  '0-1 LLM-reported confidence the cluster is internally consistent. Low '
  'confidence (<0.5) emits a space_instance_low_confidence event.';

CREATE INDEX IF NOT EXISTS idx_space_instances_round
  ON public.shortlisting_space_instances(round_id);

CREATE INDEX IF NOT EXISTS idx_space_instances_round_space
  ON public.shortlisting_space_instances(round_id, space_type);

-- updated_at trigger so operator edits stamp the row
CREATE OR REPLACE FUNCTION public._space_instances_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_space_instances_set_updated_at
  ON public.shortlisting_space_instances;
CREATE TRIGGER trg_space_instances_set_updated_at
  BEFORE UPDATE ON public.shortlisting_space_instances
  FOR EACH ROW
  EXECUTE FUNCTION public._space_instances_set_updated_at();

ALTER TABLE public.shortlisting_space_instances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS space_instances_read ON public.shortlisting_space_instances;
CREATE POLICY space_instances_read ON public.shortlisting_space_instances
  FOR SELECT
  TO authenticated
  USING ((SELECT public.get_user_role()) IN ('master_admin','admin','manager'));

DROP POLICY IF EXISTS space_instances_write ON public.shortlisting_space_instances;
CREATE POLICY space_instances_write ON public.shortlisting_space_instances
  FOR ALL
  TO authenticated
  USING ((SELECT public.get_user_role()) IN ('master_admin','admin'))
  WITH CHECK ((SELECT public.get_user_role()) IN ('master_admin','admin'));

GRANT ALL ON public.shortlisting_space_instances TO service_role;
GRANT SELECT ON public.shortlisting_space_instances TO authenticated;

-- ─── 3. shortlisting_position_decisions: capture instance per decision ──────

ALTER TABLE public.shortlisting_position_decisions
  ADD COLUMN IF NOT EXISTS space_instance_id UUID
    REFERENCES public.shortlisting_space_instances(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.shortlisting_position_decisions.space_instance_id IS
  'W11.8: which space_instance fed this position. Set by Stage 4 v1.5 when '
  'the model emits space_instance_id alongside the winner. NULL for legacy '
  'decisions (pre-W11.8) and for positions whose space_type does not require '
  'disambiguation (exterior_facade, floorplan, etc.).';

CREATE INDEX IF NOT EXISTS idx_position_decisions_space_instance
  ON public.shortlisting_position_decisions(space_instance_id)
  WHERE space_instance_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
