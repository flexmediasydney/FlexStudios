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

    // Refresh the access token
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
    if (!tokenData.access_token) {
      return errorResponse(`Failed to refresh Gmail token: ${tokenData.error || 'unknown'}`, 401);
    }
    const accessToken = tokenData.access_token;

    // Write refreshed token back
    await entities.EmailAccount.update(account.id, { access_token: accessToken });

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
            console.warn(`Failed to download attachment: ${url} (${attResponse.status})`);
            continue;
          }
          const attBytes = new Uint8Array(await attResponse.arrayBuffer());
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
          console.warn(`Failed to process attachment:`, attErr?.message);
        }
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

    const response = await fetch(
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

    return jsonResponse({ success: true, messageId: result.id });
  } catch (error: any) {
    const statusCode = error.message.includes('Unauthorized') ? 401 :
                       error.message.includes('not found') ? 404 : 500;
    return jsonResponse({
      error: error.message,
      details: error.stack
    }, statusCode);
  }
});
