//
// fieldSources.ts — typed edge-function helpers for SAFR (Source-Aware Field
// Resolution). Thin wrappers over the migration-178 RPCs. See:
//   · supabase/migrations/178_entity_field_sources_schema.sql
//   · supabase/migrations/179_entity_field_sources_backfill.sql
//
// Design contract (frozen for the 4 parallel agents):
//   · RPC names + argument names are stable. This module is the canonical
//     TypeScript call site; do not call these RPCs from edge fns directly.
//   · Every scrape / email / webhook writer calls recordFieldObservation(...)
//     with a stable `source` string. The resolver decides which value wins.
//   · Reads go through resolveEntityField(...). Callers should treat the
//     returned value as authoritative and fall back to the legacy column
//     only when a value is absent.
//

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Types ───────────────────────────────────────────────────────────────────

export type EntityType =
  | 'contact'
  | 'organization'
  | 'agent'
  | 'agency'
  | 'prospect';

export type FieldName =
  | 'mobile'
  | 'email'
  | 'phone'
  | 'full_name'
  | 'job_title'
  | 'profile_image'
  | 'linkedin_url'
  | 'name'
  | 'website'
  | 'address'
  | 'logo_url'
  | 'agency_name'
  | 'agency_rea_id';

// Known sources. Keep in sync with the source_priors jsonb seeded in migration
// 178. Callers may pass arbitrary strings — unknown sources default to a 0.5
// confidence prior.
export type Source =
  | 'manual'
  | 'email_sync'
  | 'rea_scrape'
  | 'rea_listing_detail'
  | 'domain_scrape'
  | 'import_csv'
  | 'enrichment_clearbit'
  | 'tonomo_webhook'
  | 'detail_page_lister'
  | string;

export interface FieldObservation {
  entity_type: EntityType;
  entity_id: string;
  field_name: FieldName;
  value: string | null | undefined;
  source: Source;
  source_ref_type?: string | null;
  source_ref_id?: string | null;
  confidence?: number | null;
  observed_at?: string | null;
}

export interface RecordFieldObservationResult {
  ok: boolean;
  reason?: string;
  inserted?: boolean;
  updated?: boolean;
  promotion_changed?: boolean;
  new_promoted_value?: string | null;
  conflict_detected?: boolean;
  row_id?: string;
}

export interface ResolvedAlternate {
  value: string;
  display: string | null;
  source: Source;
  confidence: number;
  times_seen: number;
  last_seen_at: string;
  dismissed: boolean;
}

export interface ResolvedField {
  // Single-value policies
  value?: string | null;
  display?: string | null;
  source?: Source | null;
  confidence?: number | null;
  observed_at?: string | null;
  promoted_at?: string | null;
  locked: boolean;
  locked_by_user_id?: string | null;
  // Multi-value policies (email can have up to 3 promoted values)
  values?: ResolvedAlternate[];
  alternates: ResolvedAlternate[];
  conflict: boolean;
  policy: string;
}

// ── Wrappers ────────────────────────────────────────────────────────────────

/**
 * Record an observation of a field value from any source. Normalisation,
 * upsert, re-resolution, and legacy mirror all happen server-side.
 *
 * A null / empty value is a no-op (returns ok=false reason=empty_value) so
 * callers can pipe raw-scrape output through without pre-filtering.
 */
export async function recordFieldObservation(
  client: SupabaseClient,
  obs: FieldObservation,
): Promise<RecordFieldObservationResult> {
  const { data, error } = await client.rpc('record_field_observation', {
    p_entity_type: obs.entity_type,
    p_entity_id: obs.entity_id,
    p_field_name: obs.field_name,
    p_value: obs.value ?? null,
    p_source: obs.source,
    p_source_ref_type: obs.source_ref_type ?? null,
    p_source_ref_id: obs.source_ref_id ?? null,
    p_confidence: obs.confidence ?? null,
    p_observed_at: obs.observed_at ?? new Date().toISOString(),
  });
  if (error) {
    return { ok: false, reason: error.message };
  }
  return data as RecordFieldObservationResult;
}

/**
 * Resolve the canonical value for (entity_type, entity_id, field_name).
 * Returns null for `value` when the field has never been observed.
 */
export async function resolveEntityField(
  client: SupabaseClient,
  entity_type: EntityType,
  entity_id: string,
  field_name: FieldName,
): Promise<ResolvedField> {
  const { data, error } = await client.rpc('resolve_entity_field', {
    p_entity_type: entity_type,
    p_entity_id: entity_id,
    p_field_name: field_name,
  });
  if (error) throw new Error(`resolveEntityField failed: ${error.message}`);
  return data as ResolvedField;
}

// ── Admin helpers ───────────────────────────────────────────────────────────

export async function promoteEntityField(
  client: SupabaseClient,
  source_id: string,
  user_id: string,
): Promise<{ ok: boolean; reason?: string; resolved?: ResolvedField }> {
  const { data, error } = await client.rpc('promote_entity_field', {
    p_source_id: source_id,
    p_user_id: user_id,
  });
  if (error) throw new Error(`promoteEntityField failed: ${error.message}`);
  return data as { ok: boolean; reason?: string; resolved?: ResolvedField };
}

export async function lockEntityField(
  client: SupabaseClient,
  entity_type: EntityType,
  entity_id: string,
  field_name: FieldName,
  value_normalized: string,
  user_id: string,
): Promise<{ ok: boolean; reason?: string; resolved?: ResolvedField }> {
  const { data, error } = await client.rpc('lock_entity_field', {
    p_entity_type: entity_type,
    p_entity_id: entity_id,
    p_field_name: field_name,
    p_value_normalized: value_normalized,
    p_user_id: user_id,
  });
  if (error) throw new Error(`lockEntityField failed: ${error.message}`);
  return data as { ok: boolean; reason?: string; resolved?: ResolvedField };
}

export async function unlockEntityField(
  client: SupabaseClient,
  entity_type: EntityType,
  entity_id: string,
  field_name: FieldName,
  user_id: string,
): Promise<{ ok: boolean; reason?: string; resolved?: ResolvedField }> {
  const { data, error } = await client.rpc('unlock_entity_field', {
    p_entity_type: entity_type,
    p_entity_id: entity_id,
    p_field_name: field_name,
    p_user_id: user_id,
  });
  if (error) throw new Error(`unlockEntityField failed: ${error.message}`);
  return data as { ok: boolean; reason?: string; resolved?: ResolvedField };
}

export async function dismissFieldSource(
  client: SupabaseClient,
  source_id: string,
  user_id: string,
  reason?: string,
): Promise<{ ok: boolean; reason?: string; resolved?: ResolvedField }> {
  const { data, error } = await client.rpc('dismiss_field_source', {
    p_source_id: source_id,
    p_user_id: user_id,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(`dismissFieldSource failed: ${error.message}`);
  return data as { ok: boolean; reason?: string; resolved?: ResolvedField };
}

/**
 * Alias for unlockEntityField — the naming matches the UI verb when a user
 * wants to "restore automatic resolution" after a prior manual lock.
 */
export const restoreFieldAutoResolution = unlockEntityField;
