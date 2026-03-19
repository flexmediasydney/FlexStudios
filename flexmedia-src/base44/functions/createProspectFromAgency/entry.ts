import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient role' }, { status: 403 });
    }

    const { agency_id, agent_name, agent_email, agent_phone, agent_title } = await req.json();

    if (!agency_id || !agent_name || !agent_email) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get the agency
    const agency = await base44.entities.Agency.get(agency_id);
    if (!agency) {
      return Response.json({ error: 'Agency not found' }, { status: 404 });
    }

    // Create the agent
    const newAgent = await base44.entities.Agent.create({
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
    await base44.entities.InteractionLog.create({
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
      const allAgents = await base44.entities.Agent.filter(
        { current_agency_id: agency_id }, null, 500
      );
      await base44.entities.Agency.update(agency_id, {
        agent_count: allAgents.length,
      });
    } catch { /* non-fatal */ }

    return Response.json({ 
      success: true, 
      agent: newAgent,
      message: `Agent created under ${agency.name}` 
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});