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
import { getDropboxTempLink } from '../_shared/shortlistingFolders.ts';
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
import {
  filterAllocationsByScope,
  resolveSlotRecipe,
  resolveTolerance,
  type RecipeResolveContext,
  type ResolvedSlotRecipe,
  type SlotAllocationRow,
  type SlotDefinitionLite,
} from '../_shared/slotRecipeResolver.ts';

const GENERATOR = 'shortlisting-ingest';
// CHUNK_SIZE = 20: each chunk POSTs to shortlisting-extract → Modal which
// downloads the .CR3 RAW files from Dropbox, decodes them, extracts EXIF +
// AEB metadata, generates a preview JPEG, and persists to the round.
//
// 2026-05-03 — bumped 10 → 20 after the fire-and-forget pattern landed in
// shortlisting-extract (commit 173dced + 4b4fbf5). With fire-and-forget
// the 150s edge IDLE_TIMEOUT no longer applies — extract returns 202
// immediately, the Modal call runs in the background task. Halving total
// chunk count = ~2× wall-clock speedup with no rate-limit risk because
// concurrency is bounded server-side via PER_KIND_CAP.extract=5 in the
// dispatcher (max 5 chunks dispatched per 2-min cron tick).
//
// Earlier iterations (kept for reference):
//   - 50 RAWs (~1.5GB) — timed out the dispatcher's 120s fetch
//   - 20 RAWs sync — hit Supabase Edge IDLE_TIMEOUT 150s
//   - 10 RAWs sync → 10 RAWs fire-and-forget worked but slow
//   - 20 RAWs fire-and-forget (current) — ~600MB/chunk, Modal 40-100s
const CHUNK_SIZE = 20;
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

  // 10c. W11.6.25 — resolve slot recipe + tolerance and pin onto the round.
  // Replay-safe: Stage 4 reads the snapshot, NOT live tables, so mid-round
  // edits to allocations don't change in-flight rounds. Failure to resolve
  // is non-fatal — the round still runs with NULL recipe (Stage 4 falls back
  // to live shortlisting_slot_definitions, legacy behaviour).
  const recipeOutcome = await resolveRecipeForRound({
    admin,
    project,
    engineTierId,
    packageId: extractPrimaryPackageId(project),
    warnings,
  });

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
      engine_grade_id: engineTierId,
      expected_count_target: photoCount.target,
      expected_count_min: photoCount.min,
      expected_count_max: photoCount.max,
      total_compositions: null,
      trigger_source: triggerSource,
      started_at: new Date().toISOString(),
      // Wave 8 (W8.4): provenance pins for reproducible replay.
      engine_version: ENGINE_VERSION,
      tier_config_version: tierConfigVersion,
      // W11.6.25 — slot recipe snapshot + tolerance pins.
      resolved_slot_recipe: recipeOutcome.recipe,
      resolved_tolerance_below: recipeOutcome.tolerance.tolerance_below,
      resolved_tolerance_above: recipeOutcome.tolerance.tolerance_above,
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

  // 12b. Wave 3 — pre-bake Dropbox temporary download links.
  //
  // The shortlisting engine's biggest scaling pain has been Dropbox /files
  // rate limits.  Modal extract used to call files/get_temporary_link
  // (or files_download directly) once per file during its concurrent
  // processing pass — and Dropbox throttles that bucket aggressively
  // when the app's recent burst+retry history looks bad.
  //
  // Wave 3 shifts ALL the link minting here, into a single SERIAL pass
  // before any parallel work begins.  We call /files/get_temporary_link
  // once per file with a 300 ms gap between calls (≈3 calls/sec — well
  // below any observed limit).  The CDN URLs we get back are valid for
  // ~4 h, more than enough for the dispatcher to claim and run all
  // chunks (typical end-to-end <5 min).  The links are persisted into
  // each chunk's payload as `prebaked_links: { [path]: link }` and the
  // Modal worker reads them directly — making ZERO Dropbox API calls
  // during the heavy parallel phase.  This decouples engine throughput
  // from Dropbox's adaptive rate-limiter entirely.
  //
  // Cost: 0.3 s × N files of wall-clock spent in ingest.  At 50 files
  // that's ~15 s; at 500 files ~2.5 min.  Acceptable given ingest runs
  // once per round and Modal's parallel phase still does the heavy
  // CR3 download/exif/preview work in parallel after this completes.
  const linkBakeStart = Date.now();
  const prebakedLinkMap: Record<string, string> = {};
  const linkBakeErrors: Array<{ path: string; error: string }> = [];
  const LINK_GAP_MS = 300;
  console.info(
    `[${GENERATOR}] Wave 3 link-bake START n=${filePaths.length} ` +
      `gap_ms=${LINK_GAP_MS} est_ms=${filePaths.length * LINK_GAP_MS}`,
  );
  for (let i = 0; i < filePaths.length; i++) {
    const fp = filePaths[i];
    try {
      const link = await getDropboxTempLink(fp);
      prebakedLinkMap[fp] = link;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      linkBakeErrors.push({ path: fp, error: msg });
      console.warn(`[${GENERATOR}] link-bake fail path=${fp.slice(-40)} err=${msg.slice(0, 200)}`);
    }
    // Serialise the burst-start; skip the sleep on the last iteration.
    if (i < filePaths.length - 1) {
      await new Promise((r) => setTimeout(r, LINK_GAP_MS));
    }
  }
  const linkBakeElapsedS = ((Date.now() - linkBakeStart) / 1000).toFixed(1);
  const okCount = Object.keys(prebakedLinkMap).length;
  console.info(
    `[${GENERATOR}] Wave 3 link-bake DONE ok=${okCount} err=${linkBakeErrors.length} ` +
      `elapsed_s=${linkBakeElapsedS}`,
  );
  if (linkBakeErrors.length > 0) {
    warnings.push(
      `Wave 3 link-bake: ${linkBakeErrors.length}/${filePaths.length} files failed to mint a temp link` +
        ` (first error: ${linkBakeErrors[0].error.slice(0, 200)}). Modal will fall back to ` +
        `per-file link minting for these — slower and rate-limit-prone.`,
    );
  }
  if (okCount === 0) {
    throw new Error(
      `Wave 3 link-bake produced 0 successful links across ${filePaths.length} files — ` +
        `aborting the round.  First error: ${linkBakeErrors[0]?.error || 'unknown'}.  ` +
        `This usually means the Dropbox app is currently rate-limit throttled.  ` +
        `Wait 10-30 min and re-run.`,
    );
  }

  // 13. Enqueue extract jobs (chunked).
  const jobIds: string[] = [];
  if (filePaths.length > 0) {
    const chunkRows: Array<Record<string, unknown>> = [];
    const chunkTotal = Math.ceil(filePaths.length / CHUNK_SIZE);
    for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + CHUNK_SIZE);
      // Wave 3: attach only the slice of pre-baked links relevant to
      // this chunk.  Keys are full Dropbox paths (matching file_paths
      // entries) so Modal can do a direct lookup without slicing.
      const chunkLinks: Record<string, string> = {};
      for (const p of chunk) {
        if (prebakedLinkMap[p]) chunkLinks[p] = prebakedLinkMap[p];
      }
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
          // Wave 3 — pre-baked CDN URLs, keyed by full Dropbox path.
          // Modal extract reads these and skips its own
          // files/get_temporary_link API call entirely.
          prebaked_links: chunkLinks,
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
        engine_grade_id: engineTierId,
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
      engine_grade_id: engineTierId,
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
        engine_grade_id: engineTierId,
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
  // mig 443 rename: package_engine_tier_mapping.engine_tier_id → engine_grade_id.
  // Table name kept (legacy "tier" terminology in cross-system contracts);
  // alias the column back to engine_tier_id so downstream code (resolveEngineTierId
  // pure helper) stays a single rename point.
  const { data, error } = await admin
    .from('package_engine_tier_mapping')
    .select('package_id, tier_choice, engine_tier_id:engine_grade_id');
  if (error) throw new Error(`package_engine_tier_mapping fetch failed: ${error.message}`);
  return Array.isArray(data) ? (data as PackageEngineTierMappingRow[]) : [];
}

async function loadShortlistingTiers(
  admin: ReturnType<typeof getAdminClient>,
): Promise<ShortlistingTierRow[]> {
  // mig 443 rename: shortlisting_tiers → shortlisting_grades. tier_code column
  // preserved for cross-system contracts (S/P/A codes still drive scoring +
  // voice-anchor selection).
  const { data, error } = await admin
    .from('shortlisting_grades')
    .select('id, tier_code')
    .eq('is_active', true);
  if (error) throw new Error(`shortlisting_grades fetch failed: ${error.message}`);
  return Array.isArray(data) ? (data as ShortlistingTierRow[]) : [];
}

// ─── W11.6.25 — slot recipe resolution at ingest ─────────────────────────────

/**
 * Pull the project's primary packages[?].package_id (first entry with a
 * non-empty package_id). À-la-carte projects have no package — returns null.
 */
function extractPrimaryPackageId(
  project: { packages?: Array<{ package_id?: string | null }> | null } | null,
): string | null {
  if (!project || !Array.isArray(project.packages)) return null;
  for (const p of project.packages) {
    if (p && typeof p.package_id === 'string' && p.package_id.length > 0) {
      return p.package_id;
    }
  }
  return null;
}

/**
 * Flatten products[] entries from the project into a list of product UUIDs
 * for the individual_product scope. Walks both top-level products[] and
 * packages[].products[] entries.
 */
function extractIndividualProductIds(
  project: {
    products?: Array<{ id?: string | null; product_id?: string | null }> | null;
    packages?: Array<{ products?: Array<{ id?: string | null; product_id?: string | null }> | null }> | null;
  } | null,
): string[] {
  const ids = new Set<string>();
  const visit = (arr: Array<{ id?: string | null; product_id?: string | null }> | null | undefined) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      const id = p?.product_id ?? p?.id;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  };
  visit(project?.products);
  if (project?.packages && Array.isArray(project.packages)) {
    for (const pkg of project.packages) visit(pkg?.products);
  }
  return Array.from(ids);
}

interface ResolveRecipeOpts {
  admin: ReturnType<typeof getAdminClient>;
  // deno-lint-ignore no-explicit-any
  project: any;
  engineTierId: string | null;
  packageId: string | null;
  warnings: string[];
}

interface RecipeOutcome {
  recipe: ResolvedSlotRecipe | null;
  tolerance: { tolerance_below: number; tolerance_above: number };
}

/**
 * Resolve the round's slot recipe + tolerance by walking the four scopes,
 * fetching matching allocation rows, and folding via slotRecipeResolver.
 *
 * Non-fatal: any DB error returns NULL recipe (Stage 4 falls back to live
 * tables) plus a warning. Tolerance always returns at least the hard default.
 */
async function resolveRecipeForRound(opts: ResolveRecipeOpts): Promise<RecipeOutcome> {
  const { admin, project, engineTierId, packageId, warnings } = opts;
  const HARD_DEFAULT_TOL = { tolerance_below: 3, tolerance_above: 3 };

  const ctx: RecipeResolveContext = {
    projectTypeId: typeof project?.project_type_id === 'string' ? project.project_type_id : null,
    packageTierId: engineTierId,
    packageId,
    individualProductIds: extractIndividualProductIds(project),
  };

  const scopeRefIds: string[] = [];
  if (ctx.projectTypeId) scopeRefIds.push(ctx.projectTypeId);
  if (ctx.packageTierId) scopeRefIds.push(ctx.packageTierId);
  if (ctx.packageId) scopeRefIds.push(ctx.packageId);
  for (const id of ctx.individualProductIds) scopeRefIds.push(id);

  if (scopeRefIds.length === 0) {
    return { recipe: null, tolerance: HARD_DEFAULT_TOL };
  }

  let allocRows: SlotAllocationRow[] = [];
  try {
    const { data, error } = await admin
      .from('shortlisting_slot_allocations')
      .select(
        'scope_type, scope_ref_id, slot_id, classification, allocated_count, max_count, priority_rank, notes',
      )
      .eq('is_active', true)
      .in('scope_ref_id', scopeRefIds);
    if (error) {
      warnings.push(`shortlisting_slot_allocations fetch failed: ${error.message} — Stage 4 will fall back to live slot definitions`);
    } else if (Array.isArray(data)) {
      // deno-lint-ignore no-explicit-any
      allocRows = (data as any[]).map((r) => ({
        scope_type: r.scope_type,
        scope_ref_id: r.scope_ref_id,
        slot_id: r.slot_id,
        classification: r.classification,
        allocated_count: Number(r.allocated_count) || 0,
        max_count: r.max_count === null ? null : Number(r.max_count),
        priority_rank: Number(r.priority_rank) || 100,
        notes: r.notes ?? null,
      }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`shortlisting_slot_allocations fetch threw: ${msg}`);
  }

  let slotDefs: SlotDefinitionLite[] = [];
  try {
    const { data, error } = await admin
      .from('shortlisting_slot_definitions')
      .select('slot_id, phase, min_images, max_images, version')
      .eq('is_active', true);
    if (error) {
      warnings.push(`shortlisting_slot_definitions fetch failed: ${error.message}`);
    } else if (Array.isArray(data)) {
      const byId = new Map<string, SlotDefinitionLite & { version: number }>();
      // deno-lint-ignore no-explicit-any
      for (const row of data as any[]) {
        const cand = {
          slot_id: row.slot_id,
          phase: Number(row.phase) || 0,
          min_images: row.min_images === null ? null : Number(row.min_images),
          max_images: row.max_images === null ? null : Number(row.max_images),
          version: Number(row.version) || 1,
        };
        const existing = byId.get(cand.slot_id);
        if (!existing || cand.version > existing.version) byId.set(cand.slot_id, cand);
      }
      slotDefs = Array.from(byId.values()).map(({ version: _v, ...rest }) => rest);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`shortlisting_slot_definitions fetch threw: ${msg}`);
  }

  const scopedRows = filterAllocationsByScope(allocRows, ctx);
  const recipe = scopedRows.length > 0 ? resolveSlotRecipe(scopedRows, slotDefs, ctx) : null;

  // Tolerance: package row → engine_settings → 3.
  let packageTolBelow: number | null = null;
  let packageTolAbove: number | null = null;
  if (packageId) {
    try {
      const { data, error } = await admin
        .from('packages')
        .select('expected_count_tolerance_below, expected_count_tolerance_above')
        .eq('id', packageId)
        .maybeSingle();
      if (error) {
        warnings.push(`packages tolerance fetch failed: ${error.message}`);
      } else if (data) {
        packageTolBelow = data.expected_count_tolerance_below === null
          ? null
          : Number(data.expected_count_tolerance_below);
        packageTolAbove = data.expected_count_tolerance_above === null
          ? null
          : Number(data.expected_count_tolerance_above);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`packages tolerance fetch threw: ${msg}`);
    }
  }

  let globalTolBelow: number | null = null;
  let globalTolAbove: number | null = null;
  try {
    const { data, error } = await admin
      .from('engine_settings')
      .select('key, value')
      .in('key', ['expected_count_tolerance_below', 'expected_count_tolerance_above']);
    if (error) {
      warnings.push(`engine_settings tolerance fetch failed: ${error.message}`);
    } else if (Array.isArray(data)) {
      for (const row of data) {
        const v = typeof row.value === 'number'
          ? row.value
          : (typeof row.value === 'string' ? Number(row.value) : null);
        if (row.key === 'expected_count_tolerance_below') globalTolBelow = v;
        if (row.key === 'expected_count_tolerance_above') globalTolAbove = v;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`engine_settings tolerance fetch threw: ${msg}`);
  }

  const tolerance = resolveTolerance({
    packageTolBelow,
    packageTolAbove,
    globalTolBelow,
    globalTolAbove,
  });

  return { recipe, tolerance };
}
