/**
 * pulseRelistDetector — detect properties that went through a
 *    for_sale/for_rent → withdrawn → for_sale/for_rent cycle
 * and emit one pulse_signals row per candidate (+ a pulse_timeline entry).
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * A re-listed-after-withdrawn property is a strong re-shoot signal:
 *   - The property may need fresh photos after time off the market
 *   - A different agent may be handling it (agency-change opportunity)
 *   - The owner has already committed to re-marketing
 * Existing signal generator classes (agent_movement, agency_growth, etc.) in
 * pulseSignalGenerator are per-timeline-event; they don't reason across the
 * multi-listing history of a single property_key, so this gap went unfilled.
 *
 * ── How ──────────────────────────────────────────────────────────────────
 * 1. Call the pulse_relist_candidates RPC (migration 130) to get one row per
 *    property_key whose most-recent active listing's first_seen_at is AFTER
 *    its most-recent listing_withdrawn_at and within the lookback window.
 * 2. For each candidate, build:
 *      - pulse_signals: level=person, category=movement, idempotency_key
 *        relist:<property_key>:<latest_active_at_iso>
 *      - pulse_timeline: event_type=listing_relisted, same idempotency_key
 *        under a relist_timeline:* prefix
 * 3. Pre-filter against existing idempotency_keys (SELECT-then-INSERT, same
 *    pattern as pulseSignalGenerator) so daily re-runs are no-ops.
 *
 * ── Trigger ──────────────────────────────────────────────────────────────
 * On-demand POST + cron daily at 05:00 AEST (19:00 UTC). Migration 130
 * registers the cron.
 */

import {
  getAdminClient,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { startRun, endRun, recordError } from '../_shared/observability.ts';

const GENERATOR = 'pulseRelistDetector';
const SOURCE_ID = 'pulse_relist_detector';
const DEFAULT_LOOKBACK_DAYS = 30;
const CANDIDATE_LIMIT = 200;

type Candidate = {
  property_key: string;
  address: string | null;
  suburb: string | null;
  listing_count: number;
  last_withdrawn: string;              // ISO timestamp
  latest_active_at: string;            // ISO timestamp
  latest_active_listing_id: string;    // uuid
  latest_listing_type: string | null;
  agent_rea_ids: string[] | null;
  agency_rea_ids: string[] | null;
  agent_pulse_ids: string[] | null;
  agency_pulse_ids: string[] | null;
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Very-readable relative-time label for descriptions. */
function relativeTime(fromIso: string, toIso: string): string {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'recently';
  const s = Math.floor((to - from) / 1000);
  if (s < 60)         return `${s}s`;
  if (s < 3600)       return `${Math.floor(s / 60)} minute${s < 120 ? '' : 's'}`;
  if (s < 86400)      return `${Math.floor(s / 3600)} hour${s < 7200 ? '' : 's'}`;
  if (s < 2_592_000)  return `${Math.floor(s / 86400)} day${s < 172_800 ? '' : 's'}`;
  if (s < 31_536_000) return `${Math.floor(s / 2_592_000)} month${s < 5_184_000 ? '' : 's'}`;
  return `${Math.floor(s / 31_536_000)} year${s < 63_072_000 ? '' : 's'}`;
}

/** Build a display-safe "address, suburb" label. Falls back if one piece is missing. */
function addressLabel(c: Candidate): string {
  const parts = [c.address?.trim(), c.suburb?.trim()].filter(Boolean);
  return parts.length ? parts.join(', ') : (c.property_key || 'property');
}

/** Idempotency key for a candidate. Stable per (property_key, active-listing timestamp). */
function idKey(c: Candidate): string {
  return `relist:${c.property_key}:${c.latest_active_at}`;
}

// ── HTTP handler ─────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const startedAt = Date.now();
  const runId = crypto.randomUUID();

  // Parse optional overrides from the POST body.
  let lookbackDays = DEFAULT_LOOKBACK_DAYS;
  let limit = CANDIDATE_LIMIT;
  try {
    const body = await req.clone().json().catch(() => ({}));
    if (typeof body?.lookback_days === 'number' && body.lookback_days > 0) {
      lookbackDays = Math.min(body.lookback_days, 365); // cap at 1 year
    }
    if (typeof body?.limit === 'number' && body.limit > 0) {
      limit = Math.min(body.limit, 1000);
    }
  } catch { /* no body — use defaults */ }

  const since = new Date(Date.now() - lookbackDays * 86400 * 1000).toISOString();
  const admin = getAdminClient();

  // ── Open observability run ─────────────────────────────────────────────
  // Uses the shared module so every pulseRelistDetector invocation shows up
  // in the Run History UI the same way pulseDataSync / pulseDetailEnrich do.
  // We still emit the legacy pulse_timeline 'data_sync' row below for backward
  // compatibility — operators who were filtering the timeline feed on that
  // event type shouldn't regress.
  const ctx = await startRun({
    admin,
    sourceId: SOURCE_ID,
    syncType: 'pulse_relist_detect',
    triggeredBy: 'manual',
    triggeredByName: `pulseRelistDetector:${runId.slice(0, 8)}`,
    inputConfig: { lookback_days: lookbackDays, limit, since, run_id: runId },
  });

  // ── 1. Fetch relist candidates via RPC ─────────────────────────────────
  const { data: candRows, error: rpcErr } = await admin.rpc('pulse_relist_candidates', {
    p_since: since,
    p_limit: limit,
  });
  if (rpcErr) {
    recordError(ctx, rpcErr, 'fatal');
    await endRun(ctx, {
      status: 'failed',
      errorMessage: `rpc failed: ${rpcErr.message}`,
      sourceLabel: `${SOURCE_ID} · rpc failed`,
      suburb: 'relist detect',
    });
    return jsonResponse({ ok: false, error: `rpc failed: ${rpcErr.message}`, sync_log_id: ctx.syncLogId }, 500, req);
  }
  const candidates: Candidate[] = (candRows || []) as Candidate[];

  const result = {
    candidates: candidates.length,
    signals_inserted: 0,
    timeline_inserted: 0,
    signals_skipped_dup: 0,
    timeline_skipped_dup: 0,
    sample_titles: [] as string[],
    errors: [] as string[],
  };

  if (!candidates.length) {
    // Still write the run-summary timeline row so operators can see the run.
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'data_sync',
      event_category: 'system',
      title: `Relist detector: 0 candidates`,
      description: `Lookback ${lookbackDays}d. No relist candidates in window.`,
      new_value: { lookback_days: lookbackDays, since, sync_log_id: ctx.syncLogId },
      source: GENERATOR,
      idempotency_key: `${GENERATOR}:run:${runId}`,
    }).then(() => {}, () => {});
    await endRun(ctx, {
      status: 'completed',
      recordsFetched: 0,
      recordsUpdated: 0,
      sourceLabel: `${SOURCE_ID} · 0 candidates · ${lookbackDays}d`,
      suburb: 'relist detect',
      customSummary: { lookback_days: lookbackDays, since, candidates: 0 },
    });
    return jsonResponse({
      ok: true, run_id: runId, sync_log_id: ctx.syncLogId, lookback_days: lookbackDays,
      duration_ms: Date.now() - startedAt, ...result,
    }, 200, req);
  }

  // ── 2. Pre-filter signal rows against the partial unique index ─────────
  const signalKeys = candidates.map(idKey);
  const { data: existingSignals } = await admin
    .from('pulse_signals')
    .select('idempotency_key')
    .in('idempotency_key', signalKeys);
  const seenSignalKeys = new Set((existingSignals || []).map((r: any) => r.idempotency_key));

  // Pre-filter timeline rows (different prefix so they can't collide with signals).
  const timelineKeys = candidates.map((c) => `relist_timeline:${c.property_key}:${c.latest_active_at}`);
  const { data: existingTimeline } = await admin
    .from('pulse_timeline')
    .select('idempotency_key')
    .in('idempotency_key', timelineKeys);
  const seenTimelineKeys = new Set((existingTimeline || []).map((r: any) => r.idempotency_key));

  // ── 3. Build signal + timeline rows ────────────────────────────────────
  const nowIso = new Date().toISOString();
  const signalsToInsert: Array<Record<string, unknown>> = [];
  const timelineToInsert: Array<Record<string, unknown>> = [];

  for (const c of candidates) {
    const label = addressLabel(c);
    const agoLabel = relativeTime(c.last_withdrawn, c.latest_active_at);
    const title = `Re-listed: ${label}`;
    const listingTypeText = c.latest_listing_type === 'for_rent'
      ? 'for rent'
      : c.latest_listing_type === 'under_contract'
        ? 'under contract'
        : 'for sale';
    const description =
      `Property was withdrawn ${agoLabel} ago and is now ${listingTypeText}. Possible re-shoot opportunity.`;

    const sigKey = idKey(c);
    if (!seenSignalKeys.has(sigKey)) {
      // linked_agent_ids expects CRM agent ids, but here we only know pulse_agents ids.
      // Leaving those arrays empty is consistent with pulseSignalGenerator's
      // agent_movement class (see that file's class-1 block). The identifiers
      // live in source_data for downstream UI to resolve.
      signalsToInsert.push({
        level: 'person',
        category: 'movement',
        title,
        description,
        status: 'new',
        is_actionable: true,
        suggested_action:
          'Reach out to the listing agent to offer a re-shoot — the owner has re-engaged',
        linked_agent_ids: [],
        linked_agency_ids: [],
        source_type: 'observed',
        event_date: c.latest_active_at,
        source_data: {
          kind: 'relist',
          property_key: c.property_key,
          address: c.address,
          suburb: c.suburb,
          listing_count: c.listing_count,
          last_withdrawn: c.last_withdrawn,
          latest_active_at: c.latest_active_at,
          latest_active_listing_id: c.latest_active_listing_id,
          latest_listing_type: c.latest_listing_type,
          agent_rea_ids: c.agent_rea_ids || [],
          agency_rea_ids: c.agency_rea_ids || [],
          agent_pulse_ids: c.agent_pulse_ids || [],
          agency_pulse_ids: c.agency_pulse_ids || [],
        },
        source_generator: GENERATOR,
        source_run_id: runId,
        idempotency_key: sigKey,
      });
      if (result.sample_titles.length < 10) result.sample_titles.push(title);
    } else {
      result.signals_skipped_dup++;
    }

    const tlKey = `relist_timeline:${c.property_key}:${c.latest_active_at}`;
    if (!seenTimelineKeys.has(tlKey)) {
      timelineToInsert.push({
        entity_type: 'listing',
        pulse_entity_id: c.latest_active_listing_id,
        event_type: 'listing_relisted',
        event_category: 'movement',
        title,
        description,
        new_value: {
          listing_type: c.latest_listing_type,
          latest_active_at: c.latest_active_at,
          latest_active_listing_id: c.latest_active_listing_id,
          property_key: c.property_key,
        },
        previous_value: {
          last_withdrawn: c.last_withdrawn,
          listing_count_prior: c.listing_count,
        },
        metadata: {
          agent_rea_ids: c.agent_rea_ids || [],
          agency_rea_ids: c.agency_rea_ids || [],
          run_id: runId,
        },
        source: GENERATOR,
        idempotency_key: tlKey,
      });
    } else {
      result.timeline_skipped_dup++;
    }
  }

  // ── 4. Insert in chunks — the partial unique index catches any races ───
  async function chunkInsert(
    table: string,
    rows: Array<Record<string, unknown>>,
    chunkSize = 100,
  ): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { data, error } = await admin.from(table).insert(chunk).select('id');
      if (error) {
        // The unique index on idempotency_key is partial — on a race a whole
        // batch can fail. Fall back to row-by-row so a single collision
        // doesn't drop 99 other fresh signals.
        console.warn(`[pulseRelistDetector] chunk insert on ${table} failed (${error.message}); retrying row-by-row`);
        for (const row of chunk) {
          const { error: e2, data: d2 } = await admin.from(table).insert(row).select('id');
          if (!e2) inserted += d2?.length || 1;
          else if (!String(e2.message).toLowerCase().includes('duplicate')) {
            result.errors.push(`${table}: ${e2.message}`);
          }
        }
      } else {
        inserted += data?.length || 0;
      }
    }
    return inserted;
  }

  try {
    if (signalsToInsert.length)  result.signals_inserted  = await chunkInsert('pulse_signals',  signalsToInsert);
    if (timelineToInsert.length) result.timeline_inserted = await chunkInsert('pulse_timeline', timelineToInsert);
  } catch (err: any) {
    result.errors.push(err?.message || String(err));
    recordError(ctx, err, 'error');
  }
  // Mirror row-level insert errors into the shared context so they land in
  // result_summary.errors for drill-through debugging.
  for (const e of result.errors) recordError(ctx, e, 'warn');

  // ── 5. Emit a run-summary timeline row so ops can see each run ─────────
  // Kept for backward compatibility with the PulseTimeline UI filter.
  try {
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'data_sync',
      event_category: 'system',
      title:
        `Relist detector: ${result.signals_inserted} new signal${result.signals_inserted === 1 ? '' : 's'} ` +
        `(${result.candidates} candidate${result.candidates === 1 ? '' : 's'})`,
      description:
        `Lookback ${lookbackDays}d. Inserted ${result.signals_inserted} signals, ` +
        `${result.timeline_inserted} timeline events. ` +
        `Skipped ${result.signals_skipped_dup} duplicate signals.`,
      new_value: {
        lookback_days: lookbackDays, since,
        candidates: result.candidates,
        signals_inserted: result.signals_inserted,
        timeline_inserted: result.timeline_inserted,
        signals_skipped_dup: result.signals_skipped_dup,
        timeline_skipped_dup: result.timeline_skipped_dup,
        errors: result.errors,
        sync_log_id: ctx.syncLogId,
      },
      source: GENERATOR,
      idempotency_key: `${GENERATOR}:run:${runId}`,
    });
  } catch { /* non-fatal */ }

  // ── 6. Close observability run ─────────────────────────────────────────
  const finalStatus = result.errors.length > 0 ? 'failed' : 'completed';
  await endRun(ctx, {
    status: finalStatus,
    recordsFetched: result.candidates,
    recordsUpdated: result.signals_inserted + result.timeline_inserted,
    recordsDetail: {
      candidates: result.candidates,
      signals_inserted: result.signals_inserted,
      timeline_inserted: result.timeline_inserted,
      signals_skipped_dup: result.signals_skipped_dup,
      timeline_skipped_dup: result.timeline_skipped_dup,
    },
    sourceLabel: `${SOURCE_ID} · ${result.signals_inserted} new · ${lookbackDays}d`,
    suburb: 'relist detect',
    customSummary: {
      lookback_days: lookbackDays,
      since,
      candidates: result.candidates,
      signals_inserted: result.signals_inserted,
      timeline_inserted: result.timeline_inserted,
      signals_skipped_dup: result.signals_skipped_dup,
      timeline_skipped_dup: result.timeline_skipped_dup,
      sample_titles: result.sample_titles,
      run_id: runId,
    },
  });

  return jsonResponse({
    ok: true,
    run_id: runId,
    sync_log_id: ctx.syncLogId,
    lookback_days: lookbackDays,
    duration_ms: Date.now() - startedAt,
    ...result,
  }, 200, req);
});
