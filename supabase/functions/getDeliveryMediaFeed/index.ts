import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2';
const DROPBOX_API_BASE     = 'https://api.dropboxapi.com/2';

// File types that Dropbox can thumbnail
const THUMBNAILABLE = new Set([
  'jpg','jpeg','png','gif','webp','tiff','tif','bmp','ppm',
  'pdf',                          // floorplans
  'mp4','mov','wmv','avi','m4v',  // video frame extraction
  'ai','eps'                      // vector (best-effort)
]);

// Raw camera files -- skip entirely
const SKIP_EXTS = new Set(['dng','cr2','cr3','arw','nef','orf','raf','rw2','raw','nrw']);

// Media type classification
function classifyFile(name: string): 'image' | 'video' | 'document' | 'other' {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['jpg','jpeg','png','gif','webp','tiff','tif','bmp','heic','heif'].includes(ext)) return 'image';
  if (['mp4','mov','wmv','avi','m4v','webm','mkv'].includes(ext)) return 'video';
  if (['pdf','ai','eps','psd'].includes(ext)) return 'document';
  return 'other';
}

function canThumbnail(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return THUMBNAILABLE.has(ext) && !SKIP_EXTS.has(ext);
}

async function dropboxPost(token: string, endpoint: string, body: any, isContent = false) {
  const base = isContent ? DROPBOX_CONTENT_BASE : DROPBOX_API_BASE;
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox ${endpoint}: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('POST only', 405);

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('DROPBOX_API_TOKEN not configured', 500);

    const { path, share_url, action } = await req.json();

    // -- Action: get temporary download link for a single file
    if (action === 'get_temp_link') {
      const data = await dropboxPost(token, '/files/get_temporary_link', { path });
      return jsonResponse({ url: data.link });
    }

    // -- Action: list files + thumbnails for a folder
    if (!path && !share_url) return errorResponse('path or share_url required', 400);

    const useSharedLink = !path && !!share_url;
    const normPath = path ? (path.startsWith('/') ? path : '/' + path) : '';

    // Step 1: List folder (recursive to catch Images/, Video/, Floorplan/ subfolders)
    let allEntries: any[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      let data: any;
      if (!cursor) {
        const listBody: any = {
          path: useSharedLink ? '' : normPath,
          recursive: true,
          include_media_info: true,
          include_deleted: false,
          limit: 300,
        };
        if (useSharedLink) {
          listBody.shared_link = { url: share_url };
        }
        data = await dropboxPost(token, '/files/list_folder', listBody);
      } else {
        data = await dropboxPost(token, '/files/list_folder/continue', { cursor });
      }
      allEntries = allEntries.concat(data.entries || []);
      cursor   = data.cursor || null;
      hasMore  = data.has_more && allEntries.length < 500;
    }

    // Step 2: Filter to deliverable files only (skip RAW, skip folders)
    const files = allEntries
      .filter((e: any) => e['.tag'] === 'file')
      .filter((e: any) => !SKIP_EXTS.has((e.name.split('.').pop() || '').toLowerCase()))
      .sort((a: any, b: any) => new Date(b.client_modified).getTime() - new Date(a.client_modified).getTime())
      .slice(0, 200); // Hard cap

    if (files.length === 0) {
      return jsonResponse({ files: [] });
    }

    // Step 3: Separate thumbnailable from non-thumbnailable
    const thumbnailable = files.filter((f: any) => canThumbnail(f.name));

    // Step 4: Batch thumbnail requests (max 25 per Dropbox batch)
    const thumbMap: Record<string, string> = {};
    const BATCH_SIZE = 25;

    for (let i = 0; i < thumbnailable.length; i += BATCH_SIZE) {
      const batch = thumbnailable.slice(i, i + BATCH_SIZE);
      try {
        const result = await dropboxPost(token, '/files/get_thumbnail_batch', {
          entries: batch.map((f: any) => ({
            path: f.path_display,
            format: 'jpeg',
            size: 'w640h480',
            mode: 'fitone_bestfit',
          })),
        }, true); // content API

        (result.entries || []).forEach((entry: any) => {
          if (entry['.tag'] === 'success' && entry.thumbnail) {
            thumbMap[entry.metadata.path_display] = entry.thumbnail;
          }
        });
      } catch (batchErr: any) {
        // Non-fatal -- continue without thumbnails for this batch
        console.warn('Thumbnail batch failed:', batchErr.message);
      }
    }

    // Step 5: Assemble response
    const result = files.map((f: any) => ({
      name:      f.name,
      path:      f.path_display,
      size:      f.size,
      modified:  f.client_modified,
      type:      classifyFile(f.name),
      ext:       (f.name.split('.').pop() || '').toLowerCase(),
      thumbnail: thumbMap[f.path_display] || null,
      duration:  f.media_info?.metadata?.duration || null,
      width:     f.media_info?.metadata?.dimensions?.width || null,
      height:    f.media_info?.metadata?.dimensions?.height || null,
    }));

    return jsonResponse({ files: result });

  } catch (err: any) {
    console.error('getDeliveryMediaFeed error:', err);
    return errorResponse(err.message);
  }
});
