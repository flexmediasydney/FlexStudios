/**
 * shortlisting-pass3
 * ───────────────────
 * Pass 3 — Coverage validation, gap detection, retouch flag surfacing.
 *
 * Runs AFTER `shortlisting-pass2` has produced the proposed shortlist (as
 * shortlisting_events rows with event_type='pass2_slot_assigned'). Pass 3
 * has NO AI calls — it's pure DB orchestration:
 *
 *   1. Read pass2_slot_assigned events to reconstruct the proposed shortlist
 *   2. Compare against active slot_definitions to compute coverage map
 *   3. Identify gaps (mandatory slots without an assignment)
 *   4. Surface retouch flags for any classification with flag_for_retouching=TRUE
 *      (one shortlisting_retouch_flags row per group, with is_shortlisted set
 *      based on whether that group appears in any pass2_slot_assigned event)
 *   5. Update the round: status='proposed', total_cost_usd, completed_at
 *   6. Update the project: shortlist_status='ready_for_review'
 *   7. Emit pass3_complete event
 *
 * NO DRONE LOGIC — drone shortlisting is parked permanently. The existing
 * drone engine handles drone selection separately.
 *
 * Body modes:
 *   { round_id: string }   — orchestrate the round (normal path)
 *   { job_id:   string }   — read round_id off a job row first (dispatcher)
 *
 * Auth: service_role OR master_admin / admin / manager.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  fireNotif,
} from '../_shared/supabase.ts';

const GENERATOR = 'shortlisting-pass3';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  _health_check?: boolean;
}

interface Pass3Result {
  status: 'proposed';
  total_classifications: number;
  shortlist_count: number;
  mandatory_filled: number;
  mandatory_total: number;
  conditional_filled: number;
  conditional_total: number;
  phase3_added: number;
  unfilled_mandatory: string[];
  overall_coverage_percent: number;
  retouch_flags_count: number;
  retouch_flags_on_shortlist: number;
  total_cost_usd: number;
  duration_ms: number;
  warnings: string[];
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  let roundId = body.round_id || null;
  if (!roundId && body.job_id) {
    const admin = getAdminClient();
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('round_id')
      .eq('id', body.job_id)
      .maybeSingle();
    if (job?.round_id) roundId = job.round_id;
  }
  if (!roundId) return errorResponse('round_id (or job_id) required', 400, req);

  try {
    const result = await runPass3(roundId);
    return jsonResponse({ ok: true, round_id: roundId, ...result }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for round ${roundId}: ${msg}`);
    return errorResponse(`pass3 failed: ${msg}`, 500, req);
  }
});

// ─── Core ────────────────────────────────────────────────────────────────────

async function runPass3(roundId: string): Promise<Pass3Result> {
  const started = Date.now();
  const admin = getAdminClient();
  const warnings: string[] = [];

  // 1. Round + project lookup, status guard.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select(`
      id, project_id, status, package_type, package_ceiling,
      pass0_cost_usd, pass1_cost_usd, pass2_cost_usd, pass3_cost_usd
    `)
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) throw new Error(`round lookup failed: ${roundErr.message}`);
  if (!round) throw new Error(`round ${roundId} not found`);
  if (round.status !== 'processing') {
    throw new Error(
      `round ${roundId} status='${round.status}' — Pass 3 requires status='processing'`,
    );
  }

  const projectId: string = round.project_id;
  const packageType: string = round.package_type || 'Gold';

  // 2. Read slot assignments from shortlisting_events (Pass 2 output).
  // We reconstruct the proposed shortlist from event payloads instead of a
  // shortlist_proposals table. Multiple rounds for the same project can
  // coexist — filter strictly by round_id.
  const { data: slotEvents, error: evtErr } = await admin
    .from('shortlisting_events')
    .select('group_id, payload, event_type')
    .eq('round_id', roundId)
    .in('event_type', ['pass2_slot_assigned', 'pass2_phase3_recommendation']);
  if (evtErr) throw new Error(`pass2 events fetch failed: ${evtErr.message}`);

  const events = slotEvents || [];

  // Set of group_ids that appear in the proposed shortlist (winners + phase 3,
  // NOT alternatives). Alternatives are options, not selections.
  const shortlistedGroupIds = new Set<string>();
  // Per-slot winner tracking — used for coverage map.
  const slotWinners = new Map<string, { group_ids: string[]; phase: number }>();
  let phase3Count = 0;

  // deno-lint-ignore no-explicit-any
  for (const evt of events as any[]) {
    if (!evt.group_id) continue;
    const payload = evt.payload || {};
    if (evt.event_type === 'pass2_slot_assigned') {
      if (payload.kind === 'winner') {
        shortlistedGroupIds.add(evt.group_id);
        const slotId = String(payload.slot_id || '');
        const phase = Number(payload.phase || 0);
        const existing = slotWinners.get(slotId);
        if (existing) existing.group_ids.push(evt.group_id);
        else slotWinners.set(slotId, { group_ids: [evt.group_id], phase });
      }
      // alternatives don't count for coverage; ignore here.
    } else if (evt.event_type === 'pass2_phase3_recommendation') {
      shortlistedGroupIds.add(evt.group_id);
      phase3Count++;
    }
  }

  // 3. Fetch active slot definitions for this package_type.
  const { data: slotDefs, error: slotErr } = await admin
    .from('shortlisting_slot_definitions')
    .select('slot_id, phase, package_types')
    .eq('is_active', true);
  if (slotErr) throw new Error(`slot_definitions fetch failed: ${slotErr.message}`);

  const matchPkg = packageType.toLowerCase();
  // deno-lint-ignore no-explicit-any
  const activeSlots = ((slotDefs || []) as any[]).filter((row) => {
    const pkgs: string[] = Array.isArray(row.package_types) ? row.package_types : [];
    if (pkgs.length === 0) return true;
    return pkgs.some((p) => String(p).toLowerCase() === matchPkg);
  });

  const mandatorySlotIds = activeSlots.filter((s) => s.phase === 1).map((s) => s.slot_id);
  const conditionalSlotIds = activeSlots.filter((s) => s.phase === 2).map((s) => s.slot_id);

  // 4. Coverage map — count filled mandatory + conditional, identify gaps.
  let mandatoryFilled = 0;
  const unfilledMandatory: string[] = [];
  for (const id of mandatorySlotIds) {
    if (slotWinners.has(id)) mandatoryFilled++;
    else unfilledMandatory.push(id);
  }
  let conditionalFilled = 0;
  for (const id of conditionalSlotIds) {
    if (slotWinners.has(id)) conditionalFilled++;
  }

  // overall_coverage_percent: 100% iff every mandatory is filled AND every
  // conditional with eligible room types is filled. Conditional with no
  // matching room type is not a gap. We compute a simpler composite:
  // (mandatory_filled / mandatory_total) weighted 60% + (conditional_filled /
  // conditional_present_room_count) weighted 40%. If we have no slot defs,
  // we report 0% and let humans interpret.
  const mandatoryTotal = mandatorySlotIds.length;
  const conditionalTotal = conditionalSlotIds.length;
  const mandatoryRatio = mandatoryTotal === 0 ? 1 : mandatoryFilled / mandatoryTotal;
  const conditionalRatio = conditionalTotal === 0 ? 1 : conditionalFilled / conditionalTotal;
  const overallCoveragePercent = Math.round(
    (mandatoryRatio * 0.6 + conditionalRatio * 0.4) * 100,
  );

  // 5. Total classifications + total compositions for the run summary.
  const { count: classCount, error: classCountErr } = await admin
    .from('composition_classifications')
    .select('id', { count: 'exact', head: true })
    .eq('round_id', roundId);
  if (classCountErr) {
    warnings.push(`classification count failed: ${classCountErr.message}`);
  }
  const totalClassifications = classCount ?? 0;

  // 6. Retouch flag surfacing — INSERT one shortlisting_retouch_flags row per
  //    composition_classification with flag_for_retouching=TRUE (and
  //    clutter_severity != 'major_reject', since major_reject is hard rejected
  //    and not surfaced for retouch).
  const { data: retouchClass, error: retErr } = await admin
    .from('composition_classifications')
    .select(`
      group_id,
      clutter_severity,
      clutter_detail,
      composition_groups!composition_classifications_group_id_fkey(
        delivery_reference_stem,
        best_bracket_stem
      )
    `)
    .eq('round_id', roundId)
    .eq('flag_for_retouching', true);
  if (retErr) {
    warnings.push(`retouch query failed: ${retErr.message}`);
  }

  // deno-lint-ignore no-explicit-any
  const retouchRows = ((retouchClass || []) as any[]).filter((r) => {
    return r.clutter_severity && r.clutter_severity !== 'major_reject';
  });

  let retouchFlagsOnShortlist = 0;
  if (retouchRows.length > 0) {
    // Build INSERT batch — guard against duplicate inserts on retry by first
    // deleting any existing rows for this round (Pass 3 is idempotent).
    const { error: delErr } = await admin
      .from('shortlisting_retouch_flags')
      .delete()
      .eq('round_id', roundId);
    if (delErr) {
      warnings.push(`retouch_flags clear failed: ${delErr.message}`);
    }

    const inserts = retouchRows.map((r) => {
      const grp = Array.isArray(r.composition_groups)
        ? r.composition_groups[0]
        : r.composition_groups;
      const fileStem: string =
        grp?.delivery_reference_stem || grp?.best_bracket_stem || '';
      const isShortlisted = shortlistedGroupIds.has(r.group_id);
      if (isShortlisted) retouchFlagsOnShortlist++;
      return {
        round_id: roundId,
        project_id: projectId,
        group_id: r.group_id,
        file_stem: fileStem,
        clutter_severity: r.clutter_severity,
        clutter_detail: r.clutter_detail,
        is_shortlisted: isShortlisted,
        resolved: false,
      };
    });

    if (inserts.length > 0) {
      const { error: insErr } = await admin
        .from('shortlisting_retouch_flags')
        .insert(inserts);
      if (insErr) {
        warnings.push(`retouch_flags insert failed: ${insErr.message}`);
      }
    }
  }

  // 7. Compute total_cost_usd = pass0 + pass1 + pass2 (+ pass3, currently 0).
  const totalCost = sumNumbers([
    round.pass0_cost_usd,
    round.pass1_cost_usd,
    round.pass2_cost_usd,
    round.pass3_cost_usd,
  ]);
  const roundedTotal = Math.round(totalCost * 1_000_000) / 1_000_000;

  // 8. Round update — status flips to 'proposed', completed_at set.
  const { error: roundUpdErr } = await admin
    .from('shortlisting_rounds')
    .update({
      status: 'proposed',
      total_cost_usd: roundedTotal,
      pass3_cost_usd: 0,
      completed_at: new Date().toISOString(),
    })
    .eq('id', roundId);
  if (roundUpdErr) {
    throw new Error(`round status update to 'proposed' failed: ${roundUpdErr.message}`);
  }

  // 9. Project update — shortlist_status='ready_for_review' (defensively
  //    confirm current_shortlist_round_id is also set).
  const { error: projUpdErr } = await admin
    .from('projects')
    .update({
      shortlist_status: 'ready_for_review',
      current_shortlist_round_id: roundId,
    })
    .eq('id', projectId);
  if (projUpdErr) {
    warnings.push(`project shortlist_status update failed: ${projUpdErr.message}`);
  }

  // 10. pass3_complete event.
  const { error: completeErr } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: projectId,
      round_id: roundId,
      event_type: 'pass3_complete',
      actor_type: 'system',
      payload: {
        coverage_percent: overallCoveragePercent,
        mandatory_filled: mandatoryFilled,
        mandatory_total: mandatoryTotal,
        mandatory_unfilled_count: unfilledMandatory.length,
        conditional_filled: conditionalFilled,
        conditional_total: conditionalTotal,
        phase3_added: phase3Count,
        shortlist_count: shortlistedGroupIds.size,
        unfilled_mandatory: unfilledMandatory,
        retouch_flags_count: retouchRows.length,
        retouch_flags_on_shortlist: retouchFlagsOnShortlist,
        total_cost_usd: roundedTotal,
        duration_ms: Date.now() - started,
        warnings_count: warnings.length,
        package_type: packageType,
      },
    });
  if (completeErr) warnings.push(`pass3_complete event insert failed: ${completeErr.message}`);

  // 11. Fire `shortlist_ready_for_review` notification.
  //     Wave 6 P1.5: recipient resolution moved to notification_routing_rules.
  //     We drop the explicit userId here — the notificationService backend
  //     reads the active rule for this type and fans out to all configured
  //     recipients (master_admin by default per the migration 294 seed).
  //     Idempotency key remains keyed on round_id; the backend appends each
  //     recipient's user_id internally so per-user dedup still works.
  //     Failure is non-fatal — we don't want a notification glitch to flip
  //     the round status back.
  try {
    const { data: project } = await admin
      .from('projects')
      .select('id, property_address')
      .eq('id', projectId)
      .maybeSingle();

    const projectName: string =
      (project?.property_address as string | undefined) || 'Project';
    const gapCount = unfilledMandatory.length;

    await fireNotif({
      type: 'shortlist_ready_for_review',
      category: 'workflow',
      severity: 'info',
      title: `Shortlist ready: ${projectName}`,
      message: `AI selected ${shortlistedGroupIds.size} shots from ${totalClassifications} compositions. ${overallCoveragePercent}% coverage. ${gapCount} gap${gapCount === 1 ? '' : 's'} flagged.`,
      projectId,
      projectName,
      ctaLabel: 'Review shortlist',
      source: GENERATOR,
      idempotencyKey: `shortlist-ready-${roundId}`,
    });
  } catch (notifErr) {
    const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
    console.warn(`[${GENERATOR}] notification fire failed: ${msg}`);
    warnings.push(`notification fire failed: ${msg}`);
  }

  return {
    status: 'proposed',
    total_classifications: totalClassifications,
    shortlist_count: shortlistedGroupIds.size,
    mandatory_filled: mandatoryFilled,
    mandatory_total: mandatoryTotal,
    conditional_filled: conditionalFilled,
    conditional_total: conditionalTotal,
    phase3_added: phase3Count,
    unfilled_mandatory: unfilledMandatory,
    overall_coverage_percent: overallCoveragePercent,
    retouch_flags_count: retouchRows.length,
    retouch_flags_on_shortlist: retouchFlagsOnShortlist,
    total_cost_usd: roundedTotal,
    duration_ms: Date.now() - started,
    warnings,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sumNumbers(vals: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of vals) {
    if (v == null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}
