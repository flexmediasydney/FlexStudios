/**
 * Shared helper for emitting pulse_timeline rows.
 *
 * Background
 * ──────────
 * pulse_timeline has a UNIQUE partial index on `idempotency_key` (partial
 * because NULL is still allowed for legacy rows). Every new writer MUST set
 * `idempotency_key` so re-runs of the same sync don't create duplicate rows.
 *
 * Historical bugs this helper prevents (Agents D/E/F audit):
 *   - `first_seen` was emitted on every rediscovery instead of only on genuine
 *     inserts → 24,958 spurious rows, fixed in commits 18234a3 + 13b8a88.
 *   - `new_listings_detected` / `client_new_listing` / `price_change` /
 *     `status_change` emitted rollup rows with no idempotency_key AND no
 *     pulse_entity_id → fixed in migration 144 + this helper.
 *
 * Design
 * ──────
 * `emitTimeline(admin, rows, ctx?)` does three things:
 *   1. Validates each row has `event_type`, `entity_type`, `idempotency_key`
 *   2. Stamps `sync_log_id` + `apify_run_id` from `ctx` if the caller didn't
 *      already provide them (rows can still override per-row).
 *   3. Chunks upserts into batches of 500 with
 *      `onConflict: 'idempotency_key', ignoreDuplicates: true` so a re-run is
 *      a no-op instead of a crash or duplicate.
 *
 * `makeIdempotencyKey(event_type, entityRef, discriminator?)` is a tiny helper
 * that enforces the canonical `<event_type>:<entityRef>[:<discriminator>]`
 * shape, so call sites don't drift from each other.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface TimelineRow {
  event_type: string;
  entity_type: string;
  idempotency_key: string;
  pulse_entity_id?: string | null;
  crm_entity_id?: string | null;
  rea_id?: string | null;
  event_category?: string | null;
  title: string;
  description?: string | null;
  previous_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  sync_log_id?: string | null;
  apify_run_id?: string | null;
}

export interface TimelineContext {
  /** Default sync_log_id applied when a row doesn't have its own. */
  sync_log_id?: string | null;
  /** Default apify_run_id applied when a row doesn't have its own. */
  apify_run_id?: string | null;
  /** Default source applied when a row doesn't have its own. */
  source?: string | null;
}

/**
 * Build a canonical idempotency key.
 *
 * Examples:
 *   makeIdempotencyKey('first_seen', 'agent', '<uuid>')
 *     → 'first_seen:agent:<uuid>'
 *   makeIdempotencyKey('price_change', '<listing_uuid>', '850000')
 *     → 'price_change:<listing_uuid>:850000'
 *   makeIdempotencyKey('new_listings_detected', 'sync_log', '<sync_log_uuid>')
 *     → 'new_listings_detected:sync_log:<sync_log_uuid>'
 *
 * The shape is load-bearing because the UNIQUE index relies on exact equality
 * to dedupe. Keep discriminators stable (e.g. integers, not formatted strings).
 */
export function makeIdempotencyKey(
  event_type: string,
  entityRef: string,
  discriminator?: string | number | null,
): string {
  if (!event_type) throw new Error('makeIdempotencyKey: event_type is required');
  if (!entityRef) throw new Error('makeIdempotencyKey: entityRef is required');
  const disc = discriminator == null ? '' : `:${String(discriminator)}`;
  return `${event_type}:${entityRef}${disc}`;
}

/**
 * Emit one or more timeline rows. Idempotent by design.
 *
 * @param admin  service-role Supabase client
 * @param rows   one or more rows to upsert
 * @param ctx    optional context applied as defaults for sync_log_id / apify_run_id / source
 *
 * Validation: each row MUST have `event_type`, `entity_type`, and
 * `idempotency_key`. Title defaults to event_type if empty. Non-fatal errors
 * are logged via console.warn; the function never throws (callers that need
 * strict error handling can await and inspect the return value).
 *
 * Returns: { inserted: number, skipped: number, errors: string[] }
 *   - inserted: upserted rows that either inserted or hit a unique conflict
 *     (PostgREST's ignoreDuplicates returns them without counting either way)
 *   - skipped: rows rejected by validation
 *   - errors: concatenated error messages, truncated to 300 chars each
 */
export async function emitTimeline(
  admin: SupabaseClient,
  rows: TimelineRow | TimelineRow[],
  ctx: TimelineContext = {},
): Promise<{ inserted: number; skipped: number; errors: string[] }> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return { inserted: 0, skipped: 0, errors: [] };

  const errors: string[] = [];
  const valid: TimelineRow[] = [];

  for (const row of list) {
    if (!row || typeof row !== 'object') {
      errors.push('emitTimeline: non-object row rejected');
      continue;
    }
    if (!row.event_type) {
      errors.push(`emitTimeline: row missing event_type (entity_type=${row.entity_type})`);
      continue;
    }
    if (!row.entity_type) {
      errors.push(`emitTimeline: row missing entity_type (event_type=${row.event_type})`);
      continue;
    }
    if (!row.idempotency_key) {
      errors.push(`emitTimeline: row missing idempotency_key (event_type=${row.event_type})`);
      continue;
    }
    // Apply ctx defaults without clobbering explicit values.
    const normalised: TimelineRow = {
      ...row,
      title: row.title || row.event_type,
      sync_log_id: row.sync_log_id ?? ctx.sync_log_id ?? null,
      apify_run_id: row.apify_run_id ?? ctx.apify_run_id ?? null,
      source: row.source ?? ctx.source ?? null,
    };
    valid.push(normalised);
  }

  const skipped = list.length - valid.length;
  if (valid.length === 0) return { inserted: 0, skipped, errors };

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const batch = valid.slice(i, i + CHUNK);
    const { error } = await admin
      .from('pulse_timeline')
      .upsert(batch, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    if (error) {
      errors.push(`emitTimeline batch ${i / CHUNK}: ${error.message?.substring(0, 300)}`);
    } else {
      // PostgREST's ignoreDuplicates doesn't return affected rows without
      // an explicit .select(), and asking for .select() would re-fail on
      // the UNIQUE conflict. We report batch size as the optimistic count.
      inserted += batch.length;
    }
  }

  if (errors.length > 0) {
    console.warn(`emitTimeline: ${errors.length} errors (first): ${errors[0]}`);
  }
  return { inserted, skipped, errors };
}
