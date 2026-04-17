/**
 * edgeFunctionHealth
 *
 * Admin-only diagnostic endpoint that aggregates Supabase Edge Function
 * invocation metrics from the platform's Log Explorer so we can catch
 * silent breakage (like the 2026-04 auth-key migration that broke 23
 * functions for 18+ hours before anyone noticed).
 *
 * Actions / query modes:
 *   - default (no function / no action):
 *       Returns per-function aggregates over last 24h:
 *         { total_calls, success_count, error_count, success_rate,
 *           p50_ms, p95_ms, last_error_ts, last_error_status }
 *   - ?function=NAME or body { function: "NAME" }:
 *       Returns the 50 most recent 4xx/5xx events for that function, with
 *       timestamp, status, execution_time, execution_id, and event_message.
 *   - action: "health_check", function: "NAME":
 *       Proxies a `{ _health_check: true }` POST to that function and
 *       returns its reply + measured latency.
 *
 * Security:
 *   - Gated to master_admin + admin only.
 *   - The Management API token is read from env (SUPABASE_MANAGEMENT_API_TOKEN)
 *     and NEVER echoed back in responses or logged.
 */

import {
  getAdminClient,
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
} from '../_shared/supabase.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const LEGACY_ANON_JWT = Deno.env.get('LEGACY_ANON_JWT') || '';
const LEGACY_SERVICE_ROLE_JWT = Deno.env.get('LEGACY_SERVICE_ROLE_JWT') || '';
const PROJECT_REF = (() => {
  try {
    // https://<ref>.supabase.co → <ref>
    const u = new URL(SUPABASE_URL);
    return u.hostname.split('.')[0];
  } catch {
    return '';
  }
})();
const MGMT_ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all`;
const LOOKBACK_HOURS = 24;

// ─── Log Explorer query helpers ──────────────────────────────────────────────

/**
 * Run a Log Explorer SQL query with an explicit lookback window.
 * Returns parsed result rows or throws.
 *
 * Important: the default window is only a minute or so when no
 * iso_timestamp_start/_end params are supplied. We always pass a
 * LOOKBACK_HOURS → now window to get useful data.
 */
async function runLogQuery(sql: string): Promise<any[]> {
  // Supabase CLI refuses secrets with SUPABASE_ prefix, so we use MANAGEMENT_API_TOKEN.
  // Fall back to SUPABASE_MANAGEMENT_API_TOKEN for anyone who sets it through the dashboard UI.
  const token = Deno.env.get('MANAGEMENT_API_TOKEN') || Deno.env.get('SUPABASE_MANAGEMENT_API_TOKEN');
  if (!token) {
    throw new Error('MANAGEMENT_API_TOKEN secret is not set');
  }
  if (!PROJECT_REF) {
    throw new Error('Unable to derive Supabase project ref from SUPABASE_URL');
  }

  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  // Pad end by 5 min to cover clock skew.
  const end = new Date(now.getTime() + 5 * 60 * 1000);

  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
  });

  const res = await fetch(`${MGMT_ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    // Don't leak token or full URL back to the caller — scrub the response text.
    const text = await res.text().catch(() => '');
    const safe = text.length > 500 ? text.slice(0, 500) + '…' : text;
    throw new Error(`Log Explorer query failed (${res.status}): ${safe}`);
  }

  const json = await res.json().catch(() => ({ result: [], error: 'invalid JSON' }));
  if (json.error) throw new Error(`Log Explorer: ${json.error}`);
  return Array.isArray(json.result) ? json.result : [];
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Per-function 24h aggregate stats.
 *
 * Note: `error_count` counts only 5xx (server faults). 4xx responses are
 * client errors — bad params, missing auth, forbidden — and are well-formed
 * API behaviour. They're surfaced separately as `client_error_count` so we
 * can still drill in, but they don't drag the success-rate badge down or
 * flag the function in the "needs attention" bucket.
 */
const AGG_SQL = `
  SELECT
    REGEXP_EXTRACT(req.pathname, r'/functions/v1/([^/?]+)') AS function_name,
    COUNT(*) AS total_calls,
    COUNTIF(resp.status_code >= 200 AND resp.status_code < 400) AS success_count,
    COUNTIF(resp.status_code >= 400 AND resp.status_code < 500) AS client_error_count,
    COUNTIF(resp.status_code >= 500) AS error_count,
    APPROX_QUANTILES(meta.execution_time_ms, 100)[OFFSET(50)] AS p50_ms,
    APPROX_QUANTILES(meta.execution_time_ms, 100)[OFFSET(95)] AS p95_ms
  FROM function_edge_logs
  CROSS JOIN UNNEST(metadata) AS meta
  CROSS JOIN UNNEST(meta.request) AS req
  CROSS JOIN UNNEST(meta.response) AS resp
  WHERE req.pathname IS NOT NULL
  GROUP BY function_name
  ORDER BY error_count DESC, total_calls DESC
`;

/**
 * Most recent server-error timestamp + status per function over the last 24h.
 * Only tracks 5xx here — 4xx is client-caused and doesn't indicate a server issue.
 * Used to decorate the aggregate rows with a "last error" column.
 */
const LAST_ERR_SQL = `
  SELECT
    REGEXP_EXTRACT(req.pathname, r'/functions/v1/([^/?]+)') AS function_name,
    MAX(timestamp) AS last_error_ts,
    ANY_VALUE(resp.status_code) AS last_error_status,
    ANY_VALUE(event_message) AS last_error_message
  FROM function_edge_logs
  CROSS JOIN UNNEST(metadata) AS meta
  CROSS JOIN UNNEST(meta.request) AS req
  CROSS JOIN UNNEST(meta.response) AS resp
  WHERE resp.status_code >= 500
    AND req.pathname IS NOT NULL
  GROUP BY function_name
`;

/** 50 most recent 4xx/5xx events for a specific function. */
function errorDetailSql(fn: string): string {
  // fn has been validated by the caller (alphanum + - + _) before we build SQL,
  // so this inline substitution is safe.
  return `
    SELECT
      timestamp,
      event_message,
      resp.status_code AS status_code,
      meta.execution_time_ms AS execution_time_ms,
      meta.execution_id AS execution_id
    FROM function_edge_logs
    CROSS JOIN UNNEST(metadata) AS meta
    CROSS JOIN UNNEST(meta.request) AS req
    CROSS JOIN UNNEST(meta.response) AS resp
    WHERE resp.status_code >= 400
      AND REGEXP_EXTRACT(req.pathname, r'/functions/v1/([^/?]+)') = '${fn}'
    ORDER BY timestamp DESC
    LIMIT 50
  `;
}

// ─── Function-name safety ────────────────────────────────────────────────────

const FN_NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;
function validateFunctionName(fn: unknown): string {
  if (typeof fn !== 'string' || !FN_NAME_RE.test(fn)) {
    throw new Error('Invalid function name');
  }
  return fn;
}

// ─── Aggregate shaping ────────────────────────────────────────────────────────

interface FunctionStat {
  function_name: string;
  total_calls: number;
  success_count: number;
  error_count: number;          // 5xx only (server faults)
  client_error_count: number;   // 4xx (well-formed client errors — not counted as failures)
  success_rate: number;         // 0-100, 2dp — server-fault rate only; treats 4xx as success
  p50_ms: number;
  p95_ms: number;
  last_error_ts: number | null; // epoch ms
  last_error_status: number | null;
  last_error_message: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function microsToMs(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return null;
  return Math.floor(v / 1000);
}

function shapeAggregates(
  aggRows: any[],
  lastErrRows: any[],
): { stats: FunctionStat[]; summary: { total_calls: number; total_errors: number; total_client_errors: number; total_success: number; overall_success_rate: number; high_error_count: number } } {
  const lastErrByFn = new Map<string, any>();
  for (const r of lastErrRows) {
    if (r.function_name) lastErrByFn.set(r.function_name, r);
  }

  const stats: FunctionStat[] = [];
  let gTotal = 0;
  let gErr = 0;             // 5xx only
  let gClientErr = 0;       // 4xx
  let gSucc = 0;

  for (const r of aggRows) {
    const fn = r.function_name;
    if (!fn) continue; // rows with NULL function_name (edge cases)
    const total = Number(r.total_calls || 0);
    const succ = Number(r.success_count || 0);
    const err = Number(r.error_count || 0);
    const clientErr = Number(r.client_error_count || 0);
    const lastErr = lastErrByFn.get(fn);

    gTotal += total;
    gErr += err;
    gClientErr += clientErr;
    gSucc += succ;

    // success_rate treats 4xx as success (well-formed client error, not a fault).
    // Denominator for health is calls that got a response we can blame on the server.
    const faultDenom = total;
    const successLike = succ + clientErr;

    stats.push({
      function_name: fn,
      total_calls: total,
      success_count: succ,
      error_count: err,
      client_error_count: clientErr,
      success_rate: faultDenom === 0 ? 100 : round2((successLike / faultDenom) * 100),
      p50_ms: Number(r.p50_ms || 0),
      p95_ms: Number(r.p95_ms || 0),
      last_error_ts: lastErr ? microsToMs(lastErr.last_error_ts) : null,
      last_error_status: lastErr ? Number(lastErr.last_error_status || 0) || null : null,
      last_error_message: lastErr?.last_error_message ? String(lastErr.last_error_message) : null,
    });
  }

  // Sort: worst server-error-rate first, then highest volume among healthy
  stats.sort((a, b) => {
    const aErrRate = a.total_calls === 0 ? 0 : a.error_count / a.total_calls;
    const bErrRate = b.total_calls === 0 ? 0 : b.error_count / b.total_calls;
    if (aErrRate !== bErrRate) return bErrRate - aErrRate;
    return b.total_calls - a.total_calls;
  });

  // overall_success_rate counts 4xx as success — only genuine server faults drag it down.
  const overallSuccessRate = gTotal === 0 ? 100 : round2(((gSucc + gClientErr) / gTotal) * 100);
  const highErrorCount = stats.filter(s =>
    s.total_calls >= 5 && (s.error_count / s.total_calls) > 0.05
  ).length;

  return {
    stats,
    summary: {
      total_calls: gTotal,
      total_errors: gErr,
      total_client_errors: gClientErr,
      total_success: gSucc,
      overall_success_rate: overallSuccessRate,
      high_error_count: highErrorCount,
    },
  };
}

// ─── Health-check proxy ──────────────────────────────────────────────────────

/**
 * Ping a function's `_health_check` endpoint and return latency + response.
 * Uses a legacy JWT for the Authorization header so verify_jwt=true passes.
 */
async function runHealthCheck(fn: string): Promise<{
  ok: boolean;
  status: number;
  latency_ms: number;
  response: unknown;
  error?: string;
}> {
  // Pick a JWT that will clear verify_jwt=true:
  //   prefer legacy anon JWT (safest — not service-role),
  //   fallback to current anon key if it's a JWT format.
  const jwt = (LEGACY_ANON_JWT && LEGACY_ANON_JWT.startsWith('eyJ'))
    ? LEGACY_ANON_JWT
    : (SUPABASE_ANON_KEY && SUPABASE_ANON_KEY.startsWith('eyJ'))
      ? SUPABASE_ANON_KEY
      : (LEGACY_SERVICE_ROLE_JWT || '');

  if (!jwt) {
    return {
      ok: false,
      status: 0,
      latency_ms: 0,
      response: null,
      error: 'No legacy JWT available for health-check auth',
    };
  }

  const url = `${SUPABASE_URL}/functions/v1/${fn}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: SUPABASE_ANON_KEY || jwt,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _health_check: true }),
    });
    const latency = Date.now() - started;
    const body = await res.text();
    let parsed: unknown = body;
    try { parsed = JSON.parse(body); } catch { /* keep raw text */ }
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: latency,
      response: parsed,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      response: null,
      error: err?.message || String(err),
    };
  }
}

// ─── Auth guard ──────────────────────────────────────────────────────────────

async function requireAdmin(req: Request): Promise<{ ok: true; role: string } | { ok: false; resp: Response }> {
  const user = await getUserFromReq(req).catch(() => null);
  if (!user) {
    return { ok: false, resp: errorResponse('Authentication required', 401, req) };
  }
  if (user.role !== 'master_admin' && user.role !== 'admin') {
    return { ok: false, resp: errorResponse('Forbidden — admin role required', 403, req) };
  }
  return { ok: true, role: user.role };
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Simple version ping
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (!url.searchParams.has('function')) {
      return jsonResponse(
        { status: 'ok', function: 'edgeFunctionHealth', version: 'v1.0.0' },
        200,
        req,
      );
    }
  }

  // Parse body (safe default)
  let body: any = {};
  if (req.method === 'POST') {
    body = await req.json().catch(() => ({}));
  }

  // Support _health_check convention so this function can appear in its own table
  if (body?._health_check) {
    return jsonResponse(
      { _version: 'v1.0.0', _fn: 'edgeFunctionHealth', _ts: '2026-04-17' },
      200,
      req,
    );
  }

  // Auth — admin/master_admin only
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.resp;

  const url = new URL(req.url);
  const queryFn = url.searchParams.get('function');
  const fnFilter = queryFn ?? body?.function ?? null;
  const action = body?.action ?? url.searchParams.get('action') ?? null;

  try {
    // ── Health-check proxy ──
    if (action === 'health_check') {
      const fn = validateFunctionName(fnFilter);
      const result = await runHealthCheck(fn);
      return jsonResponse({ function: fn, ...result }, 200, req);
    }

    // ── Per-function error detail ──
    if (fnFilter) {
      const fn = validateFunctionName(fnFilter);
      const errRows = await runLogQuery(errorDetailSql(fn));
      const errors = errRows.map((r: any) => ({
        timestamp_ms: microsToMs(r.timestamp),
        status_code: Number(r.status_code || 0) || null,
        execution_time_ms: r.execution_time_ms == null ? null : Number(r.execution_time_ms),
        execution_id: r.execution_id || null,
        message: r.event_message || null,
      }));
      return jsonResponse(
        {
          function: fn,
          lookback_hours: LOOKBACK_HOURS,
          count: errors.length,
          errors,
        },
        200,
        req,
      );
    }

    // ── Aggregated overview (default) ──
    const [aggRows, lastErrRows] = await Promise.all([
      runLogQuery(AGG_SQL),
      runLogQuery(LAST_ERR_SQL),
    ]);
    const shaped = shapeAggregates(aggRows, lastErrRows);
    return jsonResponse(
      {
        lookback_hours: LOOKBACK_HOURS,
        generated_at: new Date().toISOString(),
        summary: shaped.summary,
        functions: shaped.stats,
      },
      200,
      req,
    );
  } catch (err: any) {
    console.error('edgeFunctionHealth error:', err?.message);
    return errorResponse(err?.message || 'Internal error', 500, req);
  }
});
