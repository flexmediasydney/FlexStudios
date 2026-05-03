/**
 * shortlisting-detect-instances
 * ─────────────────────────────
 * W11.8 Phase 1 — Space Instance Clustering.
 *
 * Two physically-different rooms of the same `space_type` (e.g. downstairs vs
 * upstairs lounge, two kitchens in a duplex) currently look identical to the
 * engine. This edge fn introduces `space_instance_id` — a per-round identifier
 * shared by all composition_groups that depict the SAME PHYSICAL ROOM.
 *
 * Runs between Stage 1 and Stage 4 in the dispatcher chain.
 *
 *   extract → pass0 → shape_d_stage1 → detect_instances → stage4_synthesis
 *
 * ─── INPUTS ────────────────────────────────────────────────────────────────
 *
 *   { round_id }   — direct invocation (master_admin manual or backfill)
 *   { job_id }     — dispatcher path (looks up round_id from shortlisting_jobs)
 *   { _health_check: true } → 200 with version stamp
 *
 * ─── ALGORITHM ──────────────────────────────────────────────────────────────
 *
 * 1. Auth: service-role bypass + master_admin/admin/manager allowed.
 * 2. Load all composition_groups for the round joined with their latest
 *    composition_classifications. Filter to groups with a non-null space_type
 *    (groups without classification = ingest still in progress; return 409).
 * 3. Bucket by space_type.
 * 4. Skip space_types that don't need disambiguation:
 *      exterior_facade, floorplan, aerial_overhead, aerial_oblique, streetscape.
 *    For these, assign instance_index=1 to all groups + write a single
 *    shortlisting_space_instances row per space_type.
 * 5. For other space_types with N>=2 groups: run a SINGLE Gemini call per
 *    round (combining all bucketed space_types) to cluster the groups into
 *    physical-room instances.
 * 6. Persist clusters: one row per cluster in shortlisting_space_instances
 *    with instance_index assigned 1, 2, 3 ... by member-count desc; UPDATE
 *    composition_groups.space_instance_id + space_instance_confidence.
 * 7. Emit telemetry events:
 *      - space_instances_detected (always)
 *      - space_instance_low_confidence (per cluster with confidence < 0.5)
 *      - engine_vendor_failure (when Gemini call fails)
 * 8. On dispatcher path (job_id present), enqueue stage4_synthesis chain.
 *
 * ─── FAILURE MODES ──────────────────────────────────────────────────────────
 *
 * Per Joseph's instruction: NO Anthropic/OpenAI failover. A vendor failure
 * fails LOUD. The job goes to 'failed', the round status stays at the
 * Stage-1-complete value, and an engine_vendor_failure event fans out a
 * notification (mig 438 trigger).
 *
 * Spec: W11.8 backend rollout (Joseph signed off 2026-05-02).
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
  callVisionAdapter,
  estimateCost,
  MissingVendorCredential,
  VendorCallError,
  type VisionRequest,
} from '../_shared/visionAdapter/index.ts';
import { getDropboxAccessToken } from '../_shared/dropbox.ts';
import { tryAcquireMutex, releaseMutex } from '../_shared/dispatcherMutex.ts';

const GENERATOR = 'shortlisting-detect-instances';
const PRIMARY_VENDOR = 'google' as const;
const PRIMARY_MODEL = 'gemini-2.5-pro';
const DETECT_INSTANCES_THINKING_BUDGET = 4096;
const DETECT_INSTANCES_MAX_OUTPUT_TOKENS = 8000;
const DETECT_INSTANCES_TIMEOUT_MS = 120_000; // 2 min — fits in dispatcher's default 120s
const DETECT_INSTANCES_RETRY_COUNT = 3;
const PREVIEW_CONCURRENCY = 8;

// ─── Schema state-count discipline ──────────────────────────────────────────
// Gemini's responseSchema serving budget caps total state count. detect-
// instances has a small schema (one repeated cluster object with simple text
// fields) — ~30 states total, well under any threshold. No closed enums.

export const DETECT_INSTANCES_VERSION = 'v1.0';
const DETECT_INSTANCES_TOOL_NAME = 'cluster_space_instances';

const DETECT_INSTANCES_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    schema_version: {
      type: 'string',
      description: `Echo "${DETECT_INSTANCES_VERSION}".`,
    },
    clusters: {
      type: 'array',
      description:
        'One entry per detected physical-room INSTANCE. For space_types with ' +
        'only one bucketed group, a single cluster covers it. For space_types ' +
        'with multiple distinct rooms (e.g. duplex with two kitchens), emit ' +
        'one cluster per distinct room. Sort the clusters within each ' +
        'space_type by member count descending (the cluster with the most ' +
        'groups goes first), then by best-image score descending — this drives ' +
        'instance_index assignment downstream (1 = largest cluster).',
      items: {
        type: 'object',
        properties: {
          space_type: {
            type: 'string',
            description:
              'Echo the space_type bucket this cluster belongs to. Must match ' +
              'the space_type values in the input groups list.',
          },
          instance_label: {
            type: 'string',
            description:
              'Operator-readable label, auto-suggested. Format: "<Space type>" ' +
              'for the largest cluster, "<Space type> 2" for the second, ' +
              'etc. For granny-flat or duplex distinguishing context, use ' +
              'qualifying noun phrases e.g. "Granny flat living", "Upstairs ' +
              'master". Operator can rename later via the audit panel.',
          },
          distinctive_features: {
            type: 'array',
            description:
              'Up to 5 short noun phrases naming the visual features that ' +
              'identify THIS instance vs the others. Cite specific things: ' +
              '"raked timber ceiling", "stone fireplace wall", "navy feature ' +
              'wall". Empty array when there is only one cluster of this ' +
              'space_type.',
            items: { type: 'string' },
          },
          dominant_colors: {
            type: 'array',
            description:
              'Up to 3 dominant colors with role attribution. Helps the audit ' +
              'panel visualise instance signatures. Empty array when not ' +
              'meaningful.',
            items: {
              type: 'object',
              properties: {
                hex: {
                  type: 'string',
                  description: 'Lowercase #rrggbb (no alpha).',
                },
                role: {
                  type: 'string',
                  description:
                    'One of "primary", "secondary", "accent" — open-text, no ' +
                    'closed enum. Used as a UI hint.',
                },
              },
              required: ['hex', 'role'],
            },
          },
          group_ids: {
            type: 'array',
            description:
              'composition_groups.id values that belong to this cluster. ' +
              'MUST be a subset of the input group IDs for this space_type ' +
              'bucket. Each input group_id appears in EXACTLY ONE cluster ' +
              'across the response.',
            items: { type: 'string' },
          },
          cluster_confidence: {
            type: 'number',
            description:
              '0-1 confidence the cluster is internally consistent (all ' +
              'groups truly depict the same physical room). 0.9+ = strong ' +
              'visual signature lock. 0.5-0.8 = plausible but mixed evidence. ' +
              '<0.5 = best guess; the audit panel will surface a low-' +
              'confidence event for operator review.',
          },
        },
        required: ['space_type', 'instance_label', 'group_ids', 'cluster_confidence'],
      },
    },
  },
  required: ['schema_version', 'clusters'],
};

// Space types where 2+ groups never need disambiguation — they're either
// single-instance by physics (the property has ONE facade, ONE floorplan) or
// the visual signature is too unique to bucket (an aerial overhead can't be
// "another aerial overhead" of the same property).
const SKIP_DISAMBIGUATION_SPACE_TYPES = new Set([
  'exterior_facade',
  'floorplan',
  'aerial_overhead',
  'aerial_oblique',
  'streetscape',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  _health_check?: boolean;
}

interface CompositionRow {
  group_id: string;
  group_index: number;
  stem: string;
  space_type: string | null;
  zone_focus: string | null;
  technical_score: number | null;
  aesthetic_score: number | null;
  composition_score: number | null;
  delivery_reference_stem: string | null;
  best_bracket_stem: string | null;
  dropbox_preview_path: string | null;
}

interface RoundContext {
  round_id: string;
  project_id: string;
  /** Full Dropbox root path for the project. Retained for diagnostic logging
   *  + future use; preview fetches use composition_groups.dropbox_preview_path
   *  directly so the per-stem path is whatever the ingest stage wrote. */
  dropbox_root_path: string;
}

interface DetectedCluster {
  space_type: string;
  instance_label: string;
  distinctive_features: string[];
  dominant_colors: Array<{ hex: string; role: string }>;
  group_ids: string[];
  cluster_confidence: number;
}

interface DetectInstancesResult {
  ok: boolean;
  round_id: string;
  n_instances_detected: number;
  n_groups_clustered: number;
  cost_usd: number;
  wall_ms: number;
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
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse({ _version: DETECT_INSTANCES_VERSION, _fn: GENERATOR }, 200, req);
  }

  let roundId = body.round_id || null;
  const jobId = body.job_id || null;
  if (jobId) {
    const admin = getAdminClient();
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('round_id')
      .eq('id', jobId)
      .maybeSingle();
    if (job?.round_id && !roundId) roundId = job.round_id as string;
  }
  if (!roundId) return errorResponse('round_id (or job_id) required', 400, req);

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

  const startedAt = Date.now();
  const admin = getAdminClient();

  // Per-round mutex so two concurrent dispatcher ticks can't both run
  // detect_instances on the same round and double-write space_instances rows.
  const lockName = `detect-instances:${roundId}`;
  const tickId = crypto.randomUUID();
  const acquired = await tryAcquireMutex(admin, lockName, tickId);
  if (!acquired) {
    return errorResponse(
      `round ${roundId} detect_instances already running (mutex held)`,
      409,
      req,
    );
  }

  try {
    const result = await runDetectInstances(roundId, jobId, startedAt);
    return jsonResponse(result, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for round ${roundId}: ${msg}`);
    return errorResponse(`detect_instances failed: ${msg}`, 502, req);
  } finally {
    await releaseMutex(admin, lockName, tickId).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] mutex release failed: ${m}`);
    });
  }
});

// ─── Core ───────────────────────────────────────────────────────────────────

async function runDetectInstances(
  roundId: string,
  jobId: string | null,
  startedAt: number,
): Promise<DetectInstancesResult> {
  const admin = getAdminClient();
  const warnings: string[] = [];

  // Load round + project context.
  const ctx = await loadRoundContext(admin, roundId);

  // Load groups + classifications for the round.
  const compositions = await loadCompositions(admin, roundId);
  if (compositions.length === 0) {
    throw new Error(
      `round ${roundId} has no composition_groups with composition_classifications — Stage 1 must complete first`,
    );
  }

  const groupsWithSpaceType = compositions.filter((c) => !!c.space_type);
  if (groupsWithSpaceType.length === 0) {
    throw new Error(
      `round ${roundId} has no groups with non-null space_type — Stage 1 may have failed`,
    );
  }
  if (groupsWithSpaceType.length < compositions.length) {
    warnings.push(
      `round ${roundId} has ${compositions.length - groupsWithSpaceType.length}/${compositions.length} groups with NULL space_type — they will be excluded from clustering`,
    );
  }

  // Bucket by space_type.
  const buckets = new Map<string, CompositionRow[]>();
  for (const c of groupsWithSpaceType) {
    const st = c.space_type as string;
    const arr = buckets.get(st) ?? [];
    arr.push(c);
    buckets.set(st, arr);
  }

  // Phase 1: trivial buckets (single-group OR skip-disambiguation list).
  // These produce instance_index=1 for all members without an LLM call.
  const trivialClusters: DetectedCluster[] = [];
  // Phase 2: LLM-clustered buckets — multi-group buckets of disambiguatable
  // space_types.
  const llmBuckets = new Map<string, CompositionRow[]>();

  for (const [spaceType, groups] of buckets.entries()) {
    if (SKIP_DISAMBIGUATION_SPACE_TYPES.has(spaceType) || groups.length === 1) {
      trivialClusters.push({
        space_type: spaceType,
        instance_label: humanLabelFromSpaceType(spaceType),
        distinctive_features: [],
        dominant_colors: [],
        group_ids: groups.map((g) => g.group_id),
        cluster_confidence: 1.0,
      });
    } else {
      llmBuckets.set(spaceType, groups);
    }
  }

  // LLM clustering (one Gemini call covering all multi-group buckets).
  let llmClusters: DetectedCluster[] = [];
  let costUsd = 0;
  if (llmBuckets.size > 0) {
    const { clusters, cost_usd, warnings: callWarnings } = await runLlmClustering({
      ctx,
      buckets: llmBuckets,
    });
    llmClusters = clusters;
    costUsd = cost_usd;
    for (const w of callWarnings) warnings.push(w);
  }

  // Persist all clusters.
  const allClusters = [...trivialClusters, ...llmClusters];
  const persisted = await persistClusters({
    admin,
    ctx,
    clusters: allClusters,
    warnings,
  });

  // Telemetry — always emit space_instances_detected.
  const wallMs = Date.now() - startedAt;
  try {
    await admin.from('shortlisting_events').insert({
      project_id: ctx.project_id,
      round_id: roundId,
      group_id: null,
      event_type: 'space_instances_detected',
      actor_type: 'engine',
      actor_id: null,
      payload: {
        n_instances: persisted.instancesPersisted,
        n_groups_clustered: persisted.groupsUpdated,
        n_buckets_trivial: trivialClusters.length,
        n_buckets_llm: llmClusters.length,
        total_wall_ms: wallMs,
        cost_usd: costUsd,
        failover_triggered: false,
      },
    });
  } catch (evtErr) {
    const m = evtErr instanceof Error ? evtErr.message : String(evtErr);
    warnings.push(`space_instances_detected event insert failed: ${m}`);
  }

  // Per-cluster low-confidence event emission.
  for (const c of allClusters) {
    if (c.cluster_confidence < 0.5) {
      try {
        await admin.from('shortlisting_events').insert({
          project_id: ctx.project_id,
          round_id: roundId,
          group_id: null,
          event_type: 'space_instance_low_confidence',
          actor_type: 'engine',
          actor_id: null,
          payload: {
            space_type: c.space_type,
            instance_label: c.instance_label,
            cluster_confidence: c.cluster_confidence,
            member_group_count: c.group_ids.length,
            distinctive_features: c.distinctive_features,
          },
        });
      } catch (evtErr) {
        const m = evtErr instanceof Error ? evtErr.message : String(evtErr);
        warnings.push(`space_instance_low_confidence event insert failed: ${m}`);
      }
    }
  }

  // Dispatcher chain — enqueue stage4_synthesis when this was kicked from a
  // detect_instances job.
  if (jobId) {
    await dispatchStage4Job({
      admin,
      projectId: ctx.project_id,
      roundId,
      warnings,
    });
  }

  return {
    ok: true,
    round_id: roundId,
    n_instances_detected: persisted.instancesPersisted,
    n_groups_clustered: persisted.groupsUpdated,
    cost_usd: costUsd,
    wall_ms: wallMs,
    warnings,
  };
}

// ─── Load ────────────────────────────────────────────────────────────────────

async function loadRoundContext(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<RoundContext> {
  const { data: round, error: rErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id')
    .eq('id', roundId)
    .maybeSingle();
  if (rErr) throw new Error(`round load failed: ${rErr.message}`);
  if (!round) throw new Error(`round ${roundId} not found`);

  // Two-query pattern (mirrors shortlisting-shape-d-stage4) — PostgREST has
  // multiple inferred relationships between shortlisting_rounds and projects
  // (the FK + the auto-detected join via project_id), which makes a nested
  // .select('projects(...)') ambiguous.
  const { data: proj, error: pErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path')
    .eq('id', round.project_id)
    .maybeSingle();
  if (pErr) throw new Error(`project lookup failed: ${pErr.message}`);
  if (!proj) throw new Error(`project ${round.project_id} not found`);
  const dropboxRootPath = (proj.dropbox_root_path as string | null) ?? '';
  return {
    round_id: round.id as string,
    project_id: round.project_id as string,
    dropbox_root_path: dropboxRootPath,
  };
}

async function loadCompositions(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<CompositionRow[]> {
  // Two-query pattern (mirrors the proven fetch shape used by other shortlisting
  // edge fns): load groups + classifications separately and join in-memory.
  // Avoids PostgREST embed quirks that surfaced as missing classifications on
  // the embedded array even with service-role auth.
  const { data: groups, error: gErr } = await admin
    .from('composition_groups')
    .select(
      'id, group_index, delivery_reference_stem, best_bracket_stem, dropbox_preview_path',
    )
    .eq('round_id', roundId)
    .order('group_index');
  if (gErr) throw new Error(`composition_groups load failed: ${gErr.message}`);

  const groupRows = (groups || []) as Array<Record<string, unknown>>;
  if (groupRows.length === 0) return [];

  const groupIds = groupRows.map((r) => r.id as string);
  const { data: classifications, error: cErr } = await admin
    .from('composition_classifications')
    .select(
      'group_id, space_type, zone_focus, technical_score, aesthetic_score, composition_score',
    )
    .in('group_id', groupIds);
  if (cErr) throw new Error(`composition_classifications load failed: ${cErr.message}`);

  const byGroupId = new Map<string, Record<string, unknown>>();
  for (const c of (classifications || []) as Array<Record<string, unknown>>) {
    byGroupId.set(c.group_id as string, c);
  }

  const out: CompositionRow[] = [];
  for (const row of groupRows) {
    const cls = byGroupId.get(row.id as string) || null;
    const stem = (row.delivery_reference_stem as string | null)
      || (row.best_bracket_stem as string | null)
      || stemFromPath(row.dropbox_preview_path as string | null)
      || `group_${row.group_index ?? '?'}`;
    out.push({
      group_id: row.id as string,
      group_index: (row.group_index as number) ?? 0,
      stem,
      space_type: (cls?.space_type as string | null) ?? null,
      zone_focus: (cls?.zone_focus as string | null) ?? null,
      technical_score: (cls?.technical_score as number | null) ?? null,
      aesthetic_score: (cls?.aesthetic_score as number | null) ?? null,
      composition_score: (cls?.composition_score as number | null) ?? null,
      delivery_reference_stem: (row.delivery_reference_stem as string | null) ?? null,
      best_bracket_stem: (row.best_bracket_stem as string | null) ?? null,
      dropbox_preview_path: (row.dropbox_preview_path as string | null) ?? null,
    });
  }
  return out;
}

function stemFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const tail = path.split('/').pop();
  if (!tail) return null;
  return tail.replace(/\.[^.]+$/, '');
}

// ─── Preview fetcher (Dropbox) ──────────────────────────────────────────────

async function fetchAllPreviewsByPath(
  stemToPath: Map<string, string>,
): Promise<Map<string, { data: string; media_type: string }>> {
  const out = new Map<string, { data: string; media_type: string }>();
  const entries = Array.from(stemToPath.entries());
  for (let i = 0; i < entries.length; i += PREVIEW_CONCURRENCY) {
    const slice = entries.slice(i, i + PREVIEW_CONCURRENCY);
    const fetched = await Promise.all(slice.map(async ([stem, path]) => {
      try {
        const p = await fetchPreviewBase64(path);
        return { stem, data: p.data, media_type: p.media_type };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] preview ${stem} fetch failed: ${msg}`);
        return null;
      }
    }));
    for (const r of fetched) {
      if (r) out.set(r.stem, { data: r.data, media_type: r.media_type });
    }
  }
  return out;
}

async function fetchPreviewBase64(
  dropboxPath: string,
): Promise<{ data: string; media_type: string }> {
  const token = await getDropboxAccessToken();
  const ns = Deno.env.get('DROPBOX_TEAM_NAMESPACE_ID');
  const pathRootHeader: Record<string, string> = ns
    ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: ns }) }
    : {};
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      ...pathRootHeader,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`dropbox download ${res.status}: ${txt.slice(0, 200)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  const data = btoa(bin);
  return { data, media_type: 'image/jpeg' };
}

// ─── LLM clustering ─────────────────────────────────────────────────────────

interface RunLlmClusteringArgs {
  ctx: RoundContext;
  buckets: Map<string, CompositionRow[]>;
}

interface RunLlmClusteringResult {
  clusters: DetectedCluster[];
  cost_usd: number;
  warnings: string[];
}

async function runLlmClustering(
  args: RunLlmClusteringArgs,
): Promise<RunLlmClusteringResult> {
  const warnings: string[] = [];
  // Collect every group across all multi-group buckets.
  const allGroups: CompositionRow[] = [];
  for (const groups of args.buckets.values()) allGroups.push(...groups);

  // Fetch one preview per group using composition_groups.dropbox_preview_path
  // (the canonical path source — the preview filename is keyed off
  // best_bracket_stem, not delivery_reference_stem).
  const stemToPath = new Map<string, string>();
  for (const g of allGroups) {
    if (g.dropbox_preview_path) stemToPath.set(g.stem, g.dropbox_preview_path);
  }
  const previews = await fetchAllPreviewsByPath(stemToPath);
  if (previews.size === 0) {
    throw new Error(
      `detect_instances fetched zero previews for round ${args.ctx.round_id}`,
    );
  }
  if (previews.size < allGroups.length) {
    warnings.push(
      `detect_instances fetched ${previews.size}/${allGroups.length} previews — proceeding with partial set`,
    );
  }

  // Build the prompt.
  const systemText = buildDetectInstancesSystem();
  const userText = buildDetectInstancesUser({
    buckets: args.buckets,
    previewStems: Array.from(previews.keys()),
  });

  // Build the images array — only include groups whose preview successfully
  // fetched. We pass them in deterministic stem order so the model can correlate.
  const previewStemsOrdered = allGroups
    .map((g) => g.stem)
    .filter((s) => previews.has(s));
  const images = previewStemsOrdered.map((s) => {
    const p = previews.get(s)!;
    return {
      source_type: 'base64' as const,
      media_type: p.media_type,
      data: p.data,
    };
  });

  const baseReq: VisionRequest = {
    vendor: PRIMARY_VENDOR,
    model: PRIMARY_MODEL,
    tool_name: DETECT_INSTANCES_TOOL_NAME,
    tool_input_schema: DETECT_INSTANCES_TOOL_SCHEMA,
    system: systemText,
    user_text: userText,
    images,
    max_output_tokens: DETECT_INSTANCES_MAX_OUTPUT_TOKENS,
    temperature: 0,
    thinking_budget: DETECT_INSTANCES_THINKING_BUDGET,
    timeout_ms: DETECT_INSTANCES_TIMEOUT_MS,
  };

  const start = Date.now();
  let lastErr: string | null = null;
  let lastVendorStatus: number | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= DETECT_INSTANCES_RETRY_COUNT; attempt++) {
    attempts = attempt;
    try {
      const resp = await callVisionAdapter(baseReq);
      const output = resp.output as Record<string, unknown>;
      const rawClusters = (output.clusters as Array<Record<string, unknown>> | undefined) || [];
      const clusters = rawClusters
        .map((c) => normaliseCluster(c, args.buckets))
        .filter((c): c is DetectedCluster => c !== null);
      return {
        clusters,
        cost_usd: resp.usage.estimated_cost_usd,
        warnings,
      };
    } catch (e) {
      if (e instanceof MissingVendorCredential) {
        await emitVendorFailure(args.ctx, {
          status: null,
          message: e.message,
          attempt,
          requestSizeBytesApprox: JSON.stringify(baseReq).length,
        });
        throw new Error(`detect_instances credentials missing: ${e.message}`);
      }
      if (e instanceof VendorCallError) {
        lastErr = `${e.vendor}/${e.model} ${e.status ?? ''}: ${e.message}`;
        lastVendorStatus = typeof e.status === 'number' ? e.status : null;
      } else {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      console.warn(
        `[${GENERATOR}] attempt ${attempt}/${DETECT_INSTANCES_RETRY_COUNT} failed: ${lastErr}`,
      );
      if (attempt < DETECT_INSTANCES_RETRY_COUNT) {
        await new Promise((r) => setTimeout(r, 2_000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // Exhausted retries — emit observability event and throw (no failover).
  await emitVendorFailure(args.ctx, {
    status: lastVendorStatus,
    message: lastErr ?? 'unknown',
    attempt: attempts,
    requestSizeBytesApprox: JSON.stringify(baseReq).length,
  });
  throw new Error(
    `detect_instances Gemini call exhausted ${DETECT_INSTANCES_RETRY_COUNT} retries: ${lastErr ?? 'unknown'}`,
  );
}

interface VendorFailureArgs {
  status: number | null;
  message: string;
  attempt: number;
  requestSizeBytesApprox: number;
}

async function emitVendorFailure(
  ctx: RoundContext,
  args: VendorFailureArgs,
): Promise<void> {
  const admin = getAdminClient();
  const codeMatch = /"code"\s*:\s*"([A-Z_]+)"/.exec(args.message)
    || /"code"\s*:\s*(\d+)/.exec(args.message);
  const geminiErrorCode = codeMatch ? codeMatch[1] : null;
  try {
    await admin.from('shortlisting_events').insert({
      project_id: ctx.project_id,
      round_id: ctx.round_id,
      group_id: null,
      event_type: 'engine_vendor_failure',
      actor_type: 'engine',
      actor_id: null,
      payload: {
        stage: 'detect_instances',
        vendor: PRIMARY_VENDOR,
        model: PRIMARY_MODEL,
        status_code: args.status,
        gemini_error_code: geminiErrorCode,
        gemini_error_message_excerpt: args.message.slice(0, 600),
        attempt_count: args.attempt,
        request_size_bytes_approx: args.requestSizeBytesApprox,
      },
    });
  } catch (evtErr) {
    const m = evtErr instanceof Error ? evtErr.message : String(evtErr);
    console.warn(`[${GENERATOR}] engine_vendor_failure event insert failed: ${m}`);
  }
}

// Validate + filter Gemini's cluster object shape.
function normaliseCluster(
  raw: Record<string, unknown>,
  buckets: Map<string, CompositionRow[]>,
): DetectedCluster | null {
  const spaceType = typeof raw.space_type === 'string' ? raw.space_type : null;
  if (!spaceType || !buckets.has(spaceType)) return null;
  const bucketGroupIds = new Set(buckets.get(spaceType)!.map((g) => g.group_id));
  const rawIds = Array.isArray(raw.group_ids) ? (raw.group_ids as unknown[]) : [];
  const groupIds = rawIds
    .filter((g): g is string => typeof g === 'string' && bucketGroupIds.has(g));
  if (groupIds.length === 0) return null;
  const confidence = typeof raw.cluster_confidence === 'number'
    ? Math.max(0, Math.min(1, raw.cluster_confidence))
    : 0;
  const label = typeof raw.instance_label === 'string' && raw.instance_label.length > 0
    ? raw.instance_label
    : humanLabelFromSpaceType(spaceType);
  const distinctiveFeatures = Array.isArray(raw.distinctive_features)
    ? (raw.distinctive_features as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 5)
    : [];
  const dominantColors = Array.isArray(raw.dominant_colors)
    ? (raw.dominant_colors as unknown[])
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          hex: typeof c.hex === 'string' ? c.hex : '',
          role: typeof c.role === 'string' ? c.role : 'primary',
        }))
        .filter((c) => c.hex.length > 0)
        .slice(0, 3)
    : [];
  return {
    space_type: spaceType,
    instance_label: label,
    distinctive_features: distinctiveFeatures,
    dominant_colors: dominantColors,
    group_ids: groupIds,
    cluster_confidence: confidence,
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

interface PersistClustersArgs {
  admin: ReturnType<typeof getAdminClient>;
  ctx: RoundContext;
  clusters: DetectedCluster[];
  warnings: string[];
}

interface PersistClustersResult {
  instancesPersisted: number;
  groupsUpdated: number;
}

async function persistClusters(
  args: PersistClustersArgs,
): Promise<PersistClustersResult> {
  // Idempotency: clear prior space_instances for this round + reset
  // composition_groups.space_instance_id back to NULL. detect_instances may be
  // re-fired (operator backfill, retry).
  await args.admin
    .from('shortlisting_space_instances')
    .delete()
    .eq('round_id', args.ctx.round_id);

  await args.admin
    .from('composition_groups')
    .update({ space_instance_id: null, space_instance_confidence: null })
    .eq('round_id', args.ctx.round_id);

  if (args.clusters.length === 0) {
    return { instancesPersisted: 0, groupsUpdated: 0 };
  }

  // Group clusters by space_type, sort within space_type by member-count desc,
  // and assign instance_index 1, 2, 3 ... within each bucket.
  const bySpaceType = new Map<string, DetectedCluster[]>();
  for (const c of args.clusters) {
    const arr = bySpaceType.get(c.space_type) ?? [];
    arr.push(c);
    bySpaceType.set(c.space_type, arr);
  }
  const orderedClusters: Array<DetectedCluster & { instance_index: number; display_label: string }> = [];
  for (const [spaceType, clusters] of bySpaceType.entries()) {
    clusters.sort((a, b) => b.group_ids.length - a.group_ids.length);
    let idx = 1;
    for (const c of clusters) {
      const display = clusters.length === 1
        ? humanLabelFromSpaceType(spaceType)
        : (c.instance_label || (idx === 1 ? humanLabelFromSpaceType(spaceType) : `${humanLabelFromSpaceType(spaceType)} ${idx}`));
      orderedClusters.push({ ...c, instance_index: idx, display_label: display });
      idx++;
    }
  }

  // Insert space_instances rows. Capture returned ids so we can update
  // composition_groups.space_instance_id.
  const rowsToInsert = orderedClusters.map((c) => ({
    round_id: args.ctx.round_id,
    project_id: args.ctx.project_id,
    space_type: c.space_type,
    instance_index: c.instance_index,
    display_label: c.display_label,
    display_label_source: 'auto_derived',
    dominant_colors: c.dominant_colors,
    distinctive_features: c.distinctive_features,
    representative_group_id: c.group_ids[0] ?? null,
    member_group_count: c.group_ids.length,
    member_group_ids: c.group_ids,
    cluster_confidence: c.cluster_confidence,
  }));

  const { data: inserted, error: insErr } = await args.admin
    .from('shortlisting_space_instances')
    .insert(rowsToInsert)
    .select('id, space_type, instance_index, member_group_ids, cluster_confidence');
  if (insErr) {
    args.warnings.push(`shortlisting_space_instances insert failed: ${insErr.message}`);
    return { instancesPersisted: 0, groupsUpdated: 0 };
  }

  // Update composition_groups.space_instance_id for all member groups.
  let groupsUpdated = 0;
  for (const row of (inserted || []) as Array<Record<string, unknown>>) {
    const id = row.id as string;
    const memberIds = (row.member_group_ids as string[] | null) ?? [];
    const confidence = (row.cluster_confidence as number | null) ?? null;
    if (memberIds.length === 0) continue;
    const { error: updErr } = await args.admin
      .from('composition_groups')
      .update({
        space_instance_id: id,
        space_instance_confidence: confidence,
      })
      .in('id', memberIds);
    if (updErr) {
      args.warnings.push(
        `composition_groups update for instance ${id} failed: ${updErr.message}`,
      );
      continue;
    }
    groupsUpdated += memberIds.length;
  }

  return {
    instancesPersisted: (inserted || []).length,
    groupsUpdated,
  };
}

// ─── Stage 4 dispatch (chain on success) ────────────────────────────────────

interface DispatchStage4Args {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  roundId: string;
  warnings: string[];
}

async function dispatchStage4Job(args: DispatchStage4Args): Promise<void> {
  // Idempotency: skip if a non-terminal stage4_synthesis job already exists.
  const { count: existing } = await args.admin
    .from('shortlisting_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('round_id', args.roundId)
    .eq('kind', 'stage4_synthesis')
    .in('status', ['pending', 'running', 'succeeded']);
  if ((existing ?? 0) > 0) {
    console.log(
      `[${GENERATOR}] stage4_synthesis job already exists for round ${args.roundId} — skipping insert`,
    );
    return;
  }

  const { error } = await args.admin.from('shortlisting_jobs').insert({
    project_id: args.projectId,
    round_id: args.roundId,
    group_id: null,
    kind: 'stage4_synthesis',
    status: 'pending',
    payload: {
      project_id: args.projectId,
      round_id: args.roundId,
      chained_from: GENERATOR,
    },
    scheduled_for: new Date().toISOString(),
  });
  if (error) {
    args.warnings.push(`stage4_synthesis dispatch failed: ${error.message}`);
    return;
  }
  console.log(`[${GENERATOR}] dispatched stage4_synthesis for round ${args.roundId}`);
}

// ─── Prompt builders ────────────────────────────────────────────────────────

export function buildDetectInstancesSystem(): string {
  return [
    'You are a senior architectural photo editor identifying physically-distinct',
    'rooms within a single property shoot.',
    '',
    'TASK',
    'You will receive composition_groups grouped by space_type. For each',
    "space_type bucket with 2+ groups, cluster the groups into distinct PHYSICAL",
    'INSTANCES of that space_type.',
    '',
    'Two groups belong to the SAME instance if they are different ANGLES of the',
    'SAME PHYSICAL ROOM. They belong to DIFFERENT instances if they show',
    'DIFFERENT PHYSICAL ROOMS.',
    '',
    'Visual signals to use:',
    '- Wall colour + material (paint, panelling, tile)',
    '- Floor material (carpet, timber, tile, polished concrete)',
    '- Ceiling height + treatment (vaulted, beamed, flat, raked)',
    '- Distinctive features (specific fireplace, feature wall, view out window)',
    '- Furniture + styling palette',
    '- Lighting fixtures (a specific pendant uniquely identifies a room)',
    '',
    'Multi-dwelling properties (duplex, granny flat) commonly have 2 sets of',
    'hero spaces (2 kitchens, 2 master bedrooms). Trust the visual signature —',
    'different finishes/palettes = different physical rooms.',
    '',
    'OUTPUT DISCIPLINE',
    '- Every input group_id MUST appear in exactly ONE cluster.',
    '- Sort clusters within each space_type by member count DESCENDING (largest',
    '  cluster first), then by best-image score within the cluster.',
    '- Single-cluster space_types: emit ONE cluster with all groups; label as',
    '  the plain space_type ("Living room"). Empty distinctive_features array.',
    '- Multi-cluster space_types: number suffix the labels ("Living room",',
    '  "Living room 2"). Use qualifying noun phrases for granny-flat / duplex',
    '  contexts when the visual evidence supports it ("Granny flat living").',
    '- cluster_confidence: 0.9+ for strong visual signature locks; 0.5-0.8 for',
    '  plausible-but-mixed; <0.5 for best guesses (operator review will follow).',
    '',
    'Return ONE JSON object matching the schema in the user prompt.',
  ].join('\n');
}

export function buildDetectInstancesUser(opts: {
  buckets: Map<string, CompositionRow[]>;
  previewStems: string[];
}): string {
  const lines: string[] = [];
  lines.push('── COMPOSITION GROUPS GROUPED BY space_type ──');
  lines.push('Each group = one composition. Cluster groups into physical-room');
  lines.push('instances within each space_type bucket. The IMAGE PREVIEWS that');
  lines.push('follow are in the order the stems appear in the bucket lists below.');
  lines.push('');
  for (const [spaceType, groups] of opts.buckets.entries()) {
    lines.push(`── space_type=${spaceType} (${groups.length} groups) ──`);
    for (const g of groups) {
      const scoreBits: string[] = [];
      if (g.technical_score !== null) scoreBits.push(`tech=${g.technical_score.toFixed(1)}`);
      if (g.aesthetic_score !== null) scoreBits.push(`aes=${g.aesthetic_score.toFixed(1)}`);
      if (g.composition_score !== null) scoreBits.push(`comp=${g.composition_score.toFixed(1)}`);
      const zone = g.zone_focus ? ` zone_focus=${g.zone_focus}` : '';
      const scores = scoreBits.length ? ` [${scoreBits.join(' ')}]` : '';
      lines.push(`  group_id=${g.group_id} stem=${g.stem}${zone}${scores}`);
    }
    lines.push('');
  }
  lines.push('── IMAGE PREVIEWS (in this stem order) ──');
  lines.push(opts.previewStems.join(', '));
  lines.push('');
  lines.push('── REQUIRED OUTPUT ──');
  lines.push('Return ONE JSON object matching the cluster_space_instances schema.');
  lines.push('clusters[]: one entry per detected physical-room instance.');
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function humanLabelFromSpaceType(spaceType: string): string {
  const cleaned = spaceType.replace(/_/g, ' ').trim();
  if (cleaned.length === 0) return spaceType;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Exports for tests.
export {
  loadCompositions,
  loadRoundContext,
  normaliseCluster,
  persistClusters,
  runDetectInstances,
  SKIP_DISAMBIGUATION_SPACE_TYPES,
};
