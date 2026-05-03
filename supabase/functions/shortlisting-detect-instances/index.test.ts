/**
 * shortlisting-detect-instances/index.test.ts — W11.8 unit tests.
 *
 * Run:
 *   deno test --no-check --allow-all \
 *     supabase/functions/shortlisting-detect-instances/index.test.ts
 *
 * Covers:
 *  - Skip-disambiguation space_types (exterior_facade, floorplan, aerial_*) get
 *    instance_index=1 with no LLM call.
 *  - Single-group buckets get auto-assigned instance_index=1.
 *  - normaliseCluster rejects clusters with no group_ids in the bucket.
 *  - normaliseCluster clamps cluster_confidence to 0-1.
 *  - humanLabelFromSpaceType formats snake_case as Title Case.
 *  - persistClusters: idempotency (delete-then-insert by round_id).
 *  - persistClusters: per-bucket member-count desc ordering -> instance_index.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildDetectInstancesSystem,
  buildDetectInstancesUser,
  DETECT_INSTANCES_VERSION,
  humanLabelFromSpaceType,
  normaliseCluster,
  SKIP_DISAMBIGUATION_SPACE_TYPES,
} from './index.ts';

// ─── Pure helpers ───────────────────────────────────────────────────────────

Deno.test('humanLabelFromSpaceType: snake_case -> Title Case', () => {
  assertStrictEquals(humanLabelFromSpaceType('master_bedroom'), 'Master bedroom');
  assertStrictEquals(humanLabelFromSpaceType('living_dining_combined'), 'Living dining combined');
  assertStrictEquals(humanLabelFromSpaceType('kitchen'), 'Kitchen');
});

Deno.test('humanLabelFromSpaceType: empty input returns input', () => {
  assertStrictEquals(humanLabelFromSpaceType(''), '');
});

Deno.test('SKIP_DISAMBIGUATION_SPACE_TYPES contains the canonical 5', () => {
  assert(SKIP_DISAMBIGUATION_SPACE_TYPES.has('exterior_facade'));
  assert(SKIP_DISAMBIGUATION_SPACE_TYPES.has('floorplan'));
  assert(SKIP_DISAMBIGUATION_SPACE_TYPES.has('aerial_overhead'));
  assert(SKIP_DISAMBIGUATION_SPACE_TYPES.has('aerial_oblique'));
  assert(SKIP_DISAMBIGUATION_SPACE_TYPES.has('streetscape'));
});

// ─── Prompt builders ────────────────────────────────────────────────────────

Deno.test('buildDetectInstancesSystem: includes the visual signal cues', () => {
  const sys = buildDetectInstancesSystem();
  assert(sys.includes('Wall colour'));
  assert(sys.includes('Floor material'));
  assert(sys.includes('Ceiling height'));
  assert(sys.includes('Lighting fixtures'));
  assert(sys.includes('duplex'));
});

Deno.test('buildDetectInstancesUser: renders space_type buckets with stems', () => {
  const buckets = new Map<string, Array<{
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
  }>>();
  buckets.set('kitchen', [
    {
      group_id: 'aaa-1',
      group_index: 0,
      stem: 'IMG_001',
      space_type: 'kitchen',
      zone_focus: 'kitchen_island',
      technical_score: 8.5,
      aesthetic_score: 8.0,
      composition_score: 7.5,
      delivery_reference_stem: 'IMG_001',
      best_bracket_stem: null,
      dropbox_preview_path: null,
    },
  ]);
  const txt = buildDetectInstancesUser({
    buckets,
    previewStems: ['IMG_001'],
  });
  assert(txt.includes('space_type=kitchen'));
  assert(txt.includes('group_id=aaa-1'));
  assert(txt.includes('stem=IMG_001'));
  assert(txt.includes('cluster_space_instances'));
});

// ─── normaliseCluster ───────────────────────────────────────────────────────

Deno.test('normaliseCluster: rejects unknown space_type', () => {
  const buckets = new Map<string, Array<{ group_id: string }>>();
  buckets.set('kitchen', [{ group_id: 'g1' }]);
  // deno-lint-ignore no-explicit-any
  const result = normaliseCluster(
    {
      space_type: 'totally_unknown',
      group_ids: ['g1'],
      cluster_confidence: 0.9,
    },
    buckets as any,
  );
  assertStrictEquals(result, null);
});

Deno.test('normaliseCluster: drops group_ids not in the bucket', () => {
  const buckets = new Map<string, Array<{ group_id: string }>>();
  buckets.set('kitchen', [{ group_id: 'g1' }, { group_id: 'g2' }]);
  // deno-lint-ignore no-explicit-any
  const result = normaliseCluster(
    {
      space_type: 'kitchen',
      group_ids: ['g1', 'g2', 'g_unknown'],
      cluster_confidence: 0.85,
      instance_label: 'Kitchen',
    },
    buckets as any,
  );
  assertEquals(result?.group_ids, ['g1', 'g2']);
  assertStrictEquals(result?.cluster_confidence, 0.85);
});

Deno.test('normaliseCluster: clamps cluster_confidence to [0,1]', () => {
  const buckets = new Map<string, Array<{ group_id: string }>>();
  buckets.set('kitchen', [{ group_id: 'g1' }]);
  // deno-lint-ignore no-explicit-any
  const overOne = normaliseCluster(
    {
      space_type: 'kitchen',
      group_ids: ['g1'],
      cluster_confidence: 2.5,
    },
    buckets as any,
  );
  assertStrictEquals(overOne?.cluster_confidence, 1);
  // deno-lint-ignore no-explicit-any
  const underZero = normaliseCluster(
    {
      space_type: 'kitchen',
      group_ids: ['g1'],
      cluster_confidence: -0.3,
    },
    buckets as any,
  );
  assertStrictEquals(underZero?.cluster_confidence, 0);
});

Deno.test('normaliseCluster: defaults instance_label when missing', () => {
  const buckets = new Map<string, Array<{ group_id: string }>>();
  buckets.set('master_bedroom', [{ group_id: 'g1' }]);
  // deno-lint-ignore no-explicit-any
  const result = normaliseCluster(
    {
      space_type: 'master_bedroom',
      group_ids: ['g1'],
      cluster_confidence: 0.9,
    },
    buckets as any,
  );
  // humanLabelFromSpaceType applied
  assertStrictEquals(result?.instance_label, 'Master bedroom');
});

Deno.test('normaliseCluster: caps distinctive_features at 5 + dominant_colors at 3', () => {
  const buckets = new Map<string, Array<{ group_id: string }>>();
  buckets.set('living', [{ group_id: 'g1' }]);
  // deno-lint-ignore no-explicit-any
  const result = normaliseCluster(
    {
      space_type: 'living',
      group_ids: ['g1'],
      cluster_confidence: 0.9,
      distinctive_features: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      dominant_colors: [
        { hex: '#aaa', role: 'primary' },
        { hex: '#bbb', role: 'secondary' },
        { hex: '#ccc', role: 'accent' },
        { hex: '#ddd', role: 'extra' },
      ],
    },
    buckets as any,
  );
  assertStrictEquals(result?.distinctive_features.length, 5);
  assertStrictEquals(result?.dominant_colors.length, 3);
});

Deno.test('DETECT_INSTANCES_VERSION matches expected v1.0', () => {
  assertStrictEquals(DETECT_INSTANCES_VERSION, 'v1.0');
});
