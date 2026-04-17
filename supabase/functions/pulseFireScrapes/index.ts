import { getAdminClient, createEntities, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * Pulse Fire Scrapes — Chunked cron dispatcher (v4 batched self-invocation)
 *
 * Reads source configuration from pulse_source_configs (single source of truth
 * for all Apify input parameters). For per_suburb sources, iterates active
 * suburbs in pulse_target_suburbs and fires individual pulseDataSync calls
 * fire-and-forget.
 *
 * v4 change (migration 084): the per-suburb loop runs in batches of ~20 with
 * fire-and-forget self-invocation between batches. Previous versions tried to
 * dispatch 166+ suburbs in a single edge isolate and were killed by the 150s
 * wall-clock (evidence: only ~80 of 166 ever made it through before the
 * isolate was torn down, and the one terminal cron_dispatched audit event at
 * end-of-loop never landed in pulse_timeline). Chunking keeps each invocation
 * well under the cap (~100s worst case at 5s/suburb × 20 suburbs) and writes
 * an incremental audit trail so partial failures are visible.
 *
 * v4 change: the legacy `bounding_box` branch has been removed. No source in
 * pulse_source_configs uses approach='bounding_box' — every REA source is
 * per_suburb (including the rea_listings_bb_* family, which are named for the
 * REA "bounding box" URL pattern they consume but still iterate the suburb
 * pool). The old branch wrote useless "Bounding box scrape fired" events with
 * dispatched:null and is now unreachable.
 *
 * Body params:
 *   source_id:    string — must exist in pulse_source_configs
 *   min_priority: number — override config.min_priority (optional)
 *   max_suburbs:  number — override config.max_suburbs (optional, safety cap)
 *   batch_id:     uuid   — internal: when present, continue an existing batch
 *   offset:       number — internal: starting index into suburb_ids
 *   batch_size:   number — internal: suburbs processed per invocation (default 20)
 *
 * Timeline audit events written:
 *   cron_dispatch_started:   on kickoff (offset=0), records plan + pool size
 *   cron_dispatch_batch:     each invocation, records batch_number + suburbs dispatched
 *   cron_dispatched:         on completion only — legacy event name preserved
 *                             for pulse_source_card_stats() (migration 083) so the
 *                             Source Card "coverage" metric keeps working without
 *                             schema changes.
 *   cron_dispatch_completed: on completion, parallel to cron_dispatched for
 *                             richer batch-level stats (batch_count, duration_ms)
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
// IMPORTANT: SUPABASE_SERVICE_ROLE_KEY on new Supabase projects is auto-injected
// in the new sb_secret_... format, which is NOT a JWT and fails edge function
// auth (UNAUTHORIZED_INVALID_JWT_FORMAT). For edge-to-edge HTTP calls we need a
// legacy JWT service_role key. PULSE_EDGE_JWT is a user-set secret containing
// that JWT. Falls back to SUPABASE_SERVICE_ROLE_KEY only if PULSE_EDGE_JWT is
// missing (for backward compat with old projects).
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get('PULSE_EDGE_JWT') ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

const DEFAULT_BATCH_SIZE = 20;
const SELF_INVOKE_TIMEOUT_MS = 3000;
const PER_SUBURB_DISPATCH_TIMEOUT_MS = 3000;
// Default inter-suburb stagger; overridden per-source via
// pulse_source_configs.stagger_seconds (migration 087). Sources whose upstream
// rate-limits the scraper IP (e.g. rea_agents) set a much higher value (30s)
// to stay under the throttle and let Apify's proxy rotation cycle IPs.
const DEFAULT_INTER_SUBURB_STAGGER_MS = 2000;

/**
 * Expand {suburb} / {suburb-slug} / {postcode} placeholders in every string
 * value of the actor input template. Non-string values pass through unchanged.
 */
function inflateSuburbTemplate(
  input: Record<string, any>,
  suburb: string,
  postcode: string | null,
): Record<string, any> {
  const slug = suburb.toLowerCase().replace(/\s+/g, '-');
  const postcodeStr = postcode || '';
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') {
      out[k] = v
        .replace(/\{suburb\}/g, suburb)
        .replace(/\{suburb-slug\}/g, slug)
        .replace(/\{postcode\}/g, postcodeStr);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Best-effort timeline insert. Swallows errors — audit failures must never break dispatch. */
async function writeTimeline(
  admin: any,
  eventType: string,
  title: string,
  description: string,
  newValue: Record<string, any>,
): Promise<void> {
  try {
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: eventType,
      event_category: 'system',
      title,
      description,
      new_value: newValue,
      source: 'cron',
    });
  } catch (err: any) {
    console.warn(`[timeline] insert failed for ${eventType}:`, err?.message);
  }
}

serveWithAudit('pulseFireScrapes', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const _entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v4.0', _fn: 'pulseFireScrapes', _arch: 'chunked-self-invocation' });
    }

    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const { source_id } = body;

    if (!source_id) {
      return errorResponse('source_id is required', 400);
    }

    // ── Load config from DB (single source of truth) ─────────────────────
    const { data: config, error: cfgErr } = await admin
      .from('pulse_source_configs')
      .select('source_id, label, actor_slug, actor_input, approach, max_results_per_suburb, max_suburbs, min_priority, is_enabled, stagger_seconds')
      .eq('source_id', source_id)
      .single();

    if (cfgErr || !config) {
      return errorResponse(`Unknown source_id: ${source_id}. Must exist in pulse_source_configs. ${cfgErr?.message || ''}`, 400);
    }

    if (!config.is_enabled) {
      return errorResponse(`Source ${source_id} is disabled in pulse_source_configs.`, 400);
    }

    // Legacy approach=bounding_box is no longer supported. pulse_source_configs
    // has none today; every source is per_suburb. Fail loud if one sneaks in
    // via a manual DB edit so the operator fixes the config rather than
    // silently re-introducing the dead-branch bug.
    if (config.approach === 'bounding_box') {
      return errorResponse(
        `Source ${source_id} has approach='bounding_box' which is no longer supported. ` +
        `Change approach to 'per_suburb' in pulse_source_configs.`,
        400,
      );
    }

    const actorInput = (config.actor_input || {}) as Record<string, any>;
    const sourceLabel = config.label || source_id;

    // Body overrides > DB config > defaults
    const min_priority = body.min_priority ?? config.min_priority ?? 0;
    const max_suburbs = body.max_suburbs ?? config.max_suburbs ?? 20;
    const incomingOffset: number = Number.isInteger(body.offset) ? Number(body.offset) : 0;
    const incomingBatchId: string | null = typeof body.batch_id === 'string' && body.batch_id.length > 0 ? body.batch_id : null;

    // Inject max_results_per_suburb as actorInput.maxItems (cap per run).
    const maxItems = config.max_results_per_suburb ?? actorInput.maxItems ?? 10;

    // Per-source inter-suburb stagger (migration 087). Fall back to the legacy
    // 2s default if the column is NULL. Allow body override for ad-hoc probes.
    const staggerSeconds =
      Number.isFinite(body?.stagger_seconds) ? Number(body.stagger_seconds) :
      (Number.isFinite(config.stagger_seconds) ? Number(config.stagger_seconds) : null);
    const interSuburbStaggerMs = staggerSeconds != null && staggerSeconds >= 0
      ? staggerSeconds * 1000
      : DEFAULT_INTER_SUBURB_STAGGER_MS;

    // Batch size must keep each invocation well under the 150s edge-runtime
    // cap. Budget ~130s of work per batch; each suburb costs
    // (stagger + ~5s dispatch handshake). Cap at DEFAULT_BATCH_SIZE for the
    // cheap-stagger sources where 20 easily fits in 150s. Body override wins
    // for explicit probing.
    const perSuburbCostMs = interSuburbStaggerMs + PER_SUBURB_DISPATCH_TIMEOUT_MS;
    const maxBatchByBudget = Math.max(1, Math.floor(130000 / perSuburbCostMs));
    const batch_size = Math.max(
      1,
      Math.min(
        50,
        body.batch_size ?? Math.min(DEFAULT_BATCH_SIZE, maxBatchByBudget),
      ),
    );

    // ── Kickoff or continuation ─────────────────────────────────────────
    let batchId: string;
    let suburbIds: Array<{ name: string; postcode: string | null }>;
    let totalCount: number;
    let startedAt: string;

    if (incomingBatchId) {
      // Continuation: load batch state. A prior invocation already ran the
      // duplicate-run guard + suburb snapshot at offset=0.
      const { data: batch, error: batchErr } = await admin
        .from('pulse_fire_batches')
        .select('id, source_id, suburb_ids, total_count, dispatched_count, current_offset, batch_size, status, started_at')
        .eq('id', incomingBatchId)
        .single();
      if (batchErr || !batch) {
        return errorResponse(`Unknown batch_id: ${incomingBatchId}. ${batchErr?.message || ''}`, 400);
      }
      if (batch.source_id !== source_id) {
        return errorResponse(`batch_id ${incomingBatchId} belongs to source ${batch.source_id}, not ${source_id}`, 400);
      }
      if (batch.status !== 'running') {
        // Another invocation already completed or timed out this batch.
        return jsonResponse({ success: true, source_id, batch_id: incomingBatchId, skipped: true, reason: `batch.status=${batch.status}` });
      }
      batchId = batch.id;
      suburbIds = Array.isArray(batch.suburb_ids) ? batch.suburb_ids : [];
      totalCount = batch.total_count;
      startedAt = batch.started_at;
    } else {
      // Kickoff (offset=0): load suburbs, snapshot the batch.
      //
      // Duplicate run check — skip if a sync is already running within last
      // 30 min. Only guards the kickoff; continuation invocations are part of
      // the same logical dispatch and shouldn't re-check.
      const { data: runningSync } = await admin.from('pulse_sync_logs')
        .select('id')
        .eq('source_id', source_id)
        .eq('status', 'running')
        .gte('started_at', new Date(Date.now() - 30 * 60000).toISOString())
        .limit(1);
      if (runningSync && runningSync.length > 0) {
        return jsonResponse({ success: false, message: `Source ${source_id} already running`, existing_log: runningSync[0].id });
      }

      let query = admin.from('pulse_target_suburbs')
        .select('name, postcode')
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .limit(max_suburbs);

      if (min_priority > 0) {
        query = query.gte('priority', min_priority);
      }

      const { data: suburbs } = await query;
      if (!suburbs || suburbs.length === 0) {
        await writeTimeline(
          admin,
          'cron_dispatched',
          `Cron dispatched: ${sourceLabel}`,
          `No active suburbs matched filters`,
          { source_id, dispatched: 0, min_priority, max_items: maxItems, suburbs: [], skipped: [], actor_input: actorInput },
        );
        return jsonResponse({ success: true, source_id, dispatched: 0, message: 'No active suburbs' });
      }

      // Per-suburb URLs require postcode — skip any suburb missing it. The REA
      // URL pattern (e.g. /buy/in-strathfield,+nsw+2135) silently redirects or
      // returns garbage without a postcode, so scraping without one is unsafe.
      const actorInputUsesPostcode = JSON.stringify(actorInput).includes('{postcode}');
      const skippedSuburbs: string[] = [];
      const eligibleSuburbs = suburbs.filter(s => {
        if (actorInputUsesPostcode && !s.postcode) {
          skippedSuburbs.push(s.name);
          return false;
        }
        return true;
      });

      if (skippedSuburbs.length > 0) {
        console.warn(`[${source_id}] Skipped ${skippedSuburbs.length} suburbs missing postcode: ${skippedSuburbs.slice(0, 10).join(', ')}${skippedSuburbs.length > 10 ? '...' : ''}`);
      }

      suburbIds = eligibleSuburbs.map(s => ({ name: s.name, postcode: s.postcode || null }));
      totalCount = suburbIds.length;

      if (totalCount === 0) {
        await writeTimeline(
          admin,
          'cron_dispatched',
          `Cron dispatched: ${sourceLabel}`,
          `All ${suburbs.length} suburbs skipped (missing postcode)`,
          { source_id, dispatched: 0, min_priority, max_items: maxItems, suburbs: [], skipped: skippedSuburbs, actor_input: actorInput },
        );
        return jsonResponse({ success: true, source_id, dispatched: 0, message: 'All suburbs skipped (no postcode)' });
      }

      // Persist the batch so continuation invocations can resume.
      const { data: inserted, error: insertErr } = await admin
        .from('pulse_fire_batches')
        .insert({
          source_id,
          suburb_ids: suburbIds,
          total_count: totalCount,
          dispatched_count: 0,
          current_offset: 0,
          batch_size,
          status: 'running',
        })
        .select('id, started_at')
        .single();
      if (insertErr || !inserted) {
        return errorResponse(`Failed to create fire batch: ${insertErr?.message}`, 500);
      }
      batchId = inserted.id;
      startedAt = inserted.started_at;

      await writeTimeline(
        admin,
        'cron_dispatch_started',
        `Cron started: ${sourceLabel}`,
        `Starting batched dispatch of ${totalCount} suburbs (batch size ${batch_size}, stagger ${Math.round(interSuburbStaggerMs / 1000)}s)${skippedSuburbs.length > 0 ? `; skipped ${skippedSuburbs.length} missing postcode` : ''}`,
        {
          source_id,
          batch_id: batchId,
          total_count: totalCount,
          batch_size,
          stagger_seconds: Math.round(interSuburbStaggerMs / 1000),
          min_priority,
          max_items: maxItems,
          skipped: skippedSuburbs,
          actor_input: actorInput,
        },
      );
    }

    // ── Process this batch slice ─────────────────────────────────────────
    const startIdx = Math.max(0, Math.min(incomingOffset, totalCount));
    const endIdx = Math.min(startIdx + batch_size, totalCount);
    const sliceSuburbs = suburbIds.slice(startIdx, endIdx);
    const batchNumber = Math.floor(startIdx / batch_size) + 1;
    const totalBatches = Math.ceil(totalCount / batch_size);
    const isFinalBatch = endIdx >= totalCount;

    let dispatchedInBatch = 0;
    for (let i = 0; i < sliceSuburbs.length; i++) {
      const suburb = sliceSuburbs[i];
      // Inflate {suburb} / {suburb-slug} / {postcode} placeholders in template
      const inflated = inflateSuburbTemplate(actorInput, suburb.name, suburb.postcode);
      // Force maxItems from config so we never depend on hardcoded template value
      inflated.maxItems = maxItems;

      const params = {
        suburbs: [suburb.name],
        state: 'NSW',
        source_id,
        source_label: `${sourceLabel} - ${suburb.name} (cron)`,
        triggered_by_name: 'Cron',
        actorInput: inflated,
        // Batch attribution (migration 088) — so pulseDataSync can stamp the
        // per-suburb sync_logs row with "this came from batch N of M". Lets the
        // UI filter sync history by batch and render "Batch 3/10" chips.
        batch_id: batchId,
        batch_number: batchNumber,
        total_batches: totalBatches,
      };

      const sp = fetch(`${SUPABASE_URL}/functions/v1/pulseDataSync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(params),
      }).catch((err) => { console.error('Fire-and-forget failed for', source_id, err.message?.substring(0, 100)); });
      await Promise.race([sp, new Promise(r => setTimeout(r, PER_SUBURB_DISPATCH_TIMEOUT_MS))]);

      dispatchedInBatch++;

      // Inter-suburb stagger (avoid Apify / upstream rate limit). Configured
      // per-source via pulse_source_configs.stagger_seconds (migration 087).
      // Skip on last suburb of batch — the delay would be wasted before we
      // self-invoke.
      if (i < sliceSuburbs.length - 1 && interSuburbStaggerMs > 0) {
        await new Promise(r => setTimeout(r, interSuburbStaggerMs));
      }
    }

    // ── Persist batch progress before handing off ────────────────────────
    const newDispatched = startIdx + dispatchedInBatch;
    const updateFields: Record<string, any> = {
      dispatched_count: newDispatched,
      current_offset: endIdx,
      last_batch_at: new Date().toISOString(),
    };
    if (isFinalBatch) {
      updateFields.status = 'completed';
      updateFields.completed_at = new Date().toISOString();
    }
    try {
      await admin.from('pulse_fire_batches').update(updateFields).eq('id', batchId);
    } catch (err: any) {
      console.warn(`[fire-batches] update failed for batch ${batchId}:`, err?.message);
    }

    // ── Per-batch audit event (bulletproof: written after every batch) ──
    await writeTimeline(
      admin,
      'cron_dispatch_batch',
      `Batch ${batchNumber}/${totalBatches}: ${sourceLabel}`,
      `Batch ${batchNumber}/${totalBatches} — dispatched ${dispatchedInBatch} suburbs (${sliceSuburbs.slice(0, 3).map(s => s.name).join(', ')}${sliceSuburbs.length > 3 ? '...' : ''}); running total ${newDispatched}/${totalCount}`,
      {
        source_id,
        batch_id: batchId,
        batch_number: batchNumber,
        total_batches: totalBatches,
        offset: startIdx,
        dispatched_in_batch: dispatchedInBatch,
        dispatched_total: newDispatched,
        total_count: totalCount,
        suburbs_in_batch: sliceSuburbs.map(s => s.name),
      },
    );

    // ── Self-invoke for next batch (if any) ─────────────────────────────
    if (!isFinalBatch) {
      const nextBody = {
        source_id,
        batch_id: batchId,
        offset: endIdx,
        batch_size,
        // Pass overrides through so each invocation sees the same effective config.
        min_priority,
        max_suburbs,
      };
      const selfInvoke = fetch(`${SUPABASE_URL}/functions/v1/pulseFireScrapes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'x-caller-context': 'pulseFireScrapes:self',
        },
        body: JSON.stringify(nextBody),
      }).catch((err) => { console.error('Self-invoke failed for next batch', err?.message?.substring(0, 100)); });
      await Promise.race([selfInvoke, new Promise(r => setTimeout(r, SELF_INVOKE_TIMEOUT_MS))]);

      return jsonResponse({
        success: true,
        source_id,
        batch_id: batchId,
        batch_number: batchNumber,
        total_batches: totalBatches,
        dispatched_in_batch: dispatchedInBatch,
        dispatched_total: newDispatched,
        total_count: totalCount,
        handed_off: true,
        next_offset: endIdx,
      });
    }

    // ── Final batch: write completion audit events ──────────────────────
    const durationMs = Date.now() - new Date(startedAt).getTime();
    const suburbNames = suburbIds.map(s => s.name);

    // Legacy event: keep writing `cron_dispatched` so pulse_source_card_stats()
    // (migration 083) and the PulseDataSources "queuing" detector continue to
    // work without schema changes. The new_value.dispatched field must be an
    // int; the migration-083 SQL casts via NULLIF.
    await writeTimeline(
      admin,
      'cron_dispatched',
      `Cron dispatched: ${sourceLabel}`,
      `Fired ${newDispatched} individual suburb scrapes across ${totalBatches} batches (${suburbNames.slice(0, 5).join(', ')}${suburbNames.length > 5 ? '...' : ''})`,
      {
        source_id,
        batch_id: batchId,
        dispatched: newDispatched,
        total_count: totalCount,
        total_batches: totalBatches,
        min_priority,
        max_items: maxItems,
        suburbs: suburbNames,
        skipped: [],
        actor_input: actorInput,
        duration_ms: durationMs,
      },
    );

    // Rich completion event for future UIs that want batch-level stats.
    await writeTimeline(
      admin,
      'cron_dispatch_completed',
      `Cron completed: ${sourceLabel}`,
      `Completed ${newDispatched}/${totalCount} suburbs in ${totalBatches} batches (${Math.round(durationMs / 1000)}s wall-clock)`,
      {
        source_id,
        batch_id: batchId,
        dispatched: newDispatched,
        total_count: totalCount,
        total_batches: totalBatches,
        duration_ms: durationMs,
      },
    );

    try {
      await admin.from('pulse_source_configs').update({ last_run_at: new Date().toISOString() }).eq('source_id', source_id);
    } catch { /* non-fatal */ }

    return jsonResponse({
      success: true,
      source_id,
      batch_id: batchId,
      batch_number: batchNumber,
      total_batches: totalBatches,
      dispatched_in_batch: dispatchedInBatch,
      dispatched_total: newDispatched,
      total_count: totalCount,
      completed: true,
      duration_ms: durationMs,
    });

  } catch (error: any) {
    console.error('pulseFireScrapes error:', error);
    return errorResponse(error.message);
  }
});
