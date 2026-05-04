/**
 * shortlisting-pass0
 * ───────────────────
 * Pass 0 orchestrator for the shortlisting engine.
 *
 * Runs AFTER `shortlisting-extract` has populated the per-file EXIF + preview
 * data into `shortlisting_jobs.result`. Pass 0 is responsible for:
 *
 *   1. Fetching every succeeded extract job's result for the round and
 *      flattening into a single per-file dictionary.
 *   2. Converting raw EXIF into ExifSignals (compute motionBlurRisk / highIsoRisk
 *      / captureTimestampMs).
 *   3. Calling bracketDetector.groupIntoBrackets() — primary group + 5-shot max
 *      enforcement.
 *   4. For each group: pick best-bracket (closest luminance to 118), pick
 *      delivery-reference (lowest AEB value), INSERT composition_groups row.
 *   5. For each composition (concurrent, semaphore-controlled): mint a Dropbox
 *      temp link → call Haiku 4.5 vision with the binary hard-reject prompt.
 *   6. Process classifications:
 *        out_of_scope → INSERT shortlisting_quarantine
 *        other reject → INSERT shortlisting_events { event_type:'composition_hard_rejected' }
 *        no reject     → no-op (group is ready for Pass 1)
 *   7. Update shortlisting_rounds with totals + Pass 0 cost.
 *   8. INSERT shortlisting_events { event_type:'pass0_complete' }.
 *
 * Body modes:
 *   { round_id: string }     — orchestrate the whole round (normal path).
 *   { job_id: string }       — read round_id off a job row first (testing).
 *
 * Auth: service_role OR master_admin / admin / manager.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  callerHasProjectAccess,
} from '../_shared/supabase.ts';
import {
  callClaudeVision,
  type VisionMessage,
} from '../_shared/anthropicVision.ts';
import {
  groupIntoBracketsPartitioned,
  validateBracketCounts,
  type ExifSignals,
  type BracketGroup,
} from '../_shared/bracketDetector.ts';
import { getDropboxTempLink } from '../_shared/shortlistingFolders.ts';
import { getActivePrompt } from '../_shared/promptLoader.ts';
import {
  resolvePackageEngineRoles,
  isContentInScope,
  type EngineRole,
  type ProductRow,
} from '../_shared/slotEligibility.ts';

const GENERATOR = 'shortlisting-pass0';

// Best-bracket target luminance — see spec §0.4.
const TARGET_LUMINANCE = 118;

// Hard-reject prompt — verbatim from spec §4.6 with minor formatting tweaks.
const HARD_REJECT_PROMPT = `Analyse this real estate photography image and determine if it should be immediately rejected before quality scoring.

Return ONLY valid JSON, no other text:
{
  "hard_reject": false,
  "reject_reason": null,
  "confidence": 0.95,
  "observation": "One sentence describing what you see"
}

reject_reason options:
  "motion_blur" | "accidental_trigger" | "severe_underexposure" | "out_of_scope" | "corrupt_frame" | null

REJECT if ANY of these are true:
- Camera shake blur making the entire scene unsharp throughout the frame
- Frame is predominantly black with no recoverable architectural detail (NOT just dark — completely black/near-black with nothing visible)
- Accidental shot: lens cap on, bag interior, body part covering lens
- Content is clearly not a property interior or exterior (agent headshot, test pattern, completely different building)

DO NOT reject for:
- Dark exposure (this is the expected state of an HDR bracket — it WILL be blended with 4 other exposures)
- Window blowout (expected in RAW brackets — recoverable in post)
- Poor composition or lighting quality (scored in Pass 1, not here)
- Unusual angles or partially visible rooms
- Minor clutter, bins, cords, or photoshoppable distractions (flagged in Pass 1, not rejected here)`;

// Concurrency cap for the Pass 0 hard-reject sweep.  Each worker does:
//   1. /files/get_temporary_link  (Dropbox /files API — adaptive throttle)
//   2. Anthropic Haiku vision call  (separate budget, much higher ceiling)
//
// 2026-05-04 — tightened 10 → 5.  Dropbox's published `/files/get_temporary_link`
// ceiling is ~30 req/s app-wide, but the *adaptive* throttle tightens that
// after sustained bursts; we observed a damaged-app state on 2026-05-03 where
// even single calls were 429-ing.  At 10 concurrent × ~300ms each we'd hit
// ~30 req/s sustained — exactly the published ceiling, with zero headroom.
// At 5 concurrent we're at ~15 req/s sustained, well below any throttle and
// safe even on a recently-stressed app.  Anthropic Haiku at Tier-2 happily
// handles 50/min so 5 is well below its ceiling too.
//
// TODO Wave 3.5: extend ingest's prebaked_links pattern to pass0 so the
// `/files/get_temporary_link` call here disappears entirely (links pre-baked
// at round-creation time, fetched from job payload).  Then we can raise
// concurrency back to 10+ since the Dropbox bottleneck is gone.
const DEFAULT_CONCURRENCY = 5;
const HAIKU_MODEL = 'claude-haiku-4-5';
const HAIKU_MAX_TOKENS = 400;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  concurrency?: number;
  _health_check?: boolean;
}

interface ModalFileResult {
  ok: boolean;
  error?: string;
  exif?: {
    fileName?: string;
    cameraModel?: string | null;
    /**
     * Wave 10.1 (W10.1): camera body serial. The Modal worker reads
     * SerialNumber or BodySerialNumber from EXIF and surfaces whichever
     * is present (preferring SerialNumber). Optional for backwards compat
     * with pre-W10.1 Modal responses.
     */
    bodySerial?: string | null;
    shutterSpeed?: string;
    shutterSpeedValue?: number | null;
    aperture?: number | null;
    iso?: number | null;
    focalLength?: number | null;
    aebBracketValue?: number | null;
    dateTimeOriginal?: string | null;
    subSecTimeOriginal?: string | null;
    captureTimestampMs?: number | null;
    orientation?: number | string | null;
  };
  preview_dropbox_path?: string;
  preview_size_kb?: number;
  luminance?: number;
}

interface FileEntry extends ModalFileResult {
  stem: string;
}

interface HardRejectResult {
  hard_reject: boolean;
  reject_reason: string | null;
  confidence: number;
  observation: string;
}

interface ClassificationResult {
  groupId: string;
  groupIndex: number;
  result: HardRejectResult | null;
  error: string | null;
  costUsd: number;
}

// ─── Handler ────────────────────────────────────────────────────────────────

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
    /* empty body */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  let roundId = body.round_id || null;
  if (!roundId && body.job_id) {
    const admin = getAdminClient();
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('round_id')
      .eq('id', body.job_id)
      .maybeSingle();
    if (job?.round_id) roundId = job.round_id;
  }
  if (!roundId) return errorResponse('round_id (or job_id) required', 400, req);

  // Audit defect #42: project-access guard. After role-gating above, also
  // verify the caller actually has access to the round's project. master_admin
  // and admin pass through; manager/employee/contractor must have the project
  // in users.assigned_project_ids. service_role short-circuits to true.
  if (!isService) {
    const adminLookup = getAdminClient();
    const { data: rowForAcl } = await adminLookup
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', roundId)
      .maybeSingle();
    const pid = rowForAcl?.project_id ? String(rowForAcl.project_id) : '';
    if (!pid) {
      return errorResponse('round not found', 404, req);
    }
    const allowed = await callerHasProjectAccess(user, pid);
    if (!allowed) {
      return errorResponse('Forbidden — caller has no access to this project', 403, req);
    }
  }

  const concurrency = Math.max(
    1,
    Math.min(50, Number(body.concurrency) || DEFAULT_CONCURRENCY),
  );

  try {
    const started = Date.now();
    const result = await runPass0(roundId, concurrency);
    return jsonResponse(
      { ok: true, round_id: roundId, elapsed_ms: Date.now() - started, ...result },
      200,
      req,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for round ${roundId}: ${msg}`);
    return errorResponse(`pass0 failed: ${msg}`, 500, req);
  }
});

// ─── Core ────────────────────────────────────────────────────────────────────

interface Pass0RoundResult {
  total: number;
  total_groups: number;
  hard_rejected: number;
  out_of_scope: number;
  ready_for_pass1: number;
  cost_usd: number;
  warnings: string[];
}

async function runPass0(roundId: string, concurrency: number): Promise<Pass0RoundResult> {
  const admin = getAdminClient();

  // 1. Round + project lookup, status guard.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) throw new Error(`round lookup failed: ${roundErr.message}`);
  if (!round) throw new Error(`round ${roundId} not found`);
  // Audit defect #17: Pass 1/2/3 all guard on status='processing'; Pass 0 was
  // missing the same guard. A re-run on a round in 'proposed' or 'locked' state
  // would re-emit pass0_complete events, re-update round counters, and
  // re-INSERT quarantine rows — corrupting state. Mirror Pass 1's pattern.
  if (round.status !== 'processing') {
    throw new Error(
      `round ${roundId} status='${round.status}' — Pass 0 requires status='processing'. ` +
      `Use the dispatcher's resurrect flow if recovery is intended.`,
    );
  }
  const projectId: string = round.project_id;

  // 1b. Audit defects #6 + #7: idempotent re-run cleanup.
  //
  //   Pass 0 may be re-invoked after a mid-loop crash (composition_groups inserted
  //   but classification not finished, or quarantine partially written). Without
  //   pre-cleanup we'd accumulate duplicate composition_groups (no UNIQUE),
  //   duplicate quarantine rows (mig 327 catches the second one with a 409 but
  //   the run still aborts), and stale composition_classifications referencing
  //   deleted groups.
  //
  //   Order matters: child tables first (FK to composition_groups), then groups.
  //   composition_classifications cascade via FK; quarantine doesn't, hence the
  //   explicit DELETE.
  {
    const { error: delClsErr } = await admin
      .from('composition_classifications')
      .delete()
      .eq('round_id', roundId);
    if (delClsErr) {
      console.warn(`[${GENERATOR}] composition_classifications cleanup failed (non-fatal): ${delClsErr.message}`);
    }
    const { error: delQErr } = await admin
      .from('shortlisting_quarantine')
      .delete()
      .eq('round_id', roundId);
    if (delQErr) {
      console.warn(`[${GENERATOR}] shortlisting_quarantine cleanup failed (non-fatal): ${delQErr.message}`);
    }
    const { error: delGrpErr } = await admin
      .from('composition_groups')
      .delete()
      .eq('round_id', roundId);
    if (delGrpErr) {
      throw new Error(`composition_groups cleanup failed (cannot proceed safely): ${delGrpErr.message}`);
    }
  }

  // 2. Pull every succeeded extract job for this round.
  const { data: jobs, error: jobsErr } = await admin
    .from('shortlisting_jobs')
    .select('id, kind, status, result')
    .eq('round_id', roundId)
    .eq('kind', 'extract')
    .eq('status', 'succeeded');
  if (jobsErr) throw new Error(`extract jobs lookup failed: ${jobsErr.message}`);

  if (!jobs || jobs.length === 0) {
    throw new Error(
      `No succeeded extract jobs for round ${roundId} — run shortlisting-extract first`,
    );
  }

  // 3. Flatten per-file map.
  const fileMap = new Map<string, FileEntry>();
  for (const job of jobs) {
    const result = (job.result || {}) as Record<string, unknown>;
    const modalResp = (result.modal_response || {}) as Record<string, unknown>;
    const files = (modalResp.files || {}) as Record<string, ModalFileResult>;
    for (const [stem, entry] of Object.entries(files)) {
      // Last writer wins on duplicate stems (shouldn't happen unless rounds
      // are reprocessed — log to surface).
      if (fileMap.has(stem)) {
        console.warn(`[${GENERATOR}] duplicate stem '${stem}' — overwriting`);
      }
      fileMap.set(stem, { stem, ...entry });
    }
  }

  if (fileMap.size === 0) {
    throw new Error(`No files extracted for round ${roundId} — check Modal logs`);
  }

  // 4. Build ExifSignals — skip files that errored or are missing critical EXIF.
  const exifSignals: ExifSignals[] = [];
  const skipped: { stem: string; reason: string }[] = [];
  for (const fe of fileMap.values()) {
    if (!fe.ok || !fe.exif) {
      skipped.push({ stem: fe.stem, reason: fe.error || 'modal returned ok=false' });
      continue;
    }
    const exif = fe.exif;
    const captureTimestampMs = typeof exif.captureTimestampMs === 'number' ? exif.captureTimestampMs : 0;
    if (!captureTimestampMs) {
      skipped.push({ stem: fe.stem, reason: 'missing captureTimestampMs' });
      continue;
    }
    const shutterSpeedValue = typeof exif.shutterSpeedValue === 'number' ? exif.shutterSpeedValue : 0;
    const aperture = typeof exif.aperture === 'number' ? exif.aperture : 0;
    const iso = typeof exif.iso === 'number' ? exif.iso : 0;
    const focalLength = typeof exif.focalLength === 'number' ? exif.focalLength : 0;

    // motionBlurRisk: shutter < 1/focalLength (handheld rule of thumb). For
    // tripod-shot brackets this is often true but harmless — Pass 0 only uses
    // it as a soft signal in EXIF metadata; the hard-reject vision call is
    // what actually filters motion-blurred frames.
    const motionBlurRisk = focalLength > 0 && shutterSpeedValue > 0
      ? shutterSpeedValue > 1 / focalLength
      : false;
    const highIsoRisk = iso > 3200;

    exifSignals.push({
      fileName: exif.fileName || `${fe.stem}.CR3`,
      cameraModel: exif.cameraModel || 'unknown',
      // Wave 10.1 (W10.1): bodySerial passes through into the partitioner
      // via groupIntoBracketsPartitioned. Null when the Modal response
      // pre-dates W10.1 or the EXIF tag isn't readable; the partitioner
      // canonicalises to "<model>:unknown" in that case.
      bodySerial: typeof exif.bodySerial === 'string' && exif.bodySerial.trim() !== ''
        ? exif.bodySerial
        : null,
      shutterSpeed: exif.shutterSpeed || '',
      shutterSpeedValue,
      aperture,
      iso,
      focalLength,
      aebBracketValue: typeof exif.aebBracketValue === 'number' ? exif.aebBracketValue : null,
      dateTimeOriginal: exif.dateTimeOriginal || '',
      subSecTimeOriginal: exif.subSecTimeOriginal || '',
      captureTimestampMs,
      orientation: exif.orientation != null ? String(exif.orientation) : '1',
      motionBlurRisk,
      highIsoRisk,
    });
  }

  if (exifSignals.length === 0) {
    throw new Error(
      `No usable EXIF signals for round ${roundId} — ${skipped.length} skipped (${skipped.slice(0, 3).map((s) => s.reason).join('; ')})`,
    );
  }

  // 5. Wave 10.1 (W10.1): bracket grouping with multi-camera partitioning.
  // The partitioned variant buckets files by canonical camera_source first,
  // then runs the standard bracket detector on the primary partition only.
  // Secondary-camera files (iPhone BTS, junior photographer's R6) emit as
  // singletons (file_count=1, isSecondaryCamera=true) — NOT bracket-merged
  // on timestamp, which is the bug we're fixing.
  const groups = groupIntoBracketsPartitioned(exifSignals);
  // Validate against the PRIMARY partition only — secondary singletons by
  // design satisfy group_count == file_count, so any "drift" there would
  // always be 0 and dilute the meaningful primary signal.
  const primaryGroups = groups.filter((g) => g.isSecondaryCamera !== true);
  const primaryFileCount = primaryGroups.reduce((acc, g) => acc + g.files.length, 0);
  const validation = validateBracketCounts(primaryGroups, primaryFileCount);
  const warnings = [...validation.warnings];
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} files skipped during EXIF projection`);
  }
  // Surface multi-camera detection so the dispatcher can log it; the swimlane
  // reads camera_source + is_secondary_camera off composition_groups.
  const secondarySources = new Map<string, number>();
  for (const g of groups) {
    if (g.isSecondaryCamera === true && g.cameraSource) {
      secondarySources.set(g.cameraSource, (secondarySources.get(g.cameraSource) ?? 0) + g.files.length);
    }
  }
  if (secondarySources.size > 0) {
    const summary = [...secondarySources.entries()]
      .map(([src, count]) => `${count} files from ${src}`)
      .join('; ');
    warnings.push(`pass0 multi-camera detected (W10.1): ${summary} treated as singletons`);
  }

  // 6. Insert composition_groups rows + collect their ids.
  const groupRows = await insertCompositionGroups(
    admin,
    projectId,
    roundId,
    groups,
    fileMap,
  );

  // 7. Hard-reject vision sweep — concurrent, semaphore-controlled.
  const classifications = await classifyAllGroups(groupRows, concurrency);

  // 7b. W7.8: resolve the project's engine roles (union of products in the
  //     round's package). Lets us downgrade Pass 0's `out_of_scope` reject
  //     to a `out_of_scope_content` WARNING when the detected content
  //     actually matches an engine role on the project. Example: Haiku
  //     flags an agent headshot as out_of_scope, but the project's package
  //     contains an Agent Portraits product (engine_role='agent_portraits')
  //     — that's not a true OOS rejection, just routing the editor needs
  //     to confirm. Per the spec, warn don't auto-reject; editor decides.
  let projectEngineRoles: EngineRole[] = [];
  try {
    projectEngineRoles = await resolvePassZeroProjectEngineRoles(admin, projectId);
  } catch (e) {
    // Resolution failure is non-fatal — fall back to legacy behaviour
    // (treat all out_of_scope as hard quarantine).
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`pass0 engine_role resolution failed (non-fatal): ${msg}`);
  }
  if (projectEngineRoles.length > 0) {
    warnings.push(`pass0 project_engine_roles=[${projectEngineRoles.join(',')}] (W7.8)`);
  }

  // 8. Persist quarantine / events.
  let hardRejectedCount = 0;
  let outOfScopeCount = 0;
  let outOfScopeContentCount = 0;
  let totalCostUsd = 0;
  const visionErrors: string[] = [];

  for (const c of classifications) {
    totalCostUsd += c.costUsd;
    if (c.error) {
      visionErrors.push(`group ${c.groupId}: ${c.error}`);
      // We DO NOT block Pass 1 on vision errors — the orchestrator will
      // re-classify failed groups in a follow-up if needed.
      continue;
    }
    if (!c.result) continue;
    if (!c.result.hard_reject) continue;

    if (c.result.reject_reason === 'out_of_scope') {
      // W7.8: cross-check the OOS reject against the project's engine roles.
      // The Haiku reject reason 'out_of_scope' covers "agent headshot, test
      // pattern, completely different building". When the project's package
      // has products with engine_role='agent_portraits', the agent-headshot
      // detection is EXPECTED content — surface as a warning row
      // (`out_of_scope_content`) so the editor can route to the portraits
      // folder, NOT as a true rejection.
      const observation = String(c.result.observation || '').toLowerCase();
      const headshotLikely =
        observation.includes('headshot') ||
        observation.includes('portrait') ||
        observation.includes('agent') ||
        observation.includes('person');
      const projectHasPortraits = projectEngineRoles.includes('agent_portraits');
      const treatAsContentMismatch = headshotLikely && projectHasPortraits;

      const groupRow = groupRows.find((g) => g.id === c.groupId);
      const reasonValue = treatAsContentMismatch ? 'out_of_scope_content' : 'out_of_scope';
      // isContentInScope is intentionally permissive when projectEngineRoles
      // is empty (warn-only policy); kept here as a sanity assertion that
      // documents intent.
      void isContentInScope('agent_portraits', projectEngineRoles);

      const { error: qErr } = await admin
        .from('shortlisting_quarantine')
        .insert({
          project_id: projectId,
          round_id: roundId,
          group_id: c.groupId,
          file_stem: groupRow?.bestBracketStem || null,
          reason: reasonValue,
          reason_detail: c.result.observation,
          confidence: c.result.confidence,
          requires_human_review: true,
        });
      if (qErr) {
        visionErrors.push(`quarantine insert failed for ${c.groupId}: ${qErr.message}`);
      } else if (treatAsContentMismatch) {
        outOfScopeContentCount++;
      } else {
        outOfScopeCount++;
      }
    } else {
      hardRejectedCount++;
      const { error: evtErr } = await admin
        .from('shortlisting_events')
        .insert({
          project_id: projectId,
          round_id: roundId,
          group_id: c.groupId,
          event_type: 'composition_hard_rejected',
          actor_type: 'system',
          payload: {
            reason: c.result.reject_reason,
            observation: c.result.observation,
            confidence: c.result.confidence,
            model: HAIKU_MODEL,
          },
        });
      if (evtErr) visionErrors.push(`hard-reject event insert failed for ${c.groupId}: ${evtErr.message}`);
    }
  }

  if (visionErrors.length > 0) {
    warnings.push(`${visionErrors.length} vision/persistence error(s) — first: ${visionErrors[0]}`);
  }

  // W7.8: out_of_scope_content rows are also quarantined (just with a
  // warn/route-please semantics rather than a hard reject), so subtract them
  // from the ready-for-Pass-1 total too.
  const readyForPass1 =
    groupRows.length - hardRejectedCount - outOfScopeCount - outOfScopeContentCount;

  // W7.8: shortlisting_rounds.out_of_scope_count rolls UP both reject + warn
  // counts so the dashboard's "OOS" tally still reflects every row in the
  // quarantine bucket. The pass0_complete event payload breaks them out so
  // observability can distinguish.
  const totalOosCount = outOfScopeCount + outOfScopeContentCount;

  // 9. Round update.
  const { error: roundUpdErr } = await admin
    .from('shortlisting_rounds')
    .update({
      total_compositions: groupRows.length,
      hard_rejected_count: hardRejectedCount,
      out_of_scope_count: totalOosCount,
      pass0_cost_usd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    })
    .eq('id', roundId);
  if (roundUpdErr) warnings.push(`round update failed: ${roundUpdErr.message}`);

  // 10. Pass 0 complete event.
  const { error: doneErr } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: projectId,
      round_id: roundId,
      event_type: 'pass0_complete',
      actor_type: 'system',
      payload: {
        total_groups: groupRows.length,
        hard_rejected: hardRejectedCount,
        out_of_scope: outOfScopeCount,
        out_of_scope_content: outOfScopeContentCount,
        project_engine_roles: projectEngineRoles,
        ready_for_pass1: readyForPass1,
        cost_usd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
        validation,
        warnings,
        vision_errors_sample: visionErrors.slice(0, 5),
      },
    });
  if (doneErr) warnings.push(`pass0_complete event insert failed: ${doneErr.message}`);

  return {
    total: exifSignals.length,
    total_groups: groupRows.length,
    hard_rejected: hardRejectedCount,
    out_of_scope: outOfScopeCount,
    ready_for_pass1: readyForPass1,
    cost_usd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    warnings,
  };
}

/**
 * W7.8: resolve a project's engine-role union (distinct, non-null) using
 * `projects.packages` JSONB → product_ids → products.engine_role.
 *
 * Mirrors the same resolver used by Pass 2's fetchSlotDefinitions but without
 * the live-packages-table fallback (Pass 0 only needs the project's committed
 * package set; if it's missing, we treat the round as having no engine roles
 * and leave OOS-content detection passive).
 */
async function resolvePassZeroProjectEngineRoles(
  admin: ReturnType<typeof getAdminClient>,
  projectId: string,
): Promise<EngineRole[]> {
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('packages')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) {
    throw new Error(`project lookup failed: ${projErr.message}`);
  }

  const productIds = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const projectPackages: any[] = Array.isArray((project as any)?.packages)
    // deno-lint-ignore no-explicit-any
    ? ((project as any).packages as any[])
    : [];
  for (const pkg of projectPackages) {
    if (!pkg) continue;
    const embedded = Array.isArray(pkg.products) ? pkg.products : [];
    for (const ent of embedded) {
      if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
    }
  }
  if (productIds.size === 0) return [];

  const { data: prodRows, error: prodErr } = await admin
    .from('products')
    .select('id, engine_role, is_active')
    .in('id', Array.from(productIds));
  if (prodErr) {
    throw new Error(`products lookup failed: ${prodErr.message}`);
  }
  if (!prodRows) return [];

  const productsList: ProductRow[] = (prodRows as ProductRow[]).map((p) => ({
    id: String(p.id),
    engine_role: p.engine_role ?? null,
    is_active: p.is_active === true,
  }));
  return resolvePackageEngineRoles(
    Array.from(productIds).map((id) => ({ product_id: id })),
    productsList,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface InsertedGroupRow {
  id: string;
  groupIndex: number;
  bestBracketStem: string;
  deliveryReferenceStem: string;
  dropboxPreviewPath: string;
}

async function insertCompositionGroups(
  // deno-lint-ignore no-explicit-any
  admin: any,
  projectId: string,
  roundId: string,
  groups: BracketGroup[],
  fileMap: Map<string, FileEntry>,
): Promise<InsertedGroupRow[]> {
  const out: InsertedGroupRow[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const fileStems = group.files.map((f) => stemOf(f.fileName));
    const luminances = fileStems.map((stem) => {
      const fe = fileMap.get(stem);
      return typeof fe?.luminance === 'number' ? fe.luminance : null;
    });

    // Best bracket: closest to TARGET_LUMINANCE among defined luminances.
    let bestBracketStem = fileStems[0];
    let bestBracketLum: number | null = luminances[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let j = 0; j < fileStems.length; j++) {
      const lum = luminances[j];
      if (lum == null) continue;
      const delta = Math.abs(lum - TARGET_LUMINANCE);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestBracketStem = fileStems[j];
        bestBracketLum = lum;
      }
    }

    // Delivery reference: most negative aebBracketValue (Canon convention —
    // typically -2.667). Fallback: first file in group.
    let deliveryRefStem = fileStems[0];
    let lowestAeb = Number.POSITIVE_INFINITY;
    for (let j = 0; j < group.files.length; j++) {
      const aeb = group.files[j].aebBracketValue;
      if (aeb != null && aeb < lowestAeb) {
        lowestAeb = aeb;
        deliveryRefStem = stemOf(group.files[j].fileName);
      }
    }

    const bestEntry = fileMap.get(bestBracketStem);
    const dropboxPreviewPath = bestEntry?.preview_dropbox_path || '';
    // P-runtime-fix: Modal returns a fractional kB value (e.g. 198.8) but the
    // composition_groups.preview_size_kb column is INTEGER — bare insert
    // crashes Postgres with 'invalid input syntax for type integer'. Round.
    const previewSizeKbRaw = bestEntry?.preview_size_kb;
    const previewSizeKb = typeof previewSizeKbRaw === 'number' && isFinite(previewSizeKbRaw)
      ? Math.round(previewSizeKbRaw)
      : null;

    // EXIF metadata snapshot — full ExifSignals for all 5 brackets keyed by
    // stem. Pass 1 consumes this so it doesn't have to round-trip the
    // extract jobs again.
    const exifMetadata: Record<string, unknown> = {};
    for (let j = 0; j < group.files.length; j++) {
      exifMetadata[fileStems[j]] = group.files[j];
    }

    const { data: row, error } = await admin
      .from('composition_groups')
      .insert({
        project_id: projectId,
        round_id: roundId,
        group_index: i,
        files_in_group: fileStems,
        file_count: group.files.length,
        best_bracket_stem: bestBracketStem,
        delivery_reference_stem: deliveryRefStem,
        all_bracket_luminances: luminances,
        selected_bracket_luminance: bestBracketLum,
        is_micro_adjustment_split: group.isMicroAdjustmentSplit,
        dropbox_preview_path: dropboxPreviewPath,
        preview_size_kb: previewSizeKb,
        exif_metadata: exifMetadata,
        // Wave 10.1 (W10.1): camera_source + is_secondary_camera. Set by
        // groupIntoBracketsPartitioned; null/false on rounds that bypass the
        // partitioned path (none today, but defensive in case a caller
        // re-invokes the legacy detector directly).
        camera_source: group.cameraSource ?? null,
        is_secondary_camera: group.isSecondaryCamera === true,
      })
      .select('id')
      .single();

    if (error || !row) {
      throw new Error(
        `composition_groups insert failed for group ${i}: ${error?.message || 'no row returned'}`,
      );
    }

    out.push({
      id: row.id,
      groupIndex: i,
      bestBracketStem,
      deliveryReferenceStem: deliveryRefStem,
      dropboxPreviewPath,
    });
  }
  return out;
}

function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Run Haiku hard-reject classification across all groups concurrently with a
 * semaphore. Per-group failures are recorded in the result row's `error`
 * field but do not abort the sweep.
 */
async function classifyAllGroups(
  rows: InsertedGroupRow[],
  concurrency: number,
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = new Array(rows.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= rows.length) return;
      const row = rows[i];
      results[i] = await classifyOne(row);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Cached resolution: load DB override once per Pass 0 run, reuse across all
// concurrent classifyOne calls. promptText falls back to HARD_REJECT_PROMPT
// when DB returns null.
//
// QC-iter2 W6b (F-B-010): module-level cache with no expiry meant warm
// isolates kept the stale text indefinitely after an admin edited the prompt
// in SettingsShortlistingPrompts. Edge isolates can survive >10min between
// invocations on a busy host. Mirrors the `roomTypesFromDb` 60s TTL pattern.
export const REJECT_PROMPT_CACHE_TTL_MS = 60_000;
let _cachedRejectPrompt: { text: string; version: number; expiresAt: number } | null = null;

export function _resetPass0RejectPromptCache(): void {
  _cachedRejectPrompt = null;
}

/**
 * Pure-ish helper exported for tests: takes an explicit loader (so tests can
 * inject a mock) + a clock + an optional ttl override. Production calls below
 * use the default `getActivePrompt + Date.now()` wiring.
 */
export async function resolveRejectPromptText(
  loader: () => Promise<{ text: string; version: number } | null> = () =>
    getActivePrompt('pass0_reject'),
  now: () => number = () => Date.now(),
  ttlMs: number = REJECT_PROMPT_CACHE_TTL_MS,
): Promise<string> {
  const t = now();
  if (_cachedRejectPrompt && _cachedRejectPrompt.expiresAt > t) {
    return _cachedRejectPrompt.text;
  }
  const dbPrompt = await loader();
  if (dbPrompt) {
    _cachedRejectPrompt = {
      text: dbPrompt.text,
      version: dbPrompt.version,
      expiresAt: t + ttlMs,
    };
    return dbPrompt.text;
  }
  // On miss, also cache the fallback so we don't hammer the DB on every
  // classifyOne call when the table is empty / errored. Same TTL — the next
  // refresh window picks up a freshly-published prompt within 60s.
  _cachedRejectPrompt = {
    text: HARD_REJECT_PROMPT,
    version: 0,
    expiresAt: t + ttlMs,
  };
  return HARD_REJECT_PROMPT;
}

async function getRejectPromptText(): Promise<string> {
  return resolveRejectPromptText();
}

async function classifyOne(row: InsertedGroupRow): Promise<ClassificationResult> {
  const result: ClassificationResult = {
    groupId: row.id,
    groupIndex: row.groupIndex,
    result: null,
    error: null,
    costUsd: 0,
  };

  if (!row.dropboxPreviewPath) {
    result.error = 'no preview path on group';
    return result;
  }

  let imageUrl: string;
  try {
    // Engine app — Pass 0 is part of the shortlisting engine, mints
    // temp_links from the fresh-reputation `flexmedia-engine` app.
    imageUrl = await getDropboxTempLink(row.dropboxPreviewPath, { app: 'engine' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = `temp link failed: ${msg}`;
    return result;
  }

  const promptText = await getRejectPromptText();
  const messages: VisionMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: promptText },
      ],
    },
  ];

  try {
    const visionRes = await callClaudeVision({
      model: HAIKU_MODEL,
      messages,
      max_tokens: HAIKU_MAX_TOKENS,
      temperature: 0,
    });
    result.costUsd = visionRes.costUsd;
    const parsed = parseHardRejectJson(visionRes.content);
    if (!parsed) {
      result.error = `non-JSON or invalid hard-reject response: ${visionRes.content.slice(0, 200)}`;
      return result;
    }
    result.result = parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg;
  }
  return result;
}

/**
 * Lenient JSON parser — strips Markdown fences and surrounding chatter that
 * Haiku occasionally emits despite "ONLY valid JSON" instructions.
 */
function parseHardRejectJson(text: string): HardRejectResult | null {
  if (!text) return null;
  let body = text.trim();
  // Burst 9 O1: pick the JSON-bearing fence when Haiku emits multiple fenced
  // blocks (same fix as Pass 1 L2 / Pass 2 M5).
  const fenceMatches = Array.from(body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  if (fenceMatches.length > 0) {
    const jsonFence = fenceMatches.find((m) => m[1].includes('{'));
    body = (jsonFence ?? fenceMatches[0])[1].trim();
  }
  // Last-ditch: take first {...} block.
  const braceStart = body.indexOf('{');
  const braceEnd = body.lastIndexOf('}');
  if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
  const jsonStr = body.slice(braceStart, braceEnd + 1);

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed == null) return null;
    // Burst 9 O2: lenient hard_reject coercion. Haiku usually emits true/false
    // but occasionally produces "true" / 1 / "yes". A strict v===true silently
    // flipped a real-true to false and let an out-of-scope or accidentally-
    // triggered frame slip into Pass 1.
    let hardReject = false;
    if (parsed.hard_reject === true) hardReject = true;
    else if (typeof parsed.hard_reject === 'string') {
      const s = parsed.hard_reject.trim().toLowerCase();
      hardReject = s === 'true' || s === 'yes' || s === 'y' || s === '1';
    } else if (parsed.hard_reject === 1) hardReject = true;

    // Burst 9 O4: clamp confidence to [0,1]. Haiku occasionally emits 95
    // (treating it as a percent) — we'd otherwise persist confidence=95
    // which breaks downstream stats and the human-review threshold.
    const confRaw = typeof parsed.confidence === 'number'
      ? parsed.confidence
      : Number(parsed.confidence);
    const confidence = Number.isFinite(confRaw)
      ? Math.max(0, Math.min(1, confRaw > 1 ? confRaw / 100 : confRaw))
      : 0;

    return {
      hard_reject: hardReject,
      reject_reason: typeof parsed.reject_reason === 'string' ? parsed.reject_reason : null,
      confidence,
      observation: typeof parsed.observation === 'string' ? parsed.observation : '',
    };
  } catch {
    return null;
  }
}
