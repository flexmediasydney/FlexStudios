import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }
    if (!['master_admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    const body = await req.json();
    const { threadIds, emailAccountId } = body;

    if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0) {
      return errorResponse('threadIds must be a non-empty array', 400);
    }
    if (typeof emailAccountId !== 'string' || !emailAccountId.trim()) {
      return errorResponse('emailAccountId must be a non-empty string', 400);
    }
    if (!threadIds.every((id: any) => typeof id === 'string' && id.trim())) {
      return errorResponse('All threadIds must be non-empty strings', 400);
    }

    const messages = await entities.EmailMessage.filter({
      email_account_id: emailAccountId.trim(),
      gmail_thread_id: { '$in': threadIds }
    });

    if (messages.length === 0) {
      return jsonResponse({ success: true, updated: 0, message: 'No messages found' });
    }

    let updated = 0;
    let failed = 0;

    for (const msg of messages) {
      try {
        if (msg.is_unread !== false) {
          await entities.EmailMessage.update(msg.id, { is_unread: false });
          updated++;
        }
      } catch (error) {
        console.error(`Failed to mark message ${msg.id} as read:`, error);
        failed++;
      }
    }

    return jsonResponse({ success: failed === 0, updated, total: messages.length, failed });
  } catch (error: any) {
    console.error('Error marking emails as read:', error);
    return errorResponse('Failed to mark emails as read: ' + (error?.message || 'Unknown error'));
  }
});
