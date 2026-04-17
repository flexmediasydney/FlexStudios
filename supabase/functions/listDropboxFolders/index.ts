import { getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const DROPBOX_TIMEOUT_MS = 15_000; // 15s timeout for Dropbox API calls

serveWithAudit('listDropboxFolders', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('Dropbox API token not configured', 500);

    // Get path from request body
    const body = await req.json().catch(() => ({} as any));
    const path = body.path ? (body.path.startsWith('/') ? body.path : '/' + body.path) : '';

    // Fetch folder contents from Dropbox
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: path,
        recursive: false,
        include_media_info: false,
        include_deleted: false,
      }),
      signal: AbortSignal.timeout(DROPBOX_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      return errorResponse(`Dropbox API error: ${error}`, response.status);
    }

    const data = await response.json();

    // Filter folders only
    const folders = (data.entries || [])
      .filter((entry: any) => entry['.tag'] === 'folder')
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .map((folder: any) => ({
        id: folder.id,
        name: folder.name,
        path: folder.path_display,
      }));

    return jsonResponse({ folders });

  } catch (err: any) {
    return errorResponse(err.message);
  }
});
