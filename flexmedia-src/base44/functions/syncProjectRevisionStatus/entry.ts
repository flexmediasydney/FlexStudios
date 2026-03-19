import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Syncs project status based on revision state:
 * - If a project has ANY unclosed revision (not completed/rejected), status = "in_revision" & previous_status = saved
 * - If ALL revisions are closed, status reverts to previous_status
 * Triggered when a ProjectRevision is created/updated/deleted
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { project_id } = await req.json();

    if (!project_id) {
      return Response.json({ error: 'project_id required' }, { status: 400 });
    }

    const project = await base44.entities.Project.get(project_id);
    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    // Get all revisions for this project
    const revisions = await base44.entities.ProjectRevision.filter(
      { project_id },
      null,
      500
    );

    // Check if there are any unclosed revisions (not completed or rejected)
    const hasUnclosedRevisions = revisions.some(
      r => !['completed', 'delivered', 'cancelled', 'rejected'].includes(r.status)
    );

    let updateData = {};

    if (hasUnclosedRevisions) {
      // Enter revision mode: set status to in_revision and save current status as previous
      if (project.status !== 'in_revision') {
        updateData.previous_status = project.status;
        updateData.status = 'in_revision';
      }
    } else {
      // Exit revision mode: revert to previous_status if available
      if (project.status === 'in_revision' && project.previous_status) {
        updateData.status = project.previous_status;
        updateData.previous_status = null;
      }
    }

    // Only update if there are changes
    if (Object.keys(updateData).length > 0) {
      await base44.entities.Project.update(project_id, updateData);
      return Response.json({
        status: 'synced',
        project_status: updateData.status || project.status,
        has_unclosed_revisions: hasUnclosedRevisions
      });
    }

    return Response.json({
      status: 'no_change',
      has_unclosed_revisions: hasUnclosedRevisions
    });
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});