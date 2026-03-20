import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient role' }, { status: 403 });
    }

    const { emailAccountId, to, cc, bcc, subject, body, inReplyTo, threadId,
        attachmentUrls = [], idempotency_key } = await req.json();

    // Validate required fields
    if (!emailAccountId) {
      return Response.json({ error: 'emailAccountId is required' }, { status: 400 });
    }
    if (!to?.trim()) {
      return Response.json({ error: 'Recipient (to) is required' }, { status: 400 });
    }
    if (!subject?.trim()) {
      return Response.json({ error: 'Subject is required' }, { status: 400 });
    }

    const emailAccount = await base44.entities.EmailAccount.filter({
      id: emailAccountId,
      assigned_to_user_id: user.id
    });

    if (emailAccount.length === 0) {
      return Response.json({ error: 'Email account not found' }, { status: 404 });
    }

    const account = emailAccount[0];

    // Deduplication: reject if same idempotency_key was sent within the last 60 seconds
    if (idempotency_key) {
      const recentSent = await base44.entities.EmailMessage.filter({
        idempotency_key,
        email_account_id: account.id,
      }, null, 1);
      if (recentSent.length > 0) {
        const sentAt = new Date(recentSent[0].received_at).getTime();
        const ageSeconds = (Date.now() - sentAt) / 1000;
        if (ageSeconds < 60) {
          return Response.json({
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
      return Response.json({ error: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in environment secrets' }, { status: 500 });
    }

    if (!account.refresh_token) {
      return Response.json({ error: 'Gmail account has no refresh token — user must reconnect their Gmail account in Inbox settings' }, { status: 401 });
    }

    // Refresh the access token using the stored refresh_token from the EmailAccount entity.
    // The custom Gmail OAuth flow stores credentials there — not in base44.connectors.
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
      return Response.json({ error: `Failed to refresh Gmail token: ${tokenData.error || 'unknown'}` }, { status: 401 });
    }
    const accessToken = tokenData.access_token;

    // Write refreshed token back
    await base44.entities.EmailAccount.update(account.id, { access_token: accessToken });

    // Get user signature
    const signatures = await base44.entities.UserSignature.filter({
      user_id: user.id,
      is_default: true
    });

    let finalBody = body;
    if (signatures.length > 0) {
      finalBody += `\n${signatures[0].signature_html}`;
    }

    // Build email
    const email = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      bcc ? `Bcc: ${bcc}` : '',
      `Subject: ${subject}`,
      'Content-Type: text/html; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      finalBody
    ].filter(Boolean).join('\r\n');

    const encodedEmail = btoa(email).replace(/\+/g, '-').replace(/\//g, '_');

    const payload = {
      raw: encodedEmail,
      threadId: threadId
    };

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
    let projectId = null;
    try {
      const body2 = await req.clone().json().catch(() => ({}));
      projectId = body2?.projectId || null;
    } catch { /* ignore */ }

    try {
      await base44.entities.EmailMessage.create({
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
    } catch (createErr) {
      console.warn('Failed to create sent message record (non-fatal):', createErr?.message);
    }

    // Fix 5a — log sent email to ProjectActivity if linked to a project
    if (projectId) {
      base44.entities.ProjectActivity.create({
        project_id: projectId,
        action: 'email_sent',
        description: `Email sent to ${to}: "${subject}"`,
        actor_type: 'user',
        user_name: account.display_name || account.email_address,
        user_email: account.email_address,
        created_date: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({ success: true, messageId: result.id });
  } catch (error) {
    const statusCode = error.message.includes('Unauthorized') ? 401 : 
                       error.message.includes('not found') ? 404 : 500;
    return Response.json({ 
      error: error.message,
      details: error.stack 
    }, { status: statusCode });
  }
});