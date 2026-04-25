/**
 * drone-ingest
 * ────────────
 * Turns drone JPGs uploaded into a project's `01_RAW_WORKING/drones` Dropbox
 * folder into structured `drone_shots` + `drone_shoots` rows, with downstream
 * SfM / render jobs queued.
 *
 * Trigger surface:
 *   - Webhook path:  `dropbox-webhook` enqueues a `kind='ingest'` job in
 *     `drone_jobs` (debounced 2 min) when raw_drones file events occur. The
 *     dispatcher (Stream I, later) invokes this function with that payload.
 *   - Manual path:   master_admin / admin can POST { project_id } directly to
 *     re-run ingestion (e.g. after a Dropbox cursor reset, or when the
 *     dispatcher hasn't shipped yet).
 *
 * Pipeline per invocation (see IMPLEMENTATION_PLAN_V2 §2 / Phase 2):
 *   1. List `raw_drones` Dropbox files for the project.
 *   2. Filter out files already represented in `drone_shots` (compare by
 *      dropbox_path).
 *   3. For each new file: download bytes, run ExifReader, project to our
 *      schema (extractExifFromBytes). Skip files where extraction fails.
 *   4. Group new + existing shots into shoots by 30-minute gap on captured_at.
 *   5. UPSERT the shoot rows (one per group, scoped by project_id +
 *      flight_started_at). Resolve shoot_id for every shot.
 *   6. Classify each shot's role (pure rule fn) and INSERT drone_shots rows.
 *   7. Recompute each shoot's flight_started_at / flight_ended_at /
 *      image_count / has_nadir_grid from the now-complete shot set.
 *   8. Enqueue downstream jobs:
 *        - has_nadir_grid → kind='sfm' { shoot_id }
 *        - else           → kind='render' { shoot_id, fallback: 'gps_only' }
 *      One job per shoot — no debounce here (these are shoot-keyed).
 *   9. Emit a single drone_events row of kind='shoot_ingested' summarising
 *      shots_added + shoots_created + has_nadir_grid for the project.
 *
 * Auth: service_role (called by the dispatcher) OR master_admin/admin
 *       (manual via UI / curl). Pattern mirrors dropbox-reconcile.
 *
 * Idempotency: re-running for the same project is safe — step 2 dedupes by
 * dropbox_path; step 5 upserts shoots; step 6 INSERTs only the new shots.
 * Step 8 always enqueues a fresh job per shoot (the dispatcher's own dedupe
 * is responsible for not running SfM twice on the same shoot — this function
 * does not enforce that constraint).
 *
 * Body: { project_id: string }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { listFiles } from '../_shared/projectFolders.ts';
import { downloadFile, dropboxApi } from '../_shared/dropbox.ts';
import {
  extractExifFromBytes,
  classifyShotRole,
  groupShotsIntoShoots,
  parseDjiFilename,
  NADIR_GRID_MIN_SHOTS,
  type ExtractedExif,
  type ShotRole,
} from '../_shared/droneIngest.ts';

// Cap a JPG read to the first ~96 KB. EXIF (JPEG APP1 marker) lives at the
// beginning of the file — DJI XMP segments comfortably fit in the first ~32 KB
// and we leave headroom for thumbnails embedded ahead of the SOI of the next
// segment. Pulling the full frame (~10-20 MB per shot) blows the Edge
// Function's 256 MB cap after ~12-25 shots. (#13 audit fix)
const EXIF_PARTIAL_BYTES = 96 * 1024;

/**
 * Fetch only the first EXIF_PARTIAL_BYTES of a Dropbox file by streaming the
 * full /files/download response and stopping after we've collected enough
 * bytes. This avoids /files/get_temporary_link (10/min rate limit) and avoids
 * loading the full ~10-20 MB JPG into memory. (#13 audit, post-live-test refit)
 */
async function fetchExifBytes(path: string): Promise<Uint8Array> {
  const dlRes = await downloadFile(path);
  if (!dlRes.ok || !dlRes.body) {
    throw new Error(`Dropbox download ${dlRes.status}`);
  }
  const reader = dlRes.body.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  try {
    while (collected < EXIF_PARTIAL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      collected += value.byteLength;
    }
  } finally {
    // Cancel the rest of the stream so the underlying socket + buffers free.
    try { await reader.cancel(); } catch { /* noop */ }
  }
  // Stitch the partial chunks. We may have collected slightly more than the
  // target due to chunk-size alignment — truncate to exactly the cap.
  const out = new Uint8Array(Math.min(collected, EXIF_PARTIAL_BYTES));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return out;
}

const GENERATOR = 'drone-ingest';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExistingShot {
  id: string;
  shoot_id: string;
  dropbox_path: string;
  filename: string;
  captured_at: string | null;
  shot_role: ShotRole | null;
}

interface NewShotMaterialised {
  dropbox_path: string;
  filename: string;
  dji_index: number | null;
  exif: ExtractedExif;
  shot_role: ShotRole;
}

interface ShootRow {
  id: string;
  project_id: string;
  flight_started_at: string;
  flight_ended_at: string | null;
}

// ─── Handler ────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = typeof body.project_id === 'string' ? body.project_id : null;
  if (!projectId) return errorResponse('project_id required', 400, req);

  // Resolve a real UUID for actor_id. `getUserFromReq` returns the literal
  // '__service_role__' for service-role calls (a sentinel, not a UUID), and
  // drone_events.actor_id is typed UUID — so we pass null for service-role
  // invocations to avoid Postgres "invalid input syntax for type uuid"
  // silently rejecting the insert.
  const actorId = (user?.id && user.id !== '__service_role__') ? user.id : null;

  try {
    const startedAt = Date.now();
    const result = await ingestProject(projectId, actorId);
    return jsonResponse({
      success: true,
      project_id: projectId,
      ...result,
      elapsed_ms: Date.now() - startedAt,
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for project ${projectId}: ${msg}`);
    return errorResponse(`Ingest failed: ${msg}`, 500, req);
  }
});

// ─── Core pipeline ──────────────────────────────────────────────────────────

interface IngestResult {
  shots_added: number;
  shots_skipped_already_indexed: number;
  shots_skipped_exif_failure: number;
  shoots_created: number;
  shoots_updated: number;
  has_nadir_grid_shoots: number;
  jobs_enqueued: number;
}

async function ingestProject(projectId: string, actorId: string | null): Promise<IngestResult> {
  const admin = getAdminClient();

  // 1. List raw_drones files in Dropbox (one round-trip).
  // Note: listFiles wraps listFolder which silently caps at maxEntries=5000.
  // Audit #19: emit a warning AND a drone_event when truncation happens so
  // the activity log surfaces the cap. listFiles doesn't currently return a
  // `truncated` flag (owned by Z2's projectFolders.ts), so we approximate by
  // logging the count and emitting a warn-event when we observe the cap value.
  let files: Awaited<ReturnType<typeof listFiles>>;
  try {
    files = await listFiles(projectId, 'raw_drones');
  } catch (err) {
    // No raw_drones folder yet (project_folders not provisioned) → nothing to do.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No folder of kind 'raw_drones'")) {
      console.log(`[${GENERATOR}] project ${projectId} has no raw_drones folder; skipping`);
      return emptyResult();
    }
    throw err;
  }
  // Heuristic truncation alert: listFolder defaults to 5000 entries — if we
  // got exactly that count back, we're almost certainly truncated. Emit a
  // warn-event so an operator can spot it in the activity log.
  if (files.length >= 5000) {
    console.warn(
      `[${GENERATOR}] listFiles returned ${files.length} entries for project ${projectId} — possibly truncated at 5000. (#19 audit)`,
    );
    await admin
      .from('drone_events')
      .insert({
        project_id: projectId,
        event_type: 'shoot_ingested',
        actor_type: 'system' as const,
        actor_id: actorId,
        payload: {
          warning: 'raw_drones_listing_possibly_truncated',
          files_seen: files.length,
          maxEntries: 5000,
          note: 'increase maxEntries in listFolder or paginate via cursor',
        },
      });
  }

  // 2. Read existing shots so we can dedupe by dropbox_path. We also load
  //    them so we can re-cluster the COMBINED shot set in step 4 (a new
  //    upload may join an existing shoot).
  const { data: existing, error: existingErr } = await admin
    .from('drone_shots')
    .select('id, shoot_id, dropbox_path, filename, captured_at, shot_role, drone_shoots!inner(project_id)')
    .eq('drone_shoots.project_id', projectId);
  if (existingErr) throw existingErr;

  const existingShots: ExistingShot[] = (existing || []).map((r: any) => ({
    id: r.id,
    shoot_id: r.shoot_id,
    dropbox_path: r.dropbox_path,
    filename: r.filename,
    captured_at: r.captured_at,
    shot_role: r.shot_role,
  }));
  const existingByPath = new Map(existingShots.map((s) => [s.dropbox_path, s]));

  // 3. Process new files: range-fetch EXIF + parse. Failures are logged-and-
  //    skipped, not fatal — one corrupt JPG should not block the whole batch.
  //    Track filesConsidered separately from existingShots so the response's
  //    shots_skipped_already_indexed accurately reports "JPGs we WOULD have
  //    inserted but already had a matching dropbox_path", not just total
  //    pre-existing shot count for the project. (#15 audit fix)
  const newShots: NewShotMaterialised[] = [];
  let exifFailures = 0;
  let filesConsidered = 0;
  let filesAlreadyIndexed = 0;

  // Build the per-file work list first — eligible JPG/DNGs that aren't already
  // indexed.
  const toProcess: Array<{ path: string; name: string }> = [];
  for (const file of files) {
    if (!/\.(jpe?g|dng)$/i.test(file.name)) continue;
    filesConsidered++;
    if (existingByPath.has(file.path)) {
      filesAlreadyIndexed++;
      continue;
    }
    toProcess.push({ path: file.path, name: file.name });
  }

  // Process in small chunks with explicit async yields between batches.
  // npm:exifreader holds internal state across calls and accumulates buffers
  // when run many times in a tight sequential loop — for 30+ files this OOMs
  // the Edge Function's 256 MB cap. Chunked processing keeps peak memory low
  // and lets V8 GC between iterations. (#13 follow-up after live test failure)
  const CHUNK = 4;
  for (let i = 0; i < toProcess.length; i += CHUNK) {
    const slice = toProcess.slice(i, i + CHUNK);
    for (const f of slice) {
      try {
        const buf = await fetchExifBytes(f.path);
        const exif = extractExifFromBytes(buf);
        const dji = parseDjiFilename(f.name);
        const shot_role = classifyShotRole(exif);
        newShots.push({
          dropbox_path: f.path,
          filename: f.name,
          dji_index: dji?.dji_index ?? null,
          exif,
          shot_role,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] failed to ingest ${f.path}: ${msg}`);
        exifFailures++;
      }
    }
    // Yield to the event loop so V8 can run idle GC between chunks. Even a
    // 0ms timeout is enough to break the synchronous-ish run-to-completion
    // pattern that prevents incremental GC.
    if (i + CHUNK < toProcess.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (newShots.length === 0) {
    // Nothing to write. Still emit an event so the activity log records the
    // attempt — but mark it `shots_added=0` so observers can spot no-op runs.
    const { data: evtData, error: evtErr } = await admin
      .from('drone_events')
      .insert({
        project_id: projectId,
        event_type: 'shoot_ingested',
        actor_type: 'system' as const,
        actor_id: actorId,
        payload: {
          shots_added: 0,
          shoots_created: 0,
          shoots_updated: 0,
          has_nadir_grid: false,
          files_seen: files.length,
          files_considered: filesConsidered,
          already_indexed: filesAlreadyIndexed,
          exif_failures: exifFailures,
        },
      })
      .select('id')
      .single();
    if (evtErr) {
      console.error(`[${GENERATOR}] drone_events insert failed (no-op path) for project ${projectId}: ${evtErr.message} (code ${evtErr.code ?? 'n/a'})`);
    } else {
      console.log(`[${GENERATOR}] emitted shoot_ingested event id=${evtData?.id} for project ${projectId} (no-op)`);
    }
    return {
      shots_added: 0,
      shots_skipped_already_indexed: filesAlreadyIndexed,
      shots_skipped_exif_failure: exifFailures,
      shoots_created: 0,
      shoots_updated: 0,
      has_nadir_grid_shoots: 0,
      jobs_enqueued: 0,
    };
  }

  // 4. Group the combined shot set into shoots by 30-min gap.
  const combinedForGrouping = [
    ...existingShots.map((s) => ({
      __kind: 'existing' as const,
      ref: s,
      captured_at: s.captured_at,
    })),
    ...newShots.map((s) => ({
      __kind: 'new' as const,
      ref: s,
      captured_at: s.exif.captured_at,
    })),
  ];
  const groups = groupShotsIntoShoots(combinedForGrouping);

  // 5. Upsert shoots. For each group, find any existing shoot whose
  //    flight_started_at matches the group's first existing shot — that's
  //    the canonical row to update. Otherwise create a new shoot.
  const droneModel = newShots.find((s) => s.exif.drone_model)?.exif.drone_model ?? null;

  const groupShoots: Array<{ group_index: number; shoot: ShootRow; is_new: boolean }> = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const existingInGroup = group.shots.find((s) => s.__kind === 'existing');
    let shoot: ShootRow | null = null;
    let isNew = false;

    if (existingInGroup && existingInGroup.__kind === 'existing') {
      // Resolve shoot_id from the existing shot.
      const { data, error } = await admin
        .from('drone_shoots')
        .select('id, project_id, flight_started_at, flight_ended_at')
        .eq('id', existingInGroup.ref.shoot_id)
        .maybeSingle();
      if (error) throw error;
      shoot = data as ShootRow | null;
    }

    if (!shoot) {
      // Idempotency guard (#12 audit): before inserting a new shoot row, look
      // for one that already matches (project_id, flight_started_at). Two
      // concurrent webhooks can race this code path otherwise — both miss the
      // existing-shot check (because the OTHER webhook hadn't inserted shots
      // yet either) and both proceed to insert duplicate shoots.
      const { data: existingShoot, error: existingErr } = await admin
        .from('drone_shoots')
        .select('id, project_id, flight_started_at, flight_ended_at')
        .eq('project_id', projectId)
        .eq('flight_started_at', group.flight_started_at)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (existingShoot) {
        shoot = existingShoot as ShootRow;
        isNew = false;
      } else {
        // Create. flight_ended_at and image_count get recomputed in step 7.
        const insertRow = {
          project_id: projectId,
          flight_started_at: group.flight_started_at,
          flight_ended_at: group.flight_ended_at,
          drone_model: droneModel,
          status: 'ingested' as const,
          image_count: 0, // recomputed below
          has_nadir_grid: false, // recomputed below
        };
        const { data, error } = await admin
          .from('drone_shoots')
          .insert(insertRow)
          .select('id, project_id, flight_started_at, flight_ended_at')
          .single();
        if (error) {
          // Race: someone else inserted between our SELECT and our INSERT.
          // Re-read once more to get the canonical row.
          const { data: raceRecover } = await admin
            .from('drone_shoots')
            .select('id, project_id, flight_started_at, flight_ended_at')
            .eq('project_id', projectId)
            .eq('flight_started_at', group.flight_started_at)
            .maybeSingle();
          if (raceRecover) {
            shoot = raceRecover as ShootRow;
            isNew = false;
          } else {
            throw error;
          }
        } else {
          shoot = data as ShootRow;
          isNew = true;
        }
      }
    }

    // Audit #14: ensure each group is pushed exactly once. The previous code
    // had two .push() sites — one inside the !shoot branch with is_new=true
    // and one in the else branch — but a future edit could easily double-push
    // if the existingInGroup branch was reached but `shoot` ended up null
    // (e.g. dangling shoot_id). Single-push at the bottom of the loop body
    // makes the invariant explicit.
    if (shoot) {
      groupShoots.push({ group_index: i, shoot, is_new: isNew });
    } else {
      console.warn(
        `[${GENERATOR}] group ${i} for project ${projectId} produced no shoot row; skipping`,
      );
    }
  }

  // 6. Insert drone_shots rows for each new shot, attached to the right shoot.
  //    Use a single bulk insert per shoot to minimise round-trips.
  const insertsByShoot = new Map<string, Array<Record<string, unknown>>>();
  for (let i = 0; i < groups.length; i++) {
    const shoot = groupShoots.find((g) => g.group_index === i)?.shoot;
    if (!shoot) continue;
    for (const member of groups[i].shots) {
      if (member.__kind !== 'new') continue;
      const ns = member.ref as NewShotMaterialised;
      const row: Record<string, unknown> = {
        shoot_id: shoot.id,
        dropbox_path: ns.dropbox_path,
        filename: ns.filename,
        dji_index: ns.dji_index,
        captured_at: ns.exif.captured_at,
        gps_lat: ns.exif.gps_lat,
        gps_lon: ns.exif.gps_lon,
        // relative_altitude is the XMP AGL (DJI RelativeAltitude). We do NOT
        // fall back to gps_altitude because that's MSL not AGL — projecting
        // POIs through MSL altitude on elevated terrain places them hundreds
        // of metres off. Leave NULL when missing; drone-render will skip
        // shots without AGL altitude rather than render incorrectly. (#18 audit)
        relative_altitude: ns.exif.relative_altitude,
        flight_yaw: ns.exif.flight_yaw,
        gimbal_pitch: ns.exif.gimbal_pitch,
        gimbal_roll: ns.exif.gimbal_roll,
        flight_roll: ns.exif.flight_roll,
        gps_status: ns.exif.gps_status,
        shot_role: ns.shot_role,
        registered_in_sfm: false,
        exif_raw: ns.exif.raw,
      };
      const arr = insertsByShoot.get(shoot.id) ?? [];
      arr.push(row);
      insertsByShoot.set(shoot.id, arr);
    }
  }

  let shotsAdded = 0;
  for (const [, rows] of insertsByShoot.entries()) {
    if (rows.length === 0) continue;
    // upsert on (shoot_id, filename) so re-runs that race step 2's dedupe
    // (e.g. two webhooks fired in parallel) don't violate the unique
    // constraint.
    const { error, count } = await admin
      .from('drone_shots')
      .upsert(rows, { onConflict: 'shoot_id,filename', ignoreDuplicates: true, count: 'exact' });
    if (error) throw error;
    shotsAdded += count ?? rows.length;
  }

  // 7. Recompute shoot stats (flight_started_at / ended_at / image_count /
  //    has_nadir_grid) from the now-complete shot set. We already have the
  //    grouped data in memory — easier than another DB round-trip.
  let hasNadirCount = 0;
  for (const { group_index, shoot } of groupShoots) {
    const group = groups[group_index];
    const allShots = group.shots; // both existing + new
    // Count nadir_grid shots in this group. For existing shots we use their
    // stored shot_role; for new shots we use the freshly classified role.
    let nadirGridCount = 0;
    for (const s of allShots) {
      if (s.__kind === 'existing' && s.ref.shot_role === 'nadir_grid') nadirGridCount++;
      if (s.__kind === 'new' && (s.ref as NewShotMaterialised).shot_role === 'nadir_grid') nadirGridCount++;
    }
    const has_nadir_grid = nadirGridCount >= NADIR_GRID_MIN_SHOTS;

    const updates = {
      flight_started_at: group.flight_started_at,
      flight_ended_at: group.flight_ended_at,
      image_count: allShots.length,
      has_nadir_grid,
    };
    const { error } = await admin
      .from('drone_shoots')
      .update(updates)
      .eq('id', shoot.id);
    if (error) throw error;
    if (has_nadir_grid) hasNadirCount++;
  }

  // 8. Enqueue downstream jobs — one per shoot we touched. Only enqueue when
  //    we actually added new shots into a shoot; pure existing-shoot updates
  //    don't need a fresh SfM pass.
  let jobsEnqueued = 0;
  for (const { group_index, shoot } of groupShoots) {
    const newInGroup = groups[group_index].shots.some((s) => s.__kind === 'new');
    if (!newInGroup) continue;

    const allShots = groups[group_index].shots;
    let nadirGridCount = 0;
    for (const s of allShots) {
      if (s.__kind === 'existing' && s.ref.shot_role === 'nadir_grid') nadirGridCount++;
      if (s.__kind === 'new' && (s.ref as NewShotMaterialised).shot_role === 'nadir_grid') nadirGridCount++;
    }
    const hasNadir = nadirGridCount >= NADIR_GRID_MIN_SHOTS;

    const jobRow = hasNadir
      ? {
          project_id: projectId,
          shoot_id: shoot.id,
          kind: 'sfm' as const,
          status: 'pending' as const,
          payload: { shoot_id: shoot.id },
        }
      : {
          project_id: projectId,
          shoot_id: shoot.id,
          kind: 'render' as const,
          status: 'pending' as const,
          payload: { shoot_id: shoot.id, fallback: 'gps_only' },
        };
    const { error } = await admin.from('drone_jobs').insert(jobRow);
    if (error) throw error;
    jobsEnqueued++;
  }

  // 9. Single summary event. Surface insert failures so they're visible in
  //    the function logs rather than silently dropped — earlier deployments
  //    saw an issue where drone_events writes vanished without error, traced
  //    back to the supabase-js client swallowing the response when the
  //    promise wasn't `await`'d under serveWithAudit's try/finally. The
  //    explicit error capture below catches any future regressions.
  const eventRow = {
    project_id: projectId,
    event_type: 'shoot_ingested',
    actor_type: 'system' as const,
    actor_id: actorId,
    payload: {
      shots_added: shotsAdded,
      shoots_created: groupShoots.filter((g) => g.is_new).length,
      shoots_updated: groupShoots.filter((g) => !g.is_new).length,
      has_nadir_grid_shoots: hasNadirCount,
      jobs_enqueued: jobsEnqueued,
      exif_failures: exifFailures,
      already_indexed: filesAlreadyIndexed,
    },
  };
  const { data: evtData, error: evtErr } = await admin
    .from('drone_events')
    .insert(eventRow)
    .select('id')
    .single();
  if (evtErr) {
    console.error(`[${GENERATOR}] drone_events insert failed for project ${projectId}: ${evtErr.message} (code ${evtErr.code ?? 'n/a'})`);
  } else {
    console.log(`[${GENERATOR}] emitted shoot_ingested event id=${evtData?.id} for project ${projectId}`);
  }

  return {
    shots_added: shotsAdded,
    shots_skipped_already_indexed: filesAlreadyIndexed,
    shots_skipped_exif_failure: exifFailures,
    shoots_created: groupShoots.filter((g) => g.is_new).length,
    shoots_updated: groupShoots.filter((g) => !g.is_new).length,
    has_nadir_grid_shoots: hasNadirCount,
    jobs_enqueued: jobsEnqueued,
  };
}

function emptyResult(): IngestResult {
  return {
    shots_added: 0,
    shots_skipped_already_indexed: 0,
    shots_skipped_exif_failure: 0,
    shoots_created: 0,
    shoots_updated: 0,
    has_nadir_grid_shoots: 0,
    jobs_enqueued: 0,
  };
}
