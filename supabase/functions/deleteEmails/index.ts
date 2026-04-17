import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

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

async function trashInGmail(gmailMessageId: string, accessToken: string): Promise<{ ok: boolean; skipped: boolean }> {
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}/trash`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );
  // 404 means message already gone — treat as success
  if (res.status === 404) return { ok: true, skipped: true };
  return { ok: res.ok, skipped: false };
}

async function permanentDeleteInGmail(gmailMessageId: string, accessToken: string): Promise<{ ok: boolean; skipped: boolean }> {
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );
  // 404 means message already gone — treat as success
  if (res.status === 404) return { ok: true, skipped: true };
  // Gmail DELETE returns 204 No Content on success
  return { ok: res.ok, skipped: false };
}

serveWithAudit('deleteEmails', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401, req);
    }
    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403, req);
    }

    const { threadIds, emailAccountId, permanently = false } = await req.json();

    if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0) {
      return errorResponse('No emails to delete', 400, req);
    }
    if (!emailAccountId) {
      return errorResponse('emailAccountId is required', 400, req);
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

    // Get all messages for the given threads scoped to this account
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
      console.warn('Failed to get Gmail access token for delete sync:', err.message);
      gmailErrors.push(`Token refresh: ${err.message}`);
    }

    if (accessToken) {
      for (const msg of messages) {
        if (msg.gmail_message_id) {
          try {
            const result = permanently
              ? await permanentDeleteInGmail(msg.gmail_message_id, accessToken)
              : await trashInGmail(msg.gmail_message_id, accessToken);
            if (!result.ok) {
              console.warn(`Failed to ${permanently ? 'delete' : 'trash'} message ${msg.gmail_message_id} in Gmail`);
              gmailErrors.push(msg.gmail_message_id);
            }
            if (result.skipped) {
              console.info(`Message ${msg.gmail_message_id} not found in Gmail (already deleted)`);
            }
          } catch (err: any) {
            console.warn(`Gmail API error deleting ${msg.gmail_message_id}:`, err.message);
            gmailErrors.push(msg.gmail_message_id);
          }
        }
      }
    }

    // Always update local DB regardless of Gmail sync result
    if (permanently) {
      for (const msg of messages) {
        await entities.EmailMessage.delete(msg.id);
      }
    } else {
      for (const msg of messages) {
        await entities.EmailMessage.update(msg.id, { is_deleted: true });
      }
    }

    // Update conversation rows for all affected threads
    for (const threadId of threadIds) {
      try {
        const convos = await entities.EmailConversation.filter({
          email_account_id: emailAccountId,
          gmail_thread_id: threadId
        });
        for (const convo of convos) {
          if (permanently) {
            // Check if any messages remain for this conversation
            const remaining = await entities.EmailMessage.filter({
              email_account_id: emailAccountId,
              gmail_thread_id: threadId
            });
            if (remaining.length === 0) {
              await entities.EmailConversation.delete(convo.id);
            } else {
              await entities.EmailConversation.update(convo.id, { is_deleted: true });
            }
          } else {
            await entities.EmailConversation.update(convo.id, { is_deleted: true });
          }
        }
      } catch (err: any) {
        console.warn(`Failed to update conversation for thread ${threadId}:`, err.message);
      }
    }

    return jsonResponse({
      success: true,
      deletedCount: messages.length,
      ...(gmailErrors.length > 0 ? { gmailSyncWarnings: gmailErrors } : {}),
    }, 200, req);
  } catch (error: any) {
    console.error('Delete emails error:', error);
    return errorResponse(error.message, 500, req);
  }
});
