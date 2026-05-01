/**
 * master-listing-edit
 * ───────────────────
 * Wave 11.7.7 — operator UX edge fn for saving in-place edits to the
 * Stage 4 master_listing JSONB on shortlisting_master_listings.
 *
 * Spec: docs/design-specs/W11-7-7-master-listing-copy.md §"Master_admin
 *       re-generation flow" + §"Copywriter human-edit storage" Q2.
 *
 * Does two things atomically per request:
 *   1. Writes a per-field audit row to shortlisting_master_listings_human_edits
 *      capturing (field, prior_value, new_value, edited_by, edit_reason).
 *   2. Writes the new value into shortlisting_master_listings.master_listing
 *      JSONB at the field path.
 *
 * Both writes are independent UPDATEs (Supabase JS client doesn't expose
 * transactions), so a partial failure is possible: if the audit INSERT
 * succeeds and the master UPDATE fails, the audit trail records an "edit"
 * that didn't actually persist. We treat this as an acceptable degradation
 * because (a) the audit row is recoverable (operator can retry), (b) we'd
 * rather have a recoverable orphan audit row than a silent edit with no
 * trail.
 *
 * Auth: master_admin or admin.
 *
 * POST body (single edit):
 *   { master_listing_id: string, field: string, prior_value: any,
 *     new_value: any, edit_reason?: string }
 *
 * POST body (batch edits):
 *   { master_listing_id: string, edits: Array<{ field, prior_value,
 *     new_value, edit_reason? }> }
 *
 * Response:
 *   { ok: true, master_listing: <updated row>, audit_rows: <count> }
 *
 * Field paths supported (top-level keys on the master_listing JSON):
 *   - headline | sub_headline
 *   - scene_setting_paragraph | interior_paragraph | lifestyle_paragraph |
 *     closing_paragraph
 *   - key_features (TEXT[])
 *   - location_paragraph | target_buyer_summary
 *   - seo_meta_description | social_post_caption | print_brochure_summary |
 *     agent_one_liner | open_home_email_blurb
 *
 * Soft-validation (warns, does NOT reject):
 *   - word_count out of tier band → flagged in response.warnings[]
 *   - forbidden phrase hit → flagged
 *   - exclamation mark in body → flagged
 *
 * Errors:
 *   400 → bad request body
 *   401 → unauthenticated
 *   403 → not master_admin/admin
 *   404 → master_listing_id not found
 *   500 → DB error
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'master-listing-edit';

// Allowed top-level fields on the master_listing JSON. Anything else is
// rejected — keeps operators from accidentally writing into nested
// editorial-metadata fields like word_count_computed which the engine
// recomputes downstream.
const ALLOWED_FIELDS = new Set([
  'headline',
  'sub_headline',
  'scene_setting_paragraph',
  'interior_paragraph',
  'lifestyle_paragraph',
  'closing_paragraph',
  'key_features',
  'location_paragraph',
  'target_buyer_summary',
  'seo_meta_description',
  'social_post_caption',
  'print_brochure_summary',
  'agent_one_liner',
  'open_home_email_blurb',
  'tone_anchor',
]);

// Forbidden phrase regex array (W11.7.7 §"Layer 2 — post-emission automated
// validators"). Soft warnings only; the operator may have a legitimate use
// for "stunning" if they're hand-editing.
const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'stunning', re: /\bstunning\b/i },
  { name: 'must_inspect', re: /\bmust inspect\b/i },
  { name: 'dont_miss', re: /don['']t miss/i },
  { name: 'modern_living', re: /\bmodern living\b/i },
  { name: 'boasts', re: /\bboasts\b/i },
  { name: 'nestled', re: /\bnestled\b/i },
  { name: 'prime_location', re: /\bprime location\b/i },
];

// Tier-keyed word-count bands (body paragraphs). W11.7.8.
const TIER_WORD_COUNT_BANDS: Record<string, [number, number]> = {
  premium: [700, 1000],
  standard: [500, 750],
  approachable: [350, 500],
};

interface SingleEdit {
  field: string;
  prior_value: unknown;
  new_value: unknown;
  edit_reason?: string;
}

interface SingleEditBody extends SingleEdit {
  master_listing_id: string;
}

interface BatchEditBody {
  master_listing_id: string;
  edits: SingleEdit[];
}

type RequestBody = SingleEditBody | BatchEditBody | { _health_check?: boolean };

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden — master_admin or admin only', 403, req);
    }
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('JSON body required', 400, req);
  }
  if ((body as { _health_check?: boolean })._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const masterListingId = (body as { master_listing_id?: string }).master_listing_id;
  if (!masterListingId || typeof masterListingId !== 'string') {
    return errorResponse('master_listing_id required', 400, req);
  }

  // Normalise to batch shape.
  let edits: SingleEdit[];
  if ('edits' in body && Array.isArray(body.edits)) {
    edits = body.edits;
  } else if ('field' in body && (body as SingleEditBody).field) {
    edits = [{
      field: (body as SingleEditBody).field,
      prior_value: (body as SingleEditBody).prior_value,
      new_value: (body as SingleEditBody).new_value,
      edit_reason: (body as SingleEditBody).edit_reason,
    }];
  } else {
    return errorResponse('Either {field, new_value} or {edits: [...]} required', 400, req);
  }

  if (edits.length === 0) {
    return errorResponse('At least one edit required', 400, req);
  }
  if (edits.length > 30) {
    return errorResponse('Max 30 edits per batch', 400, req);
  }

  // Validate every edit's field name before any writes.
  for (const e of edits) {
    if (!e.field || typeof e.field !== 'string') {
      return errorResponse('Each edit needs a string field name', 400, req);
    }
    if (!ALLOWED_FIELDS.has(e.field)) {
      return errorResponse(
        `field "${e.field}" not editable — allowed: ${Array.from(ALLOWED_FIELDS).join(', ')}`,
        400,
        req,
      );
    }
  }

  const admin = getAdminClient();

  // Load the current master_listing row.
  const { data: row, error: loadErr } = await admin
    .from('shortlisting_master_listings')
    .select('id, master_listing, property_tier, regeneration_count, deleted_at')
    .eq('id', masterListingId)
    .maybeSingle();
  if (loadErr) return errorResponse(`load failed: ${loadErr.message}`, 500, req);
  if (!row) return errorResponse(`master_listing_id ${masterListingId} not found`, 404, req);
  if (row.deleted_at) return errorResponse(`master_listing is soft-deleted`, 400, req);

  // Apply edits to a working copy of the master_listing JSONB.
  const masterListing = (row.master_listing && typeof row.master_listing === 'object')
    ? { ...(row.master_listing as Record<string, unknown>) }
    : {};

  const editorId = isService ? null : user!.id;
  const auditRows: Array<Record<string, unknown>> = [];

  for (const e of edits) {
    masterListing[e.field] = e.new_value;
    auditRows.push({
      master_listing_id: masterListingId,
      field: e.field,
      prior_value: stringifyForAudit(e.prior_value),
      new_value: stringifyForAudit(e.new_value),
      edited_by: editorId,
      edit_reason: e.edit_reason ?? null,
    });
  }

  // Recompute editorial metadata that downstream cares about — word_count
  // is the cheap one. Reading-grade computation is downstream's job (the
  // shortlisting-quality-checks edge fn in Agent 1's domain).
  const recomputedWordCount = computeWordCount(masterListing);
  if (typeof recomputedWordCount === 'number') {
    masterListing.word_count = recomputedWordCount;
  }

  // Soft-validate against tier band + forbidden patterns.
  const warnings: string[] = [];
  const tier = (row.property_tier || 'standard') as string;
  const band = TIER_WORD_COUNT_BANDS[tier];
  if (band && typeof recomputedWordCount === 'number') {
    const [lo, hi] = band;
    if (recomputedWordCount < lo) {
      warnings.push(`Word count ${recomputedWordCount} below ${tier} band [${lo}-${hi}]`);
    } else if (recomputedWordCount > hi) {
      warnings.push(`Word count ${recomputedWordCount} above ${tier} band [${lo}-${hi}]`);
    }
  }

  const fullText = collectBodyText(masterListing);
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    if (re.test(fullText)) {
      warnings.push(`Forbidden phrase "${name}" present in edited body`);
    }
  }
  const exclamationCount = (fullText.match(/!/g) || []).length;
  if (exclamationCount > 0) {
    warnings.push(`${exclamationCount} exclamation mark(s) in body — zero-tolerance per tier rubric`);
  }

  // 1. Insert audit rows.
  const { error: auditErr } = await admin
    .from('shortlisting_master_listings_human_edits')
    .insert(auditRows);
  if (auditErr) {
    // Audit failure is fatal — we never want a silent edit with no trail.
    return errorResponse(
      `human_edits audit insert failed: ${auditErr.message}`,
      500,
      req,
    );
  }

  // 2. Update the master_listing JSONB.
  const nowIso = new Date().toISOString();
  const { data: updated, error: updateErr } = await admin
    .from('shortlisting_master_listings')
    .update({
      master_listing: masterListing,
      word_count: recomputedWordCount ?? null,
      updated_at: nowIso,
    })
    .eq('id', masterListingId)
    .select('id, round_id, master_listing, property_tier, word_count, ' +
            'word_count_computed, reading_grade_level, reading_grade_level_computed, ' +
            'forbidden_phrase_hits, quality_flags, regeneration_count, ' +
            'created_at, updated_at')
    .maybeSingle();
  if (updateErr) {
    return errorResponse(`master_listing update failed: ${updateErr.message}`, 500, req);
  }

  return jsonResponse(
    {
      ok: true,
      master_listing: updated,
      audit_rows: auditRows.length,
      warnings,
    },
    200,
    req,
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringifyForAudit(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.length > 10000 ? v.slice(0, 10000) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 10000 ? s.slice(0, 10000) + '…' : s;
  } catch {
    return String(v).slice(0, 10000);
  }
}

function computeWordCount(ml: Record<string, unknown>): number | null {
  const fields = [
    'headline',
    'sub_headline',
    'scene_setting_paragraph',
    'interior_paragraph',
    'lifestyle_paragraph',
    'closing_paragraph',
    'location_paragraph',
    'target_buyer_summary',
  ];
  let total = 0;
  for (const f of fields) {
    const v = ml[f];
    if (typeof v === 'string' && v.trim()) {
      total += v.trim().split(/\s+/).filter(Boolean).length;
    }
  }
  // key_features is an array of strings
  const kf = ml.key_features;
  if (Array.isArray(kf)) {
    for (const item of kf) {
      if (typeof item === 'string' && item.trim()) {
        total += item.trim().split(/\s+/).filter(Boolean).length;
      }
    }
  }
  return total > 0 ? total : null;
}

function collectBodyText(ml: Record<string, unknown>): string {
  const parts: string[] = [];
  const stringFields = [
    'headline', 'sub_headline',
    'scene_setting_paragraph', 'interior_paragraph',
    'lifestyle_paragraph', 'closing_paragraph',
    'location_paragraph', 'target_buyer_summary',
    'seo_meta_description', 'social_post_caption',
    'print_brochure_summary', 'agent_one_liner',
    'open_home_email_blurb',
  ];
  for (const f of stringFields) {
    const v = ml[f];
    if (typeof v === 'string') parts.push(v);
  }
  const kf = ml.key_features;
  if (Array.isArray(kf)) {
    for (const item of kf) {
      if (typeof item === 'string') parts.push(item);
    }
  }
  return parts.join(' ');
}
