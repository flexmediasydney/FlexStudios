import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('syncDenormalisedFieldsOnNameChange', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const admin = getAdminClient();
    const entities = createEntities(admin);

    const body = await req.json().catch(() => ({} as any));
    const { entity_type, entity_id, new_name } = body;

    if (!entity_type || !entity_id || !new_name) {
      return errorResponse('entity_type, entity_id, new_name required', 400, req);
    }

    let updatedCount = 0;

    if (entity_type === 'agency') {
      const matchingProjects = await entities.Project.filter({ agency_id: entity_id }, null, 2000);

      for (const project of matchingProjects) {
        await entities.Project.update(project.id, { agency_name: new_name });
        updatedCount++;
      }

      const matchingAgents = await entities.Agent.filter({ current_agency_id: entity_id }, null, 500);

      for (const agent of matchingAgents) {
        await entities.Agent.update(agent.id, { current_agency_name: new_name });
        updatedCount++;
      }
    } else if (entity_type === 'agent') {
      const matchingProjects = await entities.Project.filter({ client_id: entity_id }, null, 2000);

      for (const project of matchingProjects) {
        await entities.Project.update(project.id, { client_name: new_name });
        updatedCount++;
      }
    } else if (entity_type === 'user') {
      // Update denormalised user name on ProjectTasks assigned to this user
      const tasks = await entities.ProjectTask.filter({ assigned_to: entity_id }, null, 2000);
      for (const task of tasks) {
        if (task.assigned_to_name !== new_name) {
          await entities.ProjectTask.update(task.id, { assigned_to_name: new_name });
          updatedCount++;
        }
      }
      // Update EmployeeRole name
      const roles = await entities.EmployeeRole.filter({ user_id: entity_id }, null, 50).catch(() => []);
      for (const role of roles) {
        await entities.EmployeeRole.update(role.id, { user_name: new_name }).catch(() => {});
        updatedCount++;
      }
    }

    return jsonResponse({
      success: true,
      entity_type,
      entity_id,
      new_name,
      updatedCount,
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
