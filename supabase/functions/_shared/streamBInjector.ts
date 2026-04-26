/**
 * streamBInjector.ts — Stream B tier-anchor injection for Pass 1 prompts.
 *
 * The Stream B standards library (Tier S / Tier P / Tier A) is the answer to
 * the score-clustering bug documented in spec L8. Without explicit anchor text
 * in the scoring prompt, Sonnet collapses every classification into the safe
 * 7–9 band — there is no reference for what a 3 looks like, so the model never
 * goes there. With anchors, the model has concrete tier definitions to map
 * against and the score distribution actually spreads.
 *
 *   Score 5    = Tier S minimum (competent standard real estate)
 *   Score 7–8  = approaches Tier P (premium prestige)
 *   Score 9.5+ = Tier A (architectural editorial)
 *
 * Source of truth: `shortlisting_stream_b_anchors` table. If the table is
 * empty (initial state — Phase 7 admin UI will let users INSERT rows later),
 * we fall back to hardcoded defaults verbatim from spec §10.
 *
 * Two exports:
 *   getActiveStreamBAnchors() — fetch active anchors from DB or fall back.
 *   buildScoringReferenceBlock(anchors) — returns the prompt-injectable block.
 *
 * Used by: pass1Prompt.buildPass1Prompt() and any future scoring prompt that
 * needs the same anchor text.
 */

import { getAdminClient } from './supabase.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreamBAnchors {
  tierS: string;
  tierP: string;
  tierA: string;
  /** Version stamp for traceability — 0 when falling back to hardcoded defaults. */
  version: number;
}

// ─── Hardcoded defaults (spec §10) ───────────────────────────────────────────
//
// VERBATIM from shortlisting-engine-spec-v2.md §10. Do not paraphrase. These
// strings are the empirical anchor text — the spec calls out exact phrasing
// because the wording materially affects how Sonnet interprets the scale.

const TIER_S_DEFAULT =
  'TIER S — STANDARD REAL ESTATE (Score: 5 on our scale)\n' +
  'Mandatory: vertical lines straight, windows show recoverable exterior detail, ' +
  'no visible clutter, camera at correct height (counter-top for kitchen, ' +
  'chest height for bedrooms), coverage complete.\n' +
  'A score of 5 means: competent, professional, acceptable for REA/Domain.';

const TIER_P_DEFAULT =
  'TIER P — PREMIUM PRESTIGE (Score: 8 on our scale)\n' +
  'Mandatory (in addition to Tier S): minimum 3 depth layers, foreground anchoring ' +
  'element required, indoor-outdoor connection visible where applicable, material ' +
  'texture visible (stone veining, timber grain, tile grout), HDR blend invisible, ' +
  'set-level colour grade consistent.\n' +
  'A score of 8 means: would appear in premium agent brochure for $2M+ property.';

const TIER_A_DEFAULT =
  'TIER A — ARCHITECTURAL EDITORIAL (Score: 9.5+ on our scale)\n' +
  'The picture tells the story of the building. Materials are the subject. ' +
  'Light reveals architecture. Human/lifestyle elements add narrative. ' +
  'Coverage is tertiary — one extraordinary image outscores five adequate ones.\n' +
  'A score of 9.5 means: publication-grade, Architectural Digest / dezeen standard.';

const HARDCODED_FALLBACK: StreamBAnchors = {
  tierS: TIER_S_DEFAULT,
  tierP: TIER_P_DEFAULT,
  tierA: TIER_A_DEFAULT,
  version: 0,
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the active Stream B anchors.
 *
 * Resolution order:
 *   1. SELECT all is_active=true rows from shortlisting_stream_b_anchors,
 *      grouped by tier (S/P/A). Highest version wins per tier.
 *   2. If any of the three tiers is missing, that tier falls back to the
 *      hardcoded default for that tier (mixed-mode is supported — admins can
 *      override one tier without overriding all three).
 *   3. If NO rows are active at all, returns version=0 (signals "spec default").
 *
 * The returned `version` is the MAX version across the three rows actually
 * fetched. Callers persist this in shortlisting_events.payload so we can
 * reproduce a classification's exact prompt ex post.
 */
export async function getActiveStreamBAnchors(): Promise<StreamBAnchors> {
  // Audit defect #58: fallback paths now emit a shortlisting_events row in
  // addition to console.warn so ops can surface fallback usage on dashboards
  // (the warn-only signal was silent on the Tonomo monitoring stack).
  const logFallback = async (
    reason: string,
    fellBackTiers: string[],
    detail?: Record<string, unknown>,
  ) => {
    try {
      const admin = getAdminClient();
      await admin.from('shortlisting_events').insert({
        event_type: 'stream_b_anchors_fallback',
        actor_type: 'system',
        payload: { reason, tiers_fell_back: fellBackTiers, ...(detail || {}) },
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.warn(`[streamBInjector] fallback event insert failed: ${m}`);
    }
  };

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('shortlisting_stream_b_anchors')
      .select('tier, descriptor, version, score_anchor')
      .eq('is_active', true)
      .order('version', { ascending: false });

    if (error) {
      console.warn(
        `[streamBInjector] anchors query failed (${error.message}) — using hardcoded defaults`,
      );
      await logFallback('query_failed', ['S', 'P', 'A'], { error: error.message });
      return HARDCODED_FALLBACK;
    }
    if (!data || data.length === 0) {
      await logFallback('no_active_rows', ['S', 'P', 'A']);
      return HARDCODED_FALLBACK;
    }

    // Highest-version-wins per tier.
    const byTier = new Map<string, { descriptor: string; version: number }>();
    for (const row of data) {
      const tier = String(row.tier || '').toUpperCase();
      if (!byTier.has(tier)) {
        byTier.set(tier, {
          descriptor: String(row.descriptor || ''),
          version: typeof row.version === 'number' ? row.version : 0,
        });
      }
    }

    const sRow = byTier.get('S');
    const pRow = byTier.get('P');
    const aRow = byTier.get('A');

    // Track which tiers fell back so partial-fallback is still observable.
    const fellBack: string[] = [];
    if (!sRow) fellBack.push('S');
    if (!pRow) fellBack.push('P');
    if (!aRow) fellBack.push('A');
    if (fellBack.length > 0) {
      await logFallback('tier_missing', fellBack);
    }

    const versions = [sRow?.version, pRow?.version, aRow?.version]
      .filter((v): v is number => typeof v === 'number');
    const maxVersion = versions.length > 0 ? Math.max(...versions) : 0;

    return {
      tierS: sRow?.descriptor || TIER_S_DEFAULT,
      tierP: pRow?.descriptor || TIER_P_DEFAULT,
      tierA: aRow?.descriptor || TIER_A_DEFAULT,
      version: maxVersion,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[streamBInjector] threw (${msg}) — using hardcoded defaults`);
    await logFallback('exception_thrown', ['S', 'P', 'A'], { error: msg });
    return HARDCODED_FALLBACK;
  }
}

/**
 * Render the Stream B anchors as a prompt-injectable block. Section header
 * matches spec §10 wording (`SCORING REFERENCE`). The block is meant to be
 * concatenated INTO a system prompt or user-message text part — the caller
 * supplies the surrounding STEP 1 / STEP 2 scaffolding.
 *
 * Trailing newline is intentional — concatenating callers should NOT append
 * their own. Leading text (no leading newline) is also intentional so callers
 * can decide whether to prefix a blank line.
 */
export function buildScoringReferenceBlock(anchors: StreamBAnchors): string {
  return [
    'STREAM B SCORING ANCHORS (Australian professional photography standards):',
    '',
    anchors.tierS,
    '',
    anchors.tierP,
    '',
    anchors.tierA,
    '',
    'Score distribution guidance:',
    '- Score 1–3: Technical failure or major compositional fault.',
    '- Score 4–5: Below Tier P minimum — adequate at best.',
    '- Score 6–7: Competent Tier S / approaching Tier P.',
    '- Score 8–9: Strong Tier P — premium shortlist quality.',
    '- Score 9.5+: Tier A — exceptional, publication-grade.',
    '',
    'Without the above anchors, scores cluster 7–9 (grade inflation). Use the ',
    'anchors. A score of 5 is the FLOOR for "competent professional real estate" ',
    '— anything less means the image fails Tier S.',
    '',
  ].join('\n');
}
