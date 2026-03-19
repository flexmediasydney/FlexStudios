import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const BATCH_SIZE = 10; // Process messages in batches
const GMAIL_RATE_LIMIT_DELAY = 100; // ms between requests

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const retryFetch = async (url, options, retries = MAX_RETRIES) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      
      // Handle rate limiting
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

// Recursively walks the MIME tree to find the best body part.
// Handles: multipart/mixed > multipart/alternative > text/html (real-world nesting).
// Prefers HTML over plain text at every level.
const extractEmailBody = (payload) => {
  const decode = (data) => {
    try {
      return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      return '';
    }
  };

  const walk = (part) => {
    if (!part) return { html: '', text: '' };

    // Leaf node with data
    if (part.mimeType === 'text/html' && part.body?.data) {
      return { html: decode(part.body.data), text: '' };
    }
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return { html: '', text: decode(part.body.data) };
    }

    // Multipart container — recurse into children
    if (part.parts && part.parts.length > 0) {
      let html = '';
      let text = '';
      for (const child of part.parts) {
        const result = walk(child);
        if (result.html) html = result.html; // Last HTML part wins
        if (result.text) text = result.text;
      }
      return { html, text };
    }

    return { html: '', text: '' };
  };

  const { html, text } = walk(payload);
  // Return HTML if available, fall back to plain text wrapped in a <pre> for readability
  if (html) return html;
  if (text) return `<pre style="white-space:pre-wrap;font-family:inherit;font-size:inherit">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  return '';
};

const extractAttachments = (payload) => {
  const attachments = [];
  
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

const parseHeaders = (headers) => {
  const parsed = {};
  for (const header of headers) {
    parsed[header.name] = header.value;
  }
  return parsed;
};

const fetchMessageDetails = async (accessToken, messageId) => {
  const response = await retryFetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  
  if (!response.ok) {
    throw new Error(`Failed to fetch message ${messageId}: ${response.status}`);
  }
  
  return response.json();
};

const getMessageQuery = (account) => {
  // First sync: use sync_start_date if set
  if (!account.last_sync && account.sync_start_date) {
    const date = new Date(account.sync_start_date);
    const timestamp = Math.floor(date.getTime() / 1000);
    return `after:${timestamp}`;
  }
  
  // Subsequent syncs: go back 24 hours to catch new/updated emails
  if (account.last_sync) {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const timestamp = Math.floor(oneDayAgo.getTime() / 1000);
    return `after:${timestamp}`;
  }
  
  // Default: last 7 days if no sync_start_date set (more reasonable default)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const timestamp = Math.floor(sevenDaysAgo.getTime() / 1000);
  return `after:${timestamp}`;
};

const refreshAccessToken = async (clientId, clientSecret, refreshToken) => {
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

const messageExists = async (base44, account, gmailMessageId, retriesLeft = 2) => {
   try {
     const existing = await base44.asServiceRole.entities.EmailMessage.filter({
       gmail_message_id: gmailMessageId,
       email_account_id: account.id
     }, null, 1);
     return existing.length > 0;
   } catch (error) {
     if (error.status === 429 && retriesLeft > 0) {
       await sleep(Math.pow(2, 2 - retriesLeft) * 50);
       return messageExists(base44, account, gmailMessageId, retriesLeft - 1);
     }
     console.error('Error checking message existence:', error);
     return false;
   }
 };

const getThreadProjectLink = async (base44, account, threadId) => {
  try {
    // If any message in this thread is already linked to a project, inherit that link.
    const existing = await base44.asServiceRole.entities.EmailMessage.filter({
      email_account_id: account.id,
      gmail_thread_id: threadId
    }, null, 1);
    const linked = existing.find(m => m.project_id);
    if (linked) {
      return { project_id: linked.project_id, project_title: linked.project_title || null };
    }
    return null;
  } catch {
    return null;
  }
};

const saveMessage = async (base44, account, fullMsg, headers, retriesLeft = 2) => {
   try {
     const rawBody = extractEmailBody(fullMsg.payload);
     const MAX_BODY_SIZE = 10000; // Base44 entity field limit
     
     // Truncate body if too large and add visible indicator
     let body = rawBody;
     let wasTruncated = false;
     if (rawBody.length > MAX_BODY_SIZE) {
       body = rawBody.substring(0, MAX_BODY_SIZE) + 
         '\n\n<div style="margin-top: 20px; padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; color: #856404;">' +
         '<strong>⚠️ Email Truncated</strong><br/>' +
         'This message exceeded 10KB and was shortened. View in Gmail for the complete email.' +
         '</div>';
       wasTruncated = true;
     }
     
     // Check if this thread is already linked to a project — if so, inherit that link
     const threadProjectLink = await getThreadProjectLink(base44, account, fullMsg.threadId);

     await base44.asServiceRole.entities.EmailMessage.create({
       email_account_id: account.id,
       gmail_message_id: fullMsg.id,
       gmail_thread_id: fullMsg.threadId,
       from: headers['From'] || 'unknown@unknown.com',
       from_name: headers['From']?.split('<')[0].trim() || 'Unknown',
       to: (headers['To'] || '').split(',').filter(Boolean).map(e => e.trim()),
       cc: (headers['Cc'] || '').split(',').filter(Boolean).map(e => e.trim()),
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
         // Inherit visibility from the linked thread so the email appears in project history
         visibility: 'shared'
       } : {})
     });
     return true;
   } catch (error) {
     if (error.status === 429 && retriesLeft > 0) {
       await sleep(Math.pow(2, 2 - retriesLeft) * 50);
       return saveMessage(base44, account, fullMsg, headers, retriesLeft - 1);
     }
     // Log specific errors but don't crash the sync
     if (error.message?.includes('exceeds the maximum allowed size')) {
       // Skip this message, log but continue
       return false;
     }
     return false;
   }
 };

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

    // Get email accounts with retry and pagination
    const retryWithBackoff = async (fn, maxRetries = 2) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err) {
                if (err.status === 429 && attempt < maxRetries) {
                    await sleep(Math.pow(2, attempt) * 50);
                    continue;
                }
                throw err;
            }
        }
    };

    const emailAccounts = await retryWithBackoff(() =>
      base44.entities.EmailAccount.filter({
        assigned_to_user_id: user.id,
        is_active: true
      }, '-last_sync', 1000)
    );

    if (emailAccounts.length === 0) {
      return Response.json({ 
        synced: 0, 
        accounts: 0,
        message: 'No email accounts configured' 
      });
    }

    const results = {
      synced: 0,
      accounts: 0,
      accountDetails: [],
      errors: []
    };

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      return Response.json({ error: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in environment secrets' }, { status: 500 });
    }

    for (const account of emailAccounts) {
      let accountSynced = 0;
      
      try {
        if (!account.refresh_token) {
          throw new Error('No refresh token stored for this account — user must reconnect their Gmail account');
        }

        // Use the stored refresh_token to get a fresh access_token.
        // The custom OAuth flow stores these on the EmailAccount entity.
        // We never use base44.connectors here — that is a separate unrelated system.
        let accessToken = await refreshAccessToken(clientId, clientSecret, account.refresh_token);

        // Write the refreshed token back so subsequent operations in this pass use it
        await retryWithBackoff(() =>
          base44.entities.EmailAccount.update(account.id, { access_token: accessToken })
        );

        // Get message IDs using query with pagination (limit to 500 per sync)
        const query = getMessageQuery(account);
        
        let messageIds = [];
        let pageToken = null;
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
          
          // Stop if we hit the limit
          if (messageIds.length >= MAX_MESSAGES_PER_SYNC) {
            messageIds = messageIds.slice(0, MAX_MESSAGES_PER_SYNC);
            break;
          }
          
          // Rate limiting between pages
          if (pageToken) await sleep(GMAIL_RATE_LIMIT_DELAY * 2);
        } while (pageToken);
        
        // Process messages in batches with duplicate prevention
        const processedIds = new Set();
        
        for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
          const batch = messageIds.slice(i, i + BATCH_SIZE);
          
          for (const msg of batch) {
            // Skip if already processed in this run
            if (processedIds.has(msg.id)) continue;
            processedIds.add(msg.id);
            
            try {
              // Check if message already exists in database
              const exists = await messageExists(base44, account, msg.id);
              
              if (!exists) {
                // Fetch full message details
                const fullMsg = await fetchMessageDetails(accessToken, msg.id);
                const headers = parseHeaders(fullMsg.payload.headers || []);
                
                // Save message
                const saved = await saveMessage(base44, account, fullMsg, headers);
                if (saved) {
                  accountSynced++;
                }
              }
              
              // Rate limiting
              await sleep(GMAIL_RATE_LIMIT_DELAY);
            } catch (error) {
              results.errors.push(`Message ${msg.id}: ${error.message}`);
            }
          }
        }

        // Update account sync metadata with retry
         await retryWithBackoff(() =>
           base44.entities.EmailAccount.update(account.id, {
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

      } catch (error) {
        results.accountDetails.push({
          email: account.email_address,
          synced: 0,
          status: 'error',
          error: error.message
        });
        results.errors.push(`${account.email_address}: ${error.message}`);
      }
    }

    return Response.json({
      ...results,
      message: `Synced ${results.synced} messages from ${results.accounts} accounts`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Sync error:', error);
    return Response.json({ 
      error: error.message,
      synced: 0,
      accounts: 0
    }, { status: 500 });
  }
});