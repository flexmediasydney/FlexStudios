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
      // Only log first failure for shared links (they'll all fail the same way)
      if (!shareUrl || filePath.endsWith('.jpg')) {
        const errText = await res.text().catch(() => '');
        console.warn(`Thumbnail failed for ${filePath}: ${res.status} ${errText.slice(0, 100)}`);
      }
      return null;
    }

    const buffer = await res.arrayBuffer();
    // Guard against empty or error responses disguised as 200
    if (buffer.byteLength < 100) {
      const text = new TextDecoder().decode(buffer);
      if (text.includes('error') || text.includes('access_denied')) {
        console.warn(`Thumbnail returned error body for ${filePath}: ${text.slice(0, 100)}`);
        return null;
      }
    }
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
    // Shared link: use individual get_thumbnail_v2 with link resource.
    // The Dropbox API may return access_denied for shared link thumbnails
    // depending on token scopes. Try the first file; if it fails, skip the rest.
    if (thumbnailable.length > 0) {
      const probe = await fetchSingleThumbnail(token, thumbnailable[0].path_display, shareUrl);
      if (probe) {
        thumbMap[thumbnailable[0].path_display] = probe;
        // First one worked -- fetch the rest in parallel batches
        const remaining = thumbnailable.slice(1);
        for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
          const batch = remaining.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (f: any) => {
              const thumb = await fetchSingleThumbnail(token, f.path_display, shareUrl);
              if (thumb) thumbMap[f.path_display] = thumb;
            })
          );
          results.forEach((r, idx) => {
            if (r.status === 'rejected') {
              console.warn(`Thumb failed: ${batch[idx]?.name}`, r.reason);
            }
          });
        }
      } else {
        console.warn('Shared link thumbnails unavailable (probe failed) — skipping all thumbnails');
      }
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
 *
 * IMPORTANT: When listing via shared links, Dropbox entries do NOT include
 * path_display or path_lower. We must synthesize them from parentPath + name.
 */
async function listFolder(
  token: string,
  path: string,
  shareUrl?: string,
  recursive = false,
  parentPath = ''
): Promise<any[]> {
  let allEntries: any[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    let data: any;
    if (!cursor) {
      const listBody: any = {
        path,
        include_media_info: true,
        include_deleted: false,
        limit: 300,
      };
      if (shareUrl) {
        // Shared links do NOT support recursive listing.
        // Omit the recursive parameter entirely for shared links.
        listBody.shared_link = { url: shareUrl };
      } else if (recursive) {
        listBody.recursive = true;
      }
      data = await dropboxPost(token, '/files/list_folder', listBody);
    } else {
      data = await dropboxPost(token, '/files/list_folder/continue', { cursor });
    }

    // When listing via shared link, entries lack path_display.
    // Synthesize it from parentPath + entry name so downstream code works.
    if (shareUrl) {
      for (const entry of (data.entries || [])) {
        if (!entry.path_display) {
          const prefix = parentPath || path || '';
          entry.path_display = prefix ? `${prefix}/${entry.name}` : `/${entry.name}`;
        }
      }
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
      const topLevel = await listFolder(token, '', share_url, false, '');

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
          // For shared links, use /<folder_name> as path (entries lack path_display)
          const subPath = `/${folder.name}`;
          const subEntries = await listFolder(
            token,
            subPath,
            share_url,
            false,
            subPath
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
      // Build a clean shared link base for preview URL construction
      const shareBase = share_url.split('?')[0];
      const rlkeyMatch = share_url.match(/rlkey=([^&]+)/);
      const rlkey = rlkeyMatch ? rlkeyMatch[1] : '';

      const grouped = folderResults.map(group => ({
        name: group.name,
        files: group.files.map((f: any) => {
          // Construct a Dropbox preview URL for opening the file in Dropbox's viewer
          const encodedPath = encodeURIComponent(f.path_display?.replace(/^\//, '') || `${group.name}/${f.name}`);
          const previewUrl = rlkey
            ? `${shareBase}?rlkey=${rlkey}&preview=${encodeURIComponent(f.name)}&subfolder_nav_tracking=1`
            : share_url;

          return {
            name:        f.name,
            path:        f.path_display || `/${group.name}/${f.name}`,
            size:        f.size,
            modified:    f.client_modified,
            type:        classifyFile(f.name),
            ext:         (f.name.split('.').pop() || '').toLowerCase(),
            thumbnail:   thumbMap[f.path_display] || null,
            preview_url: previewUrl,
            duration:    f.media_info?.metadata?.duration || null,
            width:       f.media_info?.metadata?.dimensions?.width || null,
            height:      f.media_info?.metadata?.dimensions?.height || null,
          };
        }),
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
    // Include context in error to help frontend debugging
    const msg = err.message || 'Unknown error';
    const isTokenError = msg.includes('invalid_access_token') || msg.includes('expired_access_token');
    if (isTokenError) {
      return errorResponse('Dropbox token expired — please refresh in settings', 502);
    }
    return errorResponse(msg);
  }
});
