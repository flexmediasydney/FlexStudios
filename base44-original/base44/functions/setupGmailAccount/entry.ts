import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    const { emailAddress, displayName, teamId, accessToken, refreshToken } = await req.json();

    if (!emailAddress || !refreshToken) {
      return Response.json({ 
        error: 'emailAddress and refreshToken are required. Use the Gmail OAuth connect flow in Inbox settings.' 
      }, { status: 400 });
    }

    // Check if account already exists
    const existing = await base44.entities.EmailAccount.filter({
      email_address: emailAddress,
      assigned_to_user_id: user.id
    });

    if (existing.length > 0) {
      return Response.json({ 
        error: 'This Gmail account is already connected to your account' 
      }, { status: 400 });
    }

    await base44.entities.EmailAccount.create({
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

    return Response.json({ 
      success: true,
      email: emailAddress,
      message: 'Gmail account connected successfully'
    });
  } catch (error) {
    console.error('setupGmailAccount error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});