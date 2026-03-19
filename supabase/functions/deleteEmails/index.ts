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

    const { threadIds, emailAccountId, permanently = false } = await req.json();

    if (!threadIds || threadIds.length === 0) {
      return errorResponse('No emails to delete', 400);
    }

    // Verify the email account belongs to the authenticated user
    const accountCheck = await entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return errorResponse('Forbidden: you do not own this email account', 403);
    }

    // Get all messages for the given threads scoped to this account
    const messages = await entities.EmailMessage.filter({
      email_account_id: emailAccountId,
      gmail_thread_id: { '$in': threadIds }
    }, null, 1000);

    const messagesToDelete = messages.filter((m: any) => threadIds.includes(m.gmail_thread_id));

    if (permanently) {
      // Hard delete from database
      for (const msg of messagesToDelete) {
        await entities.EmailMessage.delete(msg.id);
      }
    } else {
      // Soft delete - mark as deleted
      for (const msg of messagesToDelete) {
        await entities.EmailMessage.update(msg.id, { is_deleted: true });
      }
    }

    return jsonResponse({ success: true, deletedCount: messagesToDelete.length });
  } catch (error: any) {
    console.error('Delete emails error:', error);
    return errorResponse(error.message);
  }
});
