/**
 * canonicalRegistry/similarityMatch.ts — cosine-similarity match against
 * `object_registry.embedding_vector`.
 *
 * Wraps a single SQL query that uses pgvector's `<=>` operator (cosine
 * distance) and converts to similarity (1 - distance). Returns the top-N
 * nearest canonical objects with similarity scores.
 *
 * Thresholds (per W12 spec + W12-trigger-thresholds.md):
 *   - similarity ≥ 0.92 → AUTO-NORMALIZE (caller writes attribute_values + bumps market_frequency)
 *   - 0.75 ≤ similarity < 0.92 → DISCOVERY QUEUE (caller upserts object_registry_candidates)
 *   - similarity < 0.75 → NEW OBSERVATION (caller writes raw_attribute_observations only)
 *
 * The classification helpers below let callers categorize without re-checking
 * the magic numbers each time.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { formatVectorLiteral } from './embeddings.ts';

// ─── Threshold constants (per W12 spec) ──────────────────────────────────────
export const AUTO_NORMALIZE_THRESHOLD = 0.92;
export const DISCOVERY_QUEUE_THRESHOLD = 0.75;

export type MatchAction = 'auto_normalize' | 'queue_for_review' | 'new_observation';

export function classifySimilarity(score: number): MatchAction {
  if (score >= AUTO_NORMALIZE_THRESHOLD) return 'auto_normalize';
  if (score >= DISCOVERY_QUEUE_THRESHOLD) return 'queue_for_review';
  return 'new_observation';
}

export interface RegistryMatch {
  id: string;                    // object_registry.id
  canonical_id: string;          // object_registry.canonical_id
  display_name: string;
  similarity: number;            // [0, 1]; 1 = identical, 0 = orthogonal
  market_frequency: number;
  signal_room_type: string | null;
  signal_confidence: number | null;
  level_0_class: string | null;
  level_1_functional: string | null;
}

/**
 * Find top-N nearest neighbors in `object_registry` by cosine similarity.
 *
 * @param admin - service-role Supabase client (bypasses RLS)
 * @param embedding - 1536-dim float array from embedText()
 * @param topN - default 5
 * @returns sorted matches DESC by similarity
 */
export async function findNearestCanonicals(
  admin: SupabaseClient,
  embedding: number[],
  topN: number = 5,
): Promise<RegistryMatch[]> {
  const literal = formatVectorLiteral(embedding);

  // We use the cosine distance operator `<=>` and convert to similarity.
  // pgvector's HNSW index supports `<=>` for vector_cosine_ops.
  // ORDER BY ... <=> ... ASC retrieves the nearest (smallest distance).
  const { data, error } = await admin.rpc('canonical_nearest_neighbors', {
    p_embedding: literal,
    p_top_n: topN,
  });

  if (error) {
    // Fallback path: if the RPC isn't installed (yet), do a direct query
    // via the postgrest sql endpoint. This is a defensive fallback for
    // environments where mig 380's optional helper RPC didn't apply.
    return fallbackDirectQuery(admin, literal, topN);
  }

  return (data || []) as RegistryMatch[];
}

/** Fallback direct SQL via supabase-js — used if the helper RPC is absent. */
async function fallbackDirectQuery(
  admin: SupabaseClient,
  literal: string,
  topN: number,
): Promise<RegistryMatch[]> {
  // supabase-js doesn't have a generic raw-SQL escape hatch, so we use
  // a parameterless RPC pattern: post a query via the sql() builder if
  // available, else fall back to selecting candidates and computing
  // similarity in JS.
  const { data, error } = await admin
    .from('object_registry')
    .select('id, canonical_id, display_name, market_frequency, signal_room_type, signal_confidence, level_0_class, level_1_functional, embedding_vector')
    .eq('status', 'canonical')
    .eq('is_active', true)
    .not('embedding_vector', 'is', null)
    .limit(500); // Pre-filter to a sane batch — JS-side ranking covers the rest.

  if (error) {
    throw new Error(`findNearestCanonicals fallback failed: ${error.message}`);
  }

  if (!data || data.length === 0) return [];

  // Parse embedding_vector strings, compute cosine similarity client-side.
  // pgvector returns vectors as text like '[0.1,0.2,...]' via PostgREST.
  const queryVec = parseVectorLiteral(literal);
  const ranked = data
    .map((row: any) => {
      const candidateVec = typeof row.embedding_vector === 'string'
        ? parseVectorLiteral(row.embedding_vector)
        : (row.embedding_vector as number[] | null);
      if (!candidateVec || candidateVec.length === 0) return null;
      const sim = cosineFromVectors(queryVec, candidateVec);
      return {
        id: row.id,
        canonical_id: row.canonical_id,
        display_name: row.display_name,
        similarity: sim,
        market_frequency: row.market_frequency,
        signal_room_type: row.signal_room_type,
        signal_confidence: row.signal_confidence,
        level_0_class: row.level_0_class,
        level_1_functional: row.level_1_functional,
      };
    })
    .filter((m): m is RegistryMatch => m !== null)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);

  return ranked;
}

function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.replace(/^\[/, '').replace(/\]$/, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((s) => Number(s));
}

function cosineFromVectors(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
