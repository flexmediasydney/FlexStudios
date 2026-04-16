import { getAdminClient, getUserFromReq, createEntities, invokeFunction, handleCors, jsonResponse, errorResponse, isQuietHours } from '../_shared/supabase.ts';

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

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'recalculateProjectPricingServerSide', _ts: '2026-03-17' });
    }

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
      });
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

    await entities.Project.update(project_id, {
      calculated_price: newPrice, price: newPrice, products_needs_recalc: false,
      price_matrix_snapshot: calcResult.price_matrix_snapshot || null,
    });

    const oldPrice = project.calculated_price || 0;
    entities.ProjectActivity.create({
      project_id, project_title: project.title || project.property_address || '',
      action: 'update',
      description: `Pricing recalculated: $${Math.round(newPrice).toLocaleString()}${oldPrice ? ` (was $${Math.round(oldPrice).toLocaleString()})` : ''}. Tier: ${tier}.`,
      actor_type: 'system', actor_source: 'recalculateProjectPricingServerSide',
      user_name: 'System', user_email: 'system@flexstudios.app',
      changed_fields: JSON.stringify([{ field: 'calculated_price', old_value: oldPrice?.toString() || '0', new_value: Math.round(newPrice).toString() }]),
    }).catch(() => {});

    // ── Price mismatch detection (Tonomo quoted vs matrix calculated) ──────
    const tonomoQuotedPrice = project.tonomo_quoted_price;
    if (tonomoQuotedPrice != null) {
      try {
        const tqp = Number(tonomoQuotedPrice);
        const mismatch = Math.round((tqp - newPrice) * 100) / 100;
        if (Math.abs(mismatch) > 1) {
          const mismatchUpdates: Record<string, any> = {
            has_pricing_mismatch: true,
            pricing_mismatch_amount: mismatch,
            pricing_mismatch_details: `Tonomo: $${tqp.toFixed(2)} vs Matrix: $${newPrice.toFixed(2)} (${mismatch > 0 ? '+' : ''}$${mismatch.toFixed(2)})`,
            // HARD RULE: Price mismatch ALWAYS downgrades confidence to partial.
            mapping_confidence: 'partial',
            pending_review_type: 'pricing_mismatch',
            pending_review_reason: `Price mismatch detected: Tonomo quoted $${tqp.toFixed(2)} but our price matrix calculates $${newPrice.toFixed(2)} (difference: $${Math.abs(mismatch).toFixed(2)}). Please review pricing before proceeding.`,
          };
          // If the project was auto-approved past pending_review, pull it back.
          const AUTO_APPROVED_STAGES = ['to_be_scheduled', 'scheduled'];
          if (project.auto_approved && AUTO_APPROVED_STAGES.includes(project.status)) {
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

    invokeFunction('syncProjectTasksFromProducts', { project_id }).catch(() => {});
    invokeFunction('syncOnsiteEffortTasks', { project_id }).catch(() => {});
    invokeFunction('cleanupOrphanedProjectTasks', { project_id }).catch(() => {});

    return jsonResponse({ success: true, project_id, calculated_price: newPrice, pricing_tier: tier, used_matrix: !!calcResult.price_matrix_snapshot, delegated_to: 'calculateProjectPricing' });
  } catch (error: any) {
    console.error('recalculateProjectPricingServerSide error:', error);
    return errorResponse(error.message);
  }
});
