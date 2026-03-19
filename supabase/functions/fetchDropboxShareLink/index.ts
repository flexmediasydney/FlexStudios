import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const { shareLink } = await req.json().catch(() => ({} as any));

    if (!shareLink) {
      return errorResponse('Share link required', 400);
    }

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('DROPBOX_API_TOKEN not configured', 500);

    // Use Dropbox shared link metadata + list_folder with shared_link to get file list
    // First, get metadata about the shared link
    const metaRes = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: shareLink }),
    });

    if (!metaRes.ok) {
      const errText = await metaRes.text();
      throw new Error(`Failed to get shared link metadata: ${errText.slice(0, 200)}`);
    }

    const meta = await metaRes.json();

    // If it's a file, return single file info
    if (meta['.tag'] === 'file') {
      return jsonResponse({
        type: 'file',
        name: meta.name,
        file_count: 1,
        files: [{ name: meta.name, type: 'file', size: meta.size || 0 }],
        success: true,
      });
    }

    // If it's a folder, list its contents
    const listRes = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: '',
        shared_link: { url: shareLink },
        recursive: true,
        include_deleted: false,
        limit: 500,
      }),
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`Failed to list shared folder: ${errText.slice(0, 200)}`);
    }

    const listData = await listRes.json();
    const files = (listData.entries || [])
      .filter((e: any) => e['.tag'] === 'file')
      .map((f: any) => ({
        name: f.name,
        type: 'file',
        size: f.size || 0,
      }));

    return jsonResponse({
      type: 'folder',
      name: meta.name,
      file_count: files.length,
      files,
      success: true,
    });

  } catch (error: any) {
    console.error('Error:', error);
    return errorResponse(error.message || 'Failed to fetch files');
  }
});
