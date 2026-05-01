/**
 * object-registry-admin — Wave 12 master_admin curation edge fn.
 * ──────────────────────────────────────────────────────────────
 *
 * Subcommand router for the discovery-queue review UI. All actions are
 * gated to master_admin (or service_role). Every mutation is recorded with
 * `curated_by` / `reviewed_by` from the caller's user_id.
 *
 * Subcommands (passed via `action` field on POST body):
 *
 *   list_candidates
 *     { status?: 'pending'|'approved'|'rejected'|'merged'|'auto_archived'|'deferred',
 *       candidate_type?: 'object'|'attribute_value',
 *       limit?: number = 50, offset?: number = 0,
 *       sort?: 'observed_count_desc'|'last_proposed_desc'|'first_proposed_asc' = 'observed_count_desc' }
 *     → { candidates: [...], total: number }
 *
 *   approve_candidate
 *     { candidate_id: string,
 *       canonical_id?: string,                  // override the auto-snake_case
 *       display_name?: string,
 *       description?: string,
 *       level_0_class?, level_1_functional?, ..., level_4_detail?,
 *       parent_canonical_id?: string|null,
 *       aliases?: string[],
 *       signal_room_type?: string|null,
 *       signal_confidence?: number|null }
 *     → Inserts into object_registry, flips candidate to 'approved'.
 *
 *   reject_candidate
 *     { candidate_id: string, reason: string }
 *     → Soft-delete: flips to 'rejected', stamps reviewer_notes.
 *
 *   merge_candidates
 *     { candidate_ids: string[], target_canonical_id: string }
 *     → All candidates flipped to 'merged' with merged_into_object_id =
 *       target. observed_count summed onto target's market_frequency.
 *
 *   defer_candidate
 *     { candidate_id: string, days?: number = 7 }
 *     → review_after_at = NOW() + days; status flips to 'deferred'.
 *
 *   auto_archive
 *     {} (no args)
 *     → Sweeps pending candidates with archive_at < NOW() to 'auto_archived'.
 *       Manual-trigger only — Joseph runs this from the UI.
 *
 * Idempotent: re-running approve/reject/merge on an already-finalised
 * candidate returns 409 with a no-op message.
 *
 * Auth: master_admin only. Service-role allowed for cross-fn calls.
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

const FN_NAME = 'object-registry-admin';
const FN_VERSION = 'v1.0';

interface BaseBody {
  action: string;
  _health_check?: boolean;
}

interface ListCandidatesBody extends BaseBody {
  action: 'list_candidates';
  status?: string;
  candidate_type?: string;
  limit?: number;
  offset?: number;
  sort?: 'observed_count_desc' | 'last_proposed_desc' | 'first_proposed_asc';
}

interface ApproveCandidateBody extends BaseBody {
  action: 'approve_candidate';
  candidate_id: string;
  canonical_id?: string;
  display_name?: string;
  description?: string | null;
  level_0_class?: string | null;
  level_1_functional?: string | null;
  level_2_material?: string | null;
  level_3_specific?: string | null;
  level_4_detail?: string | null;
  parent_canonical_id?: string | null;
  aliases?: string[];
  signal_room_type?: string | null;
  signal_confidence?: number | null;
}

interface RejectCandidateBody extends BaseBody {
  action: 'reject_candidate';
  candidate_id: string;
  reason: string;
}

interface MergeCandidatesBody extends BaseBody {
  action: 'merge_candidates';
  candidate_ids: string[];
  target_canonical_id: string;
}

interface DeferCandidateBody extends BaseBody {
  action: 'defer_candidate';
  candidate_id: string;
  days?: number;
}

interface AutoArchiveBody extends BaseBody {
  action: 'auto_archive';
}

interface BackfillEmbeddingsBody extends BaseBody {
  action: 'backfill_embeddings';
  limit?: number;
  /** Embed only canonicals where embedding_vector IS NULL (default true). */
  null_only?: boolean;
}

type AnyBody =
  | ListCandidatesBody
  | ApproveCandidateBody
  | RejectCandidateBody
  | MergeCandidatesBody
  | DeferCandidateBody
  | AutoArchiveBody
  | BackfillEmbeddingsBody;

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
  const reviewerId = isServiceRole ? null : (user?.id || null);

  // ─── Parse body ───────────────────────────────────────────────────────────
  let body: AnyBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME }, 200, req);
  }

  if (!body.action) return errorResponse('action field is required', 400, req);

  const admin = getAdminClient();

  try {
    switch (body.action) {
      case 'list_candidates':
        return await handleList(admin, body as ListCandidatesBody, req);
      case 'approve_candidate':
        return await handleApprove(admin, body as ApproveCandidateBody, reviewerId, req);
      case 'reject_candidate':
        return await handleReject(admin, body as RejectCandidateBody, reviewerId, req);
      case 'merge_candidates':
        return await handleMerge(admin, body as MergeCandidatesBody, reviewerId, req);
      case 'defer_candidate':
        return await handleDefer(admin, body as DeferCandidateBody, reviewerId, req);
      case 'auto_archive':
        return await handleAutoArchive(admin, req);
      case 'backfill_embeddings':
        return await handleBackfillEmbeddings(admin, body as BackfillEmbeddingsBody, req);
      default:
        return errorResponse(`Unknown action: ${(body as BaseBody).action}`, 400, req);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] action ${body.action} failed: ${msg}`);
    return errorResponse(`${body.action} failed: ${msg}`, 500, req);
  }
});

// ─── list_candidates ─────────────────────────────────────────────────────────
async function handleList(
  admin: ReturnType<typeof getAdminClient>,
  body: ListCandidatesBody,
  req: Request,
): Promise<Response> {
  const status = body.status || 'pending';
  const limit = Math.max(1, Math.min(body.limit || 50, 200));
  const offset = Math.max(0, body.offset || 0);
  const sort = body.sort || 'observed_count_desc';

  let query = admin
    .from('object_registry_candidates')
    .select('*', { count: 'exact' })
    .eq('status', status)
    .range(offset, offset + limit - 1);

  if (body.candidate_type) {
    query = query.eq('candidate_type', body.candidate_type);
  }

  if (sort === 'observed_count_desc') {
    query = query.order('observed_count', { ascending: false }).order('last_proposed_at', { ascending: false });
  } else if (sort === 'last_proposed_desc') {
    query = query.order('last_proposed_at', { ascending: false });
  } else {
    query = query.order('first_proposed_at', { ascending: true });
  }

  const { data, error, count } = await query;
  if (error) return errorResponse(`list_candidates failed: ${error.message}`, 500, req);

  return jsonResponse({
    candidates: data || [],
    total: count || 0,
    limit,
    offset,
  }, 200, req);
}

// ─── approve_candidate ───────────────────────────────────────────────────────
async function handleApprove(
  admin: ReturnType<typeof getAdminClient>,
  body: ApproveCandidateBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  if (!body.candidate_id) return errorResponse('candidate_id is required', 400, req);

  // 1. Load candidate
  const { data: candidate, error: loadErr } = await admin
    .from('object_registry_candidates')
    .select('*')
    .eq('id', body.candidate_id)
    .maybeSingle();
  if (loadErr) return errorResponse(`Failed to load candidate: ${loadErr.message}`, 500, req);
  if (!candidate) return errorResponse('Candidate not found', 404, req);
  if (candidate.status !== 'pending' && candidate.status !== 'deferred') {
    return errorResponse(
      `Candidate is in status='${candidate.status}'; cannot approve. (Idempotent guard)`,
      409,
      req,
    );
  }

  if (candidate.candidate_type !== 'object') {
    return errorResponse(
      'attribute_value approval is not yet supported in this fn (use direct SQL or wait for v2)',
      501,
      req,
    );
  }

  // 2. Build the new object_registry row
  const canonicalId = body.canonical_id?.trim() || candidate.proposed_canonical_label;
  const displayName = body.display_name?.trim() || candidate.proposed_display_name || canonicalId;

  const insertPayload: Record<string, unknown> = {
    canonical_id: canonicalId,
    display_name: displayName,
    description: body.description ?? candidate.proposed_description,
    level_0_class: body.level_0_class ?? candidate.proposed_level_0_class,
    level_1_functional: body.level_1_functional ?? candidate.proposed_level_1_functional,
    level_2_material: body.level_2_material ?? candidate.proposed_level_2_material,
    level_3_specific: body.level_3_specific ?? candidate.proposed_level_3_specific,
    level_4_detail: body.level_4_detail ?? candidate.proposed_level_4_detail,
    parent_canonical_id: body.parent_canonical_id ?? null,
    aliases: body.aliases ?? [],
    embedding_vector: candidate.candidate_embedding,    // re-use the embedding from the candidate
    market_frequency: candidate.observed_count || 1,
    signal_room_type: body.signal_room_type ?? null,
    signal_confidence: body.signal_confidence ?? null,
    status: 'canonical',
    is_active: true,
    created_by: reviewerId,
    curated_by: reviewerId,
    curated_at: new Date().toISOString(),
    first_observed_at: candidate.first_proposed_at,
    last_observed_at: new Date().toISOString(),
  };

  const { data: newRow, error: insertErr } = await admin
    .from('object_registry')
    .insert(insertPayload)
    .select('id, canonical_id')
    .single();

  if (insertErr) {
    return errorResponse(`object_registry insert failed: ${insertErr.message}`, 500, req);
  }

  // 3. Mark candidate as approved
  await admin
    .from('object_registry_candidates')
    .update({
      status: 'approved',
      approved_object_id: newRow.id,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', body.candidate_id);

  return jsonResponse({
    candidate_id: body.candidate_id,
    approved_object_id: newRow.id,
    canonical_id: newRow.canonical_id,
    message: `Candidate approved as canonical ${newRow.canonical_id}`,
  }, 200, req);
}

// ─── reject_candidate ────────────────────────────────────────────────────────
async function handleReject(
  admin: ReturnType<typeof getAdminClient>,
  body: RejectCandidateBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  if (!body.candidate_id) return errorResponse('candidate_id is required', 400, req);
  if (!body.reason || body.reason.trim().length < 3) {
    return errorResponse('reason is required (≥3 chars)', 400, req);
  }

  const { data: candidate, error: loadErr } = await admin
    .from('object_registry_candidates')
    .select('id, status')
    .eq('id', body.candidate_id)
    .maybeSingle();
  if (loadErr) return errorResponse(loadErr.message, 500, req);
  if (!candidate) return errorResponse('Candidate not found', 404, req);
  if (candidate.status !== 'pending' && candidate.status !== 'deferred') {
    return errorResponse(`Candidate is already in status='${candidate.status}'`, 409, req);
  }

  const { error } = await admin
    .from('object_registry_candidates')
    .update({
      status: 'rejected',
      reviewer_notes: body.reason,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', body.candidate_id);

  if (error) return errorResponse(`reject failed: ${error.message}`, 500, req);

  return jsonResponse({
    candidate_id: body.candidate_id,
    status: 'rejected',
    message: 'Candidate rejected',
  }, 200, req);
}

// ─── merge_candidates ────────────────────────────────────────────────────────
async function handleMerge(
  admin: ReturnType<typeof getAdminClient>,
  body: MergeCandidatesBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  if (!Array.isArray(body.candidate_ids) || body.candidate_ids.length === 0) {
    return errorResponse('candidate_ids[] is required', 400, req);
  }
  if (!body.target_canonical_id) {
    return errorResponse('target_canonical_id is required', 400, req);
  }

  // 1. Resolve target canonical (accept canonical_id key OR row UUID).
  const isUuid = /^[0-9a-f-]{36}$/i.test(body.target_canonical_id);
  const lookupQ = isUuid
    ? admin.from('object_registry').select('id, canonical_id, market_frequency').eq('id', body.target_canonical_id)
    : admin.from('object_registry').select('id, canonical_id, market_frequency').eq('canonical_id', body.target_canonical_id);

  const { data: target, error: targetErr } = await lookupQ.maybeSingle();
  if (targetErr) return errorResponse(targetErr.message, 500, req);
  if (!target) return errorResponse(`target canonical not found: ${body.target_canonical_id}`, 404, req);

  // 2. Sum observed_count across the candidates we're merging.
  const { data: candidates, error: candErr } = await admin
    .from('object_registry_candidates')
    .select('id, observed_count, status')
    .in('id', body.candidate_ids);
  if (candErr) return errorResponse(candErr.message, 500, req);
  if (!candidates || candidates.length === 0) {
    return errorResponse('No candidates found for merge', 404, req);
  }

  const eligible = candidates.filter((c) => c.status === 'pending' || c.status === 'deferred');
  const observedSum = eligible.reduce((acc, c) => acc + (c.observed_count || 0), 0);

  // 3. Flip each eligible candidate to 'merged'
  const { error: flipErr } = await admin
    .from('object_registry_candidates')
    .update({
      status: 'merged',
      merged_into_object_id: target.id,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .in('id', eligible.map((c) => c.id));
  if (flipErr) return errorResponse(`merge update failed: ${flipErr.message}`, 500, req);

  // 4. Bump target's market_frequency by observedSum
  if (observedSum > 0) {
    await admin
      .from('object_registry')
      .update({
        market_frequency: (target.market_frequency || 0) + observedSum,
        last_observed_at: new Date().toISOString(),
      })
      .eq('id', target.id);
  }

  return jsonResponse({
    target_object_id: target.id,
    target_canonical_id: target.canonical_id,
    merged_count: eligible.length,
    skipped_already_finalised: candidates.length - eligible.length,
    market_frequency_delta: observedSum,
    message: `Merged ${eligible.length} candidate(s) into ${target.canonical_id}`,
  }, 200, req);
}

// ─── defer_candidate ─────────────────────────────────────────────────────────
async function handleDefer(
  admin: ReturnType<typeof getAdminClient>,
  body: DeferCandidateBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  if (!body.candidate_id) return errorResponse('candidate_id is required', 400, req);
  const days = Math.max(1, Math.min(body.days || 7, 90));
  const reviewAfter = new Date(Date.now() + days * 86400 * 1000).toISOString();

  const { data: candidate, error: loadErr } = await admin
    .from('object_registry_candidates')
    .select('id, status')
    .eq('id', body.candidate_id)
    .maybeSingle();
  if (loadErr) return errorResponse(loadErr.message, 500, req);
  if (!candidate) return errorResponse('Candidate not found', 404, req);
  if (candidate.status !== 'pending' && candidate.status !== 'deferred') {
    return errorResponse(`Candidate is in status='${candidate.status}'; cannot defer`, 409, req);
  }

  const { error } = await admin
    .from('object_registry_candidates')
    .update({
      status: 'deferred',
      review_after_at: reviewAfter,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', body.candidate_id);

  if (error) return errorResponse(`defer failed: ${error.message}`, 500, req);

  return jsonResponse({
    candidate_id: body.candidate_id,
    status: 'deferred',
    review_after_at: reviewAfter,
    message: `Candidate deferred for ${days} day(s)`,
  }, 200, req);
}

// ─── backfill_embeddings ─────────────────────────────────────────────────────
// Bootstrap helper: embed canonical rows whose embedding_vector is NULL.
// Builds an embedding text from "display_name + description + level concat +
// aliases" so semantic search has rich context to match against.
async function handleBackfillEmbeddings(
  admin: ReturnType<typeof getAdminClient>,
  body: BackfillEmbeddingsBody,
  req: Request,
): Promise<Response> {
  const limit = Math.max(1, Math.min(body.limit || 50, 500));
  const nullOnly = body.null_only !== false; // default true

  let query = admin
    .from('object_registry')
    .select('id, canonical_id, display_name, description, level_0_class, level_1_functional, level_2_material, level_3_specific, level_4_detail, aliases')
    .eq('status', 'canonical')
    .eq('is_active', true)
    .limit(limit);

  if (nullOnly) {
    query = query.is('embedding_vector', null);
  }

  const { data: rows, error: loadErr } = await query;
  if (loadErr) return errorResponse(`backfill load failed: ${loadErr.message}`, 500, req);
  if (!rows || rows.length === 0) {
    return jsonResponse({
      embedded: 0,
      message: 'No canonical rows with NULL embedding to backfill',
    }, 200, req);
  }

  let embedded = 0;
  const errors: string[] = [];

  for (const row of rows as Array<{ id: string; canonical_id: string; display_name: string; description: string | null; level_0_class: string | null; level_1_functional: string | null; level_2_material: string | null; level_3_specific: string | null; level_4_detail: string | null; aliases: string[] | null }>) {
    const text = composeEmbedText(row);
    try {
      const vec = await embedText(text);
      const literal = formatVectorLiteral(vec);
      const { error: upErr } = await admin
        .from('object_registry')
        .update({ embedding_vector: literal })
        .eq('id', row.id);
      if (upErr) {
        errors.push(`${row.canonical_id}: ${upErr.message}`);
      } else {
        embedded++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${row.canonical_id}: ${msg}`);
    }
  }

  return jsonResponse({
    embedded,
    attempted: rows.length,
    errors,
    message: `Embedded ${embedded}/${rows.length} canonical row(s)`,
  }, 200, req);
}

function composeEmbedText(row: { display_name: string; description: string | null; level_0_class: string | null; level_1_functional: string | null; level_2_material: string | null; level_3_specific: string | null; level_4_detail: string | null; aliases: string[] | null }): string {
  const parts: string[] = [row.display_name];
  if (row.description) parts.push(row.description);
  const levels = [row.level_0_class, row.level_1_functional, row.level_2_material, row.level_3_specific, row.level_4_detail].filter(Boolean);
  if (levels.length > 0) parts.push(levels.join(' / '));
  if (row.aliases && row.aliases.length > 0) parts.push(row.aliases.join(', '));
  return parts.join(' — ');
}

// ─── auto_archive ────────────────────────────────────────────────────────────
async function handleAutoArchive(
  admin: ReturnType<typeof getAdminClient>,
  req: Request,
): Promise<Response> {
  const now = new Date().toISOString();

  // Pending candidates whose archive_at has passed
  const { data: due, error: dueErr } = await admin
    .from('object_registry_candidates')
    .select('id')
    .eq('status', 'pending')
    .lt('archive_at', now);

  if (dueErr) return errorResponse(`auto_archive scan failed: ${dueErr.message}`, 500, req);

  const ids = (due || []).map((r) => r.id);
  if (ids.length === 0) {
    return jsonResponse({
      archived: 0,
      message: 'No pending candidates past archive_at',
    }, 200, req);
  }

  const { error } = await admin
    .from('object_registry_candidates')
    .update({
      status: 'auto_archived',
      reviewer_notes: '[auto] archived by archive sweep',
    })
    .in('id', ids);

  if (error) return errorResponse(`auto_archive update failed: ${error.message}`, 500, req);

  return jsonResponse({
    archived: ids.length,
    message: `Archived ${ids.length} candidate(s) past archive_at`,
  }, 200, req);
}
