/**
 * engineEditorialPolicy — read the global editorial policy that governs
 * how the shortlisting engine distributes package quotas.
 *
 * Replaces the static `shortlisting_slot_definitions` lattice as the
 * authoritative directive for Stage 4.  Quotas come from
 * `packages.products` (via packageQuotas.ts); this module supplies the
 * editorial principles, tie-breaks, quality floor, and coverage hints
 * that shape HOW Stage 4 spends those quotas.
 *
 * Storage: singleton row at `shortlisting_engine_policy.id = 1`
 * (mig 465).  When the row is unavailable (row missing, RLS denial, or
 * caller has no DB access) the module falls back to the DEFAULT_POLICY
 * constant below — Stage 4 ALWAYS gets a usable policy.
 *
 * The policy is intentionally text-heavy.  It's injected verbatim into
 * the Stage 4 user prompt so master_admin can tune editorial behavior
 * without a code deploy.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

export interface EditorialPolicy {
  /** Free-form markdown describing what "good" looks like.  Injected into
   *  the Stage 4 prompt verbatim.  Edited via the Recipes settings UI. */
  editorial_principles: string;

  /** Tie-break rules when two candidates score identically.  Also
   *  injected verbatim. */
  tie_breaks: string;

  /** Minimum signal score (0-10) for the engine to even consider a
   *  candidate.  Anything strictly below this is hard-filtered before
   *  Stage 4 sees it. */
  quality_floor: number;

  /** Room types the post-check validator treats as "common for AU
   *  residential listings" — if the engine omits a room from this list
   *  AND a candidate exists in the round, a coverage_warning is emitted.
   *  Hint to operators, never blocks. */
  common_residential_rooms: string[];

  /** Subject types the engine should prefer when filling the dusk
   *  quota.  Surfaced to Stage 4 as guidance, not strict eligibility. */
  dusk_subjects: string[];
}

/**
 * Hard-coded fallback used when the singleton row is unavailable.  Stays
 * in sync with the seed in mig 465 — manual sync, not auto, so a code
 * deploy doesn't silently overwrite operator edits.
 */
export const DEFAULT_POLICY: EditorialPolicy = {
  editorial_principles:
    'You are an expert Australian real-estate photo editor selecting the deliverable shortlist for an active sales listing.\n\n' +
    'Editorial principles, ranked:\n' +
    '  1. Property comprehension — a buyer must understand the layout and lifestyle from the shortlist alone. Coverage > completeness.\n' +
    '  2. Strongest shot per room wins — never pick two of the same space_instance unless both add genuinely different value (e.g. wide + key detail, or AM vs PM lighting).\n' +
    '  3. Hero rooms typical for AU listings — kitchen, master_bedroom, primary living, dining (if present), exterior_front, bathroom_main. Use editorial judgment when a property genuinely lacks one. If a hero room has NO viable candidate, say so via coverage_warnings — do NOT pad with a weaker substitute.\n' +
    '  4. Dusk picks must showcase the facade, exterior architecture, pool/garden/landscape lighting, or street-side ambience. No dusk interiors unless explicitly compelling.\n' +
    '  5. Reject heavy clutter, blown highlights, mis-aligned compositions UNLESS retouchable AND the room has no better angle in the round.',
  tie_breaks:
    'When two candidates tie on overall quality:\n' +
    '  1. signal_scores.composition × signal_scores.lighting (multiplicative)\n' +
    '  2. social_first_friendly = true wins\n' +
    '  3. Operator memory of past decisions on this project (project_memory_block above)\n' +
    '  4. Signal score: appeal_signals length',
  quality_floor: 5.5,
  common_residential_rooms: [
    'kitchen',
    'master_bedroom',
    'open_plan_living',
    'living',
    'dining',
    'exterior_front',
    'bathroom_main',
  ],
  dusk_subjects: [
    'exterior_facade',
    'facade',
    'pool_dusk',
    'garden_dusk',
    'streetscape_dusk',
    'exterior_rear',
    'balcony_dusk',
  ],
};

interface PolicyRow {
  policy: unknown;
  updated_at: string;
}

/**
 * Validate a candidate object against the EditorialPolicy shape.  Returns
 * the cleaned object on success, throws on any structural mismatch.
 *
 * Tolerant of extra keys (forwards-compat); strict on the shape of known
 * keys so a corrupted row falls back to DEFAULT_POLICY rather than
 * shipping garbage to Stage 4.
 */
export function validateEditorialPolicy(raw: unknown): EditorialPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy: not an object');
  }
  const obj = raw as Record<string, unknown>;

  const principles = typeof obj.editorial_principles === 'string'
    ? obj.editorial_principles.trim()
    : '';
  if (!principles) throw new Error('policy.editorial_principles: missing or empty');

  const ties = typeof obj.tie_breaks === 'string' ? obj.tie_breaks.trim() : '';
  if (!ties) throw new Error('policy.tie_breaks: missing or empty');

  const floor = typeof obj.quality_floor === 'number' && Number.isFinite(obj.quality_floor)
    ? Math.max(0, Math.min(10, obj.quality_floor))
    : DEFAULT_POLICY.quality_floor;

  const rooms = Array.isArray(obj.common_residential_rooms)
    ? (obj.common_residential_rooms as unknown[])
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [...DEFAULT_POLICY.common_residential_rooms];

  const dusk = Array.isArray(obj.dusk_subjects)
    ? (obj.dusk_subjects as unknown[])
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [...DEFAULT_POLICY.dusk_subjects];

  return {
    editorial_principles: principles,
    tie_breaks: ties,
    quality_floor: floor,
    common_residential_rooms: rooms,
    dusk_subjects: dusk,
  };
}

/**
 * Read the active policy.  Falls back to DEFAULT_POLICY on ANY failure
 * (RLS denial, row missing, jsonb shape mismatch, network).  Logs once
 * per failure so ops can spot a misconfigured row without Stage 4 dying.
 */
export async function readEditorialPolicy(
  admin: SupabaseClient,
): Promise<{ policy: EditorialPolicy; source: 'db' | 'default'; warning?: string }> {
  try {
    const { data, error } = await admin
      .from('shortlisting_engine_policy')
      .select('policy, updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      console.warn(
        `[engineEditorialPolicy] DB read failed: ${error.message} — falling back to DEFAULT_POLICY`,
      );
      return { policy: DEFAULT_POLICY, source: 'default', warning: error.message };
    }
    if (!data) {
      console.warn(
        `[engineEditorialPolicy] singleton row missing — falling back to DEFAULT_POLICY`,
      );
      return { policy: DEFAULT_POLICY, source: 'default', warning: 'row missing' };
    }
    const validated = validateEditorialPolicy((data as PolicyRow).policy);
    return { policy: validated, source: 'db' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[engineEditorialPolicy] threw: ${msg} — falling back to DEFAULT_POLICY`,
    );
    return { policy: DEFAULT_POLICY, source: 'default', warning: msg };
  }
}
