import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // This function can be called by pg_cron (no user) or manually (with user)
    const user = await getUserFromReq(req);

    // Find all pending scheduled emails that are due
    const now = new Date().toISOString();
    const pendingEmails = await entities.ScheduledEmail.filter({
      status: 'pending',
    });

    // Filter to only those that are due
    const dueEmails = pendingEmails.filter((e: any) => e.send_at && new Date(e.send_at) <= new Date(now));

    if (dueEmails.length === 0) {
      return jsonResponse({ success: true, sent: 0, message: 'No scheduled emails due' });
    }

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      return errorResponse('Google OAuth credentials not configured', 500);
    }

    let sent = 0;
    let failed = 0;

    for (const scheduled of dueEmails) {
      try {
        // Mark as processing to prevent double-send
        await entities.ScheduledEmail.update(scheduled.id, { status: 'sending' });

        // Get the email account
        const accounts = await entities.EmailAccount.filter({ id: scheduled.email_account_id });
        if (accounts.length === 0) {
          await entities.ScheduledEmail.update(scheduled.id, { status: 'failed', error: 'Email account not found' });
          failed++;
          continue;
        }
        const account = accounts[0];

        if (!account.refresh_token) {
          await entities.ScheduledEmail.update(scheduled.id, { status: 'failed', error: 'No refresh token' });
          failed++;
          continue;
        }

        // Refresh access token
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
          await entities.ScheduledEmail.update(scheduled.id, { status: 'failed', error: `Token refresh failed: ${tokenData.error}` });
          failed++;
          continue;
        }

        // Get user signature
        let finalBody = scheduled.body || '';
        if (scheduled.created_by) {
          const signatures = await entities.UserSignature.filter({
            user_id: scheduled.created_by,
            is_default: true
          });
          if (signatures.length > 0 && signatures[0].signature_html) {
            finalBody += `<br/><br/>${signatures[0].signature_html}`;
          }
        }

        // Build MIME message
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const fromHeader = account.display_name
          ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(account.display_name)))}?= <${account.email_address}>`
          : account.email_address;

        let mimeLines = [
          `From: ${fromHeader}`,
          `To: ${scheduled.to}`,
        ];
        if (scheduled.cc) mimeLines.push(`Cc: ${scheduled.cc}`);
        if (scheduled.bcc) mimeLines.push(`Bcc: ${scheduled.bcc}`);
        mimeLines.push(`Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(scheduled.subject || '')))}?=`);
        mimeLines.push('MIME-Version: 1.0');

        if (scheduled.in_reply_to) {
          mimeLines.push(`In-Reply-To: ${scheduled.in_reply_to}`);
          mimeLines.push(`References: ${scheduled.in_reply_to}`);
        }

        mimeLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
        mimeLines.push('');
        mimeLines.push(`--${boundary}`);
        mimeLines.push('Content-Type: text/html; charset="UTF-8"');
        mimeLines.push('');
        mimeLines.push(finalBody);
        mimeLines.push(`--${boundary}--`);

        const rawMessage = mimeLines.join('\r\n');
        const encodedMessage = btoa(unescape(encodeURIComponent(rawMessage)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        // Send via Gmail API
        const sendUrl = scheduled.thread_id
          ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
          : 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

        const sendBody: any = { raw: encodedMessage };
        if (scheduled.thread_id) sendBody.threadId = scheduled.thread_id;

        const sendRes = await fetch(sendUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(sendBody),
        });

        if (!sendRes.ok) {
          const errText = await sendRes.text();
          await entities.ScheduledEmail.update(scheduled.id, { status: 'failed', error: `Gmail API: ${sendRes.status} ${errText}` });
          failed++;
          continue;
        }

        const sendResult = await sendRes.json();
        await entities.ScheduledEmail.update(scheduled.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          gmail_message_id: sendResult.id,
        });
        sent++;

      } catch (error: any) {
        console.error(`Failed to send scheduled email ${scheduled.id}:`, error);
        await entities.ScheduledEmail.update(scheduled.id, {
          status: 'failed',
          error: error?.message || 'Unknown error',
        });
        failed++;
      }
    }

    return jsonResponse({ success: true, sent, failed, total: dueEmails.length });
  } catch (error: any) {
    console.error('Error processing scheduled emails:', error);
    return errorResponse('Failed to process scheduled emails: ' + (error?.message || 'Unknown error'));
  }
});
