/**
 * supabaseClient.js — Supabase shim layer
 *
 * Drop-in replacement for @base44/sdk that routes all calls to Supabase.
 *
 * API surface:
 *   api.entities.EntityName.list(sortBy?, limit?)
 *   api.entities.EntityName.filter(filterObj, sortBy?, limit?)
 *   api.entities.EntityName.get(id)
 *   api.entities.EntityName.create(data)
 *   api.entities.EntityName.update(id, data)
 *   api.entities.EntityName.delete(id)
 *   api.entities.EntityName.subscribe(callback) → unsubscribe
 *   api.entities[dynamicName].*              (bracket notation)
 *   api.asServiceRole.entities.*             (service-role client)
 *   api.functions.invoke(name, params)
 *   api.asServiceRole.functions.invoke(name, params)
 *   api.auth.me()
 *   api.auth.logout(redirectUrl?)
 *   api.auth.redirectToLogin(redirectUrl?)
 *   api.users.inviteUser(email, role)
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Anon client (respects RLS, used for ALL frontend operations)
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    detectSessionInUrl: true,
  },
});

// SECURITY: Service role key is NO LONGER in the frontend.
// Admin operations (invite user, resend invite, sign out everywhere) go through
// the adminAuthActions edge function which holds the service role key server-side.
const supabaseAdmin = null;

// Monotonic counter for unique Supabase Realtime channel names.
// Each subscribe() call gets a unique channel so unsubscribing one
// doesn't tear down another subscriber's channel for the same table.
let subscribeCounter = 0;

// ─── Entity name → table name mapping ────────────────────────────────────────

/**
 * Convert PascalCase entity name to snake_case plural table name.
 * e.g. ProjectTask → project_tasks, Agency → agencies, AuditLog → audit_logs
 */
const tableNameCache = new Map();

function toTableName(entityName) {
  if (tableNameCache.has(entityName)) return tableNameCache.get(entityName);

  // PascalCase → snake_case
  let snake = entityName
    .replace(/([A-Z])/g, (match, letter, offset) =>
      offset > 0 ? '_' + letter.toLowerCase() : letter.toLowerCase()
    );

  // Pluralize (simple rules covering all 68 entities)
  if (snake.endsWith('y') && !snake.endsWith('ey') && !snake.endsWith('ay')) {
    // agency → agencies, activity → activities, category → categories
    snake = snake.slice(0, -1) + 'ies';
  } else if (snake.endsWith('s') || snake.endsWith('x') || snake.endsWith('ch') || snake.endsWith('sh')) {
    snake += 'es';
  } else {
    snake += 's';
  }

  // Handle known exceptions / overrides
  const overrides = {
    'agencys': 'agencies',
    'project_medias': 'project_media',
    'photographer_availabilitys': 'photographer_availabilities',
    'delivery_settingses': 'delivery_settings',
    'notification_digest_settingses': 'notification_digest_settings',
    'tonomo_integration_settingses': 'tonomo_integration_settings',
    'tonomo_role_defaultses': 'tonomo_role_defaults',
    'tonomo_processing_queues': 'tonomo_processing_queue',
    'pulse_timelines': 'pulse_timeline',
    'price_matrixes': 'price_matrices',
    'price_matrix_audit_logses': 'price_matrix_audit_logs',
    'price_matrix_snapshotses': 'price_matrix_snapshots',
    'employee_utilitys': 'employee_utilization',
    'external_listings': 'external_listings',
    // drone_pois_cache + drone_cadastral_cache + drone_external_cache are
    // singular by design (per-project cache rows). Override the default
    // pluraliser so api.entities.DronePoisCache resolves to the right table.
    'drone_pois_caches': 'drone_pois_cache',
    'drone_cadastral_caches': 'drone_cadastral_cache',
    'drone_external_caches': 'drone_external_cache',
    // drone_property_boundary is singular (one row per project). Wave 5 P2
    // S5 — without this override api.entities.DronePropertyBoundary would
    // resolve to a non-existent drone_property_boundaries table and 404.
    'drone_property_boundaries': 'drone_property_boundary',
  };

  snake = overrides[snake] || snake;
  tableNameCache.set(entityName, snake);
  return snake;
}

// ─── Filter translation ──────────────────────────────────────────────────────

/**
 * Apply Base44-style filter object to a Supabase query.
 *
 * Supported operators:
 *   { field: value }              → .eq(field, value)
 *   { field: { $in: [...] } }    → .in(field, [...])
 *   { field: { $gte: v } }       → .gte(field, v)
 *   { field: { $lte: v } }       → .lte(field, v)
 *   { field: { $gte: a, $lte: b } } → .gte(field, a).lte(field, b)
 */
function applyFilters(query, filterObj) {
  if (!filterObj || typeof filterObj !== 'object') return query;

  const fieldMap = { created_date: 'created_at', updated_date: 'updated_at', received_date: 'received_at' };
  for (const [rawField, value] of Object.entries(filterObj)) {
    if (value === null || value === undefined) continue;
    const field = fieldMap[rawField] || rawField;

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Operator object: { $in, $gte, $lte, ... }
      if ('$in' in value) {
        query = query.in(field, value.$in);
      }
      if ('$gte' in value) {
        query = query.gte(field, value.$gte);
      }
      if ('$lte' in value) {
        query = query.lte(field, value.$lte);
      }
      if ('$gt' in value) {
        query = query.gt(field, value.$gt);
      }
      if ('$lt' in value) {
        query = query.lt(field, value.$lt);
      }
      if ('$ne' in value) {
        query = query.neq(field, value.$ne);
      }
    } else {
      // Simple equality
      query = query.eq(field, value);
    }
  }

  return query;
}

/**
 * Apply Base44-style sort string to a Supabase query.
 * "-created_date" → order by created_date descending
 * "name"          → order by name ascending
 */
function applySort(query, sortBy) {
  if (!sortBy || typeof sortBy !== 'string') return query;
  const desc = sortBy.startsWith('-');
  const field = desc ? sortBy.slice(1) : sortBy;
  // Map old field names: created_date → created_at, updated_date → updated_at, received_date → received_at
  const sortFieldMap = { created_date: 'created_at', updated_date: 'updated_at', received_date: 'received_at' };
  const mapped = sortFieldMap[field] || field;
  return query.order(mapped, { ascending: !desc });
}

// ─── Field name mapping (DB → Base44 compat) ─────────────────────────────────

/**
 * Map database field names back to Base44-style names in response data.
 * created_at → created_date, updated_at → updated_date
 * This ensures frontend code referencing old field names keeps working.
 */
function mapRow(row) {
  if (!row || typeof row !== 'object') return row;
  const mapped = { ...row };
  if ('created_at' in mapped) { mapped.created_date = mapped.created_at; }
  if ('updated_at' in mapped) { mapped.updated_date = mapped.updated_at; }
  if ('received_at' in mapped) { mapped.received_date = mapped.received_at; }
  return mapped;
}
function mapRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(mapRow);
}

/**
 * Map Base44-style field names to database names in input data.
 * created_date → created_at, updated_date → updated_at, received_date → received_at
 *
 * Also strips server-managed fields (created_at, updated_at, id) that Supabase
 * rejects or ignores on INSERT/UPDATE. This prevents errors when callers pass a
 * full mapRow'd record (which has both created_at and created_date) back to
 * create() or update().
 */
function mapInput(data) {
  if (!data || typeof data !== 'object') return data;
  const mapped = { ...data };

  // Translate Base44 alias field names → DB column names
  if ('created_date' in mapped) { mapped.created_at = mapped.created_date; delete mapped.created_date; }
  if ('updated_date' in mapped) { mapped.updated_at = mapped.updated_date; delete mapped.updated_date; }
  if ('received_date' in mapped) { mapped.received_at = mapped.received_date; delete mapped.received_date; }

  // Strip 'id' — it's passed as a separate argument to update(); removing it from data is safe.
  delete mapped.id;
  // Note: created_at and updated_at are NOT stripped. Supabase silently ignores them
  // on insert (server defaults apply) and on update (trigger overwrites). Stripping them
  // caused data loss when forms round-tripped full entity records.

  // Strip decorated shadow fields (added by decorateEntity/mapRow) that don't exist in DB
  for (const key of Object.keys(mapped)) {
    if (key.startsWith('_')) delete mapped[key];
  }

  return mapped;
}

// ─── Entity proxy builder ────────────────────────────────────────────────────

/**
 * Build an entity API object with .list, .filter, .get, .create, .update, .delete, .subscribe
 * that mirrors the Base44 SDK interface exactly.
 */
function createEntityApi(entityName, client) {
  const table = toTableName(entityName);

  return {
    /**
     * List entities with optional sorting and limit.
     * Base44 signature: Entity.list(sortBy?, limit?)
     */
    async list(sortBy = null, limit = null) {
      const targetLimit = limit || 1000;
      // Supabase PostgREST caps at 1000 rows per request.
      // For larger limits, paginate with range() calls.
      if (targetLimit <= 1000) {
        let query = client.from(table).select('*');
        query = applySort(query, sortBy);
        query = query.limit(targetLimit);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return mapRows(data || []);
      }
      // Paginated fetch for large tables (Pulse intelligence data)
      const PAGE_SIZE = 1000;
      const allRows = [];
      for (let offset = 0; offset < targetLimit; offset += PAGE_SIZE) {
        let query = client.from(table).select('*');
        query = applySort(query, sortBy);
        query = query.range(offset, offset + PAGE_SIZE - 1);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const rows = data || [];
        allRows.push(...rows);
        if (rows.length < PAGE_SIZE) break; // no more pages
      }
      return mapRows(allRows);
    },

    /**
     * Filter entities with optional sorting and limit.
     * Base44 signature: Entity.filter(filterObj, sortBy?, limit?)
     */
    async filter(filterObj = {}, sortBy = null, limit = null) {
      let query = client.from(table).select('*');
      query = applyFilters(query, filterObj);
      query = applySort(query, sortBy);
      // BUG FIX: same as list() — always set explicit limit to avoid silent truncation
      query = query.limit(limit || 1000);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return mapRows(data || []);
    },

    /**
     * Paginated filter: same as filter() but supports offset for cursor-based pagination.
     * Returns { data, hasMore } where hasMore indicates if there are more rows to fetch.
     */
    async filterPaginated(filterObj = {}, sortBy = null, limit = 50, offset = 0) {
      let query = client.from(table).select('*');
      query = applyFilters(query, filterObj);
      query = applySort(query, sortBy);
      query = query.range(offset, offset + limit - 1);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = mapRows(data || []);
      return { data: rows, hasMore: rows.length === limit };
    },

    /**
     * Get a single entity by ID.
     * Base44 signature: Entity.get(id)
     */
    async get(id) {
      const { data, error } = await client
        .from(table)
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw new Error(error.message);
      return mapRow(data);
    },

    /**
     * Create a new entity.
     * Base44 signature: Entity.create(data) → created record
     */
    async create(data) {
      const { data: result, error } = await client
        .from(table)
        .insert(mapInput(data))
        .select()
        .single();
      if (error) throw new Error(error.message);
      return mapRow(result);
    },

    /**
     * Update an entity by ID.
     * Base44 signature: Entity.update(id, data) → updated record
     */
    async update(id, data) {
      const { data: result, error } = await client
        .from(table)
        .update(mapInput(data))
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return mapRow(result);
    },

    /**
     * Delete an entity by ID.
     * Base44 signature: Entity.delete(id)
     */
    async delete(id) {
      const { error } = await client
        .from(table)
        .delete()
        .eq('id', id);
      if (error) throw new Error(error.message);
    },

    /**
     * Subscribe to real-time changes for this entity type.
     * Base44 signature: Entity.subscribe(callback) → unsubscribeFn
     *
     * Callback receives: { id, type: 'create'|'update'|'delete', data }
     *
     * EFFICIENCY FIX: Each call creates a unique channel name so that multiple
     * concurrent subscribers to the same table get independent channels.
     * Previously all used `realtime:${table}` — in Supabase JS v2, calling
     * .channel() with an already-joined name returns the SAME Channel object,
     * so when ONE subscriber unsubscribed it tore down the channel for ALL
     * subscribers, causing missed events and stale UI across the app.
     */
    subscribe(callback) {
      const channelId = `realtime:${table}:${++subscribeCounter}`;
      const channel = client
        .channel(channelId)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table },
          (payload) => {
            const eventType =
              payload.eventType === 'INSERT' ? 'create'
              : payload.eventType === 'UPDATE' ? 'update'
              : payload.eventType === 'DELETE' ? 'delete'
              : null;

            if (!eventType) return;

            const hasNew = payload.new && Object.keys(payload.new).length > 0;
            const record = hasNew ? mapRow(payload.new) : null;

            // BUG FIX: For DELETE events, Supabase only sends old.id by default
            // (unless REPLICA IDENTITY FULL is set). mapRow(payload.old) on a
            // partial record is safe but record?.id might be undefined — always
            // fall back to payload.old?.id which Supabase guarantees for DELETEs.
            callback({
              id: record?.id ?? payload.old?.id ?? payload.new?.id,
              type: eventType,
              data: record,
            });
          }
        )
        .subscribe();

      // Return unsubscribe function (same interface as Base44)
      // EFFICIENCY FIX: use removeChannel() instead of channel.unsubscribe().
      // unsubscribe() sends LEAVE to the server but leaves the Channel object
      // in the client's internal channel list, leaking memory over time.
      // removeChannel() fully cleans up both the server subscription and the
      // client-side Channel object.
      return () => {
        client.removeChannel(channel);
      };
    },
  };
}

// ─── Entities proxy (supports bracket notation) ──────────────────────────────

const entityApiCache = new Map();
const entityApiCacheAdmin = new Map();

function getEntityApi(entityName, client, cache) {
  if (!cache.has(entityName)) {
    cache.set(entityName, createEntityApi(entityName, client));
  }
  return cache.get(entityName);
}

/**
 * Proxy that intercepts property access to create entity APIs on demand.
 * Supports both api.entities.ProjectTask and api.entities['ProjectTask'].
 */
const entitiesProxy = new Proxy({}, {
  get(_target, entityName) {
    if (typeof entityName !== 'string') return undefined;
    return getEntityApi(entityName, supabase, entityApiCache);
  },
});

const entitiesProxyAdmin = new Proxy({}, {
  get(_target, entityName) {
    if (typeof entityName !== 'string') return undefined;
    return getEntityApi(entityName, supabaseAdmin || supabase, entityApiCacheAdmin);
  },
});

// ─── Functions (invoke) ──────────────────────────────────────────────────────

/**
 * Fire-and-forget fallback audit log for frontend→edge-function failures.
 *
 * When the server-side `serveWithAudit` wrapper runs successfully, it records
 * the invocation itself — so the success case is already covered. But if the
 * function can never be reached (network drop, Supabase outage, DNS, CORS,
 * auth failure at the edge gateway before the function runs), the server
 * wrapper never executes. Those are exactly the failures we most want to
 * detect (the 2026-04-16 auth-key outage was this class of failure).
 *
 * The audit table has a permissive INSERT policy so the anon client can write.
 * Best-effort — never throws.
 */
async function _logFrontendFailure(functionName, errorMessage, durationMs) {
  try {
    // Skip audit-table recursion & health-check noise.
    if (functionName === 'edgeFunctionHealth') return;
    if ((functionName || '').toLowerCase().includes('audit')) return;
    // Resolve user_id best-effort so outage diagnostics can slice by user.
    let userId = null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id || null;
    } catch { /* unauthenticated */ }
    await supabase.from('edge_fn_call_audit').insert({
      fn_name: functionName,
      caller: 'frontend',
      status: 'error',
      http_status: null,
      duration_ms: typeof durationMs === 'number' ? Math.max(0, Math.floor(durationMs)) : null,
      error_message: typeof errorMessage === 'string' ? errorMessage.slice(0, 2000) : String(errorMessage).slice(0, 2000),
      request_id: null,
      user_id: userId,
    });
  } catch (e) {
    // Never crash the caller — audit is best-effort.
    console.warn('[audit] frontend fallback log failed:', e?.message);
  }
}

/**
 * Invoke a Supabase Edge Function.
 * Signature: api.functions.invoke(functionName, params) → response data
 *
 * Maps to: supabase.functions.invoke(functionName, { body: params })
 *
 * Sends `x-caller-context: frontend` so the server's serveWithAudit wrapper
 * can attribute the call. On errors where the server wrapper could not run
 * (network failure, CORS, auth-gate rejection), we also write a fallback
 * audit row directly from the client.
 */
async function invokeFunction(client, functionName, params = {}) {
  // Timeout: Edge Functions should not hang indefinitely on slow networks.
  // pulseDataSync runs Apify actors which can take 2-3 min per batch.
  // Other functions use 45s (Supabase default 30s + network overhead).
  const LONG_RUNNING_FUNCTIONS = ['pulseDataSync'];
  const FUNCTION_TIMEOUT = LONG_RUNNING_FUNCTIONS.includes(functionName) ? 180000 : 45000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Edge function "${functionName}" timed out after ${FUNCTION_TIMEOUT / 1000}s`)),
      FUNCTION_TIMEOUT
    );
  });

  const startMs = Date.now();
  let loggedFailure = false;
  try {
    const { data, error } = await Promise.race([
      client.functions.invoke(functionName, {
        body: params,
        headers: { 'x-caller-context': 'frontend' },
      }),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);
    if (error) {
      // W6 FIX 1 (QC3-5 BE3 + QC3-6 S2): supabase-js's FunctionsHttpError
      // carries the raw Response body on `error.context`. Without surfacing
      // it, structured 4xx replies (drone-shot-lifecycle's
      // `{success:false, error:'lifecycle_state_conflict', current_state}`,
      // drone-boundary-save's 409 with `current_row` / `current_version`,
      // drone-render-approve's lock-state messages, etc.) collapsed into a
      // generic "Edge Function returned a non-2xx status code" — callers
      // couldn't branch on the actual server-side reason.
      //
      // Strategy: best-effort extract the body (json or string), throw a
      // richer Error that exposes `.status` + `.body` for callers, while
      // preserving the existing audit-row write so outage diagnostics still
      // see one row per frontend-side failure.
      let parsedBody = null;
      const ctx = error?.context;
      // Prefer a pre-parsed body if supabase-js gave us one; otherwise pull
      // bytes off the Response (it's only readable once — we await text() and
      // then JSON.parse, falling back to the raw string).
      if (ctx?.body && typeof ctx.body === 'object' && !(ctx.body instanceof ReadableStream)) {
        parsedBody = ctx.body;
      } else if (typeof ctx?.body === 'string') {
        try { parsedBody = JSON.parse(ctx.body); } catch { parsedBody = ctx.body; }
      } else if (ctx && typeof ctx.text === 'function') {
        try {
          const txt = await ctx.text();
          try { parsedBody = JSON.parse(txt); } catch { parsedBody = txt; }
        } catch { /* response already consumed or unreadable */ }
      } else if (ctx && typeof ctx.json === 'function') {
        try { parsedBody = await ctx.json(); } catch { /* not JSON */ }
      }
      const status = ctx?.status ?? error?.status ?? null;
      const serverMsg =
        (parsedBody && typeof parsedBody === 'object' && parsedBody.error) ||
        error.message ||
        `Function ${functionName} failed`;
      loggedFailure = true;
      _logFrontendFailure(functionName, serverMsg, Date.now() - startMs);
      const richError = new Error(serverMsg);
      richError.status = status;
      richError.body = parsedBody;
      richError.functionName = functionName;
      // Preserve the original supabase-js error in case a caller needs it.
      richError.cause = error;
      throw richError;
    }
    // Wrap in { data } to match Base44's response format:
    // Frontend code does: result.data.someField
    return { data };
  } catch (err) {
    clearTimeout(timeoutId);
    // Timeout or network-level failure — server wrapper definitely did not run.
    // This path is the most valuable signal for an outage (e.g. 2026-04-16).
    if (!loggedFailure) {
      _logFrontendFailure(functionName, err?.message || String(err), Date.now() - startMs);
    }
    throw err;
  }
}

const functionsApi = {
  invoke: (name, params) => invokeFunction(supabase, name, params),
};

const functionsApiAdmin = {
  invoke: (name, params) => invokeFunction(supabaseAdmin || supabase, name, params),
};

// ─── Auth ────────────────────────────────────────────────────────────────────

const authApi = {
  /**
   * Get current authenticated user.
   * Base44 returned a user object with: id, email, full_name, role, etc.
   * Supabase auth.getUser() returns auth metadata; we merge with our users table.
   */
  async me() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) throw new Error(error?.message || 'Not authenticated');

    // Fetch the app-level user record using admin client to bypass RLS
    const dbClient = supabaseAdmin || supabase;
    const { data: appUser, error: appError } = await dbClient
      .from('users')
      .select('*')
      .eq('email', user.email)
      .single();

    if (appError || !appUser) {
      // Fall back to auth metadata if no users table record yet
      return {
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name || user.email,
        role: user.user_metadata?.role || 'employee',
      };
    }

    if (appUser.is_active === false) {
      throw new Error('Your account has been deactivated. Please contact your administrator.');
    }

    return appUser;
  },

  /**
   * Logout the current user.
   * Base44 signature: auth.logout(redirectUrl?)
   */
  async logout(redirectUrl) {
    await supabase.auth.signOut({ scope: 'local' });
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  },

  /**
   * Redirect to the login page.
   * Base44 signature: auth.redirectToLogin(redirectUrl?)
   */
  redirectToLogin(redirectUrl) {
    const loginUrl = redirectUrl
      ? `/login?redirect=${encodeURIComponent(redirectUrl)}`
      : '/login';
    window.location.href = loginUrl;
  },

  /** Sign in with Google OAuth (redirect flow) */
  async signInWithGoogle(redirectTo) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo || `${window.location.origin}/auth/callback`,
      },
    });
    if (error) throw error;
    return data;
  },

  /** Send a magic link (passwordless) to an email */
  async sendMagicLink(email) {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) throw error;
  },

  /** Send phone OTP for sign-in */
  async sendPhoneOTP(phone) {
    const { error } = await supabase.auth.signInWithOtp({
      phone,
      options: { shouldCreateUser: false },
    });
    if (error) throw error;
  },

  /** Verify phone OTP */
  async verifyPhoneOTP(phone, token) {
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token,
      type: 'sms',
    });
    if (error) throw error;
    return data;
  },

  /** Send password reset email */
  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    if (error) throw error;
  },

  /** Update password (after reset link click) */
  async updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  },

  /** Check if a phone number is registered in users table */
  async verifyPhoneRegistered(phone) {
    const client = supabaseAdmin || supabase;
    const { data, error } = await client
      .from('users')
      .select('id, email, full_name')
      .eq('phone', phone)
      .eq('is_active', true)
      .single();
    if (error || !data) return null;
    return data;
  },
};

// ─── Users ───────────────────────────────────────────────────────────────────

const usersApi = {
  /**
   * Invite a user by email with a specific role.
   * Signature: api.users.inviteUser(email, role)
   *
   * 1. Creates an auth user via Supabase admin API (sends invitation email)
   * 2. Creates a corresponding row in the `users` table with role and metadata
   * 3. Returns the created user record
   */
  async inviteUser(email, role, fullName) {
    // Use edge function — service role key is server-side only
    const { data, error } = await supabase.functions.invoke('adminAuthActions', {
      body: { action: 'invite_user', email, role, fullName },
    });
    if (error) throw new Error(error.message || 'Failed to invite user');
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async resendInvite(email) {
    const { data, error } = await supabase.functions.invoke('adminAuthActions', {
      body: { action: 'resend_invite', email },
    });
    if (error) throw new Error(error.message || 'Failed to resend invite');
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async sendPasswordResetAdmin(email) {
    const { data, error } = await supabase.functions.invoke('adminAuthActions', {
      body: { action: 'send_password_reset', email },
    });
    if (error) throw new Error(error.message || 'Failed to send reset');
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async signOutEverywhere(userId) {
    const { data, error } = await supabase.functions.invoke('adminAuthActions', {
      body: { action: 'sign_out_everywhere', user_id: userId },
    });
    if (error) throw new Error(error.message || 'Failed to sign out user');
    if (data?.error) throw new Error(data.error);
    return data;
  },

};

// ─── Main client export ──────────────────────────────────────────────────────

/**
 * The api object — Supabase-backed client that replaces the old Base44 SDK.
 */
// ─── File Upload (integrations.Core.UploadFile shim) ─────────────────────────
// Replaces Base44's built-in file upload with Supabase Storage.
// Accepts either a File object or a base64 data URL string.
// Returns { file_url } matching the Base44 API contract.

const integrationsApi = {
  Core: {
    UploadFile: async ({ file }) => {
      const bucket = 'media-delivery';
      const ts = Date.now();
      let fileBlob, fileName, mimeType;

      if (file instanceof File || file instanceof Blob) {
        // Direct File object
        fileBlob = file;
        fileName = file.name || `upload_${ts}`;
        mimeType = file.type || 'application/octet-stream';
      } else if (typeof file === 'string' && file.startsWith('data:')) {
        // Base64 data URL: "data:mime/type;base64,AAAA..."
        const [header, b64Data] = file.split(',');
        mimeType = header.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
        const ext = mimeType.split('/')[1]?.split('+')[0] || 'bin';
        fileName = `upload_${ts}.${ext}`;
        const byteChars = atob(b64Data);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
        fileBlob = new Blob([byteArray], { type: mimeType });
      } else {
        throw new Error('UploadFile: expected a File object or base64 data URL string');
      }

      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `uploads/${ts}_${safeName}`;

      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, fileBlob, { contentType: mimeType });

      if (error) throw new Error(`Upload failed: ${error.message}`);

      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(data.path);

      return { file_url: urlData.publicUrl };
    },
  },
};

/**
 * Call a Postgres RPC (database function) via PostgREST.
 * Signature: api.rpc(functionName, params) → { data, error }
 *
 * Used for server-side aggregation that the entity CRUD interface can't express
 * (e.g. `get_inbox_threads` which aggregates messages by thread).
 */
async function callRpc(client, functionName, params = {}) {
  const { data, error } = await client.rpc(functionName, params);
  if (error) throw new Error(error.message || `RPC ${functionName} failed`);
  return data;
}

export const api = {
  entities: entitiesProxy,

  asServiceRole: {
    entities: entitiesProxyAdmin,
    functions: functionsApiAdmin,
  },

  functions: functionsApi,
  auth: authApi,
  users: usersApi,
  integrations: integrationsApi,

  /**
   * Call a Postgres RPC (database function).
   * Example: const result = await api.rpc('get_inbox_threads', { p_folder: 'inbox', p_limit: 50 });
   */
  rpc: (name, params) => callRpc(supabase, name, params),

  // Expose raw Supabase clients for edge cases during migration
  _supabase: supabase,
  _supabaseAdmin: supabaseAdmin,
};

// Export the anon Supabase client for direct use where needed (e.g. AuthContext).
// supabaseAdmin is intentionally NOT exported — it is always null in the frontend.
// Admin operations go through the adminAuthActions edge function.
export { supabase };
// force rebuild 1773921131
