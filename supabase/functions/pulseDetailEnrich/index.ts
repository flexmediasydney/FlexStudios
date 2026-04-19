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
import {
  startRun,
  endRun,
  recordError,
  breakerCheckOpen,
  breakerRecordSuccess,
  breakerRecordFailure,
} from '../_shared/observability.ts';
import { recordFieldObservation } from '../_shared/fieldSources.ts';

// ── SAFR ingestion helper (silent-fails) ─────────────────────────────────────
async function safrObserve(
  admin: any,
  entity_type: 'agent' | 'agency',
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
    console.warn(`[safrObserve] ${entity_type}.${field_name} failed: ${(e as Error)?.message?.substring(0, 160)}`);
  }
}

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR_SLUG = 'memo23/realestate-au-listings';
const SOURCE_ID = 'rea_detail_enrich';

// Apify wait / batch knobs
// memo23 runs ~5s per URL against REA through its residential proxy. We want
// every batch to complete within the waitForFinish window (no polling), so
// BATCH_SIZE × 5s < APIFY_WAIT_SECS. 12 URLs × 5s = 60s << 85s window.
// Edge function wall-clock cap is 150s; we can fit 1 batch comfortably.
// Cron calls this repeatedly for larger backfills.
// B35: Dropped BATCH_SIZE from 15 → 12 to buy ~15s of wall-clock margin.
// With 140s WALL_BUDGET_MS, Apify wait ≤85s, and ~20s of DB work (candidate
// select, per-listing updates, timeline/history inserts), 12 URLs leaves
// comfortable headroom. For throughput the cron fires every 15 min, so
// 24 listings/hour = 576/day stays well within budget.
const APIFY_WAIT_SECS = 85;
const BATCH_SIZE = 12;
const MAX_BATCHES_PER_INVOCATION = 1;

// Confidence source labels (must match pulse_source_confidence() in 104)
const SRC_LISTER  = 'detail_page_lister';
const SRC_AGENCY  = 'detail_page_agency';

// ── Helpers ─────────────────────────────────────────────────────────────

function parseAuctionDatetime(auctionTime: any): string | null {
  // listing.auctionTime.startTime = '2026-05-02T14:30:00' (local time, no TZ)
  // Treat as Sydney. B27 fix: AEDT (UTC+11) applies Oct 1st → Apr 1st (approx).
  // Full Australia/Sydney DST rules via Intl — no manual offset math.
  if (!auctionTime?.startTime) return null;
  const raw = String(auctionTime.startTime).trim();
  // If already has timezone, return as-is
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw).toISOString();
  // Determine Sydney offset for the given datetime via Intl
  try {
    // Extract Y-M-D-H-M from the naive string
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const [, yy, mm, dd, hh, mi, ss] = m;
    // Determine if this AU date is in AEDT or AEST by formatting a known UTC
    // timestamp in Australia/Sydney and reading the offset. We do this by
    // finding the DST-aware UTC offset for the specific local date.
    // Pragmatic approach: format "{yyyy}-{mm}-{dd}T{hh}:{mi} Australia/Sydney"
    // into UTC via Date.UTC tricks. Use the DateTimeFormat trick:
    const local = new Date(Date.UTC(Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss || 0)));
    // Ask what Australia/Sydney thinks this UTC moment's local time is; the
    // difference tells us which offset applies to this local time.
    const sydFormatter = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    // Binary-search-style: test with +10 and +11 offsets and see which matches
    for (const tryOffset of [10, 11]) {
      const tentative = new Date(local.getTime() - tryOffset * 3600 * 1000);
      const parts = Object.fromEntries(sydFormatter.formatToParts(tentative).map(p => [p.type, p.value]));
      const sydHour = parts.hour === '24' ? '00' : parts.hour;
      if (parts.year === yy && parts.month === mm && parts.day === dd
          && sydHour === hh && parts.minute === mi) {
        return tentative.toISOString();
      }
    }
    // Fallback: treat as UTC+10
    return new Date(local.getTime() - 10 * 3600 * 1000).toISOString();
  } catch { return null; }
}

/** Strip phone extensions and non-digit noise. B11 fix. */
function sanitisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  // Remove extension tokens like "x123", " ext 456", "extn 789"
  s = s.replace(/\s*(x|ext|extn|extension)\s*\d+\s*$/i, '');
  // Keep + and digits; drop everything else
  s = s.replace(/[^0-9+]/g, '');
  // Cap at 15 digits (E.164 max); prefer leading + preserved
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\+/g, '');
  if (digits.length < 8) return null; // too short to be a phone
  if (digits.length > 15) return null; // nonsensical
  return hasPlus ? '+' + digits : digits;
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
  if (unit === 'm2' || unit === 'm²' || unit === 'sqm' || unit === 'sq m' || unit === '') return v;
  if (unit === 'ha' || unit === 'hectare' || unit === 'hectares') return v * 10_000;
  if (unit === 'acres' || unit === 'acre') return v * 4046.8564224;  // B26: AU rural listings
  return null;
}

/**
 * Rewrite a REA reastatic.net CDN URL to include a size/format prefix.
 *
 * REA's CDN 302-redirects bare URLs (/HASH/image.jpg) to a placeholder. The
 * browser-renderable variant has a prefix baked into the first path segment:
 *   /800x600-fit,format=webp/HASH/image.jpg → real image
 *   /HASH/image.jpg                         → placeholder.png
 *
 * We write the prefixed variant at enrichment time so every downstream
 * consumer (frontend, exports, APIs) gets a usable URL without having to
 * rewrite. Idempotent — passes already-prefixed URLs through unchanged.
 *
 * 2026-04-19 fix for "no media other than hero" bug on enriched listings.
 */
function toReaDisplayUrl(url: string, variant = '800x600-fit,format=webp'): string {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('reastatic.net')) return url;
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return url;
    const first = segments[0];
    const hasPrefix =
      first.includes(',') ||
      /^\d+x\d+/.test(first) ||
      first.startsWith('format=');
    if (hasPrefix) return url;
    u.pathname = '/' + variant + '/' + segments.join('/');
    return u.toString();
  } catch {
    return url;
  }
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
      // B36 fix: each video gets its own URL (no first-video-wins overwrite)
      const thisVideoUrl = img.id ? `https://www.youtube.com/watch?v=${img.id}` : `${server}${uri}`;
      // Video thumb (YouTube img URL or REA thumb) — only REA ones need rewriting
      const thisVideoThumb = toReaDisplayUrl(`${server}${uri}`, '160x120-fit,format=webp');
      if (!videoUrl) {
        videoUrl = thisVideoUrl;
        videoThumb = thisVideoThumb;
      }
      mediaItems.push({ type: 'video', url: thisVideoUrl, thumb: thisVideoThumb, order_index: idx });
    } else if (name === 'floorplan') {
      const full = toReaDisplayUrl(`${server}${uri}`);
      floorplans.push(full);
      mediaItems.push({ type: 'floorplan', url: full, order_index: idx });
    } else if (name === 'photo' || name === 'main photo') {
      const full = toReaDisplayUrl(`${server}${uri}`);
      mediaItems.push({ type: 'photo', url: full, order_index: idx });
    } else if (uri) {
      mediaItems.push({ type: name || 'photo', url: toReaDisplayUrl(`${server}${uri}`), order_index: idx });
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
  input?: any;
  error?: string;
}> {
  if (!APIFY_TOKEN) return { ok: false, status: 'NO_TOKEN', items: [], error: 'APIFY_TOKEN not set' };
  if (urls.length === 0) return { ok: true, status: 'SKIPPED_EMPTY', items: [] };

  const safeSlug = ACTOR_SLUG.replace('/', '~');
  // B38: Apify's `timeout` (actor run timeout) and `waitForFinish` (API blocking
  // wait) are distinct. Give the actor enough runtime; wait only as long as
  // our edge function budget allows.
  const ACTOR_TIMEOUT_SECS = 120;  // actor can take up to 2 min
  const submitUrl = `${APIFY_BASE}/acts/${safeSlug}/runs?timeout=${ACTOR_TIMEOUT_SECS}&waitForFinish=${APIFY_WAIT_SECS}`;
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
    return { ok: false, status: `HTTP_${resp.status}`, items: [], input, error: `Apify ${label} submit ${resp.status}: ${txt.substring(0, 300)}` };
  }

  const runData = await resp.json();
  let status = runData?.data?.status;
  const runId = runData?.data?.id;
  const datasetId = runData?.data?.defaultDatasetId;
  let stats = runData?.data?.stats;

  // B40 fix (2026-04-19): Apify returns READY/RUNNING when the actor hasn't
  // finished within our waitForFinish window. Before this, we hard-failed and
  // lost 20–30% of runs even though the actor usually completed moments later
  // and had items waiting in the dataset. New behaviour:
  //   1. On READY/RUNNING, poll the run up to 3 more times (8s apart) —
  //      cheap, still inside our edge-function budget.
  //   2. If it eventually SUCCEEDS, proceed normally.
  //   3. If it still isn't done, try fetching the dataset anyway — the actor
  //      writes items incrementally, so partial results are common and useful.
  //      We'll mark ok=true with status='PARTIAL' and let the caller decide.
  //   4. Only truly error states (ABORTED/FAILED/TIMED-OUT) get ok=false.
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
          stats = pollData?.data?.stats ?? stats;
        }
      } catch { /* swallow; try next attempt */ }
    }
  }

  const terminalError = status === 'ABORTED' || status === 'FAILED' || status === 'TIMED-OUT';

  if (terminalError) {
    return { ok: false, status, runId, datasetId, stats, items: [], input, error: `Apify status=${status}` };
  }

  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=${urls.length + 10}`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = itemsResp.ok ? await itemsResp.json() : [];
  // If actor still isn't SUCCEEDED after polling, flag as PARTIAL — caller
  // can decide whether to retry later. Items we did get are still worth
  // ingesting (address → property_key is the key for matching + fresh media
  // for partially-enriched listings is always better than nothing).
  const effectiveStatus = status === 'SUCCEEDED'
    ? status
    : (Array.isArray(items) && items.length > 0 ? 'PARTIAL' : status);
  return {
    ok: true,
    status: effectiveStatus,
    runId,
    datasetId,
    stats,
    items: Array.isArray(items) ? items : [],
    input,
    ...(effectiveStatus === 'PARTIAL' ? { partial: true, warning: `actor still ${status} after polling; accepted ${items?.length ?? 0} items` } : {}),
  };
}

// Circuit breaker helpers now come from _shared/observability.ts.
// breakerCheckOpen / breakerRecordSuccess / breakerRecordFailure replace the
// three local functions that used to live here and duplicated the pattern in
// pulseDataSync/pulseCircuitReset. B12 semantics (null reopen_at = permanently
// open) are preserved inside the shared module.

// ── Timeline emission (idempotent via idempotency_key) ──────────────────

// Migration 148: run-level rollup event types that are NOT entity-level
// changes. These are excluded from the pulse_sync_logs.timeline_events_emitted
// counter so the Sync History "Changes" column reflects true entity changes.
// Keep in sync with supabase/functions/_shared/timeline.ts and migrations 147/148.
const ROLLUP_EVENT_TYPES = new Set<string>([
  'new_listings_detected',
  'client_new_listing',
  'cron_dispatched',
  'cron_dispatch_batch',
  'cron_dispatch_started',
  'cron_dispatch_completed',
  'coverage_report',
  'data_sync',
  'data_cleanup',
  'circuit_reset',
]);

async function emitTimeline(
  admin: any,
  events: any[],
  ctx?: { syncLogId?: string | null; apifyRunId?: string | null },
): Promise<{ inserted: number; errors: Array<{ msg: string; count: number }> }> {
  // B31: group errors by first 80 chars so a schema-mismatch avalanche
  // (e.g. "column ... does not exist" × 40 rows) collapses into a single
  // visible entry with a count, instead of losing all but the first 3.
  if (events.length === 0) return { inserted: 0, errors: [] };

  // Migration 141: stamp sync_log_id + apify_run_id on every row so the
  // Timeline drill-through can walk FK → sync_log → raw payload without the
  // fragile source+time-range match. Individual push sites throughout this
  // function don't know the runtime ctx, so we merge it in centrally here.
  // Existing values on the event (unlikely) win — we only backfill when missing.
  const syncLogId  = ctx?.syncLogId  ?? null;
  const apifyRunId = ctx?.apifyRunId ?? null;
  const stamped = (syncLogId || apifyRunId)
    ? events.map((e) => ({
        sync_log_id:  e.sync_log_id  ?? syncLogId,
        apify_run_id: e.apify_run_id ?? apifyRunId,
        ...e,
      }))
    : events;

  // Migration 148: tally non-rollup, non-system rows per sync_log_id so we
  // can bump pulse_sync_logs.timeline_events_emitted after a successful insert.
  const incBySyncLog = new Map<string, number>();
  const tallyRow = (e: any) => {
    if (
      e?.sync_log_id &&
      !ROLLUP_EVENT_TYPES.has(e.event_type) &&
      e.entity_type !== 'system'
    ) {
      incBySyncLog.set(e.sync_log_id, (incBySyncLog.get(e.sync_log_id) ?? 0) + 1);
    }
  };
  const flushIncrements = async () => {
    for (const [sid, delta] of incBySyncLog) {
      try {
        const { error: rpcErr } = await admin.rpc('pulse_sync_log_increment_events', {
          p_id: sid, p_delta: delta,
        });
        if (rpcErr) {
          console.warn(`emitTimeline: increment_events rpc failed for ${sid}: ${rpcErr.message?.substring(0, 150)}`);
        }
      } catch (e) {
        console.warn(`emitTimeline: increment_events threw for ${sid}: ${(e as Error)?.message?.substring(0, 150)}`);
      }
    }
  };

  // Best-effort insert; duplicate idempotency_keys are caught by unique constraint.
  // We try bulk first, then fall back to per-row inserts so one bad row doesn't
  // drop the whole batch (which was the silent failure in the initial ship).
  const { error, count } = await admin.from('pulse_timeline').insert(stamped, { count: 'exact' });
  if (!error) {
    for (const e of stamped) tallyRow(e);
    await flushIncrements();
    return { inserted: count || stamped.length, errors: [] };
  }
  // Dedup-only errors — expected, not a real problem
  if (String(error.message || '').includes('duplicate')) return { inserted: 0, errors: [] };
  // Otherwise try per-row for partial success, and group error strings by prefix.
  const errorGroups = new Map<string, number>();
  const bump = (raw: string) => {
    const key = String(raw || '').substring(0, 80);
    errorGroups.set(key, (errorGroups.get(key) || 0) + 1);
  };
  // The bulk attempt's error applies to the whole first pass — count once.
  bump(error.message || '');
  let inserted = 0;
  for (const e of stamped) {
    const { error: e2 } = await admin.from('pulse_timeline').insert(e);
    if (!e2) { inserted++; tallyRow(e); }
    else if (!String(e2.message || '').includes('duplicate')) bump(e2.message || '');
  }
  await flushIncrements();
  const errors = Array.from(errorGroups.entries()).map(([msg, count]) => ({ msg, count }));
  return { inserted, errors };
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

  // B34: fail-fast on config error. Don't open a sync_log or touch the breaker
  // — this is not an Apify health issue, it's misconfiguration.
  if (!APIFY_TOKEN) {
    return errorResponse('APIFY_TOKEN is not configured on this environment', 500);
  }

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const trigger = String(body.trigger || 'manual');
  const priorityMode = String(body.priority_mode || 'auto');
  const maxListings = Math.max(1, Math.min(1000, Number(body.max_listings) || 500));
  const forceIds = Array.isArray(body.force_ids) ? body.force_ids : [];
  const dryRun = body.dry_run === true;

  // ── Circuit breaker check (via shared module) ────────────────────────
  // B12 semantics (null reopen_at = permanently open) preserved inside
  // breakerCheckOpen.
  const breaker = await breakerCheckOpen(admin, SOURCE_ID);
  if (breaker.open) {
    return jsonResponse({
      skipped: true,
      reason: 'circuit_breaker_open',
      consecutive_failures: breaker.consecutiveFailures,
      reopen_at: breaker.reopenAt,
    });
  }

  // ── Open a sync_log row (via shared module) ──────────────────────────
  // startRun seeds input_config eagerly so the drill-through UI works
  // mid-run. We finalise batch_number / total_batches / exact suburb scope
  // at the end via endRun.
  const ctx = await startRun({
    admin,
    sourceId: SOURCE_ID,
    syncType: 'pulse_detail_enrich',
    triggeredBy: trigger,
    triggeredByName: `pulseDetailEnrich:${trigger}:${priorityMode}`,
    inputConfig: {
      trigger,
      priority_mode: priorityMode,
      max_listings: maxListings,
      force_ids: forceIds,
      dry_run: dryRun,
      actor_slug: ACTOR_SLUG,
      apify_wait_secs: APIFY_WAIT_SECS,
      batch_size: BATCH_SIZE,
      max_batches_per_invocation: MAX_BATCHES_PER_INVOCATION,
    },
  });
  const syncLogId = ctx.syncLogId;

  try {
    // ── Candidate selection ──────────────────────────────────────────────
    // B03: include detail_enrich_count so we can increment it correctly.
    const SELECT_COLS = 'id, source_listing_id, source_url, listing_type, sold_date, price_text, last_synced_at, detail_enriched_at, detail_enrich_count';
    let candidates: any[] = [];
    // B18: track how many forceIds listings were already enriched within 14d.
    // Surfaced in stats + console.warn so ad-hoc debug runs don't silently
    // re-spend Apify budget on fresh data.
    let forceIdsAlreadyEnrichedWithin14d = 0;
    if (forceIds.length > 0) {
      const { data } = await admin
        .from('pulse_listings')
        .select(SELECT_COLS)
        .in('id', forceIds);
      candidates = data || [];
      const cutoff14d = Date.now() - 14 * 86400 * 1000;
      forceIdsAlreadyEnrichedWithin14d = candidates.filter(c => {
        if (!c.detail_enriched_at) return false;
        const t = new Date(c.detail_enriched_at).getTime();
        return !isNaN(t) && t >= cutoff14d;
      }).length;
      if (forceIdsAlreadyEnrichedWithin14d > 0) {
        console.warn(`[pulseDetailEnrich] force_ids: ${forceIdsAlreadyEnrichedWithin14d}/${candidates.length} listings were already enriched within the last 14 days — re-enrich will overwrite recent data and incur extra Apify cost.`);
      }
    } else {
      // Main path: pick stalest / priority targets
      let query = admin
        .from('pulse_listings')
        .select(SELECT_COLS)
        .eq('source', 'rea')
        .not('source_url', 'is', null)
        .limit(maxListings);

      // B04: all priority modes sort by detail_enriched_at NULLS FIRST to avoid
      // repeatedly picking the same already-processed listings.
      if (priorityMode === 'sold_first') {
        query = query.eq('listing_type', 'sold').is('sold_date', null)
          .order('detail_enriched_at', { ascending: true, nullsFirst: true })
          .order('last_synced_at', { ascending: false });
      } else if (priorityMode === 'auction_first') {
        query = query.in('listing_type', ['for_sale', 'under_contract']).ilike('price_text', '%auction%')
          .order('detail_enriched_at', { ascending: true, nullsFirst: true })
          .order('last_synced_at', { ascending: false });
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
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: 0,
        recordsUpdated: 0,
        sourceLabel: `rea_detail_enrich · no candidates · ${priorityMode}`,
        suburb: 'no candidates',
        customSummary: { message: 'No candidates needing enrichment', candidates: 0 },
      });
      return jsonResponse({ ok: true, syncLogId, candidates: 0, message: 'No candidates needing enrichment' });
    }

    if (dryRun) {
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: candidates.length,
        sourceLabel: `rea_detail_enrich · ${candidates.length} listings (dry run) · ${priorityMode}`,
        suburb: `${candidates.length} listing${candidates.length === 1 ? '' : 's'} (dry run)`,
        customSummary: {
          message: `DRY RUN: would enrich ${candidates.length} listings`,
          dry_run: true,
          candidates: candidates.length,
        },
      });
      return jsonResponse({ ok: true, dryRun: true, syncLogId, candidates: candidates.length, sample_ids: candidates.slice(0, 10).map(c => c.source_listing_id) });
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
      // B28: split into "what Apify bills us" vs "what produced useful data".
      // apify_billed_cost_usd is always incremented when a batch is launched
      // (run start $0.007) and per item returned ($0.001). It matches the
      // Apify invoice line. value_producing_cost_usd only counts batches
      // where result.ok — the cost of successful enrichment work.
      apify_billed_cost_usd: 0,
      value_producing_cost_usd: 0,
      // B18: expose forceIds-re-enrich count in response stats.
      already_enriched_within_14d: forceIdsAlreadyEnrichedWithin14d,
    };

    // B47: accumulate heavy payloads for side-table write at end of run so
    // drill-through debugging has the raw memo23 response + our request input
    // (mirrors pulseDataSync's raw_payload/input_config pattern from mig 095).
    // Cap first batch items fully, truncate subsequent to avoid oversizing
    // sync_log_payloads rows when a run processes many batches.
    const RAW_PAYLOAD_MAX_ITEMS_FIRST = 10;
    const RAW_PAYLOAD_MAX_ITEMS_LATER = 2;
    const batchPayloads: Array<{
      batch_index: number;
      label: string;
      ok: boolean;
      status: string;
      run_id?: string;
      dataset_id?: string;
      input?: any;
      items_count: number;
      items_truncated: boolean;
      items_sample: any[];
      error?: string;
    }> = [];
    const allBatchInputs: any[] = [];
    const targetedListingIds: string[] = [];

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
      const batchIndex = Math.floor(bIdx / BATCH_SIZE);

      // B47: capture targeted listing ids for input_config
      batch.forEach(c => { if (c.source_listing_id) targetedListingIds.push(String(c.source_listing_id)); });

      const batchLabel = `batch_${batchIndex}`;
      const result = await runMemo23Batch(urls, batchLabel);
      if (result.runId) stats.apify_run_ids.push(result.runId);
      if (result.input) allBatchInputs.push(result.input);
      // B28: Apify bills the run-start event whether or not the items were useful.
      stats.apify_billed_cost_usd += 0.007; // run start
      if (!result.ok) {
        stats.errors.push(`${batchLabel}: ${result.error || result.status}`);
        // B47: still record the failed batch for debugging
        batchPayloads.push({
          batch_index: batchIndex,
          label: batchLabel,
          ok: false,
          status: result.status,
          run_id: result.runId,
          dataset_id: result.datasetId,
          input: result.input,
          items_count: 0,
          items_truncated: false,
          items_sample: [],
          error: result.error,
        });
        continue;
      }
      stats.batches_succeeded++;
      stats.items_returned += result.items.length;
      // B28: per-item cost counts toward both meters — Apify bills per item
      // returned, and these items produced value since result.ok is true.
      stats.apify_billed_cost_usd += 0.001 * result.items.length;
      stats.value_producing_cost_usd += 0.007 + 0.001 * result.items.length;

      // B47: capture batch items (truncated) for raw_payload
      const cap = batchIndex === 0 ? RAW_PAYLOAD_MAX_ITEMS_FIRST : RAW_PAYLOAD_MAX_ITEMS_LATER;
      const truncated = result.items.length > cap;
      batchPayloads.push({
        batch_index: batchIndex,
        label: batchLabel,
        ok: true,
        status: result.status,
        run_id: result.runId,
        dataset_id: result.datasetId,
        input: result.input,
        items_count: result.items.length,
        items_truncated: truncated,
        items_sample: truncated ? result.items.slice(0, cap) : result.items,
      });

      // Index items by source_listing_id for O(1) match against candidates
      const itemsById = new Map<string, any>();
      for (const it of result.items) {
        const id = it.listingId ? String(it.listingId) : null;
        if (id) itemsById.set(id, it);
      }

      const timelineEvents: any[] = [];
      const historyRows: any[] = [];
      const now = new Date();
      // P1 #9 (2026-04-19): batch the per-row atomic increment RPC. Previously
      // we invoked `pulse_inc_listing_detail_count` once per listing inside
      // this loop — an N+1. Now we collect the listing IDs here and fire a
      // single `pulse_inc_listing_detail_count_bulk` RPC at end of batch.
      // Dedup via Set so the same listing never gets double-counted in a run.
      const incrementIds = new Set<string>();

      for (const cand of batch) {
        const item = itemsById.get(String(cand.source_listing_id));
        if (!item) {
          // Withdrawn: was in our DB as active, memo23 returned no item for its URL
          if (['for_sale', 'for_rent', 'under_contract'].includes(cand.listing_type)) {
            // P1 #8 (2026-04-19): check error before counter increment.
            const { error: withdrawErr } = await admin.from('pulse_listings').update({
              listing_withdrawn_at: now.toISOString(),
              listing_withdrawn_reason: 'absent_from_rea',
              detail_enriched_at: now.toISOString(),
              last_sync_log_id: syncLogId,
            }).eq('id', cand.id);
            if (withdrawErr) {
              console.error(`[pulseDetailEnrich] withdraw update failed for ${cand.id}: ${withdrawErr.message?.substring(0, 200)}`);
              continue;
            }
            incrementIds.add(cand.id);
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
          last_sync_log_id: syncLogId,
          // B17: clear withdrawn flags if listing reappears
          listing_withdrawn_at: null,
          listing_withdrawn_reason: null,
        };
        if (auctionTimeIso) listingUpdates.auction_date = auctionTimeIso;
        if (soldDateIso) listingUpdates.sold_date = soldDateIso;
        if (dateAvailable) listingUpdates.date_available = dateAvailable;
        if (landSizeSqm) listingUpdates.land_size_sqm = landSizeSqm;
        if (floorplans.length > 0) listingUpdates.floorplan_urls = floorplans;
        if (videoUrl) listingUpdates.video_url = videoUrl;
        if (videoThumb) listingUpdates.video_thumb_url = videoThumb;
        if (mediaItems.length > 0) {
          listingUpdates.media_items = mediaItems;
          // Keep legacy `images[]` in sync with the detail-scrape photo set so
          // older code paths (slideouts that haven't migrated to media_items)
          // see the same full gallery. Photos only — floorplans/video live in
          // their own columns.
          const photoUrls = mediaItems
            .filter((m) => m.type === 'photo')
            .map((m) => m.url);
          if (photoUrls.length > 0) listingUpdates.images = photoUrls;
        }

        // DO NOT overwrite address/suburb/postcode/source_url (property_key is generated from address).
        // P1 #8 (2026-04-19): surface DB errors + gate counter on success.
        const { error: enrichErr } = await admin.from('pulse_listings').update(listingUpdates).eq('id', cand.id);
        if (enrichErr) {
          console.error(`[pulseDetailEnrich] enrich update failed for ${cand.id}: ${enrichErr.message?.substring(0, 200)}`);
          continue;
        }
        incrementIds.add(cand.id);
        stats.items_processed++;

        // Base detail_enriched event (one per listing per day)
        timelineEvents.push({
          entity_type: 'listing', pulse_entity_id: cand.id, event_type: 'detail_enriched',
          event_category: 'system', title: 'Listing detail-enriched',
          description: `Fields refreshed via memo23 actor`,
          source: SOURCE_ID, idempotency_key: `detail_enriched:${cand.source_listing_id}:${now.toISOString().slice(0, 10)}`,
        });

        // Timeline events for new data discovered
        const prevEnrichedAt = cand.detail_enriched_at;
        if (soldDateIso && (!cand.sold_date || cand.sold_date !== soldDateIso)) {
          // B25: include date in the key so corrections (sold_date fixed) re-fire
          timelineEvents.push({
            entity_type: 'listing', pulse_entity_id: cand.id, event_type: 'sold_date_captured',
            event_category: 'market', title: `Sold date captured: ${soldDateIso}`,
            description: `Detail enrich found dateSold.value=${soldDateIso}`,
            previous_value: cand.sold_date ? { sold_date: cand.sold_date } : null,
            new_value: { sold_date: soldDateIso }, source: SOURCE_ID,
            idempotency_key: `sold_date_captured:${cand.source_listing_id}:${soldDateIso}`,
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
        // B11: strip extensions/non-digit junk BEFORE merging, so pulse_normalize_phone
        // doesn't corrupt "0414 xxx xxx x123" into "0414xxxxxx123".
        const rawMobile = lister?.mobilePhoneNumber || lister?.phoneNumber || topAgent?.phoneNumber || topAgent?.phone || null;
        const agentMobile = sanitisePhone(rawMobile);
        if (reaAgentId) {
          // Find the matching pulse_agents row
          let { data: agentRow } = await admin.from('pulse_agents')
            .select('id, email, email_source, mobile, mobile_source, rea_agent_id')
            .eq('rea_agent_id', reaAgentId)
            .maybeSingle();

          // Bridge-create if missing. B24: use placeholder name when no
          // lister/topAgent name is present — we don't want to drop the agent
          // just because REA sometimes ships partial data. B33: data_sources
          // must be a jsonb ARRAY, not a JSON.stringify'd string.
          if (!agentRow) {
            const listerName = lister?.name || topAgent?.name || `Agent ${reaAgentId}`;
            const listerTitle = lister?.jobTitle || topAgent?.jobTitle || null;
            const listerPhoto = lister?.mainPhoto ? `${lister.mainPhoto.server}${lister.mainPhoto.uri}` : (topAgent?.image || null);
            const { data: created } = await admin.from('pulse_agents').insert({
              rea_agent_id: reaAgentId,
              full_name: listerName,
              job_title: listerTitle,
              profile_image: listerPhoto,
              agency_name: listing.agency?.name || item.agencyName || null,
              source: 'rea_detail_bridge',
              data_sources: ['rea_detail'],  // B33: raw array, not stringified
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

          // Also widen tally to include alt_source_deepened (matches between source and stored)
          const extractAction = (r: any): string | null => {
            const d = r?.data;
            if (!d) return null;
            if (typeof d === 'object' && 'action' in d) return d.action;
            if (Array.isArray(d) && d[0]?.action) return d[0].action;
            return null;
          };

          if (agentRow) {
            // ── SAFR observations for this detail enrich ──
            // Emit observations for each field we saw on this listing detail.
            // Multi-value fields (email array) emit one per value. Source is
            // 'rea_listing_detail' — higher confidence than list-layer scrape.
            const listerName = lister?.name || topAgent?.name || null;
            const listerTitle = lister?.jobTitle || topAgent?.jobTitle || null;
            const listerPhoto = lister?.mainPhoto ? `${lister.mainPhoto.server}${lister.mainPhoto.uri}` : (topAgent?.image || null);
            const srcRefId = listing?.listingId ? String(listing.listingId) : (item?.listingId ? String(item.listingId) : null);
            if (listerName) await safrObserve(admin, 'agent', agentRow.id, 'full_name', listerName, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefId });
            if (listerTitle) await safrObserve(admin, 'agent', agentRow.id, 'job_title', listerTitle, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefId });
            if (listerPhoto) await safrObserve(admin, 'agent', agentRow.id, 'profile_image', listerPhoto, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefId });
            if (agentEmail && !isMiddlemanEmail(agentEmail)) {
              await safrObserve(admin, 'agent', agentRow.id, 'email', agentEmail, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefId });
            }
            // all_emails from topAgent.emails[] — emit one per value
            const topEmails = Array.isArray(topAgent?.emails) ? topAgent.emails : [];
            for (const e of topEmails) {
              if (typeof e === 'string' && e && !isMiddlemanEmail(e)) {
                await safrObserve(admin, 'agent', agentRow.id, 'email', e, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefId });
              }
            }
            if (agentMobile) {
              await safrObserve(admin, 'agent', agentRow.id, 'mobile', agentMobile, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefId });
            }

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
          let { data: agencyRow } = await admin.from('pulse_agencies')
            .select('id, email, phone, website, address_street, brand_color_primary, brand_color_text')
            .eq('rea_agency_id', agencyReaId)
            .maybeSingle();

          // B37: bridge-create agency if missing (mirrors agent bridge). Agencies
          // only ever come from listings; detail-enrich may see one before
          // pulseDataSync has written the main record.
          if (!agencyRow) {
            const agencyName = listing.agency?.name || item.agencyName || null;
            if (agencyName) {
              const addr = listing.agency?.address || {};
              const { data: created } = await admin.from('pulse_agencies').insert({
                rea_agency_id: agencyReaId,
                name: agencyName,
                phone: null,  // pulse_merge_contact will set below
                website: listing.agency?.website || null,
                address_street: addr?.streetAddress || null,
                suburb: addr?.suburb || null,
                state: addr?.state || null,
                postcode: addr?.postcode || null,
                brand_color_primary: listing.agency?.brandingColors?.primary || null,
                brand_color_text: listing.agency?.brandingColors?.text || null,
                logo_url: listing.agency?.logo?.images?.[0] ? `${listing.agency.logo.images[0].server}${listing.agency.logo.images[0].uri}` : null,
                source: 'rea_detail_bridge',
                last_synced_at: now.toISOString(),
                last_sync_log_id: syncLogId,
              }).select('id, email, phone, website, address_street, brand_color_primary, brand_color_text').maybeSingle();
              if (created) {
                agencyRow = created;
                timelineEvents.push({
                  entity_type: 'agency', pulse_entity_id: created.id, rea_id: agencyReaId,
                  event_type: 'first_seen', event_category: 'system',
                  title: `${agencyName} first detected via detail enrich`,
                  description: `Agency discovered through listing detail page`,
                  source: SOURCE_ID, idempotency_key: `first_seen:agency:${agencyReaId}`,
                });
              }
            }
          }

          if (agencyRow) {
            // ── SAFR observations for agency detail enrich ──
            const agencyName = listing.agency?.name || item.agencyName || null;
            const agencyEmailObs = agency._links?.email || item.agencyEmail || null;
            const agencyPhoneObs = agency.phoneNumber || item.agencyPhone || null;
            const agencyWebsiteObs = agency.website || null;
            const agencyLogoObs = listing.agency?.logo?.images?.[0]
              ? `${listing.agency.logo.images[0].server}${listing.agency.logo.images[0].uri}`
              : null;
            let agencyAddrObs: string | null = null;
            const rawAddrObs = agency.address;
            if (rawAddrObs && typeof rawAddrObs === 'object') {
              agencyAddrObs = rawAddrObs.streetAddress || null;
            } else if (typeof rawAddrObs === 'string') {
              const s = rawAddrObs.trim();
              if (/\d/.test(s) && s.includes(',')) {
                agencyAddrObs = s.split(',')[0].trim() || null;
              } else {
                agencyAddrObs = s || null;
              }
            }
            const srcRefIdAg = listing?.listingId ? String(listing.listingId) : (item?.listingId ? String(item.listingId) : null);
            if (agencyName) await safrObserve(admin, 'agency', agencyRow.id, 'name', agencyName, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefIdAg });
            if (agencyEmailObs && !isMiddlemanEmail(agencyEmailObs)) {
              await safrObserve(admin, 'agency', agencyRow.id, 'email', agencyEmailObs, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefIdAg });
            }
            if (agencyPhoneObs) await safrObserve(admin, 'agency', agencyRow.id, 'phone', agencyPhoneObs, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefIdAg });
            if (agencyWebsiteObs) await safrObserve(admin, 'agency', agencyRow.id, 'website', agencyWebsiteObs, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefIdAg });
            if (agencyAddrObs) await safrObserve(admin, 'agency', agencyRow.id, 'address', agencyAddrObs, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefIdAg });
            if (agencyLogoObs) await safrObserve(admin, 'agency', agencyRow.id, 'logo_url', agencyLogoObs, 'rea_listing_detail', { source_ref_type: 'pulse_listing', source_ref_id: srcRefIdAg });

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
              const action = extractAction(r);
              tallyAgency(action);
              if (action === 'primary_set_from_null' || action === 'alt_added') {
                timelineEvents.push({
                  entity_type: 'agency', pulse_entity_id: agencyRow.id, rea_id: agencyReaId,
                  event_type: 'agency_contact_discovered', event_category: 'contact',
                  title: `New agency email discovered`,
                  description: String(agencyEmail).toLowerCase(),
                  source: SOURCE_ID,
                  idempotency_key: `agency_email_discovered:${agencyReaId}:${String(agencyEmail).toLowerCase()}`,
                });
              }
            }
            // Phone
            const agencyPhone = agency.phoneNumber || item.agencyPhone || null;
            if (agencyPhone) {
              const r = await admin.rpc('pulse_merge_contact', {
                p_table: 'pulse_agencies', p_row_id: agencyRow.id,
                p_field: 'phone', p_value: agencyPhone, p_source: SRC_AGENCY,
              });
              const action = extractAction(r);
              tallyAgency(action);
              if (action === 'primary_set_from_null' || action === 'alt_added') {
                timelineEvents.push({
                  entity_type: 'agency', pulse_entity_id: agencyRow.id, rea_id: agencyReaId,
                  event_type: 'agency_contact_discovered', event_category: 'contact',
                  title: `New agency phone discovered`,
                  description: String(agencyPhone),
                  source: SOURCE_ID,
                  idempotency_key: `agency_phone_discovered:${agencyReaId}:${agencyPhone}`,
                });
              }
            }
            // Plain fields (website, address, brand colors) — don't overwrite if already set.
            // B45: bcText also honours `!agencyRow.brand_color_text` (parity with bcPrimary).
            const aUpdates: Record<string, any> = {};
            if (agency.website && !agencyRow.website) aUpdates.website = agency.website;
            // B44: memo23 usually ships agency.address as an object
            // ({streetAddress, suburb, state, postcode}), but occasionally as
            // a flat string. Defensive parse: object → streetAddress; string
            // with digit + comma → portion before first comma; else null.
            let addrStreet: string | null = null;
            const rawAddr = agency.address;
            if (rawAddr && typeof rawAddr === 'object') {
              addrStreet = rawAddr.streetAddress || null;
            } else if (typeof rawAddr === 'string') {
              const s = rawAddr.trim();
              if (/\d/.test(s) && s.includes(',')) {
                const head = s.split(',')[0].trim();
                addrStreet = head || null;
              }
            }
            if (addrStreet && !agencyRow.address_street) aUpdates.address_street = addrStreet;
            const bcPrimary = agency.brandingColors?.primary || null;
            const bcText = agency.brandingColors?.text || null;
            if (bcPrimary && !agencyRow.brand_color_primary) aUpdates.brand_color_primary = bcPrimary;
            if (bcText && !agencyRow.brand_color_text) aUpdates.brand_color_text = bcText;
            if (Object.keys(aUpdates).length > 0) {
              aUpdates.last_sync_log_id = syncLogId;
              // P1 #8 (2026-04-19): surface DB errors.
              const { error: agUpdErr } = await admin.from('pulse_agencies').update(aUpdates).eq('id', agencyRow.id);
              if (agUpdErr) console.error(`[pulseDetailEnrich] agency brand update failed for ${agencyRow.id}: ${agUpdErr.message?.substring(0, 200)}`);
            }
          }
        }
      }

      // Bulk inserts
      // P1 #9 (2026-04-19): single bulk RPC replaces the per-row N+1 loop.
      // Uses the deduped `incrementIds` Set so a listing can't get double-
      // counted within a batch. If the bulk RPC is unavailable (not yet
      // deployed), fall back to per-row as a safety net.
      if (incrementIds.size > 0) {
        const ids = Array.from(incrementIds);
        const { error: bulkIncErr } = await admin.rpc('pulse_inc_listing_detail_count_bulk', { p_ids: ids });
        if (bulkIncErr) {
          console.error(`[pulseDetailEnrich] bulk detail-count RPC failed: ${bulkIncErr.message?.substring(0, 200)} — falling back to per-row`);
          for (const id of ids) {
            await admin.rpc('pulse_inc_listing_detail_count', { p_listing_id: id });
          }
        }
      }

      if (timelineEvents.length > 0) {
        // Migration 141: stamp the per-batch Apify run id + the outer
        // syncLogId so the Timeline drill-through has an explicit FK to the
        // sync_log that generated each event.
        const tlResult = await emitTimeline(admin, timelineEvents, {
          syncLogId,
          apifyRunId: result.runId || null,
        });
        // B31: emit grouped "<msg> (×<count>)" instead of first 3 raw strings.
        if (tlResult.errors.length > 0) {
          tlResult.errors.forEach(e => stats.errors.push(`timeline: ${e.msg} (×${e.count})`));
        }
      }
      if (historyRows.length > 0) {
        const { error } = await admin.from('pulse_entity_sync_history').insert(historyRows);
        if (error) stats.errors.push(`history insert: ${error.message?.substring(0, 150)}`);
      }
    }

    // ── Record success / failure on circuit breaker ──────────────────────
    if (stats.batches_succeeded > 0) {
      await breakerRecordSuccess(admin, SOURCE_ID);
    } else if (stats.batches_attempted > 0) {
      await breakerRecordFailure(admin, SOURCE_ID);
    }

    // ── Mirror stats.errors into shared context ───────────────────────────
    // recordError already handles the 80-char grouping so we don't duplicate
    // that logic here. We push each accumulated error so endRun's coerced
    // error_message matches the old joined format.
    for (const e of stats.errors) recordError(ctx, e, 'warn');

    // ── Final sync_log update (via shared module) ─────────────────────────
    // endRun writes both the narrow header (completed/failed/timed_out,
    // records_fetched, records_updated, records_detail jsonb, apify_run_id
    // scalar, error_message) AND the heavy side-table payload per migration
    // 095 — replaces what used to be ~90 lines of manual pulse_sync_logs
    // update + pulse_sync_log_payloads upsert.
    const summaryMessage = `Enriched ${stats.items_processed} / ${stats.candidates} candidates in ${stats.batches_succeeded} batches. ${stats.items_withdrawn} withdrawn. Apify billed: $${stats.apify_billed_cost_usd.toFixed(3)} (value-producing: $${stats.value_producing_cost_usd.toFixed(3)})`;
    const finalStatus = stats.errors.length > 0 ? 'failed' : 'completed';
    const scopeTag = `${stats.candidates} listing${stats.candidates === 1 ? '' : 's'}`;
    const detailLabel = `rea_detail_enrich · ${scopeTag} · ${priorityMode}`;

    await endRun(ctx, {
      status: finalStatus,
      sourceLabel: detailLabel,
      suburb: scopeTag,
      batchNumber: stats.batches_succeeded > 0 ? stats.batches_succeeded : undefined,
      totalBatches: stats.batches_attempted > 0 ? stats.batches_attempted : undefined,
      recordsFetched: stats.items_returned,
      recordsUpdated: stats.items_processed,
      recordsDetail: {
        withdrawn: stats.items_withdrawn,
        agent_primary_promoted: stats.agent_primary_promoted,
        agent_alt_added: stats.agent_alt_added,
        agency_primary_promoted: stats.agency_primary_promoted,
        agency_alt_added: stats.agency_alt_added,
        integrity_scores_bumped: stats.integrity_scores_bumped,
      },
      apifyRunIds: stats.apify_run_ids,
      apifyBilledCostUsd: stats.apify_billed_cost_usd,
      valueProducingCostUsd: stats.value_producing_cost_usd,
      rawPayload: {
        source: SOURCE_ID,
        actor_slug: ACTOR_SLUG,
        batch_count: batchPayloads.length,
        items_returned_total: stats.items_returned,
        // Truncation applied in-loop: first batch keeps up to 10 items,
        // later batches keep up to 2. Counts in each entry tell you how many
        // were actually returned before the sample was cut.
        batches: batchPayloads,
      },
      customSummary: {
        message: summaryMessage,
        candidates: stats.candidates,
        items_returned: stats.items_returned,
        items_processed: stats.items_processed,
        items_withdrawn: stats.items_withdrawn,
        batches_attempted: stats.batches_attempted,
        batches_succeeded: stats.batches_succeeded,
        batches_skipped_wall: stats.batches_skipped_wall,
        agent_primary_promoted: stats.agent_primary_promoted,
        agent_alt_added: stats.agent_alt_added,
        agency_primary_promoted: stats.agency_primary_promoted,
        agency_alt_added: stats.agency_alt_added,
        integrity_scores_bumped: stats.integrity_scores_bumped,
        already_enriched_within_14d: stats.already_enriched_within_14d,
        targeted_listing_ids: targetedListingIds,
        batch_inputs: allBatchInputs,
      },
    });

    return jsonResponse({
      ok: true,
      syncLogId,
      duration_ms: Date.now() - startedAt,
      ...stats,
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
    // B41: only trip the circuit breaker on errors that implicate upstream
    // (Apify / memo23). A supabase RPC failure, JSON parse error, or similar
    // internal hiccup should NOT mark the external source unhealthy.
    const msg = String(err?.message || '');
    const isUpstream = ['Apify', 'memo23', 'HTTP_', 'TIMED-OUT', 'READY'].some(tag => msg.includes(tag));
    if (isUpstream) {
      await breakerRecordFailure(admin, SOURCE_ID);
    } else {
      console.warn('[pulseDetailEnrich] non-upstream fatal; circuit breaker NOT tripped:', msg.substring(0, 200));
    }
    console.error('pulseDetailEnrich fatal:', err);
    return errorResponse(err?.message || 'pulseDetailEnrich failed', 500);
  }
});
