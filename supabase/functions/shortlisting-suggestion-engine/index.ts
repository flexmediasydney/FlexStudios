/**
 * shortlisting-suggestion-engine — Wave 12.7-12.8 manual-trigger edge fn.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Aggregates engine telemetry into two suggestion lists for master_admin
 * review:
 *
 *   1. shortlisting_slot_suggestions
 *      - Source 1: pass2_slot_suggestion events (>= 5 distinct rounds in
 *        90 days, slot_id not currently active in shortlisting_slot_definitions)
 *      - Source 2 (W12.8 NEW): object_registry rows with market_frequency
 *        >= 20 whose canonical_label / canonical_id is not anchored as an
 *        eligible_room_type on any active slot. Surfaces as a "consider a
 *        new slot" hint.
 *
 *   2. shortlisting_room_type_suggestions
 *      - Source 1 (forced_fallback): >= 5 high-confidence (>=0.7) free-text
 *        room_types in composition_classifications in 90 days that aren't in
 *        shortlisting_room_types.
 *      - Source 2 (key_elements_cluster): >= 8 distinct rounds in 120 days
 *        sharing >= 75% key_element overlap, no existing room_type fit.
 *      - Source 3 (override_pattern): >= 5 confirmed-with-review overrides
 *        in 90 days targeting a key_element pattern not represented in any
 *        active slot's eligible_room_types.
 *
 * POST body:
 *   {
 *     days_back?: number,        // window for slot/forced/override sources (default 90)
 *     cluster_days_back?: number, // window for key_elements_cluster (default 120)
 *     dry_run?: boolean,         // when true, returns suggestions but skips upserts
 *     include_registry_proposals?: boolean // default true; set false to skip W12.8 source
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     dry_run,
 *     window_days: { slot, cluster },
 *     slot_suggestions: SlotSuggestion[],
 *     room_type_suggestions: RoomTypeSuggestion[],
 *     upserts: { slot_suggestions: n, room_type_suggestions: n },
 *     cost_attribution: { ... },
 *     elapsed_ms,
 *   }
 *
 * Auth: master_admin only (or service_role for cross-fn calls).
 * Cost: zero (pure DB read + write; no LLM / embedding spend).
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import {
  buildSlotSuggestionsFromEvents,
  buildSlotSuggestionsFromRegistry,
  buildRoomTypeFromForcedFallback,
  buildRoomTypeFromKeyElementClusters,
  buildRoomTypeFromOverridePatterns,
  type Pass2SlotEvent,
  type SlotDefinitionSnapshot,
  type ObjectRegistryRow,
  type CompositionClassificationRow,
  type ShortlistingOverrideRow,
  type RoomTypeRegistryRow,
  type SlotSuggestion,
  type RoomTypeSuggestion,
} from './aggregate.ts';

const FN_NAME = 'shortlisting-suggestion-engine';
const FN_VERSION = 'v1.0';

interface RunBody {
  days_back?: number;
  cluster_days_back?: number;
  dry_run?: boolean;
  include_registry_proposals?: boolean;
  _health_check?: boolean;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden: master_admin only', 403, req);
    }
  }

  let body: RunBody = {};
  try {
    body = (await req.json()) as RunBody;
  } catch {
    body = {};
  }
  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME, ok: true }, 200, req);
  }

  const startMs = Date.now();
  const daysBack = clampNum(body.days_back, 7, 365, 90);
  const clusterDays = clampNum(body.cluster_days_back, 7, 365, 120);
  const dryRun = !!body.dry_run;
  const includeRegistry = body.include_registry_proposals !== false;

  const admin = getAdminClient();

  try {
    const slotWindowIso = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();
    const clusterWindowIso = new Date(
      Date.now() - clusterDays * 24 * 3600 * 1000,
    ).toISOString();

    // ─── Fetch raw inputs in parallel ─────────────────────────────────────
    const [
      eventsRes,
      slotDefsRes,
      registryRes,
      classFallbackRes,
      classClusterRes,
      knownRtRes,
      overridesRes,
    ] = await Promise.all([
      // 1. pass2_slot_suggestion events
      admin
        .from('shortlisting_events')
        .select('id, round_id, payload, created_at')
        .eq('event_type', 'pass2_slot_suggestion')
        .gte('created_at', slotWindowIso)
        .limit(5000),

      // 2. active slot definitions (for filtering already-known slots)
      admin
        .from('shortlisting_slot_definitions')
        .select('slot_id, is_active, eligible_room_types')
        .eq('is_active', true),

      // 3. object_registry (W12.8 source 2). Prod schema uses `canonical_id`
      // (W12.B canonical naming). The aggregator gracefully accepts either
      // canonical_id or canonical_label; we select only what exists.
      includeRegistry
        ? admin
            .from('object_registry')
            .select(
              'id, canonical_id, display_name, market_frequency, signal_room_type, status',
            )
            .eq('status', 'canonical')
            .gte('market_frequency', 1)
            .order('market_frequency', { ascending: false })
            .limit(1000)
        : Promise.resolve({ data: [], error: null }),

      // 4. classifications (forced_fallback window) — uses `classified_at`
      admin
        .from('composition_classifications')
        .select(
          'id, round_id, room_type, room_type_confidence, analysis, key_elements, classified_at',
        )
        .gte('classified_at', slotWindowIso)
        .limit(20000),

      // 5. classifications (key_elements_cluster window) — uses `classified_at`
      admin
        .from('composition_classifications')
        .select(
          'id, round_id, room_type, room_type_confidence, analysis, key_elements, classified_at',
        )
        .gte('classified_at', clusterWindowIso)
        .limit(20000),

      // 6. shortlisting_room_types (active known set)
      admin
        .from('shortlisting_room_types')
        .select('key, display_name, is_active')
        .eq('is_active', true),

      // 7. shortlisting_overrides — schema columns `human_selected_group_id`, `override_note`
      admin
        .from('shortlisting_overrides')
        .select(
          'id, round_id, human_action, ai_proposed_group_id, human_selected_group_id, override_note, created_at',
        )
        .gte('created_at', slotWindowIso)
        .limit(5000),
    ]);

    const events = (eventsRes.data || []) as Pass2SlotEvent[];
    const slotDefs = (slotDefsRes.data || []) as SlotDefinitionSnapshot[];
    const registry = (registryRes.data || []) as ObjectRegistryRow[];
    // composition_classifications uses `classified_at`; aggregator expects `created_at` —
    // shim the column name for the helpers' shape.
    // deno-lint-ignore no-explicit-any
    const mapClassRow = (r: any): CompositionClassificationRow => ({
      id: r.id,
      round_id: r.round_id,
      room_type: r.room_type ?? null,
      room_type_confidence: r.room_type_confidence ?? null,
      analysis: r.analysis ?? null,
      key_elements: r.key_elements ?? null,
      created_at: r.classified_at ?? r.created_at ?? new Date().toISOString(),
    });
    const classFallback = (classFallbackRes.data || []).map(mapClassRow);
    const classCluster = (classClusterRes.data || []).map(mapClassRow);
    const knownRt = (knownRtRes.data || []) as RoomTypeRegistryRow[];
    const overrides = (overridesRes.data || []) as ShortlistingOverrideRow[];

    // ─── Aggregate ────────────────────────────────────────────────────────
    const slotSugFromEvents = buildSlotSuggestionsFromEvents(events, slotDefs);
    const slotSugFromRegistry = includeRegistry
      ? buildSlotSuggestionsFromRegistry(registry, slotDefs)
      : [];
    const slotSuggestions = [...slotSugFromEvents, ...slotSugFromRegistry];

    const rtFallback = buildRoomTypeFromForcedFallback(classFallback, knownRt);
    const rtCluster = buildRoomTypeFromKeyElementClusters(classCluster, knownRt);
    const rtOverride = buildRoomTypeFromOverridePatterns(
      overrides,
      classFallback,
      knownRt,
    );
    const roomTypeSuggestions = [...rtFallback, ...rtCluster, ...rtOverride];

    let slotUpserts = 0;
    let roomTypeUpserts = 0;

    if (!dryRun) {
      slotUpserts = await upsertSlotSuggestions(admin, slotSuggestions);
      roomTypeUpserts = await upsertRoomTypeSuggestions(admin, roomTypeSuggestions);
    }

    return jsonResponse(
      {
        ok: true,
        dry_run: dryRun,
        window_days: { slot: daysBack, cluster: clusterDays },
        slot_suggestions: slotSuggestions,
        room_type_suggestions: roomTypeSuggestions,
        upserts: {
          slot_suggestions: slotUpserts,
          room_type_suggestions: roomTypeUpserts,
        },
        cost_attribution: {
          llm_usd: 0,
          embedding_usd: 0,
          db_only: true,
          note: 'Pure DB aggregation; no LLM / embedding spend.',
        },
        counts_inspected: {
          pass2_events: events.length,
          slot_definitions_active: slotDefs.length,
          registry_canonical: registry.length,
          classifications_fallback_window: classFallback.length,
          classifications_cluster_window: classCluster.length,
          known_room_types: knownRt.length,
          overrides: overrides.length,
        },
        elapsed_ms: Date.now() - startMs,
      },
      200,
      req,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] failed: ${msg}`);
    return errorResponse(`suggestion-engine failed: ${msg}`, 500, req);
  }
});

// ─── Upsert helpers ──────────────────────────────────────────────────────

async function upsertSlotSuggestions(
  admin: ReturnType<typeof getAdminClient>,
  rows: SlotSuggestion[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // Coalesce evidence into existing pending rows; new evidence wins on
  // last_observed_at + counts. We use insert-with-onConflict to leverage the
  // (proposed_slot_id, trigger_source) unique index.
  const payload = rows.map((r) => ({
    proposed_slot_id: r.proposed_slot_id,
    proposed_display_name: r.proposed_display_name,
    proposed_phase: r.proposed_phase,
    trigger_source: r.trigger_source,
    evidence_round_count: r.evidence_round_count,
    evidence_total_proposals: r.evidence_total_proposals,
    first_observed_at: r.first_observed_at,
    last_observed_at: r.last_observed_at,
    sample_round_ids: r.sample_round_ids,
    sample_reasoning: r.sample_reasoning,
    source_object_registry_id: r.source_object_registry_id,
    source_market_frequency: r.source_market_frequency,
  }));
  const { error, data } = await admin
    .from('shortlisting_slot_suggestions')
    .upsert(payload, {
      onConflict: 'proposed_slot_id,trigger_source',
      ignoreDuplicates: false,
    })
    .select('id');
  if (error) {
    console.warn(`[${FN_NAME}] upsertSlotSuggestions failed: ${error.message}`);
    return 0;
  }
  return (data || []).length;
}

async function upsertRoomTypeSuggestions(
  admin: ReturnType<typeof getAdminClient>,
  rows: RoomTypeSuggestion[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    proposed_key: r.proposed_key,
    proposed_display_name: r.proposed_display_name,
    trigger_source: r.trigger_source,
    evidence_count: r.evidence_count,
    first_observed_at: r.first_observed_at,
    last_observed_at: r.last_observed_at,
    sample_composition_ids: r.sample_composition_ids,
    sample_analysis_excerpts: r.sample_analysis_excerpts,
    proposed_eligible_slots: r.proposed_eligible_slots,
    avg_confidence: r.avg_confidence,
  }));
  const { error, data } = await admin
    .from('shortlisting_room_type_suggestions')
    .upsert(payload, {
      onConflict: 'proposed_key,trigger_source',
      ignoreDuplicates: false,
    })
    .select('id');
  if (error) {
    console.warn(`[${FN_NAME}] upsertRoomTypeSuggestions failed: ${error.message}`);
    return 0;
  }
  return (data || []).length;
}

function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
