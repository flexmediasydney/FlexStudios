import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Pulse Fire Scrapes — Lightweight cron dispatcher (v2 REA-only)
 *
 * Reads active suburbs from pulse_target_suburbs, then fires INDIVIDUAL
 * net.http_post calls to pulseDataSync for each suburb. Each call is
 * fire-and-forget — no waiting, no timeout cascade.
 *
 * Body params:
 *   source_id: string    — rea_agents, rea_listings, rea_listings_bb_buy/rent/sold
 *   min_priority: number — minimum suburb priority (default 0)
 *   max_suburbs: number  — safety cap (default 20)
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'pulseFireScrapes', _arch: 'rea-only' });
    }

    const {
      source_id,
      min_priority = 0,
      max_suburbs = 20,
    } = body;

    if (!source_id) {
      return errorResponse('source_id is required', 400);
    }

    const now = new Date().toISOString();

    // REA-only source param builders
    const SOURCE_PARAMS: Record<string, (suburb: string) => Record<string, any>> = {
      rea_agents: (s) => ({ suburbs: [s], state: 'NSW', maxAgentsPerSuburb: 30, maxListingsPerSuburb: 0, skipListings: true }),
      rea_listings: (s) => ({ suburbs: [s], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 20, skipListings: false }),
      // Bounding box sources — single call, no suburb iteration
      rea_listings_bb_buy: () => ({ suburbs: [], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 0, skipListings: true, listingsStartUrl: 'https://www.realestate.com.au/buy/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date&sourcePage=rea:buy:srp-map&sourceElement=tab-headers', maxListingsTotal: 500 }),
      rea_listings_bb_rent: () => ({ suburbs: [], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 0, skipListings: true, listingsStartUrl: 'https://www.realestate.com.au/rent/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date&source=refinement', maxListingsTotal: 500 }),
      rea_listings_bb_sold: () => ({ suburbs: [], state: 'NSW', maxAgentsPerSuburb: 0, maxListingsPerSuburb: 0, skipListings: true, listingsStartUrl: 'https://www.realestate.com.au/sold/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&source=refinement', maxListingsTotal: 500 }),
    };

    const paramBuilder = SOURCE_PARAMS[source_id];
    if (!paramBuilder) {
      return errorResponse(`Unknown source_id: ${source_id}. Valid: ${Object.keys(SOURCE_PARAMS).join(', ')}`, 400);
    }

    const SOURCE_LABELS: Record<string, string> = {
      rea_agents: 'REA Agents',
      rea_listings: 'REA Listings',
      rea_listings_bb_buy: 'REA Sales BB',
      rea_listings_bb_rent: 'REA Rentals BB',
      rea_listings_bb_sold: 'REA Sold BB',
    };

    const isBoundingBox = source_id.startsWith('rea_listings_bb');

    if (isBoundingBox) {
      const params = {
        ...paramBuilder(''),
        source_id,
        source_label: `${SOURCE_LABELS[source_id]} (cron)`,
        triggered_by_name: 'Cron',
      };

      fetch(`${SUPABASE_URL}/functions/v1/pulseDataSync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(params),
      }).catch(() => {});

      try {
        await admin.from('pulse_timeline').insert({
          entity_type: 'system', event_type: 'cron_dispatched', event_category: 'system',
          title: `Cron dispatched: ${SOURCE_LABELS[source_id]}`,
          description: `Bounding box scrape fired`,
          source: 'cron',
        });
      } catch { /* non-fatal */ }

      return jsonResponse({ success: true, source_id, dispatched: 1, type: 'bounding_box' });
    }

    // Per-suburb: load suburbs, fire individual calls
    let query = admin.from('pulse_target_suburbs')
      .select('name')
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .limit(max_suburbs);

    if (min_priority > 0) {
      query = query.gte('priority', min_priority);
    }

    const { data: suburbs } = await query;
    if (!suburbs || suburbs.length === 0) {
      return jsonResponse({ success: true, source_id, dispatched: 0, message: 'No active suburbs' });
    }

    let dispatched = 0;
    for (const suburb of suburbs) {
      const params = {
        ...paramBuilder(suburb.name),
        source_id,
        source_label: `${SOURCE_LABELS[source_id]} - ${suburb.name} (cron)`,
        triggered_by_name: 'Cron',
      };

      fetch(`${SUPABASE_URL}/functions/v1/pulseDataSync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(params),
      }).catch(() => {});

      dispatched++;
    }

    try {
      await admin.from('pulse_timeline').insert({
        entity_type: 'system', event_type: 'cron_dispatched', event_category: 'system',
        title: `Cron dispatched: ${SOURCE_LABELS[source_id]}`,
        description: `Fired ${dispatched} individual suburb scrapes (${suburbs.map(s => s.name).slice(0, 5).join(', ')}${suburbs.length > 5 ? '...' : ''})`,
        new_value: { source_id, dispatched, min_priority, suburbs: suburbs.map(s => s.name) },
        source: 'cron',
      });
    } catch { /* non-fatal */ }

    return jsonResponse({ success: true, source_id, dispatched, suburbs: suburbs.length });

  } catch (error: any) {
    console.error('pulseFireScrapes error:', error);
    return errorResponse(error.message);
  }
});
