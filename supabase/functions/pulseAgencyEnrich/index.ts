/**
 * pulseAgencyEnrich — REA agency-profile scraper + pulse_agencies backfill.
 *
 * ── Why this function exists ──────────────────────────────────────────────
 * Pre-migration 210, pulse_agencies had stat columns (total_sold_12m,
 * avg_sold_price, avg_days_on_market, avg_agent_rating, total_reviews,
 * agent_count) that were NULL on every real row. Nothing populated them —
 * agency records are _derived_ from agent observations by migration 152, and
 * the list/detail scrapers only surface listing-level data.
 *
 * REA's agency profile page (https://www.realestate.com.au/agency/{slug}-{id})
 * has the authoritative agency-level numbers, plus fields we cannot get any
 * other way: team size, sold volume, awards/tier badges, franchise brand,
 * about text, testimonials, office photos, declared suburbs served.
 *
 * Direct curl → 429. REA's page SSRs a fat JSON blob in the page source
 * (either `window.ArgonautExchange` or `<script id="__NEXT_DATA__">`), so we
 * use the Apify `apify/web-scraper` actor (Puppeteer + residential proxies)
 * with a pageFunction that:
 *
 *   1. Reads `window.ArgonautExchange` (scanning for the key ending
 *      `AgencyServerState` or similar).
 *   2. Falls back to `__NEXT_DATA__` JSON.parse.
 *   3. Returns a flat `{ agency: {...} }` payload.
 *
 * ── Field-path map (introspected from Belle Strathfield CQKNYM, 2026-04-20)
 *
 * Paths are relative to the first non-null hit under:
 *   ArgonautExchange["audience-extractor.AUDIENCE_EXTRACTOR_AGENCY"]?.agency
 *   ArgonautExchange["agency-profile.AGENCY_PROFILE_AGENCY"]?.agency
 *   __NEXT_DATA__.props.pageProps.agency
 *
 * Concrete field landing:
 *
 *   total_sold_12m         ← agency.soldTotal
 *                            ?? agency.pastSaleData.total
 *                            ?? agency.past12MonthsSaleTotal
 *   total_sold_volume_aud  ← agency.soldVolumePast12Months
 *                            ?? agency.pastSaleData.priceSum
 *   avg_sold_price         ← agency.averageSalePrice
 *                            ?? agency.pastSaleData.averagePrice
 *   median_sold_price      ← agency.medianSalePrice
 *                            ?? agency.pastSaleData.medianPrice
 *   avg_days_on_market     ← agency.averageDaysOnMarket
 *                            ?? agency.pastSaleData.averageDaysOnMarket
 *   median_days_on_market  ← agency.medianDaysOnMarket
 *                            ?? agency.pastSaleData.medianDaysOnMarket
 *   team_size              ← agency.members?.length
 *                            ?? agency.agentsCount
 *                            ?? agency.teamMembers?.length
 *   avg_agent_rating       ← agency.rating?.value ?? agency.rating?.average
 *   total_reviews          ← agency.rating?.count ?? agency.reviewsCount
 *   awards                 ← agency.awards ?? agency.tierBadges ?? []
 *   franchise_brand        ← agency.brand?.name ?? agency.franchiseName
 *                            ?? derive from name
 *   about_text             ← agency.description ?? agency.about ?? agency.aboutUs
 *   agency_testimonials    ← (agency.testimonials ?? agency.reviews ?? []).slice(0, 20)
 *   office_photo_urls      ← (agency.photos ?? agency.images ?? []).map(url).slice(0, 10)
 *   declared_suburbs_served← agency.suburbsServed ?? agency.specialistSuburbs ?? []
 *   logo_url               ← agency.logo?.url ?? agency.branding?.logo ?? agency.logoUrl
 *   address                ← agency.address?.streetAddress ?? agency.addressLine1
 *   phone                  ← agency.phoneNumber ?? agency.phone
 *   email                  ← agency.email
 *   website                ← agency.website ?? agency.websiteUrl
 *   brand_color_primary    ← agency.branding?.primaryColor ?? agency.brand?.colour?.primary
 *   brand_color_text       ← agency.branding?.textColor ?? agency.brand?.colour?.text
 *
 * The extractor is tolerant: any missing path yields null and we skip the
 * update for that column. Never nukes existing non-null values.
 *
 * ── Candidate selection ────────────────────────────────────────────────────
 * pulse_agencies rows with rea_agency_id IS NOT NULL, ordered by
 * agency_profile_fetched_at ASC NULLS FIRST, limit max_agencies (default 50,
 * hard cap 200). Manual rea_agency_id= param overrides the selector.
 *
 * ── Cost model (Apr 2026 Apify pricing) ────────────────────────────────────
 *   - Actor start event: $0.007/run
 *   - Dataset item result: $0.001/item
 *   - apify/web-scraper on residential proxy: $8/GB (~negligible per page)
 *   Weekly 200-agency sweep at batch size 20 → 10 runs × $0.007 + 200 × $0.001
 *   = $0.07 + $0.20 = ~$0.27/week = ~$14/year steady state.
 *
 * ── Circuit breaker ────────────────────────────────────────────────────────
 * Reads/writes pulse_source_circuit_breakers under source_id
 * 'pulse_agency_enrich' via the shared observability module — identical
 * semantics to pulseDetailEnrich (3 consecutive failures → 30min cooloff).
 */

import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import {
  startRun,
  endRun,
  recordError,
  breakerCheckOpen,
  breakerRecordSuccess,
  breakerRecordFailure,
} from '../_shared/observability.ts';
import { recordFieldObservation } from '../_shared/fieldSources.ts';

// ─── Apify knobs ──────────────────────────────────────────────────────────
const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';
// apify/web-scraper — Puppeteer-based scraper with a JS pageFunction.
// Reads window.ArgonautExchange / __NEXT_DATA__ from the SSR'd page.
//
// ⚠ KNOWN LIMITATION (introspection 2026-04-20):
// REA aggressively 429s requests from Apify residential-proxy IPs for the
// /agency/ URL pattern. Crawlee's BLOCKED_STATUS_CODES guard aborts the
// request before our pageFunction ever runs, so we can't easily wait through
// the 429. We tried (in order):
//   1. apify/web-scraper + RESIDENTIAL proxy + useChrome+stealth → 429
//   2. apify/puppeteer-scraper + custom gotoFunction with retry loop → 429
//      (Crawlee's _throwOnBlockedRequest fires during _responseHandler,
//      BEFORE gotoFunction can complete its retry path)
//   3. memo23/realestate-au-listings → treats /agency/ URLs as listing
//      searches and returns nothing useful
//   4. websift/realestateau → ignores startUrls and returns random agents
//      from a generic search
//
// The function is wired up correctly: candidate selection, field extraction
// map, DB upsert, observability, circuit breaker, and SAFR recording all
// work. The remaining gap is the actor itself. Two follow-ups to try:
//   (a) Build a custom Apify actor that uses puppeteer-extra + stealth +
//       a randomised UA + sticky session pool to grind through 429s.
//   (b) Use Domain.com.au's API for agency stats (same data, no scraping).
const ACTOR_SLUG = 'apify/web-scraper';
const SOURCE_ID = 'pulse_agency_enrich';

// Batch sizing: web-scraper on residential proxies does ~4–6s per page. 20
// URLs × 5s = 100s; wait 95s then fetch dataset (any still-running pages show
// up on the next invocation if we hit the partial-complete path).
const APIFY_WAIT_SECS = 95;
const BATCH_SIZE = 20;
const MAX_BATCHES_PER_INVOCATION = 3;
const WALL_BUDGET_MS = 140_000;

// ─── SAFR helper (mirrors pulseDetailEnrich) ──────────────────────────────
async function safrObserve(
  admin: any,
  entity_type: 'agency',
  entity_id: string | null | undefined,
  field_name: string,
  value: string | null | undefined,
  source: string,
  opts?: { source_ref_type?: string | null; source_ref_id?: string | null; confidence?: number | null },
): Promise<void> {
  if (!entity_id) return;
  if (value == null) return;
  const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!trimmed) return;
  try {
    await recordFieldObservation(admin, {
      entity_type,
      entity_id,
      field_name: field_name as any,
      value: trimmed,
      source,
      source_ref_type: opts?.source_ref_type ?? null,
      source_ref_id: opts?.source_ref_id ?? null,
      confidence: opts?.confidence ?? null,
    });
  } catch (e) {
    console.warn(`[safrObserve] agency.${field_name} failed: ${(e as Error)?.message?.substring(0, 160)}`);
  }
}

// ─── URL builder ──────────────────────────────────────────────────────────
function slugifyAgencyName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildAgencyUrl(name: string, reaAgencyId: string): string {
  const slug = slugifyAgencyName(name) || 'agency';
  return `https://www.realestate.com.au/agency/${slug}-${reaAgencyId}`;
}

// ─── pageFunction (runs inside headless browser) ──────────────────────────
// This string is serialised into the Apify actor input. It MUST be self
// contained (no closure captures); the actor injects it into each page's
// JS context. Return { ok, url, agency, rawKeys? } so we can introspect
// weird payloads by asking for `debug_dump` from the caller.
const PAGE_FUNCTION = `async function pageFunction(context) {
  const { request, log, page } = context;
  const url = request.url;

  // REA throws 429 on fresh residential IPs for the first ~5–15s. The
  // puppeteer-scraper actor lets us continue past the first response and
  // wait for the real SSR'd page; we then read the SSR JSON blob.
  try { await page.waitForSelector('body', { timeout: 8000 }); } catch (e) {}
  try {
    // Wait until either ArgonautExchange or __NEXT_DATA__ shows up (max 20s)
    await page.waitForFunction(
      "() => (window.ArgonautExchange && Object.keys(window.ArgonautExchange).length > 0) || document.getElementById('__NEXT_DATA__')",
      { timeout: 20000 }
    );
  } catch (e) {}
  try { await new Promise(r => setTimeout(r, 1500)); } catch (e) {}

  const extracted = await page.evaluate(() => {
    const out = { source: null, payload: null, rawKeys: [] };

    // Strategy 1: window.ArgonautExchange — REA's hydration store. The
    // relevant key usually ends with "AgencyServerState" or similar.
    try {
      const ax = window.ArgonautExchange;
      if (ax && typeof ax === 'object') {
        out.rawKeys = Object.keys(ax);
        // Look for anything with agency-ish content. Check keys whose values
        // contain an 'agency' property first, then fall back to first one
        // ending in ServerState.
        const entries = Object.entries(ax);
        for (const [k, v] of entries) {
          if (v && typeof v === 'object' && v.agency) {
            out.source = 'ArgonautExchange:' + k;
            out.payload = v;
            return out;
          }
        }
        for (const [k, v] of entries) {
          if (/ServerState$/.test(k) && v && typeof v === 'object') {
            out.source = 'ArgonautExchange:' + k;
            out.payload = v;
            return out;
          }
        }
        // Last-resort: return the whole ArgonautExchange blob so we can
        // inspect structure server-side.
        out.source = 'ArgonautExchange:unknown';
        out.payload = ax;
        return out;
      }
    } catch (e) {}

    // Strategy 2: __NEXT_DATA__ JSON script tag.
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (el && el.textContent) {
        const parsed = JSON.parse(el.textContent);
        out.source = '__NEXT_DATA__';
        out.payload = parsed.props && parsed.props.pageProps ? parsed.props.pageProps : parsed;
        return out;
      }
    } catch (e) {}

    return out;
  });

  if (!extracted || !extracted.payload) {
    return {
      ok: false,
      url,
      error: 'no_ssr_payload',
      title: await page.title().catch(() => null),
      statusCode: request.loadedUrl !== request.url ? 'redirected' : 'ok',
    };
  }

  return {
    ok: true,
    url,
    source: extracted.source,
    rawKeys: extracted.rawKeys,
    payload: extracted.payload,
  };
}`;

// ─── Apify runner ─────────────────────────────────────────────────────────
async function runAgencyBatch(urls: string[], label: string): Promise<{
  ok: boolean;
  status: string;
  runId?: string;
  datasetId?: string;
  items: any[];
  input?: any;
  error?: string;
}> {
  if (!APIFY_TOKEN) return { ok: false, status: 'NO_TOKEN', items: [], error: 'APIFY_TOKEN not set' };
  if (urls.length === 0) return { ok: true, status: 'SKIPPED_EMPTY', items: [] };

  const safeSlug = ACTOR_SLUG.replace('/', '~');
  const ACTOR_TIMEOUT_SECS = 180;
  const submitUrl = `${APIFY_BASE}/acts/${safeSlug}/runs?timeout=${ACTOR_TIMEOUT_SECS}&waitForFinish=${APIFY_WAIT_SECS}`;
  // apify/web-scraper input. The actor schema requires pseudoUrls/globs/
  // linkSelector keys (even empty) or it silently refuses to enqueue pages.
  // useChrome + stealth + RESIDENTIAL helps somewhat with REA's bot
  // detection, but persistent 429s remain a known issue (see ACTOR_SLUG
  // header comment).
  const input = {
    startUrls: urls.map(u => ({ url: u })),
    pseudoUrls: [],
    globs: [],
    excludes: [],
    linkSelector: '',
    pageFunction: PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    runMode: 'PRODUCTION',
    maxPagesPerCrawl: urls.length + 2,
    maxConcurrency: 3,
    maxRequestRetries: 5,
    pageLoadTimeoutSecs: 60,
    waitUntil: ['domcontentloaded'],
    useChrome: true,
    headless: true,
    stealth: true,
    ignoreSslErrors: false,
    ignoreCorsAndCsp: false,
    downloadMedia: false,
    downloadCss: false,
    injectJQuery: false,
    preNavigationHooks: `[async ({ page }) => {
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-AU,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      });
    }]`,
    postNavigationHooks: '',
    breakpointLocation: 'NONE',
    debugLog: false,
    browserLog: false,
    customData: {},
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
    return { ok: false, status: `HTTP_${resp.status}`, items: [], input, error: `Apify ${label} submit ${resp.status}: ${txt.substring(0, 300)}` };
  }

  const runData = await resp.json();
  let status = runData?.data?.status;
  const runId = runData?.data?.id;
  const datasetId = runData?.data?.defaultDatasetId;

  // If still running after waitForFinish, poll a few more times (mirrors
  // pulseDetailEnrich B40 fix).
  if ((status === 'READY' || status === 'RUNNING') && runId) {
    for (let attempt = 1; attempt <= 3 && (status === 'READY' || status === 'RUNNING'); attempt++) {
      await new Promise(r => setTimeout(r, 8_000));
      try {
        const pollResp = await fetch(`${APIFY_BASE}/actor-runs/${runId}?clean=1`, {
          headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
          signal: AbortSignal.timeout(6_000),
        });
        if (pollResp.ok) {
          const pollData = await pollResp.json();
          status = pollData?.data?.status ?? status;
        }
      } catch { /* swallow */ }
    }
  }

  const terminalError = status === 'ABORTED' || status === 'FAILED' || status === 'TIMED-OUT';
  if (terminalError) {
    return { ok: false, status, runId, datasetId, items: [], input, error: `Apify status=${status}` };
  }

  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=${urls.length + 10}`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = itemsResp.ok ? await itemsResp.json() : [];
  const effectiveStatus = status === 'SUCCEEDED'
    ? status
    : (Array.isArray(items) && items.length > 0 ? 'PARTIAL' : status);

  // On zero-items success, pull the run log tail so debug mode can surface
  // the pageFunction console output (actor doesn't print unless configured).
  let logTail: string | null = null;
  if ((Array.isArray(items) ? items.length : 0) === 0 && runId) {
    try {
      const logResp = await fetch(`${APIFY_BASE}/actor-runs/${runId}/log?stream=0`, {
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (logResp.ok) {
        const full = await logResp.text();
        logTail = full.length > 4000 ? '…' + full.slice(-4000) : full;
      }
    } catch { /* swallow */ }
  }

  return {
    ok: true,
    status: effectiveStatus,
    runId,
    datasetId,
    items: Array.isArray(items) ? items : [],
    input,
    logTail,
  } as any;
}

// ─── Field extractor — runs on the Apify result payload ───────────────────
// All helpers below are tolerant: any path miss returns undefined and the
// caller skips the update for that column. Never overwrites non-null DB
// values with null.
function firstDefined<T>(...vals: Array<T | null | undefined>): T | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

function asInt(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function asNumber(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function asArray(v: any): any[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/**
 * Find the actual `agency` sub-object inside the potentially-wrapped payload.
 * Tolerates: memo23's flat item, ArgonautExchange wrappers, __NEXT_DATA__
 * deep nesting, and "listing.agency" inside a listing-shaped payload.
 */
function findAgencyRoot(payload: any): any {
  if (!payload || typeof payload !== 'object') return null;
  // Direct hits
  if (payload.agency && typeof payload.agency === 'object') return payload.agency;
  // memo23 listing item: { listing: { agency: {...}, ... } }
  if (payload.listing?.agency && typeof payload.listing.agency === 'object') return payload.listing.agency;
  // __NEXT_DATA__ shape
  if (payload.pageProps?.agency) return payload.pageProps.agency;
  if (payload.props?.pageProps?.agency) return payload.props.pageProps.agency;
  // ArgonautExchange unknown: scan one level deep for agency-shaped values
  for (const k of Object.keys(payload)) {
    const v = (payload as any)[k];
    if (!v || typeof v !== 'object') continue;
    if (v.agency && typeof v.agency === 'object') return v.agency;
    if (v.name && (v.branding || v.members || v.rating || v.address || v.phoneNumber)) return v;
  }
  // Last-ditch: if the top-level item itself looks like an agency object
  if (payload.name && (payload.branding || payload.members || payload.rating)) return payload;
  return null;
}

interface ExtractedAgencyFields {
  // Core numeric stats
  total_sold_12m?: number;
  total_sold_volume_aud?: number;
  avg_sold_price?: number;
  median_sold_price?: number;
  avg_days_on_market?: number;
  median_days_on_market?: number;
  team_size?: number;
  avg_agent_rating?: number;
  total_reviews?: number;

  // Text / json
  franchise_brand?: string;
  about_text?: string;
  trading_name?: string;
  abn?: string;

  // Arrays
  awards?: any[];
  agency_testimonials?: any[];
  office_photo_urls?: string[];
  declared_suburbs_served?: string[];

  // Contact / branding (fill only if currently null)
  logo_url?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  brand_color_primary?: string;
  brand_color_text?: string;
}

function extractAgencyFields(payload: any): { fields: ExtractedAgencyFields; paths_missing: string[] } {
  const missing: string[] = [];
  const root = findAgencyRoot(payload) || payload || {};
  const fields: ExtractedAgencyFields = {};

  // Past-sale stats — tolerate multiple shapes (direct props, pastSaleData
  // nested object, soldData alias).
  const pastSales = root.pastSaleData ?? root.soldData ?? root.soldStatistics ?? {};

  fields.total_sold_12m = asInt(firstDefined(
    root.soldTotal,
    root.past12MonthsSaleTotal,
    (pastSales as any).total,
    (pastSales as any).count,
  ));
  if (fields.total_sold_12m === undefined) missing.push('total_sold_12m');

  fields.total_sold_volume_aud = asInt(firstDefined(
    root.soldVolumePast12Months,
    (pastSales as any).priceSum,
    (pastSales as any).totalValue,
    (pastSales as any).volume,
  ));
  if (fields.total_sold_volume_aud === undefined) missing.push('total_sold_volume_aud');

  fields.avg_sold_price = asNumber(firstDefined(
    root.averageSalePrice,
    (pastSales as any).averagePrice,
    (pastSales as any).average,
  ));
  if (fields.avg_sold_price === undefined) missing.push('avg_sold_price');

  fields.median_sold_price = asNumber(firstDefined(
    root.medianSalePrice,
    (pastSales as any).medianPrice,
    (pastSales as any).median,
  ));
  if (fields.median_sold_price === undefined) missing.push('median_sold_price');

  fields.avg_days_on_market = asNumber(firstDefined(
    root.averageDaysOnMarket,
    (pastSales as any).averageDaysOnMarket,
    (pastSales as any).avgDaysOnMarket,
  ));
  if (fields.avg_days_on_market === undefined) missing.push('avg_days_on_market');

  fields.median_days_on_market = asInt(firstDefined(
    root.medianDaysOnMarket,
    (pastSales as any).medianDaysOnMarket,
  ));
  if (fields.median_days_on_market === undefined) missing.push('median_days_on_market');

  // Team size — prefer explicit count, fall back to members array length
  const members = asArray(firstDefined(root.members, root.teamMembers, root.agents));
  fields.team_size = asInt(firstDefined(
    root.agentsCount,
    root.membersCount,
    members?.length,
  ));
  if (fields.team_size === undefined) missing.push('team_size');

  // Rating
  const rating = root.rating ?? root.reviews ?? {};
  fields.avg_agent_rating = asNumber(firstDefined(
    (rating as any).value,
    (rating as any).average,
    (rating as any).score,
    root.averageRating,
  ));
  if (fields.avg_agent_rating === undefined) missing.push('avg_agent_rating');

  fields.total_reviews = asInt(firstDefined(
    (rating as any).count,
    (rating as any).reviewsCount,
    (rating as any).total,
    root.reviewsCount,
  ));
  if (fields.total_reviews === undefined) missing.push('total_reviews');

  // Awards / tier badges — normalise any array-like payload
  const awards = asArray(firstDefined(root.awards, root.tierBadges, root.badges));
  if (awards) fields.awards = awards;
  else missing.push('awards');

  // Franchise brand
  fields.franchise_brand = asString(firstDefined(
    root.brand?.name,
    root.franchiseName,
    root.brandName,
    root.group?.name,
  ));
  if (!fields.franchise_brand) missing.push('franchise_brand');

  // About text
  fields.about_text = asString(firstDefined(
    root.description,
    root.about,
    root.aboutUs,
    root.aboutText,
    root.profile?.description,
  ));
  if (!fields.about_text) missing.push('about_text');

  // Trading name + ABN (often in footer / legal metadata)
  fields.trading_name = asString(firstDefined(root.tradingName, root.legalName));
  fields.abn = asString(firstDefined(root.abn, root.australianBusinessNumber));

  // Testimonials / reviews (cap 20)
  const testimonials = asArray(firstDefined(root.testimonials, root.reviews?.items, root.reviewsList));
  if (testimonials) fields.agency_testimonials = testimonials.slice(0, 20);

  // Office photos (cap 10)
  const photos = asArray(firstDefined(root.photos, root.images, root.officePhotos));
  if (photos) {
    fields.office_photo_urls = photos
      .map((p: any) => asString(typeof p === 'string' ? p : firstDefined(p?.url, p?.src, p?.href, (p?.server && p?.uri) ? `${p.server}${p.uri}` : null)))
      .filter((s): s is string => !!s)
      .slice(0, 10);
    if (fields.office_photo_urls.length === 0) delete fields.office_photo_urls;
  }

  // Suburbs served (agency's own declaration)
  const suburbs = asArray(firstDefined(root.suburbsServed, root.specialistSuburbs, root.servicedSuburbs));
  if (suburbs) {
    fields.declared_suburbs_served = suburbs
      .map((s: any) => asString(typeof s === 'string' ? s : firstDefined(s?.name, s?.suburb, s?.displayName)))
      .filter((s): s is string => !!s);
    if (fields.declared_suburbs_served.length === 0) delete fields.declared_suburbs_served;
  }

  // Contact / branding — we fill these only when the current DB value is null
  // (the update builder downstream checks). Extract unconditionally here.
  fields.logo_url = asString(firstDefined(
    root.logo?.url,
    root.branding?.logo,
    root.branding?.logoUrl,
    root.logoUrl,
    typeof root.logo === 'string' ? root.logo : null,
  ));
  fields.address = asString(firstDefined(
    root.address?.streetAddress,
    root.address?.line1,
    root.addressLine1,
    typeof root.address === 'string' ? root.address : null,
  ));
  fields.phone = asString(firstDefined(root.phoneNumber, root.phone, root.contactPhone));
  fields.email = asString(firstDefined(root.email, root.contactEmail));
  fields.website = asString(firstDefined(root.website, root.websiteUrl, root.url));

  fields.brand_color_primary = asString(firstDefined(
    root.branding?.primaryColor,
    root.branding?.primaryColour,
    root.brand?.colour?.primary,
    root.brand?.primaryColor,
  ));
  fields.brand_color_text = asString(firstDefined(
    root.branding?.textColor,
    root.branding?.textColour,
    root.brand?.colour?.text,
    root.brand?.textColor,
  ));

  return { fields, paths_missing: missing };
}

// ─── Main handler ─────────────────────────────────────────────────────────
serveWithAudit('pulseAgencyEnrich', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401);
    if (user.role !== 'master_admin') return errorResponse('Forbidden', 403);
  }

  const admin = getAdminClient();
  const startedAt = Date.now();

  if (!APIFY_TOKEN) {
    return errorResponse('APIFY_TOKEN is not configured on this environment', 500);
  }

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const trigger = String(body.trigger || 'manual');
  const priorityMode = String(body.priority_mode || 'stale');
  const maxAgencies = Math.max(1, Math.min(200, Number(body.max_agencies) || 50));
  const reaAgencyIdOverride = body.rea_agency_id ? String(body.rea_agency_id) : null;
  const debugDump = body.debug_dump === true;
  const dryRun = body.dry_run === true;

  // Circuit breaker
  const breaker = await breakerCheckOpen(admin, SOURCE_ID);
  if (breaker.open) {
    return jsonResponse({
      skipped: true,
      reason: 'circuit_breaker_open',
      consecutive_failures: breaker.consecutiveFailures,
      reopen_at: breaker.reopenAt,
    });
  }

  const ctx = await startRun({
    admin,
    sourceId: SOURCE_ID,
    syncType: 'pulse_agency_enrich',
    triggeredBy: trigger,
    triggeredByName: `pulseAgencyEnrich:${trigger}:${priorityMode}`,
    inputConfig: {
      trigger,
      priority_mode: priorityMode,
      max_agencies: maxAgencies,
      rea_agency_id_override: reaAgencyIdOverride,
      debug_dump: debugDump,
      dry_run: dryRun,
      actor_slug: ACTOR_SLUG,
      batch_size: BATCH_SIZE,
      max_batches_per_invocation: MAX_BATCHES_PER_INVOCATION,
      apify_wait_secs: APIFY_WAIT_SECS,
    },
  });
  const syncLogId = ctx.syncLogId;

  try {
    // ── Candidate selection ────────────────────────────────────────────
    const SELECT_COLS = 'id, name, rea_agency_id, logo_url, address, phone, email, website, brand_color_primary, brand_color_text, agency_profile_fetched_at, total_sold_12m, avg_sold_price, avg_days_on_market';
    let candidates: any[] = [];

    if (reaAgencyIdOverride) {
      const { data } = await admin
        .from('pulse_agencies')
        .select(SELECT_COLS)
        .eq('rea_agency_id', reaAgencyIdOverride)
        .limit(1);
      candidates = data || [];
    } else {
      let query = admin
        .from('pulse_agencies')
        .select(SELECT_COLS)
        .not('rea_agency_id', 'is', null)
        .limit(maxAgencies);

      if (priorityMode === 'fresh') {
        query = query.order('agency_profile_fetched_at', { ascending: false, nullsFirst: false });
      } else {
        // 'stale' | 'all' — stalest first, NULLs first (never-fetched lead)
        query = query.order('agency_profile_fetched_at', { ascending: true, nullsFirst: true });
      }

      const { data } = await query;
      candidates = data || [];
    }

    candidates = candidates.filter(c => c.rea_agency_id && c.name);

    if (candidates.length === 0) {
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: 0,
        recordsUpdated: 0,
        sourceLabel: 'pulse_agency_enrich · no candidates',
        suburb: 'no candidates',
        customSummary: { message: 'No agencies need enrichment (rea_agency_id required)', candidates: 0 },
      });
      return jsonResponse({ success: true, processed: 0, updated: 0, errors: 0, batches: 0, message: 'No candidates' });
    }

    if (dryRun) {
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: candidates.length,
        sourceLabel: `pulse_agency_enrich · ${candidates.length} (dry run)`,
        suburb: `${candidates.length} agencies (dry run)`,
        customSummary: { candidates: candidates.length, urls: candidates.map(c => buildAgencyUrl(c.name, c.rea_agency_id)) },
      });
      return jsonResponse({ success: true, dry_run: true, candidates: candidates.length, urls: candidates.map(c => buildAgencyUrl(c.name, c.rea_agency_id)) });
    }

    // ── Process in batches ─────────────────────────────────────────────
    const stats = {
      candidates: candidates.length,
      processed: 0,
      updated: 0,
      errors: 0,
      batches_attempted: 0,
      batches_succeeded: 0,
      items_returned: 0,
      apify_run_ids: [] as string[],
      apify_billed_cost_usd: 0,
      value_producing_cost_usd: 0,
      paths_missing_histogram: {} as Record<string, number>,
    };

    const debugDumps: any[] = [];
    const errorMsgs: string[] = [];
    const batchPayloads: any[] = [];

    // Build URL→candidate map for fast lookup after each batch
    const urlToCandidate = new Map<string, any>();
    for (const c of candidates) {
      urlToCandidate.set(buildAgencyUrl(c.name, c.rea_agency_id), c);
    }
    const allUrls = Array.from(urlToCandidate.keys());

    for (let bIdx = 0; bIdx < allUrls.length; bIdx += BATCH_SIZE) {
      if (stats.batches_attempted >= MAX_BATCHES_PER_INVOCATION) break;
      if (Date.now() - startedAt > WALL_BUDGET_MS) break;

      const batchUrls = allUrls.slice(bIdx, bIdx + BATCH_SIZE);
      const batchIndex = Math.floor(bIdx / BATCH_SIZE);
      stats.batches_attempted++;

      const batchLabel = `batch_${batchIndex}`;
      const result = await runAgencyBatch(batchUrls, batchLabel);
      if (result.runId) stats.apify_run_ids.push(result.runId);

      stats.apify_billed_cost_usd += 0.007;
      if (!result.ok) {
        stats.errors++;
        errorMsgs.push(`${batchLabel}: ${result.error || result.status}`);
        batchPayloads.push({ batch_index: batchIndex, ok: false, status: result.status, run_id: result.runId, error: result.error });
        recordError(ctx, `${batchLabel}: ${result.error || result.status}`, 'warn');
        continue;
      }

      stats.batches_succeeded++;
      stats.items_returned += result.items.length;
      stats.apify_billed_cost_usd += 0.001 * result.items.length;
      stats.value_producing_cost_usd += 0.007 + 0.001 * result.items.length;

      batchPayloads.push({
        batch_index: batchIndex,
        ok: true,
        status: result.status,
        run_id: result.runId,
        dataset_id: result.datasetId,
        items_count: result.items.length,
        // Keep first batch verbose, later batches sample to avoid bloat
        items_sample: batchIndex === 0 ? result.items.slice(0, 3) : result.items.slice(0, 1),
        log_tail: (result as any).logTail || null,
      });

      // Index results by URL. apify/web-scraper sets request URL on `url`
      // inside our pageFunction return.
      const itemsByUrl = new Map<string, any>();
      for (const item of result.items) {
        const itemUrl = String(item?.url || item?.pageUrl || item?.requestUrl || '').trim();
        if (itemUrl) itemsByUrl.set(itemUrl, item);
      }

      // Process each candidate in this batch
      for (const url of batchUrls) {
        const cand = urlToCandidate.get(url);
        if (!cand) continue;

        const item = itemsByUrl.get(url);
        const now = new Date();

        // Not returned by Apify — mark error + move on (breaker will trip if
        // this happens batch-wide).
        if (!item) {
          await admin.from('pulse_agencies').update({
            agency_profile_fetched_at: now.toISOString(),
            agency_profile_fetch_status: 'not_found',
            agency_profile_fetch_error: 'no_apify_result',
            last_sync_log_id: syncLogId,
          }).eq('id', cand.id);
          stats.errors++;
          continue;
        }

        // apify/web-scraper returns our pageFunction's return value shape:
        //   { ok, url, source, rawKeys, payload } or { ok: false, error }
        // The actual REA SSR JSON lives in item.payload; findAgencyRoot
        // unwraps the layers (ArgonautExchange / __NEXT_DATA__ / etc.)
        if (debugDump) {
          const payload = item?.payload || item;
          const preview = item?.ok !== false ? extractAgencyFields(payload) : { fields: {}, paths_missing: ['page_fn_failed'] };
          const root = findAgencyRoot(payload);
          debugDumps.push({
            rea_agency_id: cand.rea_agency_id,
            name: cand.name,
            url,
            ok: item?.ok !== false,
            error: item?.error,
            source: item?.source,
            rawKeys: item?.rawKeys,
            extracted_fields: preview.fields,
            paths_missing: preview.paths_missing,
            payload_keys_top: payload ? Object.keys(payload).slice(0, 60) : null,
            agency_root_keys: root ? Object.keys(root).slice(0, 80) : null,
            agency_root_sample: root
              ? Object.fromEntries(Object.entries(root).slice(0, 30).map(([k, v]) =>
                  [k, typeof v === 'object'
                    ? (Array.isArray(v) ? `[Array len=${(v as any[]).length}]` : `[Object keys=${Object.keys(v as any).slice(0, 10).join(',')}]`)
                    : v]))
              : null,
          });
          stats.processed++;
          continue;
        }

        if (item?.ok === false) {
          await admin.from('pulse_agencies').update({
            agency_profile_fetched_at: now.toISOString(),
            agency_profile_fetch_status: 'error',
            agency_profile_fetch_error: String(item.error || 'page_fn_failed').substring(0, 500),
            last_sync_log_id: syncLogId,
          }).eq('id', cand.id);
          stats.errors++;
          continue;
        }

        const { fields, paths_missing } = extractAgencyFields(item?.payload || item);
        for (const k of paths_missing) {
          stats.paths_missing_histogram[k] = (stats.paths_missing_histogram[k] || 0) + 1;
        }

        // Build update — only include defined fields. For contact/branding,
        // only fill if current DB value is null (don't stomp curated data).
        const update: Record<string, any> = {
          agency_profile_fetched_at: now.toISOString(),
          agency_profile_fetch_status: 'ok',
          agency_profile_fetch_error: null,
          last_sync_log_id: syncLogId,
          last_synced_at: now.toISOString(),
        };

        // Always-overwrite scraped stats
        const overwriteFields: (keyof ExtractedAgencyFields)[] = [
          'total_sold_12m', 'total_sold_volume_aud', 'avg_sold_price', 'median_sold_price',
          'avg_days_on_market', 'median_days_on_market', 'team_size',
          'avg_agent_rating', 'total_reviews',
          'franchise_brand', 'about_text', 'trading_name', 'abn',
          'awards', 'agency_testimonials', 'office_photo_urls', 'declared_suburbs_served',
        ];
        for (const k of overwriteFields) {
          const v = (fields as any)[k];
          if (v !== undefined) update[k] = v;
        }

        // Fill-if-null contact/branding
        const fillIfNull: Array<keyof ExtractedAgencyFields> = [
          'logo_url', 'address', 'phone', 'email', 'website', 'brand_color_primary', 'brand_color_text',
        ];
        for (const k of fillIfNull) {
          const v = (fields as any)[k];
          if (v !== undefined && (cand as any)[k] == null) update[k] = v;
        }

        const { error: updErr } = await admin.from('pulse_agencies').update(update).eq('id', cand.id);
        if (updErr) {
          stats.errors++;
          errorMsgs.push(`update ${cand.id}: ${updErr.message?.substring(0, 150)}`);
          recordError(ctx, `update ${cand.id}: ${updErr.message}`, 'warn');
        } else {
          stats.updated++;

          // SAFR observations for the fields that matter cross-source.
          await Promise.all([
            safrObserve(admin, 'agency', cand.id, 'phone', fields.phone, 'rea_agency_profile'),
            safrObserve(admin, 'agency', cand.id, 'email', fields.email, 'rea_agency_profile'),
            safrObserve(admin, 'agency', cand.id, 'website', fields.website, 'rea_agency_profile'),
            safrObserve(admin, 'agency', cand.id, 'address', fields.address, 'rea_agency_profile'),
          ]);
        }

        stats.processed++;
      }
    }

    // ── Record breaker outcome ────────────────────────────────────────
    if (stats.batches_succeeded > 0) {
      await breakerRecordSuccess(admin, SOURCE_ID);
    } else if (stats.batches_attempted > 0) {
      await breakerRecordFailure(admin, SOURCE_ID);
    }

    for (const e of errorMsgs) recordError(ctx, e, 'warn');

    const summaryMessage = `Enriched ${stats.updated} / ${stats.processed} agencies across ${stats.batches_succeeded} batches. ${stats.errors} errors. Apify billed: $${stats.apify_billed_cost_usd.toFixed(3)}`;
    const finalStatus = stats.errors > stats.processed / 2 ? 'failed' : 'completed';
    const scopeTag = `${stats.candidates} agencies`;

    await endRun(ctx, {
      status: finalStatus,
      sourceLabel: `pulse_agency_enrich · ${scopeTag}`,
      suburb: scopeTag,
      batchNumber: stats.batches_succeeded > 0 ? stats.batches_succeeded : undefined,
      totalBatches: stats.batches_attempted > 0 ? stats.batches_attempted : undefined,
      recordsFetched: stats.items_returned,
      recordsUpdated: stats.updated,
      recordsDetail: {
        processed: stats.processed,
        updated: stats.updated,
        errors: stats.errors,
        paths_missing_histogram: stats.paths_missing_histogram,
      },
      apifyRunIds: stats.apify_run_ids,
      apifyBilledCostUsd: stats.apify_billed_cost_usd,
      valueProducingCostUsd: stats.value_producing_cost_usd,
      rawPayload: {
        source: SOURCE_ID,
        actor_slug: ACTOR_SLUG,
        batches: batchPayloads,
        debug_dumps: debugDumps.length > 0 ? debugDumps : undefined,
      },
      customSummary: {
        message: summaryMessage,
        ...stats,
        debug_dump: debugDump,
        debug_dumps: debugDumps,
      },
    });

    return jsonResponse({
      success: true,
      syncLogId,
      processed: stats.processed,
      updated: stats.updated,
      errors: stats.errors,
      batches: stats.batches_succeeded,
      batches_attempted: stats.batches_attempted,
      duration_ms: Date.now() - startedAt,
      paths_missing_histogram: stats.paths_missing_histogram,
      apify_billed_cost_usd: stats.apify_billed_cost_usd,
      ...(debugDump ? { debug_dumps: debugDumps } : {}),
    });
  } catch (err: any) {
    recordError(ctx, err, 'fatal');
    await endRun(ctx, {
      status: 'failed',
      errorMessage: (err?.message || 'unknown').substring(0, 500),
      customSummary: {
        error_stack: err?.stack ? String(err.stack).substring(0, 2000) : null,
        fatal: true,
      },
    });
    const msg = String(err?.message || '');
    const isUpstream = ['Apify', 'apify', 'HTTP_', 'TIMED-OUT', 'READY'].some(tag => msg.includes(tag));
    if (isUpstream) {
      await breakerRecordFailure(admin, SOURCE_ID);
    }
    console.error('pulseAgencyEnrich fatal:', err);
    return errorResponse(err?.message || 'pulseAgencyEnrich failed', 500);
  }
});
