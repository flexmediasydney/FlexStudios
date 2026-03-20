import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

async function refreshAccessToken(account: any, entities: any): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }
  if (!account.refresh_token) {
    throw new Error('Gmail account has no refresh token');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${data.error || 'unknown'}`);
  }

  await entities.EmailAccount.update(account.id, { access_token: data.access_token });
  return data.access_token;
}

async function restoreInGmail(gmailMessageId: string, accessToken: string): Promise<boolean> {
  // Untrash the message
  const untrashRes = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}/untrash`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );

  if (!untrashRes.ok) return false;

  // Add INBOX label back
  const modifyRes = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}/modify`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ addLabelIds: ['INBOX'] }),
    }
  );

  return modifyRes.ok;
}

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

    // Verify the email account belongs to the authenticated user
    const accountCheck = await entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return errorResponse('Forbidden: you do not own this email account', 403);
    }

    const account = accountCheck[0];

    const messages = await entities.EmailMessage.filter({
      email_account_id: emailAccountId,
      gmail_thread_id: { '$in': threadIds }
    }, null, 1000);

    // Attempt Gmail sync
    let gmailErrors: string[] = [];
    let accessToken: string | null = null;

    try {
      accessToken = await refreshAccessToken(account, entities);
    } catch (err: any) {
      console.warn('Failed to get Gmail access token for restore sync:', err.message);
      gmailErrors.push(`Token refresh: ${err.message}`);
    }

    if (accessToken) {
      for (const msg of messages) {
        if (msg.gmail_message_id) {
          const ok = await restoreInGmail(msg.gmail_message_id, accessToken);
          if (!ok) {
            console.warn(`Failed to restore message ${msg.gmail_message_id} in Gmail`);
            gmailErrors.push(msg.gmail_message_id);
          }
        }
      }
    }

    // Always update local DB regardless of Gmail sync result
    for (const msg of messages) {
      await entities.EmailMessage.update(msg.id, {
        is_deleted: false,
        is_archived: false
      });
    }

    return jsonResponse({
      success: true,
      updated: messages.length,
      ...(gmailErrors.length > 0 ? { gmailSyncWarnings: gmailErrors } : {}),
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
