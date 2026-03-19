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
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const { threadIds, emailAccountId } = await req.json();

    if (!threadIds || !Array.isArray(threadIds) || !emailAccountId) {
      return errorResponse('Invalid request', 400);
    }

    const messages = await entities.EmailMessage.filter({
      email_account_id: emailAccountId,
      gmail_thread_id: { '$in': threadIds }
    });

    for (const msg of messages) {
      await entities.EmailMessage.update(msg.id, {
        is_deleted: false,
        is_archived: false
      });
    }

    return jsonResponse({ success: true, updated: messages.length });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
