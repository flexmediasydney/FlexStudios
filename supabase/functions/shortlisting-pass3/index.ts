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
  callerHasProjectAccess,
} from '../_shared/supabase.ts';
import { resolveProjectEngineRoles as resolveProjectEngineRolesPure } from '../_shared/projectEngineRoles.ts';
import type { ProductRow } from '../_shared/slotEligibility.ts';

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

  // Audit defect #42: project-access guard. master_admin/admin/service_role
  // pass through; manager/employee/contractor must own the project.
  if (!isService) {
    const adminLookup = getAdminClient();
    const { data: rowForAcl } = await adminLookup
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', roundId)
      .maybeSingle();
    const pid = rowForAcl?.project_id ? String(rowForAcl.project_id) : '';
    if (!pid) return errorResponse('round not found', 404, req);
    const allowed = await callerHasProjectAccess(user, pid);
    if (!allowed) {
      return errorResponse('Forbidden — caller has no access to this project', 403, req);
    }
  }

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
  // W7.7: package_type is informational only (audit/event payload). Slot
  // eligibility is engine-role driven (no Gold-default fallback). Pass 3
  // doesn't filter by package_type any more.
  const packageType: string = round.package_type || 'unknown';

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

  // 3. Fetch active slot definitions for this round.
  // W7.7: package_types column dropped (mig 339). Slot eligibility is
  // strictly product-driven via eligible_when_engine_roles; we re-resolve
  // the project's engine roles to filter coverage against the same slot set
  // that Pass 2 used.
  const { data: slotDefs, error: slotErr } = await admin
    .from('shortlisting_slot_definitions')
    .select('slot_id, phase, eligible_when_engine_roles, is_active')
    .eq('is_active', true);
  if (slotErr) throw new Error(`slot_definitions fetch failed: ${slotErr.message}`);

  // Resolve project engine roles for eligibility filter (mirrors Pass 2).
  const projectEngineRoles = await resolveProjectEngineRolesForCoverage(admin, projectId);
  const projectRoleSet = new Set<string>(projectEngineRoles);
  // deno-lint-ignore no-explicit-any
  const activeSlots = ((slotDefs || []) as any[]).filter((row) => {
    const roles: string[] = Array.isArray(row.eligible_when_engine_roles)
      ? row.eligible_when_engine_roles
      : [];
    // Defensive: a slot with empty engine_roles AND is_active=true is a
    // misconfiguration. Exclude it (matching slotEligibility.filterSlotsForRound's
    // policy after the W7.7 fallback retirement).
    if (roles.length === 0) return false;
    return roles.some((r) => projectRoleSet.has(r));
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

  // Audit defect #45: clear prior pass3_complete events from earlier retries
  // before we emit the new one. Without this, repeated invocations leave a
  // trail of pass3_complete rows and downstream consumers (Tonomo, dashboards)
  // double-count.
  // We do NOT delete pass2_* events here — those are owned by Pass 2 and Pass 3
  // is read-only against them.
  {
    const { error: evtDelErr } = await admin
      .from('shortlisting_events')
      .delete()
      .eq('round_id', roundId)
      .eq('event_type', 'pass3_complete');
    if (evtDelErr) {
      warnings.push(`prior pass3_complete cleanup failed: ${evtDelErr.message}`);
    }
  }

  // Audit defect #28: count prior pass3 runs (post-cleanup, so this is at
  // most 0 for the immediately-running attempt — we look at attempt count from
  // the round itself for retry traceability).
  // We compute the run count by counting any prior pass3 jobs for the round
  // — the dispatcher's idempotency guard means the active job either is the
  // first attempt (count=1) or a manual rerun. Either way, this number is
  // appended to the notification idempotency key so retries don't collide.
  let pass3RunCount = 1;
  try {
    const { count } = await admin
      .from('shortlisting_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('round_id', roundId)
      .eq('kind', 'pass3');
    if (typeof count === 'number' && count > 0) pass3RunCount = count;
  } catch (_) {
    // best-effort — fall through with pass3RunCount=1
  }

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

    // Burst 22 WW1: fireNotif returns false on internal failure rather than
    // throwing, so the catch below NEVER fires for notification glitches —
    // the warnings array stayed empty + the return payload showed the round
    // as healthy even when ops never got the alert. Capture the return
    // value and surface it explicitly.
    const notifOk = await fireNotif({
      type: 'shortlist_ready_for_review',
      category: 'workflow',
      severity: 'info',
      title: `Shortlist ready: ${projectName}`,
      message: `AI selected ${shortlistedGroupIds.size} shots from ${totalClassifications} compositions. ${overallCoveragePercent}% coverage. ${gapCount} gap${gapCount === 1 ? '' : 's'} flagged.`,
      projectId,
      projectName,
      ctaLabel: 'Review shortlist',
      source: GENERATOR,
      // Audit defect #28: append pass3RunCount so retries produce distinct keys.
      // Without this, a re-fire after a transient notif failure was suppressed
      // by the recipient-side dedup, hiding actual delivery problems.
      idempotencyKey: `shortlist-ready-${roundId}-r${pass3RunCount}`,
    });
    if (!notifOk) {
      warnings.push(
        'notification fire returned false (notificationService rejected or unreachable — see edge logs)',
      );
    }
  } catch (notifErr) {
    const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
    console.warn(`[${GENERATOR}] notification fire threw: ${msg}`);
    warnings.push(`notification fire threw: ${msg}`);
  }

  // 12. W11.6.8 W7.10 P1-9: secondary notifications for ops awareness.
  //     SEPARATE from shortlist_ready_for_review — they target ops-facing
  //     routing rules (engine-alerts / retouch-queue Slack channels via
  //     notification_routing_rules.slack_channel binding, mig 390). Each
  //     non-fatal; pass3RunCount-suffixed idempotency keys so reruns
  //     produce distinct rows. Recipient-side dedup still applies.
  try {
    const projectName: string = (await (async () => {
      const { data } = await admin
        .from('projects')
        .select('property_address')
        .eq('id', projectId)
        .maybeSingle();
      return (data?.property_address as string | undefined) || 'Project';
    })());

    // 12a. coverage_gap_error → master_admin + #engine-alerts (mig 390).
    if (unfilledMandatory.length > 0) {
      const gapCount = unfilledMandatory.length;
      const sample = unfilledMandatory.slice(0, 5).join(', ');
      const more = gapCount > 5 ? ` (+${gapCount - 5} more)` : '';
      await fireNotif({
        type: 'coverage_gap_error',
        category: 'system',
        severity: 'warning',
        title: `Coverage gap: ${projectName}`,
        message:
          `Pass 3 detected ${gapCount} unfilled mandatory slot${gapCount === 1 ? '' : 's'}: ${sample}${more}. ` +
          `Overall coverage ${overallCoveragePercent}%.`,
        projectId,
        projectName,
        ctaLabel: 'Review shortlist',
        source: GENERATOR,
        idempotencyKey: `coverage-gap-${roundId}-r${pass3RunCount}`,
      });
    }

    // 12b. retouch_flags → admin + #retouch-queue (mig 390).
    if (retouchFlagsOnShortlist > 0) {
      await fireNotif({
        type: 'retouch_flags',
        category: 'system',
        severity: 'warning',
        title: `Retouch needed: ${projectName}`,
        message:
          `Pass 3 surfaced ${retouchFlagsOnShortlist} retouch flag${retouchFlagsOnShortlist === 1 ? '' : 's'} ` +
          `on the proposed shortlist (${retouchRows.length} total flagged).`,
        projectId,
        projectName,
        ctaLabel: 'View retouch queue',
        source: GENERATOR,
        idempotencyKey: `retouch-flags-${roundId}-r${pass3RunCount}`,
      });
    }

    // 12c. out_of_scope_detected → admin + #engine-alerts (mig 390).
    // Fires when classifications exist but the project's engine roles
    // produce zero active slots, OR when no engine roles at all.
    const hasNoEngineRoles = projectEngineRoles.length === 0;
    const hasNoActiveSlots = activeSlots.length === 0 && (slotDefs?.length || 0) > 0;
    if (totalClassifications > 0 && (hasNoEngineRoles || hasNoActiveSlots)) {
      const reason = hasNoEngineRoles
        ? 'project has no engine roles resolved (no products with engine_role on its packages)'
        : 'no active slot_definitions matched project_engine_roles';
      await fireNotif({
        type: 'out_of_scope_detected',
        category: 'system',
        severity: 'warning',
        title: `Out of scope: ${projectName}`,
        message:
          `Pass 3: ${reason}. ${totalClassifications} compositions classified but cannot be slotted.`,
        projectId,
        projectName,
        ctaLabel: 'Review project config',
        source: GENERATOR,
        idempotencyKey: `out-of-scope-${roundId}-r${pass3RunCount}`,
      });
    }
  } catch (secNotifErr) {
    const msg = secNotifErr instanceof Error ? secNotifErr.message : String(secNotifErr);
    console.warn(`[${GENERATOR}] secondary notifications fire threw: ${msg}`);
    warnings.push(`secondary notifications fire threw: ${msg}`);
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

/**
 * Resolve a project's distinct engine_role set from
 * projects.packages[].products[] + projects.products[]. Thin async I/O
 * shim around the pure shared helper in `_shared/projectEngineRoles.ts`
 * (Wave 7 P1-6 follow-up consolidation). Matches Pass 2's behaviour
 * exactly — additive bundled + à la carte, forward-compat ENGINE_ROLES
 * filter applied via the shared helper.
 */
async function resolveProjectEngineRolesForCoverage(
  admin: ReturnType<typeof getAdminClient>,
  projectId: string,
): Promise<string[]> {
  const { data: project, error } = await admin
    .from('projects')
    .select('packages, products')
    .eq('id', projectId)
    .maybeSingle();
  if (error) {
    console.warn(`[${GENERATOR}] project fetch for engine_role resolution failed: ${error.message}`);
    return [];
  }
  if (!project) return [];

  const productIds = new Set<string>();
  // deno-lint-ignore no-explicit-any
  for (const pkg of (Array.isArray((project as any)?.packages) ? (project as any).packages : [])) {
    // deno-lint-ignore no-explicit-any
    for (const ent of (Array.isArray(pkg?.products) ? (pkg as any).products : [])) {
      if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
    }
  }
  // deno-lint-ignore no-explicit-any
  for (const ent of (Array.isArray((project as any)?.products) ? (project as any).products : [])) {
    if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
  }
  if (productIds.size === 0) return [];

  const { data: prodRows } = await admin
    .from('products')
    .select('id, engine_role, is_active')
    .in('id', Array.from(productIds));

  const productsList: ProductRow[] = ((prodRows ?? []) as ProductRow[]).map((p) => ({
    id: String(p.id),
    engine_role: p.engine_role ?? null,
    is_active: p.is_active === true,
  }));

  // deno-lint-ignore no-explicit-any
  return resolveProjectEngineRolesPure(project as any, productsList);
}

function sumNumbers(vals: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of vals) {
    if (v == null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}
