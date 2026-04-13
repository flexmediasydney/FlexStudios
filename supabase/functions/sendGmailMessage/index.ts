import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryFetch = async (url: string, options: any, retries = 3): Promise<Response> => {
  let lastResponse: Response | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status === 503) {
        lastResponse = response;
        const retryAfter = parseInt(response.headers.get('retry-after') || '5') * 1000;
        await sleep(Math.min(retryAfter, 60000)); // cap at 60s
        continue;
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(1000 * Math.pow(2, i));
    }
  }
  if (lastResponse) return lastResponse;
  throw new Error('retryFetch: all retries exhausted');
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
    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    const { emailAccountId, to, cc, bcc, subject, body = '', inReplyTo, threadId,
        attachments = [], attachmentUrls = [], idempotency_key, projectId, isPrivate, signatureId } = await req.json();

    // Validate required fields
    if (!emailAccountId) {
      return errorResponse('emailAccountId is required', 400);
    }
    if (!to?.trim()) {
      return errorResponse('Recipient (to) is required', 400);
    }
    if (!subject?.trim()) {
      return errorResponse('Subject is required', 400);
    }

    const emailAccount = await entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });

    if (emailAccount.length === 0) {
      return errorResponse('Email account not found', 404);
    }

    const account = emailAccount[0];

    // Deduplication: reject if same idempotency_key was sent within the last 60 seconds
    if (idempotency_key) {
      const recentSent = await entities.EmailMessage.filter({
        idempotency_key,
        email_account_id: account.id,
      }, null, 1);
      if (recentSent.length > 0) {
        const sentAt = new Date(recentSent[0].received_at).getTime();
        const ageSeconds = (Date.now() - sentAt) / 1000;
        if (ageSeconds < 60) {
          return jsonResponse({
            success: true,
            duplicate: true,
            messageId: recentSent[0].gmail_message_id,
          });
        }
      }
    }

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      return errorResponse('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in environment secrets', 500);
    }

    if (!account.refresh_token) {
      return errorResponse('Gmail account has no refresh token — user must reconnect their Gmail account in Inbox settings', 401);
    }

    // Refresh the access token (retry once on transient failures)
    let tokenData: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
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
      if (refreshResponse.status >= 500 && attempt === 0) {
        await sleep(2000);
        continue;
      }
      tokenData = await refreshResponse.json();
      break;
    }
    if (!tokenData?.access_token) {
      const isRevoked = tokenData?.error === 'invalid_grant';
      console.error('Gmail token refresh failed:', tokenData?.error, tokenData?.error_description);
      return errorResponse(
        isRevoked
          ? 'Gmail refresh token has been revoked. User must reconnect their Gmail account in Inbox settings.'
          : 'Failed to refresh Gmail token. User may need to reconnect their Gmail account.',
        401
      );
    }
    const accessToken = tokenData.access_token;

    // Write refreshed token back (including rotated refresh token if Google issued one)
    await entities.EmailAccount.update(account.id, {
      access_token: accessToken,
      ...(tokenData.refresh_token ? { refresh_token: tokenData.refresh_token } : {}),
    });

    // Get user signature — use specific one if signatureId provided, else default
    let signatures;
    if (signatureId) {
      signatures = await entities.UserSignature.filter({ id: signatureId, user_id: user.id });
    } else {
      signatures = await entities.UserSignature.filter({ user_id: user.id, is_default: true });
    }

    let finalBody = body || '';
    if (signatures.length > 0 && signatures[0].signature_html) {
      finalBody += `<br/><br/>${signatures[0].signature_html}`;
    }

    // Build email with proper From header and In-Reply-To for threading
    // Encode display name per RFC 2047 if it contains special characters
    const safeName = account.display_name
      ? ((/[^\x20-\x7E]|[",;]/).test(account.display_name)
          ? `=?UTF-8?B?${btoa(Array.from(new TextEncoder().encode(account.display_name), (b) => String.fromCharCode(b)).join(''))}?=`
          : `"${account.display_name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        : '';
    const fromHeader = safeName
      ? `${safeName} <${account.email_address}>`
      : account.email_address;

    // Build MIME message — headers first, then the mandatory blank-line separator, then body
    const headerLines: string[] = [
      `From: ${fromHeader}`,
      `To: ${to}`,
    ];
    if (cc) headerLines.push(`Cc: ${cc}`);
    if (bcc) headerLines.push(`Bcc: ${bcc}`);
    if (inReplyTo) {
      headerLines.push(`In-Reply-To: ${inReplyTo}`);
      headerLines.push(`References: ${inReplyTo}`);
    }
    headerLines.push(`Subject: ${subject}`);
    headerLines.push('MIME-Version: 1.0');

    // Merge both attachment formats: legacy `attachmentUrls` and new `attachments` from compose dialog
    // `attachments` items have { file_url, filename, mime_type, size }
    // `attachmentUrls` items are either strings or { url, filename, mimeType }
    const allAttachments: Array<{ url: string; filename: string; mimeType: string }> = [];
    for (const att of attachmentUrls) {
      if (typeof att === 'string') {
        allAttachments.push({ url: att, filename: att.split('/').pop() || 'attachment', mimeType: 'application/octet-stream' });
      } else {
        allAttachments.push({ url: att.url, filename: att.filename || 'attachment', mimeType: att.mimeType || 'application/octet-stream' });
      }
    }
    for (const att of attachments) {
      if (att.file_url) {
        allAttachments.push({ url: att.file_url, filename: att.filename || 'attachment', mimeType: att.mime_type || 'application/octet-stream' });
      }
    }

    // Helper: split base64 into 76-char lines per RFC 2045
    const wrapBase64 = (b64: string): string => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

    // If attachments are provided, build a multipart/mixed MIME message
    let email: string;
    const failedAttachments: Array<{ filename: string; error: string }> = [];
    if (allAttachments.length > 0) {
      const boundary = `boundary_${crypto.randomUUID().replace(/-/g, '')}`;
      headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

      const parts: string[] = [];

      // HTML body part
      const bodyBase64 = wrapBase64(btoa(Array.from(new TextEncoder().encode(finalBody), (b) => String.fromCharCode(b)).join('')));
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: text/html; charset="UTF-8"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        bodyBase64
      );

      // Attachment parts — download each URL and inline as base64
      for (const att of allAttachments) {
        try {
          const { url, filename, mimeType } = att;

          const attResponse = await fetch(url);
          if (!attResponse.ok) {
            const errMsg = `Download failed: HTTP ${attResponse.status} ${attResponse.statusText}`;
            console.warn(`Failed to download attachment "${filename}": ${url} (${attResponse.status})`);
            failedAttachments.push({ filename, error: errMsg });
            continue;
          }
          // Gmail API enforces a 25MB total message size limit; reject oversized attachments early
          const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB (leaves room for base64 overhead + body)
          const contentLength = parseInt(attResponse.headers.get('content-length') || '0');
          if (contentLength > MAX_ATTACHMENT_SIZE) {
            const errMsg = `Attachment too large (${(contentLength / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
            console.warn(`Attachment "${filename}" rejected: ${errMsg}`);
            failedAttachments.push({ filename, error: errMsg });
            continue;
          }
          const attBytes = new Uint8Array(await attResponse.arrayBuffer());
          if (attBytes.length > MAX_ATTACHMENT_SIZE) {
            const errMsg = `Attachment too large (${(attBytes.length / 1024 / 1024).toFixed(1)}MB). Max is 20MB.`;
            console.warn(`Attachment "${filename}" rejected after download: ${errMsg}`);
            failedAttachments.push({ filename, error: errMsg });
            continue;
          }
          if (attBytes.length === 0) {
            const errMsg = 'Downloaded file is empty (0 bytes)';
            console.warn(`Attachment "${filename}" downloaded but empty: ${url}`);
            failedAttachments.push({ filename, error: errMsg });
            continue;
          }
          const attBase64 = btoa(Array.from(attBytes, (b) => String.fromCharCode(b)).join(''));

          // RFC 2047 encode filename if it contains non-ASCII characters
          const hasNonAscii = /[^\x20-\x7E]/.test(filename);
          const encodedFilename = hasNonAscii
            ? `=?UTF-8?B?${btoa(Array.from(new TextEncoder().encode(filename), (b) => String.fromCharCode(b)).join(''))}?=`
            : `"${filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
          const rawFilename = hasNonAscii ? encodedFilename : `"${filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

          parts.push(
            `--${boundary}\r\n` +
            `Content-Type: ${mimeType}; name=${rawFilename}\r\n` +
            `Content-Disposition: attachment; filename=${rawFilename}\r\n` +
            `Content-Transfer-Encoding: base64\r\n\r\n` +
            wrapBase64(attBase64)
          );
        } catch (attErr: any) {
          const filename = att.filename || 'unknown';
          const errMsg = attErr?.message || 'Unknown error';
          console.warn(`Failed to process attachment "${filename}":`, errMsg);
          failedAttachments.push({ filename, error: errMsg });
        }
      }

      // If ALL attachments failed to download, abort — don't send email without them
      if (failedAttachments.length === allAttachments.length) {
        const failDetails = failedAttachments.map(f => `"${f.filename}": ${f.error}`).join('; ');
        return errorResponse(
          `All ${allAttachments.length} attachment(s) failed to download and could not be sent. ` +
          `Details: ${failDetails}. ` +
          `This may be caused by storage permissions — ensure the Supabase Storage bucket is public.`,
          422
        );
      }

      parts.push(`--${boundary}--`);

      email = headerLines.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
    } else {
      // Simple single-part HTML message
      headerLines.push('Content-Type: text/html; charset="UTF-8"');
      email = headerLines.join('\r\n') + '\r\n\r\n' + finalBody;
    }

    // Encode to base64url — use TextEncoder for proper UTF-8 support
    const emailBytes = new TextEncoder().encode(email);
    const binaryStr = Array.from(emailBytes, (b) => String.fromCharCode(b)).join('');
    const encodedEmail = btoa(binaryStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const payload: Record<string, string> = { raw: encodedEmail };
    if (threadId) payload.threadId = threadId;

    const response = await retryFetch(
      'https://www.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage = `Gmail API error ${response.status}`;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.error?.message || errorMessage;
      } catch {}
      throw new Error(errorMessage);
    }

    const result = await response.json();

    // Create sent message record
    try {
      await entities.EmailMessage.create({
        email_account_id: account.id,
        gmail_message_id: result.id,
        gmail_thread_id: result.threadId,
        from: account.email_address,
        from_name: account.display_name,
        to: to.split(',').map((e: string) => e.trim()).filter(Boolean),
        cc: cc ? cc.split(',').map((e: string) => e.trim()).filter(Boolean) : [],
        bcc: bcc ? bcc.split(',').map((e: string) => e.trim()).filter(Boolean) : [],
        subject,
        body: finalBody,
        is_sent: true,
        received_at: new Date().toISOString(),
        idempotency_key: idempotency_key || null,
        visibility: isPrivate === false ? 'shared' : 'private',
        ...(allAttachments.length > 0 ? { attachments: attachments } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
    } catch (createErr: any) {
      console.warn('Failed to create sent message record (non-fatal):', createErr?.message);
    }

    // Log sent email to ProjectActivity if linked to a project
    if (projectId) {
      entities.ProjectActivity.create({
        project_id: projectId,
        action: 'email_sent',
        description: `Email sent to ${to}: "${subject}"`,
        actor_type: 'user',
        user_name: account.display_name || account.email_address,
        user_email: account.email_address,
        created_date: new Date().toISOString(),
      }).catch(() => {});
    }

    // Report partial attachment failures alongside successful send
    const response_payload: Record<string, any> = { success: true, messageId: result.id };
    if (allAttachments.length > 0 && failedAttachments.length > 0) {
      response_payload.warnings = failedAttachments.map(
        f => `Attachment "${f.filename}" was not sent: ${f.error}`
      );
      response_payload.attachmentsSent = allAttachments.length - failedAttachments.length;
      response_payload.attachmentsFailed = failedAttachments.length;
    }
    return jsonResponse(response_payload);
  } catch (error: any) {
    const statusCode = error.message.includes('Unauthorized') ? 401 :
                       error.message.includes('not found') ? 404 : 500;
    console.error('sendGmailMessage error:', error.stack || error.message);
    return jsonResponse({
      error: error.message,
    }, statusCode);
  }
});
