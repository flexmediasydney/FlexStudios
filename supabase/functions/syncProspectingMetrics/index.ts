import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    // This can be called by scheduled task or manually
    if (!user) {
      return errorResponse('Unauthorized', 401);
    }
    if (!['master_admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    const agents = await entities.Agent.list();
    const agencies = await entities.Agency.list();
    const interactions = await entities.InteractionLog.list();

    // Calculate metrics
    const metrics = {
      timestamp: new Date().toISOString(),
      agents: {
        total: agents.length,
        prospecting: agents.filter((a: any) => a.relationship_state === 'Prospecting').length,
        active: agents.filter((a: any) => a.relationship_state === 'Active').length,
        dormant: agents.filter((a: any) => a.relationship_state === 'Dormant').length,
        doNotContact: agents.filter((a: any) => a.relationship_state === 'Do Not Contact').length,
      },
      agencies: {
        total: agencies.length,
        prospecting: agencies.filter((a: any) => a.relationship_state === 'Prospecting').length,
        active: agencies.filter((a: any) => a.relationship_state === 'Active').length,
        dormant: agencies.filter((a: any) => a.relationship_state === 'Dormant').length,
        doNotContact: agencies.filter((a: any) => a.relationship_state === 'Do Not Contact').length,
      },
      interactions: {
        total: interactions.length,
        last7days: interactions.filter((i: any) => {
          const date = new Date(i.date_time);
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          return date > weekAgo;
        }).length,
      },
      conversionRate: agents.length > 0
        ? ((agents.filter((a: any) => a.relationship_state === 'Active').length / agents.length) * 100).toFixed(2)
        : 0
    };

    return jsonResponse(metrics);
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
