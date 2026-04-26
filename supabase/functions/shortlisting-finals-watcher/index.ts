/**
 * shortlisting-finals-watcher
 * ────────────────────────────
 * Editor-finals delivery → variant_count tracker.
 *
 * Background: when an editor delivers a final to Photos/Finals/, the filename
 * suffix encodes how many variants the editor produced for the same
 * composition. Per spec §14, more variants = stronger training signal:
 *
 *   KELV4091.jpg          → variant 1 (base)
 *   KELV4091-2.jpg        → variant 2 (second variant of same composition)
 *   KELV4091-2-2.jpg      → variant 3
 *   KELV4091-staged.jpg   → variant 1 (suffix doesn't match -N pattern)
 *
 * For each stem, the watcher counts the maximum variant index seen and
 * UPDATEs shortlisting_training_examples.variant_count + recomputes weight:
 *
 *   weight = 1.0 + 0.2 * (variant_count - 1) + (was_override ? 0.3 : 0)
 *
 * Invoked by dropbox-webhook (B5) after every webhook delta when files in
 * photos_finals or photos_editors_final_enriched get added.
 *
 * POST { project_id: string, file_paths: string[] }
 *
 * Auth: master_admin / admin / manager OR service_role.
 *
 * If a stem has no matching training_example row, log a warning and skip —
 * don't throw. Possible reasons:
 *   - Finals delivered before training extractor ran (race)
 *   - Filename doesn't match any composition in training_examples
 *   - Editor used a non-conventional name
 *
 * Response: { ok: true, stems_updated, total_variants, skipped }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'shortlisting-finals-watcher';

interface RequestBody {
  project_id?: string;
  file_paths?: string[];
  _health_check?: boolean;
}

// Suffix is one or more `-\d+` segments (e.g. -2, -2-2, -2-2-3). Anything
// else (e.g. `-staged`, `-final`) is NOT a variant indicator — treat as base.
const FINAL_FILENAME_RE =
  /^(?<stem>.+?)(?<suffix>(?:-\d+)+)?\.(?:jpg|jpeg|png|webp)$/i;

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse(
        'Forbidden — only master_admin/admin/manager can update training weights',
        403,
        req,
      );
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = body.project_id?.trim();
  const filePaths = Array.isArray(body.file_paths) ? body.file_paths : [];
  if (!projectId) return errorResponse('project_id required', 400, req);

  const admin = getAdminClient();

  // ── Parse filenames into (stem, variantIndex) pairs ─────────────────────
  // For each path, extract just the basename, strip the extension, and count
  // `-\d+` suffix segments. Track max variant index per stem.
  const variantsByStem = new Map<string, number>();
  let unparsed = 0;
  for (const path of filePaths) {
    if (!path) continue;
    const basename = String(path).split('/').pop() || '';
    const m = basename.match(FINAL_FILENAME_RE);
    if (!m) {
      unparsed++;
      continue;
    }
    const stem = m.groups?.stem || '';
    if (!stem) {
      unparsed++;
      continue;
    }
    const suffix = m.groups?.suffix || '';
    const segCount = suffix
      ? suffix.split('-').filter((s) => /^\d+$/.test(s)).length
      : 0;
    const variantIndex = segCount + 1; // no suffix = variant 1
    const cur = variantsByStem.get(stem) || 0;
    if (variantIndex > cur) variantsByStem.set(stem, variantIndex);
  }

  if (variantsByStem.size === 0) {
    return jsonResponse(
      {
        ok: true,
        project_id: projectId,
        stems_updated: 0,
        total_variants: 0,
        skipped: filePaths.length,
        unparsed,
      },
      200,
      req,
    );
  }

  // ── For each stem, look up matching training_examples and update ────────
  // We update in a per-stem loop because the weight formula depends on the
  // existing was_override value, and only update if the new variant_count is
  // greater than the stored value (GREATEST behaviour).
  let stemsUpdated = 0;
  let totalVariants = 0;
  let skippedNoMatch = 0;
  const stemsBumpedDetail: Array<{ stem: string; variant_count: number; rows: number }> = [];

  for (const [stem, newCount] of variantsByStem) {
    // Look up existing rows. There may be multiple rows for the same stem
    // (one per round if the editor delivered finals across re-shoots).
    const { data: rows, error: selErr } = await admin
      .from('shortlisting_training_examples')
      .select('id, variant_count, was_override, weight')
      .eq('delivery_reference_stem', stem);
    if (selErr) {
      console.warn(`[${GENERATOR}] select failed for stem='${stem}': ${selErr.message}`);
      continue;
    }
    if (!rows || rows.length === 0) {
      skippedNoMatch++;
      console.info(
        `[${GENERATOR}] no training_example match for stem='${stem}' (variant_count=${newCount}) — skipping`,
      );
      continue;
    }

    let bumpedThisStem = 0;
    for (const row of rows) {
      const cur = (row.variant_count as number | null) ?? 1;
      if (newCount <= cur) continue; // GREATEST — never decrement
      const wasOverride = (row.was_override as boolean | null) === true;
      const newWeight = roundWeight(
        1.0 + 0.2 * (newCount - 1) + (wasOverride ? 0.3 : 0),
      );
      const { error: updErr } = await admin
        .from('shortlisting_training_examples')
        .update({
          variant_count: newCount,
          weight: newWeight,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (updErr) {
        console.warn(
          `[${GENERATOR}] update failed for id=${row.id}: ${updErr.message}`,
        );
        continue;
      }
      bumpedThisStem++;
    }

    if (bumpedThisStem > 0) {
      stemsUpdated++;
      totalVariants += newCount;
      stemsBumpedDetail.push({ stem, variant_count: newCount, rows: bumpedThisStem });
    }
  }

  // ── Audit event ────────────────────────────────────────────────────────
  await admin.from('shortlisting_events').insert({
    project_id: projectId,
    round_id: null, // span multiple rounds — payload carries the stem detail
    event_type: 'variant_count_updated',
    actor_type: isService ? 'system' : 'user',
    actor_id: isService ? null : (user?.id ?? null),
    payload: {
      stems_updated: stemsUpdated,
      total_variants: totalVariants,
      skipped_no_match: skippedNoMatch,
      unparsed,
      file_count: filePaths.length,
      stems_sample: stemsBumpedDetail.slice(0, 10),
    },
  });

  return jsonResponse(
    {
      ok: true,
      project_id: projectId,
      stems_updated: stemsUpdated,
      total_variants: totalVariants,
      skipped: skippedNoMatch,
      unparsed,
    },
    200,
    req,
  );
});

function roundWeight(n: number): number {
  return Math.round(n * 1000) / 1000;
}
