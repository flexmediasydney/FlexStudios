import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const BATCH_SIZE = 10;
const GMAIL_RATE_LIMIT_DELAY = 100;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryFetch = async (url: string, options: any, retries = MAX_RETRIES) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5') * 1000;
        await sleep(retryAfter);
        continue;
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(RETRY_DELAY_MS * Math.pow(2, i));
    }
  }
};

const extractEmailBody = (payload: any) => {
  const decode = (data: string) => {
    try {
      return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      return '';
    }
  };

  const walk = (part: any): { html: string; text: string } => {
    if (!part) return { html: '', text: '' };
    if (part.mimeType === 'text/html' && part.body?.data) {
      return { html: decode(part.body.data), text: '' };
    }
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return { html: '', text: decode(part.body.data) };
    }
    if (part.parts && part.parts.length > 0) {
      let html = '';
      let text = '';
      for (const child of part.parts) {
        const result = walk(child);
        if (result.html) html = result.html;
        if (result.text) text = result.text;
      }
      return { html, text };
    }
    return { html: '', text: '' };
  };

  const { html, text } = walk(payload);
  if (html) return html;
  if (text) return `<pre style="white-space:pre-wrap;font-family:inherit;font-size:inherit">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  return '';
};

const extractAttachments = (payload: any) => {
  const attachments: any[] = [];
  if (!payload.parts) return attachments;
  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mime_type: part.mimeType,
        size: part.size || 0,
        attachment_id: part.body.attachmentId
      });
    }
  }
  return attachments;
};

const parseHeaders = (headers: any[]) => {
  const parsed: Record<string, string> = {};
  for (const header of headers) {
    parsed[header.name] = header.value;
  }
  return parsed;
};

const fetchMessageDetails = async (accessToken: string, messageId: string) => {
  const response = await retryFetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch message ${messageId}: ${response.status}`);
  }
  return response.json();
};

const getMessageQuery = (account: any) => {
  if (!account.last_sync && account.sync_start_date) {
    const date = new Date(account.sync_start_date);
    const timestamp = Math.floor(date.getTime() / 1000);
    return `after:${timestamp}`;
  }
  if (account.last_sync) {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const timestamp = Math.floor(oneDayAgo.getTime() / 1000);
    return `after:${timestamp}`;
  }
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const timestamp = Math.floor(sevenDaysAgo.getTime() / 1000);
  return `after:${timestamp}`;
};

const refreshAccessToken = async (clientId: string, clientSecret: string, refreshToken: string) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${data.error || 'unknown error'}`);
  }
  return data.access_token;
};

const messageExists = async (entities: any, account: any, gmailMessageId: string, retriesLeft = 2): Promise<boolean> => {
  try {
    const existing = await entities.EmailMessage.filter({
      gmail_message_id: gmailMessageId,
      email_account_id: account.id
    }, null, 1);
    return existing.length > 0;
  } catch (error: any) {
    if (error.status === 429 && retriesLeft > 0) {
      await sleep(Math.pow(2, 2 - retriesLeft) * 50);
      return messageExists(entities, account, gmailMessageId, retriesLeft - 1);
    }
    console.error('Error checking message existence:', error);
    return false;
  }
};

const getThreadProjectLink = async (entities: any, account: any, threadId: string) => {
  try {
    const existing = await entities.EmailMessage.filter({
      email_account_id: account.id,
      gmail_thread_id: threadId
    }, null, 1);
    const linked = existing.find((m: any) => m.project_id);
    if (linked) {
      return { project_id: linked.project_id, project_title: linked.project_title || null };
    }
    return null;
  } catch {
    return null;
  }
};

const saveMessage = async (entities: any, account: any, fullMsg: any, headers: any, retriesLeft = 2): Promise<boolean> => {
  try {
    const rawBody = extractEmailBody(fullMsg.payload);
    const MAX_BODY_SIZE = 10000;

    let body = rawBody;
    if (rawBody.length > MAX_BODY_SIZE) {
      body = rawBody.substring(0, MAX_BODY_SIZE) +
        '\n\n<div style="margin-top: 20px; padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; color: #856404;">' +
        '<strong>Email Truncated</strong><br/>' +
        'This message exceeded 10KB and was shortened. View in Gmail for the complete email.' +
        '</div>';
    }

    const threadProjectLink = await getThreadProjectLink(entities, account, fullMsg.threadId);

    await entities.EmailMessage.create({
      email_account_id: account.id,
      gmail_message_id: fullMsg.id,
      gmail_thread_id: fullMsg.threadId,
      from: headers['From'] || 'unknown@unknown.com',
      from_name: headers['From']?.split('<')[0].trim() || 'Unknown',
      to: (headers['To'] || '').split(',').filter(Boolean).map((e: string) => e.trim()),
      cc: (headers['Cc'] || '').split(',').filter(Boolean).map((e: string) => e.trim()),
      subject: headers['Subject'] || '(no subject)',
      body,
      is_unread: fullMsg.labelIds?.includes('UNREAD') || false,
      is_starred: fullMsg.labelIds?.includes('STARRED') || false,
      is_draft: fullMsg.labelIds?.includes('DRAFT') || false,
      is_sent: fullMsg.labelIds?.includes('SENT') || false,
      attachments: extractAttachments(fullMsg.payload),
      received_at: new Date(parseInt(fullMsg.internalDate)).toISOString(),
      visibility: 'private',
      ...(threadProjectLink ? {
        project_id: threadProjectLink.project_id,
        project_title: threadProjectLink.project_title,
        visibility: 'shared'
      } : {})
    });
    return true;
  } catch (error: any) {
    if (error.status === 429 && retriesLeft > 0) {
      await sleep(Math.pow(2, 2 - retriesLeft) * 50);
      return saveMessage(entities, account, fullMsg, headers, retriesLeft - 1);
    }
    if (error.message?.includes('exceeds the maximum allowed size')) {
      return false;
    }
    return false;
  }
};

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

    const retryWithBackoff = async (fn: () => Promise<any>, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: any) {
          if (err.status === 429 && attempt < maxRetries) {
            await sleep(Math.pow(2, attempt) * 50);
            continue;
          }
          throw err;
        }
      }
    };

    const emailAccounts = await retryWithBackoff(() =>
      entities.EmailAccount.filter({
        assigned_to_user_id: user.id,
        is_active: true
      }, '-last_sync', 1000)
    );

    if (emailAccounts.length === 0) {
      return jsonResponse({
        synced: 0,
        accounts: 0,
        message: 'No email accounts configured'
      });
    }

    const results: any = {
      synced: 0,
      accounts: 0,
      accountDetails: [] as any[],
      errors: [] as string[]
    };

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      return errorResponse('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in environment secrets', 500);
    }

    for (const account of emailAccounts) {
      let accountSynced = 0;

      try {
        if (!account.refresh_token) {
          throw new Error('No refresh token stored for this account — user must reconnect their Gmail account');
        }

        let accessToken = await refreshAccessToken(clientId, clientSecret, account.refresh_token);

        await retryWithBackoff(() =>
          entities.EmailAccount.update(account.id, { access_token: accessToken })
        );

        const query = getMessageQuery(account);

        let messageIds: any[] = [];
        let pageToken: string | null = null;
        const MAX_MESSAGES_PER_SYNC = 500;

        do {
          const url = new URL('https://www.googleapis.com/gmail/v1/users/me/messages');
          url.searchParams.append('q', query);
          url.searchParams.append('maxResults', '100');
          if (pageToken) url.searchParams.append('pageToken', pageToken);

          const listResponse = await retryFetch(
            url.toString(),
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
          );

          if (!listResponse.ok) {
            const errorText = await listResponse.text();
            throw new Error(`Gmail API list error: ${listResponse.status} - ${errorText}`);
          }

          const data = await listResponse.json();
          const newMessages = data.messages || [];
          messageIds = messageIds.concat(newMessages);
          pageToken = data.nextPageToken;

          if (messageIds.length >= MAX_MESSAGES_PER_SYNC) {
            messageIds = messageIds.slice(0, MAX_MESSAGES_PER_SYNC);
            break;
          }

          if (pageToken) await sleep(GMAIL_RATE_LIMIT_DELAY * 2);
        } while (pageToken);

        const processedIds = new Set();

        for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
          const batch = messageIds.slice(i, i + BATCH_SIZE);

          for (const msg of batch) {
            if (processedIds.has(msg.id)) continue;
            processedIds.add(msg.id);

            try {
              const exists = await messageExists(entities, account, msg.id);

              if (!exists) {
                const fullMsg = await fetchMessageDetails(accessToken, msg.id);
                const hdrs = parseHeaders(fullMsg.payload.headers || []);

                const saved = await saveMessage(entities, account, fullMsg, hdrs);
                if (saved) {
                  accountSynced++;
                }
              }

              await sleep(GMAIL_RATE_LIMIT_DELAY);
            } catch (error: any) {
              results.errors.push(`Message ${msg.id}: ${error.message}`);
            }
          }
        }

        await retryWithBackoff(() =>
          entities.EmailAccount.update(account.id, {
            last_sync: new Date().toISOString()
          })
        );

        results.synced += accountSynced;
        results.accounts++;
        results.accountDetails.push({
          email: account.email_address,
          synced: accountSynced,
          status: 'success'
        });

      } catch (error: any) {
        results.accountDetails.push({
          email: account.email_address,
          synced: 0,
          status: 'error',
          error: error.message
        });
        results.errors.push(`${account.email_address}: ${error.message}`);
      }
    }

    return jsonResponse({
      ...results,
      message: `Synced ${results.synced} messages from ${results.accounts} accounts`,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Sync error:', error);
    return errorResponse(error.message);
  }
});
