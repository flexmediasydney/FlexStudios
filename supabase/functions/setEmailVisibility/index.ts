import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('setEmailVisibility', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);

    const { threadIds, emailAccountId, visibility } = await req.json();

    if (!threadIds || !Array.isArray(threadIds) || !emailAccountId || !visibility) {
      return errorResponse('Invalid request', 400);
    }

    const validVisibilities = ['private', 'shared', 'team', 'public'];
    if (!validVisibilities.includes(visibility)) {
      return errorResponse('Invalid visibility value', 400);
    }

    // Verify account ownership
    const accountCheck = await entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return errorResponse('Forbidden: you do not own this email account', 403);
    }

    const messages = await entities.EmailMessage.filter({
      email_account_id: emailAccountId,
      gmail_thread_id: { $in: threadIds },
    });

    for (const msg of messages) {
      await entities.EmailMessage.update(msg.id, {
        visibility,
      });
    }

    return jsonResponse({ success: true, updated: messages.length });

  } catch (err: any) {
    return errorResponse(err.message);
  }
});
