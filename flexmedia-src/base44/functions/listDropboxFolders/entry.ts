import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) {
      return Response.json({ error: 'Dropbox API token not configured' }, { status: 500 });
    }

    // Get path from request body
    const body = await req.json();
    const path = body.path ? (body.path.startsWith('/') ? body.path : '/' + body.path) : '';

    // Fetch folder contents from Dropbox
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: path,
        recursive: false,
        include_media_info: false,
        include_deleted: false
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({ error: `Dropbox API error: ${error}` }, { status: response.status });
    }

    const data = await response.json();
    
    // Filter folders only
    const folders = (data.entries || [])
      .filter(entry => entry['.tag'] === 'folder')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(folder => ({
        id: folder.id,
        name: folder.name,
        path: folder.path_display
      }));

    return Response.json({ folders });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});