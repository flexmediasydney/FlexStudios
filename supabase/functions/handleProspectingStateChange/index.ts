import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('handleProspectingStateChange', async (req) => {
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
    const { entity_type, entity_id, old_state, new_state } = body;

    if (!entity_type || !entity_id || !new_state) {
      return errorResponse('Missing required fields', 400, req);
    }

    const entityMap: Record<string, any> = {
      'Agent': entities.Agent,
      'Agency': entities.Agency
    };

    const entity = entityMap[entity_type];
    if (!entity) {
      return errorResponse('Invalid entity type', 400, req);
    }

    // Get the entity to get its current name
    const currentEntity = await entity.get(entity_id);
    if (!currentEntity) {
      return errorResponse('Entity not found', 404);
    }

    // Log the state change as an interaction
    const stateChangeMessage = `Relationship state changed from ${old_state} to ${new_state}`;

    await entities.InteractionLog.create({
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

    return jsonResponse({ success: true, message: stateChangeMessage });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
