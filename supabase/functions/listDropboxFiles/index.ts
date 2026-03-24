import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const DROPBOX_TIMEOUT_MS = 15_000; // 15s timeout for Dropbox API calls

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('Dropbox API token not configured', 500);

    // Get path from request body
    const body = await req.json();
    const path = body.path ? (body.path.startsWith('/') ? body.path : '/' + body.path) : '';

    // Fetch folder contents from Dropbox (with pagination for large folders)
    let allEntries: any[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      let response: Response;
      if (!cursor) {
        response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: path,
            recursive: true,
            include_media_info: true,
            include_deleted: false,
          }),
          signal: AbortSignal.timeout(DROPBOX_TIMEOUT_MS),
        });
      } else {
        response = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cursor }),
          signal: AbortSignal.timeout(DROPBOX_TIMEOUT_MS),
        });
      }

      if (!response.ok) {
        const error = await response.text();
        return errorResponse(`Dropbox API error: ${error}`, response.status);
      }

      const data = await response.json();
      allEntries = allEntries.concat(data.entries || []);
      cursor = data.cursor || null;
      hasMore = !!data.has_more && allEntries.length < 2000;
    }

    // Filter and format files only (not folders)
    const files = allEntries
      .filter((entry: any) => entry['.tag'] === 'file')
      .sort((a: any, b: any) => new Date(b.client_modified).getTime() - new Date(a.client_modified).getTime())
      .map((file: any) => ({
        id: file.id,
        name: file.name,
        path: file.path_display,
        size: file.size,
        modified: file.client_modified,
        is_downloadable: file.is_downloadable,
        content_hash: file.content_hash,
      }));

    return jsonResponse({ files });

  } catch (err: any) {
    return errorResponse(err.message);
  }
});
