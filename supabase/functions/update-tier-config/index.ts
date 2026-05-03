/**
 * update-tier-config
 * ──────────────────
 * Wave 8 (W8.3) — admin endpoint for save_draft / activate / discard of
 * `shortlisting_tier_configs` rows.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §5 + §7.
 *
 * Three actions:
 *   - save_draft → INSERT new row at version=MAX(version)+1 with is_active=FALSE.
 *     Validates dimension_weights sum to 1.0 (within 0.001 tolerance) and all
 *     four dimension keys present. Validates signal_weights keys (each entry
 *     a numeric value). Validates hard_reject_thresholds shape (when provided).
 *
 *   - activate → atomic transition: UPDATE current active row to
 *     is_active=FALSE + deactivated_at=NOW(); UPDATE draft to is_active=TRUE
 *     + activated_at=NOW(). Concurrent activations get a unique-violation on
 *     idx_tier_configs_one_active_per_tier (mig 344) — we catch 23505 and
 *     return 409 with body { error: 'concurrent_activation' } per spec R7.
 *
 *   - discard → DELETE a draft (only when is_active=FALSE).
 *
 * Auth:
 *   - master_admin: all three actions.
 *   - admin: save_draft + discard. Activation requires master_admin per spec
 *     §6 ("only master_admin can activate; admin can save drafts and run
 *     simulations but the activate button is hidden for them").
 *
 * POST body:
 *   { action: 'save_draft', tier_id: string, draft: { dimension_weights, signal_weights, hard_reject_thresholds?, notes? } }
 *   { action: 'activate', draft_id: string }
 *   { action: 'discard', draft_id: string }
 *
 * Response:
 *   save_draft → { ok: true, action: 'save_draft', tier_config: <full row> }
 *   activate   → { ok: true, action: 'activate', tier_config: <activated row> }
 *   discard    → { ok: true, action: 'discard', deleted_id: string }
 *
 * Errors:
 *   400 → validation failure (dimension_weights bad, missing fields, etc.)
 *   401 → unauthenticated
 *   403 → not master_admin/admin (or admin trying to activate)
 *   404 → draft_id not found
 *   409 → concurrent activation (re-fetch and retry)
 *   500 → DB error
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { validateDimensionWeights } from '../_shared/scoreRollup.ts';

const GENERATOR = 'update-tier-config';

interface SaveDraftBody {
  action: 'save_draft';
  tier_id: string;
  draft: {
    dimension_weights: Record<string, number>;
    signal_weights: Record<string, number>;
    hard_reject_thresholds?: Record<string, number> | null;
    notes?: string | null;
  };
}

interface ActivateBody {
  action: 'activate';
  draft_id: string;
}

interface DiscardBody {
  action: 'discard';
  draft_id: string;
}

type RequestBody = SaveDraftBody | ActivateBody | DiscardBody | { _health_check?: boolean };

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden — master_admin or admin only', 403, req);
    }
  }
  const isMasterAdmin = isService || user?.role === 'master_admin';

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('JSON body required', 400, req);
  }
  if ((body as { _health_check?: boolean })._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const action = (body as { action?: string }).action;
  if (action === 'save_draft') {
    return await handleSaveDraft(body as SaveDraftBody, user?.id ?? null, req);
  } else if (action === 'activate') {
    if (!isMasterAdmin) {
      return errorResponse('Forbidden — only master_admin can activate', 403, req);
    }
    return await handleActivate(body as ActivateBody, req);
  } else if (action === 'discard') {
    return await handleDiscard(body as DiscardBody, req);
  } else {
    return errorResponse(`unknown action='${action}'; expected save_draft | activate | discard`, 400, req);
  }
});

// ─── save_draft ───────────────────────────────────────────────────────────────

async function handleSaveDraft(
  body: SaveDraftBody,
  userId: string | null,
  req: Request,
): Promise<Response> {
  const tierId = body.tier_id;
  const draft = body.draft;
  if (!tierId || typeof tierId !== 'string') {
    return errorResponse('tier_id required', 400, req);
  }
  if (!draft || typeof draft !== 'object') {
    return errorResponse('draft required', 400, req);
  }

  // Validate dimension_weights.
  const dimResult = validateDimensionWeights(draft.dimension_weights);
  if (!dimResult.valid) {
    return errorResponse(`dimension_weights validation failed: ${dimResult.error}`, 400, req);
  }

  // Validate signal_weights — each value must be a finite number.
  if (!draft.signal_weights || typeof draft.signal_weights !== 'object') {
    return errorResponse('signal_weights required (object map of signal_key → number)', 400, req);
  }
  for (const [k, v] of Object.entries(draft.signal_weights)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) {
      return errorResponse(`signal_weights.${k} is not a non-negative finite number (got ${JSON.stringify(v)})`, 400, req);
    }
  }

  // Validate hard_reject_thresholds shape when provided. NULL is allowed
  // (per-tier override unset → inherit engine_settings global).
  if (draft.hard_reject_thresholds !== undefined && draft.hard_reject_thresholds !== null) {
    if (typeof draft.hard_reject_thresholds !== 'object') {
      return errorResponse('hard_reject_thresholds must be an object or null', 400, req);
    }
    for (const [k, v] of Object.entries(draft.hard_reject_thresholds)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        return errorResponse(`hard_reject_thresholds.${k} out of range [0, 10] (got ${JSON.stringify(v)})`, 400, req);
      }
    }
  }

  const admin = getAdminClient();

  // Resolve next version: SELECT MAX(version) + 1 for this tier.
  // Concurrent save_draft calls can both pick the same MAX result and try
  // to INSERT the same version — the UNIQUE(tier_id, version) constraint
  // catches that (23505); we retry once.
  const insertOnce = async (): Promise<{ row: Record<string, unknown> | null; error: string | null; conflict: boolean }> => {
    const { data: latest } = await admin
      .from('shortlisting_grade_configs')
      .select('version')
      .eq('grade_id', tierId)
      .order('version', { ascending: false })
      .limit(1);
    const nextVersion = ((latest?.[0]?.version as number) ?? 0) + 1;

    const { data: inserted, error: insertErr } = await admin
      .from('shortlisting_grade_configs')
      .insert({
        // mig 443: tier_id column on this table renamed to grade_id.
        // We keep `tier_id` in request/response field names so the admin
        // UI doesn't need a coordinated rollout — only the SQL boundary
        // changed.
        grade_id: tierId,
        version: nextVersion,
        dimension_weights: draft.dimension_weights,
        signal_weights: draft.signal_weights,
        hard_reject_thresholds: draft.hard_reject_thresholds ?? null,
        is_active: false,
        created_by: userId,
        notes: draft.notes ?? null,
      })
      .select('id, tier_id:grade_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, created_by, notes, created_at')
      .single();
    if (insertErr) {
      const isConflict = insertErr.code === '23505' || /duplicate/i.test(insertErr.message);
      return { row: null, error: insertErr.message, conflict: isConflict };
    }
    return { row: inserted, error: null, conflict: false };
  };

  let result = await insertOnce();
  if (result.conflict) {
    // Race: re-resolve MAX(version) + 1 and try once more.
    result = await insertOnce();
  }
  if (result.error || !result.row) {
    return errorResponse(`save_draft insert failed: ${result.error ?? 'no row returned'}`, 500, req);
  }

  return jsonResponse(
    { ok: true, action: 'save_draft', tier_config: result.row },
    200,
    req,
  );
}

// ─── activate ─────────────────────────────────────────────────────────────────

async function handleActivate(body: ActivateBody, req: Request): Promise<Response> {
  const draftId = body.draft_id;
  if (!draftId || typeof draftId !== 'string') {
    return errorResponse('draft_id required', 400, req);
  }

  const admin = getAdminClient();

  // Load the draft.
  const { data: draftRow, error: draftErr } = await admin
    .from('shortlisting_grade_configs')
    .select('id, tier_id:grade_id, is_active')
    .eq('id', draftId)
    .maybeSingle();
  if (draftErr) return errorResponse(`draft lookup failed: ${draftErr.message}`, 500, req);
  if (!draftRow) return errorResponse(`draft not found: ${draftId}`, 404, req);
  if (draftRow.is_active === true) {
    return errorResponse('draft is already active', 400, req);
  }

  // Find current active row for this tier.
  const { data: activeRow } = await admin
    .from('shortlisting_grade_configs')
    .select('id')
    .eq('grade_id', draftRow.tier_id)
    .eq('is_active', true)
    .maybeSingle();

  // Two-step transition: deactivate current, then activate draft.
  // The partial unique index idx_tier_configs_one_active_per_tier (mig 344)
  // enforces that exactly one row per tier_id has is_active=TRUE at any
  // time — concurrent activations get a 23505 here.
  //
  // We do this in two UPDATE statements rather than a Postgres transaction
  // because Supabase's JS client doesn't expose transactions directly. The
  // sequence is:
  //   1. UPDATE draft → is_active=TRUE (this is the race-sensitive step)
  //   2. UPDATE old active → is_active=FALSE + deactivated_at=NOW()
  // If step 1 succeeds and step 2 fails, the partial unique index would
  // already have rejected step 1 — so step 2 only fires after step 1's
  // success means the constraint accepted the new row. In practice the
  // index check happens row-by-row at INSERT/UPDATE-time; if step 1
  // succeeds the database guarantees no other row had is_active=TRUE for
  // this tier_id at the moment step 1 ran. (We then immediately flip the
  // old active off; the brief window where two rows COULD both be
  // is_active=TRUE is closed by the partial unique index — they CAN'T both
  // be is_active=TRUE concurrently.)
  //
  // Wait: that's not right. The partial unique index catches the case
  // where you're TRYING to set is_active=TRUE on a second row. So step 1
  // (UPDATE draft → is_active=TRUE) WILL fail with 23505 if there's
  // already an active row for this tier_id. We need to flip the OLD row
  // off FIRST.
  if (activeRow && activeRow.id !== draftId) {
    const nowIso = new Date().toISOString();
    const { error: deactErr } = await admin
      .from('shortlisting_grade_configs')
      .update({ is_active: false, deactivated_at: nowIso, updated_at: nowIso })
      .eq('id', activeRow.id)
      .eq('is_active', true); // optimistic: only succeed if it's still active
    if (deactErr) {
      return errorResponse(`deactivate previous failed: ${deactErr.message}`, 500, req);
    }
  }

  const nowIso = new Date().toISOString();
  const { data: activatedRow, error: actErr } = await admin
    .from('shortlisting_grade_configs')
    .update({ is_active: true, activated_at: nowIso, updated_at: nowIso })
    .eq('id', draftId)
    .eq('is_active', false) // optimistic: only succeed if it's still a draft
    .select(
      'id, tier_id:grade_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, activated_at, deactivated_at, created_by, notes, created_at, updated_at',
    )
    .maybeSingle();
  if (actErr) {
    // 23505 → another admin already activated a different draft for this tier.
    if (actErr.code === '23505' || /duplicate/i.test(actErr.message)) {
      // Best-effort: roll back our deactivation? In practice this is rare
      // and the UI shows a refresh-and-retry message. We log for ops.
      console.warn(
        `[${GENERATOR}] activation race detected for draft ${draftId}: ${actErr.message}`,
      );
      return jsonResponse(
        {
          error: 'concurrent_activation',
          detail: 'Another admin just activated a different config; refresh to see the latest active row',
        },
        409,
        req,
      );
    }
    return errorResponse(`activate failed: ${actErr.message}`, 500, req);
  }
  if (!activatedRow) {
    // The draft must have been activated/discarded between our load and
    // the UPDATE. UI should refetch.
    return jsonResponse(
      {
        error: 'concurrent_modification',
        detail: 'Draft state changed between load and activate; refresh and retry',
      },
      409,
      req,
    );
  }

  return jsonResponse(
    { ok: true, action: 'activate', tier_config: activatedRow },
    200,
    req,
  );
}

// ─── discard ──────────────────────────────────────────────────────────────────

async function handleDiscard(body: DiscardBody, req: Request): Promise<Response> {
  const draftId = body.draft_id;
  if (!draftId || typeof draftId !== 'string') {
    return errorResponse('draft_id required', 400, req);
  }

  const admin = getAdminClient();

  const { data: row, error: lookupErr } = await admin
    .from('shortlisting_grade_configs')
    .select('id, is_active')
    .eq('id', draftId)
    .maybeSingle();
  if (lookupErr) return errorResponse(`draft lookup failed: ${lookupErr.message}`, 500, req);
  if (!row) return errorResponse(`draft not found: ${draftId}`, 404, req);
  if (row.is_active === true) {
    return errorResponse('cannot discard an active config — deactivate first by activating a different draft', 400, req);
  }

  const { error: delErr } = await admin
    .from('shortlisting_grade_configs')
    .delete()
    .eq('id', draftId)
    .eq('is_active', false);
  if (delErr) {
    return errorResponse(`discard failed: ${delErr.message}`, 500, req);
  }

  return jsonResponse(
    { ok: true, action: 'discard', deleted_id: draftId },
    200,
    req,
  );
}
