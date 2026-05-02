/**
 * shortlisting-suggestion-engine / aggregate.ts — pure aggregation helpers.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Wave 12.7-12.8. Side-effect-free reducers + threshold filters that turn
 * raw event/composition/registry rows into upsert-ready suggestion rows.
 * Kept separate from index.ts so they can be unit-tested without the Deno
 * fetch / Supabase client surface.
 *
 * Trigger sources implemented (per W12-trigger-thresholds.md):
 *
 *   SLOT — Source 1 (pass2_event)
 *     5 distinct rounds in 90 days propose the same proposed_slot_id, and
 *     the slot is NOT already an active shortlisting_slot_definitions row.
 *
 *   SLOT — Source 2 (registry_high_frequency, W12.8 NEW)
 *     object_registry rows with market_frequency >= 20 (default) that don't
 *     anchor any active slot definition. Surfaces as a slot proposal hint.
 *
 *   ROOM_TYPE — Source 1 (forced_fallback)
 *     5 occurrences of a free-text room_type label in composition_classifications
 *     in 90 days where confidence >= 0.7 AND label is NOT in shortlisting_room_types.
 *
 *   ROOM_TYPE — Source 2 (key_elements_cluster)
 *     8 distinct rounds in 120 days share key_element overlap >= 75%,
 *     and the cluster does NOT match an existing room_type with confidence > 0.7.
 *
 *   ROOM_TYPE — Source 3 (override_pattern)
 *     5 confirmed-with-review human overrides in 90 days where the human
 *     pick has a key_element pattern not represented in any active slot's
 *     eligible_room_types.
 */

export const SLOT_TRIGGER_THRESHOLD_ROUNDS = 5;
export const SLOT_REGISTRY_FREQUENCY_THRESHOLD = 20;
export const ROOM_TYPE_FALLBACK_THRESHOLD = 5;
export const ROOM_TYPE_FALLBACK_CONFIDENCE_FLOOR = 0.7;
export const ROOM_TYPE_CLUSTER_THRESHOLD_ROUNDS = 8;
export const ROOM_TYPE_CLUSTER_OVERLAP = 0.75;
export const ROOM_TYPE_OVERRIDE_THRESHOLD = 5;

export interface Pass2SlotEvent {
  id: number;
  round_id: string | null;
  payload: {
    proposed_slot_id?: string | null;
    candidate_stems?: string[];
    reasoning?: string | null;
  };
  created_at: string;
}

export interface SlotDefinitionSnapshot {
  slot_id: string;
  is_active: boolean;
  eligible_room_types?: string[];
}

export interface ObjectRegistryRow {
  id: string;
  canonical_id?: string | null;
  canonical_label?: string | null;
  display_name?: string | null;
  market_frequency: number;
  signal_room_type?: string | null;
}

export interface CompositionClassificationRow {
  id: string;
  round_id: string;
  room_type: string | null;
  room_type_confidence: number | null;
  analysis: string | null;
  key_elements: string[] | null;
  created_at: string;
}

export interface ShortlistingOverrideRow {
  id: string;
  round_id: string;
  human_action: string | null;
  ai_proposed_group_id: string | null;
  // Schema mig 286 — column is `human_selected_group_id`, not `human_chosen_group_id`.
  human_selected_group_id: string | null;
  // Schema — column is `override_note`, not `reviewer_notes`.
  override_note?: string | null;
  created_at: string;
}

export interface RoomTypeRegistryRow {
  key: string;
  display_name?: string | null;
  is_active: boolean;
}

export interface SlotSuggestion {
  proposed_slot_id: string;
  proposed_display_name: string | null;
  proposed_phase: number | null;
  trigger_source: 'pass2_event' | 'registry_high_frequency';
  evidence_round_count: number;
  evidence_total_proposals: number;
  first_observed_at: string;
  last_observed_at: string;
  sample_round_ids: string[];
  sample_reasoning: string[];
  source_object_registry_id: string | null;
  source_market_frequency: number | null;
}

export interface RoomTypeSuggestion {
  proposed_key: string;
  proposed_display_name: string | null;
  trigger_source: 'forced_fallback' | 'key_elements_cluster' | 'override_pattern';
  evidence_count: number;
  first_observed_at: string;
  last_observed_at: string;
  sample_composition_ids: string[];
  sample_analysis_excerpts: string[];
  proposed_eligible_slots: string[];
  avg_confidence: number | null;
}

// ─── Source 1: slot suggestions from pass2_slot_suggestion events ────────
export function buildSlotSuggestionsFromEvents(
  events: Pass2SlotEvent[],
  slotDefinitions: SlotDefinitionSnapshot[],
  threshold = SLOT_TRIGGER_THRESHOLD_ROUNDS,
): SlotSuggestion[] {
  // Filter out proposed_slot_ids that already exist as active slot definitions
  const activeSlotIds = new Set(
    slotDefinitions.filter((d) => d.is_active).map((d) => d.slot_id.toLowerCase()),
  );

  // Aggregate by proposed_slot_id
  const grouped = new Map<
    string,
    {
      proposed: string;
      rounds: Set<string>;
      total: number;
      first: string;
      last: string;
      sampleRounds: string[];
      sampleReasoning: string[];
    }
  >();

  for (const ev of events) {
    const proposedRaw = (ev.payload?.proposed_slot_id || '').toString().trim();
    if (!proposedRaw) continue;
    const proposed = proposedRaw.toLowerCase();
    if (activeSlotIds.has(proposed)) continue;
    if (!ev.round_id) continue;

    const bucket = grouped.get(proposed) || {
      proposed: proposedRaw,
      rounds: new Set<string>(),
      total: 0,
      first: ev.created_at,
      last: ev.created_at,
      sampleRounds: [],
      sampleReasoning: [],
    };
    bucket.rounds.add(ev.round_id);
    bucket.total += 1;
    if (ev.created_at < bucket.first) bucket.first = ev.created_at;
    if (ev.created_at > bucket.last) bucket.last = ev.created_at;
    if (bucket.sampleRounds.length < 10 && !bucket.sampleRounds.includes(ev.round_id)) {
      bucket.sampleRounds.push(ev.round_id);
    }
    const reasoning = (ev.payload?.reasoning || '').toString().trim();
    if (reasoning && bucket.sampleReasoning.length < 10) {
      bucket.sampleReasoning.push(reasoning);
    }
    grouped.set(proposed, bucket);
  }

  const out: SlotSuggestion[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.rounds.size < threshold) continue;
    out.push({
      proposed_slot_id: bucket.proposed,
      proposed_display_name: humaniseSlotId(bucket.proposed),
      proposed_phase: null,
      trigger_source: 'pass2_event',
      evidence_round_count: bucket.rounds.size,
      evidence_total_proposals: bucket.total,
      first_observed_at: bucket.first,
      last_observed_at: bucket.last,
      sample_round_ids: bucket.sampleRounds,
      sample_reasoning: bucket.sampleReasoning,
      source_object_registry_id: null,
      source_market_frequency: null,
    });
  }
  // Sort by evidence_round_count DESC for deterministic ordering
  out.sort((a, b) => b.evidence_round_count - a.evidence_round_count);
  return out;
}

// ─── Source 2 (W12.8 NEW): registry-driven slot proposals ─────────────────
export function buildSlotSuggestionsFromRegistry(
  objects: ObjectRegistryRow[],
  slotDefinitions: SlotDefinitionSnapshot[],
  freqThreshold = SLOT_REGISTRY_FREQUENCY_THRESHOLD,
): SlotSuggestion[] {
  // Build a flat set of every label that anchors an active slot's eligible_room_types
  const anchoredLabels = new Set<string>();
  for (const def of slotDefinitions) {
    if (!def.is_active) continue;
    for (const rt of def.eligible_room_types || []) {
      if (typeof rt === 'string' && rt.trim()) {
        anchoredLabels.add(rt.toLowerCase().trim());
      }
    }
  }

  const out: SlotSuggestion[] = [];
  const nowIso = new Date().toISOString();
  for (const obj of objects) {
    if (obj.market_frequency < freqThreshold) continue;
    const label = (obj.canonical_id || obj.canonical_label || '').toString().toLowerCase().trim();
    if (!label) continue;
    if (anchoredLabels.has(label)) continue;

    // Only propose a slot when the registry hint suggests the object reads
    // as a hero subject (signal_room_type set). Without it we'd churn out
    // proposals for materials/finishes that don't deserve their own slot.
    if (!obj.signal_room_type) continue;

    const proposedSlotId = `${label}_hero`;
    out.push({
      proposed_slot_id: proposedSlotId,
      proposed_display_name: obj.display_name || humaniseSlotId(proposedSlotId),
      proposed_phase: null,
      trigger_source: 'registry_high_frequency',
      evidence_round_count: 0,
      evidence_total_proposals: 0,
      first_observed_at: nowIso,
      last_observed_at: nowIso,
      sample_round_ids: [],
      sample_reasoning: [
        `object_registry.${obj.canonical_id || obj.canonical_label} has market_frequency=${obj.market_frequency} but no active slot definition references it via eligible_room_types.`,
      ],
      source_object_registry_id: obj.id,
      source_market_frequency: obj.market_frequency,
    });
  }
  out.sort((a, b) => (b.source_market_frequency || 0) - (a.source_market_frequency || 0));
  return out;
}

// ─── Room-type Source 1: forced fallback ──────────────────────────────────
export function buildRoomTypeFromForcedFallback(
  classifications: CompositionClassificationRow[],
  knownRoomTypes: RoomTypeRegistryRow[],
  threshold = ROOM_TYPE_FALLBACK_THRESHOLD,
  confidenceFloor = ROOM_TYPE_FALLBACK_CONFIDENCE_FLOOR,
): RoomTypeSuggestion[] {
  const known = new Set(
    knownRoomTypes.filter((r) => r.is_active).map((r) => r.key.toLowerCase()),
  );

  const grouped = new Map<
    string,
    {
      original: string;
      count: number;
      first: string;
      last: string;
      sampleIds: string[];
      sampleExcerpts: string[];
      confSum: number;
      confCount: number;
    }
  >();

  for (const c of classifications) {
    const rt = (c.room_type || '').toString().trim();
    if (!rt) continue;
    const lower = rt.toLowerCase();
    if (known.has(lower)) continue;
    const conf = Number(c.room_type_confidence);
    if (!Number.isFinite(conf) || conf < confidenceFloor) continue;

    const bucket = grouped.get(lower) || {
      original: rt,
      count: 0,
      first: c.created_at,
      last: c.created_at,
      sampleIds: [],
      sampleExcerpts: [],
      confSum: 0,
      confCount: 0,
    };
    bucket.count += 1;
    if (c.created_at < bucket.first) bucket.first = c.created_at;
    if (c.created_at > bucket.last) bucket.last = c.created_at;
    if (bucket.sampleIds.length < 10) bucket.sampleIds.push(c.id);
    const excerpt = truncate((c.analysis || '').toString(), 280);
    if (excerpt && bucket.sampleExcerpts.length < 10) {
      bucket.sampleExcerpts.push(excerpt);
    }
    bucket.confSum += conf;
    bucket.confCount += 1;
    grouped.set(lower, bucket);
  }

  const out: RoomTypeSuggestion[] = [];
  for (const [key, bucket] of grouped.entries()) {
    if (bucket.count < threshold) continue;
    out.push({
      proposed_key: key,
      proposed_display_name: humaniseSlotId(bucket.original),
      trigger_source: 'forced_fallback',
      evidence_count: bucket.count,
      first_observed_at: bucket.first,
      last_observed_at: bucket.last,
      sample_composition_ids: bucket.sampleIds,
      sample_analysis_excerpts: bucket.sampleExcerpts,
      proposed_eligible_slots: [],
      avg_confidence: bucket.confCount
        ? Number((bucket.confSum / bucket.confCount).toFixed(3))
        : null,
    });
  }
  out.sort((a, b) => b.evidence_count - a.evidence_count);
  return out;
}

// ─── Room-type Source 2: key_elements clusters ────────────────────────────
//
// For each composition_classifications row that has key_elements but NO
// room_type (or a room_type with low confidence), bucket by a canonical
// signature (sorted-unique key_elements joined). Threshold = 8 distinct
// rounds sharing >= 75% overlap. Cheap heuristic since we don't run real
// clustering at this stage; admin reviews the candidate clusters.
export function buildRoomTypeFromKeyElementClusters(
  classifications: CompositionClassificationRow[],
  knownRoomTypes: RoomTypeRegistryRow[],
  threshold = ROOM_TYPE_CLUSTER_THRESHOLD_ROUNDS,
  overlap = ROOM_TYPE_CLUSTER_OVERLAP,
): RoomTypeSuggestion[] {
  const known = new Set(
    knownRoomTypes.filter((r) => r.is_active).map((r) => r.key.toLowerCase()),
  );

  // Index by signature → rounds + samples
  const grouped = new Map<
    string,
    {
      keyElements: string[];
      rounds: Set<string>;
      sampleIds: string[];
      sampleExcerpts: string[];
      first: string;
      last: string;
    }
  >();

  for (const c of classifications) {
    const elements = Array.isArray(c.key_elements) ? c.key_elements : [];
    if (elements.length === 0) continue;
    // Skip rows already classified into a known room_type with high conf.
    const knownHit = c.room_type && known.has(c.room_type.toLowerCase());
    const conf = Number(c.room_type_confidence);
    if (knownHit && Number.isFinite(conf) && conf > 0.7) continue;

    const sig = canonicalKeyElementsSignature(elements);
    if (!sig) continue;
    const bucket = grouped.get(sig) || {
      keyElements: [...new Set(elements.map(normalise))].sort(),
      rounds: new Set<string>(),
      sampleIds: [],
      sampleExcerpts: [],
      first: c.created_at,
      last: c.created_at,
    };
    bucket.rounds.add(c.round_id);
    if (c.created_at < bucket.first) bucket.first = c.created_at;
    if (c.created_at > bucket.last) bucket.last = c.created_at;
    if (bucket.sampleIds.length < 10) bucket.sampleIds.push(c.id);
    const excerpt = truncate((c.analysis || '').toString(), 280);
    if (excerpt && bucket.sampleExcerpts.length < 10) {
      bucket.sampleExcerpts.push(excerpt);
    }
    grouped.set(sig, bucket);
  }

  // Merge clusters with >= overlap on key_elements (greedy union)
  const buckets = Array.from(grouped.values());
  const merged: typeof buckets = [];
  for (const b of buckets) {
    let placed = false;
    for (const m of merged) {
      const o = jaccard(new Set(b.keyElements), new Set(m.keyElements));
      if (o >= overlap) {
        for (const r of b.rounds) m.rounds.add(r);
        for (const id of b.sampleIds) {
          if (m.sampleIds.length < 10 && !m.sampleIds.includes(id)) m.sampleIds.push(id);
        }
        for (const ex of b.sampleExcerpts) {
          if (m.sampleExcerpts.length < 10 && !m.sampleExcerpts.includes(ex)) {
            m.sampleExcerpts.push(ex);
          }
        }
        if (b.first < m.first) m.first = b.first;
        if (b.last > m.last) m.last = b.last;
        // Keep the union of key_elements
        m.keyElements = [...new Set([...m.keyElements, ...b.keyElements])].sort();
        placed = true;
        break;
      }
    }
    if (!placed) merged.push({ ...b, keyElements: [...b.keyElements] });
  }

  const out: RoomTypeSuggestion[] = [];
  for (const b of merged) {
    if (b.rounds.size < threshold) continue;
    const proposed_key = b.keyElements.slice(0, 3).join('_').replace(/[^a-z0-9_]/g, '');
    if (!proposed_key) continue;
    out.push({
      proposed_key,
      proposed_display_name: humaniseSlotId(proposed_key),
      trigger_source: 'key_elements_cluster',
      evidence_count: b.rounds.size,
      first_observed_at: b.first,
      last_observed_at: b.last,
      sample_composition_ids: b.sampleIds,
      sample_analysis_excerpts: b.sampleExcerpts,
      proposed_eligible_slots: [],
      avg_confidence: null,
    });
  }
  out.sort((a, b) => b.evidence_count - a.evidence_count);
  return out;
}

// ─── Room-type Source 3: override patterns ────────────────────────────────
export function buildRoomTypeFromOverridePatterns(
  overrides: ShortlistingOverrideRow[],
  classifications: CompositionClassificationRow[],
  knownRoomTypes: RoomTypeRegistryRow[],
  threshold = ROOM_TYPE_OVERRIDE_THRESHOLD,
): RoomTypeSuggestion[] {
  // Index classifications by group_id-equivalent (we use composition.id since
  // the override shape references group ids that correspond 1:1 to compositions
  // for this engine's purpose).
  const known = new Set(
    knownRoomTypes.filter((r) => r.is_active).map((r) => r.key.toLowerCase()),
  );
  const classByGroup = new Map<string, CompositionClassificationRow>();
  for (const c of classifications) {
    classByGroup.set(c.id, c);
  }

  const grouped = new Map<
    string,
    {
      key: string;
      count: number;
      first: string;
      last: string;
      sampleIds: string[];
      sampleExcerpts: string[];
    }
  >();

  for (const o of overrides) {
    if ((o.human_action || '').toLowerCase() !== 'confirm_with_review') continue;
    const targetId = o.human_selected_group_id;
    if (!targetId) continue;
    const c = classByGroup.get(targetId);
    if (!c) continue;
    // The "pattern" — use the human-picked composition's room_type (if any)
    // OR the leading key_element. If room_type is already in registry with
    // strong confidence, the override doesn't surface a gap.
    const rtNorm = (c.room_type || '').toLowerCase().trim();
    const isKnownStrong = rtNorm && known.has(rtNorm) && Number(c.room_type_confidence) > 0.7;
    if (isKnownStrong) continue;

    const candidate = rtNorm || normalise(c.key_elements?.[0] || '');
    if (!candidate) continue;

    const bucket = grouped.get(candidate) || {
      key: candidate,
      count: 0,
      first: o.created_at,
      last: o.created_at,
      sampleIds: [],
      sampleExcerpts: [],
    };
    bucket.count += 1;
    if (o.created_at < bucket.first) bucket.first = o.created_at;
    if (o.created_at > bucket.last) bucket.last = o.created_at;
    if (bucket.sampleIds.length < 10) bucket.sampleIds.push(c.id);
    const excerpt = truncate(
      (o.override_note || c.analysis || '').toString(),
      280,
    );
    if (excerpt && bucket.sampleExcerpts.length < 10) {
      bucket.sampleExcerpts.push(excerpt);
    }
    grouped.set(candidate, bucket);
  }

  const out: RoomTypeSuggestion[] = [];
  for (const [key, b] of grouped.entries()) {
    if (b.count < threshold) continue;
    out.push({
      proposed_key: key,
      proposed_display_name: humaniseSlotId(key),
      trigger_source: 'override_pattern',
      evidence_count: b.count,
      first_observed_at: b.first,
      last_observed_at: b.last,
      sample_composition_ids: b.sampleIds,
      sample_analysis_excerpts: b.sampleExcerpts,
      proposed_eligible_slots: [],
      avg_confidence: null,
    });
  }
  out.sort((a, b) => b.evidence_count - a.evidence_count);
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function humaniseSlotId(slug: string): string {
  return slug
    .replace(/_/g, ' ')
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .trim();
}

export function normalise(s: string): string {
  return (s || '').toString().toLowerCase().trim().replace(/\s+/g, '_');
}

export function canonicalKeyElementsSignature(elements: string[]): string {
  const norm = [...new Set((elements || []).map(normalise).filter(Boolean))].sort();
  return norm.join('|');
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
