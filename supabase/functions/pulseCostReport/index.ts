import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

/**
 * pulseCostReport — aggregate Apify billing per source across 24h/7d/30d.
 *
 * ── Purpose ────────────────────────────────────────────────────────────────
 * OP03 (2026-04-18) added `apify_billed_cost_usd` and
 * `value_producing_cost_usd` to pulse_sync_log_payloads.result_summary for
 * every Pulse sync. This endpoint rolls those up so:
 *   - The Ops dashboard can show $/source/day
 *   - The weekly Ops email can include a cost table
 *   - Anyone debugging "why did our Apify bill spike" has a single URL
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * GET only. master_admin OR service_role. This is sensitive billing data —
 * no anonymous/public access.
 *
 * ── Data model ─────────────────────────────────────────────────────────────
 * Single round-trip approach (no PostgREST JOIN possible — pulse_sync_logs
 * and pulse_sync_log_payloads have no FK). We fire three queries in parallel:
 *
 *   1. pulse_sync_logs (id, source_id, started_at) for last 30d
 *   2. pulse_sync_log_payloads (sync_log_id, result_summary) for logs in set 1
 *   3. pulse_source_configs (source_id, actor_slug) to map actor labels
 *
 * Then join in-memory by sync_log_id and aggregate into 24h/7d/30d buckets,
 * by source_id and by actor_slug. Rows with null result_summary (pre-OP03
 * legacy or failed-before-payload-write) count as 0 cost, runs += 1.
 *
 * ── Budget ─────────────────────────────────────────────────────────────────
 * 15s hard cap. At ~300 runs/day × 30d = ~9k rows. Well under PostgREST's
 * 1000-row default — we explicitly raise the limit to 20k to be safe.
 */

const EXECUTION_BUDGET_MS = 15_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

type WindowKey = '24h' | '7d' | '30d';
type WindowBucket = {
  apify_billed_usd: number;
  value_producing_usd: number;
  runs: number;
};

type WindowedTotals = Record<WindowKey, WindowBucket>;

const emptyBucket = (): WindowBucket => ({
  apify_billed_usd: 0,
  value_producing_usd: 0,
  runs: 0,
});

const emptyWindowed = (): WindowedTotals => ({
  '24h': emptyBucket(),
  '7d': emptyBucket(),
  '30d': emptyBucket(),
});

/**
 * Coerce an unknown JSONB value to a finite number or 0.
 * result_summary entries may be strings (older rows), null, undefined, or NaN.
 */
function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** Round to 4dp — costs can be sub-cent but nobody needs more than that. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function roundBucket(b: WindowBucket): WindowBucket {
  return {
    apify_billed_usd: round4(b.apify_billed_usd),
    value_producing_usd: round4(b.value_producing_usd),
    runs: b.runs,
  };
}

function roundWindowed(w: WindowedTotals): WindowedTotals {
  return {
    '24h': roundBucket(w['24h']),
    '7d': roundBucket(w['7d']),
    '30d': roundBucket(w['30d']),
  };
}

serveWithAudit('pulseCostReport', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // GET only
  if (req.method.toUpperCase() !== 'GET') {
    // Support _health_check probes via POST for edgeFunctionHealth parity
    if (req.method.toUpperCase() === 'POST') {
      try {
        const body = await req.clone().json().catch(() => ({}));
        if (body?._health_check) {
          return jsonResponse({ _version: 'v1.0', _fn: 'pulseCostReport' }, 200, req);
        }
      } catch { /* not JSON */ }
    }
    return errorResponse('Method not allowed. Use GET.', 405, req);
  }

  // ── Auth gate ────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden — master_admin or service_role only', 403, req);
    }
  }

  const startedAt = Date.now();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const windowStart30d = new Date(now - 30 * MS_PER_DAY).toISOString();
  const threshold24h = now - 24 * MS_PER_HOUR;
  const threshold7d = now - 7 * MS_PER_DAY;

  const admin = getAdminClient();

  // PostgREST caps a single select at 1000 rows — we need full 30d coverage
  // for cost totals, so we paginate via .range() until a page returns fewer
  // than PAGE_SIZE rows. Each call is ~5-30ms so 5 pages fits well under 15s.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20; // 20k row safety cap (~6 months of Pulse traffic)

  async function fetchAllLogs() {
    const out: Array<{ id: string; source_id: string | null; started_at: string }> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await admin
        .from('pulse_sync_logs')
        .select('id, source_id, started_at')
        .gte('started_at', windowStart30d)
        .order('started_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw new Error(`pulse_sync_logs: ${error.message}`);
      if (!data || data.length === 0) break;
      out.push(...(data as any[]));
      if (data.length < PAGE_SIZE) break;
    }
    return out;
  }

  async function fetchAllPayloads() {
    const out: Array<{ sync_log_id: string; result_summary: any }> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await admin
        .from('pulse_sync_log_payloads')
        .select('sync_log_id, result_summary')
        .gte('created_at', windowStart30d)
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw new Error(`pulse_sync_log_payloads: ${error.message}`);
      if (!data || data.length === 0) break;
      out.push(...(data as any[]));
      if (data.length < PAGE_SIZE) break;
    }
    return out;
  }

  let logs: Array<{ id: string; source_id: string | null; started_at: string }>;
  let payloads: Array<{ sync_log_id: string; result_summary: any }>;
  let sources: Array<{ source_id: string; actor_slug: string | null }>;
  try {
    const [logsData, payloadsData, sourcesRes] = await Promise.all([
      fetchAllLogs(),
      fetchAllPayloads(),
      admin
        .from('pulse_source_configs')
        .select('source_id, actor_slug'),
    ]);
    if (sourcesRes.error) {
      return errorResponse(`Failed to read pulse_source_configs: ${sourcesRes.error.message}`, 500, req);
    }
    logs = logsData;
    payloads = payloadsData;
    sources = sourcesRes.data || [];
  } catch (err: any) {
    return errorResponse(`Failed to read cost-report inputs: ${err?.message || err}`, 500, req);
  }

  // source_id → actor_slug lookup
  const actorBySource = new Map<string, string | null>();
  for (const s of sources) {
    actorBySource.set(s.source_id, s.actor_slug ?? null);
  }

  // sync_log_id → result_summary lookup
  const payloadBySyncLog = new Map<string, any>();
  for (const p of payloads) {
    payloadBySyncLog.set(p.sync_log_id, p.result_summary ?? null);
  }

  // ── Aggregate ────────────────────────────────────────────────────────────
  const totals: WindowedTotals = emptyWindowed();
  const bySource: Record<string, WindowedTotals> = {};
  const byActor: Record<string, WindowedTotals> = {};

  // For cost_per_record: track records per source in last 7d
  const recordsBySource7d: Record<string, number> = {};
  const billedBySource7d: Record<string, number> = {};
  const valueProducingBySource7d: Record<string, number> = {};

  for (const log of logs) {
    const startedMs = log.started_at ? new Date(log.started_at).getTime() : NaN;
    if (!Number.isFinite(startedMs)) continue;

    const sourceId = log.source_id || 'unknown';
    const actorSlug = actorBySource.get(sourceId) || 'unknown';

    const rs = payloadBySyncLog.get(log.id);
    // Rows with null result_summary — legacy/pre-OP03 or failures that never
    // wrote a payload. Still counts as a run (matters for run-volume audits)
    // but zero cost.
    const billed = toNum(rs?.apify_billed_cost_usd);
    const valueProducing = toNum(rs?.value_producing_cost_usd);
    const items = toNum(rs?.items_processed);

    // Determine which windows this row falls into
    const in30d = startedMs >= now - 30 * MS_PER_DAY;
    const in7d = startedMs >= threshold7d;
    const in24h = startedMs >= threshold24h;

    // totals
    if (in30d) {
      totals['30d'].apify_billed_usd += billed;
      totals['30d'].value_producing_usd += valueProducing;
      totals['30d'].runs += 1;
    }
    if (in7d) {
      totals['7d'].apify_billed_usd += billed;
      totals['7d'].value_producing_usd += valueProducing;
      totals['7d'].runs += 1;
    }
    if (in24h) {
      totals['24h'].apify_billed_usd += billed;
      totals['24h'].value_producing_usd += valueProducing;
      totals['24h'].runs += 1;
    }

    // bySource
    if (!bySource[sourceId]) bySource[sourceId] = emptyWindowed();
    if (in30d) {
      bySource[sourceId]['30d'].apify_billed_usd += billed;
      bySource[sourceId]['30d'].value_producing_usd += valueProducing;
      bySource[sourceId]['30d'].runs += 1;
    }
    if (in7d) {
      bySource[sourceId]['7d'].apify_billed_usd += billed;
      bySource[sourceId]['7d'].value_producing_usd += valueProducing;
      bySource[sourceId]['7d'].runs += 1;

      // For cost_per_record (7d window)
      billedBySource7d[sourceId] = (billedBySource7d[sourceId] || 0) + billed;
      valueProducingBySource7d[sourceId] = (valueProducingBySource7d[sourceId] || 0) + valueProducing;
      recordsBySource7d[sourceId] = (recordsBySource7d[sourceId] || 0) + items;
    }
    if (in24h) {
      bySource[sourceId]['24h'].apify_billed_usd += billed;
      bySource[sourceId]['24h'].value_producing_usd += valueProducing;
      bySource[sourceId]['24h'].runs += 1;
    }

    // byActor (may be 'unknown' for legacy rows without a configured source)
    if (!byActor[actorSlug]) byActor[actorSlug] = emptyWindowed();
    if (in30d) {
      byActor[actorSlug]['30d'].apify_billed_usd += billed;
      byActor[actorSlug]['30d'].value_producing_usd += valueProducing;
      byActor[actorSlug]['30d'].runs += 1;
    }
    if (in7d) {
      byActor[actorSlug]['7d'].apify_billed_usd += billed;
      byActor[actorSlug]['7d'].value_producing_usd += valueProducing;
      byActor[actorSlug]['7d'].runs += 1;
    }
    if (in24h) {
      byActor[actorSlug]['24h'].apify_billed_usd += billed;
      byActor[actorSlug]['24h'].value_producing_usd += valueProducing;
      byActor[actorSlug]['24h'].runs += 1;
    }
  }

  // ── Efficiency derivations ───────────────────────────────────────────────
  // worst_source_last_7d = lowest (value_producing / billed) ratio among
  // sources with non-trivial billed spend in 7d. We require billed >= $0.01
  // to avoid naming sources that only cost $0.0001 due to rounding noise.
  let worstSourceLast7d: string | null = null;
  let worstRatio = Infinity;
  for (const [sid, spend] of Object.entries(billedBySource7d)) {
    if (spend < 0.01) continue;
    const vp = valueProducingBySource7d[sid] || 0;
    const ratio = vp / spend;
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstSourceLast7d = sid;
    }
  }

  const costPerRecord: Record<string, number> = {};
  for (const [sid, records] of Object.entries(recordsBySource7d)) {
    if (records <= 0) continue;
    const spend = billedBySource7d[sid] || 0;
    costPerRecord[sid] = round4(spend / records);
  }

  // ── Round all numbers to 4dp ─────────────────────────────────────────────
  const roundedBySource: Record<string, WindowedTotals> = {};
  for (const [sid, w] of Object.entries(bySource)) roundedBySource[sid] = roundWindowed(w);
  const roundedByActor: Record<string, WindowedTotals> = {};
  for (const [a, w] of Object.entries(byActor)) roundedByActor[a] = roundWindowed(w);

  const durationMs = Date.now() - startedAt;
  if (durationMs > EXECUTION_BUDGET_MS) {
    console.warn(`[pulseCostReport] exceeded budget: ${durationMs}ms`);
  }

  return jsonResponse(
    {
      generated_at: nowIso,
      totals: {
        last_24h: roundBucket(totals['24h']),
        last_7d: roundBucket(totals['7d']),
        last_30d: roundBucket(totals['30d']),
      },
      by_source: roundedBySource,
      by_actor: roundedByActor,
      cost_efficiency: {
        worst_source_last_7d: worstSourceLast7d,
        cost_per_record: costPerRecord,
      },
      meta: {
        logs_scanned: logs.length,
        payloads_scanned: payloads.length,
        duration_ms: durationMs,
      },
    },
    200,
    req,
  );
});
