import { getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const DROPBOX_TIMEOUT_MS = 15_000; // 15s timeout for Dropbox API calls

serveWithAudit('getDropboxFilePreview', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json().catch(() => ({} as any));
    const { filePath } = body;
    if (!filePath) {
      return errorResponse('filePath required', 400, req);
    }

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('Dropbox API token not configured', 500);

    // Get temporary download link
    const response = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: filePath }),
      signal: AbortSignal.timeout(DROPBOX_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      return errorResponse(`Failed to get preview: ${error}`, response.status);
    }

    const data = await response.json();
    return jsonResponse({ url: data.link });

  } catch (err: any) {
    return errorResponse(err.message);
  }
});
