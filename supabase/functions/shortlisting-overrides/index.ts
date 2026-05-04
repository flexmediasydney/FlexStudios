/**
 * shortlisting-overrides
 * ──────────────────────
 * Captures human override events from the photo Shortlisting swimlane review
 * UI and persists them to the shortlisting_overrides table for the learning
 * loop. Spec §14 + §16.
 *
 * Every drag/drop interaction in the swimlane fires an event (even
 * approved_as_proposed — the learning loop needs both positive and negative
 * signal). The frontend may batch multiple events in one POST.
 *
 * POST { events: OverrideEvent[] }
 *
 * Each event:
 *   project_id                       UUID
 *   round_id                         UUID
 *   ai_proposed_group_id             UUID | null
 *   ai_proposed_slot_id              string | null
 *   ai_proposed_score                number | null
 *   ai_proposed_analysis             string | null    (optional; usually omitted to keep payload small)
 *   human_action                     'approved_as_proposed' | 'removed' | 'swapped' | 'added_from_rejects'
 *   human_selected_group_id          UUID | null
 *   human_selected_slot_id           string | null
 *   override_reason                  'quality_preference' | 'client_instruction' | 'coverage_adjustment' | 'error_correction' | null
 *   override_note                    string | null
 *   slot_group_id                    string | null
 *   project_tier                     'standard' | 'premium' | null
 *   primary_signal_overridden        string | null
 *   review_duration_seconds          number    (gates training inclusion: > 30s = confirmed_with_review=TRUE)
 *   alternative_offered              bool      (did Pass 2 emit alts AND the swimlane render the drawer?)
 *   alternative_offered_drawer_seen  bool      Wave 10.3: did the editor actually OPEN the drawer?
 *   alternative_selected             bool      (did the editor pick an alt?)
 *   variant_count                    number | null
 *
 * Wave 10.3 P1-16 — annotate path:
 *
 *   POST { annotate: { override_id: UUID, primary_signal_overridden: string|null } }
 *
 * Used by the SignalAttributionModal to PATCH the primary_signal_overridden
 * onto a row that was already inserted via the events path. Validation lives
 * in _shared/overrideAnnotate.ts (pure helper); this fn wires it to the DB
 * UPDATE + project-access guard. Response: { ok: true, override_id: UUID }.
 *
 * Wave 11.6.9 — reclassify path:
 *
 *   POST { reclassify: {
 *     group_id: UUID,
 *     round_id: UUID,
 *     override_source?: 'stage1_correction' (default) | 'stage4_visual_override' | 'master_admin_correction',
 *     human_room_type?: string,
 *     human_composition_type?: string,
 *     human_vantage_point?: 'interior_looking_out' | 'exterior_looking_in' | 'neutral',
 *     human_combined_score?: number,
 *     human_eligible_slot_ids?: string[],
 *     ai_room_type?: string,             // optional baseline for replay/audit
 *     ai_composition_type?: string,
 *     ai_vantage_point?: string,
 *     ai_combined_score?: number,
 *     override_reason?: string,           // optional free-text note
 *   } }
 *
 * Used by the ShortlistingCard's "Why?" expander reclassify form. The card
 * surfaces Stage 1 + Stage 4 reasoning, the operator clicks an inline edit
 * pencil, fixes the field, saves. Each save UPSERTs a row in
 * `composition_classification_overrides` keyed on (group_id, round_id,
 * override_source). The override feeds the projectMemoryBlock on the next
 * Stage 1 run for the same project — closing the engine learning loop.
 *
 * Validation lives in _shared/reclassifyValidate.ts (pure helper). This fn
 * wires it to the DB upsert + project-access guard + audit-event emission.
 * Response: { ok: true, override: <row>, action: 'inserted' | 'updated' }.
 *
 * RLS guard for master_admin_correction: only master_admin can write that
 * source. admin/manager attempts are rejected 403.
 *
 * Auth: master_admin / admin / manager (humans hit this directly).
 *
 * Response: { ok: true, received: N, ids: UUID[] }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  callerHasProjectAccess,
} from '../_shared/supabase.ts';
import { validateAnnotate } from '../_shared/overrideAnnotate.ts';
import { validateReclassify } from '../_shared/reclassifyValidate.ts';

const GENERATOR = 'shortlisting-overrides';

const VALID_ACTIONS = new Set([
  'approved_as_proposed',
  'removed',
  'swapped',
  'added_from_rejects',
  // 2026-05-04: operator drags a card back to AI Proposed after a prior
  // approve/reject — explicit undo.  Treated as a NEUTRAL training signal
  // (distinct from 'removed' which IS negative).  DB constraint extended
  // in a paired migration on shortlisting_overrides_human_action_check.
  'reverted_to_ai_proposed',
]);
const VALID_REASONS = new Set([
  'quality_preference',
  'client_instruction',
  'coverage_adjustment',
  'error_correction',
]);
const VALID_TIERS = new Set(['standard', 'premium']);

// Spec §14 + mig 285: review_duration_seconds <= 30 → flagged as unverified.
const CONFIRMED_REVIEW_THRESHOLD_SECONDS = 30;

/**
 * QC-iter2 W6b (F-B-011): coerce raw client_sequence input to a non-negative
 * integer for persistence. Pure function, exported for tests.
 *
 * - Returns 0 (NOT null) for client_sequence === 0 — the FIRST event in a
 *   session has a zero-based counter, and the prior `>0` predicate dropped
 *   that legitimate value, mis-ordering the swimlane-lock event stream.
 * - Returns null for negative, NaN, Infinity, non-finite, non-numeric, or
 *   missing values.
 * - Truncates fractional values via Math.floor.
 */
export function coerceClientSequence(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

interface OverrideEventInput {
  project_id?: string;
  round_id?: string;
  ai_proposed_group_id?: string | null;
  ai_proposed_slot_id?: string | null;
  ai_proposed_score?: number | null;
  ai_proposed_analysis?: string | null;
  human_action?: string;
  human_selected_group_id?: string | null;
  human_selected_slot_id?: string | null;
  override_reason?: string | null;
  override_note?: string | null;
  slot_group_id?: string | null;
  project_tier?: string | null;
  primary_signal_overridden?: string | null;
  review_duration_seconds?: number | null;
  alternative_offered?: boolean;
  // Wave 10.3 P1-16 (mig 342): TRUE only when the editor actually opened the
  // alternatives drawer for this slot. Distinguishes "alts existed but ignored"
  // (alternative_offered=TRUE, drawer_seen=FALSE) from "alts existed and
  // editor actively rejected them" (both TRUE). Default FALSE — legacy clients
  // that don't send the field are treated as "drawer not seen".
  alternative_offered_drawer_seen?: boolean;
  alternative_selected?: boolean;
  variant_count?: number | null;
  // Burst 4 J1: monotonic client-side counter set by the swimlane on each
  // emission. Used by shortlist-lock to order overrides by the user's actual
  // emission order rather than the order they happened to land in the DB.
  // Optional — legacy clients may omit it (the capture endpoint stores NULL,
  // and shortlist-lock's NULLS-LAST ordering handles the legacy fallthrough).
  client_sequence?: number | null;
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
      return errorResponse('Forbidden — only master_admin/admin/manager can record overrides', 403, req);
    }
  }

  let body: {
    events?: OverrideEventInput[];
    annotate?: unknown;
    reclassify?: unknown;
    _health_check?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  // ── Reclassify path (Wave 11.6.9) ───────────────────────────────────────
  // Operator corrects Stage 1 / Stage 4 per-image judgements (room_type,
  // composition_type, vantage_point, combined_score, slot eligibility) from
  // inside the swimlane card's "Why?" expander. Each save UPSERTs a row in
  // composition_classification_overrides keyed on (group_id, round_id,
  // override_source). The override feeds projectMemoryBlock on subsequent
  // Stage 1 runs for the same project — closing the engine learning loop.
  if (body.reclassify !== undefined) {
    const validation = validateReclassify(body.reclassify);
    if (!validation.ok) {
      return jsonResponse(
        { ok: false, error: validation.message, error_code: validation.error_code },
        400,
        req,
      );
    }

    // RLS guard: master_admin_correction is master_admin-only. admin/manager
    // get a structured 403. Service-role calls bypass (used by automation that
    // cross-writes through this fn). Note that this is BEFORE the project-
    // access guard — wrong-role callers should not even reach the round
    // lookup.
    if (validation.override_source === 'master_admin_correction'
        && !isService
        && user?.role !== 'master_admin') {
      return jsonResponse(
        {
          ok: false,
          error: 'Forbidden — only master_admin can write override_source=master_admin_correction',
          error_code: 'RECLASSIFY_MASTER_ADMIN_ONLY',
        },
        403,
        req,
      );
    }

    const admin = getAdminClient();

    // Resolve project_id via the round, used by the project-access guard +
    // audit event. We fetch in a single round-trip rather than two; the round
    // table is small and uncached.
    const { data: round, error: roundErr } = await admin
      .from('shortlisting_rounds')
      .select('id, project_id')
      .eq('id', validation.round_id)
      .maybeSingle();
    if (roundErr) {
      return errorResponse(`reclassify round lookup failed: ${roundErr.message}`, 500, req);
    }
    if (!round) {
      return jsonResponse(
        { ok: false, error: `round ${validation.round_id} not found`, error_code: 'RECLASSIFY_ROUND_NOT_FOUND' },
        404,
        req,
      );
    }
    const projectId = round.project_id as string;

    if (!isService) {
      const ok = await callerHasProjectAccess(user!, projectId);
      if (!ok) {
        return errorResponse(
          `Forbidden — caller has no access to project ${projectId}`,
          403,
          req,
        );
      }
    }

    // Confirm group belongs to the round (cheap consistency check — without
    // this, a malicious payload could write an override row tying an
    // unrelated group to a round on a project the caller has access to).
    const { data: group, error: groupErr } = await admin
      .from('composition_groups')
      .select('id, round_id')
      .eq('id', validation.group_id)
      .maybeSingle();
    if (groupErr) {
      return errorResponse(`reclassify group lookup failed: ${groupErr.message}`, 500, req);
    }
    if (!group) {
      return jsonResponse(
        { ok: false, error: `group ${validation.group_id} not found`, error_code: 'RECLASSIFY_GROUP_NOT_FOUND' },
        404,
        req,
      );
    }
    if (group.round_id !== validation.round_id) {
      return jsonResponse(
        {
          ok: false,
          error: `group ${validation.group_id} is not part of round ${validation.round_id}`,
          error_code: 'RECLASSIFY_GROUP_ROUND_MISMATCH',
        },
        400,
        req,
      );
    }

    // Resolve actor_user_id. Per the W11.5 actor_required_chk constraint
    // (mig 379a), actor_user_id MUST be non-NULL when override_source IN
    // ('stage1_correction', 'master_admin_correction'). Service-role callers
    // for those sources need an explicit acting_user_id passed in the body
    // — but our reclassify path is operator-driven only (the swimlane is the
    // sole caller), so non-service is the expected path here.
    const actorUserId: string | null = isService ? null : (user?.id ?? null);
    if (actorUserId === null
        && validation.override_source !== 'stage4_visual_override') {
      return jsonResponse(
        {
          ok: false,
          error: `actor_user_id required for override_source='${validation.override_source}'`,
          error_code: 'RECLASSIFY_ACTOR_REQUIRED',
        },
        400,
        req,
      );
    }

    // Idempotent UPSERT keyed on (group_id, round_id, override_source) per
    // mig 373's UNIQUE constraint. Read-then-write so we can return the
    // pre-image (action='updated') vs fresh insert (action='inserted'),
    // and accumulate human_* fields across saves on the same row.
    const { data: existing, error: existingErr } = await admin
      .from('composition_classification_overrides')
      .select('*')
      .eq('group_id', validation.group_id)
      .eq('round_id', validation.round_id)
      .eq('override_source', validation.override_source)
      .maybeSingle();
    if (existingErr) {
      return errorResponse(`reclassify existing-row lookup failed: ${existingErr.message}`, 500, req);
    }

    // master_admin combined_score reclassifications are weighted authoritative
    // per W11.5 §"Q2 — score override authority". The flag tells W14
    // calibration to weight these higher than admin/manager corrections.
    const isMasterAdminOverride = !isService && user?.role === 'master_admin';
    const scoreAuthoritative = validation.human_combined_score != null
      && (validation.override_source === 'master_admin_correction' || isMasterAdminOverride);

    // Build the row from the validated payload. We populate ai_*/human_* in
    // pairs so the W11.6 dashboard can replay each correction; null fields
    // stay null (== "accept AI"). A multi-field reclassify may set several
    // human_* in one go.
    const newCols: Record<string, unknown> = {
      override_reason: validation.override_reason,
      actor_user_id: actorUserId,
      actor_at: new Date().toISOString(),
    };
    if (validation.human_room_type !== null) {
      newCols.ai_room_type = validation.ai_room_type;
      newCols.human_room_type = validation.human_room_type;
    }
    if (validation.human_composition_type !== null) {
      newCols.ai_composition_type = validation.ai_composition_type;
      newCols.human_composition_type = validation.human_composition_type;
    }
    if (validation.human_vantage_point !== null) {
      newCols.ai_vantage_point = validation.ai_vantage_point;
      newCols.human_vantage_point = validation.human_vantage_point;
    }
    if (validation.human_combined_score !== null) {
      newCols.ai_combined_score = validation.ai_combined_score;
      newCols.human_combined_score = validation.human_combined_score;
      newCols.human_combined_score_authoritative = scoreAuthoritative;
    }
    if (validation.human_eligible_slot_ids !== null) {
      newCols.human_eligible_slot_ids = validation.human_eligible_slot_ids;
    }

    // Capture before-values for audit (only the fields that actually changed).
    const existingRow = existing as Record<string, unknown> | null;
    const beforeValues: Record<string, unknown> = {};
    const afterValues: Record<string, unknown> = {};
    for (const f of validation.changed_fields) {
      const aiKey = `ai_${f}`;
      const humanKey = `human_${f}`;
      const prevHuman = existingRow ? existingRow[humanKey] : undefined;
      const prevAi = existingRow ? existingRow[aiKey] : undefined;
      beforeValues[f] = (prevHuman ?? prevAi ?? newCols[aiKey]) ?? null;
      afterValues[f] = newCols[humanKey] ?? null;
    }

    let savedRow: Record<string, unknown> | null = null;
    let action: 'inserted' | 'updated';

    if (existingRow) {
      // UPDATE: merge — preserve any human_* fields the new request didn't
      // touch (e.g. an earlier save corrected room_type, this save corrects
      // vantage_point; we want both stored). The non-touched ai_* fields
      // also stay so we don't lose the engine baseline.
      const { data: updated, error: updErr } = await admin
        .from('composition_classification_overrides')
        .update(newCols)
        .eq('id', existingRow.id as string)
        .select('*')
        .maybeSingle();
      if (updErr) {
        return errorResponse(`reclassify UPDATE failed: ${updErr.message}`, 500, req);
      }
      savedRow = updated as Record<string, unknown> | null;
      action = 'updated';
    } else {
      const insertRow: Record<string, unknown> = {
        group_id: validation.group_id,
        round_id: validation.round_id,
        override_source: validation.override_source,
        ...newCols,
      };
      const { data: inserted, error: insErr } = await admin
        .from('composition_classification_overrides')
        .insert(insertRow)
        .select('*')
        .maybeSingle();
      if (insErr) {
        return errorResponse(`reclassify INSERT failed: ${insErr.message}`, 500, req);
      }
      savedRow = inserted as Record<string, unknown> | null;
      action = 'inserted';
    }

    // Emit a shortlisting_events row for the audit trail. Soft-fail: don't
    // block the override on event-insert error.
    //
    // actor_type is constrained to ('system','user','worker') by the table
    // CHECK; we use 'user' for non-service callers and 'system' for service-
    // role automation. actor_id is the resolved actor_user_id.
    const { error: evErr } = await admin
      .from('shortlisting_events')
      .insert({
        project_id: projectId,
        round_id: validation.round_id,
        group_id: validation.group_id,
        event_type: 'stage1_correction',
        actor_type: isService ? 'system' : 'user',
        actor_id: actorUserId,
        payload: {
          override_id: savedRow?.id ?? null,
          override_source: validation.override_source,
          changed_fields: validation.changed_fields,
          before: beforeValues,
          after: afterValues,
          override_reason: validation.override_reason,
          action,
        },
      });
    if (evErr) {
      console.warn(`[${GENERATOR}] reclassify event insert failed (non-fatal): ${evErr.message}`);
    }

    return jsonResponse({ ok: true, override: savedRow, action }, 200, req);
  }

  // ── Annotate path (Wave 10.3 P1-16) ─────────────────────────────────────
  // PATCH a primary_signal_overridden value onto a row that was already
  // inserted via the events path. The frontend SignalAttributionModal calls
  // this after the modal is dismissed (or a signal is chosen). If the modal
  // is dismissed without choosing, the frontend simply skips the call → row
  // stays NULL, which is a legitimate signal in itself ("editor was in flow,
  // didn't want to interrupt with annotation").
  if (body.annotate !== undefined) {
    const validation = validateAnnotate(body.annotate);
    if (!validation.ok) {
      return jsonResponse(
        { ok: false, error: validation.message, error_code: validation.error_code },
        400,
        req,
      );
    }

    const admin = getAdminClient();
    const { data: existing, error: fetchErr } = await admin
      .from('shortlisting_overrides')
      .select('project_id')
      .eq('id', validation.override_id)
      .maybeSingle();
    if (fetchErr) {
      return errorResponse(`annotate lookup failed: ${fetchErr.message}`, 500, req);
    }
    if (!existing) {
      return jsonResponse(
        {
          ok: false,
          error: 'override not found',
          error_code: 'ANNOTATE_OVERRIDE_NOT_FOUND',
        },
        404,
        req,
      );
    }

    if (!isService) {
      const ok = await callerHasProjectAccess(user, existing.project_id as string);
      if (!ok) {
        return errorResponse(
          `Forbidden — caller has no access to project ${existing.project_id}`,
          403,
          req,
        );
      }
    }

    const { error: updErr } = await admin
      .from('shortlisting_overrides')
      .update({ primary_signal_overridden: validation.primary_signal_overridden })
      .eq('id', validation.override_id);
    if (updErr) {
      return errorResponse(`annotate failed: ${updErr.message}`, 500, req);
    }

    return jsonResponse(
      { ok: true, override_id: validation.override_id },
      200,
      req,
    );
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return jsonResponse(
      { ok: false, error: 'events array required (non-empty)', error_code: 'EVENTS_EMPTY' },
      400,
      req,
    );
  }
  if (events.length > 200) {
    return jsonResponse(
      { ok: false, error: 'Too many events in one batch (max 200)', error_code: 'EVENTS_OVER_LIMIT' },
      400,
      req,
    );
  }

  // ── Validate + normalise rows ───────────────────────────────────────────
  const rows: Record<string, unknown>[] = [];
  let firstProjectId: string | null = null;
  let firstRoundId: string | null = null;

  // Audit defect #56: include structured `error_code` so the swimlane UI can
  // map specific validation failures to user-friendly toasts (today it just
  // shows the raw `error` string — which is fine for debugging but unhelpful
  // for editors). Codes are stable; messages may evolve.
  const validationFail = (code: string, message: string) =>
    jsonResponse({ ok: false, error: message, error_code: code, error_index: undefined }, 400, req);
  const validationFailAt = (idx: number, code: string, message: string) =>
    jsonResponse({ ok: false, error: message, error_code: code, error_index: idx }, 400, req);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') {
      return validationFailAt(i, 'EVENT_NOT_OBJECT', `events[${i}] must be an object`);
    }
    if (!e.project_id || typeof e.project_id !== 'string') {
      return validationFailAt(i, 'PROJECT_ID_REQUIRED', `events[${i}].project_id required`);
    }
    if (!e.round_id || typeof e.round_id !== 'string') {
      return validationFailAt(i, 'ROUND_ID_REQUIRED', `events[${i}].round_id required`);
    }
    if (!e.human_action || !VALID_ACTIONS.has(e.human_action)) {
      return validationFailAt(i, 'HUMAN_ACTION_INVALID',
        `events[${i}].human_action must be one of: ${[...VALID_ACTIONS].join(', ')}`);
    }
    if (e.override_reason != null && !VALID_REASONS.has(e.override_reason)) {
      return validationFailAt(i, 'OVERRIDE_REASON_INVALID', `events[${i}].override_reason invalid`);
    }
    if (e.project_tier != null && !VALID_TIERS.has(e.project_tier)) {
      return validationFailAt(i, 'PROJECT_TIER_INVALID',
        `events[${i}].project_tier must be 'standard' or 'premium'`);
    }

    if (firstProjectId === null) firstProjectId = e.project_id;
    if (firstRoundId === null) firstRoundId = e.round_id;

    const reviewSecs =
      typeof e.review_duration_seconds === 'number' && Number.isFinite(e.review_duration_seconds)
        ? Math.max(0, Math.floor(e.review_duration_seconds))
        : null;
    const confirmedWithReview =
      reviewSecs == null ? false : reviewSecs > CONFIRMED_REVIEW_THRESHOLD_SECONDS;

    // Burst 8 N1: persist client_sequence (mig 333). Burst 4 added the
    // swimlane-side emission of this counter and updated shortlist-lock to
    // order by it, but THIS endpoint silently dropped the value because the
    // input interface didn't include it. Result: every new override row had
    // client_sequence=NULL and the lock-fn ordering fix never kicked in.
    //
    // QC-iter2 W6b (F-B-011): coerceClientSequence allows 0 (the first event
    // of a session). Prior `>0` predicate sent 0 to NULL and shortlist-lock's
    // ORDER BY client_sequence NULLS LAST sorted the first event last.
    const clientSequence = coerceClientSequence(e.client_sequence);

    rows.push({
      project_id: e.project_id,
      round_id: e.round_id,
      ai_proposed_group_id: e.ai_proposed_group_id ?? null,
      ai_proposed_slot_id: e.ai_proposed_slot_id ?? null,
      ai_proposed_score: e.ai_proposed_score ?? null,
      ai_proposed_analysis: e.ai_proposed_analysis ?? null,
      human_action: e.human_action,
      human_selected_group_id: e.human_selected_group_id ?? null,
      human_selected_slot_id: e.human_selected_slot_id ?? null,
      override_reason: e.override_reason ?? null,
      override_note: e.override_note ?? null,
      slot_group_id: e.slot_group_id ?? null,
      project_tier: e.project_tier ?? null,
      primary_signal_overridden: e.primary_signal_overridden ?? null,
      review_duration_seconds: reviewSecs,
      confirmed_with_review: confirmedWithReview,
      variant_count:
        typeof e.variant_count === 'number' && Number.isFinite(e.variant_count)
          ? Math.max(0, Math.floor(e.variant_count))
          : null,
      alternative_offered: !!e.alternative_offered,
      // Wave 10.3 P1-16 (mig 342): default FALSE for legacy clients that omit
      // the field. The swimlane (W10.3 frontend) sets it TRUE iff the editor
      // opened the AlternativesDrawer for this slot in the current session.
      alternative_offered_drawer_seen: !!e.alternative_offered_drawer_seen,
      alternative_selected: !!e.alternative_selected,
      client_sequence: clientSequence,
    });
  }

  // Burst 8 N2: project-access guard. After role-gating above, also verify
  // the caller has access to every project_id referenced in the batch.
  // master_admin/admin/service_role pass through callerHasProjectAccess;
  // managers must own each project. Without this, a manager from project A
  // could record overrides against project B by submitting a crafted batch.
  // We collect the unique project_ids and check them in parallel.
  if (!isService) {
    const uniqueProjectIds = Array.from(new Set(rows.map((r) => r.project_id as string)));
    const accessChecks = await Promise.all(
      uniqueProjectIds.map((pid) => callerHasProjectAccess(user, pid)),
    );
    for (let i = 0; i < uniqueProjectIds.length; i++) {
      if (!accessChecks[i]) {
        return errorResponse(
          `Forbidden — caller has no access to project ${uniqueProjectIds[i]}`,
          403,
          req,
        );
      }
    }
  }

  const admin = getAdminClient();

  // ── Insert overrides ────────────────────────────────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from('shortlisting_overrides')
    .insert(rows)
    .select('id');
  if (insErr) {
    return errorResponse(`overrides insert failed: ${insErr.message}`, 500, req);
  }

  // ── Audit event (one row per batch) ─────────────────────────────────────
  if (firstProjectId && firstRoundId) {
    await admin.from('shortlisting_events').insert({
      project_id: firstProjectId,
      round_id: firstRoundId,
      event_type: 'overrides_batch',
      actor_type: isService ? 'system' : 'user',
      actor_id: isService ? null : (user?.id ?? null),
      payload: {
        count: rows.length,
        // Useful for the learning-loop dashboard: which actions were taken?
        action_breakdown: rows.reduce((acc, r) => {
          const k = r.human_action as string;
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
    });
  }

  return jsonResponse(
    {
      ok: true,
      received: rows.length,
      ids: (inserted || []).map((r: { id: string }) => r.id),
    },
    200,
    req,
  );
});
