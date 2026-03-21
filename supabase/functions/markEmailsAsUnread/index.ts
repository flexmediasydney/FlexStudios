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

    const body = await req.json();
    const { threadIds, emailAccountId } = body;

    if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0) {
      return errorResponse('threadIds must be a non-empty array', 400);
    }
    if (typeof emailAccountId !== 'string' || !emailAccountId.trim()) {
      return errorResponse('emailAccountId must be a non-empty string', 400);
    }

    // Verify the email account belongs to the authenticated user
    const accountCheck = await entities.EmailAccount.filter({
      id: emailAccountId.trim(),
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return errorResponse('Forbidden: you do not own this email account', 403);
    }
    const account = accountCheck[0];

    const messages = await entities.EmailMessage.filter({
      email_account_id: emailAccountId.trim(),
      gmail_thread_id: { '$in': threadIds }
    });

    if (messages.length === 0) {
      return jsonResponse({ success: true, updated: 0, message: 'No messages found' });
    }

    // Refresh Gmail access token for syncing unread state
    let accessToken: string | null = null;
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

    if (clientId && clientSecret && account.refresh_token) {
      try {
        const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: account.refresh_token,
            grant_type: 'refresh_token'
          })
        });
        const tokenData = await refreshResponse.json();
        if (tokenData.access_token) {
          accessToken = tokenData.access_token;
          await entities.EmailAccount.update(account.id, { access_token: accessToken });
        }
      } catch (e) {
        console.error('Token refresh failed, continuing with local-only update:', e);
      }
    }

    let updated = 0;
    let failed = 0;
    let gmailSynced = 0;

    for (const msg of messages) {
      try {
        if (msg.is_unread !== true) {
          await entities.EmailMessage.update(msg.id, { is_unread: true });
          updated++;

          // Sync to Gmail — add UNREAD label
          if (accessToken && msg.gmail_message_id) {
            try {
              const gmailRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.gmail_message_id}/modify`,
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ addLabelIds: ['UNREAD'] }),
                }
              );
              if (gmailRes.ok) gmailSynced++;
            } catch (e) {
              console.error(`Gmail sync failed for ${msg.gmail_message_id}:`, e);
            }
          }
        }
      } catch (error) {
        console.error(`Failed to mark message ${msg.id} as unread:`, error);
        failed++;
      }
    }

    return jsonResponse({ success: failed === 0, updated, total: messages.length, failed, gmailSynced });
  } catch (error: any) {
    console.error('Error marking emails as unread:', error);
    return errorResponse('Failed to mark emails as unread: ' + (error?.message || 'Unknown error'));
  }
});
