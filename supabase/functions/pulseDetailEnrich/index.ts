/**
 * pulseDetailEnrich — the second enrichment layer for Industry Pulse.
 *
 * The list layer (pulseDataSync → azzouzana bounding-box scrape) tells us
 * "this listing exists in Alexandria". This function is the detail layer:
 * it hits the memo23/realestate-au-listings Apify actor with each listing's
 * source_url and extracts fields the list endpoint never returns:
 *
 *   - Exact dates: listing.dateSold.value, listing.auctionTime.startTime,
 *     listing.dateAvailable.date, full inspectionsAndAuctions[] array
 *   - Direct agent contact: listing.lister.email, .mobilePhoneNumber, .id
 *   - Direct agency contact: listing.agency.{email, phoneNumber, website,
 *     address.streetAddress, brandingColors.primary}
 *   - Rich media: floorplans (images[].name=='floorplan'), video
 *     (images[0].video=true → YouTube URL), photos
 *   - Structural: listing.landSize.{value, unit}, propertyTypeDisplay
 *   - Withdrawn detection: input URL returning zero items → listing gone
 *
 * Candidate selection: listings where detail_enriched_at IS NULL OR
 * detail_enriched_at < last_synced_at - 14 days. Capped at max_listings
 * (default 500, hard cap 1000). Priority modes support audit-heavy runs.
 *
 * Cost model (per Apr 2026 pricing):
 *   - Actor start event: $0.007
 *   - Dataset item result: $0.001
 *   - Daily 500-listing cron = $0.01 (run start) × 10 batches + $0.001 × 500
 *     = $0.07 + $0.50 = ~$0.57/day = ~$17/month steady state.
 *
 * Batch size: 50 URLs per Apify run (memo23 handles ~50/80s reliably). The
 * edge function wall-clock cap is ~150s, so we issue batches SEQUENTIALLY
 * with waitForFinish=95s per batch, spilling excess to the next cron run
 * when we approach the wall budget.
 *
 * Circuit breaker: we read/write pulse_source_circuit_breakers directly
 * (we''re not in the pulse_fire_queue worker loop). If we open the breaker,
 * we abort and the next cron run will respect cooloff.
 */

import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { cleanEmailList, isMiddlemanEmail, pickPrimaryEmail } from '../_shared/emailCleanup.ts';

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR_SLUG = 'memo23/realestate-au-listings';
const SOURCE_ID = 'rea_detail_enrich';

// Apify wait / batch knobs
// memo23 runs ~5s per URL against REA through its residential proxy. We want
// every batch to complete within the waitForFinish window (no polling), so
// BATCH_SIZE × 5s < APIFY_WAIT_SECS. 15 URLs × 5s = 75s << 85s window.
// Edge function wall-clock cap is 150s; we can fit 1 batch comfortably.
// Cron calls this repeatedly for larger backfills.
const APIFY_WAIT_SECS = 55;  // tight window; memo23 typically finishes in 30-50s for 15 URLs
const BATCH_SIZE = 15;
const MAX_BATCHES_PER_INVOCATION = 2;  // 2 × 55s = 110s, fits under 150s wall-clock

// Confidence source labels (must match pulse_source_confidence() in 104)
const SRC_LISTER  = 'detail_page_lister';
const SRC_AGENCY  = 'detail_page_agency';

// ── Helpers ─────────────────────────────────────────────────────────────

function parseAuctionDatetime(auctionTime: any): string | null {
  // listing.auctionTime.startTime = '2026-05-02T14:30:00' (local time, no TZ)
  // Treat as AEST (UTC+10/+11); REA listings are AU-local. Emit ISO UTC.
  if (!auctionTime?.startTime) return null;
  const raw = String(auctionTime.startTime).trim();
  // If already has timezone, return as-is
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw).toISOString();
  // Assume local = Sydney; append +10:00 as a best approximation
  // (DST handling is imperfect but only matters ±1h, acceptable for this use case)
  try {
    const withTz = raw + '+10:00';
    const d = new Date(withTz);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch { return null; }
}

function parseSoldDate(dateSold: any): string | null {
  // listing.dateSold = {display: '27 Mar 2026', value: '2026-03-27'}
  if (!dateSold) return null;
  const v = dateSold.value || dateSold.display;
  if (!v) return null;
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function parseDateAvailable(dateAvailable: any): string | null {
  // listing.dateAvailable = {date: '22 Apr 2026', dateDisplay: '22 Apr 2026'}
  if (!dateAvailable) return null;
  const v = dateAvailable.date || dateAvailable.dateDisplay;
  if (!v) return null;
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function parseLandSizeSqm(landSize: any): number | null {
  if (!landSize) return null;
  const unit = String(landSize.unit || '').toLowerCase();
  const v = Number(landSize.value);
  if (!v || v <= 0) return null;
  if (unit === 'm2' || unit === 'm²' || unit === 'sqm') return v;
  if (unit === 'ha' || unit === 'hectare' || unit === 'hectares') return v * 10_000;
  return null;
}

function extractMediaItems(images: any[]): {
  floorplans: string[];
  videoUrl: string | null;
  videoThumb: string | null;
  mediaItems: Array<{ type: string; url: string; thumb?: string; order_index: number }>;
} {
  const floorplans: string[] = [];
  let videoUrl: string | null = null;
  let videoThumb: string | null = null;
  const mediaItems: Array<{ type: string; url: string; thumb?: string; order_index: number }> = [];

  if (!Array.isArray(images)) return { floorplans, videoUrl, videoThumb, mediaItems };

  images.forEach((img: any, idx: number) => {
    if (!img || typeof img !== 'object') return;
    const name = String(img.name || '').toLowerCase();
    const server = String(img.server || '');
    const uri = String(img.uri || '');

    if (img.video === true || name === 'video' || server.includes('youtube.com')) {
      // Video entry
      if (img.id && !videoUrl) {
        videoUrl = `https://www.youtube.com/watch?v=${img.id}`;
        videoThumb = `${server}${uri}`;
      }
      mediaItems.push({ type: 'video', url: videoUrl || `${server}${uri}`, thumb: `${server}${uri}`, order_index: idx });
    } else if (name === 'floorplan') {
      const full = `${server}${uri}`;
      floorplans.push(full);
      mediaItems.push({ type: 'floorplan', url: full, order_index: idx });
    } else if (name === 'photo' || name === 'main photo') {
      const full = `${server}${uri}`;
      mediaItems.push({ type: 'photo', url: full, order_index: idx });
    } else if (uri) {
      mediaItems.push({ type: name || 'photo', url: `${server}${uri}`, order_index: idx });
    }
  });

  return { floorplans, videoUrl, videoThumb, mediaItems };
}

// ── Apify run helper ────────────────────────────────────────────────────

async function runMemo23Batch(urls: string[], label: string): Promise<{
  ok: boolean;
  status: string;
  runId?: string;
  datasetId?: string;
  stats?: any;
  items: any[];
  error?: string;
}> {
  if (!APIFY_TOKEN) return { ok: false, status: 'NO_TOKEN', items: [], error: 'APIFY_TOKEN not set' };
  if (urls.length === 0) return { ok: true, status: 'SKIPPED_EMPTY', items: [] };

  const safeSlug = ACTOR_SLUG.replace('/', '~');
  const submitUrl = `${APIFY_BASE}/acts/${safeSlug}/runs?timeout=${APIFY_WAIT_SECS}&waitForFinish=${APIFY_WAIT_SECS}`;
  const input = {
    startUrls: urls,
    maxItems: urls.length + 5, // small slack
    flattenOutput: true,
  };

  const resp = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${APIFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { ok: false, status: `HTTP_${resp.status}`, items: [], error: `Apify ${label} submit ${resp.status}: ${txt.substring(0, 300)}` };
  }

  const runData = await resp.json();
  const status = runData?.data?.status;
  const runId = runData?.data?.id;
  const datasetId = runData?.data?.defaultDatasetId;
  const stats = runData?.data?.stats;

  if (status !== 'SUCCEEDED') {
    return { ok: false, status, runId, datasetId, stats, items: [], error: `Apify status=${status}` };
  }

  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=${urls.length + 10}`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = itemsResp.ok ? await itemsResp.json() : [];
  return { ok: true, status, runId, datasetId, stats, items: Array.isArray(items) ? items : [] };
}

// ── Circuit breaker helpers ─────────────────────────────────────────────

async function breakerGetState(admin: any): Promise<{ state: string; consecutiveFailures: number; openedAt: string | null; reopenAt: string | null }> {
  const { data } = await admin.from('pulse_source_circuit_breakers')
    .select('state, consecutive_failures, opened_at, reopen_at')
    .eq('source_id', SOURCE_ID)
    .maybeSingle();
  return {
    state: data?.state || 'closed',
    consecutiveFailures: data?.consecutive_failures || 0,
    openedAt: data?.opened_at || null,
    reopenAt: data?.reopen_at || null,
  };
}

async function breakerRecordSuccess(admin: any) {
  await admin.from('pulse_source_circuit_breakers').upsert({
    source_id: SOURCE_ID,
    state: 'closed',
    consecutive_failures: 0,
    opened_at: null,
    reopen_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'source_id' });
}

async function breakerRecordFailure(admin: any) {
  const { data: cur } = await admin.from('pulse_source_circuit_breakers')
    .select('consecutive_failures, failure_threshold, cooldown_minutes, total_opens').eq('source_id', SOURCE_ID).maybeSingle();
  const fails = (cur?.consecutive_failures || 0) + 1;
  const threshold = cur?.failure_threshold || 3;
  const cooldownMins = cur?.cooldown_minutes || 30;
  const shouldOpen = fails >= threshold;
  const now = new Date();
  const reopenAt = shouldOpen ? new Date(now.getTime() + cooldownMins * 60 * 1000) : null;
  await admin.from('pulse_source_circuit_breakers').upsert({
    source_id: SOURCE_ID,
    state: shouldOpen ? 'open' : 'closed',
    consecutive_failures: fails,
    ...(shouldOpen ? {
      opened_at: now.toISOString(),
      reopen_at: reopenAt!.toISOString(),
      total_opens: (cur?.total_opens || 0) + 1,
    } : {}),
    updated_at: now.toISOString(),
  }, { onConflict: 'source_id' });
}

// ── Timeline emission (idempotent via idempotency_key) ──────────────────

async function emitTimeline(admin: any, events: any[]) {
  if (events.length === 0) return;
  // Best-effort insert; duplicate idempotency_keys are caught by unique constraint
  const { error } = await admin.from('pulse_timeline').insert(events);
  if (error && !String(error.message || '').includes('duplicate')) {
    console.warn('emitTimeline error (non-fatal):', error.message);
  }
}

// ── Main handler ────────────────────────────────────────────────────────

serveWithAudit('pulseDetailEnrich', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401);
    if (user.role !== 'master_admin') return errorResponse('Forbidden', 403);
  }

  const admin = getAdminClient();
  const startedAt = Date.now();
  const WALL_BUDGET_MS = 140_000; // leave headroom

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const trigger = String(body.trigger || 'manual');
  const priorityMode = String(body.priority_mode || 'auto');
  const maxListings = Math.max(1, Math.min(1000, Number(body.max_listings) || 500));
  const forceIds = Array.isArray(body.force_ids) ? body.force_ids : [];
  const dryRun = body.dry_run === true;

  // ── Circuit breaker check ─────────────────────────────────────────────
  const breaker = await breakerGetState(admin);
  if (breaker.state === 'open') {
    const reopenAt = breaker.reopenAt ? new Date(breaker.reopenAt).getTime() : 0;
    if (reopenAt > Date.now()) {
      return jsonResponse({
        skipped: true,
        reason: 'circuit_breaker_open',
        consecutive_failures: breaker.consecutiveFailures,
        reopen_at: breaker.reopenAt,
      });
    }
    // Otherwise fall through in half-open state; success will close it
  }

  // ── Open a sync_log row ───────────────────────────────────────────────
  const { data: syncLog, error: syncLogErr } = await admin.from('pulse_sync_logs').insert({
    sync_type: 'pulse_detail_enrich',   // NOT NULL
    source_id: SOURCE_ID,
    status: 'running',
    triggered_by: trigger,
    triggered_by_name: `pulseDetailEnrich:${trigger}:${priorityMode}`,
    started_at: new Date().toISOString(),
  }).select('id').single();
  if (syncLogErr) return errorResponse(`Failed to create sync_log: ${syncLogErr.message}`, 500);
  const syncLogId = syncLog!.id;

  try {
    // ── Candidate selection ──────────────────────────────────────────────
    let candidates: any[] = [];
    if (forceIds.length > 0) {
      const { data } = await admin
        .from('pulse_listings')
        .select('id, source_listing_id, source_url, listing_type, sold_date, price_text, last_synced_at, detail_enriched_at')
        .in('id', forceIds);
      candidates = data || [];
    } else {
      // Main path: pick stalest / priority targets
      let query = admin
        .from('pulse_listings')
        .select('id, source_listing_id, source_url, listing_type, sold_date, price_text, last_synced_at, detail_enriched_at')
        .eq('source', 'rea')
        .not('source_url', 'is', null)
        .limit(maxListings);

      if (priorityMode === 'sold_first') {
        // Sold listings with no sold_date captured yet — audit-highest-value
        query = query.eq('listing_type', 'sold').is('sold_date', null).order('last_synced_at', { ascending: false });
      } else if (priorityMode === 'auction_first') {
        // Active listings with 'auction' in price_text but no auction_date
        query = query.in('listing_type', ['for_sale', 'under_contract']).ilike('price_text', '%auction%').order('last_synced_at', { ascending: false });
      } else {
        // auto: stalest or never-enriched first
        query = query.or('detail_enriched_at.is.null,detail_enriched_at.lt.' + new Date(Date.now() - 14 * 86400 * 1000).toISOString())
          .order('detail_enriched_at', { ascending: true, nullsFirst: true })
          .order('last_synced_at', { ascending: false });
      }

      const { data } = await query;
      candidates = data || [];
    }

    // Filter: require source_url
    candidates = candidates.filter(c => c.source_url && c.source_url.includes('realestate.com.au'));

    if (candidates.length === 0) {
      await admin.from('pulse_sync_logs').update({
        status: 'ok', completed_at: new Date().toISOString(),
        records_fetched: 0, records_processed: 0,
        message: 'No candidates needing enrichment',
      }).eq('id', syncLogId);
      return jsonResponse({ ok: true, syncLogId, candidates: 0, message: 'No candidates needing enrichment' });
    }

    if (dryRun) {
      await admin.from('pulse_sync_logs').update({
        status: 'ok', completed_at: new Date().toISOString(),
        records_fetched: candidates.length,
        message: `DRY RUN: would enrich ${candidates.length} listings`,
      }).eq('id', syncLogId);
      return jsonResponse({ ok: true, dryRun: true, candidates: candidates.length, sample_ids: candidates.slice(0, 10).map(c => c.source_listing_id) });
    }

    // ── Process in batches ────────────────────────────────────────────────
    const stats = {
      candidates: candidates.length,
      batches_attempted: 0,
      batches_succeeded: 0,
      items_returned: 0,
      items_processed: 0,
      items_withdrawn: 0,
      agent_primary_promoted: 0,
      agent_alt_added: 0,
      agency_primary_promoted: 0,
      agency_alt_added: 0,
      integrity_scores_bumped: 0,
      errors: [] as string[],
      batches_skipped_wall: 0,
      apify_run_ids: [] as string[],
      cost_estimate_usd: 0,
    };

    for (let bIdx = 0; bIdx < candidates.length; bIdx += BATCH_SIZE) {
      if (stats.batches_attempted >= MAX_BATCHES_PER_INVOCATION) {
        stats.batches_skipped_wall++;
        break;
      }
      if (Date.now() - startedAt > WALL_BUDGET_MS) {
        stats.batches_skipped_wall++;
        break;
      }

      const batch = candidates.slice(bIdx, bIdx + BATCH_SIZE);
      const urls = batch.map(c => c.source_url);
      stats.batches_attempted++;

      const batchLabel = `batch_${bIdx / BATCH_SIZE}`;
      const result = await runMemo23Batch(urls, batchLabel);
      if (result.runId) stats.apify_run_ids.push(result.runId);
      stats.cost_estimate_usd += 0.007; // run start
      if (!result.ok) {
        stats.errors.push(`${batchLabel}: ${result.error || result.status}`);
        continue;
      }
      stats.batches_succeeded++;
      stats.items_returned += result.items.length;
      stats.cost_estimate_usd += 0.001 * result.items.length;

      // Index items by source_listing_id for O(1) match against candidates
      const itemsById = new Map<string, any>();
      for (const it of result.items) {
        const id = it.listingId ? String(it.listingId) : null;
        if (id) itemsById.set(id, it);
      }

      const timelineEvents: any[] = [];
      const historyRows: any[] = [];
      const now = new Date();

      for (const cand of batch) {
        const item = itemsById.get(String(cand.source_listing_id));
        if (!item) {
          // Withdrawn: was in our DB as active, memo23 returned no item for its URL
          if (['for_sale', 'for_rent', 'under_contract'].includes(cand.listing_type)) {
            await admin.from('pulse_listings').update({
              listing_withdrawn_at: now.toISOString(),
              listing_withdrawn_reason: 'absent_from_rea',
              detail_enriched_at: now.toISOString(),
              detail_enrich_count: 1, // first time we noticed
              last_sync_log_id: syncLogId,
            }).eq('id', cand.id);
            stats.items_withdrawn++;
            timelineEvents.push({
              entity_type: 'listing',
              pulse_entity_id: cand.id,
              event_type: 'listing_withdrawn',
              event_category: 'market',
              title: `Listing withdrawn from REA`,
              description: `Detail enrich returned 0 items for this URL — listing has been removed from realestate.com.au (not moved to sold).`,
              source: SOURCE_ID,
              idempotency_key: `withdrawn:${cand.source_listing_id}`,
            });
            historyRows.push({
              entity_type: 'listing', entity_id: cand.id, entity_key: cand.source_listing_id,
              sync_log_id: syncLogId, action: 'withdrawn_detected',
              changes_summary: { reason: 'absent_from_rea' },
              source: SOURCE_ID,
            });
          }
          continue;
        }

        // ── Extract listing fields ───────────────────────────────────────
        const listing = item.listing || item;
        const auctionTimeIso = parseAuctionDatetime(listing.auctionTime);
        const soldDateIso = parseSoldDate(listing.dateSold);
        const dateAvailable = parseDateAvailable(listing.dateAvailable);
        const landSizeSqm = parseLandSizeSqm(listing.landSize);
        const { floorplans, videoUrl, videoThumb, mediaItems } = extractMediaItems(listing.images);

        const listingUpdates: Record<string, any> = {
          detail_enriched_at: now.toISOString(),
          detail_enrich_count: (cand.detail_enrich_count || 0) + 1,
          last_sync_log_id: syncLogId,
        };
        if (auctionTimeIso) listingUpdates.auction_date = auctionTimeIso; // will work once 108 runs
        if (soldDateIso) listingUpdates.sold_date = soldDateIso;
        if (dateAvailable) listingUpdates.date_available = dateAvailable;
        if (landSizeSqm) listingUpdates.land_size_sqm = landSizeSqm;
        if (floorplans.length > 0) listingUpdates.floorplan_urls = floorplans;
        if (videoUrl) listingUpdates.video_url = videoUrl;
        if (videoThumb) listingUpdates.video_thumb_url = videoThumb;
        if (mediaItems.length > 0) listingUpdates.media_items = mediaItems;

        // DO NOT overwrite address/suburb/postcode/source_url (property_key is generated from address).
        await admin.from('pulse_listings').update(listingUpdates).eq('id', cand.id);
        stats.items_processed++;

        // Timeline events for new data discovered
        const prevEnrichedAt = cand.detail_enriched_at;
        if (soldDateIso && !cand.sold_date) {
          timelineEvents.push({
            entity_type: 'listing', pulse_entity_id: cand.id, event_type: 'sold_date_captured',
            event_category: 'market', title: `Sold date captured: ${soldDateIso}`,
            description: `Detail enrich found dateSold.value=${soldDateIso} (was NULL). Exact sold date now available.`,
            new_value: { sold_date: soldDateIso }, source: SOURCE_ID,
            idempotency_key: `sold_date_captured:${cand.source_listing_id}`,
          });
        }
        if (auctionTimeIso) {
          timelineEvents.push({
            entity_type: 'listing', pulse_entity_id: cand.id, event_type: 'listing_auction_scheduled',
            event_category: 'market', title: `Auction scheduled`,
            description: `listing.auctionTime.startTime = ${auctionTimeIso}`,
            new_value: { auction_date: auctionTimeIso }, source: SOURCE_ID,
            idempotency_key: `auction_scheduled:${cand.source_listing_id}:${auctionTimeIso.slice(0, 10)}`,
          });
        }
        if (floorplans.length > 0 && !prevEnrichedAt) {
          timelineEvents.push({
            entity_type: 'listing', pulse_entity_id: cand.id, event_type: 'listing_floorplan_added',
            event_category: 'media', title: `Floorplan${floorplans.length > 1 ? 's' : ''} discovered`,
            description: `${floorplans.length} floorplan URL(s) captured`,
            source: SOURCE_ID, idempotency_key: `floorplan_added:${cand.source_listing_id}`,
          });
        }
        if (videoUrl && !prevEnrichedAt) {
          timelineEvents.push({
            entity_type: 'listing', pulse_entity_id: cand.id, event_type: 'listing_video_added',
            event_category: 'media', title: `Video discovered`,
            description: videoUrl, source: SOURCE_ID,
            idempotency_key: `video_added:${cand.source_listing_id}`,
          });
        }

        historyRows.push({
          entity_type: 'listing', entity_id: cand.id, entity_key: cand.source_listing_id,
          sync_log_id: syncLogId, action: 'detail_enriched',
          changes_summary: {
            fields_set: Object.keys(listingUpdates).filter(k => k !== 'detail_enriched_at' && k !== 'last_sync_log_id'),
            sold_date: soldDateIso, auction_date: auctionTimeIso, date_available: dateAvailable,
            has_floorplan: floorplans.length > 0, has_video: !!videoUrl,
          },
          source: SOURCE_ID,
        });

        // ── Agent contact merge (listing.lister) ──────────────────────────
        // Two shapes to handle:
        //   listing.lister = {id: "1576842", agentId: "<uuid>", email, mobilePhoneNumber, ...}
        //   item.agents[0] = {agentId: "1576842", name, emails: [...], phone, image, ...}
        // The NUMERIC-STRING agent ID lives in lister.id OR agents[0].agentId.
        // (The UUID in lister.agentId is REA's internal key, not what we store.)
        const lister = listing.lister || null;
        const topAgent = Array.isArray(item.agents) && item.agents.length > 0 ? item.agents[0] : null;
        const reaAgentId = (lister?.id && String(lister.id))
          || (topAgent?.agentId && String(topAgent.agentId))
          || null;
        const agentEmail = lister?.email || (Array.isArray(topAgent?.emails) ? topAgent.emails[0] : null) || null;
        const agentMobile = lister?.mobilePhoneNumber || lister?.phoneNumber || topAgent?.phoneNumber || topAgent?.phone || null;
        if (reaAgentId) {
          // Find the matching pulse_agents row
          let { data: agentRow } = await admin.from('pulse_agents')
            .select('id, email, email_source, mobile, mobile_source, rea_agent_id')
            .eq('rea_agent_id', reaAgentId)
            .maybeSingle();

          // Bridge-create if missing (same pattern as pulseDataSync listing
          // bridge): detail-enrich often sees agents before websift catches
          // them. Low base score; will bump below as contacts merge in.
          if (!agentRow) {
            const listerName = lister?.name || topAgent?.name || null;
            const listerTitle = lister?.jobTitle || topAgent?.jobTitle || null;
            const listerPhoto = lister?.mainPhoto ? `${lister.mainPhoto.server}${lister.mainPhoto.uri}` : (topAgent?.image || null);
            if (listerName) {
              const { data: created } = await admin.from('pulse_agents').insert({
                rea_agent_id: reaAgentId,
                full_name: listerName,
                job_title: listerTitle,
                profile_image: listerPhoto,
                agency_name: listing.agency?.name || item.agencyName || null,
                source: 'rea_detail_bridge',
                data_sources: JSON.stringify(['rea_detail']),
                data_integrity_score: 30,
                last_synced_at: now.toISOString(),
                last_sync_log_id: syncLogId,
                first_seen_at: now.toISOString(),
              }).select('id, email, email_source, mobile, mobile_source, rea_agent_id').maybeSingle();
              if (created) {
                agentRow = created;
                timelineEvents.push({
                  entity_type: 'agent', pulse_entity_id: created.id, rea_id: reaAgentId,
                  event_type: 'first_seen', event_category: 'system',
                  title: `${listerName} first detected via detail enrich`,
                  description: `Agent discovered through listing detail page (no prior websift sync)`,
                  source: SOURCE_ID, idempotency_key: `first_seen:${reaAgentId}`,
                });
              }
            }
          }

          // Also widen tally to include alt_source_deepened (matches between source and stored)
          const extractAction = (r: any): string | null => {
            const d = r?.data;
            if (!d) return null;
            if (typeof d === 'object' && 'action' in d) return d.action;
            if (Array.isArray(d) && d[0]?.action) return d[0].action;
            return null;
          };

          if (agentRow) {
            let bumped = false;
            // Email merge
            if (agentEmail && !isMiddlemanEmail(agentEmail)) {
              const r = await admin.rpc('pulse_merge_contact', {
                p_table: 'pulse_agents', p_row_id: agentRow.id,
                p_field: 'email', p_value: agentEmail, p_source: SRC_LISTER,
              });
              const action = extractAction(r);
              if (action === 'primary_promoted') {
                stats.agent_primary_promoted++;
                timelineEvents.push({
                  entity_type: 'agent', pulse_entity_id: agentRow.id, rea_id: reaAgentId,
                  event_type: 'agent_email_changed', event_category: 'contact',
                  title: `Agent primary email changed`,
                  description: `Detail enrich promoted higher-confidence email; old moved to alternates`,
                  source: SOURCE_ID, idempotency_key: `email_changed:${reaAgentId}:${now.toISOString().slice(0, 10)}`,
                });
                bumped = true;
              } else if (action === 'alt_added' || action === 'primary_set_from_null') {
                stats.agent_alt_added++;
                timelineEvents.push({
                  entity_type: 'agent', pulse_entity_id: agentRow.id, rea_id: reaAgentId,
                  event_type: 'agent_email_discovered', event_category: 'contact',
                  title: `New email discovered for agent`,
                  description: String(agentEmail).toLowerCase(),
                  source: SOURCE_ID,
                  idempotency_key: `email_discovered:${reaAgentId}:${String(agentEmail).toLowerCase()}`,
                });
                bumped = true;
              }
            }
            // Mobile merge
            if (agentMobile) {
              const r = await admin.rpc('pulse_merge_contact', {
                p_table: 'pulse_agents', p_row_id: agentRow.id,
                p_field: 'mobile', p_value: agentMobile, p_source: SRC_LISTER,
              });
              const action = extractAction(r);
              if (action === 'primary_promoted') {
                stats.agent_primary_promoted++;
                timelineEvents.push({
                  entity_type: 'agent', pulse_entity_id: agentRow.id, rea_id: reaAgentId,
                  event_type: 'agent_mobile_changed', event_category: 'contact',
                  title: `Agent primary mobile changed`,
                  description: `Old mobile moved to alternates for CRM-matching fallback`,
                  source: SOURCE_ID, idempotency_key: `mobile_changed:${reaAgentId}:${now.toISOString().slice(0, 10)}`,
                });
                bumped = true;
              } else if (action === 'alt_added' || action === 'primary_set_from_null') {
                stats.agent_alt_added++;
                timelineEvents.push({
                  entity_type: 'agent', pulse_entity_id: agentRow.id, rea_id: reaAgentId,
                  event_type: 'agent_mobile_discovered', event_category: 'contact',
                  title: `New mobile discovered for agent`,
                  source: SOURCE_ID,
                  idempotency_key: `mobile_discovered:${reaAgentId}:${agentMobile}`,
                });
                bumped = true;
              }
            }
            // Recompute integrity score
            if (bumped) {
              await admin.rpc('pulse_recompute_agent_score', { p_agent_id: agentRow.id });
              stats.integrity_scores_bumped++;
            }
          }
        }

        // ── Agency contact merge (listing.agency + item.agencyEmail etc.) ──
        const agency = listing.agency || {};
        // agency_rea_id extraction from profile URL (same logic as pulseDataSync)
        const agencyProfileUrl = agency._links?.agencyProfile?.href || item.agencyProfileUrl || '';
        const match = String(agencyProfileUrl).match(/agency\/.*?([A-Z0-9]{5,})(?:\/|$)/i);
        const agencyReaId = match ? match[1] : null;

        if (agencyReaId) {
          const { data: agencyRow } = await admin.from('pulse_agencies')
            .select('id, email, phone, website, address_street, brand_color_primary')
            .eq('rea_agency_id', agencyReaId)
            .maybeSingle();

          if (agencyRow) {
            // Helper to extract action from rpc result (handles both jsonb-direct and wrapped responses)
            const extractAction = (r: any): string | null => {
              const d = r?.data;
              if (!d) return null;
              if (typeof d === 'object' && 'action' in d) return d.action;
              if (Array.isArray(d) && d[0]?.action) return d[0].action;
              return null;
            };
            const tallyAgency = (action: string | null) => {
              if (action === 'primary_promoted') stats.agency_primary_promoted++;
              else if (action === 'alt_added' || action === 'primary_set_from_null' || action === 'alt_source_deepened') stats.agency_alt_added++;
            };
            // Email
            const agencyEmail = agency._links?.email || item.agencyEmail || null;
            if (agencyEmail && !isMiddlemanEmail(agencyEmail)) {
              const r = await admin.rpc('pulse_merge_contact', {
                p_table: 'pulse_agencies', p_row_id: agencyRow.id,
                p_field: 'email', p_value: agencyEmail, p_source: SRC_AGENCY,
              });
              tallyAgency(extractAction(r));
            }
            // Phone
            const agencyPhone = agency.phoneNumber || item.agencyPhone || null;
            if (agencyPhone) {
              const r = await admin.rpc('pulse_merge_contact', {
                p_table: 'pulse_agencies', p_row_id: agencyRow.id,
                p_field: 'phone', p_value: agencyPhone, p_source: SRC_AGENCY,
              });
              tallyAgency(extractAction(r));
            }
            // Plain fields (website, address, brand colors) — don't overwrite if already set
            const aUpdates: Record<string, any> = {};
            if (agency.website && !agencyRow.website) aUpdates.website = agency.website;
            const addrStreet = agency.address?.streetAddress || null;
            if (addrStreet && !agencyRow.address_street) aUpdates.address_street = addrStreet;
            const bcPrimary = agency.brandingColors?.primary || null;
            const bcText = agency.brandingColors?.text || null;
            if (bcPrimary && !agencyRow.brand_color_primary) aUpdates.brand_color_primary = bcPrimary;
            if (bcText) aUpdates.brand_color_text = bcText;
            if (Object.keys(aUpdates).length > 0) {
              aUpdates.last_sync_log_id = syncLogId;
              await admin.from('pulse_agencies').update(aUpdates).eq('id', agencyRow.id);
            }
          }
        }
      }

      // Bulk inserts
      if (timelineEvents.length > 0) await emitTimeline(admin, timelineEvents);
      if (historyRows.length > 0) {
        const { error } = await admin.from('pulse_entity_sync_history').insert(historyRows);
        if (error) stats.errors.push(`history insert: ${error.message?.substring(0, 150)}`);
      }
    }

    // ── Record success / failure on circuit breaker ──────────────────────
    if (stats.batches_succeeded > 0) {
      await breakerRecordSuccess(admin);
    } else if (stats.batches_attempted > 0) {
      await breakerRecordFailure(admin);
    }

    // ── Final sync_log update ────────────────────────────────────────────
    await admin.from('pulse_sync_logs').update({
      status: stats.errors.length > 0 ? 'partial' : 'ok',
      completed_at: new Date().toISOString(),
      records_fetched: stats.items_returned,
      records_processed: stats.items_processed,
      apify_run_ids: stats.apify_run_ids,
      message: `Enriched ${stats.items_processed} / ${stats.candidates} candidates in ${stats.batches_succeeded} batches. ${stats.items_withdrawn} withdrawn. Cost: $${stats.cost_estimate_usd.toFixed(3)}`,
      cost_estimate_usd: stats.cost_estimate_usd,
    }).eq('id', syncLogId);

    return jsonResponse({
      ok: true,
      syncLogId,
      duration_ms: Date.now() - startedAt,
      ...stats,
    });
  } catch (err: any) {
    await admin.from('pulse_sync_logs').update({
      status: 'error', completed_at: new Date().toISOString(),
      error_message: (err?.message || 'unknown').substring(0, 500),
    }).eq('id', syncLogId);
    await breakerRecordFailure(admin);
    console.error('pulseDetailEnrich fatal:', err);
    return errorResponse(err?.message || 'pulseDetailEnrich failed', 500);
  }
});
