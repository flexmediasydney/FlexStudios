/**
 * shortlisting-calibration-runner
 * ───────────────────────────────
 * Wave 14 — structured calibration suite for the Shape D engine.
 *
 * Spec: docs/design-specs/W14-structured-calibration.md
 *
 * What it does:
 *   1. Resolves a sample of historical projects (operator-supplied OR
 *      stratified random with deterministic seed).
 *   2. Snapshots the current pre-run state per project (scores, slots,
 *      overrides, master_listing).
 *   3. Resets each round to status='processing' and enqueues a fresh
 *      `shape_d_stage1` job into shortlisting_jobs. The dispatcher picks them
 *      up on its 1-min cron tick — we DO NOT direct-invoke; serialization is
 *      the dispatcher's job, and going through it gives us the same retry +
 *      cost-cap + mutex protections production rounds get.
 *   4. Polls shortlisting_jobs every 30s for up to 60min until all rounds
 *      reach a terminal state (succeeded/failed/dead_letter on Stage 4).
 *   5. Diffs post-run vs pre-run; computes per-project + aggregate metrics
 *      via _shared/calibrationMath.ts.
 *   6. Persists rows in engine_calibration_runs / engine_calibration_run_summaries.
 *   7. Emits `calibration_complete` on shortlisting_events with the run_id +
 *      pass/fail.
 *
 * Wall-clock model:
 *   - Sync phase (~5s): auth, sample resolution, pre-snapshot, reset+enqueue,
 *     summary INSERT. Returns { run_id, mode: 'background' } immediately.
 *   - Background phase (up to 60min): EdgeRuntime.waitUntil polls jobs,
 *     captures post-snapshot, computes metrics, UPDATEs the summary row to
 *     status='completed'/'failed'/'timeout'.
 *   - Dashboard polls engine_calibration_run_summaries to render progress.
 *
 * Auth:
 *   - master_admin only. Calibration is an internal QA surface; admin role
 *     can read but not trigger.
 *
 * Reentrancy guard:
 *   - Refuses if a `calibration_started` event was emitted in the last 30 min
 *     without a paired `calibration_complete`. Mirrors the
 *     shortlisting-benchmark-runner pattern.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import {
  computeScoreConsistency,
  computeSlotAgreement,
  detectRegressions,
  evaluateAcceptance,
  masterListingInBand,
  medianOrNull,
  stratifiedSample,
  voiceAnchorStability,
  type CandidateProject,
  type ClutterSeverity,
  type ImageScores,
  type PairedClutter,
  type PairedImageScore,
  type PropertyTier,
  type SampleStrategy,
  type SlotDecision,
  DEFAULT_STRATA,
} from '../_shared/calibrationMath.ts';

const GENERATOR = 'shortlisting-calibration-runner';
const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 60 * 60 * 1000; // 60 min
const MAX_PROJECTS = 50;

type AdminClient = ReturnType<typeof getAdminClient>;

interface RequestBody {
  project_ids?: string[];
  auto_sample?: boolean;
  n?: number;
  seed?: number;
  /** Optional human-readable label, e.g. "smoke-2026-05-01". */
  run_label?: string;
  _health_check?: boolean;
}

interface ProjectSnapshot {
  project_id: string;
  round_id: string;
  property_tier: PropertyTier;
  property_address: string | null;
  scores: Record<string, ImageScores>;          // stem → scores
  clutter: Record<string, ClutterSeverity | null>; // stem → clutter
  slots: SlotDecision[];                         // ai_proposed_slot_id → winning stem
  override_count: number;
  total_compositions: number;
  master_listing: {
    word_count: number | null;
    reading_grade_level: number | null;
    tone_anchor: string | null;
  } | null;
  cost_usd: number;
}

// ─── HTTP entry ─────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body */
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'w14-v1.0', _fn: GENERATOR }, 200, req);
  }

  // ── Auth: master_admin only ───────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse(
        'Forbidden — only master_admin can trigger calibration runs',
        403,
        req,
      );
    }
  }

  const admin = getAdminClient();

  // ── Reentrancy guard ──────────────────────────────────────────────────
  // Use engine_calibration_run_summaries.status='running' as the source of
  // truth — simpler + non-NULL-constrained than shortlisting_events (which
  // requires project_id and would force per-project guard rows).
  {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: running } = await admin
      .from('engine_calibration_run_summaries')
      .select('run_id, started_at')
      .eq('status', 'running')
      .gte('started_at', cutoff)
      .limit(1);
    if (running && running.length > 0) {
      return jsonResponse(
        {
          ok: false,
          error_code: 'CALIBRATION_ALREADY_RUNNING',
          error: `A calibration run started in the last 30 minutes is still in progress (run_id=${running[0].run_id}). Wait for it to complete or check the dashboard.`,
        },
        409,
        req,
      );
    }
  }

  // ── Resolve sample ────────────────────────────────────────────────────
  let projectIds: string[];
  let sampleMode: 'manual' | 'auto_sample';
  let seed: number | null;

  if (Array.isArray(body.project_ids) && body.project_ids.length > 0) {
    projectIds = body.project_ids.slice(0, MAX_PROJECTS);
    sampleMode = 'manual';
    seed = null;
  } else if (body.auto_sample) {
    const n = Math.min(Math.max(Number(body.n) || 50, 1), MAX_PROJECTS);
    seed = Number.isInteger(body.seed) ? Number(body.seed) : Math.floor(Math.random() * 2_000_000_000);
    sampleMode = 'auto_sample';
    projectIds = await resolveStratifiedSample(admin, seed, n);
  } else {
    return errorResponse(
      'Provide either project_ids[] OR auto_sample=true (with optional n, seed).',
      400,
      req,
    );
  }

  if (projectIds.length === 0) {
    return jsonResponse(
      {
        ok: false,
        error_code: 'NO_ELIGIBLE_PROJECTS',
        error: 'No projects matched the sampling criteria (need a Shape D round with status proposed/locked/delivered).',
      },
      404,
      req,
    );
  }

  // ── Mint run_id + summary row ─────────────────────────────────────────
  const runId =
    body.run_label ||
    `calib-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const triggeredBy = isService ? null : user?.id ?? null;

  const { error: summaryErr } = await admin
    .from('engine_calibration_run_summaries')
    .insert({
      run_id: runId,
      status: 'running',
      seed,
      sample_mode: sampleMode,
      n_projects_requested: projectIds.length,
      n_projects_dispatched: 0,
      triggered_by: triggeredBy,
      summary_jsonb: { project_ids: projectIds },
    });
  if (summaryErr) {
    if (summaryErr.message.includes('duplicate key')) {
      return errorResponse(
        `run_id "${runId}" already exists. Provide a unique run_label or wait one minute before retrying.`,
        409,
        req,
      );
    }
    return errorResponse(`Failed to create summary row: ${summaryErr.message}`, 500, req);
  }

  // (No started-event emit — the reentrancy guard reads
  // engine_calibration_run_summaries.status='running' instead.)

  // ── Pre-run snapshot + reset rounds + enqueue jobs ────────────────────
  const dispatched: Array<{
    project_id: string;
    round_id: string;
    job_id: string | null;
    error?: string;
  }> = [];
  const preSnapshots: Record<string, ProjectSnapshot> = {};

  for (const projectId of projectIds) {
    try {
      const snap = await captureProjectSnapshot(admin, projectId);
      if (!snap) {
        dispatched.push({ project_id: projectId, round_id: '', job_id: null, error: 'No Shape D round found' });
        continue;
      }
      preSnapshots[projectId] = snap;

      // Insert per-project run row
      await admin.from('engine_calibration_runs').insert({
        run_id: runId,
        project_id: projectId,
        round_id: snap.round_id,
        status: 'pending',
        pre_run_snapshot: snap,
      });

      // Reset round status — keeps DB invariants happy and signals downstream
      // consumers that work is in flight.
      await admin
        .from('shortlisting_rounds')
        .update({ status: 'processing' })
        .eq('id', snap.round_id);

      // Enqueue a fresh shape_d_stage1 job. The dispatcher's idempotency guard
      // (uniq_shortlisting_jobs_active_pass_per_round) will reject if another
      // job is already in-flight for this round + kind — which is the desired
      // outcome. We tolerate the duplicate-key error and treat it as "round
      // already being re-run".
      const { data: jobRow, error: jobErr } = await admin
        .from('shortlisting_jobs')
        .insert({
          project_id: projectId,
          round_id: snap.round_id,
          group_id: null,
          kind: 'shape_d_stage1',
          status: 'pending',
          payload: {
            round_id: snap.round_id,
            project_id: projectId,
            calibration_run_id: runId,
            chained_from: 'calibration-runner',
          },
          scheduled_for: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (jobErr) {
        const isDupActive = /uniq_shortlisting_jobs_active_pass_per_round/.test(jobErr.message)
          || /duplicate key/i.test(jobErr.message);
        dispatched.push({
          project_id: projectId,
          round_id: snap.round_id,
          job_id: null,
          error: isDupActive ? 'Active job already exists for this round' : jobErr.message,
        });
        continue;
      }
      dispatched.push({
        project_id: projectId,
        round_id: snap.round_id,
        job_id: jobRow?.id ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] dispatch failed for ${projectId}: ${msg}`);
      dispatched.push({ project_id: projectId, round_id: '', job_id: null, error: msg });
    }
  }

  await admin
    .from('engine_calibration_run_summaries')
    .update({
      n_projects_dispatched: dispatched.filter((d) => d.job_id != null).length,
      summary_jsonb: { project_ids: projectIds, dispatched },
    })
    .eq('run_id', runId);

  // ── Background phase: poll + post-snapshot + compute metrics ──────────
  const bgWork = (async () => {
    try {
      await waitForRoundsToTerminate(
        admin,
        runId,
        dispatched.filter((d) => d.round_id).map((d) => d.round_id),
      );
      await computeAndPersist(admin, runId, projectIds, preSnapshots);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] bg work failed for run ${runId}: ${msg}`);
      try {
        await admin
          .from('engine_calibration_run_summaries')
          .update({ status: 'failed', finished_at: new Date().toISOString(), summary_jsonb: { error: msg } })
          .eq('run_id', runId);
      } catch {
        /* swallow — best-effort cleanup */
      }
    }
  })();

  // EdgeRuntime.waitUntil keeps the worker alive past HTTP response. Same
  // pattern as shortlisting-shape-d.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      mode: 'background',
      run_id: runId,
      n_projects_requested: projectIds.length,
      n_projects_dispatched: dispatched.filter((d) => d.job_id != null).length,
      dispatched,
    },
    200,
    req,
  );
});

// ─── Sample resolution ──────────────────────────────────────────────────────

async function resolveStratifiedSample(
  admin: AdminClient,
  seed: number,
  n: number,
): Promise<string[]> {
  // Pull all projects that have at least one Shape D round in a terminal state.
  const { data: rows, error } = await admin
    .from('shortlisting_rounds')
    .select('project_id, id, status, engine_mode, property_tier, created_at')
    .like('engine_mode', 'shape_d%')
    .in('status', ['proposed', 'locked', 'delivered'])
    .order('created_at', { ascending: false });
  if (error) throw new Error(`stratification lookup failed: ${error.message}`);

  // Pick the most recent round per project.
  const latestByProject = new Map<string, { round_id: string; tier: PropertyTier }>();
  for (const r of rows ?? []) {
    if (!latestByProject.has(r.project_id) && r.property_tier) {
      latestByProject.set(r.project_id, {
        round_id: r.id,
        tier: r.property_tier as PropertyTier,
      });
    }
  }
  if (latestByProject.size === 0) return [];

  // Count overrides per round to bucket well/challenging.
  const roundIds = Array.from(latestByProject.values()).map((v) => v.round_id);
  const { data: ovrRows } = await admin
    .from('shortlisting_stage4_overrides')
    .select('round_id')
    .in('round_id', roundIds);
  const ovrCount = new Map<string, number>();
  for (const r of ovrRows ?? []) {
    ovrCount.set(r.round_id, (ovrCount.get(r.round_id) ?? 0) + 1);
  }

  const candidates: CandidateProject[] = [];
  for (const [projectId, info] of latestByProject.entries()) {
    candidates.push({
      project_id: projectId,
      property_tier: info.tier,
      prior_override_count: ovrCount.get(info.round_id) ?? 0,
    });
  }

  // Scale strata to n (when n < 50, downsample proportionally).
  const totalDefault = DEFAULT_STRATA.premium + DEFAULT_STRATA.standard + DEFAULT_STRATA.approachable;
  const scale = n / totalDefault;
  const strata: SampleStrategy = {
    premium: Math.round(DEFAULT_STRATA.premium * scale),
    standard: Math.round(DEFAULT_STRATA.standard * scale),
    approachable: Math.round(DEFAULT_STRATA.approachable * scale),
  };
  // Make sure the rounding adds up to n exactly.
  const rounded = strata.premium + strata.standard + strata.approachable;
  if (rounded < n) strata.standard += n - rounded;

  return stratifiedSample(candidates, strata, seed, n);
}

// ─── Snapshot capture ───────────────────────────────────────────────────────

async function captureProjectSnapshot(
  admin: AdminClient,
  projectId: string,
): Promise<ProjectSnapshot | null> {
  // Most-recent Shape D round for the project.
  const { data: round } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, property_tier, total_compositions, engine_mode')
    .eq('project_id', projectId)
    .like('engine_mode', 'shape_d%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!round) return null;

  // Project address (display only).
  const { data: proj } = await admin
    .from('projects')
    .select('property_address, title')
    .eq('id', projectId)
    .maybeSingle();

  // Per-image classifications (with bracket-stem mapping for stable identity).
  const { data: cls } = await admin
    .from('composition_classifications')
    .select(
      'group_id, technical_score, lighting_score, composition_score, aesthetic_score, clutter_severity',
    )
    .eq('round_id', round.id);

  const { data: groups } = await admin
    .from('composition_groups')
    .select('id, delivery_reference_stem, best_bracket_stem')
    .eq('round_id', round.id);

  const stemByGroup = new Map<string, string>();
  for (const g of groups ?? []) {
    const s = (g.delivery_reference_stem || g.best_bracket_stem || g.id) as string;
    stemByGroup.set(g.id, s);
  }

  const scores: Record<string, ImageScores> = {};
  const clutter: Record<string, ClutterSeverity | null> = {};
  for (const c of cls ?? []) {
    const stem = stemByGroup.get(c.group_id);
    if (!stem) continue;
    scores[stem] = {
      technical: Number(c.technical_score ?? 0),
      lighting: Number(c.lighting_score ?? 0),
      composition: Number(c.composition_score ?? 0),
      aesthetic: Number(c.aesthetic_score ?? 0),
    };
    clutter[stem] = (c.clutter_severity as ClutterSeverity | null) ?? null;
  }

  // Slot decisions — most-recent shortlisting_overrides per slot.
  const { data: ovrs } = await admin
    .from('shortlisting_overrides')
    .select('ai_proposed_slot_id, ai_proposed_group_id, created_at')
    .eq('round_id', round.id)
    .order('created_at', { ascending: false });
  const slotMap = new Map<string, string | null>();
  for (const o of ovrs ?? []) {
    if (o.ai_proposed_slot_id && !slotMap.has(o.ai_proposed_slot_id)) {
      const stem = o.ai_proposed_group_id ? stemByGroup.get(o.ai_proposed_group_id) ?? null : null;
      slotMap.set(o.ai_proposed_slot_id, stem);
    }
  }
  const slots: SlotDecision[] = Array.from(slotMap.entries()).map(([slot_id, winning_stem]) => ({
    slot_id,
    winning_stem,
  }));

  // Stage 4 overrides count.
  const { count: overrideCount } = await admin
    .from('shortlisting_stage4_overrides')
    .select('id', { count: 'exact', head: true })
    .eq('round_id', round.id);

  // Master listing (latest active row).
  const { data: ml } = await admin
    .from('shortlisting_master_listings')
    .select('master_listing, word_count, reading_grade_level')
    .eq('round_id', round.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let toneAnchor: string | null = null;
  if (ml?.master_listing && typeof ml.master_listing === 'object') {
    const m = ml.master_listing as Record<string, unknown>;
    const ta = m.tone_anchor ?? m.voice_anchor ?? null;
    toneAnchor = typeof ta === 'string' ? ta : null;
  }

  // Cost (last engine_run_audit row).
  const { data: era } = await admin
    .from('engine_run_audit')
    .select('total_cost_usd, stage1_total_cost_usd, stage4_total_cost_usd')
    .eq('round_id', round.id)
    .maybeSingle();
  const cost = Number(era?.total_cost_usd ?? 0);

  return {
    project_id: projectId,
    round_id: round.id,
    property_tier: (round.property_tier as PropertyTier) ?? 'standard',
    property_address: proj?.property_address ?? proj?.title ?? null,
    scores,
    clutter,
    slots,
    override_count: overrideCount ?? 0,
    total_compositions: round.total_compositions ?? Object.keys(scores).length,
    master_listing: ml
      ? {
          word_count: ml.word_count != null ? Number(ml.word_count) : null,
          reading_grade_level:
            ml.reading_grade_level != null ? Number(ml.reading_grade_level) : null,
          tone_anchor: toneAnchor,
        }
      : null,
    cost_usd: cost,
  };
}

// ─── Polling ────────────────────────────────────────────────────────────────

async function waitForRoundsToTerminate(
  admin: AdminClient,
  runId: string,
  roundIds: string[],
): Promise<void> {
  if (roundIds.length === 0) return;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A round is "done" when its stage4_synthesis job is in a terminal state
    // OR its shape_d_stage1 job is in 'failed'/'dead_letter' (no Stage 4 will
    // ever fire for a failed Stage 1).
    const { data: jobs } = await admin
      .from('shortlisting_jobs')
      .select('round_id, kind, status')
      .in('round_id', roundIds)
      .in('kind', ['shape_d_stage1', 'stage4_synthesis']);

    const statusByRound = new Map<string, { stage1: string | null; stage4: string | null }>();
    for (const r of roundIds) statusByRound.set(r, { stage1: null, stage4: null });
    for (const j of jobs ?? []) {
      const rec = statusByRound.get(j.round_id) ?? { stage1: null, stage4: null };
      if (j.kind === 'shape_d_stage1') rec.stage1 = j.status;
      else if (j.kind === 'stage4_synthesis') rec.stage4 = j.status;
      statusByRound.set(j.round_id, rec);
    }

    const allDone = [...statusByRound.values()].every((s) => {
      // Stage 1 in terminal-failure → done (Stage 4 won't fire)
      if (s.stage1 === 'failed' || s.stage1 === 'dead_letter') return true;
      // Stage 4 reached terminal → done
      if (s.stage4 === 'succeeded' || s.stage4 === 'failed' || s.stage4 === 'dead_letter') return true;
      return false;
    });

    if (allDone) return;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  console.warn(`[${GENERATOR}] poll timeout reached for run ${runId} after ${POLL_TIMEOUT_MS}ms`);
}

// ─── Compute + persist ──────────────────────────────────────────────────────

async function computeAndPersist(
  admin: AdminClient,
  runId: string,
  projectIds: string[],
  preSnapshots: Record<string, ProjectSnapshot>,
): Promise<void> {
  const perProjectRows: Array<{
    project_id: string;
    cost: number;
    score_max_axis_max: number;
    slot_agreement: number | null;
    override_rate: number;
    regression_pct: number;
    in_band: boolean;
  }> = [];
  const tonesPerTier: Array<{ tier: PropertyTier; tone_anchor: string | null }> = [];

  for (const projectId of projectIds) {
    const pre = preSnapshots[projectId];
    if (!pre) continue;

    let post: ProjectSnapshot | null = null;
    let errorMsg: string | null = null;
    try {
      post = await captureProjectSnapshot(admin, projectId);
      if (!post) errorMsg = 'Post-run snapshot missing — round disappeared';
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    if (!post) {
      await admin
        .from('engine_calibration_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: errorMsg,
        })
        .eq('run_id', runId)
        .eq('project_id', projectId);
      continue;
    }

    // Score consistency — pair on stem
    const pairs: PairedImageScore[] = [];
    for (const stem of Object.keys(post.scores)) {
      const priorScores = pre.scores[stem];
      const nowScores = post.scores[stem];
      if (priorScores) pairs.push({ stem, prior: priorScores, now: nowScores });
    }
    const scoreCons = computeScoreConsistency(pairs);

    // Slot agreement
    const slotResult = computeSlotAgreement(pre.slots, post.slots);

    // Override metrics
    const total = post.total_compositions || Object.keys(post.scores).length;
    const overrideRate = total > 0 ? post.override_count / total : 0;

    // Regressions (prior vs now clutter)
    const clutterPairs: PairedClutter[] = [];
    for (const stem of Object.keys(post.clutter)) {
      clutterPairs.push({
        stem,
        prior: pre.clutter[stem] ?? null,
        now: post.clutter[stem] ?? null,
      });
    }
    const regr = detectRegressions(clutterPairs, total);

    // Master listing
    const inBand = post.master_listing
      ? masterListingInBand(post.property_tier, post.master_listing.word_count)
      : false;
    if (post.master_listing?.tone_anchor) {
      tonesPerTier.push({ tier: post.property_tier, tone_anchor: post.master_listing.tone_anchor });
    }

    const costThisRun = post.cost_usd; // engine_run_audit was rewritten by the new run

    await admin
      .from('engine_calibration_runs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        score_consistency_jsonb: scoreCons as unknown as Record<string, unknown>,
        slot_agreement_pct: slotResult.agreement_pct,
        slot_diff_jsonb: slotResult as unknown as Record<string, unknown>,
        override_count: post.override_count,
        override_rate: round4(overrideRate),
        regression_count: regr.count,
        regression_pct: regr.pct,
        regression_detail_jsonb: { regressions: regr.regressions },
        master_listing_in_band: inBand,
        word_count_now: post.master_listing?.word_count ?? null,
        reading_grade_level_now: post.master_listing?.reading_grade_level ?? null,
        tone_anchor_now: post.master_listing?.tone_anchor ?? null,
        cost_usd: costThisRun,
        post_run_snapshot: post as unknown as Record<string, unknown>,
      })
      .eq('run_id', runId)
      .eq('project_id', projectId);

    perProjectRows.push({
      project_id: projectId,
      cost: costThisRun,
      score_max_axis_max: scoreCons.max_axis_max,
      slot_agreement: slotResult.agreement_pct,
      override_rate: overrideRate,
      regression_pct: regr.pct,
      in_band: inBand,
    });
  }

  // ── Aggregates ──────────────────────────────────────────────────────
  const medianScoreDelta = medianOrNull(perProjectRows.map((r) => r.score_max_axis_max));
  const medianSlotAgreement = medianOrNull(perProjectRows.map((r) => r.slot_agreement));
  const medianOverrideRate = medianOrNull(perProjectRows.map((r) => r.override_rate));
  const medianRegressionPct = medianOrNull(perProjectRows.map((r) => r.regression_pct));
  const oobCount = perProjectRows.filter((r) => !r.in_band).length;
  const oobRate = perProjectRows.length > 0 ? oobCount / perProjectRows.length : 0;
  const totalCost = perProjectRows.reduce((s, r) => s + (r.cost ?? 0), 0);
  const voiceStability = voiceAnchorStability(tonesPerTier);

  const acceptance = evaluateAcceptance({
    median_score_delta: medianScoreDelta,
    median_slot_agreement: medianSlotAgreement,
    median_override_rate: medianOverrideRate,
    median_regression_pct: medianRegressionPct,
    master_listing_oob_rate: round4(oobRate),
  });

  const completedCount = perProjectRows.length;
  const failedCount = projectIds.length - completedCount;

  // Status:
  //   completed → at least one project finished and was scored
  //   failed    → zero projects finished (all snapshots missing)
  //   timeout   → reserved for the polling helper to set explicitly; today the
  //               poll loop just exits and we score whatever finished
  const finalStatus: 'completed' | 'failed' =
    completedCount === 0 ? 'failed' : 'completed';

  await admin
    .from('engine_calibration_run_summaries')
    .update({
      status: finalStatus,
      finished_at: new Date().toISOString(),
      n_projects_completed: completedCount,
      n_projects_failed: failedCount,
      total_cost_usd: round4(totalCost),
      median_score_delta: medianScoreDelta != null ? round2(medianScoreDelta) : null,
      median_slot_agreement: medianSlotAgreement != null ? round4(medianSlotAgreement) : null,
      median_override_rate: medianOverrideRate != null ? round4(medianOverrideRate) : null,
      median_regression_pct: medianRegressionPct != null ? round4(medianRegressionPct) : null,
      master_listing_oob_rate: round4(oobRate),
      voice_anchor_stability: voiceStability.overall,
      acceptance_pass: acceptance.pass,
      failed_criteria: acceptance.failed_criteria,
      summary_jsonb: {
        per_project: perProjectRows,
        voice_anchor_stability: voiceStability,
        completed_at: new Date().toISOString(),
      },
    })
    .eq('run_id', runId);

  // Emit one calibration_complete event per project for downstream consumers.
  // shortlisting_events.project_id is NOT NULL so we fan out per-project; the
  // run-level summary lives in engine_calibration_run_summaries.
  if (perProjectRows.length > 0) {
    const eventRows = perProjectRows.map((r) => ({
      project_id: r.project_id,
      event_type: 'calibration_complete',
      actor_type: 'system',
      actor_id: null,
      payload: {
        run_id: runId,
        acceptance_pass: acceptance.pass,
        failed_criteria: acceptance.failed_criteria,
        per_project: r,
      },
    }));
    try {
      await admin.from('shortlisting_events').insert(eventRows);
    } catch {
      /* swallow — events are best-effort */
    }
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
