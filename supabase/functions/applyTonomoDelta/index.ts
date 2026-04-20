// applyTonomoDelta — Admin-gated handler for Tonomo product/package deltas
// stashed under the (now-retired) lock system. Kept for the stashed rows
// that still exist in tonomo_pending_delta; future webhooks won't produce
// new stashes because Tonomo wins unconditionally for products/packages
// since 2026-04-20 (see migration 209).
//
// POST /applyTonomoDelta
//   body: { project_id: string, action: 'apply' | 'dismiss' }
//
// - apply:   writes tonomo_pending_delta.after.products/packages to the
//            project, sets products_auto_applied=true, products_needs_recalc=true,
//            stamps auto_applied_at, clears tonomo_pending_delta, emits a
//            project_activity entry, and triggers recalculateProjectPricingServerSide.
// - dismiss: clears tonomo_pending_delta and emits a project_activity entry.
//
// Only master_admin / admin users may call this endpoint.

import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  invokeFunction,
} from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401, req);

  const admin = getAdminClient();

  // Load the caller's user record to check role.
  // Service-role bypass: getUserFromReq returns AppUser with role='master_admin'
  // and id='__service_role__' for sb_secret_* / service-role JWT bearers.
  let callerUser: { id?: string | null; email?: string | null; full_name?: string | null; role?: string | null } | null = null;
  const initialRole = (user.role || '').toLowerCase();
  if (user.id && user.id !== '__service_role__') {
    const { data } = await admin
      .from('users')
      .select('id, email, full_name, role')
      .eq('id', user.id)
      .maybeSingle();
    callerUser = data;
  }
  const role = (callerUser?.role || initialRole || '').toLowerCase();
  if (role !== 'master_admin' && role !== 'admin') {
    return errorResponse('Admin role required', 403, req);
  }
  if (!callerUser) {
    callerUser = {
      id: user.id,
      email: user.email || 'system@flexstudios.app',
      full_name: user.full_name || 'System',
      role: initialRole,
    };
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  const projectId: string = body?.project_id;
  const action: string = body?.action;
  if (!projectId) return errorResponse('project_id is required', 400, req);
  if (action !== 'apply' && action !== 'dismiss') {
    return errorResponse("action must be 'apply' or 'dismiss'", 400, req);
  }

  // Fetch the project with its current pending delta
  const { data: project, error: fetchErr } = await admin
    .from('projects')
    .select('id, title, property_address, tonomo_pending_delta, products, packages, manually_overridden_fields, status, pending_review_type, pending_review_reason')
    .eq('id', projectId)
    .maybeSingle();

  if (fetchErr) return errorResponse(`Project fetch failed: ${fetchErr.message}`, 500, req);
  if (!project) return errorResponse('Project not found', 404, req);

  const pending = project.tonomo_pending_delta;
  if (!pending) {
    return errorResponse('No pending Tonomo delta on this project', 400, req);
  }

  // jsonb storage of a JSON.stringify()'d object yields a JSON-encoded string,
  // so we may need to parse twice (the PostgREST layer unwraps once; the
  // backfill wrote a stringified string as the jsonb value).
  function deepParsePending(raw: any): any {
    let v: any = raw;
    for (let i = 0; i < 3 && typeof v === 'string'; i++) {
      try { v = JSON.parse(v); } catch { return null; }
    }
    return v;
  }
  const pendingObj = deepParsePending(pending);
  if (!pendingObj || !pendingObj.after) {
    return errorResponse('Pending delta is malformed — missing after state', 400, req);
  }

  const projectName = project.title || project.property_address || 'Project';
  const actorName = callerUser.full_name || callerUser.email || 'Unknown';
  const actorEmail = callerUser.email || '';

  if (action === 'dismiss') {
    const { error: updateErr } = await admin
      .from('projects')
      .update({ tonomo_pending_delta: null })
      .eq('id', projectId);
    if (updateErr) return errorResponse(`Dismiss update failed: ${updateErr.message}`, 500, req);

    // Optionally clear pending_review_type if it was only tonomo_drift
    if (project.pending_review_type === 'tonomo_drift') {
      await admin.from('projects').update({
        pending_review_type: null,
        pending_review_reason: null,
      }).eq('id', projectId);
    }

    await admin.from('project_activities').insert({
      project_id: projectId,
      project_title: projectName,
      action: 'tonomo_delta_dismissed',
      description: `User dismissed Tonomo pending delta (${pendingObj.source_event_type || 'unknown event'}). Additions and removals not applied.`,
      user_name: actorName,
      user_email: actorEmail,
      actor_type: 'user',
      // Structured snapshot of the proposed change (before = current project
      // state, after = what Tonomo wanted but user rejected). Lets audit
      // queries answer "what did the user reject" without parsing metadata.
      previous_state: { products: project.products || [], packages: project.packages || [] },
      new_state: pendingObj.after ? { products: pendingObj.after.products || [], packages: pendingObj.after.packages || [] } : null,
      changed_fields: pendingObj.diff ? [{ field: 'products_and_packages', diff: pendingObj.diff, decision: 'dismissed' }] : [],
      metadata: JSON.stringify({
        diff: pendingObj.diff || null,
        source_queue_id: pendingObj.source_queue_id || null,
        source_webhook_log_id: pendingObj.source_webhook_log_id || null,
      }),
    });

    return jsonResponse({ ok: true, action: 'dismissed', project_id: projectId }, 200, req);
  }

  // action === 'apply'
  const after = pendingObj.after;
  const updatePayload: Record<string, any> = {
    products: after.products || [],
    packages: after.packages || [],
    products_auto_applied: true,
    products_needs_recalc: true,
    tonomo_pending_delta: {
      ...pendingObj,
      auto_applied_at: new Date().toISOString(),
      safe_to_auto_apply: true,
    },
  };

  // Clear the tonomo_drift review type now that we applied it
  if (project.pending_review_type === 'tonomo_drift') {
    updatePayload.pending_review_type = null;
    updatePayload.pending_review_reason = null;
  }

  const { error: applyErr } = await admin
    .from('projects')
    .update(updatePayload)
    .eq('id', projectId);
  if (applyErr) return errorResponse(`Apply update failed: ${applyErr.message}`, 500, req);

  // After applying, clear the stash completely (auto_applied_at was set for audit;
  // now we can drop it so the UI no longer surfaces it).
  await admin
    .from('projects')
    .update({ tonomo_pending_delta: null })
    .eq('id', projectId);

  await admin.from('project_activities').insert({
    project_id: projectId,
    project_title: projectName,
    action: 'tonomo_delta_applied',
    description: `User applied Tonomo pending delta. Products/packages updated to match Tonomo's proposed state.`,
    user_name: actorName,
    user_email: actorEmail,
    actor_type: 'user',
    // Structured before/after — queryable audit trail of the apply decision.
    previous_state: { products: project.products || [], packages: project.packages || [] },
    new_state: { products: after.products || [], packages: after.packages || [] },
    changed_fields: pendingObj.diff ? [{ field: 'products_and_packages', diff: pendingObj.diff, decision: 'applied' }] : [],
    metadata: JSON.stringify({
      diff: pendingObj.diff || null,
      source_queue_id: pendingObj.source_queue_id || null,
      source_webhook_log_id: pendingObj.source_webhook_log_id || null,
    }),
  });

  // Fire-and-forget pricing recalc
  invokeFunction('recalculateProjectPricingServerSide', { project_id: projectId })
    .catch((err: any) => console.warn('recalculateProjectPricingServerSide failed:', err?.message));

  // Also sync tasks & clean up orphans
  invokeFunction('syncProjectTasksFromProducts', { project_id: projectId })
    .catch((err: any) => console.warn('syncProjectTasksFromProducts failed:', err?.message));
  invokeFunction('cleanupOrphanedProjectTasks', { project_id: projectId })
    .catch((err: any) => console.warn('cleanupOrphanedProjectTasks failed:', err?.message));

  return jsonResponse({
    ok: true,
    action: 'applied',
    project_id: projectId,
    product_count: (after.products || []).length,
    package_count: (after.packages || []).length,
  }, 200, req);
});
