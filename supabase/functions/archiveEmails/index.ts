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

  // Persist refreshed token
  await entities.EmailAccount.update(account.id, { access_token: data.access_token });
  return data.access_token;
}

async function archiveInGmail(gmailMessageId: string, accessToken: string): Promise<{ ok: boolean; skipped: boolean }> {
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}/modify`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
    }
  );
  // 404 means message no longer exists in Gmail — treat as success (already archived/deleted)
  if (res.status === 404) return { ok: true, skipped: true };
  return { ok: res.ok, skipped: false };
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401, req);
    }
    if (!['master_admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403, req);
    }

    const { threadIds, emailAccountId } = await req.json();

    if (!threadIds || !Array.isArray(threadIds) || !emailAccountId) {
      return errorResponse('Invalid request: threadIds (array) and emailAccountId are required', 400, req);
    }

    // Verify the email account belongs to the authenticated user
    const accountCheck = await entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return errorResponse('Forbidden: you do not own this email account', 403, req);
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
      console.warn('Failed to get Gmail access token for archive sync:', err.message);
      gmailErrors.push(`Token refresh: ${err.message}`);
    }

    if (accessToken) {
      for (const msg of messages) {
        if (msg.gmail_message_id) {
          try {
            const result = await archiveInGmail(msg.gmail_message_id, accessToken);
            if (!result.ok) {
              console.warn(`Failed to archive message ${msg.gmail_message_id} in Gmail`);
              gmailErrors.push(msg.gmail_message_id);
            }
            if (result.skipped) {
              console.info(`Message ${msg.gmail_message_id} not found in Gmail (already archived/deleted)`);
            }
          } catch (err: any) {
            console.warn(`Gmail API error archiving ${msg.gmail_message_id}:`, err.message);
            gmailErrors.push(msg.gmail_message_id);
          }
        }
      }
    }

    // Always update local DB regardless of Gmail sync result
    for (const msg of messages) {
      await entities.EmailMessage.update(msg.id, { is_archived: true });
    }

    // Update conversation rows for all affected threads
    for (const threadId of threadIds) {
      try {
        const convos = await entities.EmailConversation.filter({
          email_account_id: emailAccountId,
          gmail_thread_id: threadId
        });
        for (const convo of convos) {
          await entities.EmailConversation.update(convo.id, { is_archived: true });
        }
      } catch (err: any) {
        console.warn(`Failed to update conversation for thread ${threadId}:`, err.message);
      }
    }

    return jsonResponse({
      success: true,
      updated: messages.length,
      ...(gmailErrors.length > 0 ? { gmailSyncWarnings: gmailErrors } : {}),
    }, 200, req);
  } catch (error: any) {
    return errorResponse(error.message, 500, req);
  }
});
