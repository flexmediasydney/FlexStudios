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

    const body = await req.json();
    const { threadIds, emailAccountId } = body;

    // Validate inputs
    if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0) {
      return Response.json({ error: 'threadIds must be a non-empty array' }, { status: 400 });
    }

    if (typeof emailAccountId !== 'string' || !emailAccountId.trim()) {
      return Response.json({ error: 'emailAccountId must be a non-empty string' }, { status: 400 });
    }

    // Validate all threadIds are strings
    if (!threadIds.every(id => typeof id === 'string' && id.trim())) {
      return Response.json({ error: 'All threadIds must be non-empty strings' }, { status: 400 });
    }

    const messages = await base44.asServiceRole.entities.EmailMessage.filter({
      email_account_id: emailAccountId.trim(),
      gmail_thread_id: { '$in': threadIds }
    });

    if (messages.length === 0) {
      return Response.json({ 
        success: true, 
        updated: 0,
        message: 'No messages found'
      });
    }

    let updated = 0;
    let failed = 0;

    for (const msg of messages) {
      try {
        // Skip if already unread
        if (msg.is_unread !== true) {
          await base44.asServiceRole.entities.EmailMessage.update(msg.id, {
            is_unread: true
          });
          updated++;
        }
      } catch (error) {
        console.error(`Failed to mark message ${msg.id} as unread:`, error);
        failed++;
      }
    }

    return Response.json({ 
      success: failed === 0,
      updated, 
      total: messages.length,
      failed
    });
  } catch (error) {
    console.error('Error marking emails as unread:', error);
    return Response.json({ error: 'Failed to mark emails as unread: ' + (error?.message || 'Unknown error') }, { status: 500 });
  }
});