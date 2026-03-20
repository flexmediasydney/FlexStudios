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

    const { entity_type, entity_id, old_state, new_state } = await req.json();

    if (!entity_type || !entity_id || !new_state) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const entityMap = {
      'Agent': base44.entities.Agent,
      'Agency': base44.entities.Agency
    };

    const entity = entityMap[entity_type];
    if (!entity) {
      return Response.json({ error: 'Invalid entity type' }, { status: 400 });
    }

    // Get the entity to get its current name
    const currentEntity = await entity.get(entity_id);
    if (!currentEntity) {
      return Response.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Log the state change as an interaction
    const stateChangeMessage = `Relationship state changed from ${old_state} to ${new_state}`;
    
    await base44.entities.InteractionLog.create({
      entity_type: entity_type,
      entity_id: entity_id,
      entity_name: currentEntity.name,
      interaction_type: 'Status Change',
      date_time: new Date().toISOString(),
      summary: stateChangeMessage,
      details: `Changed by ${user.full_name}`,
      user_id: user.id,
      user_name: user.full_name,
      sentiment: 'Neutral',
      relationship_state_at_time: new_state
    });

    // Update the entity's relevant dates if transitioning to specific states
    const updateData: any = { relationship_state: new_state };

    if (new_state === 'Active') {
      updateData.became_active_date = new Date().toISOString().split('T')[0];
      updateData.is_at_risk = false; // Fix 2b — clear at-risk flag on manual activation
    } else if (new_state === 'Dormant') {
      updateData.became_dormant_date = new Date().toISOString().split('T')[0];
    }

    await entity.update(entity_id, updateData);

    return Response.json({ success: true, message: stateChangeMessage });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});