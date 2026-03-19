import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

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

    // Fetch folder contents from Dropbox
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
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
    });

    if (!response.ok) {
      const error = await response.text();
      return errorResponse(`Dropbox API error: ${error}`, response.status);
    }

    const data = await response.json();

    // Filter and format files only (not folders)
    const files = (data.entries || [])
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
