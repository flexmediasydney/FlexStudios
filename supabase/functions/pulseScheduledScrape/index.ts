import { getAdminClient, createEntities, getUserFromReq, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

/**
 * Pulse Scheduled Scrape — Cron-triggered orchestrator (v3 DB-driven config)
 *
 * Reads source configuration from pulse_source_configs (single source of
 * truth for all Apify input parameters). Reads active suburbs from
 * pulse_target_suburbs (filtered by priority), batches them, and calls
 * pulseDataSync for each batch with the inflated actor_input.
 *
 * Body params:
 *   source_id: string    — must exist in pulse_source_configs
 *   min_priority: number — override config.min_priority (optional)
 *   batch_size: number   — suburbs per batch (default 10)
 *   max_batches: number  — safety limit (default 20 = 200 suburbs max)
 */

/**
 * Expand {suburb} / {suburb-slug} placeholders in every string value of the
 * actor input template. Non-string values pass through unchanged.
 *
 * For batch mode (multiple suburbs in one call), we inflate per-suburb at
 * dispatch time via pulseDataSync — so here we just pass the raw template
 * through when the batch has multiple suburbs, and the downstream function
 * handles per-suburb variation via suburbs[] iteration.
 */
function inflateSuburbTemplate(input: Record<string, any>, suburb: string): Record<string, any> {
  const slug = suburb.toLowerCase().replace(/\s+/g, '-');
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') {
      out[k] = v.replace(/\{suburb\}/g, suburb).replace(/\{suburb-slug\}/g, slug);
    } else {
      out[k] = v;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v3.0', _fn: 'pulseScheduledScrape', _arch: 'db-driven' });
    }

    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const {
      source_id,
      batch_size = 10,
      max_batches = 20,
    } = body;

    if (!source_id) {
      return errorResponse('source_id is required', 400);
    }

    // ── Load config from DB (single source of truth) ─────────────────────
    const { data: config, error: cfgErr } = await admin
      .from('pulse_source_configs')
      .select('source_id, label, actor_slug, actor_input, approach, max_results_per_suburb, max_suburbs, min_priority, is_enabled')
      .eq('source_id', source_id)
      .single();

    if (cfgErr || !config) {
      return errorResponse(`Unknown source_id: ${source_id}. Must exist in pulse_source_configs. ${cfgErr?.message || ''}`, 400);
    }

    if (!config.is_enabled) {
      return errorResponse(`Source ${source_id} is disabled in pulse_source_configs.`, 400);
    }

    const actorInput = (config.actor_input || {}) as Record<string, any>;
    const isBoundingBox = config.approach === 'bounding_box';
    const sourceLabel = config.label || source_id;

    // Body overrides > DB config > defaults
    const min_priority = body.min_priority ?? config.min_priority ?? 0;

    const now = new Date().toISOString();

    // Load active suburbs
    let query = admin.from('pulse_target_suburbs')
      .select('name, state, priority, region')
      .eq('is_active', true)
      .order('priority', { ascending: false });

    if (min_priority > 0) {
      query = query.gte('priority', min_priority);
    }

    const { data: suburbs, error: suburbErr } = await query;
    if (suburbErr) throw new Error(`Failed to load suburbs: ${suburbErr.message}`);
    if (!isBoundingBox && (!suburbs || suburbs.length === 0)) {
      return jsonResponse({ success: true, message: 'No active suburbs found', suburbs: 0 });
    }

    const suburbNames = isBoundingBox ? [] : suburbs!.map(s => s.name);
    console.log(`[pulseScheduledScrape] source=${source_id} priority>=${min_priority} suburbs=${isBoundingBox ? 'bounding-box' : suburbNames.length}`);

    // Log audit trail
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'scheduled_scrape_started',
      event_category: 'system',
      title: `Scheduled scrape: ${sourceLabel}`,
      description: `Auto-run started for ${suburbNames.length} suburbs (priority >= ${min_priority}). Batch size: ${batch_size}.`,
      new_value: { source_id, min_priority, suburb_count: suburbNames.length, batch_size, actor_input: actorInput },
      source: 'cron',
    }).catch(() => {});

    // Batch suburbs
    const batches: string[][] = [];
    if (isBoundingBox) {
      batches.push([]);
    } else {
      for (let i = 0; i < suburbNames.length && batches.length < max_batches; i += batch_size) {
        batches.push(suburbNames.slice(i, i + batch_size));
      }
    }

    let totalAgents = 0, totalAgencies = 0, totalListings = 0, totalMovements = 0, totalMappings = 0;
    let batchesSucceeded = 0, batchesFailed = 0;
    const batchResults: any[] = [];

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      console.log(`[pulseScheduledScrape] batch ${b + 1}/${batches.length}: ${batch.join(', ') || '(bounding-box)'}`);

      // Build params — actorInput is passed verbatim for bounding box,
      // or inflated per-suburb (first suburb as sentinel) for per_suburb.
      // pulseDataSync handles per-suburb inflation internally when suburbs[]
      // has > 1 entry and actorInput contains placeholders.
      const inflatedForBatch = isBoundingBox
        ? actorInput
        : (batch.length === 1 ? inflateSuburbTemplate(actorInput, batch[0]) : actorInput);

      const params = {
        suburbs: batch,
        state: 'NSW',
        source_id,
        source_label: `${sourceLabel} (auto)`,
        triggered_by: null,
        triggered_by_name: 'Scheduled Cron',
        actorInput: inflatedForBatch,
      };

      try {
        const result = await invokeFunction('pulseDataSync', params) as any;
        const d = result || {};
        totalAgents += d.agents_processed ?? d.agents_merged ?? 0;
        totalAgencies += d.agencies_extracted ?? 0;
        totalListings += d.listings_stored ?? 0;
        totalMovements += d.movements_detected ?? 0;
        totalMappings += d.mappings_created ?? 0;
        batchesSucceeded++;

        batchResults.push({
          batch: b + 1,
          suburbs: batch,
          status: 'ok',
          agents: d.agents_processed ?? d.agents_merged ?? 0,
          agencies: d.agencies_extracted ?? 0,
          listings: d.listings_stored ?? 0,
          sync_log_id: d.sync_log_id ?? null,
        });
      } catch (err: any) {
        console.error(`[pulseScheduledScrape] batch ${b + 1} failed:`, err.message);
        // Retry once
        try {
          const retryResult = await invokeFunction('pulseDataSync', params) as any;
          const rd = retryResult || {};
          totalAgents += rd.agents_processed ?? rd.agents_merged ?? 0;
          totalAgencies += rd.agencies_extracted ?? 0;
          totalListings += rd.listings_stored ?? 0;
          totalMovements += rd.movements_detected ?? 0;
          totalMappings += rd.mappings_created ?? 0;
          batchesSucceeded++;
          batchResults.push({
            batch: b + 1,
            suburbs: batch,
            status: 'ok_retry',
            agents: rd.agents_processed ?? rd.agents_merged ?? 0,
            agencies: rd.agencies_extracted ?? 0,
            listings: rd.listings_stored ?? 0,
            sync_log_id: rd.sync_log_id ?? null,
          });
        } catch (retryErr: any) {
          batchesFailed++;
          batchResults.push({
            batch: b + 1,
            suburbs: batch,
            status: 'error',
            error: retryErr.message?.substring(0, 200),
          });
        }
      }
    }

    // Log completion
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'scheduled_scrape_completed',
      event_category: 'system',
      title: `Scheduled scrape completed: ${sourceLabel}`,
      description: `${batchesSucceeded}/${batches.length} batches succeeded. ${totalAgents} agents, ${totalAgencies} agencies, ${totalListings} listings, ${totalMovements} movements, ${totalMappings} mappings.`,
      new_value: {
        source_id, min_priority, suburb_count: suburbNames.length,
        batches_total: batches.length, batches_ok: batchesSucceeded, batches_failed: batchesFailed,
        totals: { agents: totalAgents, agencies: totalAgencies, listings: totalListings, movements: totalMovements, mappings: totalMappings },
      },
      source: 'cron',
    }).catch(() => {});

    // Update source config last_run_at
    await admin.from('pulse_source_configs')
      .update({ last_run_at: now })
      .eq('source_id', source_id)
      .then(() => {}).catch(() => {});

    // Notify admins if failures
    if (batchesFailed > 0) {
      const users = await entities.User.list('-created_date', 200).catch(() => []);
      const admins = (users as any[]).filter((u: any) => u.role === 'master_admin' || u.role === 'admin');
      for (const u of admins) {
        entities.Notification.create({
          user_id: u.id, type: 'pulse_scrape_failed', category: 'system', severity: 'warning',
          title: `Pulse scrape partial failure: ${sourceLabel}`,
          message: `${batchesFailed} of ${batches.length} batches failed. ${batchesSucceeded} succeeded with ${totalAgents} agents, ${totalAgencies} agencies, ${totalListings} listings.`,
          is_read: false, is_dismissed: false, source: 'pulse_cron',
          idempotency_key: `pulse_scrape_fail:${source_id}:${now.substring(0, 13)}`,
          created_date: now,
        }).catch(() => {});
      }
    }

    return jsonResponse({
      success: true,
      source_id,
      min_priority,
      suburbs: suburbNames.length,
      batches: batches.length,
      batches_succeeded: batchesSucceeded,
      batches_failed: batchesFailed,
      totals: { agents: totalAgents, agencies: totalAgencies, listings: totalListings, movements: totalMovements, mappings: totalMappings },
      batch_results: batchResults,
    });

  } catch (error: any) {
    console.error('pulseScheduledScrape error:', error);
    return errorResponse(error.message);
  }
});
