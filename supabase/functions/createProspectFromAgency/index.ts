import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('createProspectFromAgency', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }
    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const { agency_id, agent_name, agent_email, agent_phone, agent_title } = body;

    if (!agency_id || !agent_name || !agent_email) {
      return errorResponse('Missing required fields', 400, req);
    }

    // Get the agency
    const agency = await entities.Agency.get(agency_id);
    if (!agency) {
      return errorResponse('Agency not found', 404);
    }

    // Create the agent
    const newAgent = await entities.Agent.create({
      name: agent_name,
      email: agent_email,
      phone: agent_phone || '',
      title: agent_title || '',
      current_agency_id: agency_id,
      current_agency_name: agency.name,
      relationship_state: 'Prospecting',
      status: 'New Lead',
      source: 'Manual Import'
    });

    // Log the creation
    await entities.InteractionLog.create({
      entity_type: 'Agent',
      entity_id: newAgent.id,
      entity_name: agent_name,
      interaction_type: 'Status Change',
      date_time: new Date().toISOString(),
      summary: `Agent created from agency: ${agency.name}`,
      details: `Created by ${user.full_name}`,
      user_id: user.id,
      user_name: user.full_name,
      sentiment: 'Neutral',
      relationship_state_at_time: 'Prospecting'
    });

    // Fix 2c — increment Agency.agent_count
    try {
      const allAgents = await entities.Agent.filter(
        { current_agency_id: agency_id }, null, 500
      );
      await entities.Agency.update(agency_id, {
        agent_count: allAgents.length,
      });
    } catch { /* non-fatal */ }

    return jsonResponse({
      success: true,
      agent: newAgent,
      message: `Agent created under ${agency.name}`
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
