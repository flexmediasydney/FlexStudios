import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * Secure function to read emails with granular permission checks.
 * Guards against: unauthorized access, data leaks, N+1 queries
 */
serveWithAudit('secureEmailRead', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    const body = await req.json().catch(() => ({} as any));
    const { email_account_id, limit = 20 } = body;

    // Validate limit to prevent memory exhaustion
    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      return errorResponse('Invalid limit. Must be 1-500.', 400, req);
    }

    if (!email_account_id || typeof email_account_id !== 'string') {
      return errorResponse('email_account_id is required', 400, req);
    }

    // CRITICAL: Verify user owns this email account
    const accounts = await entities.EmailAccount.filter({
      id: email_account_id,
      assigned_to_user_id: user.id
    });

    if (!accounts || accounts.length === 0) {
      // Return 403 (Forbidden) not 404 to avoid leaking existence of email accounts
      return errorResponse('Access denied', 403);
    }

    // Safe fetch — use admin client directly so we can use .or() for null/false is_deleted
    const { data: emails, error: fetchError } = await admin
      .from('email_messages')
      .select('id, from, from_name, to, subject, received_at, is_unread, is_starred, project_id, priority')
      .eq('email_account_id', email_account_id)
      .or('is_deleted.is.null,is_deleted.eq.false')
      .order('received_at', { ascending: false })
      .limit(limit);

    if (fetchError) {
      console.error('Error fetching emails:', fetchError);
      return errorResponse('Failed to fetch emails', 500);
    }

    // Response is already sanitized via explicit select() — no body, tokens, etc.
    return jsonResponse({ success: true, emails: emails || [] });
  } catch (error: any) {
    console.error('Error reading emails:', error);
    return errorResponse('Internal server error');
  }
});
