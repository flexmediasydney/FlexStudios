/**
 * Shared Supabase client utilities for Edge Functions.
 *
 * Provides:
 *   - getAdminClient()  → service-role client (bypasses RLS)
 *   - getUserFromReq()  → extracts & verifies the auth user from the request
 *   - corsHeaders       → standard CORS headers for all responses
 *   - handleCors()      → returns early for OPTIONS preflight
 *   - jsonResponse()    → helper to create JSON responses with CORS
 *   - errorResponse()   → helper to create error responses with CORS
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Environment ──────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://flexstudios.app',
  'https://www.flexstudios.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

function getCorsOrigin(req?: Request): string {
  const origin = req?.headers?.get('origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export function getCorsHeaders(req?: Request) {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    // `x-caller-context` is sent by the frontend invokeFunction wrapper and by
    // cross-function calls for audit attribution — it MUST be listed here or
    // the browser preflight blocks the actual POST as "Failed to fetch".
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-caller-context',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    // supabase-js v2 `functions.invoke` uses credentials:'include' — without
    // Allow-Credentials, browsers silently drop the POST as "Failed to fetch"
    // after the OPTIONS preflight succeeds. Must be 'true' (string).
    'Access-Control-Allow-Credentials': 'true',
  };
}

/** @deprecated Use getCorsHeaders(req) for origin-aware CORS. Defaults to production origin. */
export const corsHeaders = getCorsHeaders();

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }
  return null;
}

// ─── Clients ──────────────────────────────────────────────────────────────────

let _adminClient: SupabaseClient | null = null;

/** Service-role client that bypasses RLS. Use for all backend operations. */
export function getAdminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _adminClient;
}

/** Create a client scoped to the requesting user (respects RLS). */
export function getUserClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get('Authorization') ?? '';
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Extract and verify the authenticated user from the request.
 * Returns the app-level user record from the `users` table (with role, full_name, etc.)
 * Returns null if not authenticated or user not found.
 */
export interface AppUser {
  id: string;
  email: string;
  role: string;
  full_name: string;
  [key: string]: unknown;
}

export async function getUserFromReq(req: Request): Promise<AppUser | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token) return null;

  const SERVICE_ROLE_USER: AppUser = { id: '__service_role__', email: 'system@flexstudios.app', role: 'master_admin', full_name: 'System' };

  // Service-role key bypass: treat as master_admin (used by cron, cross-function calls, and admin scripts)
  // Accept:
  //   1. Exact match with SUPABASE_SERVICE_ROLE_KEY env var (legacy JWT or new sb_secret_* format)
  //   2. Any `sb_secret_*` token — this is a server-side secret; if caller has it, they have service-role
  //   3. Any JWT with role=service_role payload (legacy JWT service key)
  if (token === SUPABASE_SERVICE_ROLE_KEY) return SERVICE_ROLE_USER;
  if (token.startsWith('sb_secret_')) return SERVICE_ROLE_USER;
  try {
    const payloadB64 = token.split('.')[1];
    if (payloadB64) {
      const payload = JSON.parse(atob(payloadB64));
      if (payload.role === 'service_role') return SERVICE_ROLE_USER;
    }
  } catch (_) { /* not a JWT or invalid — continue to normal auth */ }

  const admin = getAdminClient();
  const { data: { user: authUser }, error } = await admin.auth.getUser(token);
  if (error || !authUser) return null;

  // authUser.email can be undefined for phone-only or anonymous auth
  if (!authUser.email) {
    console.warn('getUserFromReq: auth user has no email, cannot resolve app user', authUser.id);
    return null;
  }

  // Fetch app-level user from our users table
  const { data: appUser } = await admin
    .from('users')
    .select('*')
    .eq('email', authUser.email)
    .single();

  return appUser || null;
}

// ─── Entity helpers (mirrors the Base44 SDK pattern) ──────────────────────────

const _tableCache = new Map<string, string>();

/** Convert PascalCase entity name to snake_case plural table name. Internal use only. */
function toTableName(entityName: string): string {
  if (_tableCache.has(entityName)) return _tableCache.get(entityName)!;

  let snake = entityName.replace(/([A-Z])/g, (m, l, o) =>
    o > 0 ? '_' + l.toLowerCase() : l.toLowerCase()
  );

  if (snake.endsWith('y') && !snake.endsWith('ey') && !snake.endsWith('ay')) {
    snake = snake.slice(0, -1) + 'ies';
  } else if (snake.endsWith('s') || snake.endsWith('x') || snake.endsWith('ch') || snake.endsWith('sh')) {
    snake += 'es';
  } else {
    snake += 's';
  }

  const overrides: Record<string, string> = {
    'project_medias': 'project_media',
    'photographer_availabilitys': 'photographer_availabilities',
    'delivery_settingses': 'delivery_settings',
    'notification_digest_settingses': 'notification_digest_settings',
    'tonomo_integration_settingses': 'tonomo_integration_settings',
    'tonomo_role_defaultses': 'tonomo_role_defaults',
    'tonomo_processing_queues': 'tonomo_processing_queue',
    'price_matrixes': 'price_matrices',
    'price_matrix_audit_logses': 'price_matrix_audit_logs',
    'price_matrix_snapshotses': 'price_matrix_snapshots',
  };

  snake = overrides[snake] || snake;
  _tableCache.set(entityName, snake);
  return snake;
}

/**
 * Entity API adapter that mimics Base44's entity interface.
 * Usage: const entities = createEntities(adminClient);
 *        await entities.Project.get(id);
 *        await entities.ProjectTask.filter({ project_id: id });
 */
export function createEntities(client: SupabaseClient) {
  return new Proxy({} as any, {
    get(_target, entityName: string) {
      const table = toTableName(entityName);
      return {
        async list(sortBy?: string, limit?: number) {
          let q = client.from(table).select('*');
          if (sortBy) {
            const desc = sortBy.startsWith('-');
            const field = desc ? sortBy.slice(1) : sortBy;
            const mapped = field === 'created_date' ? 'created_at' : field === 'updated_date' ? 'updated_at' : field;
            q = q.order(mapped, { ascending: !desc });
          }
          if (limit) q = q.limit(limit);
          const { data, error } = await q;
          if (error) throw new Error(error.message);
          return data || [];
        },

        async filter(filterObj: Record<string, any> = {}, sortBy?: string | null, limit?: number) {
          let q = client.from(table).select('*');
          for (const [field, value] of Object.entries(filterObj)) {
            if (value == null) continue;
            if (typeof value === 'object' && !Array.isArray(value)) {
              if ('$in' in value) q = q.in(field, value.$in);
              if ('$gte' in value) q = q.gte(field, value.$gte);
              if ('$lte' in value) q = q.lte(field, value.$lte);
              if ('$ne' in value) q = q.neq(field, value.$ne);
            } else {
              q = q.eq(field, value);
            }
          }
          if (sortBy) {
            const desc = sortBy.startsWith('-');
            const field = desc ? sortBy.slice(1) : sortBy;
            const mapped = field === 'created_date' ? 'created_at' : field === 'updated_date' ? 'updated_at' : field;
            q = q.order(mapped, { ascending: !desc });
          }
          if (limit) q = q.limit(limit);
          const { data, error } = await q;
          if (error) throw new Error(error.message);
          return data || [];
        },

        async get(id: string) {
          const { data, error } = await client.from(table).select('*').eq('id', id).single();
          if (error) throw new Error(error.message);
          return data;
        },

        async create(record: Record<string, any>) {
          const { data, error } = await client.from(table).insert(record).select().single();
          if (error) throw new Error(error.message);
          return data;
        },

        async update(id: string, record: Record<string, any>) {
          const { data, error } = await client.from(table).update(record).eq('id', id).select().single();
          if (error) throw new Error(error.message);
          return data;
        },

        async delete(id: string) {
          const { error } = await client.from(table).delete().eq('id', id);
          if (error) throw new Error(error.message);
        },
      };
    },
  });
}

// ─── Edge-function call audit ────────────────────────────────────────────────
//
// Motivation: 2026-04-16 Supabase platform auth-key migration silently broke
// 23 edge functions for 18+ hours because every call site was fire-and-forget
// and errors were swallowed by `.catch(err => console.warn(...))`. We now log
// every invocation outcome to `edge_fn_call_audit` (see migration 079).
//
// Design:
//   - `serveWithAudit(fnName, handler)` wraps Deno.serve. Start time is
//     captured, handler runs, outcome (success / error / timeout / http_status /
//     duration_ms / error_message) is recorded in a `finally` block.
//   - The audit INSERT is itself wrapped in try/catch — if the audit table is
//     down, the function response is not affected.
//   - Callee-only logging. `invokeFunction()` does NOT log on the caller side
//     because the callee's `serveWithAudit` wrapper logs the same invocation
//     and double-logging would inflate counts. The `x-caller-context` header
//     carries caller identity to the callee for denormalisation.
//   - Health-check probes (`body._health_check === true`) are skipped to avoid
//     noise. `edgeFunctionHealth` and any fn_name containing 'audit' are also
//     skipped to avoid recursion.
//   - TODO (Phase 2): migrate the remaining ~105 functions from raw
//     `Deno.serve(...)` to `serveWithAudit(...)` in a follow-up scripted PR.
//     Phase 1 wraps only 5 pilot functions (trackProjectStageChange,
//     syncProjectTasksFromProducts, calculateProjectTaskDeadlines,
//     recalculateProjectPricingServerSide, processTonomoQueue).

type EdgeFnStatus = 'success' | 'error' | 'timeout';

interface AuditRow {
  fn_name: string;
  caller: string | null;
  status: EdgeFnStatus;
  http_status: number | null;
  duration_ms: number;
  error_message: string | null;
  request_id: string | null;
  user_id: string | null;
}

/** Best-effort user_id extraction from the Authorization header. Silent on failure. */
async function _extractUserId(req: Request): Promise<string | null> {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return null;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!token) return null;
    // Service-role / sb_secret_* tokens aren't tied to a user_id.
    if (token === SUPABASE_SERVICE_ROLE_KEY) return null;
    if (token.startsWith('sb_secret_')) return null;
    // Peek at the JWT payload without verifying (verification costs an RTT
    // and we already do the real verification downstream via getUserFromReq).
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.role === 'service_role') return null;
    return payload.sub || null;
  } catch {
    return null;
  }
}

/** Fire-and-forget audit insert. Never throws. */
function _recordAudit(row: AuditRow): void {
  // Skip recursion-prone function names.
  if (row.fn_name === 'edgeFunctionHealth') return;
  if (row.fn_name.toLowerCase().includes('audit')) return;
  // Non-blocking: do not await. Admin client bypasses RLS.
  queueMicrotask(() => {
    try {
      const admin = getAdminClient();
      admin.from('edge_fn_call_audit').insert(row).then(({ error }) => {
        if (error) console.warn(`[audit] insert failed for ${row.fn_name}:`, error.message);
      }).catch((err: any) => {
        console.warn(`[audit] insert threw for ${row.fn_name}:`, err?.message);
      });
    } catch (err: any) {
      console.warn(`[audit] queueMicrotask handler failed for ${row.fn_name}:`, err?.message);
    }
  });
}

/**
 * Wrap an Edge Function handler with automatic audit logging.
 *
 * Usage:
 *   serveWithAudit('trackProjectStageChange', async (req) => {
 *     // ... existing handler body, unchanged ...
 *     return jsonResponse({ ok: true });
 *   });
 *
 * Guarantees:
 *   - Response body/headers are passed through untouched.
 *   - Audit row is inserted fire-and-forget in the `finally` block — if the
 *     audit table is unreachable, the function still returns normally.
 *   - OPTIONS preflight and _health_check probes are NOT logged (noise).
 */
export function serveWithAudit(
  fnName: string,
  handler: (req: Request) => Promise<Response> | Response,
): void {
  Deno.serve(async (req: Request) => {
    // Skip audit for preflight entirely — these never reach our handlers and
    // logging them would bloat the table. `handleCors(req)` still runs inside
    // the handler, so semantics are preserved.
    const isPreflight = req.method === 'OPTIONS';

    const startMs = Date.now();
    const requestId = req.headers.get('cf-ray') || req.headers.get('x-request-id') || null;
    const caller = req.headers.get('x-caller-context') || 'unknown';

    // Peek body to detect health-check probes without consuming the stream.
    // We clone before any handler touches it. If JSON parse fails (binary/empty),
    // we simply don't skip — we still log the outcome.
    let isHealthCheck = false;
    try {
      const clone = req.clone();
      const text = await clone.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed._health_check === true) isHealthCheck = true;
        } catch { /* not JSON — not a health check */ }
      }
    } catch { /* stream already consumed or not readable — ignore */ }

    let response: Response;
    let errorMessage: string | null = null;
    let status: EdgeFnStatus = 'success';

    try {
      response = await handler(req);
      if (!response.ok) {
        status = 'error';
        // Best-effort extract error message without consuming the response
        // body the caller will receive. We use the status text as a safe proxy.
        errorMessage = `HTTP ${response.status} ${response.statusText || ''}`.trim();
      }
    } catch (err: any) {
      status = 'error';
      errorMessage = err?.message || String(err);
      // Re-emit a 500 so the caller still gets a proper response — matches
      // the behaviour of a raw `Deno.serve` handler that throws.
      response = new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      // Audit last — after we've decided on the response.
      if (!isPreflight && !isHealthCheck) {
        try {
          const userId = await _extractUserId(req);
          _recordAudit({
            fn_name: fnName,
            caller,
            status,
            http_status: response!.status,
            duration_ms: Date.now() - startMs,
            error_message: errorMessage,
            request_id: requestId,
            user_id: userId,
          });
        } catch (auditErr: any) {
          // Last-ditch — audit prep itself failed. Do not impact the response.
          console.warn(`[audit] prep failed for ${fnName}:`, auditErr?.message);
        }
      }
    }

    return response!;
  });
}

// ─── Function invocation (cross-function calls) ──────────────────────────────

// Supabase has migrated from legacy JWT keys (`eyJ...`) to the new opaque
// API-key format (`sb_secret_*` / `sb_publishable_*`). Edge functions with
// `verify_jwt: true` still require a real JWT in the Authorization header —
// the new keys return `UNAUTHORIZED_INVALID_JWT_FORMAT` from the runtime
// BEFORE the function runs.
//
// LEGACY_SERVICE_ROLE_JWT is a project-specific legacy service-role JWT stored
// as a secret. We prefer it for cross-function calls so:
//   1. It passes verify_jwt=true on the runtime gate
//   2. getUserFromReq detects role=service_role in its payload and downstream
//      functions' auth guards all see it as service-role
// LEGACY_ANON_JWT is an anon-role legacy JWT used as a second-tier fallback.
const LEGACY_SERVICE_ROLE_JWT = Deno.env.get('LEGACY_SERVICE_ROLE_JWT') || '';
const LEGACY_ANON_JWT = Deno.env.get('LEGACY_ANON_JWT') || '';
function _isJwt(token: string | undefined | null): boolean {
  return !!token && token.startsWith('eyJ');
}
function _fnAuthToken(): string {
  // Prefer service-role JWT so downstream auth guards see service-role.
  if (_isJwt(LEGACY_SERVICE_ROLE_JWT)) return LEGACY_SERVICE_ROLE_JWT;
  if (_isJwt(SUPABASE_SERVICE_ROLE_KEY)) return SUPABASE_SERVICE_ROLE_KEY;
  if (_isJwt(LEGACY_ANON_JWT)) return LEGACY_ANON_JWT;
  if (_isJwt(SUPABASE_ANON_KEY)) return SUPABASE_ANON_KEY;
  // Last resort — new-format keys will fail on verify_jwt=true targets.
  return SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Invoke another Edge Function by name.
 * Replaces base44.asServiceRole.functions.invoke(name, params).
 *
 * Audit logging:
 *   We send `x-caller-context: cross_fn:{callerFnName?}` so the callee's
 *   `serveWithAudit` wrapper can attribute the call correctly. We do NOT log
 *   on this side — the callee already logs the same invocation and double-
 *   logging would inflate counts. See the block comment at the top of the
 *   "Edge-function call audit" section.
 *
 * @param functionName  Target function to invoke.
 * @param params        JSON payload.
 * @param callerFnName  Optional: name of the calling function, for audit
 *                      attribution. E.g. 'trackProjectStageChange'.
 */
export async function invokeFunction(
  functionName: string,
  params: Record<string, unknown> = {},
  callerFnName?: string,
): Promise<unknown> {
  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  const authToken = _fnAuthToken();
  // The apikey header expects the anon key (needed for DB REST path-through).
  // The Authorization header must be a valid JWT on verify_jwt=true targets,
  // so we fall back to LEGACY_ANON_JWT / legacy SUPABASE_*_KEY when the current
  // runtime-injected env keys are in the new sb_secret_* / sb_publishable_* format.
  const callerContext = callerFnName ? `cross_fn:${callerFnName}` : 'cross_fn:unknown';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${authToken}`,
      'x-caller-context': callerContext,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.clone().text().catch(() => 'Unknown error');
    throw new Error(`Function ${functionName} failed (${res.status}): ${text}`);
  }

  return res.json().catch(() => null);
}

// ─── Notification helper ──────────────────────────────────────────────────────

/** Fire a notification via the notificationService function. Returns false if notification failed. */
export async function fireNotif(params: {
  userId?: string;
  type?: string;
  category?: string;
  severity?: string;
  title?: string;
  message?: string;
  projectId?: string;
  projectName?: string;
  ctaLabel?: string;
  source?: string;
  idempotencyKey?: string;
}): Promise<boolean> {
  try {
    await invokeFunction('notificationService', {
      action: 'create',
      ...params,
    } as Record<string, unknown>);
    return true;
  } catch (err: any) {
    console.warn('fireNotif failed:', err?.message);
    return false;
  }
}

// ─── Quiet hours helper ──────────────────────────────────────────────────────

/**
 * Check if a user is currently in quiet hours (Australia/Sydney timezone).
 * Reads `notification_digest_settings` for the user and compares the current
 * time against quiet_hours_start / quiet_hours_end.
 * Handles the overnight case (e.g. 22:00 → 08:00).
 * Returns true if notifications should be suppressed.
 */
export async function isQuietHours(userId: string): Promise<boolean> {
  try {
    const admin = getAdminClient();
    const { data } = await admin
      .from('notification_digest_settings')
      .select('quiet_hours_enabled, quiet_hours_start, quiet_hours_end')
      .eq('user_id', userId)
      .single();

    if (!data?.quiet_hours_enabled) return false;

    const start = data.quiet_hours_start; // e.g. "22:00"
    const end = data.quiet_hours_end;     // e.g. "08:00"
    if (!start || !end) return false;

    // Current time in Sydney
    const now = new Date();
    const sydneyTime = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now); // e.g. "23:15"

    const toMinutes = (hhmm: string): number => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };

    const nowMin = toMinutes(sydneyTime);
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);

    if (startMin <= endMin) {
      // Same-day range, e.g. 09:00 → 17:00
      return nowMin >= startMin && nowMin < endMin;
    } else {
      // Overnight range, e.g. 22:00 → 08:00
      return nowMin >= startMin || nowMin < endMin;
    }
  } catch {
    return false; // fail open — don't suppress on error
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

export function jsonResponse(data: any, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 500, req?: Request): Response {
  return jsonResponse({ error: message }, status, req);
}
