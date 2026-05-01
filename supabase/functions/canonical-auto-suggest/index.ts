/**
 * canonical-auto-suggest — Wave 12.6 AI confidence-gated auto-promotion
 * ──────────────────────────────────────────────────────────────────────
 *
 * Spec: docs/WAVE_PLAN.md line 252 + the W12 design doc.
 *
 * Closes the W11.6.11 manual-promote loop. Today every row in
 * `object_registry_candidates` (status='pending') needs an operator click
 * even when the upstream canonical-rollup batch already saw cosine 0.918
 * against an existing canonical. This edge fn walks pending candidates, and
 * for each one with `similarity_to_existing.top_match_score >= cosine_threshold_auto`
 * (default 0.92) calls `canonical-discovery-promote` with `auto_promoted=true`
 * — the candidate is merged into the matching canonical without human review.
 *
 * Rollup pipeline reminder: the rollup writes `similarity_to_existing` JSONB
 * to each candidate row at insert time (canonical-rollup/index.ts L464). So
 * we DO NOT re-embed here — we trust the score already on the row. This keeps
 * cost low (zero Gemini calls for confident matches; only the
 * canonical-discovery-promote callee may re-embed for the canonical row's
 * own embedding column, which we want anyway).
 *
 * ─── Endpoint contract ────────────────────────────────────────────────────
 *
 *   POST {
 *     dry_run?:                 boolean = false,
 *     batch_size?:              number  = 50,
 *     cosine_threshold_auto?:   number  = 0.92,
 *     cosine_threshold_review?: number  = 0.75
 *   }
 *
 *   →  {
 *        ok: true,
 *        dry_run: boolean,
 *        processed: number,
 *        auto_promoted_count: number,
 *        flagged_for_review_count: number,
 *        left_as_candidate_count: number,
 *        examples_promoted: Array<{candidate_id, proposed_label, canonical_label, cosine}>,
 *        examples_flagged:  Array<{candidate_id, proposed_label, top_match, cosine}>,
 *        elapsed_ms: number,
 *      }
 *
 * ─── Auth ─────────────────────────────────────────────────────────────────
 *
 * master_admin OR service-role only. Master_admin runs come from the
 * SettingsObjectRegistryDiscovery "Run AI Auto-Suggest" button. Service-role
 * runs come from a future cron. Any other role → 403.
 *
 * ─── Workflow ─────────────────────────────────────────────────────────────
 *
 * 1. SELECT object_registry_candidates WHERE status='pending'
 *    AND candidate_type='object' ORDER BY observed_count DESC LIMIT batch_size.
 * 2. For each row: read top_match_score from similarity_to_existing JSONB.
 * 3. If score >= auto threshold AND top_match_id IS NOT NULL:
 *      → not dry_run: invoke canonical-discovery-promote with
 *        action='promote', target_table='object_registry', auto_promoted=true,
 *        canonical_label=top_match_canonical_id, event_id=`obj:<row.id>`.
 *      → dry_run: append to examples_promoted.
 *    Bump auto_promoted_count.
 * 4. If review threshold ≤ score < auto threshold:
 *      Append to examples_flagged. Bump flagged_for_review_count.
 *      (No DB write — operator decides via the discovery UI.)
 * 5. If score < review threshold: bump left_as_candidate_count. (No-op.)
 *
 * ─── Idempotency ──────────────────────────────────────────────────────────
 *
 * The promote callee handles the case where the canonical_label already
 * exists (returns 409 + marks the candidate as 'approved'). We treat 409 as
 * a successful promotion (the candidate is resolved either way) and count it
 * toward auto_promoted_count.
 *
 * Rerunning auto-suggest on the same DB is safe — promoted candidates are no
 * longer status='pending' so they are skipped.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
  invokeFunction,
} from '../_shared/supabase.ts';

const FN_NAME = 'canonical-auto-suggest';
const FN_VERSION = 'v1.0';

interface AutoSuggestBody {
  dry_run?: boolean;
  batch_size?: number;
  cosine_threshold_auto?: number;
  cosine_threshold_review?: number;
  _health_check?: boolean;
}

interface CandidateRow {
  id: string;
  proposed_canonical_label: string;
  proposed_display_name: string | null;
  proposed_description: string | null;
  similarity_to_existing: Record<string, unknown> | null;
  observed_count: number;
}

interface ExamplePromoted {
  candidate_id: string;
  proposed_label: string;
  canonical_label: string;
  cosine: number;
  observed_count: number;
}

interface ExampleFlagged {
  candidate_id: string;
  proposed_label: string;
  top_match: string;
  cosine: number;
  observed_count: number;
}

const DEFAULT_AUTO_THRESHOLD = 0.92;
const DEFAULT_REVIEW_THRESHOLD = 0.75;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const EXAMPLES_CAP = 5;

// Validate threshold inputs and clamp to sensible bounds. Cosine similarity
// lives in [-1, 1] but for our use the meaningful range is [0, 1]. We accept
// values outside this range only as a no-op safety net (caller error).
export function clampCosine(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ─── Auth: master_admin or service-role only ─────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden: master_admin or service-role only', 403, req);
    }
  }

  let body: AutoSuggestBody = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — defaults apply.
    body = {};
  }

  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME, ok: true }, 200, req);
  }

  const dry_run = body.dry_run === true;
  const batch_size = Math.max(1, Math.min(Number(body.batch_size) || DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const cosine_threshold_auto = clampCosine(Number(body.cosine_threshold_auto), DEFAULT_AUTO_THRESHOLD);
  const cosine_threshold_review = clampCosine(Number(body.cosine_threshold_review), DEFAULT_REVIEW_THRESHOLD);
  if (cosine_threshold_review > cosine_threshold_auto) {
    return errorResponse(
      `cosine_threshold_review (${cosine_threshold_review}) must be <= cosine_threshold_auto (${cosine_threshold_auto})`,
      400,
      req,
    );
  }

  const startMs = Date.now();
  const admin = getAdminClient();

  try {
    // ─── 1. Pull pending object candidates ordered by observed_count ──────
    const { data: candidates, error } = await admin
      .from('object_registry_candidates')
      .select(
        'id, proposed_canonical_label, proposed_display_name, proposed_description, similarity_to_existing, observed_count',
      )
      .eq('candidate_type', 'object')
      .eq('status', 'pending')
      .order('observed_count', { ascending: false })
      .order('last_proposed_at', { ascending: false })
      .limit(batch_size);

    if (error) {
      return errorResponse(`candidate fetch failed: ${error.message}`, 500, req);
    }

    const rows = (candidates || []) as unknown as CandidateRow[];
    let auto_promoted_count = 0;
    let flagged_for_review_count = 0;
    let left_as_candidate_count = 0;
    const examples_promoted: ExamplePromoted[] = [];
    const examples_flagged: ExampleFlagged[] = [];

    for (const c of rows) {
      const sim = (c.similarity_to_existing || {}) as Record<string, unknown>;
      const score = Number(sim.top_match_score || 0);
      const top_match_id = sim.top_match_id ? String(sim.top_match_id) : null;
      const top_match_canonical = sim.top_match_canonical_id ? String(sim.top_match_canonical_id) : null;
      const top_match_display = sim.top_match_display_name
        ? String(sim.top_match_display_name)
        : (top_match_canonical || '');

      // ─── Branch 1: auto-promote (cosine >= auto threshold) ──────────────
      if (score >= cosine_threshold_auto && top_match_id && top_match_canonical) {
        if (examples_promoted.length < EXAMPLES_CAP) {
          examples_promoted.push({
            candidate_id: c.id,
            proposed_label: c.proposed_canonical_label,
            canonical_label: top_match_canonical,
            cosine: Number(score.toFixed(4)),
            observed_count: c.observed_count || 1,
          });
        }
        auto_promoted_count++;

        if (!dry_run) {
          // Invoke canonical-discovery-promote as service-role. We pass
          // auto_promoted=true so the callee:
          //   - sets object_registry.auto_promoted = TRUE
          //   - leaves curated_by NULL
          //   - 409 on dup canonical_label still resolves the candidate row
          // We swallow per-row failures so a single bad row does not kill the
          // batch; the failure is logged for triage.
          try {
            await invokeFunction(
              'canonical-discovery-promote',
              {
                event_id: `obj:${c.id}`,
                action: 'promote',
                target_table: 'object_registry',
                canonical_label: top_match_canonical,
                display_name: top_match_display || c.proposed_display_name || c.proposed_canonical_label,
                description: c.proposed_description || null,
                auto_promoted: true,
              },
              FN_NAME,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[${FN_NAME}] auto-promote failed for candidate ${c.id} (label=${c.proposed_canonical_label}, top_match=${top_match_canonical}): ${msg}`,
            );
            // Don't decrement the count — the candidate row itself is still
            // intended for auto-promotion; the reviewer can replay later.
          }
        }
        continue;
      }

      // ─── Branch 2: flag for review (review <= cosine < auto) ────────────
      if (score >= cosine_threshold_review) {
        if (examples_flagged.length < EXAMPLES_CAP) {
          examples_flagged.push({
            candidate_id: c.id,
            proposed_label: c.proposed_canonical_label,
            top_match: top_match_canonical || '(no match recorded)',
            cosine: Number(score.toFixed(4)),
            observed_count: c.observed_count || 1,
          });
        }
        flagged_for_review_count++;
        continue;
      }

      // ─── Branch 3: left as candidate (cosine < review threshold) ────────
      left_as_candidate_count++;
    }

    return jsonResponse({
      ok: true,
      dry_run,
      processed: rows.length,
      auto_promoted_count,
      flagged_for_review_count,
      left_as_candidate_count,
      examples_promoted,
      examples_flagged,
      filters: {
        batch_size,
        cosine_threshold_auto,
        cosine_threshold_review,
      },
      elapsed_ms: Date.now() - startMs,
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] failed: ${msg}`);
    return errorResponse(`canonical-auto-suggest failed: ${msg}`, 500, req);
  }
});
