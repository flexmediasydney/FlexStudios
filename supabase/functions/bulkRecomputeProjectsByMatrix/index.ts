// bulkRecomputeProjectsByMatrix — admin flow to recompute every project
// pinned to any version of a given price matrix after that matrix is edited.
//
// CONTEXT (Phase 3 pricing versioning):
//   Each project has `price_matrix_version_id` → price_matrix_versions(id).
//   When an admin edits a matrix, the trigger (migration 206) archives the
//   PRE-change state as a new version row and marks prior rows superseded.
//   Existing projects KEEP their old calculated_price (snapshot-wins) and
//   their old FK — they don't auto-reprice. This function is the admin
//   escape hatch to bring them onto the current matrix version.
//
// Flow:
//   1. Resolve every version_id that belongs to this matrix_id (current +
//      superseded) — any project pinned to any of them is "affected".
//   2. Load active projects whose price_matrix_version_id is in that set.
//   3. For each: invoke calculateProjectPricing (pure, no writes) with the
//      project's stored products/packages/agent/discount. Build a preview
//      row: { old_price, new_price, delta, pricing_locked_at, would_update }.
//   4. If dry_run=true: return preview only.
//   5. If dry_run=false: for each non-skipped project invoke
//      recalculateProjectPricingServerSide — that's the shared single-write
//      path used elsewhere; it handles the DB update + notifications +
//      task sync chain. We don't duplicate that logic here.
//   6. Write one summary row to price_matrix_audit_logs so the matrix's
//      existing audit feed reflects the bulk event.
//
// Locked projects (`pricing_locked_at` non-null) are SKIPPED by default. Pass
// `force_locked=true` to override — not wired into v1 UI; reserved for
// future admin escape hatch when a refund requires re-billing.

import {
  getAdminClient,
  getUserFromReq,
  createEntities,
  invokeFunction,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

interface PreviewRow {
  project_id: string;
  title: string;
  status: string;
  payment_status: string | null;
  old_price: number;
  new_price: number;
  delta: number;
  pricing_locked_at: string | null;
  would_update: boolean;
  skip_reason?: string;
  error?: string;
}

function round(n: number) {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

serveWithAudit('bulkRecomputeProjectsByMatrix', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    const body = await req.json().catch(() => ({} as any));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: 'bulkRecomputeProjectsByMatrix', _ts: '2026-04-20' });
    }

    // Auth gate — admin-or-above only.
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);
    const isServiceRole = user.id === '__service_role__';
    const isAdmin = ['master_admin', 'admin'].includes(user.role);
    if (!isServiceRole && !isAdmin) {
      return errorResponse('Forbidden: admin access required', 403, req);
    }

    const { matrix_id, dry_run = true, force_locked = false } = body as {
      matrix_id?: string;
      dry_run?: boolean;
      force_locked?: boolean;
    };
    if (!matrix_id) return errorResponse('matrix_id required', 400, req);

    // ─── 1. Resolve all version_ids for this matrix (current + superseded) ─
    const { data: versions, error: versionsErr } = await admin
      .from('price_matrix_versions')
      .select('id, superseded_at')
      .eq('matrix_id', matrix_id);

    if (versionsErr) {
      return errorResponse(`Failed to load matrix versions: ${versionsErr.message}`, 500, req);
    }
    if (!versions || versions.length === 0) {
      return jsonResponse({
        success: true,
        matrix_id,
        dry_run,
        results: [],
        summary: { total: 0, will_update: 0, unchanged: 0, locked_skipped: 0, errors: 0, total_delta: 0 },
      });
    }

    const versionIds = versions.map(v => v.id);
    const currentVersionId = versions.find(v => !v.superseded_at)?.id || null;

    // ─── 2. Load affected active projects ─────────────────────────────────
    const { data: projects, error: projectsErr } = await admin
      .from('projects')
      .select('id, title, property_address, calculated_price, price_matrix_version_id, pricing_locked_at, status, payment_status, products, packages, agent_id, agency_id, pricing_tier, project_type_id, discount_type, discount_value, discount_mode, is_archived')
      .in('price_matrix_version_id', versionIds)
      .eq('is_archived', false);

    if (projectsErr) {
      return errorResponse(`Failed to load affected projects: ${projectsErr.message}`, 500, req);
    }

    const affected = projects || [];
    if (affected.length === 0) {
      return jsonResponse({
        success: true,
        matrix_id,
        dry_run,
        results: [],
        summary: { total: 0, will_update: 0, unchanged: 0, locked_skipped: 0, errors: 0, total_delta: 0 },
      });
    }

    // ─── 3. Dry-run: compute new prices without writing ───────────────────
    const results: PreviewRow[] = [];
    for (const p of affected) {
      const oldPrice = Number(p.calculated_price || 0);
      const title = p.title || p.property_address || '(untitled)';
      const locked = !!p.pricing_locked_at;
      const skipForLock = locked && !force_locked;

      // Even locked projects get the dry-run preview so the admin sees what
      // WOULD change — the skip_reason flag communicates they won't be
      // touched unless force_locked is set.
      const hasItems = (p.products?.length || 0) > 0 || (p.packages?.length || 0) > 0;
      if (!hasItems) {
        results.push({
          project_id: p.id,
          title,
          status: p.status || '',
          payment_status: p.payment_status || null,
          old_price: oldPrice,
          new_price: oldPrice,
          delta: 0,
          pricing_locked_at: p.pricing_locked_at,
          would_update: false,
          skip_reason: 'no_products_or_packages',
        });
        continue;
      }

      try {
        const calc: any = await invokeFunction('calculateProjectPricing', {
          agent_id: p.agent_id || null,
          agency_id: p.agency_id || null,
          products: p.products || [],
          packages: p.packages || [],
          pricing_tier: p.pricing_tier || 'standard',
          project_type_id: p.project_type_id || null,
          discount_type: p.discount_type || 'fixed',
          discount_value: p.discount_value || 0,
          discount_mode: p.discount_mode || 'discount',
        }, 'bulkRecomputeProjectsByMatrix');

        const newPriceRaw = Number(calc?.calculated_price);
        if (!calc?.success || !Number.isFinite(newPriceRaw)) {
          results.push({
            project_id: p.id,
            title,
            status: p.status || '',
            payment_status: p.payment_status || null,
            old_price: oldPrice,
            new_price: oldPrice,
            delta: 0,
            pricing_locked_at: p.pricing_locked_at,
            would_update: false,
            error: 'pricing_calc_failed',
            skip_reason: 'pricing_calc_failed',
          });
          continue;
        }

        const newPrice = Math.max(0, newPriceRaw);
        const delta = round(newPrice - oldPrice);
        const changed = Math.abs(delta) >= 0.5; // engine rounds to nearest $1 but we keep cents-safe
        const wouldUpdate = changed && !skipForLock;

        const row: PreviewRow = {
          project_id: p.id,
          title,
          status: p.status || '',
          payment_status: p.payment_status || null,
          old_price: round(oldPrice),
          new_price: round(newPrice),
          delta,
          pricing_locked_at: p.pricing_locked_at,
          would_update: wouldUpdate,
        };
        if (skipForLock) row.skip_reason = 'locked';
        else if (!changed) row.skip_reason = 'unchanged';
        results.push(row);
      } catch (err: any) {
        results.push({
          project_id: p.id,
          title,
          status: p.status || '',
          payment_status: p.payment_status || null,
          old_price: oldPrice,
          new_price: oldPrice,
          delta: 0,
          pricing_locked_at: p.pricing_locked_at,
          would_update: false,
          error: err?.message || 'unknown_error',
          skip_reason: 'error',
        });
      }
    }

    // ─── 4. Compute summary ───────────────────────────────────────────────
    const willUpdate = results.filter(r => r.would_update);
    const lockedSkipped = results.filter(r => r.skip_reason === 'locked').length;
    const unchanged = results.filter(r => r.skip_reason === 'unchanged').length;
    const errored = results.filter(r => r.error).length;
    const totalDelta = round(willUpdate.reduce((s, r) => s + r.delta, 0));

    const summary = {
      total: results.length,
      will_update: willUpdate.length,
      unchanged,
      locked_skipped: lockedSkipped,
      errors: errored,
      total_delta: totalDelta,
    };

    if (dry_run) {
      return jsonResponse({ success: true, matrix_id, dry_run: true, results, summary });
    }

    // ─── 5. Real batch: write via recalculateProjectPricingServerSide ─────
    // We delegate to the existing single-project recompute function so the
    // full chain (price write + version pin + ProjectActivity + task sync)
    // fires per project without duplicating logic here. Small 100ms stagger
    // between calls to avoid hammering the engine.
    const applyResults: Array<{ project_id: string; success: boolean; error?: string }> = [];
    for (const r of willUpdate) {
      try {
        await invokeFunction(
          'recalculateProjectPricingServerSide',
          { project_id: r.project_id },
          'bulkRecomputeProjectsByMatrix',
        );
        applyResults.push({ project_id: r.project_id, success: true });
      } catch (err: any) {
        applyResults.push({ project_id: r.project_id, success: false, error: err?.message || 'unknown_error' });
      }
      await new Promise(res => setTimeout(res, 100));
    }

    const applied = applyResults.filter(r => r.success).length;
    const applyFailed = applyResults.filter(r => !r.success).length;

    // ─── 6. Summary row on price_matrix_audit_logs ────────────────────────
    // Table schema (migration 001): price_matrix_id, entity_type, entity_id,
    // entity_name, action, changed_fields (jsonb), previous_state (jsonb),
    // new_state (jsonb), user_name, user_email, timestamp.
    try {
      // Pull the matrix row once to denormalize entity info onto the audit row.
      const { data: matrixRow } = await admin
        .from('price_matrices')
        .select('entity_type, entity_id, entity_name')
        .eq('id', matrix_id)
        .maybeSingle();

      // Build a human-readable summary consistent with logPriceMatrixChange
      // so the existing PriceMatrixAuditLog UI renders a clean line.
      const deltaLabel = totalDelta === 0 ? '$0' : `${totalDelta < 0 ? '−' : '+'}$${Math.abs(Math.round(totalDelta)).toLocaleString()}`;
      const changesSummary =
        `Bulk recomputed pricing for ${applied} project${applied === 1 ? '' : 's'}` +
        (lockedSkipped ? `, skipped ${lockedSkipped} locked` : '') +
        (unchanged ? `, ${unchanged} unchanged` : '') +
        (applyFailed ? `, ${applyFailed} failed` : '') +
        ` · net ${deltaLabel}`;

      await admin.from('price_matrix_audit_logs').insert({
        price_matrix_id: matrix_id,
        entity_type: matrixRow?.entity_type || null,
        entity_id: matrixRow?.entity_id || null,
        entity_name: matrixRow?.entity_name || null,
        action: 'bulk_project_recompute',
        changed_fields: [{
          field: 'bulk_recompute',
          projects_updated: applied,
          projects_skipped: lockedSkipped + unchanged,
          projects_failed: applyFailed,
          total_price_delta: totalDelta,
          force_locked,
        }],
        changes_summary: changesSummary,
        affected_projects_count: applied,
        previous_state: { current_version_id: currentVersionId, affected_versions: versionIds.length },
        new_state: {
          applied_to: applyResults.filter(r => r.success).map(r => r.project_id),
          failed: applyResults.filter(r => !r.success),
        },
        user_name: user.full_name || 'Admin',
        user_email: user.email || null,
        timestamp: new Date().toISOString(),
      });
    } catch (auditErr: any) {
      // Audit failure is non-fatal — the real work already succeeded.
      console.warn('bulkRecompute audit log failed:', auditErr?.message);
    }

    return jsonResponse({
      success: true,
      matrix_id,
      dry_run: false,
      results,
      summary: {
        ...summary,
        applied,
        apply_failed: applyFailed,
      },
      apply_results: applyResults,
    });
  } catch (error: any) {
    console.error('bulkRecomputeProjectsByMatrix error:', error);
    return errorResponse(error.message);
  }
});
