import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * setupGmailAccount — registers an EmailAccount record for a user.
 *
 * This is called after the OAuth callback has already exchanged the code
 * and stored access_token + refresh_token on the EmailAccount entity.
 * This function exists as a fallback direct-call path; the primary flow
 * goes through handleGmailOAuthCallback which creates the record automatically.
 *
 * Expects: { emailAddress, displayName, teamId, accessToken, refreshToken }
 */
serveWithAudit('setupGmailAccount', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const { emailAddress, displayName, teamId, accessToken, refreshToken } = await req.json();

    if (!emailAddress || !refreshToken) {
      return errorResponse('emailAddress and refreshToken are required. Use the Gmail OAuth connect flow in Inbox settings.', 400);
    }

    // Check if account already exists
    const existing = await entities.EmailAccount.filter({
      email_address: emailAddress,
      assigned_to_user_id: user.id
    });

    if (existing.length > 0) {
      return errorResponse('This Gmail account is already connected to your account', 400);
    }

    await entities.EmailAccount.create({
      email_address: emailAddress,
      display_name: displayName || emailAddress,
      assigned_to_user_id: user.id,
      assigned_to_name: user.full_name,
      team_id: teamId || null,
      access_token: accessToken || null,
      refresh_token: refreshToken,
      is_active: true,
      last_sync: new Date().toISOString()
    });

    return jsonResponse({
      success: true,
      email: emailAddress,
      message: 'Gmail account connected successfully'
    });
  } catch (error) {
    console.error('setupGmailAccount error:', error);
    return errorResponse(error.message);
  }
});
