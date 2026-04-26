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
 *   project_id                    UUID
 *   round_id                      UUID
 *   ai_proposed_group_id          UUID | null
 *   ai_proposed_slot_id           string | null
 *   ai_proposed_score             number | null
 *   ai_proposed_analysis          string | null    (optional; usually omitted to keep payload small)
 *   human_action                  'approved_as_proposed' | 'removed' | 'swapped' | 'added_from_rejects'
 *   human_selected_group_id       UUID | null
 *   human_selected_slot_id        string | null
 *   override_reason               'quality_preference' | 'client_instruction' | 'coverage_adjustment' | 'error_correction' | null
 *   override_note                 string | null
 *   slot_group_id                 string | null
 *   project_tier                  'standard' | 'premium' | null
 *   primary_signal_overridden     string | null
 *   review_duration_seconds       number    (gates training inclusion: > 30s = confirmed_with_review=TRUE)
 *   alternative_offered           bool      (did the swimlane show top-3 alts?)
 *   alternative_selected          bool      (did the editor pick an alt?)
 *   variant_count                 number | null
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
} from '../_shared/supabase.ts';

const GENERATOR = 'shortlisting-overrides';

const VALID_ACTIONS = new Set([
  'approved_as_proposed',
  'removed',
  'swapped',
  'added_from_rejects',
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
  alternative_selected?: boolean;
  variant_count?: number | null;
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

  let body: { events?: OverrideEventInput[]; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return errorResponse('events array required (non-empty)', 400, req);
  }
  if (events.length > 200) {
    return errorResponse('Too many events in one batch (max 200)', 400, req);
  }

  // ── Validate + normalise rows ───────────────────────────────────────────
  const rows: Record<string, unknown>[] = [];
  let firstProjectId: string | null = null;
  let firstRoundId: string | null = null;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== 'object') {
      return errorResponse(`events[${i}] must be an object`, 400, req);
    }
    if (!e.project_id || typeof e.project_id !== 'string') {
      return errorResponse(`events[${i}].project_id required`, 400, req);
    }
    if (!e.round_id || typeof e.round_id !== 'string') {
      return errorResponse(`events[${i}].round_id required`, 400, req);
    }
    if (!e.human_action || !VALID_ACTIONS.has(e.human_action)) {
      return errorResponse(
        `events[${i}].human_action must be one of: ${[...VALID_ACTIONS].join(', ')}`,
        400,
        req,
      );
    }
    if (e.override_reason != null && !VALID_REASONS.has(e.override_reason)) {
      return errorResponse(
        `events[${i}].override_reason invalid`,
        400,
        req,
      );
    }
    if (e.project_tier != null && !VALID_TIERS.has(e.project_tier)) {
      return errorResponse(
        `events[${i}].project_tier must be 'standard' or 'premium'`,
        400,
        req,
      );
    }

    if (firstProjectId === null) firstProjectId = e.project_id;
    if (firstRoundId === null) firstRoundId = e.round_id;

    const reviewSecs =
      typeof e.review_duration_seconds === 'number' && Number.isFinite(e.review_duration_seconds)
        ? Math.max(0, Math.floor(e.review_duration_seconds))
        : null;
    const confirmedWithReview =
      reviewSecs == null ? false : reviewSecs > CONFIRMED_REVIEW_THRESHOLD_SECONDS;

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
      alternative_selected: !!e.alternative_selected,
    });
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
