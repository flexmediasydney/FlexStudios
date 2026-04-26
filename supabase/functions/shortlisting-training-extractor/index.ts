/**
 * shortlisting-training-extractor
 * ────────────────────────────────
 * Extracts training examples from a locked shortlisting round. Per spec §14:
 * every confirmed human selection (whether AI proposed it or a human added it)
 * becomes a row in shortlisting_training_examples for future few-shot
 * injection.
 *
 * Invoked by shortlist-lock immediately after the round transitions to
 * status='locked' (via fire-and-forget invokeFunction). Idempotent — if
 * training_examples for this round already exist, they are deleted then
 * re-inserted so re-running produces consistent state.
 *
 * Input source for "what was confirmed":
 *   shortlisting_rounds.confirmed_shortlist_group_ids — populated by
 *   shortlist-lock at the same time it kicks the file moves. This is the
 *   authoritative snapshot of the approved set at lock time.
 *
 * For each confirmed group:
 *   - Read composition_classifications (analysis, scores, room_type, etc.)
 *   - Read pass2_slot_assigned event for the group (slot_id, rank)
 *   - Read shortlisting_overrides for the group to determine was_override
 *     (TRUE if the human took explicit action — added/swapped — to put this
 *     group in the approved set; FALSE if AI proposed it and the human kept
 *     it as proposed)
 *   - Read project pricing_tier
 *   - Compute weight = 1.0 + 0.2 * (variant_count - 1) + (was_override ? 0.3 : 0)
 *     variant_count starts at 1; the finals watcher (B4) will bump it.
 *   - INSERT row into shortlisting_training_examples
 *
 * POST { round_id: string }
 *
 * Auth: master_admin / admin / manager OR service_role.
 *
 * Response:
 *   { ok: true, count: N, total_weight: <sum of weights>, deleted_existing: N }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'shortlisting-training-extractor';

interface RequestBody {
  round_id?: string;
  _health_check?: boolean;
}

interface ClassificationRow {
  group_id: string;
  analysis: string | null;
  room_type: string | null;
  composition_type: string | null;
  zones_visible: string[] | null;
  key_elements: string[] | null;
  combined_score: number | null;
}

interface CompositionGroupRow {
  id: string;
  delivery_reference_stem: string | null;
  best_bracket_stem: string | null;
}

interface SlotEventRow {
  group_id: string | null;
  event_type: string;
  payload: Record<string, unknown> | null;
}

interface OverrideRow {
  ai_proposed_group_id: string | null;
  human_selected_group_id: string | null;
  ai_proposed_score: number | null;
  human_action: string;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse(
        'Forbidden — only master_admin/admin/manager can extract training examples',
        403,
        req,
      );
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id?.trim();
  if (!roundId) return errorResponse('round_id required', 400, req);

  const admin = getAdminClient();

  // ── Round lookup + status guard ─────────────────────────────────────────
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, package_type, status, confirmed_shortlist_group_ids')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) return errorResponse(`round lookup failed: ${roundErr.message}`, 500, req);
  if (!round) return errorResponse(`round ${roundId} not found`, 404, req);
  if (round.status !== 'locked') {
    return errorResponse(
      `round ${roundId} status='${round.status}' — extractor requires status='locked'`,
      409,
      req,
    );
  }

  const confirmedIds: string[] = Array.isArray(round.confirmed_shortlist_group_ids)
    ? round.confirmed_shortlist_group_ids
    : [];
  if (confirmedIds.length === 0) {
    // Nothing to extract — round was locked with no confirmed selections.
    // Still emit the event so dashboards see the run.
    await admin.from('shortlisting_events').insert({
      project_id: round.project_id,
      round_id: round.id,
      event_type: 'training_examples_extracted',
      actor_type: isService ? 'system' : 'user',
      actor_id: isService ? null : (user?.id ?? null),
      payload: { count: 0, total_weight: 0, note: 'no confirmed groups' },
    });
    return jsonResponse(
      { ok: true, round_id: roundId, count: 0, total_weight: 0, deleted_existing: 0 },
      200,
      req,
    );
  }

  // ── Project lookup for tier ─────────────────────────────────────────────
  const { data: project } = await admin
    .from('projects')
    .select('id, pricing_tier')
    .eq('id', round.project_id)
    .maybeSingle();
  const tierRaw = (project?.pricing_tier || '').toLowerCase();
  const projectTier = tierRaw === 'premium' ? 'premium' : 'standard';

  // ── Idempotency: delete any existing training_examples rows for this round ─
  // We don't have a round_id column on training_examples; the only join is
  // composition_group_id → composition_groups → round_id. Delete by FK chain.
  //
  // Bug G4 fix: BEFORE delete, capture each existing row's variant_count so
  // we can preserve it on re-insert. The finals-watcher bumps variant_count
  // when an editor delivers multiple variants of the same composition (e.g.
  // KELV4091 + KELV4091-2 + KELV4091-2-2 = variant_count=3). Without
  // preservation, a re-extract (e.g. admin re-locks the round) resets every
  // composition to variant_count=1 and the editor's variant signal is lost.
  let deletedExisting = 0;
  const priorVariantCounts = new Map<string, number>();
  {
    const { data: existing, error: existingErr } = await admin
      .from('shortlisting_training_examples')
      .select('id, composition_group_id, variant_count')
      .in('composition_group_id', confirmedIds);
    if (existingErr) {
      console.warn(`[${GENERATOR}] existing-rows lookup failed: ${existingErr.message}`);
    } else if (existing && existing.length > 0) {
      // Capture variant_counts BEFORE delete (G4).
      for (const r of existing) {
        const gid = r.composition_group_id as string;
        const vc = typeof r.variant_count === 'number' ? r.variant_count : 1;
        // Keep the MAX if the same group_id appears multiple times (legacy).
        priorVariantCounts.set(gid, Math.max(priorVariantCounts.get(gid) ?? 1, vc));
      }
      const idsToDelete = existing.map((r) => r.id as string);
      const { error: delErr } = await admin
        .from('shortlisting_training_examples')
        .delete()
        .in('id', idsToDelete);
      if (delErr) {
        console.warn(`[${GENERATOR}] existing-rows delete failed: ${delErr.message}`);
      } else {
        deletedExisting = idsToDelete.length;
      }
    }
  }

  // ── Bug G2 fix: pre-fetch active slot_definitions so we can map
  //    slot_id → phase (1=mandatory, 2=conditional). Phase 3 free recs are
  //    detected via event_type and slot_id will be null for them.
  const slotPhaseByIdRes = await admin
    .from('shortlisting_slot_definitions')
    .select('slot_id, phase')
    .eq('is_active', true);
  const slotPhaseById = new Map<string, number>();
  for (const s of slotPhaseByIdRes.data || []) {
    if (typeof s.phase === 'number') slotPhaseById.set(s.slot_id as string, s.phase);
  }

  // ── Fetch context: classifications + groups + slot events + overrides ──
  const [classRes, groupsRes, eventsRes, overridesRes] = await Promise.all([
    admin
      .from('composition_classifications')
      .select(
        'group_id, analysis, room_type, composition_type, zones_visible, key_elements, combined_score',
      )
      .in('group_id', confirmedIds),
    admin
      .from('composition_groups')
      .select('id, delivery_reference_stem, best_bracket_stem')
      .in('id', confirmedIds),
    admin
      .from('shortlisting_events')
      .select('group_id, event_type, payload')
      .eq('round_id', roundId)
      .in('event_type', ['pass2_slot_assigned', 'pass2_phase3_recommendation']),
    admin
      .from('shortlisting_overrides')
      .select('ai_proposed_group_id, human_selected_group_id, ai_proposed_score, human_action')
      .eq('round_id', roundId),
  ]);

  if (classRes.error) return errorResponse(`classifications query failed: ${classRes.error.message}`, 500, req);
  if (groupsRes.error) return errorResponse(`groups query failed: ${groupsRes.error.message}`, 500, req);
  if (eventsRes.error) return errorResponse(`events query failed: ${eventsRes.error.message}`, 500, req);
  if (overridesRes.error) return errorResponse(`overrides query failed: ${overridesRes.error.message}`, 500, req);

  const classifications = (classRes.data || []) as ClassificationRow[];
  const groups = (groupsRes.data || []) as CompositionGroupRow[];
  const slotEvents = (eventsRes.data || []) as SlotEventRow[];
  const overrides = (overridesRes.data || []) as OverrideRow[];

  // ── Build lookup maps ──────────────────────────────────────────────────
  const classByGroup = new Map<string, ClassificationRow>();
  for (const c of classifications) classByGroup.set(c.group_id, c);

  const groupById = new Map<string, CompositionGroupRow>();
  for (const g of groups) groupById.set(g.id, g);

  // Slot events: prefer rank=1 winners over phase3 (rank=1 carries slot_id;
  // phase3 is a recommendation without a slot). Map group_id → { slot_id, rank, phase }.
  // Bug G2 fix: capture `phase` (1/2/3) so the training_examples row can
  // distinguish mandatory winners from conditional fills from free recs.
  const slotByGroup = new Map<
    string,
    { slot_id: string | null; rank: number | null; phase: number | null }
  >();
  for (const ev of slotEvents) {
    if (!ev.group_id) continue;
    const payload = ev.payload || {};
    const slotId = (payload.slot_id as string | undefined) ?? null;
    const rank = typeof payload.rank === 'number' ? (payload.rank as number) : null;
    if (ev.event_type === 'pass2_slot_assigned' && rank === 1) {
      // Phase comes from slot_definitions (1=mandatory, 2=conditional).
      const phase = slotId ? slotPhaseById.get(slotId) ?? null : null;
      slotByGroup.set(ev.group_id, { slot_id: slotId, rank, phase });
    } else if (
      ev.event_type === 'pass2_phase3_recommendation' &&
      !slotByGroup.has(ev.group_id)
    ) {
      // Phase 3 free rec — explicit phase=3, slot_id null by design.
      slotByGroup.set(ev.group_id, { slot_id: null, rank, phase: 3 });
    }
  }

  // Overrides: for each confirmed group, find the override that placed it
  // there (if any). A group is "override=true" if a human action directly
  // moved it (added_from_rejects on this group, or swapped with this group
  // as the human_selected_group_id). approved_as_proposed is NOT an override
  // — it means AI proposed and human accepted as-is.
  const overrideByGroup = new Map<string, { ai_proposed_score: number | null; was_override: boolean }>();
  for (const ov of overrides) {
    const aiId = ov.ai_proposed_group_id;
    const humanId = ov.human_selected_group_id;
    switch (ov.human_action) {
      case 'approved_as_proposed':
        if (aiId) {
          // Track ai_proposed_score even though was_override stays false.
          const existing = overrideByGroup.get(aiId);
          if (!existing || existing.was_override === false) {
            overrideByGroup.set(aiId, {
              ai_proposed_score: ov.ai_proposed_score,
              was_override: false,
            });
          }
        }
        break;
      case 'added_from_rejects':
        if (humanId) {
          overrideByGroup.set(humanId, {
            ai_proposed_score: ov.ai_proposed_score,
            was_override: true,
          });
        }
        break;
      case 'swapped':
        if (humanId) {
          overrideByGroup.set(humanId, {
            ai_proposed_score: ov.ai_proposed_score,
            was_override: true,
          });
        }
        break;
      // 'removed' acts on aiId — that group is NOT in confirmed set so we
      // don't track it as a training example here.
    }
  }

  // ── Build training_examples rows ───────────────────────────────────────
  const rows: Record<string, unknown>[] = [];
  let totalWeight = 0;
  for (const groupId of confirmedIds) {
    const cls = classByGroup.get(groupId);
    const grp = groupById.get(groupId);
    const slot = slotByGroup.get(groupId);
    const ovr = overrideByGroup.get(groupId);

    const wasOverride = ovr?.was_override ?? false;
    // Bug G4 fix: preserve variant_count from prior row if one existed (the
    // finals-watcher may have bumped it). Default 1 for fresh extractions.
    const variantCount = priorVariantCounts.get(groupId) ?? 1;
    const weight = roundWeight(1.0 + 0.2 * (variantCount - 1) + (wasOverride ? 0.3 : 0));
    totalWeight += weight;

    const aiProposedScore =
      ovr?.ai_proposed_score ?? cls?.combined_score ?? null;
    // Bug G1 fix: human_confirmed_score should be NULL absent an actual human
    // override. Previously we copied combined_score blindly, conflating
    // "AI proposed and human silently accepted" with "human re-graded".
    // Today we ONLY populate this on a real override (added_from_rejects /
    // swapped). Future v2: a UI affordance to let humans grade an image
    // directly will populate this without an override flag.
    const humanConfirmedScore = wasOverride ? (cls?.combined_score ?? null) : null;

    rows.push({
      composition_group_id: groupId,
      delivery_reference_stem:
        grp?.delivery_reference_stem || grp?.best_bracket_stem || null,
      variant_count: variantCount,
      slot_id: slot?.slot_id ?? null,
      // Bug G2 fix: explicit phase column for ML signal differentiation.
      phase: slot?.phase ?? null,
      package_type: round.package_type ?? null,
      project_tier: projectTier,
      human_confirmed_score: humanConfirmedScore,
      ai_proposed_score: aiProposedScore,
      was_override: wasOverride,
      analysis: cls?.analysis ?? null,
      key_elements: cls?.key_elements ?? null,
      zones_visible: cls?.zones_visible ?? null,
      composition_type: cls?.composition_type ?? null,
      room_type: cls?.room_type ?? null,
      weight,
      training_grade: false,
      excluded: false,
    });
  }

  // ── Bulk insert ────────────────────────────────────────────────────────
  let inserted = 0;
  if (rows.length > 0) {
    // Insert in chunks of 100 to keep payloads modest.
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error: insErr } = await admin
        .from('shortlisting_training_examples')
        .insert(chunk);
      if (insErr) {
        console.error(`[${GENERATOR}] insert chunk ${i / CHUNK} failed: ${insErr.message}`);
        // Continue on partial failure — emit summary then return non-fatal.
      } else {
        inserted += chunk.length;
      }
    }
  }

  // ── Audit event ────────────────────────────────────────────────────────
  await admin.from('shortlisting_events').insert({
    project_id: round.project_id,
    round_id: round.id,
    event_type: 'training_examples_extracted',
    actor_type: isService ? 'system' : 'user',
    actor_id: isService ? null : (user?.id ?? null),
    payload: {
      count: inserted,
      attempted: rows.length,
      deleted_existing: deletedExisting,
      total_weight: roundWeight(totalWeight),
    },
  });

  return jsonResponse(
    {
      ok: true,
      round_id: roundId,
      count: inserted,
      total_weight: roundWeight(totalWeight),
      deleted_existing: deletedExisting,
    },
    200,
    req,
  );
});

function roundWeight(n: number): number {
  return Math.round(n * 1000) / 1000;
}
