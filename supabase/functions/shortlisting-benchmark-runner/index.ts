/**
 * shortlisting-benchmark-runner
 * ──────────────────────────────
 * Quarterly accuracy benchmark — re-runs Pass 2 in blind mode against the
 * holdout set (rounds with is_benchmark=TRUE) and compares the proposed
 * shortlist against round.confirmed_shortlist_group_ids.
 *
 * Per spec §14:
 *   - Default sample_size = 50 rounds (limit param)
 *   - Each blind run is a single Sonnet call (Pass 2 is text-only)
 *   - Match rate = matched_groups / total_confirmed_groups
 *   - Baseline = 0.78 (Goldmine 4 zero-knowledge baseline)
 *   - Target after 6 months = >0.88
 *
 * Cost note: ~$0.03 per round → ~$1.50 per benchmark at limit=50. Default
 * limit is conservative; admins can raise it from the Calibration UI.
 *
 * POST { trigger?: 'manual' | 'quarterly_cron', limit?: number }
 *
 * Auth: master_admin / admin OR service_role.
 *
 * Response: full benchmark result + the inserted shortlisting_benchmark_results
 *           row id.
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
  callClaudeVision,
  type VisionMessage,
} from '../_shared/anthropicVision.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';
import {
  buildPass2Prompt,
  type Pass2ClassificationRow,
  type Pass2SlotDefinition,
} from '../_shared/pass2Prompt.ts';
import { validatePass2Output } from '../_shared/pass2Validator.ts';

const GENERATOR = 'shortlisting-benchmark-runner';
const ENGINE_VERSION = 'wave-6-p8';
const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 4000;
const PASS1_MODEL = 'claude-sonnet-4-6'; // engine current — recorded for provenance
const DEFAULT_LIMIT = 50;
const HARD_LIMIT_MAX = 200;

const PACKAGE_CEILING_DEFAULTS: Record<string, number> = {
  'gold': 24,
  'day to dusk': 31,
  'premium': 38,
};

interface RequestBody {
  trigger?: 'manual' | 'quarterly_cron';
  limit?: number;
  _health_check?: boolean;
}

interface BenchmarkRoundContext {
  round_id: string;
  project_id: string;
  package_type: string;
  package_ceiling: number;
  property_address: string | null;
  tier: string;
  confirmed_group_ids: string[];
}

interface RoundResult {
  round_id: string;
  package_type: string;
  matched: number;
  total_confirmed: number;
  match_rate: number;
  per_slot: Record<string, number>; // slot_id → 1 (matched) | 0 (missed)
  cost_usd: number;
  warnings: string[];
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse(
        'Forbidden — only master_admin/admin can run the benchmark',
        403,
        req,
      );
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body */
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const trigger: 'manual' | 'quarterly_cron' =
    body.trigger === 'quarterly_cron' ? 'quarterly_cron' : 'manual';
  const limit = Math.min(
    Math.max(Number(body.limit) || DEFAULT_LIMIT, 1),
    HARD_LIMIT_MAX,
  );

  const admin = getAdminClient();

  // ── Select holdout rounds ──────────────────────────────────────────────
  const { data: rounds, error: rerr } = await admin
    .from('shortlisting_rounds')
    .select(
      'id, project_id, status, package_type, package_ceiling, confirmed_shortlist_group_ids',
    )
    .eq('is_benchmark', true)
    .eq('status', 'locked')
    .order('locked_at', { ascending: false })
    .limit(limit);
  if (rerr) return errorResponse(`holdout lookup failed: ${rerr.message}`, 500, req);

  const eligible = (rounds || []).filter(
    (r) =>
      Array.isArray(r.confirmed_shortlist_group_ids) &&
      r.confirmed_shortlist_group_ids.length > 0,
  );

  if (eligible.length === 0) {
    return jsonResponse(
      {
        ok: true,
        sample_size: 0,
        match_rate: 0,
        improvement_vs_baseline: -0.78,
        message: 'No eligible holdout rounds (need is_benchmark=TRUE, status=locked, non-empty confirmed_shortlist_group_ids).',
      },
      200,
      req,
    );
  }

  // ── Stream B anchors (consistent across all benchmark runs in this batch) ─
  const anchors = await getActiveStreamBAnchors();

  // ── Iterate rounds + run blind Pass 2 ──────────────────────────────────
  const results: RoundResult[] = [];
  let totalMatches = 0;
  let totalSlots = 0;
  let totalCost = 0;
  const perSlotAgg = new Map<string, { matches: number; total: number }>();
  const perPackageAgg = new Map<string, { matches: number; total: number }>();

  for (const round of eligible) {
    try {
      const result = await runBlindBenchmark(round, anchors);
      results.push(result);
      totalMatches += result.matched;
      totalSlots += result.total_confirmed;
      totalCost += result.cost_usd;

      // per-slot accumulator (we don't have slot_id for every confirmed
      // group — but per_slot covers what we could attribute).
      for (const [slotId, val] of Object.entries(result.per_slot)) {
        const cur = perSlotAgg.get(slotId) || { matches: 0, total: 0 };
        cur.matches += val;
        cur.total += 1;
        perSlotAgg.set(slotId, cur);
      }

      const pkg = (round.package_type || 'unknown') as string;
      const cur = perPackageAgg.get(pkg) || { matches: 0, total: 0 };
      cur.matches += result.matched;
      cur.total += result.total_confirmed;
      perPackageAgg.set(pkg, cur);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] round ${round.id} failed: ${msg}`);
      results.push({
        round_id: round.id,
        package_type: (round.package_type as string) || 'unknown',
        matched: 0,
        total_confirmed: (round.confirmed_shortlist_group_ids as string[])?.length || 0,
        match_rate: 0,
        per_slot: {},
        cost_usd: 0,
        warnings: [`benchmark failed: ${msg}`],
      });
      // Failed rounds count toward total_slots (denominator) but contribute
      // zero matches — treats them as "engine couldn't reproduce" rather
      // than dropping them silently.
      totalSlots += (round.confirmed_shortlist_group_ids as string[])?.length || 0;
    }
  }

  const matchRate = totalSlots > 0 ? totalMatches / totalSlots : 0;
  const improvement = matchRate - 0.78;

  // ── Compute per-slot / per-package match rates ─────────────────────────
  const perSlotMatchRates: Record<string, number> = {};
  for (const [slotId, agg] of perSlotAgg.entries()) {
    perSlotMatchRates[slotId] = agg.total > 0 ? roundRate(agg.matches / agg.total) : 0;
  }
  const perPackageMatchRates: Record<string, number> = {};
  for (const [pkg, agg] of perPackageAgg.entries()) {
    perPackageMatchRates[pkg] = agg.total > 0 ? roundRate(agg.matches / agg.total) : 0;
  }

  // ── Insert benchmark_results row ───────────────────────────────────────
  const ranBy = isService ? null : (user?.id ?? null);
  const totalCostRounded = Math.round(totalCost * 1_000_000) / 1_000_000;
  const insertPayload = {
    ran_by: ranBy,
    trigger,
    sample_size: results.length,
    total_matches: totalMatches,
    total_slots: totalSlots,
    match_rate: roundRate(matchRate),
    baseline_match_rate: 0.78,
    improvement_vs_baseline: roundRate(improvement),
    per_slot_match_rates: perSlotMatchRates,
    per_package_match_rates: perPackageMatchRates,
    engine_version: ENGINE_VERSION,
    model_versions: { pass1: PASS1_MODEL, pass2: SONNET_MODEL },
    notes: `cost_usd=${totalCostRounded.toFixed(4)} | failed=${results.filter((r) => r.warnings.length > 0).length}`,
  };
  const { data: inserted, error: insErr } = await admin
    .from('shortlisting_benchmark_results')
    .insert(insertPayload)
    .select('id')
    .maybeSingle();
  if (insErr) {
    console.warn(`[${GENERATOR}] benchmark_results insert failed: ${insErr.message}`);
  }

  // ── Audit event ────────────────────────────────────────────────────────
  await admin.from('shortlisting_events').insert({
    project_id: null,
    round_id: null,
    event_type: 'benchmark_complete',
    actor_type: isService ? 'system' : 'user',
    actor_id: ranBy,
    payload: {
      result_id: inserted?.id ?? null,
      sample_size: results.length,
      match_rate: roundRate(matchRate),
      improvement_vs_baseline: roundRate(improvement),
      total_cost_usd: totalCostRounded,
      trigger,
    },
  });

  return jsonResponse(
    {
      ok: true,
      result_id: inserted?.id ?? null,
      sample_size: results.length,
      total_matches: totalMatches,
      total_slots: totalSlots,
      match_rate: roundRate(matchRate),
      baseline_match_rate: 0.78,
      improvement_vs_baseline: roundRate(improvement),
      per_slot_match_rates: perSlotMatchRates,
      per_package_match_rates: perPackageMatchRates,
      total_cost_usd: totalCostRounded,
      per_round: results,
    },
    200,
    req,
  );
});

// ─── Per-round blind benchmark ──────────────────────────────────────────────
async function runBlindBenchmark(
  // deno-lint-ignore no-explicit-any
  round: any,
  // deno-lint-ignore no-explicit-any
  anchors: any,
): Promise<RoundResult> {
  const admin = getAdminClient();
  const warnings: string[] = [];

  const confirmedIds: string[] = round.confirmed_shortlist_group_ids || [];
  const packageType = (round.package_type as string) || 'Gold';
  const packageCeiling =
    (round.package_ceiling as number) ||
    PACKAGE_CEILING_DEFAULTS[packageType.toLowerCase()] ||
    24;

  // Project metadata for prompt context
  const { data: project } = await admin
    .from('projects')
    .select('property_address, pricing_tier')
    .eq('id', round.project_id)
    .maybeSingle();
  const tier = ((project?.pricing_tier as string) || 'standard').toLowerCase();

  const ctx: BenchmarkRoundContext = {
    round_id: round.id,
    project_id: round.project_id,
    package_type: packageType,
    package_ceiling: packageCeiling,
    property_address: project?.property_address ?? null,
    tier,
    confirmed_group_ids: confirmedIds,
  };

  // Fetch classifications + their groups (for stems)
  const classifications = await fetchClassifications(admin, round.id);
  if (classifications.length === 0) {
    throw new Error(`no classifications for round ${round.id}`);
  }
  // Build stem ↔ group_id map
  const stemToGroupId = new Map<string, string>();
  for (const c of classifications) stemToGroupId.set(c.stem, c.group_id);

  // Slot definitions for this package
  const slotDefinitions = await fetchSlotDefinitions(admin, packageType);

  // Build prompt — same as Pass 2 production
  const prompt = buildPass2Prompt({
    propertyAddress: ctx.property_address,
    packageType: ctx.package_type,
    packageCeiling: ctx.package_ceiling,
    tier: ctx.tier,
    slotDefinitions,
    streamBAnchors: anchors,
    classifications,
  });

  // Single Sonnet call — text-only
  const messages: VisionMessage[] = [
    { role: 'user', content: [{ type: 'text', text: prompt.userPrefix }] },
  ];

  let visionContent = '';
  let visionCostUsd = 0;
  try {
    const visionRes = await callClaudeVision({
      model: SONNET_MODEL,
      messages,
      system: prompt.system,
      max_tokens: SONNET_MAX_TOKENS,
      temperature: 0,
    });
    visionContent = visionRes.content;
    visionCostUsd = visionRes.costUsd;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Sonnet call failed: ${msg}`);
  }

  // Parse & validate (mirror pass2's logic)
  const parsed = parsePass2Json(visionContent);
  if (!parsed.ok) {
    throw new Error(`pass2 JSON parse failed: ${parsed.error}`);
  }

  const allFileStems = classifications.map((c) => c.stem);
  const mandatorySlotIds = slotDefinitions.filter((s) => s.phase === 1).map((s) => s.slot_id);
  const validation = validatePass2Output(parsed.value, {
    packageCeiling: ctx.package_ceiling,
    mandatorySlotIds,
    allFileStems,
  });
  if (!validation.valid) {
    warnings.push(`validation failed: ${validation.errors.join('; ')}`);
  }
  const output = validation.fixed;

  // Build proposed group_id set: shortlist (winners + alternatives ranked 1)
  // The cleanest "engine-proposed shortlist" is the union of:
  //   - slot_assignments (winners) → rank 1
  //   - phase3_recommendations
  // (We exclude alternatives ranked 2/3 — they're not in the proposed shortlist.)
  const proposedGroupIds = new Set<string>();
  for (const stems of Object.values(output.slot_assignments)) {
    const arr = Array.isArray(stems) ? stems : [stems as string];
    for (const stem of arr) {
      const gid = stemToGroupId.get(stem);
      if (gid) proposedGroupIds.add(gid);
    }
  }
  for (const rec of output.phase3_recommendations) {
    const gid = stemToGroupId.get(rec.file);
    if (gid) proposedGroupIds.add(gid);
  }

  // Compute matches: how many confirmed group_ids are also in proposed?
  const confirmedSet = new Set(confirmedIds);
  let matched = 0;
  for (const gid of proposedGroupIds) {
    if (confirmedSet.has(gid)) matched++;
  }

  // Per-slot attribution: for each slot_assignment in the engine output,
  // if the assigned stem's group_id is in confirmedSet → 1, else 0.
  const perSlot: Record<string, number> = {};
  for (const [slotId, stems] of Object.entries(output.slot_assignments)) {
    const arr = Array.isArray(stems) ? stems : [stems as string];
    let slotMatched = 0;
    for (const stem of arr) {
      const gid = stemToGroupId.get(stem);
      if (gid && confirmedSet.has(gid)) {
        slotMatched = 1;
        break;
      }
    }
    perSlot[slotId] = slotMatched;
  }

  return {
    round_id: round.id,
    package_type: packageType,
    matched,
    total_confirmed: confirmedIds.length,
    match_rate: confirmedIds.length > 0 ? matched / confirmedIds.length : 0,
    per_slot: perSlot,
    cost_usd: visionCostUsd,
    warnings,
  };
}

// ─── DB helpers (mirror shortlisting-pass2) ────────────────────────────────
async function fetchClassifications(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<Pass2ClassificationRow[]> {
  const { data, error } = await admin
    .from('composition_classifications')
    .select(`
      group_id,
      analysis,
      room_type,
      composition_type,
      vantage_point,
      technical_score,
      lighting_score,
      composition_score,
      aesthetic_score,
      combined_score,
      is_styled,
      indoor_outdoor_visible,
      is_drone,
      is_exterior,
      eligible_for_exterior_rear,
      clutter_severity,
      flag_for_retouching,
      composition_groups!composition_classifications_group_id_fkey(
        group_index,
        delivery_reference_stem,
        best_bracket_stem
      )
    `)
    .eq('round_id', roundId);
  if (error) throw new Error(`fetchClassifications failed: ${error.message}`);
  if (!data) return [];
  // deno-lint-ignore no-explicit-any
  return data.map((r: any) => {
    const grp = Array.isArray(r.composition_groups) ? r.composition_groups[0] : r.composition_groups;
    const stem = grp?.delivery_reference_stem || grp?.best_bracket_stem || `group_${grp?.group_index ?? '?'}`;
    return {
      stem,
      group_id: r.group_id,
      group_index: grp?.group_index ?? 0,
      room_type: r.room_type,
      composition_type: r.composition_type,
      vantage_point: r.vantage_point,
      technical_score: r.technical_score,
      lighting_score: r.lighting_score,
      composition_score: r.composition_score,
      aesthetic_score: r.aesthetic_score,
      combined_score: r.combined_score,
      is_styled: r.is_styled,
      indoor_outdoor_visible: r.indoor_outdoor_visible,
      is_drone: r.is_drone,
      is_exterior: r.is_exterior,
      eligible_for_exterior_rear: r.eligible_for_exterior_rear,
      clutter_severity: r.clutter_severity,
      flag_for_retouching: r.flag_for_retouching,
      analysis: r.analysis,
    } as Pass2ClassificationRow;
  });
}

async function fetchSlotDefinitions(
  admin: ReturnType<typeof getAdminClient>,
  packageType: string,
): Promise<Pass2SlotDefinition[]> {
  const { data, error } = await admin
    .from('shortlisting_slot_definitions')
    .select('slot_id, display_name, phase, package_types, eligible_room_types, max_images, min_images, notes, version')
    .eq('is_active', true);
  if (error) throw new Error(`fetchSlotDefinitions failed: ${error.message}`);
  if (!data) return [];

  const matchPkg = packageType.toLowerCase();
  // deno-lint-ignore no-explicit-any
  const filtered = (data as any[]).filter((row) => {
    const pkgs: string[] = Array.isArray(row.package_types) ? row.package_types : [];
    if (pkgs.length === 0) return true;
    return pkgs.some((p) => String(p).toLowerCase() === matchPkg);
  });

  const byId = new Map<string, Pass2SlotDefinition & { version: number }>();
  for (const row of filtered) {
    const cand = {
      slot_id: row.slot_id,
      display_name: row.display_name,
      phase: row.phase,
      eligible_room_types: row.eligible_room_types || [],
      max_images: row.max_images,
      min_images: row.min_images,
      notes: row.notes,
      version: row.version || 1,
    } as Pass2SlotDefinition & { version: number };
    const existing = byId.get(cand.slot_id);
    if (!existing || cand.version > existing.version) byId.set(cand.slot_id, cand);
  }

  return Array.from(byId.values())
    .map(({ version: _v, ...rest }) => rest)
    .sort((a, b) => (a.phase - b.phase) || a.slot_id.localeCompare(b.slot_id));
}

// ─── JSON parser (lightweight version of pass2's) ──────────────────────────
// deno-lint-ignore no-explicit-any
function parsePass2Json(content: string): { ok: true; value: any } | { ok: false; error: string } {
  if (!content) return { ok: false, error: 'empty content' };
  // Find a top-level JSON object — strip any surrounding fences.
  let s = content.trim();
  // Remove markdown code fences if present
  s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  // First/last brace
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) {
    return { ok: false, error: 'no JSON object found' };
  }
  const json = s.slice(first, last + 1);
  try {
    const parsed = JSON.parse(json);
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: `JSON.parse: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function roundRate(n: number): number {
  return Math.round(n * 10000) / 10000;
}
