import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Exponential backoff retry helper
const retryWithBackoff = async (fn, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 50;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);

    // Accept both user sessions (frontend) and service-role calls
    // (from recalculateProjectPricingServerSide, processTonomoQueue)
    if (user && !['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
    }

    const body = await req.json();
    const { project_id } = body;

    if (body?._health_check) {
      return Response.json({ _version: 'v1.1', _fn: 'cleanupOrphanedProjectTasks', _ts: '2026-03-17' });
    }

    if (!project_id) {
      return Response.json({ error: 'project_id is required' }, { status: 400 });
    }

    // Fetch project and tasks in parallel
    const db = user ? base44.entities : base44.asServiceRole.entities;
    const [project, allTasks] = await Promise.all([
      retryWithBackoff(() => db.Project.get(project_id)),
      retryWithBackoff(() => db.ProjectTask.filter({ project_id }, null, 1000)),
    ]);

    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    // Build set of valid IDs from current products/packages
    // Include both root-level products AND products nested in packages
    const rootProducts = (project.products || []).map(p => p.product_id);
    const packagedProducts = (project.packages || []).flatMap(pkg => 
      (pkg.products || []).map(p => p.product_id)
    );
    const validProductIds = new Set([...rootProducts, ...packagedProducts]);
    const validPackageIds = new Set((project.packages || []).map(p => p.package_id));

    // Find auto-generated tasks whose source product/package no longer exists on the project
    // Skip onsite tasks (template_id starts with "onsite:") — those are managed by syncOnsiteEffortTasks
    const orphanedTasks = allTasks.filter(task => {
      if (!task.auto_generated) return false;
      if (task.is_deleted) return false; // already soft-deleted
      if (task.template_id?.startsWith('onsite:')) return false; // managed separately

      const hasValidSource =
        (task.product_id && validProductIds.has(task.product_id)) ||
        (task.package_id && validPackageIds.has(task.package_id));
      return !hasValidSource;
    });

    // Soft-delete orphaned tasks (preserves time logs, history)
    let softDeletedCount = 0;
    const batchSize = 5;
    for (let i = 0; i < orphanedTasks.length; i += batchSize) {
      const batch = orphanedTasks.slice(i, i + batchSize);
      await Promise.all(
        batch.map(task =>
          retryWithBackoff(() => db.ProjectTask.update(task.id, { is_deleted: true }))
            .then(() => { softDeletedCount++; })
            .catch(err => console.error(`Failed to soft-delete task ${task.id}:`, err.message))
        )
      );
    }

    // Also trigger onsite task sync via service role (avoids auth propagation issues)
    base44.asServiceRole.functions.invoke('syncOnsiteEffortTasks', { project_id })
      .catch(err => console.warn('syncOnsiteEffortTasks skipped:', err?.message));

    return Response.json({
      success: true,
      deleted_count: softDeletedCount,
      message: `Soft-removed ${softDeletedCount} orphaned task(s)`,
    });
  } catch (error) {
    console.error('Error cleaning up orphaned tasks:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});