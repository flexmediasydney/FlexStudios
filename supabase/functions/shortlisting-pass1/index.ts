/**
 * shortlisting-pass1
 * ───────────────────
 * Pass 1 orchestrator for the shortlisting engine.
 *
 * Runs AFTER `shortlisting-pass0` has filtered hard rejects and quarantined
 * out-of-scope frames. Pass 1 classifies EVERY remaining composition group
 * with Sonnet vision using a reasoning-FIRST prompt and Stream B tier-anchor
 * injection.
 *
 * Critical v2 architecture (do not deviate):
 *
 *   1. REASONING-FIRST (spec L9): the model writes the full `analysis`
 *      paragraph BEFORE producing any scores. Without this, the prose becomes
 *      post-hoc justification of arbitrary numbers and prose/score consistency
 *      drops. Enforced in pass1Prompt.ts STEP 1 / STEP 2 ordering.
 *
 *   2. STREAM B INJECTION (spec L8): tier descriptors (Tier S=5 / P=8 / A=9.5+)
 *      are injected as scoring anchors. Without them Sonnet clusters every
 *      score 7–9 (grade inflation). Loaded from shortlisting_stream_b_anchors
 *      with hardcoded fallbacks.
 *
 *   3. NO SHORTLISTING DECISIONS (spec L4): Pass 1 classifies and scores. It
 *      does not pick winners. Pass 2 does selection with full universe context.
 *
 *   4. CONCURRENT EXECUTION (spec L20): vision calls are embarrassingly
 *      parallel. Default 10 concurrent, configurable via PASS1_CONCURRENCY env
 *      or `concurrency` in body.
 *
 * Body modes:
 *   { round_id: string }   — orchestrate the whole round (normal path)
 *   { job_id:   string }   — read round_id off a job row first (dispatcher)
 *
 * Auth: service_role OR master_admin / admin / manager.
 *
 * Per-composition errors are logged to shortlisting_events and counted but do
 * not abort the sweep — UNLESS failures exceed 20% of compositions, in which
 * case the round is rolled back to allow a retry.
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
import { getDropboxTempLink } from '../_shared/shortlistingFolders.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';
import { buildPass1Prompt } from '../_shared/pass1Prompt.ts';
import { getActivePrompt } from '../_shared/promptLoader.ts';

const GENERATOR = 'shortlisting-pass1';

// ─── Constants ──────────────────────────────────────────────────────────────

const SONNET_MODEL = 'claude-sonnet-4-6';
const SONNET_MAX_TOKENS = 1500;
const DEFAULT_CONCURRENCY = 10;
// If more than this fraction of compositions fail, abort — round is retryable.
const MAX_FAILURE_RATE = 0.20;

// All 22 fields the Pass 1 JSON output must contain. Missing fields → reject.
const REQUIRED_JSON_FIELDS = [
  'analysis',
  'room_type',
  'room_type_confidence',
  'composition_type',
  'vantage_point',
  'time_of_day',
  'is_drone',
  'is_exterior',
  'is_detail_shot',
  'zones_visible',
  'key_elements',
  'is_styled',
  'indoor_outdoor_visible',
  'clutter_severity',
  'clutter_detail',
  'flag_for_retouching',
  'technical_score',
  'lighting_score',
  'composition_score',
  'aesthetic_score',
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  concurrency?: number;
  _health_check?: boolean;
}

interface ReadyComposition {
  id: string;
  project_id: string;
  round_id: string;
  group_index: number;
  best_bracket_stem: string;
  delivery_reference_stem: string;
  dropbox_preview_path: string;
}

interface Pass1Classification {
  analysis: string;
  room_type: string;
  room_type_confidence: number;
  composition_type: string;
  vantage_point: 'interior_looking_out' | 'exterior_looking_in' | 'neutral' | string;
  time_of_day: string;
  is_drone: boolean;
  is_exterior: boolean;
  is_detail_shot: boolean;
  zones_visible: string[];
  key_elements: string[];
  is_styled: boolean;
  indoor_outdoor_visible: boolean;
  clutter_severity: 'none' | 'minor_photoshoppable' | 'moderate_retouch' | 'major_reject' | string;
  clutter_detail: string | null;
  flag_for_retouching: boolean;
  technical_score: number;
  lighting_score: number;
  composition_score: number;
  aesthetic_score: number;
}

interface ClassifyResult {
  composition: ReadyComposition;
  classification: Pass1Classification | null;
  error: string | null;
  costUsd: number;
}

interface Pass1RoundResult {
  total_ready: number;
  classifications_inserted: number;
  failures: number;
  cost_usd: number;
  duration_ms: number;
  anchors_version: number;
  warnings: string[];
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
  // verify the caller actually has access to the round's project.
  if (!isService) {
    const adminLookup = getAdminClient();
    const { data: rowForAcl } = await adminLookup
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', roundId)
      .maybeSingle();
    const pid = rowForAcl?.project_id ? String(rowForAcl.project_id) : '';
    if (!pid) return errorResponse('round not found', 404, req);
    const allowed = await callerHasProjectAccess(user, pid);
    if (!allowed) {
      return errorResponse('Forbidden — caller has no access to this project', 403, req);
    }
  }

  const concurrency = resolveConcurrency(body.concurrency);

  try {
    const result = await runPass1(roundId, concurrency);
    return jsonResponse({ ok: true, round_id: roundId, ...result }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for round ${roundId}: ${msg}`);
    return errorResponse(`pass1 failed: ${msg}`, 500, req);
  }
});

function resolveConcurrency(bodyValue: number | undefined): number {
  const envValue = Number(Deno.env.get('PASS1_CONCURRENCY'));
  const candidate = Number(bodyValue) || envValue || DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(50, candidate));
}

// ─── Core ────────────────────────────────────────────────────────────────────

async function runPass1(roundId: string, concurrency: number): Promise<Pass1RoundResult> {
  const started = Date.now();
  const admin = getAdminClient();
  const warnings: string[] = [];

  // 1. Round + project lookup, status guard.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) throw new Error(`round lookup failed: ${roundErr.message}`);
  if (!round) throw new Error(`round ${roundId} not found`);
  if (round.status !== 'processing') {
    throw new Error(
      `round ${roundId} status='${round.status}' — Pass 1 requires status='processing'`,
    );
  }
  const projectId: string = round.project_id;

  // 2. Enumerate compositions ready for Pass 1.
  const { data: ready, error: readyErr } = await admin
    .rpc('pass1_ready_compositions', { p_round_id: roundId });
  if (readyErr) throw new Error(`pass1_ready_compositions RPC failed: ${readyErr.message}`);

  // deno-lint-ignore no-explicit-any
  const compositions: ReadyComposition[] = (ready || []).map((row: any) => ({
    id: row.id,
    project_id: row.project_id,
    round_id: row.round_id,
    group_index: row.group_index,
    best_bracket_stem: row.best_bracket_stem,
    delivery_reference_stem: row.delivery_reference_stem,
    dropbox_preview_path: row.dropbox_preview_path,
  }));

  if (compositions.length === 0) {
    return {
      total_ready: 0,
      classifications_inserted: 0,
      failures: 0,
      cost_usd: 0,
      duration_ms: Date.now() - started,
      anchors_version: 0,
      warnings: ['no compositions ready for Pass 1 — check round status / Pass 0 completion'],
    };
  }

  // 3. Load Stream B anchors + build prompt.
  const anchors = await getActiveStreamBAnchors();
  const builtPrompt = buildPass1Prompt(anchors);
  // P8 follow-up: master_admin can override the system message via the
  // SettingsShortlistingPrompts admin page (mig 296 / promptLoader.ts).
  // If no DB override, builtPrompt.system applies.
  const dbSystem = await getActivePrompt('pass1_system');
  const prompt = dbSystem
    ? { ...builtPrompt, system: dbSystem.text }
    : builtPrompt;
  // Wave 7 P1-10 (W7.6): persist the block-version map per Pass 1 inference
  // so provenance is queryable downstream. When a DB system override is in
  // effect, the `header` slot reflects the override marker instead of the
  // built-in v1.0 baseline.
  const promptBlockVersions: Record<string, string> = { ...builtPrompt.blockVersions };
  if (dbSystem) promptBlockVersions['header'] = `db_override:${dbSystem.version ?? 'unknown'}`;

  // 4. Concurrent classification sweep.
  const results = await classifyAll(compositions, prompt, concurrency);

  // Audit defect #14: tag every per-run event with a unique pass1_run_id so
  // retries are filterable in shortlisting_events.
  const pass1RunId = crypto.randomUUID();

  // Audit defects #10 + #18: ORDER MATTERS. Previously the failure-rate guard
  // ran BEFORE persistence — when 20%+ failed, every successful classification
  // was thrown away (full Sonnet cost, zero rows inserted). Now we persist
  // successes FIRST, then evaluate the failure rate. On retry, the
  // pass1_ready_compositions RPC only returns the still-unclassified groups,
  // so we don't re-bill for the ones that already landed.
  const failures = results.filter((r) => r.error || !r.classification).length;
  const failureRate = failures / results.length;

  // 6. Persist classifications + log per-comp failure events.
  let inserted = 0;
  let totalCostUsd = 0;
  for (const r of results) {
    totalCostUsd += r.costUsd;
    if (r.error || !r.classification) {
      const { error: evtErr } = await admin
        .from('shortlisting_events')
        .insert({
          project_id: projectId,
          round_id: roundId,
          group_id: r.composition.id,
          event_type: 'pass1_classification_failed',
          actor_type: 'system',
          payload: {
            error: r.error || 'no classification returned',
            group_index: r.composition.group_index,
            stem: r.composition.best_bracket_stem,
            model: SONNET_MODEL,
            pass1_run_id: pass1RunId,
          },
        });
      if (evtErr) warnings.push(`failure-event insert failed for ${r.composition.id}: ${evtErr.message}`);
      continue;
    }

    const c = r.classification;
    const combined = (c.technical_score + c.lighting_score + c.composition_score + c.aesthetic_score) / 4;
    const eligibleExtRear =
      c.room_type === 'alfresco' && c.vantage_point === 'exterior_looking_in';

    // Audit defect #48: derive flag_for_retouching server-side from
    // clutter_severity rather than trusting Sonnet's flag. The contract
    // (per spec L13/§9): TRUE iff severity is minor_photoshoppable or
    // moderate_retouch; FALSE for none and major_reject (major_reject is
    // already excluded by Pass 3's filter, but consistency with the prompt
    // doc is what matters here). This eliminates the inconsistency between
    // the Pass 1 prompt's text and Pass 3's runtime filter.
    const derivedFlagForRetouching =
      c.clutter_severity === 'minor_photoshoppable' ||
      c.clutter_severity === 'moderate_retouch';

    const { error: insErr } = await admin
      .from('composition_classifications')
      .insert({
        group_id: r.composition.id,
        round_id: roundId,
        project_id: projectId,
        analysis: c.analysis,
        room_type: c.room_type,
        room_type_confidence: c.room_type_confidence,
        composition_type: c.composition_type,
        vantage_point: c.vantage_point,
        time_of_day: c.time_of_day,
        is_drone: c.is_drone,
        is_exterior: c.is_exterior,
        is_detail_shot: c.is_detail_shot,
        zones_visible: c.zones_visible,
        key_elements: c.key_elements,
        is_styled: c.is_styled,
        indoor_outdoor_visible: c.indoor_outdoor_visible,
        clutter_severity: c.clutter_severity,
        clutter_detail: c.clutter_detail,
        flag_for_retouching: derivedFlagForRetouching,
        technical_score: c.technical_score,
        lighting_score: c.lighting_score,
        composition_score: c.composition_score,
        aesthetic_score: c.aesthetic_score,
        combined_score: Math.round(combined * 100) / 100,
        eligible_for_exterior_rear: eligibleExtRear,
        is_near_duplicate_candidate: false, // Pass 2 sets this
        model_version: SONNET_MODEL,
        // Wave 7 P1-10 (W7.6): block-version provenance per migration 338.
        prompt_block_versions: promptBlockVersions,
      });

    if (insErr) {
      warnings.push(`classification insert failed for ${r.composition.id}: ${insErr.message}`);
    } else {
      inserted++;
    }
  }

  // 7. Round update — only Pass 1 cost. Status stays 'processing' until Pass 2.
  // Audit defect #5 sibling fix for Pass 1: accumulate cost across retries
  // rather than overwriting (Pass 1 retry-on-partial-failure scenario).
  const { data: priorRoundCost } = await admin
    .from('shortlisting_rounds')
    .select('pass1_cost_usd')
    .eq('id', roundId)
    .maybeSingle();
  const priorPass1Cost = typeof priorRoundCost?.pass1_cost_usd === 'number'
    ? priorRoundCost.pass1_cost_usd
    : 0;
  const accumulatedCost = priorPass1Cost + totalCostUsd;
  const roundedCost = Math.round(accumulatedCost * 1_000_000) / 1_000_000;
  const { error: roundUpdErr } = await admin
    .from('shortlisting_rounds')
    .update({ pass1_cost_usd: roundedCost })
    .eq('id', roundId);
  if (roundUpdErr) warnings.push(`round update failed: ${roundUpdErr.message}`);

  // Audit defects #10 + #18: failure-rate guard runs AFTER persistence so
  // successful classifications survive even when the overall run is judged
  // unhealthy. The dispatcher will retry; pass1_ready_compositions only
  // returns un-classified groups.
  if (failureRate > MAX_FAILURE_RATE) {
    const sampleErrors = results
      .filter((r) => r.error)
      .slice(0, 3)
      .map((r) => `comp ${r.composition.group_index}: ${r.error}`)
      .join('; ');
    throw new Error(
      `Pass 1 failure rate ${(failureRate * 100).toFixed(1)}% exceeds ${MAX_FAILURE_RATE * 100}% threshold ` +
        `(${failures}/${results.length}, ${inserted} successes persisted). Sample: ${sampleErrors}. Round retryable.`,
    );
  }

  // 8. pass1_complete event.
  const avgCombined = inserted > 0
    ? results
        .filter((r) => r.classification)
        .reduce((sum, r) => {
          const c = r.classification!;
          return sum + (c.technical_score + c.lighting_score + c.composition_score + c.aesthetic_score) / 4;
        }, 0) / inserted
    : null;

  const { error: evtErr } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: projectId,
      round_id: roundId,
      event_type: 'pass1_complete',
      actor_type: 'system',
      payload: {
        classifications_inserted: inserted,
        failures,
        total_ready: compositions.length,
        cost_usd: roundedCost,
        model_version: SONNET_MODEL,
        anchors_version: anchors.version,
        prompt_override_version: dbSystem?.version ?? null,
        average_combined_score: avgCombined != null ? Math.round(avgCombined * 100) / 100 : null,
        concurrency,
        pass1_run_id: pass1RunId,
      },
    });
  if (evtErr) warnings.push(`pass1_complete event insert failed: ${evtErr.message}`);

  return {
    total_ready: compositions.length,
    classifications_inserted: inserted,
    failures,
    cost_usd: roundedCost,
    duration_ms: Date.now() - started,
    anchors_version: anchors.version,
    warnings,
  };
}

// ─── Concurrent classification ───────────────────────────────────────────────

async function classifyAll(
  compositions: ReadyComposition[],
  prompt: { system: string; userPrefix: string },
  concurrency: number,
): Promise<ClassifyResult[]> {
  const results: ClassifyResult[] = new Array(compositions.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= compositions.length) return;
      results[i] = await classifyOne(compositions[i], prompt);
    }
  }

  const workerCount = Math.min(concurrency, compositions.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function classifyOne(
  comp: ReadyComposition,
  prompt: { system: string; userPrefix: string },
): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    composition: comp,
    classification: null,
    error: null,
    costUsd: 0,
  };

  if (!comp.dropbox_preview_path) {
    result.error = 'no preview path on group';
    return result;
  }

  let imageUrl: string;
  try {
    imageUrl = await getDropboxTempLink(comp.dropbox_preview_path);
  } catch (err) {
    result.error = `temp link failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  const messages: VisionMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: prompt.userPrefix },
      ],
    },
  ];

  try {
    const visionRes = await callClaudeVision({
      model: SONNET_MODEL,
      messages,
      system: prompt.system,
      max_tokens: SONNET_MAX_TOKENS,
      temperature: 0,
    });
    result.costUsd = visionRes.costUsd;
    const parsed = parsePass1Json(visionRes.content);
    if (!parsed.ok) {
      result.error = `parse failed: ${parsed.error} | first 200 chars: ${visionRes.content.slice(0, 200)}`;
      return result;
    }
    result.classification = parsed.value;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ─── JSON parsing + validation ──────────────────────────────────────────────

interface ParseSuccess { ok: true; value: Pass1Classification }
interface ParseFailure { ok: false; error: string }
type ParseResult = ParseSuccess | ParseFailure;

/**
 * Lenient JSON extractor — strips ``` fences and surrounding chatter that
 * Sonnet occasionally emits despite "ONLY valid JSON" instructions.
 * Validates all required fields are present + correctly typed before returning.
 */
function parsePass1Json(text: string): ParseResult {
  if (!text) return { ok: false, error: 'empty response' };
  let body = text.trim();

  // Burst 6 L2: Sonnet sometimes emits TWO fenced blocks — the analysis prose
  // wrapped in one fence, and the JSON output in another. The previous
  // (?:json)?\s*([\s\S]*?) regex was non-greedy and captured the FIRST fence,
  // which would be the analysis text. We now scan ALL fenced blocks and pick
  // the one whose contents look like a JSON object (contains `{`). Falls back
  // to the first fence (legacy behaviour) only if no JSON-looking fence found.
  const fenceMatches = Array.from(body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  if (fenceMatches.length > 0) {
    const jsonFence = fenceMatches.find((m) => m[1].includes('{'));
    body = (jsonFence ?? fenceMatches[0])[1].trim();
  }

  const braceStart = body.indexOf('{');
  const braceEnd = body.lastIndexOf('}');
  if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
    return { ok: false, error: 'no JSON object found' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.slice(braceStart, braceEnd + 1));
  } catch (err) {
    return { ok: false, error: `JSON.parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'parsed value is not an object' };
  }

  const missing = REQUIRED_JSON_FIELDS.filter((f) => !(f in parsed));
  if (missing.length > 0) {
    return { ok: false, error: `missing fields: ${missing.join(', ')}` };
  }

  // Coerce numerics + clamp scores to 0-10. Models occasionally emit
  // 9.5 as "9.5" string; tolerate both.
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isNaN(n)) return fallback;
    return Math.max(0, Math.min(10, n));
  };
  const conf = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
  };
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
  // Burst 6 L1: lenient boolean coercion. Sonnet usually emits true/false but
  // occasionally produces "true" (string), 1, "yes", "y". A strict v===true
  // check silently flips real-true values to false, corrupting downstream
  // logic — e.g. Pass 2 reads is_exterior to seed slot eligibility, so a
  // false-when-should-be-true breaks the entire interior/exterior separation.
  const bool = (v: unknown): boolean => {
    if (v === true) return true;
    if (v === false || v == null) return false;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === 'true' || s === 'yes' || s === 'y' || s === '1';
    }
    if (typeof v === 'number') return v === 1;
    return false;
  };
  const str = (v: unknown): string => typeof v === 'string' ? v : String(v ?? '');
  const strOrNull = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === 'string' && v.length === 0) return null;
    return typeof v === 'string' ? v : String(v);
  };

  const value: Pass1Classification = {
    analysis: str(parsed.analysis),
    room_type: str(parsed.room_type),
    room_type_confidence: conf(parsed.room_type_confidence),
    composition_type: str(parsed.composition_type),
    vantage_point: str(parsed.vantage_point),
    time_of_day: str(parsed.time_of_day),
    is_drone: bool(parsed.is_drone),
    is_exterior: bool(parsed.is_exterior),
    is_detail_shot: bool(parsed.is_detail_shot),
    zones_visible: arr(parsed.zones_visible),
    key_elements: arr(parsed.key_elements),
    is_styled: bool(parsed.is_styled),
    indoor_outdoor_visible: bool(parsed.indoor_outdoor_visible),
    clutter_severity: str(parsed.clutter_severity),
    clutter_detail: strOrNull(parsed.clutter_detail),
    flag_for_retouching: bool(parsed.flag_for_retouching),
    technical_score: num(parsed.technical_score, 0),
    lighting_score: num(parsed.lighting_score, 0),
    composition_score: num(parsed.composition_score, 0),
    aesthetic_score: num(parsed.aesthetic_score, 0),
  };

  // Sanity guard — analysis must be at least 3 chars (spec asks 3+ sentences).
  if (value.analysis.length < 30) {
    return { ok: false, error: `analysis too short (${value.analysis.length} chars)` };
  }

  // Burst 6 L3: reject when critical taxonomy fields coerced to empty string.
  // The REQUIRED_JSON_FIELDS check above only verifies key presence; a key
  // with `null` or `""` value still passes (`'room_type' in parsed === true`).
  // Pass 2's slot mapping then sees room_type='' and silently skips the
  // composition from every slot — the group ends up "undecided" with no
  // evidence in events. Better to fail here so the dispatcher retries.
  if (!value.room_type) {
    return { ok: false, error: 'room_type empty/null after coercion' };
  }
  if (!value.composition_type) {
    return { ok: false, error: 'composition_type empty/null after coercion' };
  }
  if (!value.vantage_point) {
    return { ok: false, error: 'vantage_point empty/null after coercion' };
  }
  if (!value.clutter_severity) {
    return { ok: false, error: 'clutter_severity empty/null after coercion' };
  }

  return { ok: true, value };
}
