/**
 * regenerate-master-listing
 * ─────────────────────────
 * Wave 11.7.7 — operator-triggered regeneration of a round's master_listing
 * with optional voice tier / voice anchor override.
 *
 * Spec: docs/design-specs/W11-7-7-master-listing-copy.md §"Master_admin
 *       re-generation flow".
 *
 * Behaviour:
 *   1. Loads the active master_listing row for the round.
 *   2. Archives the current version to shortlisting_master_listings_history
 *      (with regeneration_count snapshot).
 *   3. Increments regeneration_count + stamps regenerated_at + regenerated_by
 *      on the master_listings row. The master_listing JSONB stays in place
 *      until Stage 4 worker (Agent 1) overwrites it with the new synthesis.
 *   4. Enqueues a stage4_synthesis job in shortlisting_jobs with payload
 *      `{ regenerate: true, voice_tier_override?, voice_anchor_override?,
 *        reason? }` so the existing Stage 4 worker can pick it up on the
 *      next dispatcher tick.
 *
 *   TODO(Agent 1): the Stage 4 worker needs to handle
 *     payload.regenerate === true. When set, the worker should:
 *       (a) read master_listing_id_to_overwrite from the job payload
 *       (b) apply voice_tier_override / voice_anchor_override if present,
 *           otherwise fall back to round.property_tier
 *       (c) re-run the master_listing synthesis (slot decisions + dedup
 *           remain unchanged — this is a copy-only regen)
 *       (d) UPDATE the master_listings row in place (preserves the FK
 *           target for shortlisting_master_listings_history archive rows)
 *
 * Auth: master_admin only (regen costs ~$1.20/call).
 *
 * POST body:
 *   { round_id: string,
 *     voice_tier_override?: 'premium' | 'standard' | 'approachable',
 *     voice_anchor_override?: string,    // free-text rubric (≤2000 chars)
 *     reason?: string }                   // operator context for the regen
 *
 * Response:
 *   { ok: true, job_id: string, regeneration_count: number,
 *     archived_history_id: string }
 *
 * Errors:
 *   400 → bad request
 *   401 → unauthenticated
 *   403 → not master_admin
 *   404 → round_id has no active master_listing
 *   409 → another regen in flight for this round
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

const GENERATOR = 'regenerate-master-listing';

const ALLOWED_TIERS = new Set(['premium', 'standard', 'approachable']);
const VOICE_ANCHOR_MAX_CHARS = 2000;

interface ReqBody {
  round_id?: string;
  voice_tier_override?: string;
  voice_anchor_override?: string;
  reason?: string;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden — master_admin only', 403, req);
    }
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('JSON body required', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id;
  if (!roundId || typeof roundId !== 'string') {
    return errorResponse('round_id required', 400, req);
  }

  // Voice tier override validation.
  if (body.voice_tier_override !== undefined && body.voice_tier_override !== null) {
    if (!ALLOWED_TIERS.has(body.voice_tier_override)) {
      return errorResponse(
        `voice_tier_override must be one of: ${Array.from(ALLOWED_TIERS).join(', ')}`,
        400,
        req,
      );
    }
  }
  // Voice anchor override length validation.
  if (body.voice_anchor_override !== undefined && body.voice_anchor_override !== null) {
    if (typeof body.voice_anchor_override !== 'string') {
      return errorResponse('voice_anchor_override must be a string', 400, req);
    }
    if (body.voice_anchor_override.length > VOICE_ANCHOR_MAX_CHARS) {
      return errorResponse(
        `voice_anchor_override too long (${body.voice_anchor_override.length} > ${VOICE_ANCHOR_MAX_CHARS} chars)`,
        400,
        req,
      );
    }
  }

  const admin = getAdminClient();

  // Load the active master_listing for this round.
  const { data: ml, error: mlErr } = await admin
    .from('shortlisting_master_listings')
    .select('id, round_id, master_listing, property_tier, voice_anchor_used, ' +
            'regeneration_count, deleted_at, created_at')
    .eq('round_id', roundId)
    .is('deleted_at', null)
    .maybeSingle();
  if (mlErr) return errorResponse(`master_listing load failed: ${mlErr.message}`, 500, req);
  if (!ml) {
    return errorResponse(
      `No active master_listing found for round ${roundId}. Stage 4 must run first.`,
      404,
      req,
    );
  }

  // Verify the round exists and is in a state where regeneration makes sense.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, engine_mode, property_tier, property_voice_anchor_override')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) return errorResponse(`round load failed: ${roundErr.message}`, 500, req);
  if (!round) return errorResponse(`round ${roundId} not found`, 404, req);

  // Check for any existing stage4_synthesis job for this round. The unique
  // partial index uniq_shortlisting_jobs_active_pass_per_round (mig 377)
  // prevents inserting a new stage4_synthesis job when an existing one is
  // pending/running/succeeded. We resolve this by:
  //   - 409 if a regen is already pending/running (don't double-enqueue)
  //   - else mark the prior succeeded job as 'succeeded_archived' (or
  //     similar) so the unique index releases the slot for the new job
  // Simpler/safer at v1: query existing jobs and reject if a regenerate
  // is in-flight; if a non-regen succeeded job exists, we mark it
  // archived to free the slot.
  const { data: existingJobs, error: jobLookupErr } = await admin
    .from('shortlisting_jobs')
    .select('id, status, payload, kind')
    .eq('round_id', roundId)
    .eq('kind', 'stage4_synthesis');
  if (jobLookupErr) {
    return errorResponse(`job lookup failed: ${jobLookupErr.message}`, 500, req);
  }

  const nowIso = new Date().toISOString();

  const inflightSlots = (existingJobs || []).filter(
    (j) => j.status === 'pending' || j.status === 'running' || j.status === 'processing',
  );
  if (inflightSlots.length > 0) {
    const j = inflightSlots[0];
    const isRegen = (j.payload as Record<string, unknown> | null)?.regenerate === true;
    return errorResponse(
      `${isRegen ? 'regeneration' : 'stage4 synthesis'} already in flight (job ${j.id})`,
      409,
      req,
    );
  }

  // Free up the unique slot held by any previously-succeeded job. The
  // unique partial index uniq_shortlisting_jobs_active_pass_per_round
  // includes 'succeeded' so we must transition the prior job out of that
  // state before inserting a new one. The shortlisting_jobs status CHECK
  // (mig 284) accepts 'failed' and 'dead_letter' as terminal exit states
  // outside the unique-index predicate. We tag the prior succeeded job
  // as 'failed' with a clear error_message marking it as archived for
  // regeneration — preserves the row for forensic replay while freeing
  // the unique slot for the new regenerate job.
  const succeededJobs = (existingJobs || []).filter((j) => j.status === 'succeeded');
  for (const j of succeededJobs) {
    const { error: archErr } = await admin
      .from('shortlisting_jobs')
      .update({
        status: 'failed',
        error_message: 'archived_by_regeneration: superseded by master-listing regenerate request',
        finished_at: nowIso,
      })
      .eq('id', j.id)
      .eq('status', 'succeeded'); // optimistic guard against concurrent regen
    if (archErr) {
      return errorResponse(
        `failed to archive prior stage4 job ${j.id}: ${archErr.message}`,
        500,
        req,
      );
    }
  }

  const regeneratedBy = isService ? null : user!.id;

  // 1. Archive the current master_listing to history.
  const { data: historyRow, error: historyErr } = await admin
    .from('shortlisting_master_listings_history')
    .insert({
      master_listing_id: ml.id,
      round_id: ml.round_id,
      master_listing: ml.master_listing,
      property_tier: ml.property_tier,
      voice_anchor_used: ml.voice_anchor_used,
      regeneration_count: ml.regeneration_count,
      archived_by: regeneratedBy,
      archive_reason: body.reason ?? `regenerate-master-listing (tier_override=${body.voice_tier_override ?? 'none'})`,
    })
    .select('id')
    .single();
  if (historyErr) {
    return errorResponse(`history archive failed: ${historyErr.message}`, 500, req);
  }

  // 2. Increment regeneration_count + stamp regen metadata.
  const newRegenCount = (ml.regeneration_count ?? 0) + 1;
  const { error: bumpErr } = await admin
    .from('shortlisting_master_listings')
    .update({
      regeneration_count: newRegenCount,
      regenerated_at: nowIso,
      regenerated_by: regeneratedBy,
      regeneration_reason: body.reason ?? null,
      updated_at: nowIso,
    })
    .eq('id', ml.id);
  if (bumpErr) {
    return errorResponse(`master_listing bump failed: ${bumpErr.message}`, 500, req);
  }

  // 3. Enqueue the stage4_synthesis job. The Stage 4 worker (Agent 1's
  //    domain) handles payload.regenerate === true; until that lands, the
  //    job sits pending and the operator can re-trigger from the UI.
  const jobPayload: Record<string, unknown> = {
    regenerate: true,
    master_listing_id_to_overwrite: ml.id,
    archived_history_id: historyRow.id,
    regeneration_count_before: ml.regeneration_count ?? 0,
    regeneration_count_after: newRegenCount,
  };
  if (body.voice_tier_override) {
    jobPayload.voice_tier_override = body.voice_tier_override;
  }
  if (body.voice_anchor_override) {
    jobPayload.voice_anchor_override = body.voice_anchor_override;
  }
  if (body.reason) {
    jobPayload.reason = body.reason;
  }
  if (regeneratedBy) {
    jobPayload.regenerated_by = regeneratedBy;
  }

  const { data: jobRow, error: jobErr } = await admin
    .from('shortlisting_jobs')
    .insert({
      round_id: roundId,
      project_id: round.project_id,
      kind: 'stage4_synthesis',
      status: 'pending',
      payload: jobPayload,
      attempt_count: 0,
    })
    .select('id')
    .single();
  if (jobErr) {
    // Job enqueue failed — best-effort rollback of the regen_count bump
    // so the operator can retry without seeing an incorrect count.
    await admin
      .from('shortlisting_master_listings')
      .update({
        regeneration_count: ml.regeneration_count ?? 0,
        regenerated_at: null,
        regenerated_by: null,
        regeneration_reason: null,
      })
      .eq('id', ml.id);
    return errorResponse(`job enqueue failed: ${jobErr.message}`, 500, req);
  }

  return jsonResponse(
    {
      ok: true,
      job_id: jobRow.id,
      regeneration_count: newRegenCount,
      archived_history_id: historyRow.id,
      master_listing_id: ml.id,
      // Friendly prompt for the UI to indicate the worker dependency.
      worker_note: 'Stage 4 worker (Agent 1 domain) needs payload.regenerate handling. If it has not yet been wired, the job will sit in pending until the worker is updated.',
    },
    200,
    req,
  );
});
