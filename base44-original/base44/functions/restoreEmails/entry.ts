import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
    }

    const { threadIds, emailAccountId } = await req.json();

    if (!threadIds || !Array.isArray(threadIds) || !emailAccountId) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }

    const messages = await base44.asServiceRole.entities.EmailMessage.filter({
      email_account_id: emailAccountId,
      gmail_thread_id: { '$in': threadIds }
    });

    for (const msg of messages) {
      await base44.asServiceRole.entities.EmailMessage.update(msg.id, {
        is_deleted: false,
        is_archived: false
      });
    }

    return Response.json({ success: true, updated: messages.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});