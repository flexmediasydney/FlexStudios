/**
 * shortlisting-ingest
 * ───────────────────
 * Entry point for a Pass 0 round. Lists CR3 files in the project's
 * `Photos/Raws/Shortlist Proposed/` Dropbox folder, opens a new
 * `shortlisting_rounds` row, and queues `shortlisting_jobs` of kind='extract'
 * (chunked at 50 files per job).
 *
 * Pipeline per invocation:
 *   1. Resolve the project's Photos shortlist-proposed folder via projectFolders.
 *   2. List CR3 / CR2 / ARW / NEF / RAF / DNG files.
 *   3. Determine the booked package (projects.tonomo_package fallback to first
 *      packages[] entry) → derive package_ceiling per spec §12.
 *   4. Sanity-check file count vs expected package count; warn (don't fail) if
 *      drift > ±10 %.
 *   5. INSERT a new shortlisting_rounds row (round_number = next sequence,
 *      status='processing').
 *   6. UPDATE projects.current_shortlist_round_id to the new round.
 *   7. Chunk file_paths at CHUNK_SIZE (50) and INSERT one shortlisting_jobs
 *      row of kind='extract' per chunk.
 *   8. INSERT shortlisting_events row of event_type='round_started'.
 *   9. Return { ok, round_id, job_ids[], file_count }.
 *
 * Auth: service_role OR master_admin / admin / manager.
 *
 * Body: { project_id: string, trigger_source?: 'auto_settling' | 'manual' | 'reshoot' }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { listFolder } from '../_shared/dropbox.ts';
import { getFolderPath } from '../_shared/projectFolders.ts';

const GENERATOR = 'shortlisting-ingest';
const CHUNK_SIZE = 50;
const SUPPORTED_RAW_EXT = ['.cr3', '.cr2', '.arw', '.nef', '.raf', '.dng'];

// Package ceilings per spec §12.
const PACKAGE_CEILING_DEFAULT = 24;
const PACKAGE_CEILINGS: Record<string, number> = {
  gold: 24,
  'gold+3': 24,
  'day to dusk': 31,
  'day-to-dusk': 31,
  'day_to_dusk': 31,
  'daytodusk': 31,
  premium: 38,
  architectural: 38,
};

/** Map a free-form package name onto the ceiling table. Case-insensitive. */
function resolvePackageCeiling(packageName: string | null | undefined): number {
  if (!packageName) return PACKAGE_CEILING_DEFAULT;
  const key = packageName.toLowerCase().trim();
  if (PACKAGE_CEILINGS[key] != null) return PACKAGE_CEILINGS[key];
  // Loose match: any key that's a substring of (or is contained within) the
  // package name. Catches 'Gold Standard', 'Premium Architectural', etc.
  for (const [needle, ceiling] of Object.entries(PACKAGE_CEILINGS)) {
    if (key.includes(needle) || needle.includes(key)) return ceiling;
  }
  return PACKAGE_CEILING_DEFAULT;
}

/**
 * Best-effort expected-file-count heuristic for sanity checking. Each composition
 * is 5 brackets, so for a Gold (~21 deliverables) we expect ~21 × 5 = 105 files,
 * with ~30 % over-shoot for editor selection — call it ~140. We use the package
 * ceiling × 5 × 1.5 as a rough upper bound and the lower bound is half of that.
 *
 * Drift > ±10 % is logged as a warning but does NOT block the round — the
 * photographer may have intentionally over-/under-shot.
 */
function expectedFileCountRange(packageCeiling: number): { low: number; high: number } {
  const center = packageCeiling * 5 * 1.5;
  return { low: Math.floor(center * 0.5), high: Math.ceil(center * 1.5) };
}

interface RequestBody {
  project_id?: string;
  trigger_source?: 'auto_settling' | 'manual' | 'reshoot';
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = typeof body.project_id === 'string' ? body.project_id : null;
  if (!projectId) return errorResponse('project_id required', 400, req);

  const triggerSource = body.trigger_source || 'manual';
  const actorId = (user?.id && user.id !== '__service_role__') ? user.id : null;
  const actorType = isService ? 'system' : 'user';

  try {
    const result = await ingest(projectId, triggerSource, actorId, actorType);
    return jsonResponse({ ok: true, ...result }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for project ${projectId}: ${msg}`);
    return errorResponse(`Ingest failed: ${msg}`, 500, req);
  }
});

interface IngestResult {
  round_id: string;
  round_number: number;
  job_ids: string[];
  file_count: number;
  package_type: string | null;
  package_ceiling: number;
  warnings: string[];
}

async function ingest(
  projectId: string,
  triggerSource: string,
  actorId: string | null,
  actorType: 'system' | 'user',
): Promise<IngestResult> {
  const admin = getAdminClient();
  const warnings: string[] = [];

  // 1. Project lookup — package, dropbox_root_path.
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, tonomo_package, packages, dropbox_root_path')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) throw new Error(`project lookup failed: ${projErr.message}`);
  if (!project) throw new Error(`project ${projectId} not found`);

  // Resolve package — prefer tonomo_package, fall back to first packages[] entry.
  let packageType: string | null = project.tonomo_package || null;
  if (!packageType && Array.isArray(project.packages) && project.packages.length > 0) {
    const first = project.packages[0];
    if (typeof first === 'string') packageType = first;
    else if (first && typeof first === 'object' && typeof first.name === 'string') {
      packageType = first.name;
    }
  }
  const packageCeiling = resolvePackageCeiling(packageType);

  // 2. Resolve folder path + list CR3 files.
  let folderPath: string;
  try {
    folderPath = await getFolderPath(projectId, 'photos_raws_shortlist_proposed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Photos shortlist folder not provisioned for project: ${msg}`);
  }

  const { entries } = await listFolder(folderPath, { recursive: false, maxEntries: 5000 });
  const filePaths = entries
    .filter((e) => e['.tag'] === 'file' && typeof e.name === 'string')
    .filter((e) => {
      const lower = e.name.toLowerCase();
      return SUPPORTED_RAW_EXT.some((ext) => lower.endsWith(ext));
    })
    .map((e) => e.path_display || `${folderPath}/${e.name}`)
    .sort();

  const fileCount = filePaths.length;

  // Burst 15 X2: refuse to create a round when the folder is empty. Without
  // this, ingest happily INSERTs a status='processing' shortlisting_rounds
  // row with zero extract jobs, the dispatcher does nothing, and the round
  // is stuck forever — visible to ops as a permanently-processing round
  // that no one can clear without SQL surgery. The frontend's
  // hasInflightRound guard then ALSO blocks "Run Shortlist Now" until a
  // human resolves the orphan. Returning a clear 400 keeps DB clean and
  // tells the photographer/operator to put files in the folder first.
  if (fileCount === 0) {
    throw new Error(
      `Photos shortlist folder is empty for project ${projectId} (folder='${folderPath}'). ` +
      `Drop CR3/CR2/ARW/NEF/RAF/DNG files into the folder before triggering a round.`,
    );
  }

  // 3. Sanity check — drift > ±10 % from expected range.
  const { low, high } = expectedFileCountRange(packageCeiling);
  if (fileCount < low) {
    warnings.push(`File count ${fileCount} below expected lower bound ${low} for package '${packageType ?? 'unknown'}'`);
  } else if (fileCount > high) {
    warnings.push(`File count ${fileCount} above expected upper bound ${high} for package '${packageType ?? 'unknown'}'`);
  }

  // 4. Determine next round_number for this project.
  const { data: existingRounds, error: existingErr } = await admin
    .from('shortlisting_rounds')
    .select('round_number')
    .eq('project_id', projectId)
    .order('round_number', { ascending: false })
    .limit(1);
  if (existingErr) throw new Error(`round_number lookup failed: ${existingErr.message}`);
  const nextRoundNumber = (existingRounds && existingRounds.length > 0
    ? (existingRounds[0].round_number || 0)
    : 0) + 1;

  // 5. Insert the round.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .insert({
      project_id: projectId,
      round_number: nextRoundNumber,
      status: 'processing',
      package_type: packageType,
      package_ceiling: packageCeiling,
      total_compositions: null,
      trigger_source: triggerSource,
      started_at: new Date().toISOString(),
    })
    .select('id, round_number')
    .single();
  if (roundErr || !round) throw new Error(`round insert failed: ${roundErr?.message || 'no row returned'}`);

  const roundId: string = round.id;

  // 6. Bind project to the new round.
  const { error: linkErr } = await admin
    .from('projects')
    .update({ current_shortlist_round_id: roundId })
    .eq('id', projectId);
  if (linkErr) {
    // Non-fatal — surface warning but proceed (round + jobs are still valid).
    warnings.push(`projects.current_shortlist_round_id update failed: ${linkErr.message}`);
  }

  // 7. Enqueue extract jobs (chunked).
  // Burst 11 S4: atomically insert all chunks in ONE statement. The previous
  // for-loop did one INSERT per chunk; if chunk N failed (network blip, RLS
  // hiccup) we'd throw with chunks 1..N-1 already committed. The dispatcher's
  // chain logic counts extract jobs in pending/running and fires pass0 once
  // all of them complete — but a round with only 3 of 4 chunks ever enqueued
  // would silently complete pass0 on incomplete data, dropping ~50 files
  // from the universe. PostgREST's array-form INSERT is atomic — either all
  // rows commit or none do — so a failure leaves a clean state.
  const jobIds: string[] = [];
  if (filePaths.length > 0) {
    const chunkRows: Array<Record<string, unknown>> = [];
    const chunkTotal = Math.ceil(filePaths.length / CHUNK_SIZE);
    for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + CHUNK_SIZE);
      chunkRows.push({
        project_id: projectId,
        round_id: roundId,
        kind: 'extract',
        status: 'pending',
        payload: {
          project_id: projectId,
          round_id: roundId,
          file_paths: chunk,
          chunk_index: Math.floor(i / CHUNK_SIZE),
          chunk_total: chunkTotal,
        },
        scheduled_for: new Date().toISOString(),
      });
    }
    const { data: insertedJobs, error: jobErr } = await admin
      .from('shortlisting_jobs')
      .insert(chunkRows)
      .select('id, payload');
    if (jobErr || !insertedJobs) {
      throw new Error(`extract job batch insert failed (${chunkRows.length} chunks): ${jobErr?.message || 'no rows returned'}`);
    }
    if (insertedJobs.length !== chunkRows.length) {
      throw new Error(
        `extract job batch returned ${insertedJobs.length} rows but expected ${chunkRows.length}`,
      );
    }
    // Sort by chunk_index so jobIds reflect file order — defensive against
    // PostgREST returning rows in arbitrary order. Tests/audit consumers
    // expect job_ids[0] = chunk 0.
    // deno-lint-ignore no-explicit-any
    const sorted = (insertedJobs as any[]).slice().sort((a, b) => {
      const ai = Number(a?.payload?.chunk_index ?? 0);
      const bi = Number(b?.payload?.chunk_index ?? 0);
      return ai - bi;
    });
    for (const r of sorted) jobIds.push(r.id);
  }

  // 8. Audit event.
  const { error: evtErr } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: projectId,
      round_id: roundId,
      event_type: 'round_started',
      actor_type: actorType,
      actor_id: actorId,
      payload: {
        trigger_source: triggerSource,
        file_count: fileCount,
        package_type: packageType,
        package_ceiling: packageCeiling,
        job_ids: jobIds,
        chunk_size: CHUNK_SIZE,
        warnings,
      },
    });
  if (evtErr) {
    warnings.push(`event insert failed: ${evtErr.message}`);
  }

  return {
    round_id: roundId,
    round_number: round.round_number,
    job_ids: jobIds,
    file_count: fileCount,
    package_type: packageType,
    package_ceiling: packageCeiling,
    warnings,
  };
}
