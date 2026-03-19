import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const { shareLink } = await req.json().catch(() => ({}));
  
  if (!shareLink) {
    return Response.json({ error: 'Share link required' }, { status: 400 });
  }

  const base44 = createClientFromRequest(req);

  try {
    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `Navigate to this Dropbox share link and download the complete file list: ${shareLink}

You MUST:
1. Open the link in a browser
2. Wait for the page to fully load
3. Scroll down to view ALL files in the folder
4. If there's a "Show more" button or pagination, click it to load every single file
5. Count the total number of files you can see
6. List every file name, file type, and size

Be exhaustive - if the folder shows "23 files" at the top, make sure you return all 23.

Return a JSON object with:
{
  "type": "file" or "folder",
  "name": "folder name",
  "file_count": total count,
  "files": [
    {"name": "filename.ext", "type": "file", "size": 123456},
    ...
  ]
}

Return ONLY the JSON, no other text.`,
      add_context_from_internet: true,
      response_json_schema: {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          file_count: { type: "number" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                size: { type: "number" }
              }
            }
          }
        },
        required: ["type", "name", "files"]
      }
    });

    return Response.json({
      ...result,
      success: true
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json(
      { error: error.message || 'Failed to fetch files', success: false },
      { status: 500 }
    );
  }
});