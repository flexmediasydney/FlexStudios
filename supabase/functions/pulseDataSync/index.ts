import { getAdminClient, createEntities, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import {
  cleanEmailList,
  pickPrimaryEmail,
  parseEmailString,
  rejectedEmailList,
  isMiddlemanEmail,
} from '../_shared/emailCleanup.ts';

/**
 * Pulse Data Sync — REA-Only 2-Actor Merge Engine (v3 DB-driven config)
 *
 * Architecture: 2 Apify actors, 1 ID system (rea_agent_id)
 *   - websift/realestateau: agent profiles with stats, reviews, awards
 *   - azzouzana/real-estate-au-scraper-pro: all listings (buy/rent/sold) with agent emails, photos, IDs
 *
 * Pipeline 1 (Agent Sync): websift → upsert agents → extract agencies → detect movements → CRM mapping
 * Pipeline 2 (Listing Sync): azzouzana → upsert listings → cross-enrich agents (emails/photos) → detect new listings → CRM notifications
 *
 * Body params:
 *   suburbs: string[]           — e.g. ["Strathfield", "Burwood"]
 *   state: string               — default "NSW"
 *   actorInput: object          — (v3) Apify input template from pulse_source_configs.actor_input,
 *                                   passed verbatim to runApifyActor. {suburb} / {suburb-slug}
 *                                   placeholders are inflated here if they haven't been already.
 *                                   When present, overrides maxAgentsPerSuburb/maxListingsPerSuburb/
 *                                   listingsStartUrl/maxListingsTotal legacy params.
 *   source_id: string           — (v3) pulse_source_configs.source_id to look up actor_slug + approach
 *                                   from DB if actorInput not supplied
 *   maxAgentsPerSuburb: number  — (legacy) default 50, used when actorInput not supplied
 *   maxListingsPerSuburb: number — (legacy) default 30, used when actorInput not supplied
 *   skipListings: boolean       — skip listings scrape
 *   dryRun: boolean             — return results without saving
 *   listingsStartUrl: string    — (legacy) bounding box mode: single URL for whole region
 *   maxListingsTotal: number    — (legacy) max listings for bounding box mode
 */

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';

// ── Apify actor runner ──────────────────────────────────────────────────────

interface ApifyRunResult {
  items: any[];
  runId: string | null;
  datasetId: string | null;
}

/**
 * Fetch with an explicit abort-based timeout. Prevents the handler from
 * hanging past the Supabase edge function 150s wall if Apify stalls.
 * Throws AbortError on timeout — callers must catch.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runApifyActor(actorSlug: string, input: any, label: string, timeoutSecs = 180): Promise<ApifyRunResult> {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set in environment');

  const safeId = actorSlug.replace('/', '~');
  const url = `${APIFY_BASE}/acts/${safeId}/runs?timeout=${timeoutSecs}&waitForFinish=${timeoutSecs}`;

  // Fetch timeout = Apify timeout + 10s grace (so we see the ACTUAL Apify response
  // rather than the edge runtime killing us at 150s). Each individual HTTP call
  // caps at 120s to leave budget for other suburbs in a batch.
  const fetchTimeoutMs = Math.min(timeoutSecs * 1000 + 10_000, 120_000);

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }, fetchTimeoutMs);
  } catch (err: any) {
    console.error(`Apify ${label} run submit failed (aborted/network): ${err?.message || err}`);
    return { items: [], runId: null, datasetId: null };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`Apify ${label} failed: ${resp.status} — ${body.substring(0, 200)}`);
    return { items: [], runId: null, datasetId: null };
  }

  const runData = await resp.json().catch(() => ({}));
  let runId = runData?.data?.id || null;
  let status = runData?.data?.status;
  let datasetId = runData?.data?.defaultDatasetId || null;

  // Poll if still running — cap total poll time at timeoutSecs so we respect the caller's budget.
  if (status === 'RUNNING' || status === 'READY') {
    const pollBudgetMs = Math.min(timeoutSecs * 1000, 120_000);
    const pollStart = Date.now();
    while (Date.now() - pollStart < pollBudgetMs) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const pollResp = await fetchWithTimeout(`${APIFY_BASE}/actor-runs/${runId}`, {
          headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
        }, 15_000);
        const pollData = await pollResp.json().catch(() => ({}));
        status = pollData?.data?.status;
        datasetId = pollData?.data?.defaultDatasetId || datasetId;
        if (status !== 'RUNNING' && status !== 'READY') break;
      } catch (pollErr: any) {
        // One poll failing is fine — try again next iteration. If we run out
        // of budget, the while loop exits and we fall through to the status check.
        console.warn(`Apify ${label} poll error: ${pollErr?.message || pollErr}`);
      }
    }
  }

  if (status !== 'SUCCEEDED') {
    console.error(`Apify ${label}: status=${status}`);
    return { items: [], runId, datasetId };
  }

  try {
    const itemsResp = await fetchWithTimeout(`${APIFY_BASE}/datasets/${datasetId}/items?limit=5000`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    }, 30_000);
    if (!itemsResp.ok) {
      console.error(`Apify ${label}: dataset fetch failed (${itemsResp.status})`);
      return { items: [], runId, datasetId };
    }
    const items = await itemsResp.json();
    console.log(`Apify ${label}: ${items.length} results`);
    return { items: Array.isArray(items) ? items : [], runId, datasetId };
  } catch (fetchErr: any) {
    console.error(`Apify ${label}: dataset fetch error: ${fetchErr.message}`);
    return { items: [], runId, datasetId };
  }
}

// ── Normalize helpers ───────────────────────────────────────────────────────

function normalizeMobile(raw: string | null): string {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('614')) digits = '0' + digits.slice(2);
  else if (digits.startsWith('61')) digits = '0' + digits.slice(2);
  if (!digits.startsWith('0')) digits = '0' + digits;
  return digits;
}

function parsePrice(raw: string | null): number | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/,/g, '');
  if (s.includes('contact') || s.includes('request') || s.includes('enquire') || s.includes('auction')) return null;
  const mMatch = s.match(/\$?([\d.]+)\s*m/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
  const kMatch = s.match(/\$?([\d.]+)\s*k/i);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  const numMatch = s.match(/\$?([\d]+(?:\.[\d]+)?)/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    return val > 50 ? Math.round(val) : null;
  }
  return null;
}

/**
 * Parse listing status from price text — detects "Under Contract", "Sold", "Auction" etc.
 */
function parseListingStatus(priceText: string | null, defaultType: string): string {
  if (!priceText) return defaultType;
  const s = priceText.toLowerCase();
  if (s.includes('under contract') || s.includes('under offer')) return 'under_contract';
  if (s.includes('sold')) return 'sold';
  if (s.includes('auction')) return defaultType; // Still active, just auction method
  return defaultType;
}

/**
 * Extract a listing date from an Apify payload, trying many field name variations.
 * Returns an ISO date string (YYYY-MM-DD) or null.
 *
 * Priorities:
 *   Sold listings: soldDate → listedDate → dateSold
 *   Active/rent:   listedDate → dateListed → listDate → dateAvailable → dateCreated → createdAt
 *
 * REA (azzouzana) does NOT return a date field — the payload has no dates at all.
 * Domain returns `listedDate` as ISO datetime. The fallback chain also uses inspection
 * dates (startTime) and auction dates as a last resort.
 */
function extractListingDate(l: any, listingType: string): string | null {
  const pick = (v: any): string | null => {
    if (!v) return null;
    try {
      const dt = new Date(v);
      if (isNaN(dt.getTime())) return null;
      // Return as ISO date (YYYY-MM-DD)
      return dt.toISOString().slice(0, 10);
    } catch {
      return null;
    }
  };

  if (listingType === 'sold') {
    return pick(l.soldDate) || pick(l.sold_date) || pick(l.dateSold)
      || pick(l.listedDate) || pick(l.listed_date) || pick(l.dateListed);
  }
  // Active/rent/other
  return pick(l.listedDate)
    || pick(l.listed_date)
    || pick(l.dateListed)
    || pick(l.listDate)
    || pick(l.listingDate)
    || pick(l.dateAvailable)
    || pick(l.date_available)
    || pick(l.dateCreated)
    || pick(l.createdAt)
    || pick(l.created_at)
    || null;
}

/**
 * Extract sold date specifically. Returns ISO date or null.
 * REA sold payloads don't include a date, but `soldDate` may appear in enriched
 * sources. For REA sold listings with no date, the caller will fall back to
 * first_seen_at (which is when we first scraped it — a useful proxy).
 */
function extractSoldDate(l: any): string | null {
  const pick = (v: any): string | null => {
    if (!v) return null;
    try {
      const dt = new Date(v);
      if (isNaN(dt.getTime())) return null;
      return dt.toISOString().slice(0, 10);
    } catch {
      return null;
    }
  };
  return pick(l.soldDate) || pick(l.sold_date) || pick(l.dateSold) || pick(l.sold_at) || null;
}

/**
 * Parse "Days on Market: N" from description text (common in REA sold listings).
 * Returns the integer or null.
 */
function extractDaysOnMarketFromText(text: string | null): number | null {
  if (!text) return null;
  const m = String(text).match(/Days on Market[:\s]+(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  return n > 0 && n < 3650 ? n : null; // sanity: 0-10yr
}

function fmtPriceShort(v: number | null): string {
  if (!v) return '?';
  return v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`;
}

function normalizeAgencyName(raw: string | null): string {
  if (!raw) return '';
  return raw.replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fuzzyNameMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  const pa = na.split(/\s+/);
  const pb = nb.split(/\s+/);
  if (pa.length >= 2 && pb.length >= 2) {
    return pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
  }
  return false;
}

/**
 * Expand {suburb} / {suburb-slug} placeholders in every string value of the
 * actor input template. Non-string values pass through unchanged. Safe to
 * call multiple times — idempotent on already-inflated strings.
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

// ── Main handler ────────────────────────────────────────────────────────────

serveWithAudit('pulseDataSync', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const admin = getAdminClient();
  let syncLogId: string | null = null;
  try {
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'pulseDataSync', _arch: 'rea-only-2-actor', hasToken: !!APIFY_TOKEN });
    }

    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    // Accepts user JWT or service-role (cron via pulseFireScrapes/pulseScheduledScrape).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    if (!APIFY_TOKEN) {
      return errorResponse('APIFY_TOKEN not configured. Set it in Supabase Edge Function secrets.', 400);
    }

    const {
      suburbs = ['Strathfield'],
      state = 'NSW',
      maxAgentsPerSuburb = 50,
      maxListingsPerSuburb = 30,
      skipListings = false,
      dryRun = false,
      source_id = null,
      source_label = null,
      triggered_by = null,
      triggered_by_name = null,
      // Bounding box mode: single URL covers entire region (legacy params)
      listingsStartUrl = null,
      maxListingsTotal = 0,
      // v3 DB-driven config — when supplied, this is the Apify input template
      // from pulse_source_configs.actor_input (already inflated for single-suburb
      // dispatches, or raw with {suburb}/{suburb-slug} for multi-suburb batches).
      actorInput = null,
    } = body;

    // ── v3 config-driven dispatch helpers ────────────────────────────────
    // Determine actor_slug + approach from DB config when source_id given.
    // Falls back gracefully to the 2-actor assumption for legacy callers.
    let dbConfig: { actor_slug?: string; approach?: string } | null = null;
    if (source_id) {
      const { data: cfg } = await admin
        .from('pulse_source_configs')
        .select('actor_slug, approach')
        .eq('source_id', source_id)
        .maybeSingle();
      if (cfg) dbConfig = cfg;
    }

    const actorSlug: string | null = dbConfig?.actor_slug || null;
    const configApproach: string | null = dbConfig?.approach || null;
    const isBoundingBoxFromConfig = configApproach === 'bounding_box';

    // When actorInput is supplied, it is the single source of truth for Apify
    // input params. It may contain {suburb}/{suburb-slug} placeholders if
    // this is a multi-suburb batch call from pulseScheduledScrape.
    const hasActorInput = actorInput && typeof actorInput === 'object' && Object.keys(actorInput).length > 0;
    const isWebsiftActor = actorSlug === 'websift/realestateau';
    const isAzzouzanaActor = actorSlug === 'azzouzana/real-estate-au-scraper-pro';

    const now = new Date().toISOString();
    const apifyRunIds: Record<string, string | null> = {};

    // Log sync start
    if (!dryRun) {
      const log = await entities.PulseSyncLog.create({
        sync_type: source_id || 'full_sweep',
        source_id: source_id || null,
        source_label: source_label || null,
        status: 'running',
        started_at: now,
        input_config: { suburbs, state, maxAgentsPerSuburb, maxListingsPerSuburb, skipListings, actorInput, actor_slug: actorSlug, approach: configApproach },
        triggered_by: triggered_by || null,
        triggered_by_name: triggered_by_name || null,
      });
      syncLogId = log.id;
    }

    const allReaAgents: any[] = [];
    const allListings: any[] = [];

    // ── Step 1: Bounding box listings (single-URL mode) ──────────────────
    // v3: if actorInput present AND config approach is bounding_box, use it directly.
    // v2: fall back to legacy listingsStartUrl + maxListingsTotal body params.
    if (hasActorInput && isBoundingBoxFromConfig) {
      console.log(`[bounding-box v3] Running ${actorSlug || 'azzouzana'} with DB actor_input...`);
      const bbResult = await runApifyActor(
        actorSlug || 'azzouzana/real-estate-au-scraper-pro',
        actorInput,
        'listings-boundingbox',
        300
      );
      bbResult.items.forEach(l => { l._suburb = l.suburb || 'Greater Sydney'; l._source = 'rea_boundingbox'; });
      allListings.push(...bbResult.items);
      if (bbResult.runId) apifyRunIds['listings-boundingbox'] = bbResult.runId;
      console.log(`[bounding-box v3] ${bbResult.items.length} listings from bounding box`);
    } else if (listingsStartUrl && maxListingsTotal > 0) {
      console.log(`[bounding-box legacy] Running azzouzana with custom URL, max ${maxListingsTotal}...`);
      const bbResult = await runApifyActor('azzouzana/real-estate-au-scraper-pro', {
        startUrl: listingsStartUrl,
        maxItems: maxListingsTotal,
      }, 'listings-boundingbox', 300);
      bbResult.items.forEach(l => { l._suburb = l.suburb || 'Greater Sydney'; l._source = 'rea_boundingbox'; });
      allListings.push(...bbResult.items);
      if (bbResult.runId) apifyRunIds['listings-boundingbox'] = bbResult.runId;
      console.log(`[bounding-box legacy] ${bbResult.items.length} listings from bounding box`);
    }

    // ── Step 2: Run Apify actors per suburb ──────────────────────────────
    // v3: if actorInput present AND config approach is per_suburb, use it directly
    // (inflating {suburb}/{suburb-slug} placeholders per iteration). The config's
    // actor_slug decides which pipeline (agents vs listings).
    // v2: fall back to the hardcoded 2-actor pipeline using maxAgentsPerSuburb /
    // maxListingsPerSuburb body params.
    const useV3PerSuburb = hasActorInput && !isBoundingBoxFromConfig && actorSlug;

    for (const suburb of suburbs) {
      const suburbSlug = suburb.toLowerCase().replace(/\s+/g, '-');

      if (useV3PerSuburb) {
        // v3: single-actor pipeline driven by config actor_slug + actor_input
        const inflated = inflateSuburbTemplate(actorInput, suburb);

        if (isWebsiftActor) {
          // websift = REA agent profiles pipeline
          console.log(`[${suburb}] v3 websift with actor_input=${JSON.stringify(inflated).substring(0, 120)}...`);
          const reaResult = await runApifyActor(actorSlug, inflated, `websift-${suburb}`, 180);
          reaResult.items.forEach(a => { a._suburb = suburb; a._source = 'rea'; });
          allReaAgents.push(...reaResult.items);
          if (reaResult.runId) apifyRunIds[`websift-${suburb}`] = reaResult.runId;
        } else if (isAzzouzanaActor) {
          // azzouzana = REA listings pipeline
          console.log(`[${suburb}] v3 azzouzana with actor_input=${JSON.stringify(inflated).substring(0, 120)}...`);
          const listResult = await runApifyActor(actorSlug, inflated, `listings-${suburb}`, 120);
          listResult.items.forEach(l => { l._suburb = suburb; l._source = 'rea'; });
          allListings.push(...listResult.items);
          if (listResult.runId) apifyRunIds[`listings-${suburb}`] = listResult.runId;
        } else {
          // Unknown actor_slug — skip with a warning, legacy path won't match either
          console.warn(`[${suburb}] v3: unknown actor_slug '${actorSlug}', skipping`);
        }
        continue;
      }

      // v2 legacy: 2-actor pipeline with hardcoded params per suburb
      // 2A: websift REA agent profiles (correct input params: maxPages + fullScrape)
      if (maxAgentsPerSuburb > 0) {
        console.log(`[${suburb}] Running websift REA agents (legacy)...`);
        const reaResult = await runApifyActor('websift/realestateau', {
          location: `${suburb} ${state}`,
          maxPages: Math.ceil(maxAgentsPerSuburb / 10),
          fullScrape: true,
          sortBy: 'SUBURB_SALES_PERFORMANCE',
        }, `websift-${suburb}`, 180);
        reaResult.items.forEach(a => { a._suburb = suburb; a._source = 'rea'; });
        allReaAgents.push(...reaResult.items);
        if (reaResult.runId) apifyRunIds[`websift-${suburb}`] = reaResult.runId;
      }

      // 2B: azzouzana REA listings per suburb
      if (!skipListings && maxListingsPerSuburb > 0) {
        console.log(`[${suburb}] Running azzouzana REA listings (legacy)...`);
        const listResult = await runApifyActor('azzouzana/real-estate-au-scraper-pro', {
          startUrl: `https://www.realestate.com.au/buy/in-${suburbSlug},+${state.toLowerCase()}/list-1`,
          maxItems: maxListingsPerSuburb,
        }, `listings-${suburb}`, 120);
        listResult.items.forEach(l => { l._suburb = suburb; l._source = 'rea'; });
        allListings.push(...listResult.items);
        if (listResult.runId) apifyRunIds[`listings-${suburb}`] = listResult.runId;
      }
    }

    console.log(`Raw data: ${allReaAgents.length} REA agents, ${allListings.length} listings`);

    // ── Step 3: Process agents (REA-only, no merge needed) ──────────────

    const processedAgents: any[] = [];

    for (const rea of allReaAgents) {
      const reaName = rea.name || '';
      const reaMobile = normalizeMobile(rea.mobile || '');

      // Integrity scoring: REA-only, recalibrated
      let integrityScore = 50; // Base: REA profile exists
      if (reaMobile) integrityScore += 10;
      if (rea.agency?.name) integrityScore += 5;
      // Email and photo get added during cross-enrichment (Step 6) and bump score then

      const searchStats = rea.search_stats || {};
      const profileStats = rea.profile_stats || {};
      const reviews = rea.reviews || {};

      processedAgents.push({
        full_name: reaName,
        email: rea.email || null, // May come from websift, also cross-enriched from listing data
        mobile: rea.mobile ? String(rea.mobile) : null,
        business_phone: rea.businessPhone ? String(rea.businessPhone) : null,
        phone: rea.businessPhone ? String(rea.businessPhone) : null,
        agency_name: rea.agency?.name || null,
        agency_rea_id: rea.agency?.id || null,
        agency_suburb: rea._suburb,
        job_title: rea.job_title || null,
        years_experience: rea.years_experience || null,
        sales_as_lead: rea.sales_as_lead || null,
        total_sold_12m: searchStats.sumSoldProperties || null,
        rea_median_sold_price: searchStats.medianSoldPrice || profileStats.medianSoldPrice || null,
        avg_sold_price: searchStats.medianSoldPrice || profileStats.medianSoldPrice || null,
        rea_median_dom: searchStats.medianSoldDaysOnSite || profileStats.medianSoldDaysOnSite || null,
        avg_days_on_market: searchStats.medianSoldDaysOnSite || profileStats.medianSoldDaysOnSite || null,
        rea_rating: reviews.avg_rating || null,
        overall_rating: reviews.avg_rating || null,
        rea_review_count: reviews.total_reviews || null,
        reviews_count: reviews.total_reviews || 0,
        reviews_avg: reviews.avg_rating || null,
        awards: rea.awards || null,
        speciality_suburbs: rea.specialities || null,
        social_facebook: rea.social?.facebook || null,
        social_instagram: rea.social?.instagram || null,
        social_linkedin: rea.social?.linkedin || null,
        community_involvement: rea.community_involvement || null,
        biography: rea.description || rea.about || rea.biography || null,
        recent_listing_ids: JSON.stringify((rea.recent_listings || []).slice(0, 10).map((l: any) => l.listing_id)),
        sales_breakdown: rea.profile_sales_breakdown ? JSON.stringify(rea.profile_sales_breakdown) : null,
        rea_agent_id: rea.salesperson_id ? String(rea.salesperson_id) : null,
        rea_profile_url: rea.profile_url || null,
        profile_image: rea.image || rea.photo_url || rea.profile_image || null, // May come from websift, also cross-enriched from listing data
        source: 'rea',
        data_sources: JSON.stringify(['rea']),
        data_integrity_score: integrityScore,
        mobile_validated: false,
        agency_validated: false,
        suburbs_active: JSON.stringify([rea._suburb]),
        last_synced_at: now,
        is_in_crm: false,
        is_prospect: false,
      });
    }

    // ── Step 4: Extract agencies from agent data + listings ──────────────

    const agencyMap = new Map<string, any>();

    // 4a: Seed agencies from listings (address, phone, logo, listing count)
    for (const listing of allListings) {
      const agencyName = listing.agencyName;
      if (!agencyName) continue;
      const key = normalizeAgencyName(agencyName);
      if (!agencyMap.has(key)) {
        agencyMap.set(key, {
          name: agencyName,
          phone: listing.agencyPhone || null,
          email: listing.agencyEmail || null,
          website: listing.agencyWebsite || null,
          address: listing.agencyAddress || null,
          suburb: listing.agencyAddress_suburb || null,
          state: listing.agencyAddress_state || null,
          postcode: listing.agencyAddress_postcode || null,
          logo_url: listing.agencyLogo || null,
          rea_profile_url: listing.agencyProfileUrl || null,
          active_listings: 0,
          listing_prices: [],
          suburbs: new Set<string>(),
          sources: new Set<string>(['rea_listings']),
          rea_agency_ids: new Set<string>(),
        });
      }
      const agency = agencyMap.get(key)!;
      agency.active_listings++;
      if (listing.suburb) agency.suburbs.add(listing.suburb);
      const price = parseFloat(String(listing.price || '').replace(/[^0-9.]/g, ''));
      if (price > 0) agency.listing_prices.push(price);
    }

    // 4b: Enrich agencies from agent data (REA IDs, sales, ratings)
    for (const agent of processedAgents) {
      const agencyName = agent.agency_name;
      if (!agencyName) continue;
      const key = normalizeAgencyName(agencyName);
      if (!agencyMap.has(key)) {
        agencyMap.set(key, {
          name: agencyName,
          phone: null, email: null, website: null, address: null,
          suburb: agent.agency_suburb || null, state: null, postcode: null,
          logo_url: null, rea_profile_url: null,
          active_listings: 0, listing_prices: [],
          suburbs: new Set<string>(),
          sources: new Set<string>(),
          rea_agency_ids: new Set<string>(),
        });
      }
      const agency = agencyMap.get(key)!;
      agency.sources.add('rea');
      if (agent.agency_rea_id) agency.rea_agency_ids.add(agent.agency_rea_id);
      if (agent.agency_suburb) agency.suburbs.add(agent.agency_suburb);
    }

    // 4c: Aggregate per-agency stats from agents
    const mergedAgencies: any[] = [];
    for (const [key, agency] of agencyMap.entries()) {
      const agencyAgents = processedAgents.filter(a => normalizeAgencyName(a.agency_name || '') === key);
      const agentCount = agencyAgents.length;
      const totalSold = agencyAgents.reduce((s, a) => s + (a.sales_as_lead || 0), 0);
      const avgRating = (() => {
        const rated = agencyAgents.filter(a => a.rea_rating > 0);
        if (rated.length === 0) return null;
        return Math.round(rated.reduce((s, a) => s + (a.rea_rating || 0), 0) / rated.length * 10) / 10;
      })();
      const totalReviews = agencyAgents.reduce((s, a) => s + (a.reviews_count || 0), 0);
      const avgSoldPrice = (() => {
        const withPrice = agencyAgents.filter(a => a.avg_sold_price > 0);
        if (withPrice.length === 0) return null;
        return Math.round(withPrice.reduce((s, a) => s + a.avg_sold_price, 0) / withPrice.length);
      })();
      const avgDom = (() => {
        const withDom = agencyAgents.filter(a => a.avg_days_on_market > 0);
        if (withDom.length === 0) return null;
        return Math.round(withDom.reduce((s, a) => s + a.avg_days_on_market, 0) / withDom.length);
      })();
      const prices = agency.listing_prices;
      const reaIds = [...agency.rea_agency_ids];

      mergedAgencies.push({
        name: agency.name,
        phone: agency.phone,
        email: agency.email,
        website: agency.website,
        address: agency.address,
        suburb: agency.suburb,
        state: agency.state,
        postcode: agency.postcode,
        logo_url: agency.logo_url,
        rea_profile_url: agency.rea_profile_url,
        rea_agency_id: reaIds[0] || null,
        agent_count: agentCount,
        active_listings: agency.active_listings,
        avg_listing_price: prices.length > 0 ? Math.round(prices.reduce((s: number, p: number) => s + p, 0) / prices.length) : null,
        total_sold_12m: totalSold || null,
        avg_sold_price: avgSoldPrice,
        avg_days_on_market: avgDom,
        avg_agent_rating: avgRating,
        total_reviews: totalReviews || null,
        suburbs_active: JSON.stringify([...agency.suburbs]),
        source: 'rea',
        data_sources: JSON.stringify([...agency.sources]),
        last_synced_at: now,
        is_in_crm: false,
      });
    }

    // ── Step 5: CRM cross-reference ─────────────────────────────────────

    const crmAgentsList = await entities.Agent.filter({}, null, 1000).catch(() => []);
    const crmNames = new Set(crmAgentsList.map((a: any) => (a.name || '').toLowerCase().trim()));
    const crmAgenciesList = await entities.Agency.filter({}, null, 500).catch(() => []);
    const crmAgencyNames = new Set(crmAgenciesList.map((a: any) => normalizeAgencyName(a.name)));

    for (const agent of processedAgents) {
      const name = (agent.full_name || '').toLowerCase().trim();
      if (crmNames.has(name)) {
        // Verify agency matches too (if available) to avoid false positives
        const crmAgent = crmAgentsList.find((c: any) => (c.name || '').toLowerCase().trim() === name);
        if (crmAgent) {
          const crmAgencyName = (crmAgent.current_agency_name || '').toLowerCase().trim();
          const pulseAgencyName = (agent.agency_name || '').toLowerCase().trim();
          if (!crmAgencyName || !pulseAgencyName || crmAgencyName.includes(pulseAgencyName) || pulseAgencyName.includes(crmAgencyName)) {
            agent.is_in_crm = true;
          }
        } else {
          agent.is_in_crm = true; // No CRM agent found for validation, trust name match
        }
      } else {
        for (const cn of crmNames) {
          if (fuzzyNameMatch(name, cn)) {
            // Verify agency matches too (if available)
            const crmAgent = crmAgentsList.find((c: any) => (c.name || '').toLowerCase().trim() === cn);
            if (crmAgent) {
              const crmAgencyName = (crmAgent.current_agency_name || '').toLowerCase().trim();
              const pulseAgencyName = (agent.agency_name || '').toLowerCase().trim();
              if (!crmAgencyName || !pulseAgencyName || crmAgencyName.includes(pulseAgencyName) || pulseAgencyName.includes(crmAgencyName)) {
                agent.is_in_crm = true;
                break;
              }
            } else {
              agent.is_in_crm = true;
              break;
            }
          }
        }
      }
    }

    for (const agency of mergedAgencies) {
      if (crmAgencyNames.has(normalizeAgencyName(agency.name))) {
        agency.is_in_crm = true;
      }
    }

    // Fallback: agents with confirmed CRM mappings stay is_in_crm even if agency changed
    const { data: confirmedAgentMappings = [] } = await admin.from('pulse_crm_mappings')
      .select('rea_id')
      .eq('entity_type', 'agent')
      .eq('confidence', 'confirmed');
    const confirmedReaIds = new Set(confirmedAgentMappings.map((m: any) => m.rea_id).filter(Boolean));
    for (const agent of processedAgents) {
      if (!agent.is_in_crm && agent.rea_agent_id && confirmedReaIds.has(agent.rea_agent_id)) {
        agent.is_in_crm = true;
      }
    }

    console.log(`Processed: ${processedAgents.length} agents, ${mergedAgencies.length} agencies`);
    console.log(`In CRM: ${processedAgents.filter(a => a.is_in_crm).length} agents, ${mergedAgencies.filter(a => a.is_in_crm).length} agencies`);

    if (dryRun) {
      return jsonResponse({
        success: true,
        dry_run: true,
        agents: processedAgents.length,
        agencies: mergedAgencies.length,
        listings: allListings.length,
        in_crm_agents: processedAgents.filter(a => a.is_in_crm).length,
        in_crm_agencies: mergedAgencies.filter(a => a.is_in_crm).length,
        sample_agent: processedAgents[0] || null,
        sample_agency: mergedAgencies[0] || null,
      });
    }

    // ── Step 5b: Snapshot existing agents BEFORE upsert (for movement detection in Step 9) ──
    // Must load before Step 6 upsert — otherwise existing.agency_rea_id already equals the new value
    const { data: preUpsertPulseAgents = [] } = await admin.from('pulse_agents')
      .select('id, rea_agent_id, agency_name, agency_rea_id, full_name')
      .not('rea_agent_id', 'is', null);
    const existingByReaIdSnapshot = new Map(preUpsertPulseAgents.map((a: any) => [a.rea_agent_id, a]));
    console.log(`Pre-upsert snapshot: ${preUpsertPulseAgents.length} existing agents with REA IDs`);

    // ── Step 6: Upsert to database ──────────────────────────────────────

    let agentsInserted = 0;
    let agentsUpdated = 0;
    let agentErrors = 0;
    const _agentErrorMsgs: string[] = [];
    const BATCH = 50;

    // Deduplicate agents by rea_agent_id (same agent appears in multiple suburb searches)
    const deduped = new Map<string, any>();
    for (const agent of processedAgents) {
      const key = agent.rea_agent_id || `name:${(agent.full_name || '').toLowerCase()}@${normalizeAgencyName(agent.agency_name || '')}`;
      if (!deduped.has(key)) {
        deduped.set(key, agent);
      } else {
        // Merge suburbs_active from duplicate
        const existing = deduped.get(key);
        try {
          const existingSuburbs = typeof existing.suburbs_active === 'string' ? JSON.parse(existing.suburbs_active) : (existing.suburbs_active || []);
          const newSuburbs = typeof agent.suburbs_active === 'string' ? JSON.parse(agent.suburbs_active) : (agent.suburbs_active || []);
          existing.suburbs_active = JSON.stringify([...new Set([...existingSuburbs, ...newSuburbs])]);
        } catch { /* keep existing */ }
      }
    }
    const uniqueAgents = [...deduped.values()];
    console.log(`Deduped: ${processedAgents.length} -> ${uniqueAgents.length} unique agents`);

    // Upsert agents by rea_agent_id — strip null email/profile_image to preserve enriched data
    for (let i = 0; i < uniqueAgents.length; i += BATCH) {
      const batch = uniqueAgents.slice(i, i + BATCH).map(a => {
        const record: Record<string, any> = {
          ...a,
          data_sources: typeof a.data_sources === 'string' ? JSON.parse(a.data_sources) : (a.data_sources || []),
          suburbs_active: typeof a.suburbs_active === 'string' ? JSON.parse(a.suburbs_active) : (a.suburbs_active || []),
          recent_listing_ids: typeof a.recent_listing_ids === 'string' ? JSON.parse(a.recent_listing_ids) : (a.recent_listing_ids || []),
          sales_breakdown: typeof a.sales_breakdown === 'string' ? JSON.parse(a.sales_breakdown) : (a.sales_breakdown || null),
        };
        // Don't overwrite cross-enriched fields with null
        if (!record.email) delete record.email;
        if (!record.profile_image) delete record.profile_image;
        if (!record.total_listings_active) delete record.total_listings_active;
        return record;
      });

      // Only agents with rea_agent_id can upsert properly
      const withReaId = batch.filter(a => a.rea_agent_id);
      const withoutReaId = batch.filter(a => !a.rea_agent_id);

      if (withReaId.length > 0) {
        const { error } = await admin.from('pulse_agents').upsert(withReaId, {
          onConflict: 'rea_agent_id',
          ignoreDuplicates: false,
        });
        if (error) { agentErrors++; _agentErrorMsgs.push(error.message?.substring(0, 300) || 'unknown'); }
        else {
          // Count inserts vs updates using pre-upsert snapshot
          for (const a of withReaId) {
            if (existingByReaIdSnapshot.has(a.rea_agent_id)) {
              agentsUpdated++;
            } else {
              agentsInserted++;
            }
          }
        }
      }

      // Agents without REA ID: check by name to avoid duplicates
      for (const agent of withoutReaId) {
        const { data: existing } = await admin.from('pulse_agents')
          .select('id').ilike('full_name', agent.full_name?.trim() || '').limit(1);
        if (existing && existing.length > 0) {
          await admin.from('pulse_agents').update(agent).eq('id', existing[0].id);
          agentsUpdated++;
        } else {
          const { error: insertErr } = await admin.from('pulse_agents').insert(agent);
          if (!insertErr) agentsInserted++;
        }
      }
      if ((i / BATCH) % 3 === 0) console.log(`  Agents: ${agentsInserted}/${uniqueAgents.length}...`);
    }

    // Upsert agencies — pre-load existing for batch lookup (replaces N+1 pattern)
    let agenciesInserted = 0;
    let agenciesUpdated = 0;

    const { data: existingAgenciesList = [] } = await admin.from('pulse_agencies')
      .select('id, name');
    const existingAgencyMap = new Map<string, string>();
    existingAgenciesList.forEach((a: any) => {
      existingAgencyMap.set((a.name || '').trim().toLowerCase(), a.id);
    });

    for (const agency of mergedAgencies) {
      const cleaned = {
        ...agency,
        suburbs_active: typeof agency.suburbs_active === 'string' ? JSON.parse(agency.suburbs_active) : (agency.suburbs_active || []),
        data_sources: typeof agency.data_sources === 'string' ? JSON.parse(agency.data_sources) : (agency.data_sources || []),
      };
      try {
        const existingId = existingAgencyMap.get(agency.name.trim().toLowerCase());

        if (existingId) {
          await admin.from('pulse_agencies').update(cleaned).eq('id', existingId);
          agenciesUpdated++;
        } else {
          await admin.from('pulse_agencies').insert(cleaned);
          agenciesInserted++;
        }
      } catch (err: any) {
        if (agenciesInserted < 3) console.error(`Agency upsert error for ${agency.name}:`, err.message?.substring(0, 200));
      }
    }

    // Upsert listings + detect new listings + parse status from price text
    let listingsInserted = 0;
    let newListingsDetected = 0;
    const _listingErrorMsgs: string[] = [];

    // Load existing listing IDs for new-listing detection
    const existingListingIds = new Set<string>();
    if (allListings.length > 0) {
      const { data: existingListings = [] } = await admin.from('pulse_listings')
        .select('source_listing_id')
        .not('source_listing_id', 'is', null);
      existingListings.forEach((l: any) => { if (l.source_listing_id) existingListingIds.add(l.source_listing_id); });
    }

    // Load existing listing prices + types for change detection (MUST be before listingRecords mapping)
    const existingListingData = new Map<string, { asking_price: number | null; listing_type: string | null }>();
    if (allListings.length > 0) {
      const listingIds = allListings.map(l => l.listingId ? String(l.listingId) : null).filter(Boolean) as string[];
      if (listingIds.length > 0) {
        const { data: existingPriceData = [] } = await admin.from('pulse_listings')
          .select('source_listing_id, asking_price, listing_type')
          .in('source_listing_id', listingIds.slice(0, 1000));
        existingPriceData.forEach((l: any) => {
          existingListingData.set(l.source_listing_id, { asking_price: l.asking_price, listing_type: l.listing_type });
        });
      }
    }

    const listingRecords = allListings.map(l => {
      const listingId = l.listingId ? String(l.listingId) : null;
      const isNew = listingId && !existingListingIds.has(listingId);
      const inspections = Array.isArray(l.inspections) ? l.inspections : [];
      const nextInspection = inspections[0]?.startTime || null;
      const listingAgents = Array.isArray(l.agents) ? l.agents : [];
      const primaryAgent = listingAgents[0] || {};

      // Determine raw listing type
      const rawType = l.isSold ? 'sold' : l.isBuy ? 'for_sale' : l.isRent ? 'for_rent' : 'other';
      // Override with status from price text (catches "Under Contract" in buy results)
      const listingType = parseListingStatus(l.price, rawType);

      // Extract dates with robust multi-field fallback
      const extractedListedDate = extractListingDate(l, listingType);
      const extractedSoldDate = extractSoldDate(l);
      // Days on Market: explicit field first, then parse from description (REA sold often has "Days on Market: N")
      const extractedDom = l.daysOnMarket
        || extractDaysOnMarketFromText(l.description)
        || null;

      // For sold listings with DOM but no listed_date, derive listed_date from first_seen_at - DOM
      // (done in post-processing when first_seen_at is known; here we just capture DOM)

      return {
        address: l.address || null,
        suburb: l.suburb || l._suburb || null,
        postcode: l.postcode || null,
        property_type: l.propertyType || null,
        bedrooms: l.bedrooms || null,
        bathrooms: l.bathrooms || null,
        parking: (l.parking || l.carSpaces) ? String(l.parking || l.carSpaces) : null,
        land_size: l.landSize ? String(l.landSize) : null,
        listing_type: listingType,
        asking_price: parsePrice(l.price),
        sold_price: parsePrice(l.soldPrice),
        listed_date: extractedListedDate,
        created_date: extractedListedDate,
        sold_date: extractedSoldDate,
        auction_date: l.auctionDate || null,
        days_on_market: extractedDom,
        status: l.status || null,
        price_text: l.price || null,
        next_inspection: nextInspection,
        agent_name: primaryAgent.name || null,
        agent_phone: primaryAgent.phoneNumber || null,
        agent_photo: primaryAgent.image || l.agentPhoto || null,
        agency_name: l.agencyName || null,
        agency_logo: l.agencyLogo || null,
        agency_brand_colour: l.brandColour || null,
        description: l.description ? String(l.description).substring(0, 2000) : null,
        image_url: l.mainImage || (Array.isArray(l.images) && l.images[0]) || null,
        hero_image: l.mainImage || (Array.isArray(l.images) && l.images[0]) || null,
        images: Array.isArray(l.images) ? l.images.slice(0, 20) : null,
        has_video: l.hasVideo || false,
        latitude: l.latitude || null,
        longitude: l.longitude || null,
        features: l.propertyFeatures ? l.propertyFeatures : null,
        promo_level: l.promoLevel || l.productDepth || null,
        // Agent + agency ID foreign keys
        agent_rea_id: primaryAgent.agentId ? String(primaryAgent.agentId) : null,
        agency_rea_id: (() => { const match = (l.agencyProfileUrl || '').match(/agency\/.*?([A-Z0-9]{5,})(?:\/|$)/i); return match ? match[1] : null; })(),
        source: l._source || 'rea',
        source_url: l.url || null,
        source_listing_id: listingId || null,
        first_seen_at: isNew ? now : undefined,
        last_synced_at: now,
        // Change detection
        previous_asking_price: (() => {
          if (!listingId) return undefined;
          const ex = existingListingData.get(listingId);
          if (!ex?.asking_price) return undefined;
          const newPrice = parsePrice(l.price);
          return (newPrice && newPrice !== ex.asking_price) ? ex.asking_price : undefined;
        })(),
        price_changed_at: (() => {
          if (!listingId) return undefined;
          const ex = existingListingData.get(listingId);
          if (!ex?.asking_price) return undefined;
          const newPrice = parsePrice(l.price);
          return (newPrice && newPrice !== ex.asking_price) ? now : undefined;
        })(),
        previous_listing_type: (() => {
          if (!listingId) return undefined;
          const ex = existingListingData.get(listingId);
          if (!ex?.listing_type) return undefined;
          return (listingType !== ex.listing_type) ? ex.listing_type : undefined;
        })(),
        status_changed_at: (() => {
          if (!listingId) return undefined;
          const ex = existingListingData.get(listingId);
          if (!ex?.listing_type) return undefined;
          return (listingType !== ex.listing_type) ? now : undefined;
        })(),
        _isNew: isNew,
        // Cross-enrichment temp data (stripped before DB insert)
        _agentEmail: (primaryAgent.emails && primaryAgent.emails[0]) || null,
        _agentPhoto: primaryAgent.image || null,
        _agentReaId: primaryAgent.agentId ? String(primaryAgent.agentId) : null,
        _agentJobTitle: primaryAgent.jobTitle || null,
        _allAgents: listingAgents.map((a: any) => ({
          name: a.name, email: (a.emails && a.emails[0]) || null,
          phone: a.phoneNumber || null, photo: a.image || null,
          reaId: a.agentId ? String(a.agentId) : null, jobTitle: a.jobTitle || null,
        })),
      };
    });

    // Filter out obvious out-of-state listings (VIC, QLD, SA, WA, TAS, NT by postcode)
    // Keep listingRecords intact for cross-enrichment (agent emails from interstate sales still valid)
    const filteredListingRecords = listingRecords.filter(l => {
      if (!l.suburb) return true; // keep if no suburb data
      if (l.postcode) {
        const pc = parseInt(l.postcode);
        if (pc >= 3000 && pc < 5000) return false; // VIC/QLD
        if (pc >= 5000 && pc < 7000) return false; // SA/WA
        if (pc >= 7000 && pc < 8000) return false; // TAS
        if (pc >= 800 && pc < 900) return false; // NT
      }
      return true;
    });
    console.log(`Listings: ${listingRecords.length} total, ${filteredListingRecords.length} after state filter (removed ${listingRecords.length - filteredListingRecords.length} out-of-state)`);

    for (let i = 0; i < filteredListingRecords.length; i += BATCH) {
      const batch = filteredListingRecords.slice(i, i + BATCH);
      const cleanBatch = batch.map(({ _isNew, _agentEmail, _agentPhoto, _agentReaId, _agentJobTitle, _allAgents, ...rest }) => {
        // Strip undefined values so they don't null-out existing data
        const cleaned: Record<string, any> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) cleaned[k] = v;
        }
        return cleaned;
      });
      const { error } = await admin.from('pulse_listings').upsert(cleanBatch, {
        onConflict: 'source_listing_id',
        ignoreDuplicates: false,
      });
      if (error) {
        console.error(`Listing upsert error (batch ${i / BATCH}):`, error.message?.substring(0, 300));
        _listingErrorMsgs.push(`batch:${error.message?.substring(0, 300)}`);
        for (const rec of cleanBatch) {
          const { error: singleErr } = await admin.from('pulse_listings').upsert(rec, { onConflict: 'source_listing_id', ignoreDuplicates: false });
          if (!singleErr) listingsInserted++;
          else _listingErrorMsgs.push(`single(${rec.source_listing_id}):${singleErr.message?.substring(0, 200)}`);
        }
      } else {
        listingsInserted += cleanBatch.length;
      }
      newListingsDetected += batch.filter(l => l._isNew).length;
    }

    // Log new listings to timeline
    if (newListingsDetected > 0) {
      const sampleNew = listingRecords.filter(l => l._isNew).slice(0, 5);
      try {
        await admin.from('pulse_timeline').insert({
          entity_type: 'listing',
          event_type: 'new_listings_detected',
          event_category: 'market',
          title: `${newListingsDetected} new listing${newListingsDetected !== 1 ? 's' : ''} detected`,
          description: sampleNew.map(l => `${l.address || l.suburb || '?'} - ${l.agency_name || '?'}`).join('; '),
          new_value: { count: newListingsDetected, sample: sampleNew.map(l => ({ address: l.address, suburb: l.suburb, price: l.asking_price, agency: l.agency_name, agent: l.agent_name })) },
          source: source_id || 'rea_sync',
        });
      } catch { /* non-fatal */ }
    }

    // Timeline events for price changes
    const priceChangedListings = filteredListingRecords.filter(l => l.previous_asking_price !== undefined);
    if (priceChangedListings.length > 0) {
      try {
        await admin.from('pulse_timeline').insert({
          entity_type: 'listing', event_type: 'price_change', event_category: 'market',
          title: `${priceChangedListings.length} listing price change${priceChangedListings.length !== 1 ? 's' : ''} detected`,
          description: priceChangedListings.slice(0, 5).map(l => `${l.address || l.suburb}: ${fmtPriceShort(l.previous_asking_price)} → ${fmtPriceShort(l.asking_price)}`).join('; '),
          new_value: { count: priceChangedListings.length, sample: priceChangedListings.slice(0, 5).map(l => ({ address: l.address, old: l.previous_asking_price, new: l.asking_price })) },
          source: source_id || 'rea_sync',
        });
      } catch { /* non-fatal */ }
    }

    // Timeline events for status changes (e.g., for_sale → sold)
    const statusChangedListings = filteredListingRecords.filter(l => l.previous_listing_type !== undefined);
    if (statusChangedListings.length > 0) {
      try {
        await admin.from('pulse_timeline').insert({
          entity_type: 'listing', event_type: 'status_change', event_category: 'market',
          title: `${statusChangedListings.length} listing status change${statusChangedListings.length !== 1 ? 's' : ''} detected`,
          description: statusChangedListings.slice(0, 5).map(l => `${l.address || l.suburb}: ${l.previous_listing_type} → ${l.listing_type}`).join('; '),
          new_value: { count: statusChangedListings.length, sample: statusChangedListings.slice(0, 5).map(l => ({ address: l.address, old: l.previous_listing_type, new: l.listing_type })) },
          source: source_id || 'rea_sync',
        });
      } catch { /* non-fatal */ }
    }

    // ── Step 7: Cross-enrich agents from listing data (EMAIL BRIDGE) ────
    // Listings contain agent emails, photos, and REA IDs that websift doesn't provide.
    // Match by rea_agent_id FIRST (not name) to prevent wrong-agent email assignment.
    {
      // Build enrichment map keyed by rea_agent_id (primary) and name (fallback)
      const enrichByReaId = new Map<string, { email?: string; photo?: string; phone?: string; jobTitle?: string; listingCount: number; allEmails: string[] }>();
      const enrichByName = new Map<string, { email?: string; photo?: string; phone?: string; reaId?: string; jobTitle?: string; listingCount: number; allEmails: string[] }>();

      for (const lr of listingRecords) {
        const agents = lr._allAgents || [];
        for (const la of agents) {
          if (!la.name) continue;

          // Expand raw email string (scraper gives comma-joined: "real@agency,capture@agency.agentboxmail.com.au")
          const rawParts = parseEmailString(la.email);

          // Primary: keyed by REA agent ID (strongest match)
          if (la.reaId) {
            const existing = enrichByReaId.get(la.reaId) || { listingCount: 0, allEmails: [] };
            for (const part of rawParts) {
              if (!existing.allEmails.includes(part)) existing.allEmails.push(part);
            }
            if (la.photo && !existing.photo) existing.photo = la.photo;
            if (la.phone && !existing.phone) existing.phone = la.phone;
            if (la.jobTitle && !existing.jobTitle) existing.jobTitle = la.jobTitle;
            existing.listingCount++;
            enrichByReaId.set(la.reaId, existing);
          }

          // Secondary: keyed by normalized name (weaker, for agents without REA ID in listings)
          const nameKey = la.name.toLowerCase().trim();
          const existingByName = enrichByName.get(nameKey) || { listingCount: 0, allEmails: [] };
          for (const part of rawParts) {
            if (!existingByName.allEmails.includes(part)) existingByName.allEmails.push(part);
          }
          if (la.photo && !existingByName.photo) existingByName.photo = la.photo;
          if (la.phone && !existingByName.phone) existingByName.phone = la.phone;
          if (la.reaId && !existingByName.reaId) existingByName.reaId = la.reaId;
          if (la.jobTitle && !existingByName.jobTitle) existingByName.jobTitle = la.jobTitle;
          existingByName.listingCount++;
          enrichByName.set(nameKey, existingByName);
        }
      }

      console.log(`Cross-enrichment data: ${enrichByReaId.size} agents by REA ID, ${enrichByName.size} by name`);

      if (enrichByReaId.size > 0 || enrichByName.size > 0) {
        const { data: existingAgentsForEnrich = [] } = await admin.from('pulse_agents')
          .select('id, full_name, email, mobile, profile_image, rea_agent_id, agency_name, job_title, total_listings_active, data_integrity_score');

        let enriched = 0;
        for (const pa of existingAgentsForEnrich) {
          let enrichData: any = null;

          // Priority 1: Match by rea_agent_id (strongest — guaranteed correct agent)
          if (pa.rea_agent_id && enrichByReaId.has(pa.rea_agent_id)) {
            enrichData = enrichByReaId.get(pa.rea_agent_id);
          }

          // Priority 2: Match by name (weaker — only if no ID match)
          if (!enrichData) {
            const nameKey = (pa.full_name || '').toLowerCase().trim();
            if (enrichByName.has(nameKey)) {
              enrichData = enrichByName.get(nameKey);
            }
          }

          if (!enrichData) continue;

          const updates: Record<string, any> = {};

          // Build the cleaned pool of emails: existing stored + freshly scraped.
          // Always filter middleman before writing. See _shared/emailCleanup.ts.
          const existingPool = parseEmailString(pa.email);
          const rawPool: string[] = [...existingPool, ...(enrichData.allEmails || [])];
          const cleanedList = cleanEmailList(rawPool);
          const rejectedList = rejectedEmailList(rawPool);
          const freshPrimary = pickPrimaryEmail(
            enrichData.allEmails || [],
            pa.agency_name,
            pa.full_name,
          );

          // Primary email: prefer a clean fresh pick over a middleman-polluted
          // stored value. If the stored value is already clean and the fresh
          // pick is at a different domain (agency move), record previous_email.
          if (freshPrimary) {
            if (!pa.email || isMiddlemanEmail(pa.email)) {
              updates.email = freshPrimary;
            } else if (pa.email.toLowerCase() !== freshPrimary) {
              const existingDomain = pa.email.toLowerCase().split('@')[1] || '';
              const newDomain = freshPrimary.split('@')[1] || '';
              if (existingDomain !== newDomain) {
                updates.previous_email = pa.email;
                updates.email = freshPrimary;
              }
            }
          }

          // all_emails: always store the cleaned list (jsonb array of strings)
          if (cleanedList.length > 0) {
            updates.all_emails = JSON.stringify(cleanedList);
          }
          // rejected_emails: audit trail of everything we filtered out
          if (rejectedList.length > 0) {
            updates.rejected_emails = JSON.stringify(rejectedList);
          }

          // Photo: only fill blank (don't thrash)
          if (enrichData.photo && !pa.profile_image) updates.profile_image = enrichData.photo;
          if (enrichData.phone && !pa.mobile) updates.mobile = enrichData.phone;
          if (enrichData.reaId && !pa.rea_agent_id) updates.rea_agent_id = enrichData.reaId;
          if (enrichData.jobTitle && !pa.job_title) updates.job_title = enrichData.jobTitle;
          if (enrichData.listingCount > 0) updates.total_listings_active = enrichData.listingCount;

          // Recalculate integrity score from scratch (avoids competing Math.max paths)
          if (Object.keys(updates).length > 0) {
            const finalEmail = updates.email || pa.email;
            const finalEmailIsClean = finalEmail && !isMiddlemanEmail(finalEmail);
            let newScore = 50; // base: exists in REA
            if (pa.mobile || updates.mobile) newScore += 10;
            // Only award points for a clean primary email
            if (finalEmailIsClean) newScore += 15;
            if (updates.profile_image || pa.profile_image) newScore += 10;
            if (finalEmailIsClean && (updates.profile_image || pa.profile_image)) newScore += 5;
            if (pa.rea_agent_id) newScore += 10;
            updates.data_integrity_score = newScore;

            await admin.from('pulse_agents').update(updates).eq('id', pa.id);
            enriched++;
          }
        }
        console.log(`Cross-enriched ${enriched} agents from listing data`);
      }
    }

    // ── Step 8: CRM client listing notifications ────────────────────────
    if (newListingsDetected > 0) {
      const newListingsFromCrmAgents = listingRecords.filter(l => {
        if (!l._isNew || !l.agent_name) return false;
        const agentName = l.agent_name.toLowerCase().trim();
        return crmAgentsList.some((c: any) => (c.name || '').toLowerCase().trim() === agentName);
      });

      if (newListingsFromCrmAgents.length > 0) {
        const users = await entities.User.list('-created_date', 200).catch(() => []);
        const admins = (users as any[]).filter((u: any) => u.role === 'master_admin' || u.role === 'admin');
        for (const listing of newListingsFromCrmAgents.slice(0, 5)) {
          const addr = listing.address || listing.suburb || 'New property';
          for (const u of admins) {
            try {
              await entities.Notification.create({
                user_id: u.id, type: 'pulse_client_listing', category: 'pulse', severity: 'info',
                title: `Client listing: ${listing.agent_name}`,
                message: `Your client ${listing.agent_name} just listed ${addr}${listing.asking_price ? ` ($${listing.asking_price > 1000000 ? (listing.asking_price / 1000000).toFixed(1) + 'M' : Math.round(listing.asking_price / 1000) + 'K'})` : ''}`,
                is_read: false, is_dismissed: false, source: 'pulse',
                idempotency_key: `client_listing:${listing.source_listing_id}:${u.id}`,
                created_date: now,
              });
            } catch { /* dedup key handles repeats */ }
          }
        }
        try {
          await admin.from('pulse_timeline').insert({
            entity_type: 'listing',
            event_type: 'client_new_listing',
            event_category: 'market',
            title: `${newListingsFromCrmAgents.length} new listing${newListingsFromCrmAgents.length !== 1 ? 's' : ''} from CRM clients`,
            description: newListingsFromCrmAgents.slice(0, 3).map(l => `${l.agent_name}: ${l.address || l.suburb}`).join('; '),
            source: source_id || 'rea_sync',
          });
        } catch { /* non-fatal */ }
      }
    }

    // ── Step 9: Movement Detection + Timeline ───────────────────────────
    // Uses existingByReaIdSnapshot from Step 5b (loaded BEFORE the upsert)
    // so we can detect movements and first_seen correctly.

    let movementsDetected = 0;
    let timelineEntries = 0;
    let mappingsCreated = 0;

    for (const agent of processedAgents) {
      const reaId = agent.rea_agent_id;
      if (!reaId) continue;

      const existing = existingByReaIdSnapshot.get(reaId);

      if (!existing) {
        // New agent — first seen
        try {
          await admin.from('pulse_timeline').insert({
            entity_type: 'agent',
            rea_id: reaId,
            event_type: 'first_seen',
            event_category: 'system',
            title: `${agent.full_name} first detected`,
            description: `Agent first seen in ${agent.agency_name || 'unknown agency'}, ${agent.agency_suburb || ''}`,
            new_value: { agency_name: agent.agency_name, agency_rea_id: agent.agency_rea_id, suburb: agent.agency_suburb },
            source: 'rea_sync',
          });
          timelineEntries++;
        } catch { /* non-fatal */ }
      } else if (existing.agency_rea_id && agent.agency_rea_id && existing.agency_rea_id !== agent.agency_rea_id) {
        // Agency change detected
        movementsDetected++;
        try {
          await admin.from('pulse_timeline').insert({
            entity_type: 'agent',
            pulse_entity_id: existing.id,
            rea_id: reaId,
            event_type: 'agency_change',
            event_category: 'movement',
            title: `${agent.full_name} moved agencies`,
            description: `${existing.agency_name} -> ${agent.agency_name}`,
            previous_value: { agency_name: existing.agency_name, agency_rea_id: existing.agency_rea_id },
            new_value: { agency_name: agent.agency_name, agency_rea_id: agent.agency_rea_id },
            source: 'rea_sync',
          });
          timelineEntries++;
        } catch { /* non-fatal */ }

        await admin.from('pulse_agents').update({
          previous_agency_name: existing.agency_name,
          agency_changed_at: now,
        }).eq('id', existing.id);
      }
    }

    // ── Step 10: Auto-Mapping (REA ID + Phone + Name) ───────────────────

    const { data: existingMappings = [] } = await admin.from('pulse_crm_mappings').select('id, rea_id, entity_type, crm_entity_id, confidence, pulse_entity_id');
    const mappedKeys = new Set(existingMappings.filter((m: any) => m.confidence === 'confirmed').map((m: any) =>
      `${m.entity_type}:${m.rea_id || ''}`
    ));

    // Build lookup maps from existing mappings (eliminates per-agent DB queries)
    const mappingsByCrmId = new Map<string, any>();
    existingMappings.forEach((m: any) => {
      if (m.crm_entity_id) mappingsByCrmId.set(`${m.entity_type}:${m.crm_entity_id}`, m);
    });

    // Build complete pulse agent ID map (eliminates per-agent pulse_agents.select queries)
    const { data: allPulseAgentIds = [] } = await admin.from('pulse_agents')
      .select('id, rea_agent_id').not('rea_agent_id', 'is', null);
    const pulseAgentIdMap = new Map(allPulseAgentIds.map((a: any) => [a.rea_agent_id, a.id]));

    // Build complete pulse agency ID map (eliminates per-agency pulse_agencies.select queries)
    const { data: allPulseAgencyIds = [] } = await admin.from('pulse_agencies')
      .select('id, name').limit(2000);
    const pulseAgencyIdMap = new Map(allPulseAgencyIds.map((a: any) => [(a.name || '').trim().toLowerCase(), a.id]));

    // 10a: Agent mapping
    for (const agent of processedAgents) {
      const reaId = agent.rea_agent_id;
      if (!reaId) continue;
      if (mappedKeys.has(`agent:${reaId}`)) continue;

      let matchedCrm: any = null;
      let matchType = '';
      let hasNameOverlap = false;

      // Priority 1: REA agent ID match
      if (reaId) {
        matchedCrm = crmAgentsList.find((c: any) => c.rea_agent_id === reaId);
        if (matchedCrm) { matchType = 'rea_id'; hasNameOverlap = true; }
      }

      // Priority 2: Phone match
      if (!matchedCrm) {
        const agentMobile = normalizeMobile(agent.mobile);
        if (agentMobile) {
          matchedCrm = crmAgentsList.find((c: any) => normalizeMobile(c.phone) === agentMobile);
          if (matchedCrm) {
            matchType = 'phone';
            hasNameOverlap = fuzzyNameMatch(matchedCrm.name || '', agent.full_name || '');
          }
        }
      }

      // Priority 3: Exact name match
      if (!matchedCrm) {
        matchedCrm = crmAgentsList.find((c: any) => (c.name || '').toLowerCase().trim() === (agent.full_name || '').toLowerCase().trim());
        if (matchedCrm) { matchType = 'name_exact'; hasNameOverlap = true; }
      }

      // Priority 4: Fuzzy name match
      if (!matchedCrm) {
        matchedCrm = crmAgentsList.find((c: any) => fuzzyNameMatch(c.name || '', agent.full_name || ''));
        if (matchedCrm) { matchType = 'name_fuzzy'; hasNameOverlap = true; }
      }

      if (matchedCrm) {
        const confidence = (matchType === 'rea_id' || (matchType === 'phone' && hasNameOverlap) || matchType === 'name_exact') ? 'confirmed' : 'suggested';

        // Use pre-built lookup maps instead of per-agent DB queries
        const existMapEntry = mappingsByCrmId.get(`agent:${matchedCrm.id}`);
        const existMap = existMapEntry ? [existMapEntry] : [];

        // Look up pulse_agent ID from pre-built map
        const pulseAgentId: string | null = reaId ? (pulseAgentIdMap.get(reaId) || null) : null;

        if (existMap.length === 0) {
          await admin.from('pulse_crm_mappings').insert({
            entity_type: 'agent',
            pulse_entity_id: pulseAgentId,
            rea_id: reaId || null,
            crm_entity_id: matchedCrm.id,
            match_type: hasNameOverlap ? `${matchType}+name` : matchType,
            confidence,
          });
          mappingsCreated++;
        } else if (existMap[0].confidence === 'suggested' && confidence === 'confirmed') {
          const updates: Record<string, any> = { confidence: 'confirmed' };
          if (reaId && !existMap[0].rea_id) updates.rea_id = reaId;
          if (pulseAgentId) updates.pulse_entity_id = pulseAgentId;
          await admin.from('pulse_crm_mappings').update(updates).eq('id', existMap[0].id);
        }

        // Write REA ID back to CRM record
        const crmUpdates: Record<string, any> = {};
        if (reaId && !matchedCrm.rea_agent_id) crmUpdates.rea_agent_id = reaId;
        if (Object.keys(crmUpdates).length > 0) {
          await admin.from('agents').update(crmUpdates).eq('id', matchedCrm.id);
        }

        // Set is_in_crm on pulse_agent
        if (confidence === 'confirmed' && pulseAgentId) {
          await admin.from('pulse_agents').update({ is_in_crm: true, linked_agent_id: matchedCrm.id }).eq('id', pulseAgentId);
        }
      }
    }

    // 10b: Agency mapping
    for (const agency of mergedAgencies) {
      const reaAgencyId = agency.rea_agency_id;

      let matchedCrmAgency: any = null;
      let agencyMatchType = '';

      // Priority 1: REA agency ID
      if (reaAgencyId) {
        matchedCrmAgency = crmAgenciesList.find((c: any) => c.rea_agency_id === reaAgencyId);
        if (matchedCrmAgency) agencyMatchType = 'rea_id';
      }

      // Priority 2: Normalized name match
      if (!matchedCrmAgency) {
        const normName = normalizeAgencyName(agency.name);
        matchedCrmAgency = crmAgenciesList.find((c: any) => normalizeAgencyName(c.name) === normName);
        if (matchedCrmAgency) agencyMatchType = 'name';
      }

      if (matchedCrmAgency) {
        // Use pre-built lookup maps instead of per-agency DB queries
        const existAgencyMapEntry = mappingsByCrmId.get(`agency:${matchedCrmAgency.id}`);
        const existAgencyMap = existAgencyMapEntry ? [existAgencyMapEntry] : [];

        // Look up pulse_agency ID from pre-built map
        const pulseAgencyId: string | null = pulseAgencyIdMap.get(agency.name.trim().toLowerCase()) || null;

        if (existAgencyMap.length === 0) {
          await admin.from('pulse_crm_mappings').insert({
            entity_type: 'agency',
            pulse_entity_id: pulseAgencyId,
            rea_id: reaAgencyId || null,
            crm_entity_id: matchedCrmAgency.id,
            match_type: agencyMatchType,
            confidence: 'confirmed',
          });
          mappingsCreated++;
        } else if (existAgencyMap[0].confidence === 'suggested') {
          const updates: Record<string, any> = { confidence: 'confirmed' };
          if (reaAgencyId && !existAgencyMap[0].rea_id) updates.rea_id = reaAgencyId;
          if (pulseAgencyId) updates.pulse_entity_id = pulseAgencyId;
          await admin.from('pulse_crm_mappings').update(updates).eq('id', existAgencyMap[0].id);
        }

        // Write REA ID back to CRM agency
        if (reaAgencyId && !matchedCrmAgency.rea_agency_id) {
          await admin.from('agencies').update({ rea_agency_id: reaAgencyId }).eq('id', matchedCrmAgency.id);
        }

        // Set is_in_crm on pulse_agency
        if (reaAgencyId) {
          await admin.from('pulse_agencies').update({ is_in_crm: true }).eq('rea_agency_id', reaAgencyId);
        } else {
          await admin.from('pulse_agencies').update({ is_in_crm: true }).ilike('name', agency.name.trim());
        }
      }
    }

    console.log(`Post-sync: ${movementsDetected} movements, ${timelineEntries} timeline entries, ${mappingsCreated} mappings`);

    // Update sync log
    if (syncLogId) {
      await entities.PulseSyncLog.update(syncLogId, {
        status: 'completed',
        records_fetched: allReaAgents.length + allListings.length,
        records_new: agentsInserted + agenciesInserted,
        records_updated: agentsUpdated + agenciesUpdated + listingsInserted,
        completed_at: new Date().toISOString(),
        apify_run_id: Object.values(apifyRunIds).filter(Boolean).join(',') || null,
        raw_payload: {
          rea_agents: allReaAgents,
          listings: allListings,
        },
        result_summary: {
          agents_inserted: agentsInserted,
          agents_updated: agentsUpdated,
          agencies_inserted: agenciesInserted,
          agencies_updated: agenciesUpdated,
          listings_stored: listingsInserted,
          movements_detected: movementsDetected,
          timeline_entries: timelineEntries,
          mappings_created: mappingsCreated,
          in_crm_agents: processedAgents.filter(a => a.is_in_crm).length,
          agent_errors: agentErrors,
        },
      });
    }

    // Update source config last_run_at
    if (source_id) {
      try {
        await admin.from('pulse_source_configs').update({ last_run_at: now }).eq('source_id', source_id);
      } catch { /* non-fatal */ }
    }

    return jsonResponse({
      success: true,
      _version: 'v2.0',
      suburbs,
      agents_inserted: agentsInserted,
      agents_updated: agentsUpdated,
      agents_processed: agentsInserted + agentsUpdated,
      agencies_inserted: agenciesInserted,
      agencies_updated: agenciesUpdated,
      agencies_extracted: agenciesInserted + agenciesUpdated,
      listings_stored: listingsInserted,
      listings_filtered_out: listingRecords.length - filteredListingRecords.length,
      movements_detected: movementsDetected,
      timeline_entries: timelineEntries,
      mappings_created: mappingsCreated,
      new_listings: newListingsDetected,
      in_crm_agents: processedAgents.filter(a => a.is_in_crm).length,
      in_crm_agencies: mergedAgencies.filter(a => a.is_in_crm).length,
      sync_log_id: syncLogId,
      apify_run_ids: apifyRunIds,
      _debug: {
        rea_raw: allReaAgents.length,
        unique_agents: uniqueAgents.length,
        agent_errors: agentErrors,
        error_msgs: _agentErrorMsgs.slice(0, 3),
        listings_raw: allListings.length,
        listing_records: listingRecords.length,
        listings_filtered: filteredListingRecords.length,
        listing_errors: _listingErrorMsgs.slice(0, 5),
      },
    });

  } catch (error: any) {
    console.error('pulseDataSync error:', error);
    // Update sync log to failed so it doesn't block future runs
    if (syncLogId) {
      try {
        await admin.from('pulse_sync_logs').update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          result_summary: { error: error.message?.substring(0, 500) },
        }).eq('id', syncLogId);
      } catch { /* last resort */ }
    }
    return errorResponse(error.message);
  }
});
