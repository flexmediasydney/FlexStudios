/**
 * canonicalRegistry/embeddings.ts — Wave 12 embedding helpers for the
 * canonical object registry (W12).
 *
 * Wraps Google's Gemini Embedding API:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent?key={GEMINI_API_KEY}
 *
 * Output dimension is fixed at 1536 to match `object_registry.embedding_vector
 * VECTOR(1536)`. Uses `gemini-embedding-001` which supports a configurable
 * `outputDimensionality` parameter — set to 1536 explicitly. The DB column
 * holds the full native-precision floats.
 *
 * Why 1536 (not 768 or 384)?
 *   - The W12 spec's R3 resolution: native precision avoids similarity-threshold
 *     noise at the 0.92 / 0.75 boundaries (PCA-reduced embeddings lose ~5-10%
 *     of cosine fidelity at ≤768-dim).
 *   - Storage cost is bounded — 6 KB / row × ~10k canonicals = ~60 MB at
 *     mature scale; trivial within Supabase's quota.
 *   - HNSW index on 1536-dim vectors is sub-millisecond at warm cache.
 *
 * Retry strategy:
 *   - 3 attempts on 429 / 500 / 502 / 503
 *   - Exponential backoff (1s, 2s, 4s)
 *   - 30 s AbortSignal timeout per attempt
 *
 * Cost (rough):
 *   - gemini-embedding-001 is $0.000025 / 1k input tokens
 *   - Per observation ~5-10 tokens → ~$0.0001 / observation
 *   - 42-classification Saladine round × 10 key_elements = 420 obs ≈ $0.04
 *
 * Service-role only — embeddings.ts is called from edge fns that have
 * service_role auth (canonical-rollup, object-registry-admin).
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-embedding-001';
const TARGET_DIM = 1536;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const TIMEOUT_MS = 30 * 1000;

/** Custom error class so callers can catch the typed failure. */
export class EmbeddingError extends Error {
  constructor(message: string, readonly status?: number, readonly attempt?: number) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

interface EmbedContentResponse {
  embedding?: { values: number[] };
  embeddings?: Array<{ values: number[] }>;
  error?: { message?: string; code?: number };
}

interface EmbedRequestBody {
  content: { parts: Array<{ text: string }> };
  taskType?: string;
  outputDimensionality?: number;
}

function getApiKey(): string {
  const key = Deno.env.get('GEMINI_API_KEY') || '';
  if (!key) {
    throw new EmbeddingError('GEMINI_API_KEY is not set in this edge fn environment');
  }
  return key;
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Embed a single text string. Returns a 1536-dim float array suitable for
 * direct insertion into a VECTOR(1536) column via the Postgres `vector` cast.
 *
 * Format the result for Postgres with `formatVectorLiteral(arr)` before
 * passing it as a query parameter — Supabase-js doesn't know about the
 * vector type natively.
 */
export async function embedText(
  text: string,
  opts?: { model?: string; taskType?: string },
): Promise<number[]> {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new EmbeddingError('embedText: input text is empty');
  }

  const model = opts?.model || DEFAULT_MODEL;
  const taskType = opts?.taskType || 'SEMANTIC_SIMILARITY';
  const apiKey = getApiKey();
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`;

  const body: EmbedRequestBody = {
    content: { parts: [{ text: trimmed }] },
    taskType,
    outputDimensionality: TARGET_DIM,
  };

  let lastError: string = 'no attempts ran';
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) {
        const json = (await res.json()) as EmbedContentResponse;
        // Gemini v1beta returns `embedding.values` (single) on embedContent.
        const values = json.embedding?.values || json.embeddings?.[0]?.values;
        if (!Array.isArray(values) || values.length === 0) {
          throw new EmbeddingError(
            `embedText: response missing embedding.values (got ${JSON.stringify(json).slice(0, 200)})`,
          );
        }
        if (values.length !== TARGET_DIM) {
          throw new EmbeddingError(
            `embedText: expected dim ${TARGET_DIM} but got ${values.length}`,
          );
        }
        return values;
      }

      lastStatus = res.status;
      const errBody = await res.text();
      lastError = `HTTP ${res.status}: ${errBody.slice(0, 300)}`;

      if (!isRetryable(res.status)) {
        throw new EmbeddingError(lastError, res.status, attempt);
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof EmbeddingError) {
        // Non-retryable typed error — propagate immediately.
        if (lastStatus !== 0 && !isRetryable(lastStatus)) throw err;
        lastError = err.message;
      } else if ((err as Error).name === 'AbortError') {
        lastError = `Timeout after ${TIMEOUT_MS}ms (attempt ${attempt})`;
      } else {
        lastError = (err as Error).message || String(err);
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_MS[attempt - 1] || 4000);
    }
  }

  throw new EmbeddingError(
    `embedText failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    lastStatus || undefined,
    MAX_ATTEMPTS,
  );
}

/**
 * Convert a JS number[] to a Postgres vector literal: '[0.1,0.2,...]'.
 * pgvector accepts this exact text form when inserting via `::vector` cast.
 */
export function formatVectorLiteral(values: number[]): string {
  // pgvector format requires square brackets and comma-separated floats.
  // Use toFixed-free representation to preserve precision.
  return `[${values.join(',')}]`;
}

/** Cosine similarity between two equal-length number arrays. Useful for
 *  client-side ranking when the DB has already returned candidate rows. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingError(`cosineSimilarity: dim mismatch (${a.length} vs ${b.length})`);
  }
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
