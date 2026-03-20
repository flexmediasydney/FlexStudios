import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { filePath } = await req.json();
    if (!filePath) {
      return Response.json({ error: 'filePath required' }, { status: 400 });
    }

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) {
      return Response.json({ error: 'Dropbox API token not configured' }, { status: 500 });
    }

    // Get temporary download link
    const response = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: filePath })
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({ error: `Failed to get preview: ${error}` }, { status: response.status });
    }

    const data = await response.json();
    return Response.json({ url: data.link });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});