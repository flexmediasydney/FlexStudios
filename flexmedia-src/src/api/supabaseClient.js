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
const SUPABASE_SERVICE_ROLE_KEY = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

// Anon client (respects RLS, used for normal user operations)
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Service-role client (bypasses RLS, used for elevated backend-like operations)
// Uses a distinct storageKey to avoid "Multiple GoTrueClient" conflicts
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        storageKey: 'sb-admin-token',
      },
    })
  : null;

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
    'price_matrixes': 'price_matrices',
    'price_matrix_audit_logses': 'price_matrix_audit_logs',
    'price_matrix_snapshotses': 'price_matrix_snapshots',
    'employee_utilitys': 'employee_utilization',
    'external_listings': 'external_listings',
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
      let query = client.from(table).select('*');
      query = applySort(query, sortBy);
      if (limit) query = query.limit(limit);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return mapRows(data || []);
    },

    /**
     * Filter entities with optional sorting and limit.
     * Base44 signature: Entity.filter(filterObj, sortBy?, limit?)
     */
    async filter(filterObj = {}, sortBy = null, limit = null) {
      let query = client.from(table).select('*');
      query = applyFilters(query, filterObj);
      query = applySort(query, sortBy);
      if (limit) query = query.limit(limit);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return mapRows(data || []);
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
     */
    subscribe(callback) {
      const channel = client
        .channel(`realtime:${table}`)
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
            const record = hasNew ? mapRow(payload.new) : mapRow(payload.old);

            callback({
              id: record?.id ?? payload.old?.id,
              type: eventType,
              data: hasNew ? record : null,
            });
          }
        )
        .subscribe();

      // Return unsubscribe function (same interface as Base44)
      return () => {
        channel.unsubscribe();
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
 * Invoke a Supabase Edge Function.
 * Signature: api.functions.invoke(functionName, params) → response data
 *
 * Maps to: supabase.functions.invoke(functionName, { body: params })
 */
async function invokeFunction(client, functionName, params = {}) {
  const { data, error } = await client.functions.invoke(functionName, {
    body: params,
  });
  if (error) throw new Error(error.message || `Function ${functionName} failed`);
  // Wrap in { data } to match Base44's response format:
  // Frontend code does: result.data.someField
  return { data };
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
        role: user.user_metadata?.role || 'contractor',
      };
    }

    return appUser;
  },

  /**
   * Logout the current user.
   * Base44 signature: auth.logout(redirectUrl?)
   */
  async logout(redirectUrl) {
    await supabase.auth.signOut();
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  },

  /**
   * Redirect to the login page.
   * Base44 signature: auth.redirectToLogin(redirectUrl?)
   */
  redirectToLogin(redirectUrl) {
    // For now, redirect to a login page. This will be replaced
    // with proper Supabase Auth UI in the auth migration phase.
    const loginUrl = redirectUrl
      ? `/login?redirect=${encodeURIComponent(redirectUrl)}`
      : '/login';
    window.location.href = loginUrl;
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
    if (!supabaseAdmin) {
      throw new Error('Service role key required for user invitations');
    }

    // Step 1: Create auth user and send invitation email
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { role, full_name: fullName || email.split('@')[0] },
    });
    if (authError) throw new Error(authError.message);

    const authUser = authData?.user;
    if (!authUser) throw new Error('Auth user was not created');

    // Step 2: Create a row in the users table so the user appears in the app immediately
    try {
      const displayName = fullName?.trim() || email.split('@')[0];
      const { data: userRow, error: insertError } = await supabaseAdmin
        .from('users')
        .insert({
          id: authUser.id,
          email: email.toLowerCase().trim(),
          full_name: displayName,
          role: role || 'employee',
          is_active: true,
        })
        .select()
        .single();

      if (insertError) {
        // If the user row already exists (e.g. re-invite), update it instead
        if (insertError.code === '23505') { // unique_violation
          const { data: updatedRow, error: updateError } = await supabaseAdmin
            .from('users')
            .update({ role: role || 'employee', is_active: true })
            .eq('email', email.toLowerCase().trim())
            .select()
            .single();
          if (updateError) {
            console.warn('Failed to update existing user row during invite:', updateError.message);
          }
          return updatedRow || authData;
        }
        console.warn('Failed to create user row during invite:', insertError.message);
        // Don't throw — the auth user was created; the row can be synced later
      }

      return userRow || authData;
    } catch (err) {
      console.warn('Error creating user row during invite:', err.message);
      return authData;
    }
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

  // Expose raw Supabase clients for edge cases during migration
  _supabase: supabase,
  _supabaseAdmin: supabaseAdmin,
};

// Temporary backward-compat alias (remove once all imports are updated)
export { api as base44 };

// Also export individual Supabase clients for direct use where needed
export { supabase, supabaseAdmin };
// force rebuild 1773921131
