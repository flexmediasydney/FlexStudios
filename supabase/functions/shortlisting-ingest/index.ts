/**
 * shortlisting-ingest
 * ───────────────────
 * Entry point for a Pass 0 round. Lists CR3 files in the project's
 * `Photos/Raws/Shortlist Proposed/` Dropbox folder, opens a new
 * `shortlisting_rounds` row, and queues `shortlisting_jobs` of kind='extract'
 * (chunked at 50 files per job).
 *
 * Wave 7 P1-6 (W7.7): the legacy hardcoded {Gold:24, Day-to-Dusk:31,
 * Premium:38} ceiling map is gone. Photo count target / min / max are now
 * computed dynamically from the project's products via
 * computeExpectedFileCount() — see _shared/packageCounts.ts. The engine tier
 * (S/P/A) is pre-resolved at ingest via resolveEngineTierId() and written to
 * shortlisting_rounds.engine_tier_id so Pass 2 reads it without
 * re-derivation.
 *
 * Manual-mode triggers (Joseph 2026-04-27, spec Section 4b):
 *   1. project_type.shortlisting_supported === false → manual round, no
 *      Pass 0 enqueue. manual_mode_reason = 'project_type_unsupported'.
 *   2. computeExpectedFileCount(...).target === 0 → graceful manual fallback
 *      (project has no photo deliverables). manual_mode_reason =
 *      'no_photo_products'.
 *
 * Pipeline per invocation:
 *   1. Resolve project + project_type, products catalog, package mapping,
 *      tiers table.
 *   2. Resolve engine_tier_id and { target, min, max } via the helpers.
 *   3. Manual-mode check — short-circuit to a synthetic round if either
 *      trigger fires.
 *   4. List Dropbox files; refuse on empty folder.
 *   5. Open shortlisting_rounds row with engine_tier_id +
 *      expected_count_target/min/max + (legacy package_ceiling kept for
 *      back-compat with already-migrated rows).
 *   6. UPDATE projects.current_shortlist_round_id.
 *   7. Chunk file_paths and INSERT one extract job per chunk.
 *   8. Emit round_started event.
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
import {
  computeExpectedFileCount,
  flattenProjectProducts,
  type ProductCatalogEntry,
} from '../_shared/packageCounts.ts';
import {
  resolveEngineTierId,
  type PackageEngineTierMappingRow,
  type ShortlistingTierRow,
} from '../_shared/engineTierResolver.ts';
import { resolveManualModeReason } from '../_shared/manualModeResolver.ts';
import { ENGINE_VERSION } from '../_shared/engineVersion.ts';
import { getActiveTierConfig } from '../_shared/tierConfig.ts';

const GENERATOR = 'shortlisting-ingest';
const CHUNK_SIZE = 50;
const SUPPORTED_RAW_EXT = ['.cr3', '.cr2', '.arw', '.nef', '.raf', '.dng'];

// Engine roles that count toward the photo shortlist target. Drone, video,
// floorplan, etc. are separate engine_roles handled by their own engines.
const PHOTO_ENGINE_ROLES = ['photo_day_shortlist', 'photo_dusk_shortlist'];
const PHOTO_FALLBACK_CATEGORIES = ['Images', 'images'];

interface RequestBody {
  project_id?: string;
  job_id?: string;             // dispatcher passes {job_id} only — we resolve project_id from it
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

  // Resolve project_id from explicit body field OR from job_id (dispatcher path).
  // The shortlisting-job-dispatcher invokes every edge fn with body={job_id}; we
  // look up the project_id from shortlisting_jobs when only job_id is provided.
  let projectId: string | null = typeof body.project_id === 'string' ? body.project_id : null;
  if (!projectId && typeof body.job_id === 'string' && body.job_id) {
    const adminLookup = getAdminClient();
    const { data: jobRow } = await adminLookup
      .from('shortlisting_jobs')
      .select('project_id')
      .eq('id', body.job_id)
      .maybeSingle();
    projectId = jobRow?.project_id ? String(jobRow.project_id) : null;
  }
  if (!projectId) return errorResponse('project_id (or job_id) required', 400, req);

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
  engine_tier_id: string | null;
  expected_count_target: number;
  expected_count_min: number;
  expected_count_max: number;
  status: 'processing' | 'manual';
  manual_mode_reason: string | null;
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

  // 1. Project lookup — full shape for tier + count resolution.
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select(
      'id, tonomo_package, packages, products, pricing_tier, project_type_id, dropbox_root_path',
    )
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) throw new Error(`project lookup failed: ${projErr.message}`);
  if (!project) throw new Error(`project ${projectId} not found`);

  // 2. Project type — for manual-mode trigger #1.
  let shortlistingSupported = true;
  if (project.project_type_id) {
    const { data: ptype, error: ptypeErr } = await admin
      .from('project_types')
      .select('id, shortlisting_supported')
      .eq('id', project.project_type_id)
      .maybeSingle();
    if (ptypeErr) {
      warnings.push(`project_types lookup failed: ${ptypeErr.message} (defaulting shortlisting_supported=true)`);
    } else if (ptype && typeof ptype.shortlisting_supported === 'boolean') {
      shortlistingSupported = ptype.shortlisting_supported;
    }
  }

  // 3. Resolve human-readable package name (for round.package_type, audit
  // events, prompt context). Prefer tonomo_package (legacy), fall back to
  // first packages[] entry. Engine logic no longer reads this — engine_tier_id
  // is the source of truth.
  let packageType: string | null = project.tonomo_package || null;
  if (!packageType && Array.isArray(project.packages) && project.packages.length > 0) {
    const first = project.packages[0];
    if (typeof first === 'string') packageType = first;
    else if (first && typeof first === 'object' && typeof first.name === 'string') {
      packageType = first.name;
    }
  }

  // 4. Load products catalog, package mapping, and tiers in parallel.
  const [productsCatalog, packageEngineTierMapping, tiers] = await Promise.all([
    loadProductsCatalog(admin),
    loadPackageEngineTierMapping(admin),
    loadShortlistingTiers(admin),
  ]);

  // 5. Resolve engine tier (defensive: if shortlisting_tiers table is unseeded
  // we'd throw; fall through to a clear error so ops can backfill).
  let engineTierId: string | null = null;
  try {
    engineTierId = resolveEngineTierId(project, packageEngineTierMapping, tiers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`engine tier resolution failed: ${msg}`);
  }

  // 6. Compute photo count target via dynamic helper.
  const flatProducts = flattenProjectProducts(project);
  const photoCount = computeExpectedFileCount(
    flatProducts,
    productsCatalog,
    PHOTO_ENGINE_ROLES,
    PHOTO_FALLBACK_CATEGORIES,
  );

  // 7. Manual-mode triggers (Joseph 2026-04-27, spec Section 4b).
  // Wave 7 P1-19 (W7.13): trigger logic moved to a pure helper so it can be
  // unit-tested in isolation. Same precedence (project type unsupported wins
  // over count-driven fallback).
  const manualReason = resolveManualModeReason({
    shortlistingSupported,
    expectedCountTarget: photoCount.target,
  });

  if (manualReason) {
    return await createManualRound({
      admin,
      projectId,
      triggerSource,
      actorId,
      actorType,
      packageType,
      engineTierId,
      photoCount,
      manualReason,
      warnings,
    });
  }

  // 8. Resolve folder path + list CR3 files (engine mode only).
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

  // Burst 15 X2: refuse to create a round when the folder is empty (see prior
  // commit history; preserved here verbatim — empty folder is still an error,
  // not a manual-mode trigger).
  if (fileCount === 0) {
    throw new Error(
      `Photos shortlist folder is empty for project ${projectId} (folder='${folderPath}'). ` +
      `Drop CR3/CR2/ARW/NEF/RAF/DNG files into the folder before triggering a round.`,
    );
  }

  // 9. Sanity check — drift outside the dynamic min/max range.
  if (fileCount < photoCount.min) {
    warnings.push(
      `File count ${fileCount} below expected lower bound ${photoCount.min} (target ${photoCount.target} ± 3 for package '${packageType ?? 'unknown'}')`,
    );
  } else if (fileCount > photoCount.max + (photoCount.target * 5)) {
    // Photographers routinely shoot 5-10× the deliverable count for editor
    // selection; warn only on truly excessive over-shoots.
    warnings.push(
      `File count ${fileCount} substantially above expected target ${photoCount.target} (over-shoot factor ${(fileCount / Math.max(photoCount.target, 1)).toFixed(1)}× for package '${packageType ?? 'unknown'}')`,
    );
  }

  // 10. Determine next round_number for this project.
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

  // 10b. Wave 8 (W8.4): resolve the active tier_config version for the
  // round's engine tier. Pinned at ingest so historical replay reads the
  // version that was active when Pass 1 wrote the scores. NULL fallback
  // when no active config exists (data corruption / pre-seed migration);
  // Pass 1 emits a warning and uses DEFAULT_DIMENSION_WEIGHTS.
  let tierConfigVersion: number | null = null;
  if (engineTierId) {
    const activeConfig = await getActiveTierConfig(engineTierId);
    tierConfigVersion = activeConfig?.version ?? null;
    if (!activeConfig) {
      warnings.push(
        `ingest tier_config: no active row for engine_tier_id=${engineTierId} — round.tier_config_version=NULL (Pass 1 will fall back to DEFAULT_DIMENSION_WEIGHTS)`,
      );
    }
  }

  // 11. Insert the round.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .insert({
      project_id: projectId,
      round_number: nextRoundNumber,
      status: 'processing',
      package_type: packageType,
      // Legacy column kept populated for back-compat with already-migrated
      // rows; new code paths read expected_count_target instead.
      package_ceiling: photoCount.target,
      engine_tier_id: engineTierId,
      expected_count_target: photoCount.target,
      expected_count_min: photoCount.min,
      expected_count_max: photoCount.max,
      total_compositions: null,
      trigger_source: triggerSource,
      started_at: new Date().toISOString(),
      // Wave 8 (W8.4): provenance pins for reproducible replay.
      engine_version: ENGINE_VERSION,
      tier_config_version: tierConfigVersion,
    })
    .select('id, round_number')
    .single();
  if (roundErr || !round) throw new Error(`round insert failed: ${roundErr?.message || 'no row returned'}`);

  const roundId: string = round.id;

  // 12. Bind project to the new round.
  const { error: linkErr } = await admin
    .from('projects')
    .update({ current_shortlist_round_id: roundId })
    .eq('id', projectId);
  if (linkErr) {
    warnings.push(`projects.current_shortlist_round_id update failed: ${linkErr.message}`);
  }

  // 13. Enqueue extract jobs (chunked).
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
    // deno-lint-ignore no-explicit-any
    const sorted = (insertedJobs as any[]).slice().sort((a, b) => {
      const ai = Number(a?.payload?.chunk_index ?? 0);
      const bi = Number(b?.payload?.chunk_index ?? 0);
      return ai - bi;
    });
    for (const r of sorted) jobIds.push(r.id);
  }

  // 14. Audit event.
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
        engine_tier_id: engineTierId,
        expected_count_target: photoCount.target,
        expected_count_min: photoCount.min,
        expected_count_max: photoCount.max,
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
    engine_tier_id: engineTierId,
    expected_count_target: photoCount.target,
    expected_count_min: photoCount.min,
    expected_count_max: photoCount.max,
    status: 'processing',
    manual_mode_reason: null,
    warnings,
  };
}

// ─── Manual-mode synthetic round ─────────────────────────────────────────────

interface CreateManualRoundOpts {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  triggerSource: string;
  actorId: string | null;
  actorType: 'system' | 'user';
  packageType: string | null;
  engineTierId: string | null;
  photoCount: { target: number; min: number; max: number };
  manualReason: string;
  warnings: string[];
}

async function createManualRound(opts: CreateManualRoundOpts): Promise<IngestResult> {
  const {
    admin,
    projectId,
    triggerSource,
    actorId,
    actorType,
    packageType,
    engineTierId,
    photoCount,
    manualReason,
    warnings,
  } = opts;

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

  // Wave 8 (W8.4): manual rounds also stamp engine_version + tier_config_version
  // so analytics can join across engine + manual round histories. The
  // tier_config doesn't drive any decision in manual mode (no Pass 1/2),
  // but the version pin is still useful for "what was the tier config
  // active at the time of the manual lock?" diagnostics.
  let manualTierConfigVersion: number | null = null;
  if (engineTierId) {
    const activeConfig = await getActiveTierConfig(engineTierId);
    manualTierConfigVersion = activeConfig?.version ?? null;
  }

  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .insert({
      project_id: projectId,
      round_number: nextRoundNumber,
      status: 'manual',
      package_type: packageType,
      package_ceiling: photoCount.target,
      engine_tier_id: engineTierId,
      expected_count_target: photoCount.target,
      expected_count_min: photoCount.min,
      expected_count_max: photoCount.max,
      total_compositions: null,
      trigger_source: triggerSource,
      started_at: new Date().toISOString(),
      manual_mode_reason: manualReason,
      // Wave 8 (W8.4): stamp engine_version even in manual mode.
      engine_version: ENGINE_VERSION,
      tier_config_version: manualTierConfigVersion,
    })
    .select('id, round_number')
    .single();
  if (roundErr || !round) {
    throw new Error(`manual-mode round insert failed: ${roundErr?.message || 'no row returned'}`);
  }

  const roundId: string = round.id;

  const { error: linkErr } = await admin
    .from('projects')
    .update({ current_shortlist_round_id: roundId })
    .eq('id', projectId);
  if (linkErr) {
    warnings.push(`projects.current_shortlist_round_id update failed: ${linkErr.message}`);
  }

  // Audit event — distinct event_type so dashboards can surface manual-mode
  // rounds separately from engine rounds.
  const { error: evtErr } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: projectId,
      round_id: roundId,
      event_type: 'round_started_manual',
      actor_type: actorType,
      actor_id: actorId,
      payload: {
        trigger_source: triggerSource,
        manual_mode_reason: manualReason,
        package_type: packageType,
        engine_tier_id: engineTierId,
        expected_count_target: photoCount.target,
        warnings,
      },
    });
  if (evtErr) {
    warnings.push(`event insert failed: ${evtErr.message}`);
  }

  return {
    round_id: roundId,
    round_number: round.round_number,
    job_ids: [],
    file_count: 0,
    package_type: packageType,
    engine_tier_id: engineTierId,
    expected_count_target: photoCount.target,
    expected_count_min: photoCount.min,
    expected_count_max: photoCount.max,
    status: 'manual',
    manual_mode_reason: manualReason,
    warnings,
  };
}

// ─── DB loaders ──────────────────────────────────────────────────────────────

async function loadProductsCatalog(
  admin: ReturnType<typeof getAdminClient>,
): Promise<ProductCatalogEntry[]> {
  const { data, error } = await admin
    .from('products')
    .select('id, category, engine_role')
    .eq('is_active', true);
  if (error) throw new Error(`products catalog fetch failed: ${error.message}`);
  return Array.isArray(data) ? (data as ProductCatalogEntry[]) : [];
}

async function loadPackageEngineTierMapping(
  admin: ReturnType<typeof getAdminClient>,
): Promise<PackageEngineTierMappingRow[]> {
  const { data, error } = await admin
    .from('package_engine_tier_mapping')
    .select('package_id, tier_choice, engine_tier_id');
  if (error) throw new Error(`package_engine_tier_mapping fetch failed: ${error.message}`);
  return Array.isArray(data) ? (data as PackageEngineTierMappingRow[]) : [];
}

async function loadShortlistingTiers(
  admin: ReturnType<typeof getAdminClient>,
): Promise<ShortlistingTierRow[]> {
  const { data, error } = await admin
    .from('shortlisting_tiers')
    .select('id, tier_code')
    .eq('is_active', true);
  if (error) throw new Error(`shortlisting_tiers fetch failed: ${error.message}`);
  return Array.isArray(data) ? (data as ShortlistingTierRow[]) : [];
}
