/**
 * round-engine-controls
 * ─────────────────────
 * Wave 11.7.7 — operator UX edge fn for per-round engine controls (engine_mode
 * + voice tier overrides) on the round detail page banner.
 *
 * Spec: docs/design-specs/W11-7-7-master-listing-copy.md §"Master_admin
 *       re-generation flow", §"Open question Q1: Tier-mismatch override flow"
 *       docs/design-specs/W11-7-8-voice-tier-modulation.md §"Tier selection"
 *
 * Lets master_admin tweak shortlisting_rounds.engine_mode +
 * shortlisting_rounds.property_tier + shortlisting_rounds.property_voice_anchor_override
 * for an individual round. These changes do NOT trigger reprocessing on
 * their own — the operator follows up with a regenerate-master-listing
 * call (or, for engine_mode, re-runs the round via shortlisting-ingest).
 *
 * Auth: master_admin only (per-round engine mutation is a privileged op).
 *
 * POST body:
 *   { round_id: string,
 *     engine_mode?: 'shape_d_full' | 'two_pass',
 *     property_tier?: 'premium' | 'standard' | 'approachable',
 *     property_voice_anchor_override?: string | null  // null clears the override
 *   }
 *
 * Response:
 *   { ok: true, round: <updated row> }
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'round-engine-controls';

const ALLOWED_ENGINE_MODES = new Set([
  'shape_d_full',
  'two_pass',
]);
const ALLOWED_TIERS = new Set(['premium', 'standard', 'approachable']);
const VOICE_ANCHOR_MAX_CHARS = 2000;

interface ReqBody {
  round_id?: string;
  engine_mode?: string;
  property_tier?: string;
  property_voice_anchor_override?: string | null;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden — master_admin only', 403, req);
    }
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('JSON body required', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id;
  if (!roundId || typeof roundId !== 'string') {
    return errorResponse('round_id required', 400, req);
  }

  // Build the patch only with the fields the caller actually set.
  const patch: Record<string, unknown> = {};
  let touched = false;

  if (body.engine_mode !== undefined) {
    if (!ALLOWED_ENGINE_MODES.has(body.engine_mode)) {
      return errorResponse(
        `engine_mode must be one of: ${Array.from(ALLOWED_ENGINE_MODES).join(', ')}`,
        400,
        req,
      );
    }
    patch.engine_mode = body.engine_mode;
    touched = true;
  }

  if (body.property_tier !== undefined) {
    if (!ALLOWED_TIERS.has(body.property_tier)) {
      return errorResponse(
        `property_tier must be one of: ${Array.from(ALLOWED_TIERS).join(', ')}`,
        400,
        req,
      );
    }
    patch.property_tier = body.property_tier;
    touched = true;
  }

  if (body.property_voice_anchor_override !== undefined) {
    if (body.property_voice_anchor_override === null) {
      patch.property_voice_anchor_override = null;
    } else if (typeof body.property_voice_anchor_override !== 'string') {
      return errorResponse('property_voice_anchor_override must be string or null', 400, req);
    } else if (body.property_voice_anchor_override.length > VOICE_ANCHOR_MAX_CHARS) {
      return errorResponse(
        `property_voice_anchor_override too long (${body.property_voice_anchor_override.length} > ${VOICE_ANCHOR_MAX_CHARS} chars)`,
        400,
        req,
      );
    } else {
      patch.property_voice_anchor_override = body.property_voice_anchor_override;
    }
    touched = true;
  }

  if (!touched) {
    return errorResponse('No engine controls supplied (need engine_mode, property_tier, or property_voice_anchor_override)', 400, req);
  }

  const admin = getAdminClient();

  const { data: round, error: updErr } = await admin
    .from('shortlisting_rounds')
    .update(patch)
    .eq('id', roundId)
    .select(
      'id, project_id, round_number, status, engine_mode, property_tier, ' +
      'property_voice_anchor_override, package_type, created_at, updated_at',
    )
    .maybeSingle();
  if (updErr) {
    return errorResponse(`round update failed: ${updErr.message}`, 500, req);
  }
  if (!round) {
    return errorResponse(`round ${roundId} not found`, 404, req);
  }

  return jsonResponse({ ok: true, round, patched: Object.keys(patch) }, 200, req);
});
