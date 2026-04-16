import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

/**
 * Pulse Scheduled Scrape — Cron-triggered orchestrator (v2 REA-only)
 *
 * Reads active suburbs from pulse_target_suburbs (filtered by priority tier),
 * batches them, and calls pulseDataSync for each batch.
 *
 * Body params:
 *   source_id: string    — rea_agents, rea_listings, rea_listings_bb_buy/rent/sold
 *   min_priority: number — minimum suburb priority to include (default 0 = all)
 *   batch_size: number   — suburbs per batch (default 10)
 *   max_batches: number  — safety limit (default 20 = 200 suburbs max)
 */

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'pulseScheduledScrape', _arch: 'rea-only' });
    }

    const {
      source_id,
      min_priority = 0,
      batch_size = 10,
      max_batches = 20,
    } = body;

    if (!source_id) {
      return errorResponse('source_id is required (rea_agents, rea_listings, rea_listings_bb_buy/rent/sold)', 400);
    }

    const now = new Date().toISOString();

    // Load active suburbs
    let query = admin.from('pulse_target_suburbs')
      .select('name, state, priority, region')
      .eq('is_active', true)
      .order('priority', { ascending: false });

    if (min_priority > 0) {
      query = query.gte('priority', min_priority);
    }

    const isBoundingBox = source_id.startsWith('rea_listings_bb');

    const { data: suburbs, error: suburbErr } = await query;
    if (suburbErr) throw new Error(`Failed to load suburbs: ${suburbErr.message}`);
    if (!isBoundingBox && (!suburbs || suburbs.length === 0)) {
      return jsonResponse({ success: true, message: 'No active suburbs found', suburbs: 0 });
    }

    const suburbNames = isBoundingBox ? [] : suburbs!.map(s => s.name);
    console.log(`[pulseScheduledScrape] source=${source_id} priority>=${min_priority} suburbs=${isBoundingBox ? 'bounding-box' : suburbNames.length}`);

    // REA-only source param builders
    const SOURCE_PARAMS: Record<string, (subs: string[]) => Record<string, any>> = {
      rea_agents: (subs) => ({ suburbs: subs, state: 'NSW', maxAgentsPerSuburb: 30, maxListingsPerSuburb: 0, skipListings: true }),
      rea_listings: (subs) => ({ suburbs: subs, state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 20, skipListings: false }),
      rea_listings_bb_buy: () => ({ suburbs: [], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 0, skipListings: true, listingsStartUrl: 'https://www.realestate.com.au/buy/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date&sourcePage=rea:buy:srp-map&sourceElement=tab-headers', maxListingsTotal: 500 }),
      rea_listings_bb_rent: () => ({ suburbs: [], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 0, skipListings: true, listingsStartUrl: 'https://www.realestate.com.au/rent/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date&source=refinement', maxListingsTotal: 500 }),
      rea_listings_bb_sold: () => ({ suburbs: [], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 0, skipListings: true, listingsStartUrl: 'https://www.realestate.com.au/sold/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&source=refinement', maxListingsTotal: 500 }),
    };

    const paramBuilder = SOURCE_PARAMS[source_id];
    if (!paramBuilder) {
      return errorResponse(`Unknown source_id: ${source_id}. Valid: ${Object.keys(SOURCE_PARAMS).join(', ')}`, 400);
    }

    const SOURCE_LABELS: Record<string, string> = {
      rea_agents: 'REA Agent Intelligence',
      rea_listings: 'REA Listings Market Data',
      rea_listings_bb_buy: 'REA New Sales (Greater Sydney)',
      rea_listings_bb_rent: 'REA New Rentals (Greater Sydney)',
      rea_listings_bb_sold: 'REA Recently Sold (Greater Sydney)',
    };

    // Log audit trail
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'scheduled_scrape_started',
      event_category: 'system',
      title: `Scheduled scrape: ${SOURCE_LABELS[source_id]}`,
      description: `Auto-run started for ${suburbNames.length} suburbs (priority >= ${min_priority}). Batch size: ${batch_size}.`,
      new_value: { source_id, min_priority, suburb_count: suburbNames.length, batch_size },
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
      console.log(`[pulseScheduledScrape] batch ${b + 1}/${batches.length}: ${batch.join(', ')}`);

      try {
        const params = {
          ...paramBuilder(batch),
          source_id,
          source_label: `${SOURCE_LABELS[source_id]} (auto)`,
          triggered_by: null,
          triggered_by_name: 'Scheduled Cron',
        };

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
      title: `Scheduled scrape completed: ${SOURCE_LABELS[source_id]}`,
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
          title: `Pulse scrape partial failure: ${SOURCE_LABELS[source_id]}`,
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
