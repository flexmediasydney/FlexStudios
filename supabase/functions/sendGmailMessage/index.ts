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

    const { emailAccountId, to, cc, bcc, subject, body, inReplyTo, threadId,
        attachmentUrls = [], idempotency_key, projectId } = await req.json();

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

    // Get user signature
    const signatures = await entities.UserSignature.filter({
      user_id: user.id,
      is_default: true
    });

    let finalBody = body;
    if (signatures.length > 0) {
      finalBody += `\n${signatures[0].signature_html}`;
    }

    // Build email with proper From header and In-Reply-To for threading
    const fromHeader = account.display_name
      ? `${account.display_name} <${account.email_address}>`
      : account.email_address;

    const email = [
      `From: ${fromHeader}`,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      bcc ? `Bcc: ${bcc}` : '',
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
      inReplyTo ? `References: ${inReplyTo}` : '',
      `Subject: ${subject}`,
      'Content-Type: text/html; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      finalBody
    ].filter(Boolean).join('\r\n');

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
        to: [to],
        cc: cc ? [cc] : [],
        subject,
        body: finalBody,
        is_sent: true,
        received_at: new Date().toISOString(),
        idempotency_key: idempotency_key || null,
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
