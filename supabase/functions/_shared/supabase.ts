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

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
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
export async function getUserFromReq(req: Request): Promise<any | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const token = authHeader.replace('Bearer ', '');
  if (!token) return null;

  const admin = getAdminClient();
  const { data: { user: authUser }, error } = await admin.auth.getUser(token);
  if (error || !authUser) return null;

  // Fetch app-level user from our users table
  const { data: appUser } = await admin
    .from('users')
    .select('*')
    .eq('email', authUser.email)
    .single();

  return appUser || null;
}

// ─── Entity helpers (mirrors the Base44 SDK pattern) ──────────────────────────

/** Convert PascalCase entity name to snake_case plural table name. */
const _tableCache = new Map<string, string>();

export function toTableName(entityName: string): string {
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

// ─── Function invocation (cross-function calls) ──────────────────────────────

/**
 * Invoke another Edge Function by name.
 * Replaces base44.asServiceRole.functions.invoke(name, params).
 */
export async function invokeFunction(functionName: string, params: any = {}): Promise<any> {
  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Function ${functionName} failed (${res.status}): ${text}`);
  }

  return res.json().catch(() => null);
}

// ─── Notification helper ──────────────────────────────────────────────────────

/** Fire a notification via the notificationService function. */
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
}) {
  try {
    await invokeFunction('notificationService', {
      action: 'create',
      ...params,
    });
  } catch (err: any) {
    console.warn('fireNotif failed:', err?.message);
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}
