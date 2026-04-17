import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const refreshAccessToken = async (refreshToken: string): Promise<string> => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${data.error || 'unknown'}`);

  // Update stored token if rotated
  if (data.refresh_token) {
    const admin = getAdminClient();
    await admin.from('email_accounts').update({
      refresh_token: data.refresh_token,
      access_token: data.access_token,
    }).eq('refresh_token', refreshToken);
  }

  return data.access_token;
};

serveWithAudit('getEmailAttachment', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401, req);

    const { messageId, attachmentId, accountId } = await req.json();
    if (!messageId || !attachmentId || !accountId) {
      return errorResponse('messageId, attachmentId, and accountId are required', 400, req);
    }

    const admin = getAdminClient();

    // Get the email account (verify user owns it)
    const { data: account, error: accErr } = await admin
      .from('email_accounts')
      .select('id, user_id, access_token, refresh_token')
      .eq('id', accountId)
      .single();

    if (accErr || !account) return errorResponse('Email account not found', 404, req);
    if (account.user_id !== user.id && user.role !== 'master_admin') {
      return errorResponse('Access denied', 403, req);
    }
    if (!account.refresh_token) return errorResponse('No refresh token', 400, req);

    // Get fresh access token
    const accessToken = await refreshAccessToken(account.refresh_token);

    // Fetch attachment from Gmail API
    const gmailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
    const gmailRes = await fetch(gmailUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!gmailRes.ok) {
      const errText = await gmailRes.text();
      return errorResponse(`Gmail API error: ${gmailRes.status} ${errText}`, 502, req);
    }

    const gmailData = await gmailRes.json();
    if (!gmailData.data) return errorResponse('No attachment data returned', 404, req);

    // Gmail returns base64url-encoded data — convert to standard base64
    const base64Data = gmailData.data.replace(/-/g, '+').replace(/_/g, '/');

    return jsonResponse({
      data: base64Data,
      size: gmailData.size || 0,
    }, 200, req);
  } catch (err: any) {
    console.error('getEmailAttachment error:', err);
    return errorResponse(err.message || 'Internal error', 500, req);
  }
});
