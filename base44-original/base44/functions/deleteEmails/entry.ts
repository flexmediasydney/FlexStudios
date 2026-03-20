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

    const { threadIds, emailAccountId, permanently = false } = await req.json();

    if (!threadIds || threadIds.length === 0) {
      return Response.json({ error: 'No emails to delete' }, { status: 400 });
    }

    // Verify the email account belongs to the authenticated user
    const accountCheck = await base44.entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return Response.json({ error: 'Forbidden: you do not own this email account' }, { status: 403 });
    }

    // Get all messages for the given threads scoped to this account
    const messages = await base44.entities.EmailMessage.filter({
      email_account_id: emailAccountId,
      gmail_thread_id: { '$in': threadIds }
    }, null, 1000);

    const messagesToDelete = messages.filter(m => threadIds.includes(m.gmail_thread_id));

    if (permanently) {
      // Hard delete from database
      for (const msg of messagesToDelete) {
        await base44.entities.EmailMessage.delete(msg.id);
      }
    } else {
      // Soft delete - mark as deleted
      for (const msg of messagesToDelete) {
        await base44.entities.EmailMessage.update(msg.id, { is_deleted: true });
      }
    }

    return Response.json({ success: true, deletedCount: messagesToDelete.length });
  } catch (error) {
    console.error('Delete emails error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});