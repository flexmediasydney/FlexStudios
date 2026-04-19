import { getAdminClient, createEntities, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import {
  cleanEmailList,
  pickPrimaryEmail,
  parseEmailString,
  rejectedEmailList,
  isMiddlemanEmail,
} from '../_shared/emailCleanup.ts';
import { startRun, endRun, recordError } from '../_shared/observability.ts';

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

// ── Wall-clock budget ───────────────────────────────────────────────────────
// Supabase edge runtime kills functions at ~150s. We track a per-invocation
// wall budget so the cumulative cost of multiple Apify calls (one per suburb)
// can't blow past the wall. When the budget runs out we finalize the sync log
// as 'timed_out' and return 200 with partial results, instead of letting the
// edge runtime issue a 504 Gateway Timeout we have no way to handle.
const WALL_BUDGET_MS = 130_000;
let invocationStart = 0;
function wallRemainingMs(): number {
  return Math.max(0, WALL_BUDGET_MS - (Date.now() - invocationStart));
}
function wallExceeded(): boolean { return wallRemainingMs() <= 0; }

// ── Apify actor runner ──────────────────────────────────────────────────────

interface ApifyRunResult {
  items: any[];
  runId: string | null;
  datasetId: string | null;
  // OP03 (2026-04-18): capture Apify's authoritative billed cost + runtime so
  // we can write result_summary.apify_billed_cost_usd / runtime_secs per run.
  // Both read from the Apify run object's `usageTotalUsd` and `stats.runTimeSecs`.
  // Nullable because aborted/timed-out/failed runs may not expose them.
  usageTotalUsd: number | null;
  runTimeSecs: number | null;
  status: string | null;
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

  // Baseline result shape — every exit path returns a full ApifyRunResult so
  // the caller doesn't have to null-check individual fields.
  const empty = (runId: string | null = null, datasetId: string | null = null, status: string | null = null): ApifyRunResult => ({
    items: [],
    runId,
    datasetId,
    usageTotalUsd: null,
    runTimeSecs: null,
    status,
  });

  // Respect the global wall budget — caller may have already burned most of it.
  // Reserve 5s grace so a finalize/jsonResponse path still has time to run.
  const remaining = Math.max(0, wallRemainingMs() - 5_000);
  if (remaining < 5_000) {
    console.warn(`Apify ${label}: wall budget exhausted (${wallRemainingMs()}ms left), skipping`);
    return empty();
  }

  const safeId = actorSlug.replace('/', '~');
  const url = `${APIFY_BASE}/acts/${safeId}/runs?timeout=${timeoutSecs}&waitForFinish=${timeoutSecs}`;

  // Fetch timeout = min(Apify timeout + 10s grace, 120s, wall remaining).
  // The wall cap prevents one stalled call from consuming a budget meant for
  // multiple suburbs in a batch.
  const fetchTimeoutMs = Math.min(timeoutSecs * 1000 + 10_000, 120_000, remaining);

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }, fetchTimeoutMs);
  } catch (err: any) {
    console.error(`Apify ${label} run submit failed (aborted/network): ${err?.message || err}`);
    return empty();
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`Apify ${label} failed: ${resp.status} — ${body.substring(0, 200)}`);
    return empty();
  }

  const runData = await resp.json().catch(() => ({}));
  let runId = runData?.data?.id || null;
  let status = runData?.data?.status;
  let datasetId = runData?.data?.defaultDatasetId || null;
  // OP03 (2026-04-18): Apify's run object carries billed cost in usageTotalUsd
  // (sum across all chargeable events). runtime is data.stats.runTimeSecs.
  // Captured on every poll and on the initial submit so even early-exit paths
  // retain whatever the last-seen values are.
  let usageTotalUsd: number | null = typeof runData?.data?.usageTotalUsd === 'number' ? runData.data.usageTotalUsd : null;
  let runTimeSecs: number | null = typeof runData?.data?.stats?.runTimeSecs === 'number' ? runData.data.stats.runTimeSecs : null;

  // Poll if still running — cap total poll time at timeoutSecs so we respect the caller's budget.
  // Also cap by the wall remaining so we don't blow past the 150s edge runtime kill.
  if (status === 'RUNNING' || status === 'READY') {
    const pollBudgetMs = Math.min(timeoutSecs * 1000, 120_000, Math.max(0, wallRemainingMs() - 5_000));
    const pollStart = Date.now();
    while (Date.now() - pollStart < pollBudgetMs && !wallExceeded()) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const pollResp = await fetchWithTimeout(`${APIFY_BASE}/actor-runs/${runId}`, {
          headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
        }, 15_000);
        const pollData = await pollResp.json().catch(() => ({}));
        status = pollData?.data?.status;
        datasetId = pollData?.data?.defaultDatasetId || datasetId;
        if (typeof pollData?.data?.usageTotalUsd === 'number') usageTotalUsd = pollData.data.usageTotalUsd;
        if (typeof pollData?.data?.stats?.runTimeSecs === 'number') runTimeSecs = pollData.data.stats.runTimeSecs;
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
    return { items: [], runId, datasetId, usageTotalUsd, runTimeSecs, status };
  }

  try {
    const datasetTimeout = Math.min(30_000, Math.max(2_000, wallRemainingMs() - 3_000));
    const itemsResp = await fetchWithTimeout(`${APIFY_BASE}/datasets/${datasetId}/items?limit=5000`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    }, datasetTimeout);
    if (!itemsResp.ok) {
      console.error(`Apify ${label}: dataset fetch failed (${itemsResp.status})`);
      return { items: [], runId, datasetId, usageTotalUsd, runTimeSecs, status };
    }
    const items = await itemsResp.json();
    console.log(`Apify ${label}: ${items.length} results (cost=$${(usageTotalUsd ?? 0).toFixed(4)}, runtime=${runTimeSecs ?? '?'}s)`);
    return { items: Array.isArray(items) ? items : [], runId, datasetId, usageTotalUsd, runTimeSecs, status };
  } catch (fetchErr: any) {
    console.error(`Apify ${label}: dataset fetch error: ${fetchErr.message}`);
    return { items: [], runId, datasetId, usageTotalUsd, runTimeSecs, status };
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
 *
 * IMPORTANT: auction phrasing like "Auction Unless Sold Prior", "Auction (unless sold prior)",
 * "Auction | Unless Sold Prior", "AUCTION UNLESS SOLD PRIOR!" etc. contains the substring
 * "sold" but the listing is still FOR SALE. We must not flip these to `sold`. We check
 * for these conditional-auction phrases BEFORE the "sold" substring check, and we also
 * guard the "sold" match with negative-context checks.
 */
function parseListingStatus(priceText: string | null, defaultType: string): string {
  if (!priceText) return defaultType;
  const s = priceText.toLowerCase();
  if (s.includes('under contract') || s.includes('under offer')) return 'under_contract';
  // Conditional-auction phrases: still for_sale, just auctioning with a "sell prior" option
  // Match: "unless sold", "if not sold", "before sold", "prior to sold" (with any punctuation/spacing)
  if (/\b(unless|if\s+not|before|prior\s+to)\s+sold\b/.test(s)) return defaultType;
  if (s.includes('auction')) return defaultType; // Still active, just auction method
  if (s.includes('sold')) return 'sold';
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
 * Expand {suburb} / {suburb-slug} / {suburb-full} / {postcode} placeholders in
 * every string value of the actor input template. Non-string values pass
 * through unchanged. Safe to call multiple times — idempotent on already-
 * inflated strings.
 *
 * OP01 (2026-04-18): added {suburb-full} = "<name> NSW <postcode>" for actors
 * that resolve location by free-text (e.g. websift REA agent profiles). Note
 * that direct invocations to pulseDataSync (not through pulseFireScrapes) do
 * NOT have the postcode in scope here, so we fall back to "{suburb} NSW".
 * Cron-driven runs inflate in pulseFireScrapes where the postcode IS known;
 * by the time the queue payload arrives here, the template strings are
 * already literal.
 */
function inflateSuburbTemplate(input: Record<string, any>, suburb: string): Record<string, any> {
  const slug = suburb.toLowerCase().replace(/\s+/g, '-');
  const suburbFullFallback = `${suburb} NSW`;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') {
      out[k] = v
        .replace(/\{suburb-full\}/g, suburbFullFallback)
        .replace(/\{suburb-slug\}/g, slug)
        .replace(/\{suburb\}/g, suburb)
        .replace(/\{postcode\}/g, '');
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
  // Observability context (shared module). Nullable because dry_run skips the
  // sync_log entirely — the outer catch path falls back to raw admin writes
  // when ctx is null. See startRun invocation further down.
  let ctx: Awaited<ReturnType<typeof startRun>> | null = null;
  // Initialize wall budget for this invocation. Reset every call so the global
  // never carries over between cold/warm starts.
  invocationStart = Date.now();
  // OP03 (2026-04-18): hoist apifyStats + apifyRunIds out of the try-block so
  // the outer catch can still persist cost data when we bail with an error.
  // Otherwise a mid-run throw would wipe the accounting and result_summary
  // would lose the partial invoice line.
  const apifyStats = {
    apify_billed_cost_usd: 0,
    value_producing_cost_usd: 0,
    runtime_secs: 0,
    runs_attempted: 0,
    runs_succeeded: 0,
  };
  const apifyRunIds: Record<string, string | null> = {};
  function accumulateApify(result: ApifyRunResult) {
    apifyStats.runs_attempted += 1;
    if (typeof result.usageTotalUsd === 'number') {
      apifyStats.apify_billed_cost_usd += result.usageTotalUsd;
    }
    if (typeof result.runTimeSecs === 'number') {
      apifyStats.runtime_secs += result.runTimeSecs;
    }
    if (result.status === 'SUCCEEDED') {
      apifyStats.runs_succeeded += 1;
      if (result.items.length > 0 && typeof result.usageTotalUsd === 'number') {
        apifyStats.value_producing_cost_usd += result.usageTotalUsd;
      }
    }
  }
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
      // Explicit suburb override for the main-table `suburb` column (migration
      // 121). Queue dispatches set this; manual/test calls can omit it and
      // we'll fall back to suburbs[0].
      suburb: suburbOverride = null,
      triggered_by = null,
      triggered_by_name = null,
      // Bounding box mode: single URL covers entire region (legacy params)
      listingsStartUrl = null,
      maxListingsTotal = 0,
      // v3 DB-driven config — when supplied, this is the Apify input template
      // from pulse_source_configs.actor_input (already inflated for single-suburb
      // dispatches, or raw with {suburb}/{suburb-slug} for multi-suburb batches).
      actorInput = null,
      // Batch attribution (migration 088) — set by pulseFireScrapes when this
      // invocation is one leg of a chunked dispatch. Persisted to pulse_sync_logs
      // so the UI can say "Batch 3/10" on each suburb's row.
      batch_id = null,
      batch_number = null,
      total_batches = null,
      // Queue-based dispatch (migration 093). Set by pulseFireWorker via
      // pulse_fire_queue_dispatch_via_net. pulseDataSync MUST call back via
      // pulse_fire_queue_record_outcome on success/failure so the queue row
      // transitions out of 'running' state. If this id is present and we
      // forget to call back, the worker's reconciler will re-queue after 5min.
      fire_queue_id = null,
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
    // apifyStats + apifyRunIds hoisted above the try-block so the catch path
    // can also persist partial-run cost info (see OP03 fix at top of handler).

    // Log sync start
    // ── Migration 095 + shared observability ──────────────────────────
    // startRun inserts the sync_log row and seeds pulse_sync_log_payloads
    // input_config eagerly so the UI drill-through works mid-run. Heavy
    // JSONB (raw_payload, result_summary, records_detail) still routes to
    // the side-table at endRun time. Dry-run skips this entirely — matches
    // prior behavior where no sync_log row was written for dry runs.
    if (!dryRun) {
      // Resolve the suburb scalar for the main-table column (migration 121).
      // Prefer the explicit `suburb` body param (set by the queue dispatch
      // RPC) and fall back to suburbs[0] for non-queue callers.
      const suburbForLog: string | null =
        (typeof suburbOverride === 'string' && suburbOverride.length > 0)
          ? suburbOverride
          : (Array.isArray(suburbs) && suburbs.length > 0 ? String(suburbs[0]) : null);

      ctx = await startRun({
        admin,
        sourceId: source_id || 'full_sweep',
        syncType: source_id || 'full_sweep',
        triggeredBy: triggered_by || 'manual',
        triggeredByName: triggered_by_name || `pulseDataSync:${source_id || 'full_sweep'}`,
        inputConfig: {
          suburbs,
          state,
          maxAgentsPerSuburb,
          maxListingsPerSuburb,
          skipListings,
          actorInput,
          actor_slug: actorSlug,
          approach: configApproach,
          batch_id,
          batch_number,
          total_batches,
          suburb: suburbForLog,
        },
      });
      syncLogId = ctx.syncLogId;

      // Backfill the columns startRun doesn't set (source_label, suburb,
      // batch_id/number/total). startRun writes a generic label ("source · by")
      // — the pulseDataSync UI wants the richer one passed in by callers, plus
      // the queue-dispatch batch attribution.
      try {
        const headerPatch: Record<string, any> = {};
        if (source_label) headerPatch.source_label = source_label;
        if (suburbForLog) headerPatch.suburb = suburbForLog;
        if (typeof batch_id === 'string' && batch_id.length > 0) headerPatch.batch_id = batch_id;
        if (Number.isInteger(batch_number)) headerPatch.batch_number = Number(batch_number);
        if (Number.isInteger(total_batches)) headerPatch.total_batches = Number(total_batches);
        if (Object.keys(headerPatch).length > 0) {
          await admin.from('pulse_sync_logs').update(headerPatch).eq('id', syncLogId);
        }
      } catch (pErr) {
        console.warn('pulseDataSync: header backfill failed (non-fatal):', (pErr as any)?.message);
      }
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
      accumulateApify(bbResult);
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
      accumulateApify(bbResult);
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

    let timedOut = false;
    const suburbsProcessed: string[] = [];
    const suburbsSkipped: string[] = [];

    for (const suburb of suburbs) {
      // Wall budget check — bail before next Apify call if we have no budget
      // to safely run + finalize. Caller gets a 200 with timed_out=true and
      // a partial result instead of a 504 from the edge runtime.
      if (wallRemainingMs() < 15_000) {
        timedOut = true;
        suburbsSkipped.push(suburb);
        console.warn(`pulseDataSync: wall budget low (${wallRemainingMs()}ms), skipping remaining suburbs starting at ${suburb}`);
        continue;
      }
      suburbsProcessed.push(suburb);
      const suburbSlug = suburb.toLowerCase().replace(/\s+/g, '-');

      if (useV3PerSuburb) {
        // v3: single-actor pipeline driven by config actor_slug + actor_input
        const inflated = inflateSuburbTemplate(actorInput, suburb);

        if (isWebsiftActor) {
          // websift = REA agent profiles pipeline
          console.log(`[${suburb}] v3 websift with actor_input=${JSON.stringify(inflated).substring(0, 120)}...`);
          const reaResult = await runApifyActor(actorSlug, inflated, `websift-${suburb}`, 180);
          accumulateApify(reaResult);
          reaResult.items.forEach(a => { a._suburb = suburb; a._source = 'rea'; });
          allReaAgents.push(...reaResult.items);
          if (reaResult.runId) apifyRunIds[`websift-${suburb}`] = reaResult.runId;
        } else if (isAzzouzanaActor) {
          // azzouzana = REA listings pipeline
          console.log(`[${suburb}] v3 azzouzana with actor_input=${JSON.stringify(inflated).substring(0, 120)}...`);
          const listResult = await runApifyActor(actorSlug, inflated, `listings-${suburb}`, 120);
          accumulateApify(listResult);
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
      // OP01 (2026-04-18): legacy path ran with bare "<suburb> <state>" which
      // fuzzy-matched wrong on many common suburb names (Randwick, Sydney,
      // Mosman — 80% silent-zero rate). v3 config-driven path now uses
      // {suburb-full} inflated to "<name> NSW <postcode>" in pulseFireScrapes.
      // Legacy callers have to pass postcode explicitly via body.postcode if
      // they want the same disambiguation here.
      if (maxAgentsPerSuburb > 0) {
        console.log(`[${suburb}] Running websift REA agents (legacy)...`);
        const legacyPostcode = (body.postcode || '').toString().trim();
        const legacyLocation = legacyPostcode
          ? `${suburb} ${state} ${legacyPostcode}`
          : `${suburb} ${state}`;
        const reaResult = await runApifyActor('websift/realestateau', {
          location: legacyLocation,
          maxPages: Math.ceil(maxAgentsPerSuburb / 10),
          fullScrape: true,
          sortBy: 'SUBURB_SALES_PERFORMANCE',
        }, `websift-${suburb}`, 180);
        accumulateApify(reaResult);
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
        accumulateApify(listResult);
        listResult.items.forEach(l => { l._suburb = suburb; l._source = 'rea'; });
        allListings.push(...listResult.items);
        if (listResult.runId) apifyRunIds[`listings-${suburb}`] = listResult.runId;
      }
    }

    // If wall budget ran out mid-loop and we haven't done the early-skip dance
    // for all unprocessed suburbs, finalize the sync log as 'timed_out' with
    // partial data and return 200. Skips heavy post-processing (Step 3+) since
    // we have no budget to safely run it.
    if (timedOut || wallExceeded()) {
      console.warn(`pulseDataSync: timed out — processed ${suburbsProcessed.length}/${suburbs.length} suburbs, ${allReaAgents.length} agents + ${allListings.length} listings collected (skipping post-processing)`);
      if (ctx) {
        try {
          await endRun(ctx, {
            status: 'timed_out',
            errorMessage: `Wall-clock budget (${WALL_BUDGET_MS}ms) exceeded after ${suburbsProcessed.length}/${suburbs.length} suburbs`,
            apifyRunId: Object.values(apifyRunIds).filter(Boolean).join(',') || undefined,
            recordsFetched: allReaAgents.length + allListings.length,
            // OP03: cost visibility even on timed-out runs — these still cost
            // money because the Apify actor ran; we just didn't finish post-
            // processing. Matters for daily cost reconciliation.
            apifyBilledCostUsd: apifyStats.apify_billed_cost_usd,
            valueProducingCostUsd: apifyStats.value_producing_cost_usd,
            customSummary: {
              timed_out: true,
              suburbs_processed: suburbsProcessed,
              suburbs_skipped: suburbsSkipped,
              agents_collected: allReaAgents.length,
              listings_collected: allListings.length,
              runtime_secs: apifyStats.runtime_secs,
              apify_runs_attempted: apifyStats.runs_attempted,
              apify_runs_succeeded: apifyStats.runs_succeeded,
              apify_run_ids: apifyRunIds,
              items_processed: allReaAgents.length + allListings.length,
              note: 'Post-processing skipped — partial data not persisted to live tables.',
            },
          });
        } catch (logErr) {
          console.error('pulseDataSync: failed to mark sync log as timed_out:', logErr);
        }
      }
      // Queue callback (migration 093): timeout counts as a transient failure
      // so the worker reschedules with backoff rather than dead-lettering.
      if (fire_queue_id) {
        try {
          await admin.rpc('pulse_fire_queue_record_outcome', {
            p_id: fire_queue_id,
            p_success: false,
            p_error: `pulseDataSync wall-budget exceeded (${suburbsProcessed.length}/${suburbs.length} suburbs)`,
            p_category: 'transient',
            p_sync_log_id: syncLogId,
          });
        } catch (qErr) {
          console.error('pulseDataSync: fire_queue callback (timeout) failed:', qErr);
        }
      }
      return jsonResponse({
        success: false,
        timed_out: true,
        _version: 'v2.0',
        suburbs_processed: suburbsProcessed,
        suburbs_skipped: suburbsSkipped,
        agents_collected: allReaAgents.length,
        listings_collected: allListings.length,
        sync_log_id: syncLogId,
        apify_run_ids: apifyRunIds,
        message: `Edge function wall budget exceeded after ${suburbsProcessed.length}/${suburbs.length} suburbs. Re-run for remaining suburbs.`,
      });
    }

    console.log(`Raw data: ${allReaAgents.length} REA agents, ${allListings.length} listings`);

    // ── Step 3: Process agents (REA-only, no merge needed) ──────────────

    const processedAgents: any[] = [];

    for (const rea of allReaAgents) {
      const reaName = rea.name || '';
      const reaMobile = normalizeMobile(rea.mobile || '');

      // Integrity scoring: REA-only, via shared helper (migration 106).
      // At this point (initial processing) we haven't cross-enriched yet,
      // so email/photo are typically absent. They arrive later in Step 6
      // and pulseDetailEnrich, both of which recompute via the same helper.
      // We fall back to a static calc if the RPC hasn't deployed yet.
      let integrityScore: number;
      try {
        const { data: scored } = await admin.rpc('pulse_compute_integrity_score', {
          p_has_rea_profile:    !!rea.profile_url,
          p_has_email:          !!rea.email,
          p_email_is_clean:     !!(rea.email && !isMiddlemanEmail(rea.email)),
          p_email_is_detail:    false,
          p_email_multi_source: false,
          p_has_mobile:         !!reaMobile,
          p_mobile_is_detail:   false,
          p_has_photo:          !!(rea.image || rea.photo_url || rea.profile_image),
          p_has_agency:         !!rea.agency?.name,
          p_has_rea_agent_id:   !!rea.salesperson_id,
        });
        integrityScore = typeof scored === 'number' ? scored : 50;
      } catch {
        // RPC may not exist yet (pre-106 deployment). Fallback to legacy formula.
        integrityScore = 50;
        if (reaMobile) integrityScore += 10;
        if (rea.agency?.name) integrityScore += 5;
      }

      const searchStats = rea.search_stats || {};
      const profileStats = rea.profile_stats || {};
      const reviews = rea.reviews || {};

      processedAgents.push({
        full_name: reaName,
        email: rea.email || null, // May come from websift, also cross-enriched from listing data
        // B46: normalize primary phone fields with the same JS helper used
        // everywhere else in this file so the value written here matches the
        // shape pulse_merge_contact / pulse_normalize_phone would produce on
        // alternates. Prevents drift where mobile/business_phone keep the
        // raw "+614…" / "(02) …" form while alternates get normalized.
        mobile: normalizeMobile(rea.mobile) || null,
        business_phone: normalizeMobile(rea.businessPhone) || null,
        phone: normalizeMobile(rea.businessPhone) || null,
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
        // ── Migration 098: capture richer review data ────────────────
        // Aggregated review tags ([{tag, count}, ...]) — high-signal for
        // competitive intelligence. E.g. "Professional: 254, Great negotiator: 68"
        reviews_compliments: Array.isArray(reviews.compliments) && reviews.compliments.length > 0
          ? JSON.stringify(reviews.compliments.slice(0, 30))
          : null,
        // Most recent review (role + rating + content) for sentiment tracking
        reviews_latest: reviews.latest_review && typeof reviews.latest_review === 'object'
          ? JSON.stringify(reviews.latest_review)
          : null,
        awards: rea.awards || null,
        speciality_suburbs: rea.specialities || null,
        // ── Migration 098: nickname/first-name ──────────────────────
        friendly_name: rea.friendly_name || null,
        social_facebook: rea.social?.facebook || null,
        social_instagram: rea.social?.instagram || null,
        social_linkedin: rea.social?.linkedin || null,
        community_involvement: rea.community_involvement || null,
        biography: rea.description || rea.about || rea.biography || null,
        recent_listing_ids: JSON.stringify((rea.recent_listings || []).slice(0, 10).map((l: any) => l.listing_id)),
        // profile_sales_breakdown = agent-lifetime stats by property type
        sales_breakdown: rea.profile_sales_breakdown ? JSON.stringify(rea.profile_sales_breakdown) : null,
        // ── Migration 098: search_sales_breakdown = suburb-scoped version ──
        // Different semantic from sales_breakdown — this is the agent's
        // performance IN THE CURRENT SEARCH SUBURB. Useful for suburb-specific
        // intelligence ("Sonia in Liverpool: 58 primary-lister sales").
        search_sales_breakdown: rea.search_sales_breakdown && rea.search_sales_breakdown.count > 0
          ? JSON.stringify(rea.search_sales_breakdown)
          : null,
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
        last_sync_log_id: syncLogId,  // Migration 100: drill-back reference
        // B32: always send first_seen_at on upsert. The companion migration
        // installs a pulse_preserve_first_seen_at trigger that keeps the
        // existing value on UPDATE, so it's safe to set unconditionally — on
        // INSERT this records the true first-seen timestamp, on UPDATE the
        // trigger reverts any overwrite back to the stored original.
        first_seen_at: now,
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
          sources: new Set<string>([source_id || 'rea']),
          rea_agency_ids: new Set<string>(),
        });
      }
      const agency = agencyMap.get(key)!;
      agency.active_listings++;
      if (listing.suburb) agency.suburbs.add(listing.suburb);
      const price = parseFloat(String(listing.price || '').replace(/[^0-9.]/g, ''));
      if (price > 0) agency.listing_prices.push(price);

      // ── Bug fix: harvest rea_agency_id from listings too ──
      // Previously only agents' agency_rea_id fed this set, so a listings-only
      // run (any rea_listings_bb_*) couldn't populate pulse_agencies.rea_agency_id
      // even though every listing row carries it. Belle Property Strathfield had
      // rea_agency_id=NULL because of this — fix extracts the ID from the
      // agencyProfileUrl pattern same as the listing-row extractor does.
      const listingAgencyUrl = listing.agencyProfileUrl || '';
      const listingAgencyIdMatch = listingAgencyUrl.match(/agency\/.*?([A-Z0-9]{5,})(?:\/|$)/i);
      if (listingAgencyIdMatch) {
        agency.rea_agency_ids.add(listingAgencyIdMatch[1]);
      }
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
        // Migration 100/134: stamp the drill-back reference on agency upserts
        // too, matching what agents (line ~835) and listings (line ~1305)
        // already do. Without this, the bulk-history emit at the end of the
        // run never records agency touches (its query filters by
        // last_sync_log_id = syncLogId).
        last_sync_log_id: syncLogId,
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
      .select('id, rea_agent_id, agency_name, agency_rea_id, full_name, alternate_mobiles, alternate_emails')
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
          // Migration 098 — parse the new jsonb columns back to objects for upsert
          reviews_compliments: typeof a.reviews_compliments === 'string' ? JSON.parse(a.reviews_compliments) : (a.reviews_compliments || null),
          reviews_latest: typeof a.reviews_latest === 'string' ? JSON.parse(a.reviews_latest) : (a.reviews_latest || null),
          search_sales_breakdown: typeof a.search_sales_breakdown === 'string' ? JSON.parse(a.search_sales_breakdown) : (a.search_sales_breakdown || null),
        };
        // Don't overwrite cross-enriched fields with null
        if (!record.email) delete record.email;
        if (!record.profile_image) delete record.profile_image;
        if (!record.total_listings_active) delete record.total_listings_active;
        // Don't clobber reviews_compliments with null either — if the new scrape
        // didn't return compliments but a previous one did, preserve the old.
        if (!record.reviews_compliments) delete record.reviews_compliments;
        if (!record.reviews_latest) delete record.reviews_latest;
        if (!record.search_sales_breakdown) delete record.search_sales_breakdown;
        if (!record.friendly_name) delete record.friendly_name;
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
      const cleaned: Record<string, any> = {
        ...agency,
        suburbs_active: typeof agency.suburbs_active === 'string' ? JSON.parse(agency.suburbs_active) : (agency.suburbs_active || []),
        data_sources: typeof agency.data_sources === 'string' ? JSON.parse(agency.data_sources) : (agency.data_sources || []),
      };
      // Don't overwrite a previously-captured rea_agency_id with NULL if this
      // particular run didn't carry it (defensive — protects the Belle Property
      // Strathfield fix from being re-broken on future runs that happen to
      // omit the agencyProfileUrl pattern).
      if (cleaned.rea_agency_id == null) {
        delete cleaned.rea_agency_id;
      }
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

      // ── Migration 100 fix: sold_price mapping ────────────────────────
      // Azzouzana returns `price` as the headline price for ALL states:
      //   for_sale/for_rent → asking/rent price
      //   sold             → actual sold price (not asking)
      // Previously we always wrote `price` to asking_price regardless of
      // state, and `sold_price` was left NULL (actor doesn't return that
      // field). Fix: when sold, route `price` to sold_price.
      const parsedPrice = parsePrice(l.price);
      const isSoldListing = listingType === 'sold';

      // Extract dates with robust multi-field fallback
      let extractedListedDate = extractListingDate(l, listingType);
      let extractedSoldDate = extractSoldDate(l);
      // ── Migration 100 fix: listed_date / sold_date fallback ─────────
      // Azzouzana doesn't return any date fields. For new rows we set
      // listed_date = first_seen_at (what we're about to write for this
      // row). For sold listings, also use as sold_date proxy.
      if (!extractedListedDate && isNew) {
        extractedListedDate = now.slice(0, 10); // YYYY-MM-DD
      }
      if (!extractedSoldDate && isSoldListing && isNew) {
        extractedSoldDate = now.slice(0, 10);
      }
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
        // Sold listings: price goes to sold_price, asking_price stays null
        // (since azzouzana doesn't preserve the original asking price).
        asking_price: isSoldListing ? null : parsedPrice,
        sold_price: isSoldListing ? parsedPrice : parsePrice(l.soldPrice),
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
        // Cap at 50 for pathological data; REA listings typically cap at 30-40 photos.
        // The richer `media_items` jsonb column (populated by pulseDetailEnrich) stores
        // the full set with no slice.
        images: Array.isArray(l.images) ? l.images.slice(0, 50) : null,
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
        last_sync_log_id: syncLogId,  // Migration 100: drill-back reference
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

    // ── Resolve a single apify_run_id string for timeline stamping ─────────
    // apifyRunIds is a per-step map (e.g. websift-Willoughby, listings-Willoughby).
    // Migration 141 adds pulse_timeline.apify_run_id so drill-through can cross
    // to the Apify dashboard without the fragile source+time-range match.
    // We join all non-null ids the same way pulse_sync_logs.apify_run_id does.
    const timelineApifyRunId = Object.values(apifyRunIds).filter(Boolean).join(',') || null;

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
          sync_log_id: syncLogId,
          apify_run_id: timelineApifyRunId,
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
          sync_log_id: syncLogId,
          apify_run_id: timelineApifyRunId,
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
          sync_log_id: syncLogId,
          apify_run_id: timelineApifyRunId,
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

      // ── NEW: Collect agency info from listings for create-missing pass ──
      // Listings carry agency_name + agency_rea_id + metadata (logo, phone,
      // address). If we have an agency_rea_id in the listings but not in
      // pulse_agencies, we should INSERT a minimal row — otherwise the
      // listing's agency_rea_id becomes an orphan FK.
      const agencyByReaId = new Map<string, {
        name?: string; phone?: string; email?: string; website?: string;
        address?: string; suburb?: string; state?: string; postcode?: string;
        logo_url?: string; profile_url?: string; listingCount: number;
      }>();
      for (const lr of listingRecords) {
        const aId = lr.agency_rea_id;
        if (!aId) continue;
        const existing = agencyByReaId.get(aId) || { listingCount: 0 };
        if (lr.agency_name && !existing.name) existing.name = lr.agency_name;
        if (lr.agency_logo && !existing.logo_url) existing.logo_url = lr.agency_logo;
        existing.listingCount++;
        agencyByReaId.set(aId, existing);
      }

      if (enrichByReaId.size > 0 || enrichByName.size > 0) {
        // ── NEW: Create missing pulse_agents from listing data ──────────
        // Previously Step 7 only UPDATED existing pulse_agents. Agents
        // discovered in listing payloads (who weren't scraped by websift)
        // became orphan FKs on pulse_listings.agent_rea_id. Now we INSERT
        // minimal rows for them — websift can enrich later.
        // BUG FIX: Previously this used `.select('rea_agent_id').not('rea_agent_id','is',null)`
        // which is capped at 1000 rows by PostgREST. With >8k agents, ~7k existing
        // agents fell outside the Set → upsert(ignoreDuplicates) silently no-op'd →
        // but the subsequent .select().in() still fetched them → first_seen emitted
        // on every discovery (22,934 spurious rows observed). Now we scope the
        // pre-check to the EXACT set of ids we care about.
        const candidateAgentIds = Array.from(enrichByReaId.keys());
        const preCheckIds = new Set<string>();
        if (candidateAgentIds.length > 0) {
          // Chunk to stay under URL length limits on .in() filters
          const CHUNK = 500;
          for (let i = 0; i < candidateAgentIds.length; i += CHUNK) {
            const chunk = candidateAgentIds.slice(i, i + CHUNK);
            const { data: chunkExisting = [] } = await admin.from('pulse_agents')
              .select('rea_agent_id')
              .in('rea_agent_id', chunk);
            for (const r of chunkExisting) if (r.rea_agent_id) preCheckIds.add(r.rea_agent_id);
          }
        }

        const listingOnlyAgentRows: any[] = [];
        for (const [reaId, enrichData] of enrichByReaId.entries()) {
          if (preCheckIds.has(reaId)) continue; // already exists
          // Best-effort name from enrichByName (we don't have it in enrichByReaId).
          // Iterate to find the name-keyed entry that has this reaId.
          let inferredName: string | null = null;
          for (const [nameKey, byName] of enrichByName.entries()) {
            if (byName.reaId === reaId) { inferredName = nameKey; break; }
          }
          if (!inferredName) continue; // can't create without a name

          const emailList = cleanEmailList(enrichData.allEmails || []);
          const primaryEmail = emailList[0] || null;
          listingOnlyAgentRows.push({
            rea_agent_id: reaId,
            full_name: inferredName.replace(/\b\w/g, c => c.toUpperCase()), // title case
            email: primaryEmail,
            all_emails: emailList.length > 0 ? JSON.stringify(emailList) : null,
            mobile: enrichData.phone || null,
            profile_image: enrichData.photo || null,
            job_title: enrichData.jobTitle || null,
            total_listings_active: enrichData.listingCount,
            source: 'rea_listings_bridge', // marker: came from listing data, not websift direct
            data_sources: JSON.stringify(['rea_listings']),
            data_integrity_score: 30, // baseline: listing-only agent (see integrity scoring rubric)
            last_synced_at: now,
            is_in_crm: false,
            is_prospect: false,
          });
        }
        if (listingOnlyAgentRows.length > 0) {
          const { error } = await admin.from('pulse_agents').upsert(listingOnlyAgentRows, {
            onConflict: 'rea_agent_id',
            ignoreDuplicates: true,
          });
          if (error) {
            console.warn(`Create-missing-agents upsert error: ${error.message?.substring(0, 300)}`);
          } else {
            console.log(`Created ${listingOnlyAgentRows.length} agents from listing data (previously orphan FKs)`);
            // Emit first_seen for each bridge-created agent so the Intelligence
            // slideouts have at least one canonical event to render. Prior to
            // migration 132 this path silently skipped timeline entirely;
            // see also pulse_reconcile_bridge_agents_from_listings() which
            // emits first_seen inline for the cron reconciler path.
            try {
              const { data: bridgeInserted = [] } = await admin.from('pulse_agents')
                .select('id, rea_agent_id, full_name, agency_name, agency_rea_id')
                .in('rea_agent_id', listingOnlyAgentRows.map((a: any) => a.rea_agent_id));
              const timelineRows = bridgeInserted.map((pa: any) => ({
                entity_type: 'agent',
                pulse_entity_id: pa.id,
                rea_id: pa.rea_agent_id,
                event_type: 'first_seen',
                event_category: 'system',
                title: `${pa.full_name || 'Unknown agent'} first detected`,
                description: `Agent first seen via listing bridge${pa.agency_name ? ` at ${pa.agency_name}` : ''}`,
                new_value: { agency_name: pa.agency_name, agency_rea_id: pa.agency_rea_id, source: 'rea_listings_bridge' },
                source: 'rea_listings_bridge',
                sync_log_id: syncLogId,
                apify_run_id: timelineApifyRunId,
              }));
              if (timelineRows.length > 0) {
                await admin.from('pulse_timeline').insert(timelineRows);
              }
            } catch (e) {
              console.warn(`bridge-agent first_seen emit failed: ${(e as Error)?.message?.substring(0, 300)}`);
            }
          }
        }

        // ── NEW: Create missing pulse_agencies from listing data ─────────
        const { data: preCheckAg = [] } = await admin.from('pulse_agencies')
          .select('rea_agency_id')
          .not('rea_agency_id', 'is', null);
        const preCheckAgIds = new Set(preCheckAg.map((r: any) => r.rea_agency_id));

        const listingOnlyAgencyRows: any[] = [];
        for (const [reaAgId, info] of agencyByReaId.entries()) {
          if (preCheckAgIds.has(reaAgId)) continue;
          if (!info.name) continue;
          listingOnlyAgencyRows.push({
            rea_agency_id: reaAgId,
            name: info.name,
            logo_url: info.logo_url || null,
            active_listings: info.listingCount,
            source: 'rea_listings_bridge',
            data_sources: JSON.stringify(['rea_listings']),
            last_synced_at: now,
            is_in_crm: false,
          });
        }
        if (listingOnlyAgencyRows.length > 0) {
          const { error } = await admin.from('pulse_agencies').upsert(listingOnlyAgencyRows, {
            onConflict: 'rea_agency_id',
            ignoreDuplicates: true,
          });
          if (error) {
            console.warn(`Create-missing-agencies upsert error: ${error.message?.substring(0, 300)}`);
          } else {
            console.log(`Created ${listingOnlyAgencyRows.length} agencies from listing data (previously orphan FKs)`);
            // Companion first_seen emit — see agent-bridge rationale above.
            try {
              const { data: bridgeInserted = [] } = await admin.from('pulse_agencies')
                .select('id, rea_agency_id, name')
                .in('rea_agency_id', listingOnlyAgencyRows.map((a: any) => a.rea_agency_id));
              const timelineRows = bridgeInserted.map((ag: any) => ({
                entity_type: 'agency',
                pulse_entity_id: ag.id,
                rea_id: ag.rea_agency_id,
                event_type: 'first_seen',
                event_category: 'system',
                title: `${ag.name || 'Unknown agency'} first detected`,
                description: 'Agency first seen via listing bridge',
                new_value: { name: ag.name, rea_agency_id: ag.rea_agency_id, source: 'rea_listings_bridge' },
                source: 'rea_listings_bridge',
                sync_log_id: syncLogId,
                apify_run_id: timelineApifyRunId,
              }));
              if (timelineRows.length > 0) {
                await admin.from('pulse_timeline').insert(timelineRows);
              }
            } catch (e) {
              console.warn(`bridge-agency first_seen emit failed: ${(e as Error)?.message?.substring(0, 300)}`);
            }
          }
        }

        // ── Existing update path: enrich agents we already had ──────────
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

          // Recalculate integrity score via shared DB helper (migration 106).
          // This keeps the formula consistent across pulseDataSync (initial +
          // cross-enrich) and pulseDetailEnrich (detail path). Source-aware:
          // detail_page_lister / detail_page_agency get +5/+3 over list-sourced.
          if (Object.keys(updates).length > 0) {
            const finalEmail = (updates.email || pa.email) as string | null;
            const finalEmailIsClean = !!(finalEmail && !isMiddlemanEmail(finalEmail));
            const finalMobile = (updates.mobile || pa.mobile) as string | null;
            const finalPhoto = (updates.profile_image || pa.profile_image) as string | null;
            // For cross-enrich path, source is 'cross_enrich' (70 confidence) —
            // not 'detail' (95). So `p_email_is_detail` is false here; real
            // detail enrichment bumps these flags via pulseDetailEnrich.
            const { data: scored } = await admin.rpc('pulse_compute_integrity_score', {
              p_has_rea_profile:    !!pa.rea_profile_url,
              p_has_email:          !!finalEmail,
              p_email_is_clean:     finalEmailIsClean,
              p_email_is_detail:    false,
              p_email_multi_source: false,
              p_has_mobile:         !!finalMobile,
              p_mobile_is_detail:   false,
              p_has_photo:          !!finalPhoto,
              p_has_agency:         !!pa.agency_name,
              p_has_rea_agent_id:   !!pa.rea_agent_id,
            });
            updates.data_integrity_score = typeof scored === 'number' ? scored : 50;

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
            sync_log_id: syncLogId,
            apify_run_id: timelineApifyRunId,
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
            sync_log_id: syncLogId,
            apify_run_id: timelineApifyRunId,
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
            sync_log_id: syncLogId,
            apify_run_id: timelineApifyRunId,
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

      // Priority 2: Phone match — includes alternate_mobiles.
      // B23 fix: snapshot was loaded pre-upsert and may be stale w.r.t.
      // detail-enrich runs that happened since. Re-fetch alternate_mobiles
      // just-in-time for this specific agent to ensure freshness.
      if (!matchedCrm) {
        const agentMobilePool = new Set<string>();
        if (agent.mobile) {
          const n = normalizeMobile(agent.mobile);
          if (n) agentMobilePool.add(n);
        }
        // Fresh read of alternate_mobiles + mobile + business_phone
        try {
          const { data: freshAgent } = await admin
            .from('pulse_agents')
            .select('mobile, business_phone, alternate_mobiles, alternate_phones')
            .eq('rea_agent_id', reaId)
            .maybeSingle();
          if (freshAgent?.mobile) {
            const n = normalizeMobile(freshAgent.mobile);
            if (n) agentMobilePool.add(n);
          }
          if (freshAgent?.business_phone) {
            const n = normalizeMobile(freshAgent.business_phone);
            if (n) agentMobilePool.add(n);
          }
          // B22: JS normalizeMobile and SQL pulse_normalize_phone can diverge on
          // edge cases (extensions, parentheses, leading-zero handling). Stored
          // alternates were already normalized on insert via pulse_merge_contact
          // → pulse_normalize_phone, so trust them as-is instead of re-running
          // the JS normalizer and risking a mismatch. (CRM contact phones
          // below still use JS normalizeMobile — CRM data follows different
          // conventions and never passes through the SQL normalizer.)
          if (Array.isArray(freshAgent?.alternate_mobiles)) {
            for (const alt of freshAgent.alternate_mobiles) {
              const n = (alt?.value || '').trim() || null;
              if (n) agentMobilePool.add(n);
            }
          }
          if (Array.isArray(freshAgent?.alternate_phones)) {
            for (const alt of freshAgent.alternate_phones) {
              const n = (alt?.value || '').trim() || null;
              if (n) agentMobilePool.add(n);
            }
          }
        } catch { /* fall back to stale snapshot below */ }
        // Fallback to snapshot if fresh read failed
        // B22: snapshot values also came from pulse_agents.alternate_mobiles,
        // which are normalized on write — trust them as-is (parity with the
        // fresh-read path above).
        const existingAgentSnap = existingByReaIdSnapshot.get(reaId);
        if (agentMobilePool.size === 0 && existingAgentSnap?.alternate_mobiles && Array.isArray(existingAgentSnap.alternate_mobiles)) {
          for (const alt of existingAgentSnap.alternate_mobiles) {
            const n = (alt?.value || '').trim() || null;
            if (n) agentMobilePool.add(n);
          }
        }
        if (agentMobilePool.size > 0) {
          matchedCrm = crmAgentsList.find((c: any) => {
            const cPhone = normalizeMobile(c.phone);
            return cPhone && agentMobilePool.has(cPhone);
          });
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

    // ── Migration 100 + 134: pulse_entity_sync_history bulk write ───────
    // Every entity touched by this sync gets a history row so the UI can
    // drill back to "which run produced this state". This replaced the
    // single-filter-on-last_sync_log_id approach from migration 100 which
    // silently missed rows whenever `last_sync_log_id` failed to stamp
    // (e.g. migration 134 found 0/3,567 agents had it set in prod — the
    // column was added in migration 100 but the emit block at the end of
    // the run filtered by it, so no rows were ever recorded for
    // pulseDataSync runs despite the code being "deployed").
    //
    // New approach: query by rea_agent_id / source_listing_id / name (the
    // stable business keys from this run's processed batches) then cross-
    // reference against pre-upsert snapshots to split created vs updated.
    // This doesn't depend on last_sync_log_id propagating correctly, so it
    // survives partial upsert failures / trigger quirks / shadowed writes.
    if (syncLogId) {
      try {
        const sourceLabelForHistory = source_id || 'pulse_sync';
        const historyRows: any[] = [];

        // Agents touched this run: every rea_agent_id we tried to upsert.
        const touchedAgentReaIds = uniqueAgents
          .map((a: any) => a.rea_agent_id)
          .filter((v: any): v is string => typeof v === 'string' && v.length > 0);
        if (touchedAgentReaIds.length > 0) {
          // Chunk the IN query to avoid URL overflow on large batches.
          const CHUNK = 200;
          for (let i = 0; i < touchedAgentReaIds.length; i += CHUNK) {
            const slice = touchedAgentReaIds.slice(i, i + CHUNK);
            const { data: agentRows = [] } = await admin.from('pulse_agents')
              .select('id, rea_agent_id')
              .in('rea_agent_id', slice);
            for (const row of agentRows as any[]) {
              const wasExisting = existingByReaIdSnapshot.has(row.rea_agent_id);
              historyRows.push({
                entity_type: 'agent',
                entity_id: row.id,
                entity_key: row.rea_agent_id,
                sync_log_id: syncLogId,
                action: wasExisting ? 'updated' : 'created',
                source: sourceLabelForHistory,
                seen_at: new Date().toISOString(),
              });
            }
          }
        }

        // Listings touched this run: every source_listing_id we processed.
        const touchedListingIds = filteredListingRecords
          .map((l: any) => l.source_listing_id)
          .filter((v: any): v is string => typeof v === 'string' && v.length > 0);
        if (touchedListingIds.length > 0) {
          const CHUNK = 200;
          for (let i = 0; i < touchedListingIds.length; i += CHUNK) {
            const slice = touchedListingIds.slice(i, i + CHUNK);
            const { data: listingRows = [] } = await admin.from('pulse_listings')
              .select('id, source_listing_id')
              .in('source_listing_id', slice);
            for (const row of listingRows as any[]) {
              const wasExisting = existingListingIds.has(row.source_listing_id);
              historyRows.push({
                entity_type: 'listing',
                entity_id: row.id,
                entity_key: row.source_listing_id,
                sync_log_id: syncLogId,
                action: wasExisting ? 'updated' : 'created',
                source: sourceLabelForHistory,
                seen_at: new Date().toISOString(),
              });
            }
          }
        }

        // Agencies touched this run: lookup by name (unique key is
        // lower(trim(name))). existingAgencyMap keyed by lower-trim name
        // gives us the was-existing flag.
        const touchedAgencyNames = mergedAgencies
          .map((a: any) => (a.name || '').trim())
          .filter((v: string) => v.length > 0);
        if (touchedAgencyNames.length > 0) {
          const CHUNK = 200;
          for (let i = 0; i < touchedAgencyNames.length; i += CHUNK) {
            const slice = touchedAgencyNames.slice(i, i + CHUNK);
            const { data: agencyRows = [] } = await admin.from('pulse_agencies')
              .select('id, name, rea_agency_id')
              .in('name', slice);
            for (const row of agencyRows as any[]) {
              const normKey = (row.name || '').trim().toLowerCase();
              const wasExisting = existingAgencyMap.has(normKey);
              historyRows.push({
                entity_type: 'agency',
                entity_id: row.id,
                entity_key: row.rea_agency_id,
                sync_log_id: syncLogId,
                action: wasExisting ? 'updated' : 'created',
                source: sourceLabelForHistory,
                seen_at: new Date().toISOString(),
              });
            }
          }
        }

        if (historyRows.length > 0) {
          // Chunked insert to avoid hitting payload caps on very large runs
          const HIST_BATCH = 500;
          let insertedCount = 0;
          for (let i = 0; i < historyRows.length; i += HIST_BATCH) {
            const chunk = historyRows.slice(i, i + HIST_BATCH);
            const { error } = await admin.from('pulse_entity_sync_history').insert(chunk);
            if (error) {
              console.warn(`sync_history insert chunk ${i / HIST_BATCH}: ${error.message?.substring(0, 200)}`);
            } else {
              insertedCount += chunk.length;
            }
          }
          console.log(`Wrote ${insertedCount}/${historyRows.length} pulse_entity_sync_history rows (agents+listings+agencies)`);
        } else {
          console.log('pulse_entity_sync_history: 0 rows to write (empty run)');
        }
      } catch (histErr: any) {
        console.warn('pulse_entity_sync_history write failed (non-fatal):', histErr?.message);
      }
    }

    // Update sync log via shared observability module.
    // endRun replaces the manual entities.PulseSyncLog.update + side-table
    // upsert dance (~50 lines). Heavy raw_payload + result_summary still land
    // in pulse_sync_log_payloads per migration 095 — the shared helper just
    // handles the write.
    //
    // records_new (agents/agencies inserted count) is NOT part of the shared
    // helper's narrow header vocab, so it lands in records_detail instead.
    // The UI reads records_new off the header — B-QUIRK: if that column is
    // needed on the top-level row, patch it in after endRun. Currently the
    // records_detail path is sufficient for drill-through.
    if (ctx) {
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: allReaAgents.length + allListings.length,
        recordsUpdated: agentsUpdated + agenciesUpdated + listingsInserted,
        recordsDetail: {
          agents_inserted: agentsInserted,
          agents_updated: agentsUpdated,
          agencies_inserted: agenciesInserted,
          agencies_updated: agenciesUpdated,
          listings_stored: listingsInserted,
          movements_detected: movementsDetected,
          timeline_entries: timelineEntries,
          mappings_created: mappingsCreated,
        },
        apifyRunId: Object.values(apifyRunIds).filter(Boolean).join(',') || undefined,
        apifyBilledCostUsd: apifyStats.apify_billed_cost_usd,
        valueProducingCostUsd: apifyStats.value_producing_cost_usd,
        rawPayload: {
          rea_agents: allReaAgents,
          listings: allListings,
        },
        customSummary: {
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
          // OP03 (2026-04-18): cost + runtime reconciliation fields so the
          // daily billing dashboard can see $/source and per-run efficiency
          // on the same side-table row the UI already renders from. Keys
          // match pulseDetailEnrich so both REA sources aggregate with the
          // same SQL. items_processed = raw items surfaced by the scraper
          // (pre-dedup); use records_fetched on the main table for the
          // count after dedup if you want that view instead.
          runtime_secs: apifyStats.runtime_secs,
          apify_runs_attempted: apifyStats.runs_attempted,
          apify_runs_succeeded: apifyStats.runs_succeeded,
          apify_run_ids: apifyRunIds,
          items_processed: allReaAgents.length + allListings.length,
        },
      });

      // records_new lives in the header (the UI reads it directly). endRun
      // doesn't expose it because the shared-module vocab is deliberately
      // minimal — patch it in as a direct update.
      try {
        await admin.from('pulse_sync_logs').update({
          records_new: agentsInserted + agenciesInserted,
        }).eq('id', syncLogId);
      } catch (pErr) {
        console.warn('pulseDataSync: records_new patch failed (non-fatal):', (pErr as any)?.message);
      }
    }

    // Update source config last_run_at
    if (source_id) {
      try {
        await admin.from('pulse_source_configs').update({ last_run_at: now }).eq('source_id', source_id);
      } catch { /* non-fatal */ }
    }

    // Queue callback (migration 093): close the loop for pulseFireWorker.
    // Without this, the queue row stays 'running' and the worker's reconciler
    // will re-queue us after 5 min — which would be a double-sync bug.
    if (fire_queue_id) {
      try {
        await admin.rpc('pulse_fire_queue_record_outcome', {
          p_id: fire_queue_id,
          p_success: true,
          p_sync_log_id: syncLogId,
        });
      } catch (qErr) {
        console.error('pulseDataSync: fire_queue callback (success) failed:', qErr);
      }
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
    const errMsg = (error?.message || String(error) || 'unknown error').substring(0, 2000);
    // CRITICAL: Always mark the sync log as failed so pulseFireScrapes' 30-min
    // "already running" guard doesn't block subsequent scrapes. Using endRun
    // (via shared observability module) closes both the header and the side-
    // table in one call; a wrapper-level throw is still caught below.
    if (ctx) {
      try {
        recordError(ctx, error, 'fatal');
        await endRun(ctx, {
          status: 'failed',
          errorMessage: errMsg,
          // OP03 (2026-04-18): persist cost data on the error path so runs that
          // burned Apify credits before throwing still show up in billing
          // reconciliation rather than appearing free.
          apifyRunId: Object.values(apifyRunIds).filter(Boolean).join(',') || undefined,
          apifyBilledCostUsd: apifyStats.apify_billed_cost_usd,
          valueProducingCostUsd: apifyStats.value_producing_cost_usd,
          customSummary: {
            error: errMsg,
            runtime_secs: apifyStats.runtime_secs,
            apify_runs_attempted: apifyStats.runs_attempted,
            apify_runs_succeeded: apifyStats.runs_succeeded,
            apify_run_ids: apifyRunIds,
            items_processed: 0,
          },
        });
      } catch (logErr) {
        console.error('pulseDataSync: failed to mark sync log as failed:', logErr);
      }
    }

    // Queue callback (migration 093): record failure so the item is either
    // re-queued with backoff or dead-lettered based on attempts/category.
    // Categorize: 4xx-like fatal misconfigs are permanent; Apify 429 / rate
    // limit substrings are rate_limit; everything else transient.
    if (body?.fire_queue_id) {
      const msgLc = errMsg.toLowerCase();
      const category =
        msgLc.includes('429') || msgLc.includes('rate limit') || msgLc.includes('rate-limit') ? 'rate_limit' :
        msgLc.includes('missing') && msgLc.includes('config') ? 'permanent' :
        msgLc.includes('apify_token') ? 'permanent' :
        'transient';
      try {
        await admin.rpc('pulse_fire_queue_record_outcome', {
          p_id: body.fire_queue_id,
          p_success: false,
          p_error: errMsg,
          p_category: category,
          p_sync_log_id: syncLogId,
        });
      } catch (qErr) {
        console.error('pulseDataSync: fire_queue callback (failure) failed:', qErr);
      }
    }

    return errorResponse(errMsg);
  }
});
