import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // This can be called by scheduled task or manually
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient role' }, { status: 403 });
    }

    const agents = await base44.entities.Agent.list();
    const agencies = await base44.entities.Agency.list();
    const interactions = await base44.entities.InteractionLog.list();

    // Calculate metrics
    const metrics = {
      timestamp: new Date().toISOString(),
      agents: {
        total: agents.length,
        prospecting: agents.filter(a => a.relationship_state === 'Prospecting').length,
        active: agents.filter(a => a.relationship_state === 'Active').length,
        dormant: agents.filter(a => a.relationship_state === 'Dormant').length,
        doNotContact: agents.filter(a => a.relationship_state === 'Do Not Contact').length,
      },
      agencies: {
        total: agencies.length,
        prospecting: agencies.filter(a => a.relationship_state === 'Prospecting').length,
        active: agencies.filter(a => a.relationship_state === 'Active').length,
        dormant: agencies.filter(a => a.relationship_state === 'Dormant').length,
        doNotContact: agencies.filter(a => a.relationship_state === 'Do Not Contact').length,
      },
      interactions: {
        total: interactions.length,
        last7days: interactions.filter(i => {
          const date = new Date(i.date_time);
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          return date > weekAgo;
        }).length,
      },
      conversionRate: agents.length > 0 
        ? ((agents.filter(a => a.relationship_state === 'Active').length / agents.length) * 100).toFixed(2)
        : 0
    };

    return Response.json(metrics);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});