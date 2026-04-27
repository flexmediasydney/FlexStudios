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

/**
 * Resolve the calling user from the request's Authorization header.
 *
 * Auth-algorithm note (2026-04-20):
 * This function is algorithm-agnostic. It calls `admin.auth.getUser(token)`
 * which hits the Supabase Auth API and that service handles both legacy HS256
 * JWTs and the new ES256 asymmetric JWTs (via its JWKS) transparently.
 *
 * The prior outage was NOT here — it was the Supabase edge gateway's
 * `verify_jwt: true` middleware rejecting ES256 before the function body ever
 * ran (`UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM`). That gateway layer is now
 * disabled on every user-facing function (`verify_jwt: false` set via the
 * Management API). Each function continues to do its own role-based auth
 * below — belt-and-braces now that the gateway belt is off.
 *
 * If Supabase rotates signing keys again in the future, nothing here needs
 * to change. Monitor `/config/auth/signing-keys` on the Management API to
 * detect rotation events.
 */
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

  // admin.auth.getUser resolves HS256 and ES256 tokens identically.
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

/**
 * Wave 6 P-audit-fix-2 Class B (#42): per-call project access guard for
 * shortlisting edge functions.
 *
 * Returns true iff the user has access to the given project. Resolution:
 *   - service_role / master_admin / admin → always TRUE (full access).
 *   - manager / employee / contractor / photographer → TRUE iff the project_id
 *     appears in users.assigned_project_ids (the canonical FlexStudios
 *     project assignment column — same source the my_project_ids() SQL
 *     function reads from).
 *
 * Returns FALSE when:
 *   - User is null (caller forgot to authenticate).
 *   - User has a non-system role and the project_id isn't in their
 *     assigned_project_ids array.
 *
 * Does NOT throw — caller should treat false as a 403.
 *
 * Cost: 1 SELECT per call (only for non-admin roles). For admin-tier users
 * we short-circuit before the DB roundtrip.
 */
export async function callerHasProjectAccess(
  user: AppUser | null,
  projectId: string,
): Promise<boolean> {
  if (!user) return false;
  if (!projectId) return false;

  // service_role + admin tiers bypass.
  if (user.id === '__service_role__') return true;
  const adminRoles = new Set(['master_admin', 'admin']);
  if (adminRoles.has(user.role || '')) return true;

  // For all other roles, require project membership.
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('users')
    .select('assigned_project_ids')
    .eq('id', user.id)
    .maybeSingle();
  if (error || !data) return false;
  const ids: unknown = data.assigned_project_ids;
  if (!Array.isArray(ids)) return false;
  return ids.some((p) => typeof p === 'string' && p === projectId);
}

// ─── Entity helpers (mirrors the Base44 SDK pattern) ──────────────────────────
//
// PostgREST's default `.select()` returns max 1000 rows — this has been the
// root cause of many "unbounded select" bugs where callers forgot to pass an
// explicit limit and silently got truncated. We now apply a generous DEFAULT
// upper bound via `.range(0, DEFAULT_LIST_CAP - 1)` whenever the caller does
// not pass an explicit limit. When the returned row count equals the cap
// exactly, we emit a `console.warn` so future audits can spot truncation in
// edge-function logs.
//
// Callers who genuinely need every row (cron backfills, analytics rollups)
// should use `listAll()` / `filterAll()` which transparently paginate with
// chunked ranges.

const DEFAULT_LIST_CAP = 25000;
const PAGE_SIZE = 1000;

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

      const applySort = (q: any, sortBy?: string | null) => {
        if (!sortBy) return q;
        const desc = sortBy.startsWith('-');
        const field = desc ? sortBy.slice(1) : sortBy;
        const mapped = field === 'created_date' ? 'created_at' : field === 'updated_date' ? 'updated_at' : field;
        return q.order(mapped, { ascending: !desc });
      };

      const applyFilterObj = (q: any, filterObj: Record<string, any>) => {
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
        return q;
      };

      /** Warn when the result set exactly equals the cap — strong signal of truncation. */
      const warnIfCapped = (rows: any[], effectiveCap: number, where: string) => {
        if (rows.length === effectiveCap && effectiveCap >= PAGE_SIZE) {
          console.warn(
            `[entities] ${entityName}.${where}() returned exactly ${effectiveCap} rows — ` +
            `likely truncated. Use listAll()/filterAll() or pass a larger explicit limit.`
          );
        }
      };

      /**
       * Paginate a pre-built PostgREST query (no .limit() / .range() attached)
       * in chunks of PAGE_SIZE until fewer than PAGE_SIZE rows come back or we
       * reach the caller's cap. Handles the 1000-row PostgREST default cleanly.
       */
      const paginate = async (buildQuery: () => any, cap: number): Promise<any[]> => {
        const out: any[] = [];
        let offset = 0;
        while (offset < cap) {
          const end = Math.min(offset + PAGE_SIZE, cap) - 1;
          const { data, error } = await buildQuery().range(offset, end);
          if (error) throw new Error(error.message);
          const batch = data || [];
          out.push(...batch);
          if (batch.length < PAGE_SIZE) break; // exhausted
          offset += PAGE_SIZE;
        }
        return out;
      };

      return {
        /**
         * Fetch a list of rows.
         *   - `limit` undefined  → default cap of DEFAULT_LIST_CAP (25000) applied
         *                          via .range(0, cap-1). Warns on exact-cap hit.
         *   - `limit` number     → explicit .limit() applied (back-compat). If
         *                          larger than PostgREST's 1000-row ceiling we
         *                          use .range() instead so the cap is respected.
         */
        async list(sortBy?: string, limit?: number) {
          const effectiveCap = limit && limit > 0 ? limit : DEFAULT_LIST_CAP;
          const build = () => applySort(client.from(table).select('*'), sortBy);
          // For caps ≤ PAGE_SIZE we can use the simpler .limit() path; otherwise
          // we range-paginate so PostgREST's default 1000-row ceiling doesn't bite.
          if (effectiveCap <= PAGE_SIZE) {
            const { data, error } = await build().limit(effectiveCap);
            if (error) throw new Error(error.message);
            const rows = data || [];
            warnIfCapped(rows, effectiveCap, 'list');
            return rows;
          }
          const rows = await paginate(build, effectiveCap);
          warnIfCapped(rows, effectiveCap, 'list');
          return rows;
        },

        async filter(filterObj: Record<string, any> = {}, sortBy?: string | null, limit?: number) {
          const effectiveCap = limit && limit > 0 ? limit : DEFAULT_LIST_CAP;
          const build = () => applySort(applyFilterObj(client.from(table).select('*'), filterObj), sortBy);
          if (effectiveCap <= PAGE_SIZE) {
            const { data, error } = await build().limit(effectiveCap);
            if (error) throw new Error(error.message);
            const rows = data || [];
            warnIfCapped(rows, effectiveCap, 'filter');
            return rows;
          }
          const rows = await paginate(build, effectiveCap);
          warnIfCapped(rows, effectiveCap, 'filter');
          return rows;
        },

        /**
         * Fetch ALL rows via chunked range pagination.
         * Use for cron backfills and analytics rollups where truncation is
         * unacceptable. No cap — will page until the table is exhausted.
         */
        async listAll(sortBy?: string | null) {
          const build = () => applySort(client.from(table).select('*'), sortBy);
          return paginate(build, Number.MAX_SAFE_INTEGER);
        },

        async filterAll(filterObj: Record<string, any> = {}, sortBy?: string | null) {
          const build = () => applySort(applyFilterObj(client.from(table).select('*'), filterObj), sortBy);
          return paginate(build, Number.MAX_SAFE_INTEGER);
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
      // supabase-js returns PostgrestBuilder which is PromiseLike<void> (no .catch).
      // Wrap in Promise.resolve to get a real Promise so we can attach .catch().
      Promise.resolve(admin.from('edge_fn_call_audit').insert(row))
        .then(({ error }) => {
          if (error) console.warn(`[audit] insert failed for ${row.fn_name}:`, error.message);
        })
        .catch((err: any) => {
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
        // body the caller will receive. Status line is the safe baseline; if
        // we can clone-and-read the body too, append a sanitised excerpt so
        // edge_fn_call_audit captures actionable failure detail (Wave 11 S2
        // Cluster A — until now ~all rows just said "HTTP 4xx").
        errorMessage = `HTTP ${response.status} ${response.statusText || ''}`.trim();
        try {
          // Clone first so caller's response body stream is untouched.
          const bodyText = await response.clone().text();
          if (bodyText) {
            // Strip control chars, collapse whitespace, truncate to 500 chars.
            const cleaned = bodyText
              .replace(/[\x00-\x1F\x7F]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            const truncated = cleaned.length > 500
              ? `${cleaned.slice(0, 500)}…[truncated ${cleaned.length - 500} chars]`
              : cleaned;
            if (truncated) errorMessage = `${errorMessage}: ${truncated}`;
          }
        } catch (_bodyErr) {
          // Body read failed (already consumed, non-text, locked stream, etc) —
          // fall back to status-line only. errorMessage stays as the HTTP NNN form.
        }
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

/**
 * Fire a notification via the notificationService function.
 *
 * Two modes (Wave 6 P1.5):
 *   1. Direct: pass `userId` → notification is created for that user only.
 *      This is the legacy back-compat path; existing callers are unchanged.
 *   2. Fan-out: omit `userId` (pass `type` and content) → notificationService
 *      reads `notification_routing_rules` for the active rule for `type` and
 *      fans out one notification per resolved recipient. Falls back to
 *      NOTIFICATION_TYPES[type].default_roles when no rule exists.
 *
 * Returns false if the invocation failed (does not distinguish 0 recipients
 * from network failure — check edge function logs for fan-out details).
 */
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
    // Strip undefined/null userId so the backend takes the fan-out path
    // unambiguously rather than treating an explicit-null as "create for null".
    // deno-lint-ignore no-explicit-any
    const payload: Record<string, unknown> = { action: 'create' };
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      payload[k] = v;
    }
    await invokeFunction('notificationService', payload);
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
