/**
 * Source-Aware Field Resolution (SAFR) — convenience helpers.
 *
 * Higher-level wrappers on top of `./fieldSources.ts`:
 *   - bulkRecordObservations()  — emit many observations in a single pass
 *                                 with per-call try/catch isolation (a single
 *                                 failing field never blocks the rest).
 *   - recordManualEdit()        — emit + LOCK in one call (user intent is
 *                                 sacred; future scrapes can't override).
 *   - recordAgentObservations() — helper for a common case: fan out all
 *                                 SAFR-managed fields of a pulse agent from
 *                                 a single scrape/detail payload.
 *   - recordAgencyObservations() / recordContactObservations() /
 *     recordOrganizationObservations() — same pattern for other entity types.
 *
 * The SAFR-managed field set is the canonical list — write-path authors use
 * it to know which columns they must NOT upsert directly after emitting an
 * observation (the SAFR mirror trigger handles those columns).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  recordFieldObservation,
  type RecordFieldObservationParams,
  type RecordFieldObservationResult,
  type SafrEntityType,
} from './fieldSources.ts';

// ─── SAFR-managed field registry ──────────────────────────────────────────────
//
// Source of truth for the "do not write directly after observing" rule.
// Write-path authors import these Sets and use them to strip SAFR fields from
// their upsert payloads. Matches the spec from the schema agent.

export const SAFR_FIELDS_PULSE_AGENT: ReadonlySet<string> = new Set([
  'mobile',
  'email',
  'phone',           // business_phone alias
  'business_phone',
  'full_name',
  'job_title',
  'profile_image',
]);

export const SAFR_FIELDS_PULSE_AGENCY: ReadonlySet<string> = new Set([
  'name',
  'phone',
  'email',
  'website',
  'address',
  'address_street',
  'logo_url',
]);

export const SAFR_FIELDS_CONTACT: ReadonlySet<string> = new Set([
  'mobile',
  'email',
  'phone',
  'full_name',
  'job_title',
  'profile_image',
  'linkedin_url',
]);

export const SAFR_FIELDS_ORGANIZATION: ReadonlySet<string> = new Set([
  'name',
  'phone',
  'email',
  'website',
  'address',
  'logo_url',
]);

/**
 * Strip SAFR-managed fields from an upsert payload. Returns a NEW object —
 * the input is not mutated. Use this immediately BEFORE calling
 * `admin.from(...).upsert(stripped)` so identity / non-resolved columns land
 * while SAFR-managed columns are left alone for the mirror trigger.
 */
export function stripSafrFields<T extends Record<string, unknown>>(
  record: T,
  managed: ReadonlySet<string>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!managed.has(k)) out[k] = v;
  }
  return out as Partial<T>;
}

// ─── Bulk observation fan-out ────────────────────────────────────────────────

export interface BulkObservationOutcome {
  total: number;
  ok: number;
  failed: number;
  skipped_empty: number;
  errors: string[]; // capped at 5 for log hygiene
}

/**
 * Emit many observations with per-call try/catch — one failure never blocks
 * the rest. Empty values are counted as `skipped_empty` (not `failed`).
 */
export async function bulkRecordObservations(
  admin: SupabaseClient,
  observations: RecordFieldObservationParams[],
): Promise<BulkObservationOutcome> {
  const outcome: BulkObservationOutcome = {
    total: observations.length,
    ok: 0,
    failed: 0,
    skipped_empty: 0,
    errors: [],
  };

  for (const obs of observations) {
    try {
      const res = await recordFieldObservation(admin, obs);
      if (res.ok) {
        outcome.ok++;
      } else if (res.error === 'empty_value_skipped') {
        outcome.skipped_empty++;
      } else {
        outcome.failed++;
        if (outcome.errors.length < 5 && res.error) {
          outcome.errors.push(`${obs.entity_type}/${obs.field_name}: ${res.error}`);
        }
      }
    } catch (err: any) {
      outcome.failed++;
      if (outcome.errors.length < 5) {
        outcome.errors.push(`${obs.entity_type}/${obs.field_name}: ${err?.message || 'unknown'}`);
      }
    }
  }
  return outcome;
}

// ─── Manual edit path (user intent is sacred) ────────────────────────────────

export interface RecordManualEditParams {
  entity_type: SafrEntityType | string;
  entity_id: string;
  field_name: string;
  value: unknown;
  value_normalized?: unknown; // for the lock table; defaults to `value`
}

/**
 * Record a manual user edit: emits observation with source='manual' AND
 * calls `lock_entity_field` so future scrapes can't override.
 *
 * Fails soft: if the lock RPC isn't deployed yet, the observation still
 * lands and a warning is logged.
 */
export async function recordManualEdit(
  admin: SupabaseClient,
  params: RecordManualEditParams,
  userId: string | null,
): Promise<RecordFieldObservationResult> {
  const obsResult = await recordFieldObservation(admin, {
    entity_type: params.entity_type,
    entity_id: params.entity_id,
    field_name: params.field_name,
    value: params.value,
    source: 'manual',
    source_ref_type: userId ? 'user' : null,
    source_ref_id: userId,
    confidence: 100, // max — user intent is sacred
  });

  if (!obsResult.ok) return obsResult;

  try {
    const { error: lockErr } = await admin.rpc('lock_entity_field', {
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      field_name: params.field_name,
      value_normalized: params.value_normalized ?? params.value ?? null,
      user_id: userId,
    });
    if (lockErr) {
      console.warn(
        `[safr] lock_entity_field failed for ${params.entity_type}/${params.field_name}: ${lockErr.message?.substring(0, 200)}`,
      );
    }
  } catch (err: any) {
    console.warn(
      `[safr] lock_entity_field threw for ${params.entity_type}/${params.field_name}: ${err?.message}`,
    );
  }

  return obsResult;
}

// ─── Convenience: pulse_agent observation fan-out ────────────────────────────

export interface PulseAgentObservationInput {
  entity_id: string;
  source: string;
  source_ref_type?: string;
  source_ref_id?: string;
  confidence?: number;
  observed_at?: string;
  // Observations (emit only when present — undefined skips cleanly)
  full_name?: string | null;
  mobile?: string | null;
  email?: string | null;              // primary email (also pass alternates via all_emails)
  all_emails?: string[] | null;       // emits one observation per entry
  business_phone?: string | null;
  alternate_mobiles?: string[] | null;
  alternate_business_phones?: string[] | null;
  job_title?: string | null;
  profile_image?: string | null;
}

/**
 * Emit SAFR observations for every SAFR-managed field on a pulse agent in
 * one go. Multi-value fields (emails, alternate_mobiles, alternate_business_phones)
 * emit one observation per entry — the resolver's `multi_value` policy keeps
 * up to N.
 */
export async function recordPulseAgentObservations(
  admin: SupabaseClient,
  input: PulseAgentObservationInput,
): Promise<BulkObservationOutcome> {
  const base = {
    entity_type: 'agent' as const,
    entity_id: input.entity_id,
    source: input.source,
    source_ref_type: input.source_ref_type ?? null,
    source_ref_id: input.source_ref_id ?? null,
    confidence: input.confidence ?? null,
    observed_at: input.observed_at ?? null,
  };

  const obs: RecordFieldObservationParams[] = [];

  const pushScalar = (field_name: string, value: unknown) => {
    if (value === undefined || value === null) return;
    obs.push({ ...base, field_name, value });
  };
  const pushMulti = (field_name: string, values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const v of values) {
      if (v === null || v === undefined) continue;
      obs.push({ ...base, field_name, value: v });
    }
  };

  pushScalar('full_name', input.full_name);
  pushScalar('mobile', input.mobile);
  pushScalar('email', input.email);
  pushMulti('email', input.all_emails);
  pushScalar('business_phone', input.business_phone);
  pushMulti('mobile', input.alternate_mobiles);
  pushMulti('business_phone', input.alternate_business_phones);
  pushScalar('job_title', input.job_title);
  pushScalar('profile_image', input.profile_image);

  return bulkRecordObservations(admin, obs);
}

// ─── Convenience: pulse_agency observation fan-out ───────────────────────────

export interface PulseAgencyObservationInput {
  entity_id: string;
  source: string;
  source_ref_type?: string;
  source_ref_id?: string;
  confidence?: number;
  observed_at?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  logo_url?: string | null;
}

export async function recordPulseAgencyObservations(
  admin: SupabaseClient,
  input: PulseAgencyObservationInput,
): Promise<BulkObservationOutcome> {
  const base = {
    entity_type: 'agency' as const,
    entity_id: input.entity_id,
    source: input.source,
    source_ref_type: input.source_ref_type ?? null,
    source_ref_id: input.source_ref_id ?? null,
    confidence: input.confidence ?? null,
    observed_at: input.observed_at ?? null,
  };

  const obs: RecordFieldObservationParams[] = [];
  const push = (field_name: string, value: unknown) => {
    if (value === undefined || value === null) return;
    obs.push({ ...base, field_name, value });
  };

  push('name', input.name);
  push('email', input.email);
  push('phone', input.phone);
  push('website', input.website);
  push('address', input.address);
  push('logo_url', input.logo_url);

  return bulkRecordObservations(admin, obs);
}
