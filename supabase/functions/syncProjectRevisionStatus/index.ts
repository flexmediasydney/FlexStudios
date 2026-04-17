import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, getUserFromReq, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('syncProjectRevisionStatus', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // ── Auth: require any authenticated user or service role ──
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { project_id } = await req.json();

    if (!project_id) return jsonResponse({ error: 'project_id required' }, 400);

    const project = await entities.Project.get(project_id);
    if (!project) return jsonResponse({ error: 'Project not found' }, 404);

    const revisions = await entities.ProjectRevision.filter({ project_id }, null, 500);
    const hasUnclosedRevisions = revisions.some((r: any) => !['completed', 'delivered', 'cancelled', 'rejected'].includes(r.status));

    let updateData: any = {};

    if (hasUnclosedRevisions) {
      if (project.status !== 'in_revision') {
        updateData.previous_status = project.status;
        updateData.status = 'in_revision';
      }
    } else {
      if (project.status === 'in_revision' && project.previous_status) {
        updateData.status = project.previous_status;
        updateData.previous_status = null;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await entities.Project.update(project_id, updateData);
      return jsonResponse({ status: 'synced', project_status: updateData.status || project.status, has_unclosed_revisions: hasUnclosedRevisions });
    }

    return jsonResponse({ status: 'no_change', has_unclosed_revisions: hasUnclosedRevisions });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
