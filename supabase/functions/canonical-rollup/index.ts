/**
 * canonical-rollup — Wave 12 Stage 1.5 normalisation edge fn.
 * ───────────────────────────────────────────────────────────
 *
 * Maps Stage 1's free-text `key_elements[]` (and optionally `observed_objects[]`)
 * to canonical IDs in `object_registry` via Gemini embeddings + pgvector
 * cosine similarity. Manual-trigger only (per Joseph 2026-04-27).
 *
 * Usage modes:
 *   1. POST { round_id }
 *      → Process every composition_classifications row in the round.
 *
 *   2. POST { round_id, group_id, key_elements: string[] }
 *      → Process a single explicit list (useful for debug / replay).
 *
 *   3. POST { round_id, key_elements: string[] }
 *      → Process the explicit list scoped to that round (group_id NULL —
 *        used by tests).
 *
 * Behavior per key_element:
 *   1. Embed via embedText (Gemini gemini-embedding-001 @ 1536 dim)
 *   2. Top-5 nearest match via canonical_nearest_neighbors RPC
 *   3. Threshold split:
 *      - cosine ≥ 0.92  → AUTO-NORMALIZE
 *          • upsert raw_attribute_observations (round_id, group_id, raw_label)
 *            with normalised_to_object_id + similarity_score
 *          • bump object_registry.market_frequency
 *          • bump object_registry.last_observed_at
 *      - 0.75 ≤ cosine < 0.92 → DISCOVERY QUEUE
 *          • upsert raw_attribute_observations (un-normalised)
 *          • upsert object_registry_candidates with similarity_to_existing
 *      - cosine < 0.75 → NEW OBSERVATION
 *          • upsert raw_attribute_observations (un-normalised)
 *          • upsert object_registry_candidates with "no close match" hint
 *
 * Returns:
 *   { round_id, processed, auto_normalized, queued_for_review, new_observations,
 *     skipped_already_processed, elapsed_ms, errors[] }
 *
 * Idempotent: the unique partial index on (round_id, group_id, raw_label) for
 * raw_attribute_observations means re-running on the same round is a no-op
 * for already-processed (round, group, label) tuples.
 *
 * Auth: master_admin only (or service_role for cross-fn calls).
 *
 * Cost: ~$0.0001 per key_element (Gemini embedding). 42 classifications ×
 * 10 elements ≈ 420 obs ≈ $0.04 per round.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { embedText, formatVectorLiteral } from '../_shared/canonicalRegistry/embeddings.ts';
import {
  classifySimilarity,
  findNearestCanonicals,
  AUTO_NORMALIZE_THRESHOLD,
  DISCOVERY_QUEUE_THRESHOLD,
} from '../_shared/canonicalRegistry/similarityMatch.ts';

const FN_NAME = 'canonical-rollup';
const FN_VERSION = 'v1.0';

interface RolloutBody {
  round_id: string;
  group_id?: string | null;
  key_elements?: string[];
  /** Cap the number of key_elements processed per call (default 60, max 200).
   *  Edge-fn 150s timeout caps full-round processing — chunk via repeated calls
   *  with limit=60. The dedup logic skips already-processed (round, group, label)
   *  tuples so re-running is safe. */
  limit?: number;
  /** Skip embedding (testing only — caller provides cached embeddings) */
  _health_check?: boolean;
}

interface KeyElementUnit {
  group_id: string | null;
  raw_label: string;
  source_excerpt?: string | null;
}

interface ProcessOutcome {
  raw_label: string;
  group_id: string | null;
  action: 'auto_normalized' | 'queued_for_review' | 'new_observation' | 'skipped' | 'error';
  matched_canonical_id?: string | null;
  matched_canonical_label?: string | null;
  similarity?: number;
  error?: string;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden: master_admin only', 403, req);
    }
  }

  // ─── Parse body ───────────────────────────────────────────────────────────
  let body: RolloutBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME }, 200, req);
  }

  if (!body.round_id || typeof body.round_id !== 'string') {
    return errorResponse('round_id is required', 400, req);
  }

  const startMs = Date.now();
  const admin = getAdminClient();

  try {
    // ─── Collect key_elements to process ─────────────────────────────────────
    let units: KeyElementUnit[] = [];
    if (Array.isArray(body.key_elements) && body.key_elements.length > 0) {
      // Explicit list mode
      units = body.key_elements.map((k) => ({
        group_id: body.group_id ?? null,
        raw_label: String(k).trim(),
      })).filter((u) => u.raw_label.length > 0);
    } else {
      // Batch mode: walk all classifications in the round
      const { data: classifications, error } = await admin
        .from('composition_classifications')
        .select('group_id, key_elements, analysis')
        .eq('round_id', body.round_id);
      if (error) {
        return errorResponse(`Failed to load classifications: ${error.message}`, 500, req);
      }
      if (!classifications || classifications.length === 0) {
        return jsonResponse({
          round_id: body.round_id,
          processed: 0,
          auto_normalized: 0,
          queued_for_review: 0,
          new_observations: 0,
          skipped_already_processed: 0,
          elapsed_ms: Date.now() - startMs,
          errors: [],
          message: 'No classifications found for this round',
        }, 200, req);
      }
      for (const row of classifications as Array<{ group_id: string; key_elements: string[] | null; analysis: string | null }>) {
        const elements = Array.isArray(row.key_elements) ? row.key_elements : [];
        const excerpt = (row.analysis || '').slice(0, 500);
        for (const el of elements) {
          const label = String(el || '').trim();
          if (label) {
            units.push({ group_id: row.group_id, raw_label: label, source_excerpt: excerpt });
          }
        }
      }
    }

    if (units.length === 0) {
      return jsonResponse({
        round_id: body.round_id,
        processed: 0,
        auto_normalized: 0,
        queued_for_review: 0,
        new_observations: 0,
        skipped_already_processed: 0,
        elapsed_ms: Date.now() - startMs,
        errors: [],
        message: 'No key_elements to process',
      }, 200, req);
    }

    // ─── Apply per-call limit to keep edge fn under the 150s timeout ────────
    const totalUnits = units.length;
    const limit = Math.max(1, Math.min(body.limit ?? 60, 200));

    // ─── Pre-filter: skip (round, group, label) tuples already processed ────
    // Pull existing raw_attribute_observations for the round to deduplicate.
    const { data: existing } = await admin
      .from('raw_attribute_observations')
      .select('group_id, raw_label, normalised_to_object_id')
      .eq('round_id', body.round_id);

    const existingKey = new Set<string>();
    for (const row of (existing || []) as Array<{ group_id: string; raw_label: string; normalised_to_object_id: string | null }>) {
      // Skip any row that already exists in raw_attribute_observations —
      // whether normalised or queued for review. Re-running the rollup against
      // the same round should be a no-op for already-seen labels. To re-process
      // (e.g. after registry curation changed), explicitly delete the rows.
      existingKey.add(`${row.group_id || ''}|${row.raw_label}`);
    }

    // ─── Process each unit ──────────────────────────────────────────────────
    // First, apply the limit by filtering out already-processed dedupes ahead
    // of the loop, then trimming. This way, repeated chunked calls progress
    // forward through the round instead of re-evaluating the same prefix.
    const pending: KeyElementUnit[] = [];
    for (const unit of units) {
      const dedupKey = `${unit.group_id || ''}|${unit.raw_label}`;
      if (existingKey.has(dedupKey)) continue;
      pending.push(unit);
      if (pending.length >= limit) break;
    }

    const outcomes: ProcessOutcome[] = [];
    let autoNormalized = 0;
    let queuedForReview = 0;
    let newObservations = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Count how many were skipped by the pending filter above
    skipped = totalUnits - pending.length - Math.max(0, totalUnits - existingKey.size - pending.length);
    // simpler: skipped = the existing-key matches we filtered out above
    skipped = 0;
    for (const unit of units) {
      const dedupKey = `${unit.group_id || ''}|${unit.raw_label}`;
      if (existingKey.has(dedupKey)) skipped++;
    }

    // ─── Pre-embed all pending units in parallel batches ──────────────────
    // Sequential embedding at ~1s/call would push us over the 150s edge fn
    // timeout. Gemini's embedContent endpoint supports concurrent requests;
    // batches of 8 give a healthy speedup without tripping rate limits.
    const EMBED_CONCURRENCY = 8;
    const embeddings = new Map<number, number[]>();
    for (let i = 0; i < pending.length; i += EMBED_CONCURRENCY) {
      const slice = pending.slice(i, i + EMBED_CONCURRENCY);
      const results = await Promise.all(
        slice.map((u) => embedText(u.raw_label).catch((err) => ({ __err: err instanceof Error ? err.message : String(err) }))),
      );
      results.forEach((r, j) => {
        const idx = i + j;
        if (Array.isArray(r)) {
          embeddings.set(idx, r);
        } else {
          errors.push(`embed "${slice[j].raw_label}" failed: ${(r as { __err: string }).__err}`);
        }
      });
    }

    for (let idx = 0; idx < pending.length; idx++) {
      const unit = pending[idx];
      const embedding = embeddings.get(idx);
      if (!embedding) {
        outcomes.push({ raw_label: unit.raw_label, group_id: unit.group_id, action: 'error', error: 'embedding failed' });
        continue;
      }
      try {
        const embeddingLiteral = formatVectorLiteral(embedding);

        // 2. Top-5 nearest match
        const matches = await findNearestCanonicals(admin, embedding, 5);
        const topMatch = matches[0];
        const topSim = topMatch ? Number(topMatch.similarity) : 0;

        // 3. Classify by threshold
        const action = classifySimilarity(topSim);

        // 4. Upsert raw_attribute_observations (single source of truth row)
        const obsPayload: Record<string, unknown> = {
          round_id: body.round_id,
          group_id: unit.group_id,
          raw_label: unit.raw_label,
          raw_label_embedding: embeddingLiteral,
          source_type: 'internal_raw',
          source_excerpt: unit.source_excerpt || null,
          attributes: {},
        };

        if (action === 'auto_normalize' && topMatch) {
          obsPayload.normalised_to_object_id = topMatch.id;
          obsPayload.normalised_at = new Date().toISOString();
          obsPayload.similarity_score = Number(topSim.toFixed(4));
        }

        // Manual upsert: PostgREST onConflict requires a non-partial unique
        // constraint name; our uniqueness is partial (round + group not null).
        // So we look up first, then UPDATE or INSERT as appropriate.
        let lookupQ = admin
          .from('raw_attribute_observations')
          .select('id')
          .eq('round_id', body.round_id)
          .eq('raw_label', unit.raw_label);
        lookupQ = unit.group_id ? lookupQ.eq('group_id', unit.group_id) : lookupQ.is('group_id', null);
        const { data: existingRow, error: lookupErr } = await lookupQ.maybeSingle();

        let obsError: { message: string } | null = null;
        if (lookupErr) {
          obsError = lookupErr;
        } else if (existingRow) {
          const { error } = await admin
            .from('raw_attribute_observations')
            .update(obsPayload)
            .eq('id', existingRow.id);
          if (error) obsError = error;
        } else {
          const { error } = await admin
            .from('raw_attribute_observations')
            .insert(obsPayload);
          if (error) obsError = error;
        }

        if (obsError) {
          errors.push(`raw_obs upsert failed for "${unit.raw_label}": ${obsError.message}`);
          outcomes.push({
            raw_label: unit.raw_label,
            group_id: unit.group_id,
            action: 'error',
            error: obsError.message,
          });
          continue;
        }

        // 5. Branch by action
        if (action === 'auto_normalize' && topMatch) {
          // Bump market_frequency + last_observed_at on the canonical
          const bumpRes = await admin
            .from('object_registry')
            .update({
              market_frequency: (topMatch.market_frequency || 0) + 1,
              last_observed_at: new Date().toISOString(),
            })
            .eq('id', topMatch.id);
          if (bumpRes.error) {
            console.warn(`[${FN_NAME}] frequency bump failed: ${bumpRes.error.message}`);
          }

          autoNormalized++;
          outcomes.push({
            raw_label: unit.raw_label,
            group_id: unit.group_id,
            action: 'auto_normalized',
            matched_canonical_id: topMatch.id,
            matched_canonical_label: topMatch.canonical_id,
            similarity: topSim,
          });
        } else if (action === 'queue_for_review') {
          // Upsert candidate with similarity context
          await upsertCandidate(admin, {
            proposed_label: normalizeToCanonicalKey(unit.raw_label),
            display_name: unit.raw_label,
            embedding_literal: embeddingLiteral,
            matches,
            sample_excerpt: unit.source_excerpt || unit.raw_label,
          });
          queuedForReview++;
          outcomes.push({
            raw_label: unit.raw_label,
            group_id: unit.group_id,
            action: 'queued_for_review',
            matched_canonical_id: topMatch?.id ?? null,
            matched_canonical_label: topMatch?.canonical_id ?? null,
            similarity: topSim,
          });
        } else {
          // new_observation — also queue for review (but with "no close match" hint)
          await upsertCandidate(admin, {
            proposed_label: normalizeToCanonicalKey(unit.raw_label),
            display_name: unit.raw_label,
            embedding_literal: embeddingLiteral,
            matches,
            sample_excerpt: unit.source_excerpt || unit.raw_label,
            new_observation: true,
          });
          newObservations++;
          outcomes.push({
            raw_label: unit.raw_label,
            group_id: unit.group_id,
            action: 'new_observation',
            matched_canonical_id: topMatch?.id ?? null,
            matched_canonical_label: topMatch?.canonical_id ?? null,
            similarity: topSim,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`process "${unit.raw_label}" failed: ${msg}`);
        outcomes.push({
          raw_label: unit.raw_label,
          group_id: unit.group_id,
          action: 'error',
          error: msg,
        });
      }
    }

    return jsonResponse({
      round_id: body.round_id,
      total_units: totalUnits,
      processed_this_call: pending.length,
      remaining_after_call: Math.max(0, totalUnits - skipped - pending.length),
      auto_normalized: autoNormalized,
      queued_for_review: queuedForReview,
      new_observations: newObservations,
      skipped_already_processed: skipped,
      limit_applied: limit,
      elapsed_ms: Date.now() - startMs,
      errors,
      sample_outcomes: outcomes.slice(0, 30),
      thresholds: {
        auto_normalize: AUTO_NORMALIZE_THRESHOLD,
        discovery_queue: DISCOVERY_QUEUE_THRESHOLD,
      },
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] failed: ${msg}`);
    return errorResponse(`canonical-rollup failed: ${msg}`, 500, req);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert free text to a snake_case candidate label.
 *  e.g. "white shaker-style cabinet doors" → "white_shaker_style_cabinet_doors"
 *  Bounded to 80 chars. */
function normalizeToCanonicalKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/** Upsert a candidate row with similarity context. Used for both
 *  queue_for_review (mid-similarity) and new_observation (low-similarity). */
async function upsertCandidate(
  admin: ReturnType<typeof getAdminClient>,
  args: {
    proposed_label: string;
    display_name: string;
    embedding_literal: string;
    matches: Array<{ id: string; canonical_id: string; display_name: string; similarity: number }>;
    sample_excerpt: string;
    new_observation?: boolean;
  },
): Promise<void> {
  const top = args.matches[0];
  const alternates = args.matches.slice(1, 5).map((m) => ({
    id: m.id,
    canonical_id: m.canonical_id,
    display_name: m.display_name,
    score: Number(Number(m.similarity).toFixed(4)),
  }));

  const similarity_to_existing = top ? {
    top_match_id: top.id,
    top_match_canonical_id: top.canonical_id,
    top_match_display_name: top.display_name,
    top_match_score: Number(Number(top.similarity).toFixed(4)),
    alternates,
    is_new_observation: !!args.new_observation,
  } : {
    top_match_id: null,
    top_match_score: 0,
    alternates: [],
    is_new_observation: !!args.new_observation,
  };

  // Try to find an existing pending candidate with the same proposed_label.
  // If exists: bump observed_count + append sample.
  // If not: insert.
  const { data: existing, error: lookupErr } = await admin
    .from('object_registry_candidates')
    .select('id, observed_count, sample_observation_ids, sample_excerpts')
    .eq('candidate_type', 'object')
    .eq('proposed_canonical_label', args.proposed_label)
    .eq('status', 'pending')
    .maybeSingle();

  if (lookupErr) {
    console.warn(`[canonical-rollup] candidate lookup failed: ${lookupErr.message}`);
  }

  if (existing) {
    const newSamples = (existing.sample_excerpts || []).slice(0, 9).concat([args.sample_excerpt.slice(0, 200)]);
    await admin
      .from('object_registry_candidates')
      .update({
        observed_count: (existing.observed_count || 0) + 1,
        sample_excerpts: newSamples.slice(0, 10),
        last_proposed_at: new Date().toISOString(),
        similarity_to_existing,
      })
      .eq('id', existing.id);
  } else {
    await admin
      .from('object_registry_candidates')
      .insert({
        candidate_type: 'object',
        proposed_canonical_label: args.proposed_label,
        proposed_display_name: args.display_name,
        candidate_embedding: args.embedding_literal,
        similarity_to_existing,
        observed_count: 1,
        sample_excerpts: [args.sample_excerpt.slice(0, 200)],
      });
  }
}
