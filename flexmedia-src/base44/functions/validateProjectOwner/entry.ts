import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { project_id } = await req.json();

    if (!project_id) {
      return Response.json({ valid: false, error: 'project_id required' }, { status: 400 });
    }

    const project = await base44.entities.Project.get(project_id);

    if (!project) {
      return Response.json({
        valid: false,
        project_id,
        project_owner_id: null,
        error: 'Project not found',
      }, { status: 404 });
    }

    const hasOwner = !!project.project_owner_id;
    return Response.json({ 
      valid: hasOwner, 
      project_id,
      project_owner_id: project.project_owner_id || null,
      error: hasOwner ? null : 'Project Owner is mandatory (PR-022)',
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});