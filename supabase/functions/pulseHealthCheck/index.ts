import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * pulseHealthCheck — Single JSON health endpoint for the Industry Pulse subsystem.
 *
 * ── Purpose ────────────────────────────────────────────────────────────────
 * Uptime monitors (and humans) need one URL to ask "is Industry Pulse OK?".
 * This function aggregates queue depth, cron cadence, circuit-breaker state,
 * sync-log failure rates, signal backlog, and data-integrity counts into a
 * single JSON response with a rolled-up top-level `status` enum.
 *
 * ── Methods ────────────────────────────────────────────────────────────────
 *   GET   — unauthenticated; returns the full JSON shape but with
 *           `sensitive` fields stripped (no raw error messages). Safe for
 *           external uptime probes.
 *   POST  — admin-gated (master_admin or service-role); returns the full
 *           detail including `circuit_breakers.sample_errors` and any other
 *           error-message fields that could leak stack traces / SQL.
 *
 * ── Aggregate status rule ─────────────────────────────────────────────────
 *   unhealthy  if ANY:
 *     - any circuit_breaker has been open for >60min
 *     - queue.stuck_over_20min > 0
 *     - silent_empty rate > 50% on any source in last 24h
 *   degraded   if ANY:
 *     - last_success_minutes_ago > 2x expected cadence on any source
 *     - DLQ > 0 (pulse_fire_queue.status='failed' in last 24h)
 *   healthy    otherwise
 *
 * ── Budget ────────────────────────────────────────────────────────────────
 * 15 seconds hard cap. All queries fire in parallel via Promise.all. Each
 * query has its own try/catch so a single slow/broken table does not poison
 * the rest of the report.
 */

const EXECUTION_BUDGET_MS = 15_000;

// Interpret schedule_cron (5-field form) into an expected cadence in minutes.
// We approximate: the tightest interval the expression fires at within a day.
// Good enough for "last_success_minutes_ago > 2x expected cadence" checks.
// Returns null if no cron is set (manual/on-demand source).
function cronToExpectedMinutes(cronExpr: string | null | undefined): number | null {
  if (!cronExpr) return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;

  // Step patterns: */N in the minute field → every N minutes.
  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep) return parseInt(minuteStep[1], 10);
  if (minute === '*') return 1;

  // Step pattern in hour field → every N hours.
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep) return parseInt(hourStep[1], 10) * 60;

  // Multiple explicit hours ("0 8,20 * * *") → figure out tightest gap.
  if (hour.includes(',')) {
    const hours = hour.split(',').map((h) => parseInt(h, 10)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    if (hours.length >= 2) {
      let smallest = 24 * 60;
      for (let i = 0; i < hours.length; i++) {
        const next = i + 1 < hours.length ? hours[i + 1] : hours[0] + 24;
        smallest = Math.min(smallest, (next - hours[i]) * 60);
      }
      return smallest;
    }
  }

  // Weekly if dow is a specific day (not *)
  if (dow !== '*' && !dow.includes(',') && !/^\d+-\d+$/.test(dow)) {
    return 7 * 24 * 60; // weekly
  }

  // Monthly if dom is a specific day
  if (dom !== '*' && !dom.includes(',')) {
    return 30 * 24 * 60; // monthly approximation
  }

  // Default: daily
  return 24 * 60;
}

// Utility: safely resolve a promise with a fallback on rejection
async function safeResolve<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await p;
  } catch (err: any) {
    console.warn(`[pulseHealthCheck] ${label} failed:`, err?.message);
    return fallback;
  }
}

serveWithAudit('pulseHealthCheck', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return errorResponse('Method not allowed. Use GET (public) or POST (admin).', 405, req);
  }

  // ── Health-check probe bypass (for edgeFunctionHealth auditing) ─────────
  let body: any = {};
  if (method === 'POST') {
    try { body = await req.clone().json().catch(() => ({})); } catch { body = {}; }
    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: 'pulseHealthCheck' }, 200, req);
    }
  }

  // ── Admin gate for POST (full-detail response) ──────────────────────────
  // GET always returns — uptime monitors hit GET unauthenticated.
  // POST requires master_admin OR service-role to include sensitive fields.
  let isAdmin = false;
  if (method === 'POST') {
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required for POST. Use GET for public summary.', 401, req);
      if (user.role !== 'master_admin') return errorResponse('Forbidden: POST requires master_admin.', 403, req);
    }
    isAdmin = true;
  }

  const admin = getAdminClient();
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();

  // ── Parallel queries — each wrapped in safeResolve so one failure does not
  // poison the whole report. Keeps us under the 15s budget comfortably. ─────
  const [
    queueCounts,
    sourceRows,
    breakerRows,
    syncLogs24h,
    stuckSyncLogs,
    signalNew,
    signalUnactioned7d,
    unanchoredTimeline,
    orphanListingsAgent,
    orphanListingsAgency,
  ] = await Promise.all([
    // Queue counts — pending / running / stuck>20min / dlq (failed in last 24h)
    safeResolve(
      (async () => {
        const [pending, running, stuck, dlq] = await Promise.all([
          admin.from('pulse_fire_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
          admin.from('pulse_fire_queue').select('*', { count: 'exact', head: true }).eq('status', 'running'),
          admin.from('pulse_fire_queue').select('*', { count: 'exact', head: true })
            .eq('status', 'running')
            .lt('dispatched_at', new Date(Date.now() - 20 * 60 * 1000).toISOString()),
          admin.from('pulse_fire_queue').select('*', { count: 'exact', head: true })
            .eq('status', 'failed')
            .gte('updated_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
        ]);
        return {
          pending: pending.count ?? 0,
          running: running.count ?? 0,
          stuck_over_20min: stuck.count ?? 0,
          dlq: dlq.count ?? 0,
        };
      })(),
      { pending: 0, running: 0, stuck_over_20min: 0, dlq: 0 },
      'queueCounts',
    ),

    // Source configs — drives cadence checks
    safeResolve(
      admin.from('pulse_source_configs')
        .select('source_id, label, is_enabled, schedule_cron, last_run_at')
        .eq('is_enabled', true)
        .then((r) => r.data || []),
      [] as Array<{ source_id: string; label: string | null; is_enabled: boolean; schedule_cron: string | null; last_run_at: string | null }>,
      'sourceRows',
    ),

    // Circuit breakers
    safeResolve(
      admin.from('pulse_source_circuit_breakers')
        .select('source_id, state, consecutive_failures, opened_at, reopen_at')
        .then((r) => r.data || []),
      [] as Array<{ source_id: string; state: string; consecutive_failures: number; opened_at: string | null; reopen_at: string | null }>,
      'breakerRows',
    ),

    // Sync logs in last 24h — fetch just enough columns to compute stats
    // We limit to 2000 rows (last 24h typically has <500 even at peak).
    safeResolve(
      admin.from('pulse_sync_logs')
        .select('source_id, status, records_fetched, started_at, completed_at, error_message')
        .gte('started_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
        .order('started_at', { ascending: false })
        .limit(2000)
        .then((r) => r.data || []),
      [] as Array<{ source_id: string | null; status: string; records_fetched: number | null; started_at: string; completed_at: string | null; error_message: string | null }>,
      'syncLogs24h',
    ),

    // Stuck sync-logs (status=running > 20min) — independent count
    safeResolve(
      admin.from('pulse_sync_logs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'running')
        .lt('started_at', new Date(Date.now() - 20 * 60 * 1000).toISOString())
        .then((r) => r.count ?? 0),
      0,
      'stuckSyncLogs',
    ),

    // Signals — new
    safeResolve(
      admin.from('pulse_signals').select('*', { count: 'exact', head: true })
        .eq('status', 'new')
        .then((r) => r.count ?? 0),
      0,
      'signalNew',
    ),

    // Signals — unactioned (new or acknowledged) older than 7d
    safeResolve(
      admin.from('pulse_signals').select('*', { count: 'exact', head: true })
        .in('status', ['new', 'acknowledged'])
        .lt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
        .then((r) => r.count ?? 0),
      0,
      'signalUnactioned7d',
    ),

    // Data integrity — unanchored timeline
    safeResolve(
      admin.from('pulse_timeline').select('*', { count: 'exact', head: true })
        .is('pulse_entity_id', null)
        .then((r) => r.count ?? 0),
      0,
      'unanchoredTimeline',
    ),

    // Data integrity — orphan listings (agent_rea_id present, no matching agent)
    // Postgres has no simple NOT EXISTS via PostgREST; we rely on the
    // agent_pulse_id column which is kept in sync by migration 123 triggers.
    safeResolve(
      admin.from('pulse_listings').select('*', { count: 'exact', head: true })
        .not('agent_rea_id', 'is', null)
        .is('agent_pulse_id', null)
        .then((r) => r.count ?? 0),
      0,
      'orphanListingsAgent',
    ),

    // Data integrity — orphan listings (agency_rea_id present, no matching agency)
    safeResolve(
      admin.from('pulse_listings').select('*', { count: 'exact', head: true })
        .not('agency_rea_id', 'is', null)
        .is('agency_pulse_id', null)
        .then((r) => r.count ?? 0),
      0,
      'orphanListingsAgency',
    ),
  ]);

  // ── Derive per-source stats from the raw sync-log rows ──────────────────
  // For each enabled source we compute:
  //   last_success_minutes_ago — for cadence check
  //   last_status              — most recent sync_log row status
  //   cadence_ok               — (minutes_ago <= 2x expected) OR last_run == null
  //   backlog                  — per-source pending+running queue depth
  //   silent_empty_rate_24h    — share of completed runs w/ records_fetched=0
  const perSource: Array<{
    source_id: string;
    last_success_minutes_ago: number | null;
    last_status: string | null;
    cadence_ok: boolean;
    backlog: number;
  }> = [];

  const silentEmptyBySource: Record<string, { completed: number; empty: number }> = {};
  const latestBySource: Record<string, { completedAt: Date | null; latestStatus: string | null; latestAt: Date | null }> = {};

  for (const row of syncLogs24h) {
    const sid = row.source_id || 'unknown';
    if (!silentEmptyBySource[sid]) silentEmptyBySource[sid] = { completed: 0, empty: 0 };
    if (!latestBySource[sid]) latestBySource[sid] = { completedAt: null, latestStatus: null, latestAt: null };

    const startedDate = row.started_at ? new Date(row.started_at) : null;
    if (startedDate && (!latestBySource[sid].latestAt || startedDate > latestBySource[sid].latestAt!)) {
      latestBySource[sid].latestStatus = row.status;
      latestBySource[sid].latestAt = startedDate;
    }
    if (row.status === 'completed') {
      silentEmptyBySource[sid].completed += 1;
      if ((row.records_fetched ?? 0) === 0) silentEmptyBySource[sid].empty += 1;
      const completedDate = row.completed_at ? new Date(row.completed_at) : startedDate;
      if (completedDate && (!latestBySource[sid].completedAt || completedDate > latestBySource[sid].completedAt!)) {
        latestBySource[sid].completedAt = completedDate;
      }
    }
  }

  // Per-source queue backlog (pending + running) — single round trip covering
  // only enabled sources. Unknown/unused source rows are silently dropped.
  const enabledIds = sourceRows.map((s) => s.source_id);
  let backlogBySource: Record<string, number> = {};
  if (enabledIds.length > 0) {
    try {
      const { data: backlogRows } = await admin
        .from('pulse_fire_queue')
        .select('source_id, status')
        .in('source_id', enabledIds)
        .in('status', ['pending', 'running']);
      for (const r of backlogRows || []) {
        backlogBySource[r.source_id] = (backlogBySource[r.source_id] || 0) + 1;
      }
    } catch (err: any) {
      console.warn('[pulseHealthCheck] backlogBySource failed:', err?.message);
    }
  }

  // ── Build per-source cron status + aggregate flags ──────────────────────
  let anyCadenceStale = false;
  let anySilentEmptyOver50 = false;

  for (const src of sourceRows) {
    const expectedMin = cronToExpectedMinutes(src.schedule_cron);
    const completedAt = latestBySource[src.source_id]?.completedAt
      || (src.last_run_at ? new Date(src.last_run_at) : null);
    const lastSuccessMinAgo = completedAt
      ? Math.round((Date.now() - completedAt.getTime()) / 60000)
      : null;

    let cadenceOk = true;
    if (expectedMin != null && lastSuccessMinAgo != null) {
      cadenceOk = lastSuccessMinAgo <= expectedMin * 2;
      if (!cadenceOk) anyCadenceStale = true;
    } else if (expectedMin != null && lastSuccessMinAgo == null) {
      // Source has a cron but nothing ever succeeded → stale
      cadenceOk = false;
      anyCadenceStale = true;
    }

    const se = silentEmptyBySource[src.source_id];
    if (se && se.completed >= 4 && se.empty / se.completed > 0.5) {
      anySilentEmptyOver50 = true;
    }

    perSource.push({
      source_id: src.source_id,
      last_success_minutes_ago: lastSuccessMinAgo,
      last_status: latestBySource[src.source_id]?.latestStatus || null,
      cadence_ok: cadenceOk,
      backlog: backlogBySource[src.source_id] || 0,
    });
  }

  // ── Circuit-breaker roll-up ─────────────────────────────────────────────
  const openSources: string[] = [];
  let anyOpenOver60min = false;
  const breakerErrorSamples: Array<{ source_id: string; consecutive_failures: number; opened_at: string | null }> = [];
  for (const b of breakerRows) {
    if (b.state === 'open') {
      openSources.push(b.source_id);
      breakerErrorSamples.push({
        source_id: b.source_id,
        consecutive_failures: b.consecutive_failures,
        opened_at: b.opened_at,
      });
      if (b.opened_at) {
        const openedMs = Date.now() - new Date(b.opened_at).getTime();
        if (openedMs > 60 * 60 * 1000) anyOpenOver60min = true;
      }
    }
  }

  // ── Sync-log 24h aggregates ─────────────────────────────────────────────
  const totalLogs = syncLogs24h.length;
  const failedLogs = syncLogs24h.filter((r) => r.status === 'failed').length;
  const silentEmptyLogs = syncLogs24h.filter((r) => r.status === 'completed' && (r.records_fetched ?? 0) === 0).length;

  // ── Top-level status rule ───────────────────────────────────────────────
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (anyOpenOver60min || queueCounts.stuck_over_20min > 0 || anySilentEmptyOver50) {
    status = 'unhealthy';
  } else if (anyCadenceStale || queueCounts.dlq > 0) {
    status = 'degraded';
  }

  // ── Response shape ──────────────────────────────────────────────────────
  const pulse = {
    queue: queueCounts,
    crons: perSource,
    circuit_breakers: {
      all_closed: openSources.length === 0,
      open_sources: openSources,
      // Only included for POST+admin — sensitive operational detail
      ...(isAdmin ? { sample_errors: breakerErrorSamples } : {}),
    },
    sync_logs: {
      last_24h_total: totalLogs,
      last_24h_failed: failedLogs,
      last_24h_silent_empty: silentEmptyLogs,
      stuck_running_over_20min: stuckSyncLogs,
      // Only admins see the error sample — often contains SQL / stack fragments
      ...(isAdmin
        ? {
            recent_errors: syncLogs24h
              .filter((r) => r.status === 'failed' && r.error_message)
              .slice(0, 5)
              .map((r) => ({
                source_id: r.source_id,
                started_at: r.started_at,
                error_message: r.error_message,
              })),
          }
        : {}),
    },
    signals: {
      new: signalNew,
      unactioned_older_than_7d: signalUnactioned7d,
    },
    data_integrity: {
      unanchored_timeline: unanchoredTimeline,
      orphan_listings_agent: orphanListingsAgent,
      orphan_listings_agency: orphanListingsAgency,
    },
  };

  const durationMs = Date.now() - startedAt;
  // If we somehow blew the budget, warn but still return — better partial
  // data than a 500 for the uptime probe.
  if (durationMs > EXECUTION_BUDGET_MS) {
    console.warn(`[pulseHealthCheck] exceeded budget: ${durationMs}ms`);
  }

  return jsonResponse(
    {
      status,
      checked_at: nowIso,
      ...(isAdmin ? { duration_ms: durationMs } : {}),
      pulse,
    },
    200,
    req,
  );
});
