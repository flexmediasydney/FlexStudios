import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

//
// Import historical (legacy) projects into legacy_projects. Accepts CSV rows
// (either as an already-parsed array under `rows` or a signed URL under
// `data_url`) or JSON. Caller provides a column_mapping describing which
// source columns map to our internal field names.
//
// Only the BEFORE trigger's address parse runs during insert — geocoding and
// package mapping are done by sibling workers (geocodeLegacyProjects and the
// package-mapping pass).
//
// Body contract (FROZEN):
//   {
//     batch_id:        uuid            // existing legacy_import_batches row
//     format:          'csv' | 'json'
//     column_mapping:  Record<string, string>   // source_col -> field
//     rows?:           Record<string, any>[]    // already-parsed
//     data_url?:       string                    // signed URL to fetch raw file
//   }
//
// Response:
//   { batch_id, imported_count, error_count, row_count, errors: [...] }
//

type ColMap = Record<string, string>;

// Fields we accept directly onto legacy_projects.
const DIRECT_FIELDS = new Set([
  'source',            // per-row override (falls back to batch.source)
  'external_id',
  'raw_address',
  'property_key', 'suburb', 'postcode', 'state',  // allow manual override; trigger is COALESCE
  'latitude', 'longitude',
  'project_name',
  'completed_date',
  'package_name_legacy',
  'products_legacy',
  'price',
  'currency',
  'agent_name',
  'agency_name',
  'client_name',
  'client_email',
  'client_phone',
]);

function parseCsv(text: string): Record<string, string>[] {
  // Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes,
  // CRLF / LF line endings. Not meant to replace a full CSV library but
  // covers the Pipedrive exports we've seen (comma delimiter, "" escaping).
  const out: Record<string, string>[] = [];
  if (!text) return out;

  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { cur.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      cur.push(field); field = '';
      rows.push(cur); cur = [];
      i++; continue;
    }
    field += c; i++;
  }
  // flush last field
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }

  if (rows.length === 0) return out;
  const headers = rows[0].map(h => h.trim());
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === '') continue; // skip blank lines
    const obj: Record<string, string> = {};
    for (let k = 0; k < headers.length; k++) {
      obj[headers[k]] = (row[k] ?? '').trim();
    }
    out.push(obj);
  }
  return out;
}

function coerceValue(field: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === '' || s === null) return null;

  switch (field) {
    case 'price':
    case 'latitude':
    case 'longitude': {
      const cleaned = typeof s === 'string' ? s.replace(/[$,\s]/g, '') : s;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    case 'completed_date': {
      if (s instanceof Date) return s.toISOString().slice(0, 10);
      if (typeof s === 'string') {
        // Accept YYYY-MM-DD or DD/MM/YYYY (AU) or M/D/YYYY
        const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
        const au = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(s);
        if (au) {
          const d = au[1].padStart(2, '0');
          const m = au[2].padStart(2, '0');
          const y = au[3].length === 2 ? `20${au[3]}` : au[3];
          return `${y}-${m}-${d}`;
        }
        // Fallback to Date parse
        const parsed = new Date(s);
        if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
      }
      return null;
    }
    case 'products_legacy': {
      if (typeof s === 'string') {
        try { return JSON.parse(s); } catch { return [{ raw: s }]; }
      }
      return s;
    }
    default:
      return typeof s === 'string' ? s : String(s);
  }
}

function applyMapping(sourceRow: Record<string, unknown>, mapping: ColMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceCol, targetField] of Object.entries(mapping)) {
    if (!targetField || !DIRECT_FIELDS.has(targetField)) continue;
    const v = sourceRow[sourceCol];
    const coerced = coerceValue(targetField, v);
    if (coerced !== null && coerced !== undefined) out[targetField] = coerced;
  }
  return out;
}

serveWithAudit('importLegacyProjects', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('POST only', 405, req);

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401, req);
    if (user.role !== 'master_admin' && user.role !== 'admin') {
      return errorResponse('Forbidden — admin only', 403, req);
    }

    const body = await req.json().catch(() => ({} as any));
    const {
      batch_id,
      format,
      column_mapping,
      rows: suppliedRows,
      data_url,
    } = body ?? {};

    if (!batch_id) return errorResponse('batch_id required', 400, req);
    if (format !== 'csv' && format !== 'json') {
      return errorResponse("format must be 'csv' or 'json'", 400, req);
    }
    if (!column_mapping || typeof column_mapping !== 'object') {
      return errorResponse('column_mapping required', 400, req);
    }

    const admin = getAdminClient();

    // Verify the batch exists
    const { data: batch, error: batchErr } = await admin
      .from('legacy_import_batches')
      .select('*')
      .eq('id', batch_id)
      .single();
    if (batchErr || !batch) return errorResponse(`batch ${batch_id} not found`, 404, req);

    // Mark batch in_progress
    await admin
      .from('legacy_import_batches')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', batch_id);

    // Load raw rows
    let rawRows: Record<string, unknown>[] = [];
    if (Array.isArray(suppliedRows) && suppliedRows.length > 0) {
      rawRows = suppliedRows;
    } else if (typeof data_url === 'string' && data_url.length > 0) {
      const res = await fetch(data_url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        await admin.from('legacy_import_batches').update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          notes: `fetch ${data_url} → ${res.status}`,
        }).eq('id', batch_id);
        return errorResponse(`Failed to fetch data_url: ${res.status}`, 502, req);
      }
      if (format === 'csv') {
        rawRows = parseCsv(await res.text());
      } else {
        const parsed = await res.json();
        rawRows = Array.isArray(parsed) ? parsed : (parsed?.rows ?? []);
      }
    } else {
      return errorResponse('Provide either rows[] or data_url', 400, req);
    }

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      await admin.from('legacy_import_batches').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        row_count: 0, imported_count: 0, error_count: 0,
        notes: 'no rows',
      }).eq('id', batch_id);
      return jsonResponse({
        batch_id, row_count: 0, imported_count: 0, error_count: 0, errors: [],
      });
    }

    // Translate rows via column_mapping
    const errors: Array<{ row_index: number; error: string; raw?: unknown }> = [];
    const insertRows: Record<string, unknown>[] = [];

    for (let idx = 0; idx < rawRows.length; idx++) {
      const src = rawRows[idx];
      try {
        const mapped = applyMapping(src as Record<string, unknown>, column_mapping as ColMap);
        if (!mapped.raw_address || typeof mapped.raw_address !== 'string' || mapped.raw_address.trim().length < 5) {
          errors.push({ row_index: idx, error: 'raw_address missing or too short' });
          continue;
        }
        // Default source from batch if row didn't supply one
        if (!mapped.source) mapped.source = batch.source;
        mapped.import_batch_id = batch_id;
        mapped.raw_payload = src;
        insertRows.push(mapped);
      } catch (e) {
        errors.push({ row_index: idx, error: (e as Error).message });
      }
    }

    // Chunked insert — 500 rows per call keeps payloads under PostgREST limits.
    const CHUNK = 500;
    let imported = 0;
    for (let i = 0; i < insertRows.length; i += CHUNK) {
      const chunk = insertRows.slice(i, i + CHUNK);
      const { error, data } = await admin
        .from('legacy_projects')
        .upsert(chunk, {
          onConflict: 'source,external_id',
          ignoreDuplicates: false,
          defaultToNull: false,
        })
        .select('id');
      if (error) {
        // Log the first error but don't abort — try remaining chunks so caller
        // gets maximum signal. Map to synthetic row_index of first row in chunk.
        errors.push({ row_index: i, error: error.message });
      } else {
        imported += (data?.length ?? chunk.length);
      }
    }

    const status = errors.length === 0 ? 'completed' : (imported > 0 ? 'completed' : 'failed');
    await admin.from('legacy_import_batches').update({
      row_count:      rawRows.length,
      imported_count: imported,
      error_count:    errors.length,
      status,
      completed_at:   new Date().toISOString(),
    }).eq('id', batch_id);

    return jsonResponse({
      batch_id,
      row_count:      rawRows.length,
      imported_count: imported,
      error_count:    errors.length,
      errors:         errors.slice(0, 50),
    });
  } catch (err) {
    return errorResponse((err as Error).message ?? 'Unknown error', 500, req);
  }
});
