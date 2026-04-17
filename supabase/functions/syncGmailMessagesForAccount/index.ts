import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';
import { MS_PER_DAY, MS_PER_MINUTE, GMAIL_DEFAULT_LOOKBACK_DAYS, GMAIL_HISTORY_FALLBACK_LOOKBACK_DAYS, GMAIL_LOOKBACK_MINUTES, MAX_MESSAGES_PER_SYNC } from '../_shared/constants.ts';
import { AgentLookup } from '../_shared/emailLinking.ts';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const BATCH_SIZE = 10;
const GMAIL_RATE_LIMIT_DELAY = 100;
// Wall-clock budget: stop processing before the 30s Supabase Edge Function timeout.
// Leave headroom for token refresh, conversation upsert, and account metadata update.
const WALL_CLOCK_BUDGET_MS = 24_000; // 24 seconds

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryFetch = async (url: string, options: any, retries = MAX_RETRIES): Promise<Response> => {
  let lastResponse: Response | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status === 503) {
        lastResponse = response;
        const retryAfter = parseInt(response.headers.get('retry-after') || '5') * 1000;
        await sleep(Math.min(retryAfter, 60000)); // cap at 60s to avoid unbounded waits
        continue;
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(RETRY_DELAY_MS * Math.pow(2, i));
    }
  }
  // All retries exhausted (e.g. repeated 429s) — return the last response so callers can inspect status
  if (lastResponse) return lastResponse;
  throw new Error('retryFetch: all retries exhausted with no response');
};

const extractEmailBody = (payload: any) => {
  const decode = (data: string) => {
    try {
      const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch { return ''; }
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
  const walkParts = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ filename: part.filename, mime_type: part.mimeType, size: part.size || 0, attachment_id: part.body.attachmentId });
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
  const raw: Record<string, string> = {};
  if (!Array.isArray(headers)) return raw;
  for (const header of headers) {
    if (header?.name) raw[header.name] = header.value ?? '';
  }
  // Return a proxy that does case-insensitive lookups (RFC 2822: header names are case-insensitive)
  // Build a lowercase-key map for fast lookup, but preserve original casing in entries
  const lowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) lowerMap.set(k.toLowerCase(), v);
  return new Proxy(raw, {
    get(target, prop: string) {
      if (typeof prop === 'string') return lowerMap.get(prop.toLowerCase()) ?? target[prop];
      return target[prop as any];
    }
  });
};

const refreshAccessToken = async (clientId: string, clientSecret: string, refreshToken: string): Promise<{ access_token: string; refresh_token?: string }> => {
  // Retry once on transient network/server errors
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
      });
      if (response.status >= 500 && attempt === 0) {
        await sleep(2000);
        continue;
      }
      const data = await response.json();
      if (!data.access_token) {
        // Distinguish permanent auth errors from transient ones
        const isRevoked = data.error === 'invalid_grant';
        throw new Error(`Token refresh failed: ${data.error || 'unknown error'}${isRevoked ? ' (refresh token revoked — user must reconnect Gmail)' : ''}`);
      }
      // Google may rotate the refresh token — if a new one is returned, we must store it
      return { access_token: data.access_token, refresh_token: data.refresh_token || undefined };
    } catch (err: any) {
      if (attempt === 0 && !err.message?.includes('Token refresh failed')) {
        await sleep(2000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Token refresh failed after retries');
};

// --- Fetch and save a single Gmail message (shared by full sync and history sync) ---
// Returns: 'saved' if new message saved, 'skipped' if already exists, 'failed' if fetch/save error
async function fetchAndSaveMessage(
  accessToken: string,
  gmailMessageId: string,
  account: any,
  entities: any,
  admin: any,
  agentLookup?: AgentLookup,
): Promise<'saved' | 'skipped' | 'failed'> {
  // Check if already exists
  const existing = await entities.EmailMessage.filter({
    gmail_message_id: gmailMessageId,
    email_account_id: account.id
  }, null, 1);
  if (existing.length > 0) return 'skipped';

  // Inherit project link from sibling messages in same thread
  // We need the threadId first, so fetch the message
  const msgResponse = await retryFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!msgResponse || !msgResponse.ok) return 'failed';

  const fullMsg = await msgResponse.json();
  const headers = parseHeaders(fullMsg.payload.headers || []);
  const isSent = fullMsg.labelIds?.includes('SENT');

  // Inherit project link from sibling messages in same thread
  let threadProjectLink: any = null;
  try {
    const siblings = await entities.EmailMessage.filter({
      email_account_id: account.id,
      gmail_thread_id: fullMsg.threadId
    }, null, 1);
    const linked = siblings.find((m: any) => m.project_id);
    if (linked) threadProjectLink = { project_id: linked.project_id, project_title: linked.project_title || null };
  } catch { /* non-fatal */ }

  // Agent/agency auto-linking — match From: OR To: OR Cc: OR domain fallback
  const toList = (headers['To'] || '').split(/,(?![^<]*>)/).filter(Boolean).map((e: string) => e.trim());
  const ccList = (headers['Cc'] || '').split(/,(?![^<]*>)/).filter(Boolean).map((e: string) => e.trim());
  const linkResult = agentLookup
    ? await agentLookup.resolve({
        from: headers['From'],
        to: toList,
        cc: ccList,
      })
    : { agent_id: null, agent_name: null, agency_id: null, agency_name: null, matched_via: null };

  // Truncate oversized bodies to prevent DB insert failures
  const MAX_BODY_SIZE = 10000;
  let rawBody = extractEmailBody(fullMsg.payload);
  if (rawBody.length > MAX_BODY_SIZE) {
    rawBody = rawBody.substring(0, MAX_BODY_SIZE) +
      '\n\n<div style="margin-top: 20px; padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; color: #856404;">' +
      '<strong>Email Truncated</strong><br/>' +
      'This message exceeded 10KB and was shortened. View in Gmail for the complete email.' +
      '</div>';
  }

  // Save message with proper visibility field
  const savedMessage = await entities.EmailMessage.create({
    email_account_id: account.id,
    gmail_message_id: fullMsg.id,
    gmail_thread_id: fullMsg.threadId,
    from: headers['From'] || 'unknown@unknown.com',
    from_name: headers['From']?.split('<')[0].trim() || 'Unknown',
    to: toList,
    cc: ccList,
    subject: headers['Subject'] || '(no subject)',
    body: rawBody,
    is_unread: fullMsg.labelIds?.includes('UNREAD') || false,
    is_starred: fullMsg.labelIds?.includes('STARRED') || false,
    is_draft: fullMsg.labelIds?.includes('DRAFT') || false,
    is_sent: fullMsg.labelIds?.includes('SENT') || false,
    attachments: extractAttachments(fullMsg.payload),
    received_at: (() => {
      const ts = parseInt(fullMsg.internalDate);
      return isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString();
    })(),
    visibility: 'private',
    ...(threadProjectLink ? {
      project_id: threadProjectLink.project_id,
      project_title: threadProjectLink.project_title,
      visibility: 'shared'
    } : {}),
    ...(linkResult.agent_id || linkResult.agency_id ? {
      agent_id: linkResult.agent_id,
      agent_name: linkResult.agent_name,
      agency_id: linkResult.agency_id,
      agency_name: linkResult.agency_name,
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

  return 'saved';
}

// --- Retry pass for failed messages (one extra attempt each) ---
async function retryFailedMessages(
  failedIds: string[],
  accessToken: string,
  account: any,
  entities: any,
  admin: any,
  agentLookup?: AgentLookup,
): Promise<{ retried: number; stillFailed: number }> {
  let retried = 0;
  let stillFailed = 0;
  console.log(`Retrying ${failedIds.length} failed messages for ${account.email_address}`);
  for (const msgId of failedIds) {
    try {
      const result = await fetchAndSaveMessage(accessToken, msgId, account, entities, admin, agentLookup);
      if (result === 'saved') retried++;
      else if (result === 'failed') stillFailed++;
      await sleep(GMAIL_RATE_LIMIT_DELAY);
    } catch (error: any) {
      console.error(`Retry still failed for message ${msgId}:`, error?.message);
      stillFailed++;
    }
  }
  if (stillFailed > 0) {
    console.warn(`${stillFailed} messages still failed after retry for ${account.email_address}`);
  }
  return { retried, stillFailed };
}

// --- Full sync: list messages via query, fetch new ones ---
async function fullSync(
  accessToken: string,
  account: any,
  entities: any,
  admin: any,
  options?: { historyExpiredFallback?: boolean },
  agentLookup?: AgentLookup,
  wallClockStart?: number,
): Promise<{ synced: number; latestHistoryId: string | null; hitTimeBudget?: boolean }> {
  let synced = 0;
  let latestHistoryId: string | null = null;

  // Build query based on last sync
  // When falling back from expired history, use a wider 60-day window to catch missed messages
  const isHistoryFallback = options?.historyExpiredFallback === true;
  let query = '';
  if (account.last_sync) {
    const lastSyncDate = new Date(account.last_sync);
    // Normal: 30 min lookback. History fallback: 60 days lookback to catch missed messages
    const lookbackMs = isHistoryFallback
      ? GMAIL_HISTORY_FALLBACK_LOOKBACK_DAYS * MS_PER_DAY
      : GMAIL_LOOKBACK_MINUTES * MS_PER_MINUTE;
    const syncFromDate = new Date(lastSyncDate.getTime() - lookbackMs);
    const timestamp = Math.floor(syncFromDate.getTime() / 1000);
    query = `after:${timestamp}`;
    if (isHistoryFallback) {
      console.log(`History expired fallback: using 60-day window from ${syncFromDate.toISOString()} for ${account.email_address}`);
    }
  } else if (account.sync_start_date) {
    const date = new Date(account.sync_start_date);
    const timestamp = Math.floor(date.getTime() / 1000);
    query = `after:${timestamp}`;
  } else {
    const defaultDays = isHistoryFallback ? GMAIL_HISTORY_FALLBACK_LOOKBACK_DAYS : GMAIL_DEFAULT_LOOKBACK_DAYS;
    const lookbackDate = new Date(Date.now() - defaultDays * MS_PER_DAY);
    query = `after:${Math.floor(lookbackDate.getTime() / 1000)}`;
  }

  // MAX_MESSAGES_PER_SYNC imported from _shared/constants.ts
  let messageIds: any[] = [];
  let pageToken: string | null = null;

  do {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.append('q', query);
    listUrl.searchParams.append('maxResults', '100');
    if (pageToken) listUrl.searchParams.append('pageToken', pageToken);

    const listResponse = await retryFetch(
      listUrl.toString(),
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (!listResponse || !listResponse.ok) {
      throw new Error(`Gmail API error: ${listResponse?.status}`);
    }

    const data = await listResponse.json();
    const newMessages = data.messages || [];
    messageIds = messageIds.concat(newMessages);
    pageToken = data.nextPageToken || null;

    if (messageIds.length >= MAX_MESSAGES_PER_SYNC) {
      messageIds = messageIds.slice(0, MAX_MESSAGES_PER_SYNC);
      break;
    }

    if (pageToken) await sleep(GMAIL_RATE_LIMIT_DELAY * 2);
  } while (pageToken);

  // Get the latest historyId from the first message (most recent)
  // We need to fetch at least one message to get a historyId
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
    // No messages, get historyId from profile
    const profileResponse = await retryFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/profile`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (profileResponse && profileResponse.ok) {
      const profile = await profileResponse.json();
      latestHistoryId = profile.historyId || null;
    }
  }

  // Process in batches, collecting failed message IDs for retry
  const failedIds: string[] = [];
  let hitTimeBudget = false;
  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    // Wall-clock guard: stop before Supabase kills us, save progress so far
    if (wallClockStart && (Date.now() - wallClockStart) > WALL_CLOCK_BUDGET_MS) {
      console.warn(`Wall-clock budget exhausted after syncing ${synced} messages (${messageIds.length - i} remaining). Saving progress for next run.`);
      hitTimeBudget = true;
      break;
    }

    const batch = messageIds.slice(i, i + BATCH_SIZE);

    for (const msg of batch) {
      try {
        const result = await fetchAndSaveMessage(accessToken, msg.id, account, entities, admin, agentLookup);
        if (result === 'saved') synced++;
        else if (result === 'failed') failedIds.push(msg.id);
        await sleep(GMAIL_RATE_LIMIT_DELAY);
      } catch (error: any) {
        console.error(`Error processing message ${msg.id}:`, error);
        failedIds.push(msg.id);
      }
    }
  }

  // Retry pass for transiently failed messages (skip if we already hit the time budget)
  if (failedIds.length > 0 && !hitTimeBudget) {
    const retryResult = await retryFailedMessages(failedIds, accessToken, account, entities, admin, agentLookup);
    synced += retryResult.retried;
  }

  return { synced, latestHistoryId, hitTimeBudget };
}

// --- Incremental sync via Gmail History API ---
async function syncViaHistory(
  accessToken: string,
  account: any,
  entities: any,
  admin: any,
  agentLookup?: AgentLookup,
  wallClockStart?: number,
): Promise<{ synced: number; latestHistoryId: string | null; fallbackToFull: boolean; hitTimeBudget?: boolean }> {
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
    // No changes since last sync
    return { synced: 0, latestHistoryId, fallbackToFull: false };
  }

  // Collect all message IDs that were added, deleted, or had label changes
  const addedMessageIds = new Set<string>();
  const deletedMessageIds = new Set<string>();
  const labelChangedMessageIds = new Set<string>();

  for (const record of historyRecords) {
    // messagesAdded: new messages arrived
    if (record.messagesAdded) {
      for (const added of record.messagesAdded) {
        addedMessageIds.add(added.message.id);
      }
    }

    // messagesDeleted: messages were trashed/deleted
    if (record.messagesDeleted) {
      for (const deleted of record.messagesDeleted) {
        deletedMessageIds.add(deleted.message.id);
      }
    }

    // labelsAdded / labelsRemoved: labels changed (read/unread, starred, etc.)
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

  // Remove from "added" if also deleted (message came and went)
  for (const id of deletedMessageIds) {
    addedMessageIds.delete(id);
  }

  // Process new messages (messagesAdded), collecting failures for retry
  const failedIds: string[] = [];
  let hitTimeBudget = false;
  const addedList = [...addedMessageIds];
  for (let i = 0; i < addedList.length; i += BATCH_SIZE) {
    // Wall-clock guard: stop before Supabase kills us
    if (wallClockStart && (Date.now() - wallClockStart) > WALL_CLOCK_BUDGET_MS) {
      console.warn(`Wall-clock budget exhausted during incremental sync after ${synced} messages (${addedList.length - i} remaining)`);
      hitTimeBudget = true;
      break;
    }
    const batch = addedList.slice(i, i + BATCH_SIZE);
    for (const msgId of batch) {
      try {
        const result = await fetchAndSaveMessage(accessToken, msgId, account, entities, admin, agentLookup);
        if (result === 'saved') synced++;
        else if (result === 'failed') failedIds.push(msgId);
        await sleep(GMAIL_RATE_LIMIT_DELAY);
      } catch (error: any) {
        console.error(`Error processing added message ${msgId}:`, error);
        failedIds.push(msgId);
      }
    }
  }

  // Process deleted messages — mark as deleted in our DB
  if (deletedMessageIds.size > 0) {
    const deletedList = [...deletedMessageIds];
    for (const msgId of deletedList) {
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
  // Only process messages that weren't already handled as added
  const labelOnlyIds = [...labelChangedMessageIds].filter(id => !addedMessageIds.has(id) && !deletedMessageIds.has(id));
  for (const msgId of labelOnlyIds) {
    try {
      // Fetch minimal message data to get current labels
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

  // Paginate if there are more history records
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

    const pageRecords = pageData.history || [];
    for (const record of pageRecords) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          try {
            const result = await fetchAndSaveMessage(accessToken, added.message.id, account, entities, admin, agentLookup);
            if (result === 'saved') synced++;
            else if (result === 'failed') failedIds.push(added.message.id);
            await sleep(GMAIL_RATE_LIMIT_DELAY);
          } catch (error: any) {
            console.error(`Error processing added message ${added.message.id}:`, error);
            failedIds.push(added.message.id);
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
        // Skip messages already handled as added or deleted above
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

  // Retry pass for transiently failed messages (skip if we already hit the time budget)
  if (failedIds.length > 0 && !hitTimeBudget) {
    const retryResult = await retryFailedMessages(failedIds, accessToken, account, entities, admin, agentLookup);
    synced += retryResult.retried;
  }

  return { synced, latestHistoryId, fallbackToFull: false, hitTimeBudget };
}

// --- Upsert email_conversations summary table ---
//
// NOTE: as of migration 071, a DB trigger (`email_messages_refresh_conversation`)
// keeps `email_conversations` in sync automatically on every message insert,
// update, and delete. The previous implementation of this function SELECTed
// all messages for an account without a limit — but PostgREST's default cap is
// 1000 rows, so for accounts with >1000 messages (info@ has 2265, joseph@ has
// 1159), the function only saw the first 1000 threads and DELETED every other
// conversation row as "stale". That was the structural cause of the "only 45
// emails showing" bug observed in production.
//
// Now this function is a no-op — the trigger handles everything. Left in place
// (as a stub) so existing callers don't need to change.
async function upsertConversations(_admin: any, _accountId: string) {
  // Intentionally empty — replaced by DB trigger in migration 071.
  // The trigger (`email_messages_refresh_conversation`) fires per-row on
  // INSERT/UPDATE/DELETE of email_messages and calls refresh_email_conversation
  // which upserts (or deletes) the corresponding email_conversations row.
  return;
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { accountId, userId } = await req.json();

    // Created below, after account lookup so we can exclude our own addresses.
    let agentLookup: AgentLookup | undefined;

    if (!accountId || !userId) {
      return errorResponse('Missing accountId or userId', 400);
    }

    // Check if this is a service-role invocation (from syncAllEmails scheduler)
    const authHeader = req.headers.get('Authorization') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const isServiceRole = authHeader === `Bearer ${serviceRoleKey}`;

    if (!isServiceRole) {
      // Verify user authentication for direct user calls
      const user = await getUserFromReq(req);
      if (!user || user.id !== userId) {
        return errorResponse('Unauthorized', 403);
      }

      if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
        return errorResponse('Forbidden: insufficient permissions', 403);
      }
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
    let syncMode = 'full';
    let hitTimeBudget = false;
    const wallClockStart = Date.now();

    // Gather ALL of our own email account addresses so we don't self-match them as agents
    const { data: allAccounts } = await admin
      .from('email_accounts')
      .select('email_address');
    const ownAddresses = new Set<string>();
    for (const a of allAccounts || []) {
      if (a.email_address) ownAddresses.add(String(a.email_address).toLowerCase());
    }
    agentLookup = new AgentLookup(admin, ownAddresses);
    // Preload agents + domains once per request (cheap: 1-2 queries) so all subsequent lookups are in-memory
    await agentLookup.preloadAgents().catch(() => {});
    await agentLookup.preloadDomains().catch(() => {});

    try {
      const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
      const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

      if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in environment secrets');
      }

      if (!account.refresh_token) {
        throw new Error('No refresh token stored — user must reconnect their Gmail account');
      }

      const tokenResult = await refreshAccessToken(clientId, clientSecret, account.refresh_token);
      const accessToken = tokenResult.access_token;

      // Write refreshed token back to entity (and rotated refresh token if Google issued one)
      await entities.EmailAccount.update(account.id, {
        access_token: accessToken,
        ...(tokenResult.refresh_token ? { refresh_token: tokenResult.refresh_token } : {}),
      });

      let latestHistoryId: string | null = null;

      // --- Decide: incremental (History API) vs full sync ---
      if (account.history_id) {
        // Try incremental sync via History API
        syncMode = 'incremental';
        console.log(`Using History API for ${account.email_address} (historyId: ${account.history_id})`);

        const historyResult = await syncViaHistory(accessToken, account, entities, admin, agentLookup, wallClockStart);

        if (historyResult.fallbackToFull) {
          // History expired — clear stale history_id FIRST to prevent infinite 404 loop
          console.log(`Falling back to full sync for ${account.email_address} (history ID expired, using 60-day window)`);
          syncMode = 'full_fallback';
          await entities.EmailAccount.update(account.id, { history_id: null });
          const fullResult = await fullSync(accessToken, account, entities, admin, { historyExpiredFallback: true }, agentLookup, wallClockStart);
          synced = fullResult.synced;
          latestHistoryId = fullResult.latestHistoryId;
          hitTimeBudget = fullResult.hitTimeBudget || false;
        } else {
          synced = historyResult.synced;
          latestHistoryId = historyResult.latestHistoryId;
          hitTimeBudget = historyResult.hitTimeBudget || false;
        }
      } else {
        // No history_id stored — first sync or migration, do full sync
        console.log(`Full sync for ${account.email_address} (no history_id stored)`);
        const fullResult = await fullSync(accessToken, account, entities, admin, undefined, agentLookup, wallClockStart);
        synced = fullResult.synced;
        latestHistoryId = fullResult.latestHistoryId;
        hitTimeBudget = fullResult.hitTimeBudget || false;
      }

      // Upsert email_conversations summary table
      await upsertConversations(admin, account.id);

      // Update account metadata with rich sync metrics (Email-04)
      const now = new Date().toISOString();
      const isFullSync = syncMode === 'full' || syncMode === 'full_fallback';
      await entities.EmailAccount.update(account.id, {
        last_sync: now,
        last_sync_at: now,
        last_sync_message_count: synced,
        last_sync_mode: syncMode,
        total_synced_count: (account.total_synced_count || 0) + synced,
        sync_error_count: 0,
        last_sync_error: null,
        sync_health: 'ok',
        // Track full syncs separately for debugging sync gaps
        ...(isFullSync ? { last_full_sync_at: now } : {}),
        // Store the latest historyId for next incremental sync
        ...(latestHistoryId ? { history_id: latestHistoryId } : {}),
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
      syncMode,
      accountEmail: account.email_address,
      ...(hitTimeBudget ? { partial: true, reason: 'wall_clock_budget_exceeded' } : {}),
    });
  } catch (error: any) {
    console.error('Account sync error:', error);
    return errorResponse(error.message);
  }
});
