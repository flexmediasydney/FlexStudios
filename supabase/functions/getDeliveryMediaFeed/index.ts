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

function shouldSkip(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return SKIP_EXTS.has(ext);
}

async function dropboxPost(token: string, endpoint: string, body: any, isContent = false, retries = 2) {
  const base = isContent ? DROPBOX_CONTENT_BASE : DROPBOX_API_BASE;
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Retry on 429 rate limit with Retry-After header
  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
    const waitMs = Math.min(retryAfter, 10) * 1000;
    await new Promise(r => setTimeout(r, waitMs));
    return dropboxPost(token, endpoint, body, isContent, retries - 1);
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox ${endpoint}: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch a thumbnail using the content endpoint with Dropbox-API-Arg header.
 * For shared links, uses the "link" resource tag.
 * Returns base64 string or null on failure.
 */
async function fetchSingleThumbnail(
  token: string,
  filePath: string,
  shareUrl?: string
): Promise<string | null> {
  const resource = shareUrl
    ? { '.tag': 'link', url: shareUrl, path: filePath }
    : { '.tag': 'path', path: filePath };

  const apiArg = JSON.stringify({
    resource,
    size: 'w480h320',
    mode: 'fitone_bestfit',
    format: 'jpeg',
  });

  try {
    const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/get_thumbnail_v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Dropbox-API-Arg': apiArg,
      },
    });

    if (!res.ok) {
      console.warn(`Thumbnail failed for ${filePath}: ${res.status}`);
      return null;
    }

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (err: any) {
    console.warn(`Thumbnail error for ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Batch fetch thumbnails in groups of 25.
 * For shared links we use individual get_thumbnail_v2 calls (batch endpoint doesn't support shared links).
 * For direct paths we use the batch endpoint.
 */
async function fetchThumbnailsBatch(
  token: string,
  files: any[],
  shareUrl?: string
): Promise<Record<string, string>> {
  const thumbMap: Record<string, string> = {};
  const thumbnailable = files.filter(f => canThumbnail(f.name));
  const BATCH_SIZE = 25;

  if (shareUrl) {
    // Shared link: use individual get_thumbnail_v2 with link resource
    // Process in parallel batches of BATCH_SIZE
    for (let i = 0; i < thumbnailable.length; i += BATCH_SIZE) {
      const batch = thumbnailable.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (f: any) => {
          const thumb = await fetchSingleThumbnail(token, f.path_display, shareUrl);
          if (thumb) thumbMap[f.path_display] = thumb;
        })
      );
      // Log failures but don't break
      results.forEach((r, idx) => {
        if (r.status === 'rejected') {
          console.warn(`Thumb failed: ${batch[idx]?.name}`, r.reason);
        }
      });
    }
  } else {
    // Direct path: use batch endpoint
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
        }, true);

        (result.entries || []).forEach((entry: any) => {
          if (entry['.tag'] === 'success' && entry.thumbnail) {
            thumbMap[entry.metadata.path_display] = entry.thumbnail;
          }
        });
      } catch (batchErr: any) {
        console.warn('Thumbnail batch failed:', batchErr.message);
      }
    }
  }

  return thumbMap;
}

/**
 * List all entries in a folder, handling pagination.
 * For shared links, pass shareUrl and use relative paths.
 */
async function listFolder(
  token: string,
  path: string,
  shareUrl?: string,
  recursive = false
): Promise<any[]> {
  let allEntries: any[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    let data: any;
    if (!cursor) {
      const listBody: any = {
        path,
        recursive,
        include_media_info: true,
        include_deleted: false,
        limit: 300,
      };
      if (shareUrl) {
        listBody.shared_link = { url: shareUrl };
      }
      data = await dropboxPost(token, '/files/list_folder', listBody);
    } else {
      data = await dropboxPost(token, '/files/list_folder/continue', { cursor });
    }
    allEntries = allEntries.concat(data.entries || []);
    cursor = data.cursor || null;
    hasMore = data.has_more && allEntries.length < 500;
  }

  return allEntries;
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

    const useSharedLink = !!share_url;
    const normPath = path ? (path.startsWith('/') ? path : '/' + path) : '';

    // ── SHARED LINK MODE: list subfolders individually, return grouped ──
    if (useSharedLink) {
      // Step 1: List top-level to find subfolders
      const topLevel = await listFolder(token, '', share_url, false);

      const folders: any[] = [];
      const topLevelFiles: any[] = [];

      // Separate folders from files at root level
      for (const entry of topLevel) {
        if (entry['.tag'] === 'folder') {
          folders.push(entry);
        } else if (entry['.tag'] === 'file' && !shouldSkip(entry.name)) {
          topLevelFiles.push(entry);
        }
      }

      // Step 2: List each subfolder's contents
      const folderResults: { name: string; files: any[] }[] = [];

      for (const folder of folders) {
        try {
          const subEntries = await listFolder(
            token,
            folder.path_display,
            share_url,
            false
          );

          const subFiles = subEntries
            .filter((e: any) => e['.tag'] === 'file')
            .filter((e: any) => !shouldSkip(e.name))
            .sort((a: any, b: any) =>
              new Date(b.client_modified).getTime() - new Date(a.client_modified).getTime()
            )
            .slice(0, 100); // Cap per subfolder

          if (subFiles.length > 0) {
            folderResults.push({ name: folder.name, files: subFiles });
          }
        } catch (err: any) {
          console.warn(`Failed to list subfolder ${folder.name}:`, err.message);
        }
      }

      // If there are loose files at root, add them as a group
      if (topLevelFiles.length > 0) {
        folderResults.unshift({ name: 'Root', files: topLevelFiles });
      }

      // Step 3: Fetch thumbnails for all files across all folders
      const allFiles = folderResults.flatMap(f => f.files);
      const thumbMap = await fetchThumbnailsBatch(token, allFiles, share_url);

      // Step 4: Assemble grouped response
      const grouped = folderResults.map(group => ({
        name: group.name,
        files: group.files.map((f: any) => ({
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
        })),
      }));

      return jsonResponse({ folders: grouped });
    }

    // ── DIRECT PATH MODE: recursive listing, flat response (original behavior) ──
    const allEntries = await listFolder(token, normPath, undefined, true);

    // Filter to deliverable files
    const files = allEntries
      .filter((e: any) => e['.tag'] === 'file')
      .filter((e: any) => !shouldSkip(e.name))
      .sort((a: any, b: any) => new Date(b.client_modified).getTime() - new Date(a.client_modified).getTime())
      .slice(0, 200);

    if (files.length === 0) {
      return jsonResponse({ files: [] });
    }

    // Batch thumbnails for direct path mode
    const thumbMap = await fetchThumbnailsBatch(token, files);

    // Assemble flat response
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
