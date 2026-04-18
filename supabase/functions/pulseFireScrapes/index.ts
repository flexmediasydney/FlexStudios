import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * pulseFireScrapes — Queue-based orchestrator (v5 durable-queue rewrite)
 *
 * ── Architecture ───────────────────────────────────────────────────────────
 * This function is now pure ENQUEUE. It loads the source config, inflates the
 * Apify `actor_input` template for each eligible suburb, and inserts one row
 * per suburb into `pulse_fire_queue`. It does NOT dispatch to pulseDataSync.
 *
 * Dispatch is owned by `pulseFireWorker`, which pg_cron fires every minute.
 * The worker claims eligible queue rows via `pulse_fire_queue_claim_next()`
 * (SKIP LOCKED), respects per-source stagger + circuit breakers, fires
 * pulseDataSync, and relies on pulseDataSync's `fire_queue_id` callback to
 * record the outcome (via `pulse_fire_queue_record_outcome()`).
 *
 * ── Why we replaced the chained self-invocation ───────────────────────────
 * The previous design (v4) had pulseFireScrapes process batches of 20 suburbs
 * then fire-and-forget POST to itself to continue. A 3-second handshake budget
 * governed whether the handoff landed. Under concurrent load (multiple source
 * crons overlapping, edge router cold-starts) the handoff silently dropped
 * ~30% of the time, leaving chains dead and suburbs unsynced until the next
 * day. See migration 093 header for the full forensic writeup.
 *
 * The queue design fixes this because:
 *   - No chain to break. Each worker tick is independent.
 *   - Durable state: a row in pulse_fire_queue survives every failure mode.
 *   - Reconciler: items stuck in 'running' get re-queued after 5 min.
 *   - Retry: 3 attempts with exponential backoff, then dead-letter.
 *   - Circuit breaker: 5 consecutive source failures → pause source for 30 min.
 *
 * ── Body params ────────────────────────────────────────────────────────────
 *   source_id:         string — must exist in pulse_source_configs
 *   min_priority:      number — override config.min_priority (optional)
 *   max_suburbs:       number — override config.max_suburbs (optional safety cap)
 *   suburbs:           string[] — explicit override (tests / manual single-suburb runs)
 *   triggered_by_name: string — audit label ("Cron", "User Click", etc.)
 */

serveWithAudit('pulseFireScrapes', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v5.0', _fn: 'pulseFireScrapes', _arch: 'durable-queue' });
    }

    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const { source_id } = body;
    if (!source_id) {
      return errorResponse('source_id is required', 400);
    }

    // ── Load source config (single source of truth) ─────────────────────────
    const { data: config, error: cfgErr } = await admin
      .from('pulse_source_configs')
      .select('source_id, label, actor_slug, actor_input, approach, max_results_per_suburb, max_suburbs, min_priority, is_enabled')
      .eq('source_id', source_id)
      .single();

    if (cfgErr || !config) {
      return errorResponse(`Unknown source_id: ${source_id}. ${cfgErr?.message || ''}`, 400);
    }

    if (!config.is_enabled) {
      return errorResponse(`Source ${source_id} is disabled in pulse_source_configs.`, 400);
    }

    if (config.approach === 'bounding_box') {
      return errorResponse(
        `Source ${source_id} has approach='bounding_box' which is no longer supported. `
        + `Set approach='per_suburb' in pulse_source_configs.`,
        400,
      );
    }

    // ── Circuit breaker check ──────────────────────────────────────────────
    // If the source is tripped, reject enqueues until reopen_at passes.
    // (Manual "Run Now" also honors the breaker; user sees a clear error.)
    const { data: breaker } = await admin
      .from('pulse_source_circuit_breakers')
      .select('state, consecutive_failures, reopen_at')
      .eq('source_id', source_id)
      .maybeSingle();

    if (breaker?.state === 'open' && breaker.reopen_at && new Date(breaker.reopen_at) > new Date()) {
      const reopenMins = Math.round((new Date(breaker.reopen_at).getTime() - Date.now()) / 60000);
      return errorResponse(
        `Circuit breaker open for ${source_id} (${breaker.consecutive_failures} consecutive failures). `
        + `Reopens in ${reopenMins}min. Manually reset: UPDATE pulse_source_circuit_breakers SET state='closed', consecutive_failures=0 WHERE source_id='${source_id}'`,
        423,  // Locked
      );
    }

    // ── Body overrides > DB config > defaults ──────────────────────────────
    const actorInput = (config.actor_input || {}) as Record<string, any>;
    const sourceLabel = config.label || source_id;
    const min_priority: number = body.min_priority ?? config.min_priority ?? 0;
    const max_suburbs: number = body.max_suburbs ?? config.max_suburbs ?? 200;
    const triggered_by_name = body.triggered_by_name || 'Manual';
    const maxItems = config.max_results_per_suburb ?? actorInput.maxItems ?? 10;

    // ── Load eligible suburbs ──────────────────────────────────────────────
    let suburbs: Array<{ name: string; postcode: string | null; priority: number }>;
    if (Array.isArray(body.suburbs) && body.suburbs.length > 0) {
      // Explicit override (used by manual single-suburb dispatches + tests)
      const { data: rows } = await admin.from('pulse_target_suburbs')
        .select('name, postcode, priority')
        .in('name', body.suburbs)
        .eq('is_active', true);
      suburbs = (rows || []) as any;
    } else {
      let q = admin.from('pulse_target_suburbs')
        .select('name, postcode, priority')
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .limit(max_suburbs);
      if (min_priority > 0) q = q.gte('priority', min_priority);
      const { data: rows } = await q;
      suburbs = (rows || []) as any;
    }

    if (suburbs.length === 0) {
      await admin.from('pulse_timeline').insert({
        entity_type: 'system',
        event_type: 'cron_dispatched',
        event_category: 'system',
        title: `Cron dispatched: ${sourceLabel}`,
        description: 'No eligible suburbs matched filters',
        new_value: { source_id, dispatched: 0, min_priority, max_items: maxItems, enqueued: 0 },
        source: 'cron',
      }).catch(() => {});
      return jsonResponse({ success: true, source_id, enqueued: 0, message: 'No eligible suburbs' });
    }

    // ── Postcode eligibility filter ────────────────────────────────────────
    // Per-suburb URLs require postcode — REA silently redirects without one.
    const actorInputUsesPostcode = JSON.stringify(actorInput).includes('{postcode}');
    const skipped: string[] = [];
    const eligible = suburbs.filter(s => {
      if (actorInputUsesPostcode && !s.postcode) {
        skipped.push(s.name);
        return false;
      }
      return true;
    });

    if (eligible.length === 0) {
      await admin.from('pulse_timeline').insert({
        entity_type: 'system',
        event_type: 'cron_dispatched',
        event_category: 'system',
        title: `Cron dispatched: ${sourceLabel}`,
        description: `All ${suburbs.length} suburbs skipped (missing postcode)`,
        new_value: { source_id, dispatched: 0, enqueued: 0, skipped },
        source: 'cron',
      }).catch(() => {});
      return jsonResponse({ success: true, source_id, enqueued: 0, skipped: skipped.length });
    }

    // ── Create batch row (cohort metadata) ─────────────────────────────────
    // Still uses pulse_fire_batches so the UI can render "X / Y dispatched"
    // from one place. dispatched_count is updated by the worker + reconciler.
    const suburbIds = eligible.map(s => ({ name: s.name, postcode: s.postcode || null }));
    const { data: batch, error: batchErr } = await admin
      .from('pulse_fire_batches')
      .insert({
        source_id,
        suburb_ids: suburbIds,
        total_count: eligible.length,
        dispatched_count: 0,
        current_offset: 0,
        batch_size: 1,   // queue-based: no batch-size concept anymore; kept for schema compat
        status: 'running',
      })
      .select('id, started_at')
      .single();

    if (batchErr || !batch) {
      return errorResponse(`Failed to create fire batch: ${batchErr?.message}`, 500);
    }

    // ── Enqueue: one row per suburb ────────────────────────────────────────
    const queueRows = eligible.map(s => {
      // Inflate the actor_input template for this specific suburb
      const slug = s.name.toLowerCase().replace(/\s+/g, '-');
      const inflated: Record<string, any> = {};
      for (const [k, v] of Object.entries(actorInput)) {
        if (typeof v === 'string') {
          inflated[k] = v
            .replace(/\{suburb\}/g, s.name)
            .replace(/\{suburb-slug\}/g, slug)
            .replace(/\{postcode\}/g, s.postcode || '');
        } else {
          inflated[k] = v;
        }
      }
      // Force maxItems from config (template might have its own default)
      inflated.maxItems = maxItems;

      return {
        batch_id: batch.id,
        source_id,
        suburb_name: s.name,
        postcode: s.postcode,
        priority: s.priority || 0,
        actor_input: inflated,
        status: 'pending',
        triggered_by_name,
      };
    });

    // Batch insert in chunks of 100 to keep payloads reasonable
    const CHUNK = 100;
    for (let i = 0; i < queueRows.length; i += CHUNK) {
      const { error } = await admin.from('pulse_fire_queue').insert(queueRows.slice(i, i + CHUNK));
      if (error) {
        console.error(`[pulseFireScrapes] enqueue chunk ${i / CHUNK} failed: ${error.message}`);
        // Best-effort: mark batch failed if nothing got in
        if (i === 0) {
          await admin.from('pulse_fire_batches')
            .update({ status: 'failed', error_message: error.message, completed_at: new Date().toISOString() })
            .eq('id', batch.id);
          return errorResponse(`Enqueue failed: ${error.message}`, 500);
        }
      }
    }

    // ── Audit event (kept as 'cron_dispatched' so pulse_source_card_stats()
    // in migration 083 keeps working without schema changes) ─────────────
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'cron_dispatched',
      event_category: 'system',
      title: `Cron dispatched: ${sourceLabel}`,
      description: `Enqueued ${eligible.length} suburb${eligible.length === 1 ? '' : 's'} for ${sourceLabel}${skipped.length ? ` (${skipped.length} skipped missing postcode)` : ''}`,
      new_value: {
        source_id,
        batch_id: batch.id,
        dispatched: eligible.length,  // keeps legacy field name for migration-083 SQL
        enqueued: eligible.length,
        total_count: eligible.length,
        min_priority,
        max_items: maxItems,
        skipped,
        suburbs: eligible.map(s => s.name),
        actor_input: actorInput,
      },
      source: 'cron',
    }).catch(() => {});

    // Update source config last_run_at
    await admin.from('pulse_source_configs')
      .update({ last_run_at: new Date().toISOString() })
      .eq('source_id', source_id)
      .then(() => {}).catch(() => {});

    return jsonResponse({
      success: true,
      source_id,
      batch_id: batch.id,
      enqueued: eligible.length,
      dispatched: eligible.length,  // legacy alias for UI compatibility
      skipped: skipped.length,
      total_count: eligible.length,
      message: `${eligible.length} suburb${eligible.length === 1 ? '' : 's'} enqueued. Worker will drain at ~1 per minute with per-source stagger.`,
    });

  } catch (error: any) {
    console.error('pulseFireScrapes error:', error);
    return errorResponse(error.message);
  }
});
