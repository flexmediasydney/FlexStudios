-- 455_space_instance_operator_rpcs.sql
--
-- W11.8 Audit panel — operator override RPCs for shortlisting_space_instances.
--
-- Depends on INST-A's mig 453 (creates `shortlisting_space_instances` table +
-- adds `space_instance_id` column to `composition_groups`).
--
-- Provides four SECURITY DEFINER RPCs, role-gated to master_admin/admin so the
-- Project Details > Shortlisting > Audit subtab can list, rename, merge, and
-- split detected instances per round:
--
--   1. list_space_instances(p_round_id uuid, p_include_merged boolean DEFAULT FALSE)
--      Returns jsonb array; each row includes display_label, dominant_colors,
--      distinctive_features, representative_group_id + dropbox_path,
--      member_group_count + ids, cluster_confidence, operator-flag triplet.
--
--   2. rename_space_instance(p_instance_id uuid, p_new_label text)
--      Sets display_label + display_label_source='operator_renamed' +
--      operator_renamed=TRUE; emits 'space_instance_renamed' event.
--
--   3. merge_space_instances(p_keep_id uuid, p_drop_id uuid)
--      Re-points all composition_groups.space_instance_id from drop → keep,
--      soft-deletes the drop row via operator_merged_into=keep, recomputes
--      member_group_count + ids on the kept row, renumbers instance_index for
--      remaining rows in (round_id, space_type) so they're contiguous 1..N,
--      emits 'space_instances_merged' event.
--
--   4. split_space_instances(p_source_id uuid, p_group_ids_to_split uuid[],
--                            p_new_label text DEFAULT NULL)
--      Inserts new shortlisting_space_instances row with
--      operator_split_from=p_source_id, instance_index=(max+1),
--      member_group_ids=p_group_ids_to_split, display_label_source=
--      'operator_renamed' (operator-authored). Re-points the listed groups,
--      decrements the source's member_group_count + ids. If source ends up
--      with 0 members, soft-deletes it (operator_merged_into=new_id).
--      Returns the new instance's id. Emits 'space_instance_split' event.
--
-- All four RPCs hard-fail on non-master_admin/non-admin role via
-- get_user_role() — UI gating is defence-in-depth only.
--
-- ─── Rollback ──────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.list_space_instances(uuid, boolean);
-- DROP FUNCTION IF EXISTS public.rename_space_instance(uuid, text);
-- DROP FUNCTION IF EXISTS public.merge_space_instances(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.split_space_instances(uuid, uuid[], text);
-- COMMIT;

BEGIN;

-- ─── 1. list_space_instances ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_space_instances(
  p_round_id uuid,
  p_include_merged boolean DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_result jsonb;
BEGIN
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin', 'admin') THEN
    RAISE EXCEPTION 'list_space_instances requires master_admin or admin role (got: %)', v_role
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.space_type, t.instance_index), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      i.id,
      i.round_id,
      i.space_type,
      i.instance_index,
      i.display_label,
      i.display_label_source,
      i.dominant_colors,
      i.distinctive_features,
      i.representative_group_id,
      g.dropbox_preview_path AS representative_dropbox_path,
      i.member_group_count,
      i.member_group_ids,
      i.cluster_confidence,
      i.operator_renamed,
      i.operator_split_from,
      i.operator_merged_into,
      i.detected_at,
      i.updated_at
    FROM public.shortlisting_space_instances i
    LEFT JOIN public.composition_groups g
      ON g.id = i.representative_group_id
    WHERE i.round_id = p_round_id
      AND (p_include_merged OR i.operator_merged_into IS NULL)
  ) t;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.list_space_instances(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_space_instances(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.list_space_instances(uuid, boolean) IS
  'W11.8 audit panel: list space instances for a round with rep-group dropbox path + member counts. master_admin/admin only.';

-- ─── 2. rename_space_instance ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rename_space_instance(
  p_instance_id uuid,
  p_new_label text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_old_label text;
  v_round_id uuid;
  v_project_id uuid;
  v_actor uuid;
BEGIN
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin', 'admin') THEN
    RAISE EXCEPTION 'rename_space_instance requires master_admin or admin role (got: %)', v_role
      USING ERRCODE = '42501';
  END IF;

  IF p_new_label IS NULL OR length(trim(p_new_label)) = 0 THEN
    RAISE EXCEPTION 'p_new_label must be non-empty';
  END IF;

  SELECT i.display_label, i.round_id, r.project_id
  INTO v_old_label, v_round_id, v_project_id
  FROM public.shortlisting_space_instances i
  JOIN public.shortlisting_rounds r ON r.id = i.round_id
  WHERE i.id = p_instance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'space instance % not found', p_instance_id;
  END IF;

  v_actor := public.current_app_user_id();

  UPDATE public.shortlisting_space_instances
  SET display_label = p_new_label,
      display_label_source = 'operator_renamed',
      operator_renamed = TRUE,
      updated_at = now()
  WHERE id = p_instance_id;

  INSERT INTO public.shortlisting_events
    (project_id, round_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_project_id,
    v_round_id,
    'space_instance_renamed',
    'user',
    v_actor,
    jsonb_build_object(
      'instance_id', p_instance_id,
      'old_label', v_old_label,
      'new_label', p_new_label
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rename_space_instance(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_space_instance(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.rename_space_instance(uuid, text) IS
  'W11.8 audit panel: operator rename — sets display_label_source=operator_renamed + emits event. master_admin/admin only.';

-- ─── 3. merge_space_instances ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.merge_space_instances(
  p_keep_id uuid,
  p_drop_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_keep_round_id uuid;
  v_keep_space_type text;
  v_drop_round_id uuid;
  v_drop_space_type text;
  v_project_id uuid;
  v_actor uuid;
  v_moved_group_count integer;
  v_idx integer;
  r_inst record;
BEGIN
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin', 'admin') THEN
    RAISE EXCEPTION 'merge_space_instances requires master_admin or admin role (got: %)', v_role
      USING ERRCODE = '42501';
  END IF;

  IF p_keep_id = p_drop_id THEN
    RAISE EXCEPTION 'cannot merge an instance into itself';
  END IF;

  SELECT i.round_id, i.space_type, r.project_id
  INTO v_keep_round_id, v_keep_space_type, v_project_id
  FROM public.shortlisting_space_instances i
  JOIN public.shortlisting_rounds r ON r.id = i.round_id
  WHERE i.id = p_keep_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'kept instance % not found', p_keep_id;
  END IF;

  SELECT round_id, space_type
  INTO v_drop_round_id, v_drop_space_type
  FROM public.shortlisting_space_instances
  WHERE id = p_drop_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dropped instance % not found', p_drop_id;
  END IF;

  IF v_keep_round_id <> v_drop_round_id THEN
    RAISE EXCEPTION 'cannot merge across rounds (keep round %, drop round %)',
      v_keep_round_id, v_drop_round_id;
  END IF;

  IF v_keep_space_type <> v_drop_space_type THEN
    RAISE EXCEPTION 'cannot merge across space_types (keep %, drop %)',
      v_keep_space_type, v_drop_space_type;
  END IF;

  -- Repoint composition_groups from drop → keep.
  UPDATE public.composition_groups
  SET space_instance_id = p_keep_id
  WHERE space_instance_id = p_drop_id;

  GET DIAGNOSTICS v_moved_group_count = ROW_COUNT;

  -- Soft-delete the dropped instance (audit trail preserved).
  UPDATE public.shortlisting_space_instances
  SET operator_merged_into = p_keep_id,
      updated_at = now()
  WHERE id = p_drop_id;

  -- Recompute member_group_count + member_group_ids for the kept instance.
  UPDATE public.shortlisting_space_instances
  SET member_group_ids = (
        SELECT COALESCE(array_agg(g.id ORDER BY g.id), ARRAY[]::uuid[])
        FROM public.composition_groups g
        WHERE g.space_instance_id = p_keep_id
      ),
      member_group_count = (
        SELECT COUNT(*)
        FROM public.composition_groups g
        WHERE g.space_instance_id = p_keep_id
      ),
      updated_at = now()
  WHERE id = p_keep_id;

  -- Renumber instance_index for live (non-merged) instances within
  -- (round_id, space_type) so they're contiguous 1..N. The kept row keeps
  -- its slot relative to siblings.
  v_idx := 0;
  FOR r_inst IN
    SELECT id
    FROM public.shortlisting_space_instances
    WHERE round_id = v_keep_round_id
      AND space_type = v_keep_space_type
      AND operator_merged_into IS NULL
    ORDER BY instance_index ASC, detected_at ASC, id ASC
  LOOP
    v_idx := v_idx + 1;
    UPDATE public.shortlisting_space_instances
    SET instance_index = v_idx,
        updated_at = now()
    WHERE id = r_inst.id
      AND instance_index <> v_idx;
  END LOOP;

  v_actor := public.current_app_user_id();

  INSERT INTO public.shortlisting_events
    (project_id, round_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_project_id,
    v_keep_round_id,
    'space_instances_merged',
    'user',
    v_actor,
    jsonb_build_object(
      'keep_id', p_keep_id,
      'drop_id', p_drop_id,
      'space_type', v_keep_space_type,
      'moved_group_count', v_moved_group_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_space_instances(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_space_instances(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.merge_space_instances(uuid, uuid) IS
  'W11.8 audit panel: operator merge — repoints groups from drop to keep, soft-deletes drop, renumbers instance_index. master_admin/admin only.';

-- ─── 4. split_space_instances ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.split_space_instances(
  p_source_id uuid,
  p_group_ids_to_split uuid[],
  p_new_label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_round_id uuid;
  v_space_type text;
  v_project_id uuid;
  v_source_label text;
  v_new_id uuid;
  v_new_idx integer;
  v_derived_label text;
  v_label text;
  v_actor uuid;
  v_split_count integer;
  v_remaining integer;
BEGIN
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin', 'admin') THEN
    RAISE EXCEPTION 'split_space_instances requires master_admin or admin role (got: %)', v_role
      USING ERRCODE = '42501';
  END IF;

  IF p_group_ids_to_split IS NULL OR array_length(p_group_ids_to_split, 1) IS NULL THEN
    RAISE EXCEPTION 'p_group_ids_to_split must be a non-empty array';
  END IF;

  SELECT i.round_id, i.space_type, i.display_label, r.project_id
  INTO v_round_id, v_space_type, v_source_label, v_project_id
  FROM public.shortlisting_space_instances i
  JOIN public.shortlisting_rounds r ON r.id = i.round_id
  WHERE i.id = p_source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source instance % not found', p_source_id;
  END IF;

  -- Verify all groups currently belong to the source instance.
  IF EXISTS (
    SELECT 1 FROM unnest(p_group_ids_to_split) AS gid
    WHERE NOT EXISTS (
      SELECT 1 FROM public.composition_groups g
      WHERE g.id = gid AND g.space_instance_id = p_source_id
    )
  ) THEN
    RAISE EXCEPTION 'one or more groups in p_group_ids_to_split do not belong to source instance %', p_source_id;
  END IF;

  -- Pick the next instance_index for this (round, space_type) — taking the
  -- max across both live and soft-deleted rows so we never re-use an index.
  SELECT COALESCE(MAX(instance_index), 0) + 1
  INTO v_new_idx
  FROM public.shortlisting_space_instances
  WHERE round_id = v_round_id
    AND space_type = v_space_type;

  -- Derived label if operator didn't provide one.
  v_derived_label := COALESCE(v_source_label, v_space_type) || ' ' || v_new_idx::text;
  v_label := COALESCE(NULLIF(trim(p_new_label), ''), v_derived_label);

  v_split_count := array_length(p_group_ids_to_split, 1);
  v_new_id := gen_random_uuid();

  INSERT INTO public.shortlisting_space_instances (
    id,
    round_id,
    project_id,
    space_type,
    instance_index,
    display_label,
    display_label_source,
    member_group_ids,
    member_group_count,
    cluster_confidence,
    operator_renamed,
    operator_split_from,
    representative_group_id,
    detected_at,
    updated_at
  )
  VALUES (
    v_new_id,
    v_round_id,
    v_project_id,
    v_space_type,
    v_new_idx,
    v_label,
    'operator_renamed',
    p_group_ids_to_split,
    v_split_count,
    1.0, -- operator-authored split → high confidence
    TRUE,
    p_source_id,
    p_group_ids_to_split[1],
    now(),
    now()
  );

  -- Re-point the listed groups onto the new instance.
  UPDATE public.composition_groups
  SET space_instance_id = v_new_id
  WHERE id = ANY(p_group_ids_to_split);

  -- Decrement the source instance's members.
  UPDATE public.shortlisting_space_instances
  SET member_group_ids = (
        SELECT COALESCE(array_agg(g.id ORDER BY g.id), ARRAY[]::uuid[])
        FROM public.composition_groups g
        WHERE g.space_instance_id = p_source_id
      ),
      member_group_count = (
        SELECT COUNT(*)
        FROM public.composition_groups g
        WHERE g.space_instance_id = p_source_id
      ),
      updated_at = now()
  WHERE id = p_source_id;

  SELECT member_group_count INTO v_remaining
  FROM public.shortlisting_space_instances
  WHERE id = p_source_id;

  -- If the source has zero members left, soft-delete it pointing at new_id.
  IF v_remaining = 0 THEN
    UPDATE public.shortlisting_space_instances
    SET operator_merged_into = v_new_id,
        updated_at = now()
    WHERE id = p_source_id;
  END IF;

  v_actor := public.current_app_user_id();

  INSERT INTO public.shortlisting_events
    (project_id, round_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_project_id,
    v_round_id,
    'space_instance_split',
    'user',
    v_actor,
    jsonb_build_object(
      'source_id', p_source_id,
      'new_id', v_new_id,
      'space_type', v_space_type,
      'split_group_count', v_split_count,
      'new_label', v_label,
      'source_emptied', (v_remaining = 0)
    )
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.split_space_instances(uuid, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.split_space_instances(uuid, uuid[], text) TO authenticated;

COMMENT ON FUNCTION public.split_space_instances(uuid, uuid[], text) IS
  'W11.8 audit panel: operator split — moves listed groups onto a new instance. Returns new id. master_admin/admin only.';

NOTIFY pgrst, 'reload schema';

COMMIT;
