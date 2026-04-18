// One-shot audit sweep: for every project with a manually_overridden_fields
// products/packages lock AND non-empty tonomo_service_tiers, re-resolve the
// Tonomo products/packages and stash a tonomo_pending_delta if the diff is
// non-empty. This surfaces pre-existing silent drops in the UI.
//
// POST /backfillTonomoDrift
//   body: { dry_run?: boolean, project_id?: string }
//
// - dry_run=true: returns per-project diff summaries without writing
// - project_id: restrict to a single project (useful for verifying 36 Ward St)
//
// Admin-only (service-role bearer also works).

import {
  getAdminClient,
  createEntities,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/supabase.ts';
import {
  resolveProductsFromTiers,
  resolveProductsFromWorkDays,
  deduplicateProjectItems,
  loadMappingTable,
  safeJsonParse,
} from '../processTonomoQueue/utils.ts';
import {
  diffProjectPackages,
  isAddOnly,
  isNoOp,
  applyDiff,
  extractAddedFromNew,
} from '../processTonomoQueue/diffTonomoProducts.ts';

interface ProjectRow {
  id: string;
  title?: string | null;
  property_address?: string | null;
  tonomo_order_id?: string | null;
  tonomo_service_tiers?: string | null;
  tonomo_raw_services?: string | null;
  manually_overridden_fields?: string | null;
  manually_locked_product_ids?: any;
  manually_locked_package_ids?: any;
  products?: any[] | null;
  packages?: any[] | null;
  tonomo_pending_delta?: any;
  pending_review_type?: string | null;
  pending_review_reason?: string | null;
  status?: string | null;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401, req);

  const admin = getAdminClient();
  const entities = createEntities(admin);

  // Check role — service-role bypass has role='master_admin' already set in AppUser
  const initialRole = (user.role || '').toLowerCase();
  let isAdmin = initialRole === 'master_admin' || initialRole === 'admin';
  if (!isAdmin && user.id && user.id !== '__service_role__') {
    const { data: callerUser } = await admin.from('users').select('role').eq('id', user.id).maybeSingle();
    const role = (callerUser?.role || '').toLowerCase();
    isAdmin = role === 'master_admin' || role === 'admin';
  }
  if (!isAdmin) {
    return errorResponse('Admin role required', 403, req);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ok */ }
  const dryRun = body.dry_run === true;
  const singleProjectId: string | null = body.project_id || null;

  // Fetch candidate projects
  let query = admin
    .from('projects')
    .select('id, title, property_address, tonomo_order_id, tonomo_service_tiers, tonomo_raw_services, manually_overridden_fields, manually_locked_product_ids, manually_locked_package_ids, products, packages, tonomo_pending_delta, pending_review_type, pending_review_reason, status')
    .not('tonomo_service_tiers', 'is', null);

  if (singleProjectId) {
    query = query.eq('id', singleProjectId);
  } else {
    // Require some form of lock
    query = query.or(`manually_overridden_fields.ilike.%products%,manually_overridden_fields.ilike.%packages%`);
  }

  const { data: projects, error: fetchErr } = await query;
  if (fetchErr) return errorResponse(`Project fetch failed: ${fetchErr.message}`, 500, req);

  const allMappings = await loadMappingTable(entities);
  const [allProducts, allPackages] = await Promise.all([
    entities.Product.list(null, 500).catch(() => []),
    entities.Package.list(null, 200).catch(() => []),
  ]);

  const results: any[] = [];
  let stashed = 0;
  let skippedNoTiers = 0;
  let skippedNoop = 0;
  let alreadyPending = 0;

  for (const project of (projects || []) as ProjectRow[]) {
    try {
    // Skip if already has a pending delta (unless single-project run for verification)
    if (!singleProjectId && project.tonomo_pending_delta) {
      alreadyPending++;
      continue;
    }

    const tiers = safeJsonParse<any[]>(project.tonomo_service_tiers, []);
    if (!tiers || tiers.length === 0) {
      skippedNoTiers++;
      results.push({ project_id: project.id, title: project.title, status: 'skipped_no_tiers' });
      continue;
    }

    // The stored tiers on the project are the stripped shape:
    //   [{name, selected}]
    // resolveProductsFromTiers expects the raw service_custom_tiers shape:
    //   [{serviceId, serviceName, selected: {name}}]
    // We can't reconstruct serviceId from the project's stored form — but
    // the original raw tiers are captured in tonomo_raw_services which only
    // has service NAMES. However, the mapping table is keyed by tonomo_id.
    // So we need the original raw payload from tonomo_webhook_logs.
    //
    // Strategy: look up the latest webhook_log for this order_id and parse
    // its raw_payload to grab service_custom_tiers + workDays. This is the
    // authoritative "what Tonomo wants" source.

    const orderId = project.tonomo_order_id;
    if (!orderId) {
      skippedNoTiers++;
      results.push({ project_id: project.id, title: project.title, status: 'skipped_no_order_id' });
      continue;
    }

    // tonomo_webhook_logs doesn't have an order_id column — orderId lives
    // inside raw_payload. Search by text content.
    const { data: logs } = await admin
      .from('tonomo_webhook_logs')
      .select('id, raw_payload, created_at, event_type')
      .ilike('raw_payload', `%${orderId}%`)
      .order('created_at', { ascending: false })
      .limit(10);

    let rawTiers: any[] = [];
    let rawWorkDays: any[] = [];
    let sourceWebhookLogId: string | null = null;
    let sourceEventType: string | null = null;
    for (const log of logs || []) {
      try {
        const p = JSON.parse(log.raw_payload);
        const t = p.order?.service_custom_tiers || p.service_custom_tiers || [];
        const w = p.order?.workDays || p.workDays || [];
        if (t.length > 0 || w.length > 0) {
          rawTiers = t;
          rawWorkDays = w;
          sourceWebhookLogId = log.id;
          sourceEventType = log.event_type || p.action || 'unknown';
          break;
        }
      } catch { /* skip malformed */ }
    }

    if (rawTiers.length === 0 && rawWorkDays.length === 0) {
      skippedNoTiers++;
      results.push({ project_id: project.id, title: project.title, status: 'skipped_no_raw_tiers' });
      continue;
    }

    const { autoProducts: newProducts, autoPackages: newPackages } =
      await resolveProductsFromTiers(entities, rawTiers, allMappings);
    const { autoProducts: feeProducts } =
      await resolveProductsFromWorkDays(entities, rawWorkDays, allMappings);
    if (feeProducts.length > 0) newProducts.push(...feeProducts);

    const deduped = deduplicateProjectItems(newProducts, newPackages, allProducts, allPackages);
    const diff = diffProjectPackages(
      project.products, project.packages,
      deduped.products, deduped.packages,
      allProducts, allPackages,
    );

    if (isNoOp(diff)) {
      skippedNoop++;
      results.push({ project_id: project.id, title: project.title, status: 'noop', diff });
      continue;
    }

    const addOnly = isAddOnly(diff);

    const stashPayload = {
      detected_at: new Date().toISOString(),
      source_queue_id: null,
      source_webhook_log_id: sourceWebhookLogId,
      source_event_type: sourceEventType,
      before: {
        products: project.products || [],
        packages: project.packages || [],
      },
      after: {
        products: deduped.products,
        packages: deduped.packages,
      },
      diff,
      safe_to_auto_apply: addOnly,
      auto_applied_at: null,
      backfill: true,
    };

    if (dryRun) {
      results.push({
        project_id: project.id,
        title: project.title,
        status: addOnly ? 'would_auto_merge' : 'would_stash',
        diff,
      });
      continue;
    }

    // Write the stash (and if add-only, we still surface it for user review
    // because the backfill is a one-shot audit — we don't want to make
    // mass product changes silently)
    const updates: Record<string, any> = {
      tonomo_pending_delta: stashPayload,
    };
    if (!addOnly && project.pending_review_type == null) {
      updates.pending_review_type = 'tonomo_drift';
      updates.pending_review_reason = `Backfill detected Tonomo drift: ${diff.added_products.length} added, ${diff.removed_products.length} removed, ${diff.qty_changed.length} qty changes. Review required.`;
    }
    const { error: updErr } = await admin.from('projects').update(updates).eq('id', project.id);
    if (updErr) {
      results.push({ project_id: project.id, title: project.title, status: 'error_update', error: updErr.message });
      continue;
    }

    try {
      await admin.from('project_activities').insert({
        project_id: project.id,
        project_title: project.title || project.property_address || '',
        action: 'tonomo_delta_backfilled',
        description: `Backfill sweep stashed a ${addOnly ? 'safe add-only' : 'destructive'} Tonomo delta: +${diff.added_products.length}/−${diff.removed_products.length} products, ${diff.qty_changed.length} qty changes, +${diff.added_packages.length}/−${diff.removed_packages.length} packages.`,
        actor_type: 'system',
        actor_source: 'backfillTonomoDrift',
        user_name: 'Backfill Sweep',
        user_email: 'system@backfill',
        tonomo_order_id: orderId,
        tonomo_event_type: sourceEventType,
        metadata: JSON.stringify({ add_only: addOnly, source_webhook_log_id: sourceWebhookLogId }),
      });
    } catch (activityErr: any) {
      results.push({ project_id: project.id, title: project.title, status: 'warning_activity_failed', error: activityErr?.message || 'activity insert failed', stashed: true });
      stashed++;
      continue;
    }

    stashed++;
    results.push({ project_id: project.id, title: project.title, status: addOnly ? 'stashed_add_only' : 'stashed_destructive', diff });
    } catch (perProjectErr: any) {
      results.push({ project_id: project.id, title: project.title, status: 'exception', error: perProjectErr?.message || String(perProjectErr) });
    }
  }

  return jsonResponse({
    ok: true,
    dry_run: dryRun,
    project_count: projects?.length || 0,
    stashed,
    skipped_noop: skippedNoop,
    skipped_no_tiers: skippedNoTiers,
    already_pending: alreadyPending,
    results: results.slice(0, 100),
  }, 200, req);
});
