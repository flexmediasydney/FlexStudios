import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

// --- Agent lookup cache (per sync cycle) ---
const agentCache = new Map<string, any>();

async function findAgentByEmail(adminClient: any, email: string) {
  const key = email.toLowerCase();
  if (agentCache.has(key)) return agentCache.get(key);
  try {
    const { data } = await adminClient
      .from('agents')
      .select('id, name, current_agency_id, current_agency_name')
      .ilike('email', key)
      .limit(1)
      .single();
    agentCache.set(key, data || null);
    return data || null;
  } catch {
    agentCache.set(key, null);
    return null;
  }
}

function extractEmailAddress(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

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
    try { return atob(data.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
  };
  const walk = (part: any): { html: string; text: string } => {
    if (!part) return { html: '', text: '' };
    if (part.mimeType === 'text/html' && part.body?.data) return { html: decode(part.body.data), text: '' };
    if (part.mimeType === 'text/plain' && part.body?.data) return { html: '', text: decode(part.body.data) };
    if (part.parts && part.parts.length > 0) {
      let html = '', text = '';
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
      attachments.push({ filename: part.filename, mime_type: part.mimeType, size: part.size || 0, attachment_id: part.body.attachmentId });
    }
  }
  return attachments;
};

const parseHeaders = (headers: any[]) => {
  const parsed: Record<string, string> = {};
  for (const header of headers) parsed[header.name] = header.value;
  return parsed;
};

const refreshAccessToken = async (clientId: string, clientSecret: string, refreshToken: string) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const data = await response.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${data.error || 'unknown error'}`);
  return data.access_token;
};

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { accountId, userId } = await req.json();

    // Clear agent lookup cache for this sync cycle
    agentCache.clear();

    if (!accountId || !userId) {
      return errorResponse('Missing accountId or userId', 400);
    }

    // Verify user authentication
    const user = await getUserFromReq(req);
    if (!user || user.id !== userId) {
      return errorResponse('Unauthorized', 403);
    }

    if (!['master_admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    // Get the specific email account (verify ownership)
    const accounts = await entities.EmailAccount.filter({
      id: accountId,
      assigned_to_user_id: userId,
      is_active: true
    });

    if (accounts.length === 0) {
      return jsonResponse({ synced: 0, error: 'Account not found or inactive' });
    }

    const account = accounts[0];
    let synced = 0;

    try {
      const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
      const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

      if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in environment secrets');
      }

      if (!account.refresh_token) {
        throw new Error('No refresh token stored — user must reconnect their Gmail account');
      }

      const accessToken = await refreshAccessToken(clientId, clientSecret, account.refresh_token);

      // Write refreshed token back to entity
      await entities.EmailAccount.update(account.id, { access_token: accessToken });

      // Build query based on last sync
      let query = '';
      if (account.last_sync) {
        const lastSyncDate = new Date(account.last_sync);
        const syncFromDate = new Date(lastSyncDate.getTime() - 5 * 60 * 1000);
        const timestamp = Math.floor(syncFromDate.getTime() / 1000);
        query = `after:${timestamp}`;
      } else if (account.sync_start_date) {
        const date = new Date(account.sync_start_date);
        const timestamp = Math.floor(date.getTime() / 1000);
        query = `after:${timestamp}`;
      } else {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        query = `after:${Math.floor(thirtyDaysAgo.getTime() / 1000)}`;
      }

      const listResponse = await retryFetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=100`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (!listResponse.ok) {
        throw new Error(`Gmail API error: ${listResponse.status}`);
      }

      const data = await listResponse.json();
      const messageIds = data.messages || [];

      // Process in batches
      for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
        const batch = messageIds.slice(i, i + BATCH_SIZE);

        for (const msg of batch) {
          try {
            const existing = await entities.EmailMessage.filter({
              gmail_message_id: msg.id,
              email_account_id: account.id
            }, null, 1);

            if (existing.length === 0) {
              // Inherit project link from sibling messages in same thread
              let threadProjectLink: any = null;
              try {
                const siblings = await entities.EmailMessage.filter({
                  email_account_id: account.id,
                  gmail_thread_id: msg.threadId
                }, null, 1);
                const linked = siblings.find((m: any) => m.project_id);
                if (linked) threadProjectLink = { project_id: linked.project_id, project_title: linked.project_title || null };
              } catch { /* non-fatal */ }

              // Fetch full message
              const msgResponse = await retryFetch(
                `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
                { headers: { 'Authorization': `Bearer ${accessToken}` } }
              );

              if (msgResponse.ok) {
                const fullMsg = await msgResponse.json();
                const headers = parseHeaders(fullMsg.payload.headers || []);
                const isSent = fullMsg.labelIds?.includes('SENT');

                // Agent/agency auto-linking
                const fromEmail = extractEmailAddress(headers['From'] || '');
                const agentMatch = fromEmail ? await findAgentByEmail(admin, fromEmail) : null;

                // Save message with proper visibility field
                const savedMessage = await entities.EmailMessage.create({
                  email_account_id: account.id,
                  gmail_message_id: fullMsg.id,
                  gmail_thread_id: fullMsg.threadId,
                  from: headers['From'] || 'unknown@unknown.com',
                  from_name: headers['From']?.split('<')[0].trim() || 'Unknown',
                  to: (headers['To'] || '').split(',').filter(Boolean).map((e: string) => e.trim()),
                  cc: (headers['Cc'] || '').split(',').filter(Boolean).map((e: string) => e.trim()),
                  subject: headers['Subject'] || '(no subject)',
                  body: extractEmailBody(fullMsg.payload),
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
                  } : {}),
                  ...(agentMatch ? {
                    agent_id: agentMatch.id,
                    agent_name: agentMatch.name,
                    agency_id: agentMatch.current_agency_id || null,
                    agency_name: agentMatch.current_agency_name || null,
                  } : {})
                });

                // Email-05: Fire notification on new inbound email
                if (!isSent) {
                  try {
                    const fromRaw = headers['From'] || '';
                    const emailMatch = fromRaw.match(/<([^>]+)>/);
                    const fromAddress = emailMatch ? emailMatch[1] : fromRaw.trim();
                    const displayName = emailMatch ? fromRaw.replace(/<[^>]+>/, '').trim() : fromRaw;

                    let notifyUserIds = new Set<string>();
                    if (threadProjectLink?.project_id) {
                      const project = await entities.Project.get(threadProjectLink.project_id).catch(() => null);
                      if (project?.project_owner_id) notifyUserIds.add(project.project_owner_id);
                    }

                    if (notifyUserIds.size > 0) {
                      const idemKey = `email_received:${fullMsg.threadId}:${fromAddress}`;
                      for (const notifUserId of notifyUserIds) {
                        await invokeFunction('notificationService', {
                          action: 'create',
                          userId: notifUserId,
                          type: 'email_received_from_client',
                          category: 'email',
                          severity: 'info',
                          title: `Email from ${displayName}${threadProjectLink?.project_title ? ` re: ${threadProjectLink.project_title}` : ''}`,
                          message: headers['Subject'] || '(no subject)',
                          projectId: threadProjectLink?.project_id,
                          projectName: threadProjectLink?.project_title,
                          ctaLabel: 'View Email',
                          source: 'email_sync',
                          idempotencyKey: idemKey,
                        }).catch(() => {});
                      }
                    }
                  } catch { /* non-fatal */ }
                }

                synced++;
              }
            }

            // Rate limiting
            await sleep(GMAIL_RATE_LIMIT_DELAY);
          } catch (error: any) {
            console.error(`Error processing message ${msg.id}:`, error);
          }
        }
      }

      // ─── Upsert email_conversations summary table ─────────────────────────
      try {
        const { data: threadMessages } = await admin
          .from('email_messages')
          .select('gmail_thread_id, subject, from, from_name, is_unread, is_starred, received_at, attachments, project_id, project_title, agent_id, agency_id, to, cc')
          .eq('email_account_id', account.id)
          .order('received_at', { ascending: false });

        if (threadMessages && threadMessages.length > 0) {
          const threads = new Map<string, any[]>();
          for (const msg of threadMessages) {
            const tid = msg.gmail_thread_id;
            if (!threads.has(tid)) threads.set(tid, []);
            threads.get(tid)!.push(msg);
          }

          const conversationRows: any[] = [];
          for (const [threadId, msgs] of threads) {
            const latest = msgs[0];
            const oldest = msgs[msgs.length - 1];
            const participantSet = new Set<string>();
            let hasAttachments = false;
            for (const m of msgs) {
              if (m.from) participantSet.add(m.from);
              if (Array.isArray(m.to)) m.to.forEach((e: string) => participantSet.add(e));
              if (Array.isArray(m.cc)) m.cc.forEach((e: string) => participantSet.add(e));
              if (m.attachments && Array.isArray(m.attachments) && m.attachments.length > 0) hasAttachments = true;
            }
            const linkedMsg = msgs.find((m: any) => m.project_id);
            conversationRows.push({
              email_account_id: account.id,
              gmail_thread_id: threadId,
              subject: latest.subject,
              snippet: (latest.subject || '').substring(0, 200),
              first_message_at: oldest.received_at,
              last_message_at: latest.received_at,
              message_count: msgs.length,
              unread_count: msgs.filter((m: any) => m.is_unread).length,
              participant_count: participantSet.size,
              participants: JSON.stringify([...participantSet]),
              is_starred: msgs.some((m: any) => m.is_starred),
              has_attachments: hasAttachments,
              last_sender: latest.from,
              last_sender_name: latest.from_name,
              project_id: linkedMsg?.project_id || null,
              project_title: linkedMsg?.project_title || null,
              agent_id: linkedMsg?.agent_id || null,
              agency_id: linkedMsg?.agency_id || null,
            });
          }
          for (let i = 0; i < conversationRows.length; i += 50) {
            const batch = conversationRows.slice(i, i + 50);
            await admin
              .from('email_conversations')
              .upsert(batch, { onConflict: 'email_account_id,gmail_thread_id' });
          }
        }
      } catch (convError: any) {
        console.error('Error upserting email_conversations:', convError?.message);
      }

      // Update account metadata with rich sync metrics (Email-04)
      await entities.EmailAccount.update(account.id, {
        last_sync: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        last_sync_message_count: synced,
        total_synced_count: (account.total_synced_count || 0) + synced,
        sync_error_count: 0,
        last_sync_error: null,
        sync_health: 'ok',
      });

    } catch (error: any) {
      console.error(`Error syncing account ${account.email_address}:`, error);

      // Write error metrics on sync failure (Email-04)
      try {
        const newErrorCount = (account.sync_error_count || 0) + 1;
        await entities.EmailAccount.update(account.id, {
          last_sync_error: error?.message || 'Unknown sync error',
          sync_error_count: newErrorCount,
          sync_health: newErrorCount >= 3 ? 'error' : 'warning',
        }).catch(() => {});
      } catch { /* non-fatal */ }

      throw error;
    }

    return jsonResponse({
      synced,
      accountEmail: account.email_address
    });
  } catch (error: any) {
    console.error('Account sync error:', error);
    return errorResponse(error.message);
  }
});
