/**
 * Source-Aware Field Resolution (SAFR) — minimal stub.
 *
 * This file is OWNED by the schema agent (migration 178 + real implementation).
 * This stub exists so parallel ingestion/rewire agents can import a stable
 * `../_shared/fieldSources.ts` surface BEFORE the schema agent's branch merges.
 *
 * Contract (must match schema agent's final module):
 *   - recordFieldObservation(admin, params): jsonb with ok/inserted/updated/promotion_changed
 *   - resolveEntityField(admin, entity_type, entity_id, field_name): resolved value + source
 *
 * Calls the underlying postgres RPCs directly:
 *   - record_field_observation(p_entity_type, p_entity_id, p_field_name, p_value,
 *                              p_source, p_source_ref_type?, p_source_ref_id?,
 *                              p_confidence?, p_observed_at?)
 *   - resolve_entity_field(entity_type, entity_id, field_name)
 *
 * Safe to ship in parallel: when the schema agent's real fieldSources.ts lands
 * at merge, it replaces this file with the same public signatures — no import-
 * site changes required.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type SafrEntityType =
  | 'agent'
  | 'agency'
  | 'contact'
  | 'organization'
  | 'pulse_agent'
  | 'pulse_agency';

export interface RecordFieldObservationParams {
  entity_type: SafrEntityType | string;
  entity_id: string;
  field_name: string;
  value: unknown;
  source: string;
  source_ref_type?: string | null;
  source_ref_id?: string | null;
  confidence?: number | null;
  observed_at?: string | null;
}

export interface RecordFieldObservationResult {
  ok: boolean;
  inserted?: boolean;
  updated?: boolean;
  promotion_changed?: boolean;
  error?: string;
}

/**
 * Append an observation to the Source-Aware Field Resolution ledger.
 * Returns `{ ok: false, error }` on RPC failure — never throws (ledger
 * writes must never cascade-fail an ingestion pipeline).
 */
export async function recordFieldObservation(
  admin: SupabaseClient,
  params: RecordFieldObservationParams,
): Promise<RecordFieldObservationResult> {
  try {
    // Normalise value: null/undefined/empty-string become null (policy:
    // don't pollute the ledger with empties — if a source has nothing to
    // say about a field, skip at the call-site).
    const v = params.value;
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      return { ok: false, error: 'empty_value_skipped' };
    }

    const { data, error } = await admin.rpc('record_field_observation', {
      p_entity_type: params.entity_type,
      p_entity_id: params.entity_id,
      p_field_name: params.field_name,
      p_value: v,
      p_source: params.source,
      p_source_ref_type: params.source_ref_type ?? null,
      p_source_ref_id: params.source_ref_id ?? null,
      p_confidence: params.confidence ?? null,
      p_observed_at: params.observed_at ?? null,
    });

    if (error) {
      // RPC may not exist yet (migration 178 unapplied). Swallow and report.
      return { ok: false, error: error.message };
    }

    // The real RPC returns jsonb: { ok, inserted, updated, promotion_changed }.
    // Handle both shape-already-matches and legacy-void cases.
    if (data && typeof data === 'object') {
      return {
        ok: (data as any).ok !== false,
        inserted: !!(data as any).inserted,
        updated: !!(data as any).updated,
        promotion_changed: !!(data as any).promotion_changed,
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export interface ResolveEntityFieldResult {
  value: unknown;
  source: string | null;
  confidence: number | null;
  observed_at: string | null;
}

export async function resolveEntityField(
  admin: SupabaseClient,
  entity_type: SafrEntityType | string,
  entity_id: string,
  field_name: string,
): Promise<ResolveEntityFieldResult | null> {
  try {
    const { data, error } = await admin.rpc('resolve_entity_field', {
      entity_type,
      entity_id,
      field_name,
    });
    if (error || !data) return null;
    if (typeof data === 'object') {
      return {
        value: (data as any).value ?? null,
        source: (data as any).source ?? null,
        confidence: (data as any).confidence ?? null,
        observed_at: (data as any).observed_at ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
