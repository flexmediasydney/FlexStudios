/**
 * dropbox-webhook
 * ───────────────
 * Receives Dropbox file change notifications and emits project_folder_events
 * for files inside our managed `/Flex Media Team Folder/Projects/` tree.
 *
 * Dropbox webhook protocol:
 *   GET ?challenge=X  →  return X as text/plain (verification handshake on
 *                        registration; Dropbox re-runs this periodically)
 *   POST /            →  notification body { list_folder: { accounts: [...] } }
 *                        Dropbox just signals "something changed" — we then
 *                        call /files/list_folder/continue with our stored
 *                        cursor to fetch the actual diff.
 *
 * Auth: Dropbox webhooks don't carry JWT. Authenticity is enforced via
 * HMAC-SHA256 signature in the `X-Dropbox-Signature` header (the app secret
 * is the HMAC key). Function is deployed verify_jwt=false.
 *
 * Delta processing logic lives in `_shared/dropboxSync.ts` and is shared
 * with `dropbox-reconcile` (nightly cron back-fill).
 *
 * Performance: returns 200 within ~1s by deferring the actual diff +
 * processing to EdgeRuntime.waitUntil(). Dropbox times out at 10s.
 */

import {
  handleCors,
  errorResponse,
  serveWithAudit,
  getAdminClient,
  invokeFunction,
} from '../_shared/supabase.ts';
import { processDropboxDelta } from '../_shared/dropboxSync.ts';
import { getFolderPath } from '../_shared/projectFolders.ts';

const GENERATOR = 'dropbox-webhook';
const WATCH_PATH = '/Flex Media Team Folder/Projects';
// 2-min debounce so a 50-image bulk upload of a drone shoot collapses into
// a single ingest job rather than 50× back-to-back runs. See migration 228
// (uniq_drone_jobs_pending_ingest_per_project) for the constraint that
// enforces at-most-one pending ingest per project.
const INGEST_DEBOUNCE_SECONDS = 120;
// 7200s (2hr) settling window for photo shoots — Q1 user decision (Wave 6
// Phase 1, mig 288). Photographers do multi-pass uploads of bracketed
// CR3 sets across 1-2 hours; the longer window lets the engine wait until
// the upload session is actually finished before kicking off a round. The
// "Run Shortlist Now" button on the project page passes a short override
// (60s) to fire instantly. Mirrors the drone INGEST_DEBOUNCE_SECONDS pattern
// but with a longer default per the photos workflow.
const SHORTLISTING_DEBOUNCE_SECONDS = 7200;

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // ── Dropbox verification handshake ───────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const challenge = url.searchParams.get('challenge') || '';
    return new Response(challenge, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, req);
  }

  // ── HMAC verification ────────────────────────────────────────────────────
  const bodyText = await req.text();
  const signature = req.headers.get('X-Dropbox-Signature') || '';
  const secret = Deno.env.get('DROPBOX_APP_SECRET') || '';

  if (!secret) {
    console.error(`[${GENERATOR}] DROPBOX_APP_SECRET not set`);
    return errorResponse('Webhook secret not configured', 500, req);
  }

  const expectedSig = await computeHmacSha256Hex(bodyText, secret);
  if (!constantTimeEquals(signature, expectedSig)) {
    console.warn(`[${GENERATOR}] signature mismatch`);
    return errorResponse('Invalid signature', 401, req);
  }

  // ── Defer processing — Dropbox needs a fast response ────────────────────
  // forceEmitOnSeed: true so that if our cursor is null (first webhook ever
  // OR sync_state was reset) and there are pre-existing JPGs in raw_drones,
  // they still produce file_added events. Without this, files uploaded BEFORE
  // a project's webhook starts watching would never trigger ingest.
  // (#55 audit fix — B3 case.)
  //
  // QC8 D-10 fix: previously the post-delta helpers each used a fixed 60s
  // lookback. processDropboxDelta can take >60s on a large initial reconcile
  // (saw ~120s on a fresh project with thousands of pre-existing files), so
  // events emitted near the start of the delta would be older than 60s by the
  // time linkRecentEditorDrops / enqueueIngestForRecentRawDrones queried —
  // and they'd be silently missed. Capture the webhook start timestamp BEFORE
  // we kick off the delta and pass it through, so the helpers see "everything
  // since this webhook started" no matter how long the delta takes.
  const webhookStartIso = new Date().toISOString();
  const work = processDropboxDelta(WATCH_PATH, 'webhook', { forceEmitOnSeed: true })
    .then(async (r) => {
      console.log(`[${GENERATOR}] processed: emitted=${r.emitted} skipped=${r.skipped} errors=${r.errors.length}`);
      // After the delta lands, scan project_folder_events for raw_drones
      // file_added events emitted since this webhook started (was: last 60s)
      // and enqueue debounced ingest jobs per distinct project_id.
      try {
        const queued = await enqueueIngestForRecentRawDrones(webhookStartIso);
        if (queued > 0) {
          console.log(`[${GENERATOR}] enqueued ingest for ${queued} project(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] ingest enqueue failed: ${msg}`);
      }
      // Parallel branch: scan project_folder_events for
      // `photos_raws_shortlist_proposed` file_added events emitted since this
      // webhook started, and enqueue debounced shortlisting ingest jobs per
      // distinct project_id. Photos pipeline mirrors the drones one but uses
      // shortlisting_jobs (mig 284) and the 7200s settling window (mig 288).
      // Wave 6 P5 SHORTLIST.
      try {
        const queuedPhotos = await enqueueShortlistingForRecentPhotos(webhookStartIso);
        if (queuedPhotos > 0) {
          console.log(`[${GENERATOR}] enqueued shortlisting ingest for ${queuedPhotos} project(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] shortlisting enqueue failed: ${msg}`);
      }
      // Editor-folder watcher: link Edited Post Production drops to the
      // matching drone_shots row and (when all raw_accepted shots are
      // covered) enqueue a render job. Same start-timestamp window.
      try {
        const linked = await linkRecentEditorDrops(webhookStartIso);
        if (linked > 0) {
          console.log(`[${GENERATOR}] linked ${linked} editor file(s) to drone_shots`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] editor-link failed: ${msg}`);
      }
      // Photos finals watcher: scan project_folder_events for `file_added`
      // rows in photos_finals / photos_editors_final_enriched emitted since
      // this webhook started, group by project_id, and invoke the
      // shortlisting-finals-watcher edge function with the batch. The watcher
      // parses filename suffixes to update training_examples.variant_count
      // (spec §14). Wave 6 P8 SHORTLIST.
      try {
        const fanned = await fanoutFinalsWatcher(webhookStartIso);
        if (fanned > 0) {
          console.log(`[${GENERATOR}] fanned-out finals-watcher to ${fanned} project(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] finals-watcher fanout failed: ${msg}`);
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] processing failed: ${msg}`);
    });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(work);

  return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
});

/**
 * Find any raw_drones file_added events emitted in the last 60 seconds
 * (covering this webhook run + a small buffer) and enqueue a debounced
 * `kind='ingest'` job per distinct project_id.
 *
 * Why a time-window query rather than threading the project_ids through
 * processDropboxDelta?
 *   - Keeps the delta processor unchanged (it's also called by reconcile,
 *     where the queue semantics are different).
 *   - Naturally idempotent under the unique partial index from migration 228:
 *     repeated calls within the same window upsert the same pending row.
 *
 * The webhook fires multiple times during a 50-file upload. Each call advances
 * the cursor by the new chunk and enqueues. Migration 228's unique partial
 * index collapses all those enqueues into a single pending row whose
 * `scheduled_for` is ratcheted forward by 2 minutes from the latest webhook
 * invocation — i.e. ingest fires once, ~2 minutes after the last file lands.
 */
async function enqueueIngestForRecentRawDrones(sinceIso: string): Promise<number> {
  const admin = getAdminClient();
  // Window: events created at or after the webhook started (was: last 60s).
  // QC8 D-10 — see top of handler for rationale.
  const since = sinceIso;
  // QC2-1 #11: dropped 'raw_drones' from the filter — that folder_kind was
  // cleaned up in mig 247 (DELETE FROM project_folders WHERE folder_kind IN
  // ('raw_drones', 'final_delivery_drones')) so no event will EVER carry
  // it again. Keeping it in the filter just adds noise and risks a future
  // typo confusing readers about what's still live.
  const { data, error } = await admin
    .from('project_folder_events')
    .select('project_id')
    .eq('folder_kind', 'drones_raws_shortlist_proposed')
    // P-runtime-fix Bug D: include file_modified, not just file_added.
    // Pilots/photographers often DRAG files into the Dropbox folder from an
    // existing Dropbox location (camera-imported folder, Downloads, etc).
    // Dropbox treats those moves as file_modified for the same dropbox_id,
    // not file_added. Filtering on file_added alone misses every "move-in"
    // upload. The downstream enqueue RPC has its own debounce so duplicate
    // events for the same project_id collapse to one pending ingest row.
    .in('event_type', ['file_added', 'file_modified'])
    .gte('created_at', since);
  if (error) throw error;

  const projectIds = Array.from(new Set((data || []).map((r) => r.project_id as string).filter(Boolean)));
  for (const pid of projectIds) {
    const { error: rpcErr } = await admin.rpc('enqueue_drone_ingest_job', {
      p_project_id: pid,
      p_debounce_seconds: INGEST_DEBOUNCE_SECONDS,
    });
    if (rpcErr) {
      console.warn(`[${GENERATOR}] enqueue_drone_ingest_job failed for ${pid}: ${rpcErr.message}`);
    }
  }
  return projectIds.length;
}

/**
 * Photos shortlisting branch — parallel to enqueueIngestForRecentRawDrones.
 *
 * After every webhook delta, scan project_folder_events for `file_added`
 * rows in `photos_raws_shortlist_proposed` emitted since the webhook started
 * and enqueue a debounced kind=ingest shortlisting_jobs row per distinct
 * project_id. The unique partial index uniq_shortlisting_jobs_pending_ingest_per_project
 * (mig 284) collapses the burst into a single pending row whose scheduled_for
 * is ratcheted forward by SHORTLISTING_DEBOUNCE_SECONDS (default 7200s = 2h)
 * with each new webhook tick.
 *
 * Wave 6 P5 SHORTLIST. The drones path is unchanged.
 */
async function enqueueShortlistingForRecentPhotos(sinceIso: string): Promise<number> {
  const admin = getAdminClient();
  const since = sinceIso;
  const { data, error } = await admin
    .from('project_folder_events')
    .select('project_id')
    .eq('folder_kind', 'photos_raws_shortlist_proposed')
    // P-runtime-fix Bug D: see drones branch above. Round 1 of 8/2 Everton
    // surfaced 7,413 file_modified events on this folder + ZERO file_added
    // because the photographer dragged 170 CR3s in from a synced Dropbox
    // location rather than fresh-uploading. The narrow file_added filter
    // missed all of them → auto-fire never triggered → user had to manually
    // invoke shortlisting-ingest. Including file_modified self-heals.
    .in('event_type', ['file_added', 'file_modified'])
    .gte('created_at', since);
  if (error) throw error;

  const projectIds = Array.from(new Set((data || []).map((r) => r.project_id as string).filter(Boolean)));
  if (projectIds.length === 0) return 0;

  // Audit defect #35: pre-check that each project actually has a provisioned
  // photos_raws_shortlist_proposed folder before enqueueing. Prevents wasting
  // ingest cycles on projects that haven't been provisioned yet (the ingest
  // job would just no-op + dead-letter, polluting the queue).
  const { data: provisioned } = await admin
    .from('project_folders')
    .select('project_id')
    .eq('folder_kind', 'photos_raws_shortlist_proposed')
    .in('project_id', projectIds);
  const provisionedSet = new Set(
    (provisioned || []).map((r) => r.project_id as string),
  );

  let enqueued = 0;
  for (const pid of projectIds) {
    if (!provisionedSet.has(pid)) {
      console.info(
        `[${GENERATOR}] skipping shortlisting enqueue for ${pid} — no photos_raws_shortlist_proposed folder provisioned yet`,
      );
      continue;
    }
    const { error: rpcErr } = await admin.rpc('enqueue_shortlisting_ingest_job', {
      p_project_id: pid,
      p_debounce_seconds: SHORTLISTING_DEBOUNCE_SECONDS,
    });
    if (rpcErr) {
      console.warn(`[${GENERATOR}] enqueue_shortlisting_ingest_job failed for ${pid}: ${rpcErr.message}`);
    } else {
      enqueued++;
    }
  }
  return enqueued;
}

/**
 * Photos finals watcher fanout — Wave 6 P8 SHORTLIST.
 *
 * After every webhook delta, scan project_folder_events for file_added rows
 * where folder_kind ∈ ('photos_finals','photos_editors_final_enriched')
 * emitted since the webhook started. Group the file paths by project_id and
 * invoke the shortlisting-finals-watcher edge function once per project with
 * the batch.
 *
 * The watcher parses filename suffixes to compute variant_count per stem and
 * updates shortlisting_training_examples.variant_count + weight per spec §14.
 *
 * Returns the number of project_ids fanned-out.
 */
async function fanoutFinalsWatcher(sinceIso: string): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('project_folder_events')
    .select('project_id, file_name, metadata')
    .in('folder_kind', ['photos_finals', 'photos_editors_final_enriched'])
    // P-runtime-fix Bug D: editors typically COPY exported JPGs from their
    // working folder into Finals/, which Dropbox often emits as file_modified
    // for the dropbox_id created earlier. Without including file_modified,
    // the variant_count tracker silently misses real deliveries.
    .in('event_type', ['file_added', 'file_modified'])
    .gte('created_at', sinceIso);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  // Group by project_id → list of full paths (preferring metadata.path; fall
  // back to bare file_name when path is missing).
  const byProject = new Map<string, string[]>();
  for (const ev of data) {
    const pid = ev.project_id as string | null;
    if (!pid) continue;
    const meta = (ev.metadata || {}) as Record<string, unknown>;
    const fullPath =
      (meta.path as string | undefined) || (ev.file_name as string | undefined) || null;
    if (!fullPath) continue;
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid)!.push(fullPath);
  }

  let fanned = 0;
  for (const [pid, paths] of byProject) {
    try {
      await invokeFunction(
        'shortlisting-finals-watcher',
        { project_id: pid, file_paths: paths },
        GENERATOR,
      );
      fanned++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] finals-watcher invoke failed for ${pid}: ${msg}`);
    }
  }
  return fanned;
}

/**
 * Editor-folder watcher.
 *
 * After every webhook delta, scan project_folder_events for `file_added` /
 * `file_modified` rows in `drones_editors_edited_post_production` emitted
 * since this webhook started and:
 *
 *   1. Look up the matching `drone_shots` row in the same project by exact
 *      filename (basename match). v1 only does exact match — _edited / (1)
 *      suffix stripping is out of scope.
 *   2. UPDATE drone_shots.edited_dropbox_path = '<full path>'.
 *   3. Insert `drone_events` row (event_type='editor_file_added').
 *   4a. (LEGACY, kept for backwards compat) After the link, check whether
 *       ALL `lifecycle_state='raw_accepted'` shots in the shoot now have
 *       edited_dropbox_path. If yes, enqueue a `kind='render'` drone_jobs
 *       row (deduped via the partial unique index from migration 240).
 *       Historical pre-Wave-5 trigger — most projects don't depend on it
 *       any more, but kept alive in parallel so any in-flight project that
 *       still relies on the gate doesn't break.
 *   4b. (Wave 5 P2 S6, NEW) Edited-pipeline initiation chain — gated by
 *       env WAVE5_EDITED_PIPELINE_ENABLED. Default: enabled.
 *       Per project touched, enqueue:
 *         • a fresh kind='poi_fetch' job (so drone-pois re-fetches POIs
 *           rather than inheriting the raw snapshot — Joseph's call).
 *           Payload includes pipeline='edited' so drone-pois logs the
 *           call context (drone-pois treats both pipelines identically).
 *         • per-shot kind='render_edited' jobs for each shot whose
 *           edited_dropbox_path was just populated. Dispatcher v19 routes
 *           these to drone-render-edited which renders into Edited Pool.
 *       Both enqueues use ON CONFLICT DO NOTHING for idempotency.
 *
 * Returns count of linked files. Logs warnings (no throw) for files that
 * don't match a known shot — they may be a NEW shot the editor introduced
 * (out of scope for v1).
 */
async function linkRecentEditorDrops(sinceIso: string): Promise<number> {
  const admin = getAdminClient();
  // Window: events created at or after the webhook started (was: last 60s).
  // QC8 D-10 — see top of handler for rationale.
  const since = sinceIso;
  const { data: events, error } = await admin
    .from('project_folder_events')
    .select('project_id, file_name, metadata, event_type, created_at')
    .eq('folder_kind', 'drones_editors_edited_post_production')
    .in('event_type', ['file_added', 'file_modified'])
    .gte('created_at', since);
  if (error) throw error;
  if (!events || events.length === 0) return 0;

  let linkedCount = 0;
  // De-dup: a single file modified twice in the same window should only
  // produce one update + one drone_event. Key on (project_id, basename).
  const seen = new Set<string>();
  // Track which shoots got a link this pass so we only re-evaluate the
  // legacy "all shots ready?" gate once per shoot.
  const touchedShoots = new Set<string>();
  // Wave 5 P2 S6: track the shot_ids whose edited_dropbox_path was just
  // populated, grouped by project (for poi_fetch fan-out and per-shot
  // render_edited enqueues). Keyed on projectId, not shootId, because the
  // poi_fetch is project-scoped while render_edited is per-shot.
  type TouchedShot = { shoot_id: string; shot_id: string };
  const touchedByProject = new Map<string, TouchedShot[]>();

  // Wave 13 H: cache resolved project → expected drones_editors_edited_post_production
  // path-prefix so we don't re-query project_folders for every file in a bulk
  // delivery. A NULL value (cached as empty string) means "no row exists for
  // this project" — we'll skip the link in that case (defensive: should never
  // happen for a properly provisioned project).
  const expectedPrefixByProject = new Map<string, string | null>();
  async function resolveExpectedPrefix(projectId: string): Promise<string | null> {
    if (expectedPrefixByProject.has(projectId)) {
      return expectedPrefixByProject.get(projectId) ?? null;
    }
    let prefix: string | null = null;
    try {
      prefix = await getFolderPath(projectId, 'drones_editors_edited_post_production');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${GENERATOR}] no project_folders row for drones_editors_edited_post_production project=${projectId} — skipping path-prefix gate (${msg})`,
      );
      prefix = null;
    }
    expectedPrefixByProject.set(projectId, prefix);
    return prefix;
  }

  for (const ev of events) {
    const projectId = ev.project_id as string | null;
    const fileName = ev.file_name as string | null;
    const metadata = (ev.metadata || {}) as Record<string, unknown>;
    const fullPath = (metadata.path as string | undefined) || null;
    if (!projectId || !fileName || !fullPath) continue;

    // Skip non-image entries that may have crept in (e.g. .DS_Store).
    if (!/\.(jpe?g|png|tiff?)$/i.test(fileName)) continue;

    const dedupKey = `${projectId}|${fileName.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // ── Wave 13 H: path-prefix validation ──────────────────────────────────
    // The folder_kind on the inbound event is already
    // 'drones_editors_edited_post_production', but folder_kind is assigned by
    // dropboxSync via path matching against project_folders.dropbox_path; if
    // an admin override repointed a folder kind to a path used by another
    // project (or a non-canonical path was injected), the event could be
    // attributed to the wrong project. Verify the event's actual fullPath
    // lives under the project's expected prefix before trusting it. On
    // mismatch we log + skip the link (don't propagate the wrong path into
    // drone_shots.edited_dropbox_path → which would later trigger a
    // mis-attributed render_edited via mig 322's trigger).
    const expectedPrefix = await resolveExpectedPrefix(projectId);
    if (!expectedPrefix) {
      // No project_folders row → skip (already warned in resolver).
      continue;
    }
    if (!fullPath.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
      console.warn(
        `[${GENERATOR}] path-prefix mismatch — refusing editor link: project=${projectId} got=${fullPath} expected_prefix=${expectedPrefix}`,
      );
      continue;
    }

    // ── E29 / FIX 7: cross-tick dedup ──────────────────────────────────────
    // The webhook can fire multiple times in close succession for the same
    // file (Dropbox emits file_modified for every metadata touch — content
    // change, share-link refresh, even some no-op renames). Production
    // observation: ×6 file_modified events for one file in 9hr. Without
    // dedup each one re-inserts the same `editor_file_added` drone_events
    // row and re-fans the same `render_edited` job.
    //
    // Skip if we already wrote an editor_file_added drone_events row for
    // this (project_id, fullPath) in the last 60s. drone_events.payload
    // stores edited_path, so we can match on that.
    const { data: priorEvent } = await admin
      .from('drone_events')
      .select('id')
      .eq('project_id', projectId)
      .eq('event_type', 'editor_file_added')
      .filter('payload->>edited_path', 'eq', fullPath)
      .gte('created_at', new Date(Date.now() - 60_000).toISOString())
      .limit(1)
      .maybeSingle();
    if (priorEvent) {
      console.info(
        `[${GENERATOR}] editor-link deduped: ${fileName} for project ${projectId} — already linked within 60s (event ${priorEvent.id})`,
      );
      continue;
    }

    // Look up the matching raw shot via shoot.project_id JOIN. We need shot_id
    // + shoot_id for the audit row + downstream render-gate check.
    //
    // Wave 14 S4: two-phase match. Fast-path is exact filename equality (covers
    // the common case where the editor preserves the raw filename as the stem
    // of their JPEG export). Fallback is a normalised stem match — strips
    // trailing whitespace, collapses internal whitespace, strips the extension,
    // lowercases — so the editor renaming `DJI_0042.JPG` to `dji_0042.jpeg` or
    // ` DJI_0042 .png ` still routes to the same shot. Without normalisation
    // these variants surface as "no matching raw shot" warnings + the editor
    // delivery never enters the edited pipeline.
    const { data: exactCandidates, error: shotErr } = await admin
      .from('drone_shots')
      .select('id, filename, shoot_id, drone_shoots!inner(project_id)')
      .eq('drone_shoots.project_id', projectId)
      .eq('filename', fileName);
    if (shotErr) {
      console.warn(`[${GENERATOR}] editor-link shot lookup failed for ${fileName}: ${shotErr.message}`);
      continue;
    }
    let candidates = exactCandidates;
    if (!candidates || candidates.length === 0) {
      // Fallback: pull all shots for the project and normalise-compare. The
      // shoot count per project is small (single-digit typical) and shot count
      // per shoot is in the hundreds; this scan is cheap relative to the
      // delivery's value. Logged as INFO so the normalised-match path is
      // visible in production traces.
      const normTarget = normaliseFilename(fileName);
      const { data: allCandidates, error: allErr } = await admin
        .from('drone_shots')
        .select('id, filename, shoot_id, drone_shoots!inner(project_id)')
        .eq('drone_shoots.project_id', projectId);
      if (allErr) {
        console.warn(`[${GENERATOR}] editor-link normalised lookup failed for ${fileName}: ${allErr.message}`);
        continue;
      }
      const matches = (allCandidates || []).filter((row) => {
        const rowName = row.filename as string | null | undefined;
        return Boolean(rowName) && normaliseFilename(rowName!) === normTarget;
      });
      if (matches.length === 0) {
        console.warn(`[${GENERATOR}] editor file '${fileName}' (project ${projectId}) has no matching raw shot — likely a new shot introduced by editor (out of scope for v1).`);
        continue;
      }
      console.info(`[${GENERATOR}] editor file '${fileName}' matched via normalised stem (project ${projectId}, ${matches.length} candidate(s))`);
      candidates = matches;
    }
    if (candidates.length > 1) {
      console.warn(`[${GENERATOR}] editor file '${fileName}' (project ${projectId}) matched ${candidates.length} shots — using first.`);
    }
    const shot = candidates[0] as { id: string; shoot_id: string };

    // Update the raw shot's edited_dropbox_path AND atomically promote the
    // lifecycle_state to 'editor_returned' (Wave 13 D, mig 324). Doing both in
    // a single UPDATE eliminates the race where mig 322's belt-and-braces
    // trigger fires on a row whose state hasn't yet been promoted, and the
    // operator sees a confusingly half-promoted shot in the swimlane.
    //
    // The .eq('lifecycle_state', 'raw_accepted') predicate is intentional:
    // we ONLY promote from raw_accepted. Don't overwrite raw_proposed (would
    // skip operator triage), sfm_only (alignment frames), final, or rejected.
    // A shot already at editor_returned will be a 0-row update — handled
    // gracefully below (we still want to refresh the path if it changed,
    // which is a separate idempotent fallback UPDATE).
    const { data: promoted, error: updErr } = await admin
      .from('drone_shots')
      .update({
        edited_dropbox_path: fullPath,
        lifecycle_state: 'editor_returned',
      })
      .eq('id', shot.id)
      .eq('lifecycle_state', 'raw_accepted')
      .select('id');
    if (updErr) {
      console.warn(`[${GENERATOR}] edited_dropbox_path + lifecycle promote failed for shot ${shot.id}: ${updErr.message}`);
      continue;
    }
    // 0 rows ⇒ shot was already past raw_accepted (likely already at
    // editor_returned). Fall back to a path-only update (no lifecycle change)
    // so a re-delivery with a different filename / location still updates the
    // canonical path, and the cross-tick dedup above already prevented us from
    // re-emitting the audit event.
    if (!promoted || promoted.length === 0) {
      const { error: fallbackErr } = await admin
        .from('drone_shots')
        .update({ edited_dropbox_path: fullPath })
        .eq('id', shot.id);
      if (fallbackErr) {
        console.warn(`[${GENERATOR}] edited_dropbox_path fallback update failed for shot ${shot.id}: ${fallbackErr.message}`);
        continue;
      }
    }

    await admin.from('drone_events').insert({
      project_id: projectId,
      shoot_id: shot.shoot_id,
      shot_id: shot.id,
      event_type: 'editor_file_added',
      actor_type: 'system',
      actor_id: null,
      payload: {
        shot_id: shot.id,
        raw_filename: fileName,
        edited_path: fullPath,
      },
    });

    linkedCount++;
    touchedShoots.add(shot.shoot_id);

    // Wave 5 P2 S6: track per-project shot list for the new edited-pipeline
    // init chain (poi_fetch + per-shot render_edited).
    const arr = touchedByProject.get(projectId) || [];
    arr.push({ shoot_id: shot.shoot_id, shot_id: shot.id });
    touchedByProject.set(projectId, arr);
  }

  // ── (LEGACY, kept for backwards compat) Per-shoot render-readiness gate ─
  // For each shoot we touched, count raw_accepted shots that still have NO
  // edited_dropbox_path. If zero → all editor work is in → enqueue render.
  // Use the partial unique index from migration 240 to dedupe.
  //
  // Wave 5 P2 S6: most projects don't depend on this trigger any more
  // (editor delivery is a one-way push under the new pipeline), but we keep
  // the path alive in parallel for any in-flight project that still relies
  // on it. The new edited-pipeline init chain runs ALONGSIDE this block.
  for (const shootId of touchedShoots) {
    try {
      const { count: missing, error: cntErr } = await admin
        .from('drone_shots')
        .select('id', { count: 'exact', head: true })
        .eq('shoot_id', shootId)
        .eq('lifecycle_state', 'raw_accepted')
        .is('edited_dropbox_path', null);
      if (cntErr) {
        console.warn(`[${GENERATOR}] render-gate count failed for shoot ${shootId}: ${cntErr.message}`);
        continue;
      }
      if ((missing || 0) > 0) continue;

      // Need project_id for the drone_jobs row.
      const { data: shootRow } = await admin
        .from('drone_shoots')
        .select('id, project_id')
        .eq('id', shootId)
        .maybeSingle();
      if (!shootRow?.project_id) continue;

      // Insert a render job. The partial unique index
      // idx_drone_jobs_unique_pending_render (migration 240) covers
      // (shoot_id) WHERE status IN (pending,running) AND kind='render'; a
      // duplicate insert raises 23505 which we treat as a successful debounce
      // (same pattern as drone-pins-save).
      const { error: jobErr } = await admin
        .from('drone_jobs')
        .insert({
          project_id: shootRow.project_id,
          shoot_id: shootId,
          kind: 'render',
          status: 'pending',
          payload: {
            shoot_id: shootId,
            kind: 'poi_plus_boundary',
            reason: 'edited_files_complete',
          },
        });
      if (jobErr) {
        const code = (jobErr as { code?: string }).code;
        if (code === '23505') {
          console.info(`[${GENERATOR}] render job debounced for shoot ${shootId} (existing pending/running)`);
        } else {
          console.warn(`[${GENERATOR}] render enqueue failed for shoot ${shootId}: ${jobErr.message}`);
        }
        continue;
      }
      console.log(`[${GENERATOR}] all editor files complete for shoot ${shootId} — render enqueued`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] render-gate failed for shoot ${shootId}: ${msg}`);
    }
  }

  // ── (Wave 5 P2 S6, NEW) Edited-pipeline initiation chain ────────────────
  // For each project that just received an editor delivery, fan out:
  //   • one fresh kind='poi_fetch' job (deduped — skip if a pending/running
  //     poi_fetch already exists for the project)
  //   • one kind='render_edited' job per touched shot (idempotent insert via
  //     try/catch on 23505; mig 282/287 doesn't add a partial unique on
  //     render_edited yet so we treat any duplicate as success)
  //
  // Gated by the WAVE5_EDITED_PIPELINE_ENABLED env var. Default is enabled
  // (production rollout). Set the var to a falsy string in the Supabase
  // dashboard for emergency disable; legacy block above continues to run.
  //
  // To disable: set WAVE5_EDITED_PIPELINE_ENABLED to 'false', '0', or '' in
  // the Edge Function's secrets. Any other value (including unset) is
  // treated as enabled.
  if (touchedByProject.size > 0 && isEditedPipelineEnabled()) {
    for (const [projectId, shotsArr] of touchedByProject) {
      try {
        await enqueueEditedPipelineInit(admin, projectId, shotsArr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] edited-pipeline init failed for project ${projectId}: ${msg}`);
      }
    }
  } else if (touchedByProject.size > 0) {
    console.info(`[${GENERATOR}] edited-pipeline init skipped (WAVE5_EDITED_PIPELINE_ENABLED disabled) — ${touchedByProject.size} project(s) had editor deliveries`);
  }

  return linkedCount;
}

/**
 * Wave 5 P2 S6 feature flag.
 *
 * Reads WAVE5_EDITED_PIPELINE_ENABLED from the Edge Function environment.
 * Default behaviour: ENABLED (returns true when the var is unset). Disable
 * by setting the var to 'false', '0', '' or 'no'. Any other value is
 * treated as enabled.
 *
 * The flag exists so an operator can flip the new init chain off in an
 * emergency (e.g. dispatcher routing bug) without redeploying the webhook.
 */
function isEditedPipelineEnabled(): boolean {
  const raw = Deno.env.get('WAVE5_EDITED_PIPELINE_ENABLED');
  // Unset → enabled (production-default rollout per architect).
  if (raw === undefined) return true;
  const norm = raw.trim().toLowerCase();
  // Explicit disable strings.
  if (norm === 'false' || norm === '0' || norm === '' || norm === 'no' || norm === 'off') {
    return false;
  }
  return true;
}

/**
 * Wave 5 P2 S6 — edited-pipeline initiation per project.
 *
 * Enqueues one poi_fetch (deduped) + one render_edited per touched shot
 * (idempotent on 23505). Both inserts are wrapped in try/catch so a single
 * conflict does not abort the per-project loop.
 */
// deno-lint-ignore no-explicit-any
async function enqueueEditedPipelineInit(
  admin: any,
  projectId: string,
  touchedShots: { shoot_id: string; shot_id: string }[],
): Promise<void> {
  // 1) poi_fetch (project-scoped, deduped). Check for an existing
  // pending/running row first; insert only if none. The partial unique index
  // for poi_fetch (if any) would also catch this, but the explicit pre-check
  // gives us a clean "skipped" log line for observability.
  const { data: existing, error: cntErr } = await admin
    .from('drone_jobs')
    .select('id')
    .eq('project_id', projectId)
    .eq('kind', 'poi_fetch')
    .in('status', ['pending', 'running'])
    .limit(1);
  if (cntErr) {
    console.warn(`[${GENERATOR}] poi_fetch dedup-check failed for project ${projectId}: ${cntErr.message}`);
  } else if (!existing || existing.length === 0) {
    const { error: poiErr } = await admin.from('drone_jobs').insert({
      project_id: projectId,
      kind: 'poi_fetch',
      status: 'pending',
      payload: {
        project_id: projectId,
        pipeline: 'edited',
        reason: 'editor_delivery',
      },
    });
    if (poiErr) {
      const code = (poiErr as { code?: string }).code;
      if (code === '23505') {
        console.info(`[${GENERATOR}] poi_fetch debounced for project ${projectId} (existing pending/running)`);
      } else {
        console.warn(`[${GENERATOR}] poi_fetch enqueue failed for project ${projectId}: ${poiErr.message}`);
      }
    } else {
      console.log(`[${GENERATOR}] poi_fetch enqueued for project ${projectId} (editor delivery)`);
    }
  } else {
    console.info(`[${GENERATOR}] poi_fetch already pending for project ${projectId} — skip`);
  }

  // 2) render_edited per touched shot. mig 282/287 doesn't add a partial
  // unique on render_edited so we rely on try/catch on 23505. Each shot is
  // independent — a single conflict is treated as a successful debounce.
  for (const { shoot_id, shot_id } of touchedShots) {
    const { error: rendErr } = await admin.from('drone_jobs').insert({
      project_id: projectId,
      shoot_id,
      shot_id, // Wave 11 S2 Cluster D — surface per-shot identity at top level for joins/audit
      kind: 'render_edited',
      status: 'pending',
      pipeline: 'edited',
      payload: {
        shoot_id,
        shot_id,
        reason: 'editor_delivery',
        column_state: 'pool',
        pipeline: 'edited',
      },
    });
    if (rendErr) {
      const code = (rendErr as { code?: string }).code;
      if (code === '23505') {
        console.info(`[${GENERATOR}] render_edited debounced for shot ${shot_id} (conflict)`);
      } else {
        console.warn(`[${GENERATOR}] render_edited enqueue failed for shot ${shot_id}: ${rendErr.message}`);
      }
    } else {
      console.log(`[${GENERATOR}] render_edited enqueued for shot ${shot_id} (project ${projectId})`);
    }
  }
}

// ─── Filename normalisation ──────────────────────────────────────────────────

/**
 * Normalise a filename for stem-equality matching.
 *
 * Wave 14 S4: editors deliver JPGs whose filenames may differ from the raw
 * shot's `filename` by extension (`.JPG` → `.jpeg`), case (`DJI_0042` →
 * `dji_0042`), or whitespace artefacts (a stray trailing space from a sloppy
 * file rename). Strip those variants so the editor-link lookup matches the
 * underlying shot regardless of the editor's export pipeline.
 *
 * Order:
 *   1. trim leading/trailing whitespace
 *   2. collapse internal whitespace runs to a single space
 *   3. strip the trailing extension (`.ext`, `.tiff` etc.)
 *   4. lowercase the result
 *
 * Used as a FALLBACK only — the exact-match fast path runs first and short-
 * circuits the common case.
 */
function normaliseFilename(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
}

// ─── HMAC helpers ────────────────────────────────────────────────────────────

async function computeHmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison.
 *
 * (#53 audit fix) The previous version returned false early on length
 * mismatch, which leaks the length of `b` (the secret-derived expected
 * signature) via timing. For Dropbox HMAC-SHA256 signatures both inputs are
 * always 64 hex chars so the leak is theoretical, but the attack surface is
 * trivial to close: pad both inputs to the longer length with a sentinel char
 * (NUL) and iterate the full length, XORing every byte. The mismatch in
 * length is then implicitly captured by the XOR (the sentinel won't match
 * the real char) without short-circuiting.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    result |= ca ^ cb;
  }
  return result === 0;
}
