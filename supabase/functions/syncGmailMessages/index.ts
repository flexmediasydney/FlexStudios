import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

// --- Agent lookup cache (per sync cycle, scoped per request to avoid leaking between concurrent requests) ---
let agentCache = new Map<string, any>();

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

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const BATCH_SIZE = 10;
const GMAIL_RATE_LIMIT_DELAY = 100;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryFetch = async (url: string, options: any, retries = MAX_RETRIES): Promise<Response> => {
  let lastResponse: Response | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        lastResponse = response;
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
  if (lastResponse) return lastResponse;
  throw new Error('retryFetch: all retries exhausted with no response');
};

const extractEmailBody = (payload: any) => {
  const decode = (data: string) => {
    try {
      // Decode base64url → binary → UTF-8 (atob alone corrupts non-ASCII)
      const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
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
  const walkParts = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mime_type: part.mimeType,
        size: part.size || 0,
        attachment_id: part.body.attachmentId
      });
    }
    if (part.parts) {
      for (const child of part.parts) {
        walkParts(child);
      }
    }
  };
  walkParts(payload);
  return attachments;
};

const parseHeaders = (headers: any[]) => {
  const parsed: Record<string, string> = {};
  if (!Array.isArray(headers)) return parsed;
  for (const header of headers) {
    if (header?.name) parsed[header.name] = header.value ?? '';
  }
  return parsed;
};

const fetchMessageDetails = async (accessToken: string, messageId: string) => {
  const response = await retryFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
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

const refreshAccessToken = async (clientId: string, clientSecret: string, refreshToken: string): Promise<{ access_token: string; refresh_token?: string }> => {
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
  // Google may rotate the refresh token — if a new one is returned, we must store it
  return { access_token: data.access_token, refresh_token: data.refresh_token || undefined };
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

const saveMessage = async (entities: any, account: any, fullMsg: any, headers: any, adminClient?: any, retriesLeft = 2): Promise<boolean> => {
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

    // Agent/agency auto-linking
    const fromEmail = extractEmailAddress(headers['From'] || '');
    const agentMatch = (fromEmail && adminClient) ? await findAgentByEmail(adminClient, fromEmail) : null;

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
      visibility: account.default_visibility || 'private',
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
    return true;
  } catch (error: any) {
    if (error.status === 429 && retriesLeft > 0) {
      await sleep(Math.pow(2, 2 - retriesLeft) * 50);
      return saveMessage(entities, account, fullMsg, headers, adminClient, retriesLeft - 1);
    }
    if (error.message?.includes('exceeds the maximum allowed size')) {
      return false;
    }
    return false;
  }
};

// --- Full sync: list messages via query, fetch new ones ---
async function fullSyncAccount(
  accessToken: string,
  account: any,
  entities: any,
  admin: any,
  results: any,
): Promise<{ synced: number; latestHistoryId: string | null }> {
  let accountSynced = 0;
  let latestHistoryId: string | null = null;

  const query = getMessageQuery(account);

  let messageIds: any[] = [];
  let pageToken: string | null = null;
  const MAX_MESSAGES_PER_SYNC = 500;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.append('q', query);
    url.searchParams.append('maxResults', '100');
    if (pageToken) url.searchParams.append('pageToken', pageToken);

    const listResponse = await retryFetch(
      url.toString(),
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (!listResponse || !listResponse.ok) {
      const errorText = listResponse ? await listResponse.text() : 'no response';
      throw new Error(`Gmail API list error: ${listResponse?.status} - ${errorText}`);
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

  // Get historyId from the first (most recent) message or from profile
  if (messageIds.length > 0) {
    const firstMsgResponse = await retryFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageIds[0].id}?format=metadata&metadataHeaders=Subject`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (firstMsgResponse && firstMsgResponse.ok) {
      const firstMsg = await firstMsgResponse.json();
      latestHistoryId = firstMsg.historyId || null;
    }
  } else {
    const profileResponse = await retryFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/profile`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (profileResponse && profileResponse.ok) {
      const profile = await profileResponse.json();
      latestHistoryId = profile.historyId || null;
    }
  }

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

          const saved = await saveMessage(entities, account, fullMsg, hdrs, admin);
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

  return { synced: accountSynced, latestHistoryId };
}

// --- Incremental sync via Gmail History API ---
async function syncViaHistory(
  accessToken: string,
  account: any,
  entities: any,
  admin: any,
  results: any,
): Promise<{ synced: number; latestHistoryId: string | null; fallbackToFull: boolean }> {
  let synced = 0;
  let latestHistoryId: string | null = account.history_id;

  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
  url.searchParams.append('startHistoryId', account.history_id);
  url.searchParams.append('historyTypes', 'messageAdded');
  url.searchParams.append('historyTypes', 'messageDeleted');
  url.searchParams.append('historyTypes', 'labelAdded');
  url.searchParams.append('historyTypes', 'labelRemoved');
  url.searchParams.append('maxResults', '500');

  const historyResponse = await retryFetch(
    url.toString(),
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!historyResponse) {
    return { synced: 0, latestHistoryId: null, fallbackToFull: true };
  }

  // 404 means the historyId is too old — fall back to full sync
  if (historyResponse.status === 404) {
    console.log(`History ID ${account.history_id} expired for account ${account.email_address}, falling back to full sync`);
    return { synced: 0, latestHistoryId: null, fallbackToFull: true };
  }

  if (!historyResponse.ok) {
    throw new Error(`Gmail History API error: ${historyResponse.status}`);
  }

  const historyData = await historyResponse.json();
  latestHistoryId = historyData.historyId || latestHistoryId;

  const historyRecords = historyData.history || [];

  if (historyRecords.length === 0) {
    return { synced: 0, latestHistoryId, fallbackToFull: false };
  }

  // Collect all message IDs that were added, deleted, or had label changes
  const addedMessageIds = new Set<string>();
  const deletedMessageIds = new Set<string>();
  const labelChangedMessageIds = new Set<string>();

  for (const record of historyRecords) {
    if (record.messagesAdded) {
      for (const added of record.messagesAdded) {
        addedMessageIds.add(added.message.id);
      }
    }
    if (record.messagesDeleted) {
      for (const deleted of record.messagesDeleted) {
        deletedMessageIds.add(deleted.message.id);
      }
    }
    if (record.labelsAdded) {
      for (const changed of record.labelsAdded) {
        labelChangedMessageIds.add(changed.message.id);
      }
    }
    if (record.labelsRemoved) {
      for (const changed of record.labelsRemoved) {
        labelChangedMessageIds.add(changed.message.id);
      }
    }
  }

  // Remove from "added" if also deleted
  for (const id of deletedMessageIds) {
    addedMessageIds.delete(id);
  }

  // Process new messages
  const addedList = [...addedMessageIds];
  for (let i = 0; i < addedList.length; i += BATCH_SIZE) {
    const batch = addedList.slice(i, i + BATCH_SIZE);
    for (const msgId of batch) {
      try {
        const exists = await messageExists(entities, account, msgId);
        if (!exists) {
          const fullMsg = await fetchMessageDetails(accessToken, msgId);
          const hdrs = parseHeaders(fullMsg.payload.headers || []);
          const saved = await saveMessage(entities, account, fullMsg, hdrs, admin);
          if (saved) synced++;
        }
        await sleep(GMAIL_RATE_LIMIT_DELAY);
      } catch (error: any) {
        results.errors.push(`Message ${msgId}: ${error.message}`);
      }
    }
  }

  // Process deleted messages
  if (deletedMessageIds.size > 0) {
    for (const msgId of deletedMessageIds) {
      try {
        const existing = await entities.EmailMessage.filter({
          gmail_message_id: msgId,
          email_account_id: account.id
        }, null, 1);
        if (existing.length > 0) {
          await entities.EmailMessage.update(existing[0].id, { is_deleted: true });
        }
      } catch (error: any) {
        console.error(`Error marking message ${msgId} as deleted:`, error);
      }
    }
  }

  // Process label changes (read/unread, starred, etc.)
  const labelOnlyIds = [...labelChangedMessageIds].filter(id => !addedMessageIds.has(id) && !deletedMessageIds.has(id));
  for (const msgId of labelOnlyIds) {
    try {
      const msgResponse = await retryFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (msgResponse && msgResponse.ok) {
        const msgData = await msgResponse.json();
        const labels = msgData.labelIds || [];

        const existing = await entities.EmailMessage.filter({
          gmail_message_id: msgId,
          email_account_id: account.id
        }, null, 1);

        if (existing.length > 0) {
          await entities.EmailMessage.update(existing[0].id, {
            is_unread: labels.includes('UNREAD'),
            is_starred: labels.includes('STARRED'),
            is_draft: labels.includes('DRAFT'),
            is_sent: labels.includes('SENT'),
          });
        }
      }
      await sleep(GMAIL_RATE_LIMIT_DELAY);
    } catch (error: any) {
      console.error(`Error updating labels for message ${msgId}:`, error);
    }
  }

  // Paginate history if needed
  let nextPageToken = historyData.nextPageToken;
  while (nextPageToken) {
    const pageUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    pageUrl.searchParams.append('startHistoryId', account.history_id);
    pageUrl.searchParams.append('historyTypes', 'messageAdded');
    pageUrl.searchParams.append('historyTypes', 'messageDeleted');
    pageUrl.searchParams.append('historyTypes', 'labelAdded');
    pageUrl.searchParams.append('historyTypes', 'labelRemoved');
    pageUrl.searchParams.append('maxResults', '500');
    pageUrl.searchParams.append('pageToken', nextPageToken);

    const pageResponse = await retryFetch(
      pageUrl.toString(),
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (!pageResponse || !pageResponse.ok) break;

    const pageData = await pageResponse.json();
    latestHistoryId = pageData.historyId || latestHistoryId;

    for (const record of (pageData.history || [])) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          try {
            const exists = await messageExists(entities, account, added.message.id);
            if (!exists) {
              const fullMsg = await fetchMessageDetails(accessToken, added.message.id);
              const hdrs = parseHeaders(fullMsg.payload.headers || []);
              const saved = await saveMessage(entities, account, fullMsg, hdrs, admin);
              if (saved) synced++;
            }
            await sleep(GMAIL_RATE_LIMIT_DELAY);
          } catch (error: any) {
            results.errors.push(`Message ${added.message.id}: ${error.message}`);
          }
        }
      }
      if (record.messagesDeleted) {
        for (const deleted of record.messagesDeleted) {
          try {
            const existing = await entities.EmailMessage.filter({
              gmail_message_id: deleted.message.id,
              email_account_id: account.id
            }, null, 1);
            if (existing.length > 0) {
              await entities.EmailMessage.update(existing[0].id, { is_deleted: true });
            }
          } catch { /* non-fatal */ }
        }
      }
      // Process label changes on paginated pages too
      if (record.labelsAdded || record.labelsRemoved) {
        const changedIds = new Set<string>();
        for (const changed of (record.labelsAdded || [])) changedIds.add(changed.message.id);
        for (const changed of (record.labelsRemoved || [])) changedIds.add(changed.message.id);
        for (const msgId of changedIds) {
          if (record.messagesAdded?.some((a: any) => a.message.id === msgId)) continue;
          if (record.messagesDeleted?.some((d: any) => d.message.id === msgId)) continue;
          try {
            const msgResponse = await retryFetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject`,
              { headers: { 'Authorization': `Bearer ${accessToken}` } }
            );
            if (msgResponse && msgResponse.ok) {
              const msgData = await msgResponse.json();
              const labels = msgData.labelIds || [];
              const existing = await entities.EmailMessage.filter({
                gmail_message_id: msgId,
                email_account_id: account.id
              }, null, 1);
              if (existing.length > 0) {
                await entities.EmailMessage.update(existing[0].id, {
                  is_unread: labels.includes('UNREAD'),
                  is_starred: labels.includes('STARRED'),
                  is_draft: labels.includes('DRAFT'),
                  is_sent: labels.includes('SENT'),
                });
              }
            }
            await sleep(GMAIL_RATE_LIMIT_DELAY);
          } catch { /* non-fatal */ }
        }
      }
    }

    nextPageToken = pageData.nextPageToken;
  }

  return { synced, latestHistoryId, fallbackToFull: false };
}

// --- Upsert email_conversations summary table ---
async function upsertConversations(admin: any, accountId: string) {
  try {
    const { data: threadMessages } = await admin
      .from('email_messages')
      .select('gmail_thread_id, subject, from, from_name, is_unread, is_starred, received_at, attachments, project_id, project_title, agent_id, agency_id, to, cc')
      .eq('email_account_id', accountId)
      .or('is_deleted.is.null,is_deleted.eq.false')  // Exclude deleted messages (include null and false)
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
          email_account_id: accountId,
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

      // Clean up stale conversations for threads where all messages have been deleted
      const activeThreadIds = [...threads.keys()];
      if (activeThreadIds.length > 0) {
        const { data: existingConvos } = await admin
          .from('email_conversations')
          .select('id, gmail_thread_id')
          .eq('email_account_id', accountId);
        if (existingConvos) {
          const activeSet = new Set(activeThreadIds);
          const staleIds = existingConvos
            .filter((c: any) => !activeSet.has(c.gmail_thread_id))
            .map((c: any) => c.id);
          if (staleIds.length > 0) {
            await admin.from('email_conversations').delete().in('id', staleIds);
          }
        }
      }
    }
  } catch (convError: any) {
    console.error('Error upserting email_conversations:', convError?.message);
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    // Create a fresh agent lookup cache for this sync cycle
    agentCache = new Map<string, any>();
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
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
      let syncMode = 'full';

      try {
        if (!account.refresh_token) {
          throw new Error('No refresh token stored for this account — user must reconnect their Gmail account');
        }

        const tokenResult = await refreshAccessToken(clientId, clientSecret, account.refresh_token);
        let accessToken = tokenResult.access_token;

        await retryWithBackoff(() =>
          entities.EmailAccount.update(account.id, {
            access_token: accessToken,
            ...(tokenResult.refresh_token ? { refresh_token: tokenResult.refresh_token } : {}),
          })
        );

        let latestHistoryId: string | null = null;

        // --- Decide: incremental (History API) vs full sync ---
        if (account.history_id) {
          syncMode = 'incremental';
          console.log(`Using History API for ${account.email_address} (historyId: ${account.history_id})`);

          const historyResult = await syncViaHistory(accessToken, account, entities, admin, results);

          if (historyResult.fallbackToFull) {
            // History expired — clear stale history_id FIRST to prevent infinite 404 loop
            console.log(`Falling back to full sync for ${account.email_address}`);
            syncMode = 'full_fallback';
            await retryWithBackoff(() =>
              entities.EmailAccount.update(account.id, { history_id: null })
            );
            const fullResult = await fullSyncAccount(accessToken, account, entities, admin, results);
            accountSynced = fullResult.synced;
            latestHistoryId = fullResult.latestHistoryId;
          } else {
            accountSynced = historyResult.synced;
            latestHistoryId = historyResult.latestHistoryId;
          }
        } else {
          // No history_id stored — first sync or migration, do full sync
          console.log(`Full sync for ${account.email_address} (no history_id stored)`);
          const fullResult = await fullSyncAccount(accessToken, account, entities, admin, results);
          accountSynced = fullResult.synced;
          latestHistoryId = fullResult.latestHistoryId;
        }

        // Upsert email_conversations summary table
        await upsertConversations(admin, account.id);

        // Update account metadata with rich sync metrics
        await retryWithBackoff(() =>
          entities.EmailAccount.update(account.id, {
            last_sync: new Date().toISOString(),
            last_sync_at: new Date().toISOString(),
            last_sync_message_count: accountSynced,
            total_synced_count: (account.total_synced_count || 0) + accountSynced,
            sync_error_count: 0,
            last_sync_error: null,
            sync_health: 'ok',
            // Store the latest historyId for next incremental sync
            ...(latestHistoryId ? { history_id: latestHistoryId } : {}),
          })
        );

        results.synced += accountSynced;
        results.accounts++;
        results.accountDetails.push({
          email: account.email_address,
          synced: accountSynced,
          syncMode,
          status: 'success'
        });

      } catch (error: any) {
        // Update error metrics on sync failure (match syncGmailMessagesForAccount behavior)
        try {
          const newErrorCount = (account.sync_error_count || 0) + 1;
          await retryWithBackoff(() =>
            entities.EmailAccount.update(account.id, {
              last_sync_error: error?.message || 'Unknown sync error',
              sync_error_count: newErrorCount,
              sync_health: newErrorCount >= 3 ? 'error' : 'warning',
            })
          );
        } catch { /* non-fatal */ }

        results.accountDetails.push({
          email: account.email_address,
          synced: 0,
          syncMode,
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
