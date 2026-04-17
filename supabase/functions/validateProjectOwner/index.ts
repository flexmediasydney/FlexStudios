import { getAdminClient, createEntities, getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { project_id } = await req.json();

    if (!project_id) {
      return jsonResponse({ valid: false, error: 'project_id required' }, 400);
    }

    const project = await entities.Project.get(project_id);

    if (!project) {
      return jsonResponse({
        valid: false,
        project_id,
        project_owner_id: null,
        error: 'Project not found',
      }, 404);
    }

    const hasOwner = !!project.project_owner_id;
    return jsonResponse({
      valid: hasOwner,
      project_id,
      project_owner_id: project.project_owner_id || null,
      error: hasOwner ? null : 'Project Owner is mandatory (PR-022)',
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
