import { getAdminClient, getUserFromReq, createEntities, invokeFunction, handleCors, jsonResponse, errorResponse, isQuietHours, serveWithAudit } from '../_shared/supabase.ts';

async function _canNotify(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    if (await isQuietHours(userId)) return false;
    const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 50);
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

serveWithAudit('recalculateProjectPricingServerSide', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'recalculateProjectPricingServerSide', _ts: '2026-03-17' });
    }

    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const { project_id } = body;
    if (!project_id) return errorResponse('project_id required', 400);

    const project = await entities.Project.get(project_id);
    if (!project) return errorResponse('Project not found', 404);

    const products = project.products || [];
    const packages = project.packages || [];

    if (products.length === 0 && packages.length === 0) {
      return jsonResponse({ success: true, skipped: true, reason: 'no products or packages' });
    }

    let calcResult: any = null;
    try {
      calcResult = await invokeFunction('calculateProjectPricing', {
        agent_id: project.agent_id || null,
        agency_id: project.agency_id || null,
        products, packages,
        pricing_tier: project.pricing_tier || 'standard',
        project_type_id: project.project_type_id || null,
        discount_type: project.discount_type || 'fixed',
        discount_value: project.discount_value || 0,
        discount_mode: project.discount_mode || 'discount',
      }, 'recalculateProjectPricingServerSide');
    } catch (invokeErr: any) {
      console.error('calculateProjectPricing invoke failed:', invokeErr?.message);
      return errorResponse('Pricing calculation failed', 500);
    }

    if (!calcResult?.success || calcResult.calculated_price == null) {
      return errorResponse('Pricing calculation returned invalid result', 500);
    }

    const parsedPrice = parseFloat(calcResult.calculated_price);
    if (isNaN(parsedPrice)) {
      return errorResponse('Pricing calculation returned non-numeric price', 500);
    }
    const newPrice = Math.max(0, parsedPrice);
    const tier = calcResult.pricing_tier || project.pricing_tier || 'standard';

    // Resolve the versioned-matrix FK. 2026-04-20 (Phase 3) added
    // price_matrix_versions as an immutable archive of every matrix state.
    // Pin the project to the CURRENT version of the matrix that was used
    // so calculated_price stays reproducible even if the matrix is edited
    // later. Null when no matrix applied (e.g. no agent/agency).
    let versionId: string | null = null;
    const usedMatrixId = calcResult.price_matrix_snapshot?.id || null;
    if (usedMatrixId) {
      const { data: versionRow } = await admin
        .from('price_matrix_versions')
        .select('id')
        .eq('matrix_id', usedMatrixId)
        .is('superseded_at', null)
        .limit(1)
        .maybeSingle();
      versionId = versionRow?.id || null;
    }

    const oldPrice = project.calculated_price || 0;
    const oldVersionId = project.price_matrix_version_id || null;

    await entities.Project.update(project_id, {
      calculated_price: newPrice, price: newPrice, products_needs_recalc: false,
      price_matrix_snapshot: calcResult.price_matrix_snapshot || null,
      price_matrix_version_id: versionId,
    });

    // Append to pricing_audit_log (migration 208). Captures every meaningful
    // price change with full provenance — who, what, which matrix version.
    // Silent no-op when delta < $0.01. Never blocks the main write path.
    let auditId: string | null = null;
    let auditErrorMsg: string | null = null;
    try {
      const triggered_by = body?.triggered_by_webhook ? 'webhook'
        : body?.triggered_by_cron ? 'cron'
        : body?.triggered_by_revision ? 'revision'
        : body?.triggered_by_bulk ? 'bulk'
        : user ? 'user' : 'system';
      const reason = body?.audit_reason
        || (body?.triggered_by_webhook ? 'tonomo_webhook'
            : body?.triggered_by_revision ? 'revision_apply'
            : body?.triggered_by_bulk ? 'bulk_matrix_recompute'
            : oldPrice === 0 ? 'initial'
            : 'user_edit');
      // Guard: when called via service_role JWT, user.id is the literal
      // "__service_role__" string which fails the uuid cast. Only pass
      // actor_id when it looks like a real UUID.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const actorId = (user?.id && UUID_RE.test(user.id)) ? user.id : null;
      const actorName = user?.email || user?.full_name
        || (user?.id === '__service_role__' ? 'system' : null);
      const rpcResult = await admin.rpc('record_pricing_audit', {
        p_project_id: project_id,
        p_old_price: oldPrice,
        p_new_price: newPrice,
        p_old_version_id: oldVersionId,
        p_new_version_id: versionId,
        p_reason: reason,
        p_triggered_by: triggered_by,
        p_actor_id: actorId,
        p_actor_name: actorName,
        p_engine_version: calcResult?.engine_version || null,
        p_notes: body?.audit_notes || null,
      });
      auditId = rpcResult?.data || null;
      if (rpcResult?.error) auditErrorMsg = rpcResult.error.message;
    } catch (auditErr: any) {
      auditErrorMsg = auditErr?.message || String(auditErr);
      console.warn('pricing audit log write failed (non-fatal):', auditErrorMsg);
    }

    entities.ProjectActivity.create({
      project_id, project_title: project.title || project.property_address || '',
      action: 'update',
      description: `Pricing recalculated: $${Math.round(newPrice).toLocaleString()}${oldPrice ? ` (was $${Math.round(oldPrice).toLocaleString()})` : ''}. Tier: ${tier}.`,
      actor_type: 'system', actor_source: 'recalculateProjectPricingServerSide',
      user_name: 'System', user_email: 'system@flexstudios.app',
      changed_fields: JSON.stringify([{ field: 'calculated_price', old_value: oldPrice?.toString() || '0', new_value: Math.round(newPrice).toString() }]),
    }).catch(() => {});

    // ── Price mismatch detection (Tonomo quoted vs matrix calculated) ──────
    // Threshold: $5 (matches engine rounding granularity). Previously $1,
    // which generated rounding-noise false positives for any project whose
    // blanket discount fell on an odd number.
    const MISMATCH_TOLERANCE = 5;
    const tonomoQuotedPrice = project.tonomo_quoted_price;
    if (tonomoQuotedPrice != null) {
      try {
        const tqp = Number(tonomoQuotedPrice);
        const mismatch = Math.round((tqp - newPrice) * 100) / 100;
        if (Math.abs(mismatch) > MISMATCH_TOLERANCE) {
          const mismatchUpdates: Record<string, any> = {
            has_pricing_mismatch: true,
            pricing_mismatch_amount: mismatch,
            pricing_mismatch_details: `Tonomo: $${tqp.toFixed(2)} vs Matrix: $${newPrice.toFixed(2)} (${mismatch > 0 ? '+' : ''}$${mismatch.toFixed(2)})`,
            // HARD RULE: Price mismatch ALWAYS downgrades confidence to partial.
            mapping_confidence: 'partial',
          };

          // Only touch pending_review fields when the project is being flipped
          // to pending_review, or is already in pending_review FOR THIS reason.
          // Previously these two fields were written unconditionally, which
          // (a) overwrote unrelated review reasons (e.g. rescheduled, services
          // change) on projects already in pending_review, and (b) polluted
          // non-pending active projects with phantom pending_review_type values
          // that surfaced the next time the project re-entered pending_review.
          const AUTO_APPROVED_STAGES = ['to_be_scheduled', 'scheduled'];
          const willFlipToPendingReview =
            project.auto_approved && AUTO_APPROVED_STAGES.includes(project.status);
          const alreadyPendingForPricing =
            project.status === 'pending_review' &&
            (project.pending_review_type === 'pricing_mismatch' ||
             project.pending_review_type == null);
          if (willFlipToPendingReview || alreadyPendingForPricing) {
            mismatchUpdates.pending_review_type = 'pricing_mismatch';
            mismatchUpdates.pending_review_reason = `Price mismatch detected: Tonomo quoted $${tqp.toFixed(2)} but our price matrix calculates $${newPrice.toFixed(2)} (difference: $${Math.abs(mismatch).toFixed(2)}). Please review pricing before proceeding.`;
          }
          if (willFlipToPendingReview) {
            mismatchUpdates.status = 'pending_review';
            mismatchUpdates.pre_revision_stage = project.status;
            mismatchUpdates.auto_approved = false;
            console.log(`Price mismatch for ${project_id}: reverting auto-approve → pending_review`);
          }
          await entities.Project.update(project_id, mismatchUpdates);
          // Notify admins about the mismatch
          const projectName = project.title || project.property_address || 'Project';
          entities.User.list('-created_date', 200).then(async (users: any[]) => {
            const adminIds = users.filter((u: any) => u.role === 'master_admin' || u.role === 'admin').map((u: any) => u.id);
            for (const userId of adminIds) {
              const allowed = await _canNotify(entities, userId, 'project_pricing_changed', 'project');
              if (!allowed) continue;
              entities.Notification.create({
                user_id: userId, type: 'project_pricing_changed', category: 'project', severity: 'warning',
                title: `Price mismatch: ${projectName}`,
                message: `Tonomo quoted $${tqp.toFixed(2)} but our price matrix calculates $${newPrice.toFixed(2)} — difference of $${Math.abs(mismatch).toFixed(2)}.`,
                project_id, project_name: projectName, cta_label: 'View Project',
                is_read: false, is_dismissed: false, source: 'pricing',
                idempotency_key: `price_mismatch:${project_id}:${tqp}:${newPrice}:${userId}`,
                created_date: new Date().toISOString(),
              }).catch(() => {});
            }
          }).catch(() => {});
        } else if (project.has_pricing_mismatch) {
          // Prices now match — clear previous mismatch flag
          await entities.Project.update(project_id, {
            has_pricing_mismatch: false,
            pricing_mismatch_amount: null,
            pricing_mismatch_details: null,
          });
        }
      } catch (mismatchErr: any) {
        console.warn('Price mismatch check failed (non-fatal):', mismatchErr.message);
      }
    }

    const priceDelta = Math.abs(newPrice - oldPrice);
    const pctDelta = oldPrice > 0 ? (priceDelta / oldPrice) * 100 : 0;
    if (oldPrice > 0 && priceDelta >= 50 && pctDelta >= 5) {
      const projectName = project.title || project.property_address || 'Project';
      const notifyUsers: string[] = [project.project_owner_id].filter(Boolean);
      entities.User.list('-created_date', 200).then(async (users: any[]) => {
        users.filter((u: any) => u.role === 'master_admin' || u.role === 'admin').forEach((u: any) => notifyUsers.push(u.id));
        for (const userId of [...new Set(notifyUsers)].filter(Boolean)) {
          const allowed = await _canNotify(entities, userId as string, 'project_pricing_changed', 'project');
          if (!allowed) continue;
          entities.Notification.create({
            user_id: userId, type: 'project_pricing_changed', category: 'project', severity: 'info',
            title: `Pricing updated — ${projectName}`,
            message: `Price updated to $${Math.round(newPrice).toLocaleString()} (was $${Math.round(oldPrice).toLocaleString()}).`,
            project_id, project_name: projectName, cta_label: 'View Project',
            is_read: false, is_dismissed: false, source: 'pricing',
            idempotency_key: `pricing_changed:${project_id}:${Math.round(newPrice)}:${userId}`,
            created_date: new Date().toISOString(),
          }).catch(() => {});
        }
      }).catch(() => {});

      entities.TeamActivityFeed.create({
        event_type: 'pricing_changed', category: 'financial', severity: 'info',
        actor_id: null, actor_name: 'System',
        title: `Pricing recalculated: ${projectName}`,
        description: `$${Math.round(oldPrice).toLocaleString()} → $${Math.round(newPrice).toLocaleString()} (Δ$${Math.round(priceDelta)}).`,
        project_id, project_name: projectName, project_stage: project.status || '',
        entity_type: 'project', entity_id: project_id, created_date: new Date().toISOString(),
      }).catch(() => {});
    }

    invokeFunction('syncProjectTasksFromProducts', { project_id }, 'recalculateProjectPricingServerSide').catch(() => {});
    invokeFunction('syncOnsiteEffortTasks', { project_id }, 'recalculateProjectPricingServerSide').catch(() => {});
    invokeFunction('cleanupOrphanedProjectTasks', { project_id }, 'recalculateProjectPricingServerSide').catch(() => {});

    return jsonResponse({ success: true, project_id, calculated_price: newPrice, pricing_tier: tier, used_matrix: !!calcResult.price_matrix_snapshot, delegated_to: 'calculateProjectPricing', audit_id: auditId, audit_error: auditErrorMsg });
  } catch (error: any) {
    console.error('recalculateProjectPricingServerSide error:', error);
    return errorResponse(error.message);
  }
});
