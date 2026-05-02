/**
 * schemaStateCount.test.ts — Wave 11.7.17 hotfix-6 (2026-05-02) build-time
 * guardrail against the Gemini "schema produces a constraint that has too
 * many states for serving" 400 that has tripped THREE times in a single day:
 *
 *   - commit a03ced9 — photographer_techniques enum drop (Stage 1)
 *   - commit bbb4337 — slot_id enum drop (Stage 4)
 *   - commit 9325f46 — space_type / zone_focus enum drop (Stage 1, v2.3 -> v2.4)
 *
 * The schema is borderline. One new closed enum and we hit it again. This test
 * computes a deterministic STATE-COUNT PROXY for every responseSchema we hand
 * Gemini and FAILS THE BUILD if any schema crosses an empirical threshold
 * pinned to today's known-good baseline + 10% headroom. Bumping the threshold
 * deliberately requires editing this file (visible in PR review) — exactly
 * what we want.
 *
 * ─── What the proxy measures ────────────────────────────────────────────────
 *
 * Gemini's "state count" is the size of the constraint automaton it compiles
 * the schema into. Google has not published the exact formula, but the
 * dominant contributors are:
 *   1. Closed `enum` cardinality (each entry is a state in the automaton).
 *   2. Total node count in the schema tree (each property = at least 1 state).
 *   3. `required` array entries (each adds at least 1 transition).
 *   4. Long descriptions on string properties (the validator scans them).
 *
 * Proxy = sum(enum lengths) + node_count + sum(required entries)
 *       + 0.5 * (sum(string_property_description_chars) / 200)
 *
 * The 200-char divisor + 0.5 weight on description chars is empirical: it
 * makes string properties with "this is one of: A | B | C | …" descriptions
 * weigh roughly the same as a true closed enum of the same cardinality, since
 * Gemini DOES tokenise long descriptions when building the FSM (we know this
 * because dropping a closed enum to description-only does not always restore
 * a barely-over-budget schema, only one with significant headroom).
 *
 * The proxy is NOT Gemini's exact internal calculation — we don't have that.
 * It is a STABLE, DETERMINISTIC, MONOTONIC indicator that lets us pin a
 * known-good baseline and detect regression. If this test fails on a future
 * PR that adds a field, the question to ask is:
 *   - Did the new field add a closed enum?
 *   - Could the field be moved to description-only (the W11.7.x pattern)?
 *   - Is the threshold still empirically conservative? Bump if so.
 *
 * ─── Threshold rationale ────────────────────────────────────────────────────
 *
 * Per Joseph's binding (2026-05-02): better to fail a PR that's actually-still-
 * safe (and bump the threshold) than to miss a real regression. ~10% headroom
 * over today's known-good baseline.
 *
 * Today's measured proxies (deterministic given the schemas in tree):
 *   - stage1:internal_raw       292
 *   - stage1:internal_finals    305
 *   - stage1:external_listing   307
 *   - stage1:floorplan_image    308
 *   - stage4                    141
 *
 * Limits (proxy + 10% rounded up):
 *   - STAGE1_STATE_COUNT_LIMIT  339   (max 308 * 1.10 = 338.8 -> ceil 339)
 *   - STAGE4_STATE_COUNT_LIMIT  156   (141 * 1.10 = 155.1 -> ceil 156)
 *
 * See also: docs/MIGRATION_SAFETY.md "Gemini response-schema state-count
 * limit" section, which documents the runtime symptom and remediation
 * patterns. This test is the BUILD-TIME enforcement mechanism.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  universalSchemaForSource,
  type SourceType,
} from './universalVisionResponseSchemaV2.ts';
import { STAGE4_TOOL_SCHEMA } from '../../../shortlisting-shape-d-stage4/stage4Prompt.ts';

// ─── Pinned thresholds ─────────────────────────────────────────────────────
//
// HOW TO BUMP: only when you have measured the proxy on a schema you know
// works in production AND the new value is < 1.30x today's value (i.e. you
// are not eating ALL of the FSM headroom on one PR). Use Read on this file's
// docstring for the formula. Document the bump rationale in the PR
// description so reviewers can sanity-check.

/** Stage 1 universal responseSchema (per-source variants).
 *  Today's worst case: floorplan_image at 308. Limit = 308 * 1.10. */
export const STAGE1_STATE_COUNT_LIMIT = 339;

/** Stage 4 STAGE4_TOOL_SCHEMA. Today's value: 141. Limit = 141 * 1.10. */
export const STAGE4_STATE_COUNT_LIMIT = 156;

// ─── State-count proxy ─────────────────────────────────────────────────────

interface ProxyAccumulator {
  /** Total number of distinct enum entries summed across every closed enum. */
  enumStatesTotal: number;
  /** Number of nodes that declared an `enum` array. */
  enumNodes: number;
  /** Primitive type nodes: string | number | integer | boolean | null. */
  primitiveNodes: number;
  /** Object-typed nodes (each implies a transition group in the FSM). */
  objectNodes: number;
  /** Array-typed nodes. */
  arrayNodes: number;
  /** Total entries across all `required` arrays in the tree. */
  requiredEntries: number;
  /** Total chars across descriptions of string-typed properties. */
  longDescriptionChars: number;
}

function emptyAcc(): ProxyAccumulator {
  return {
    enumStatesTotal: 0,
    enumNodes: 0,
    primitiveNodes: 0,
    objectNodes: 0,
    arrayNodes: 0,
    requiredEntries: 0,
    longDescriptionChars: 0,
  };
}

/**
 * Recursively walk a JSON-schema-shaped object summing the proxy contributors.
 * Pure function — no time / env / network dependence.
 */
function walk(node: unknown, acc: ProxyAccumulator): void {
  if (node === null || node === undefined) return;
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, acc);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj.type;

  // 1. enum cardinality contribution
  if (Array.isArray(obj.enum)) {
    acc.enumNodes += 1;
    acc.enumStatesTotal += obj.enum.length;
  }

  // 2. node-count contribution by primary type
  if (typeof t === 'string') {
    if (t === 'object') {
      acc.objectNodes += 1;
    } else if (t === 'array') {
      acc.arrayNodes += 1;
    } else {
      // string | number | integer | boolean | null — all treated as primitives
      acc.primitiveNodes += 1;
      if (t === 'string' && typeof obj.description === 'string') {
        acc.longDescriptionChars += obj.description.length;
      }
    }
  }

  // 3. required array contribution
  if (Array.isArray(obj.required)) {
    acc.requiredEntries += obj.required.length;
  }

  // 4. recurse into JSON-Schema sub-trees
  if (obj.properties && typeof obj.properties === 'object') {
    for (const v of Object.values(obj.properties as Record<string, unknown>)) {
      walk(v, acc);
    }
  }
  if (obj.items) walk(obj.items, acc);
  // oneOf / anyOf / allOf are forbidden in Gemini today, but if a future
  // schema author adds one we still want to count contained nodes — sum
  // each branch and let geminiCompatibility.test.ts catch the pattern.
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(obj[k])) {
      for (const branch of obj[k] as unknown[]) walk(branch, acc);
    }
  }
}

/**
 * Compute the deterministic state-count proxy for a JSON-schema-shaped object.
 * Exported for tests; not used at runtime.
 */
export function stateCountProxy(schema: Record<string, unknown>): number {
  const acc = emptyAcc();
  walk(schema, acc);
  const nodes = acc.primitiveNodes + acc.objectNodes + acc.arrayNodes + acc.enumNodes;
  // 0.5 weight on (description_chars / 200) per the docstring rationale.
  const descriptionContribution = Math.round(0.5 * (acc.longDescriptionChars / 200));
  return acc.enumStatesTotal + descriptionContribution + nodes + acc.requiredEntries;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

const STAGE1_SOURCES: SourceType[] = [
  'internal_raw',
  'internal_finals',
  'external_listing',
  'floorplan_image',
];

for (const source_type of STAGE1_SOURCES) {
  Deno.test(`schemaStateCount: Stage 1 universalSchema('${source_type}') under STAGE1_STATE_COUNT_LIMIT`, () => {
    const schema = universalSchemaForSource(source_type);
    const proxy = stateCountProxy(schema);
    if (proxy > STAGE1_STATE_COUNT_LIMIT) {
      throw new Error(
        `Stage 1 schema for source '${source_type}' has state-count proxy = ${proxy}, ` +
        `exceeds STAGE1_STATE_COUNT_LIMIT = ${STAGE1_STATE_COUNT_LIMIT}. ` +
        `Gemini may reject with "schema produces a constraint that has too many states for serving". ` +
        `See docs/MIGRATION_SAFETY.md "Gemini response-schema state-count limit" for remediation patterns. ` +
        `If this regression is intentional and the new total is still safely under Gemini's serving limit, ` +
        `bump STAGE1_STATE_COUNT_LIMIT in this file with a clear PR rationale.`,
      );
    }
    // sanity: the proxy must be a positive integer well above zero — guards
    // against the walker silently returning 0 for a malformed schema.
    assert(proxy > 100, `proxy unexpectedly low (${proxy}) — walker may be broken`);
  });
}

Deno.test('schemaStateCount: Stage 4 STAGE4_TOOL_SCHEMA under STAGE4_STATE_COUNT_LIMIT', () => {
  const proxy = stateCountProxy(STAGE4_TOOL_SCHEMA);
  if (proxy > STAGE4_STATE_COUNT_LIMIT) {
    throw new Error(
      `Stage 4 STAGE4_TOOL_SCHEMA has state-count proxy = ${proxy}, ` +
      `exceeds STAGE4_STATE_COUNT_LIMIT = ${STAGE4_STATE_COUNT_LIMIT}. ` +
      `Gemini may reject with "schema produces a constraint that has too many states for serving". ` +
      `See docs/MIGRATION_SAFETY.md "Gemini response-schema state-count limit" for remediation patterns. ` +
      `If this regression is intentional and the new total is still safely under Gemini's serving limit, ` +
      `bump STAGE4_STATE_COUNT_LIMIT in this file with a clear PR rationale.`,
    );
  }
  assert(proxy > 50, `proxy unexpectedly low (${proxy}) — walker may be broken`);
});

Deno.test('schemaStateCount: regression — adding a fake enum grows the proxy by at least N', () => {
  // Confirms the walker actually counts enum cardinality. If someone refactors
  // walk() and accidentally drops the enum branch, this test fails.
  const baseSchema = universalSchemaForSource('internal_raw');
  const baseProxy = stateCountProxy(baseSchema);

  const fakeEnumSize = 25;
  const fakeEnum = Array.from({ length: fakeEnumSize }, (_, i) => `fake_value_${i}`);
  const augmented: Record<string, unknown> = {
    ...baseSchema,
    properties: {
      ...(baseSchema.properties as Record<string, unknown>),
      __fake_enum_for_test: {
        type: 'string',
        enum: fakeEnum,
      },
    },
  };
  const augmentedProxy = stateCountProxy(augmented);
  const delta = augmentedProxy - baseProxy;
  assert(
    delta >= fakeEnumSize,
    `expected proxy to grow by at least ${fakeEnumSize} after adding a ${fakeEnumSize}-entry enum, ` +
    `but it grew by only ${delta} (${baseProxy} -> ${augmentedProxy})`,
  );
});

Deno.test('schemaStateCount: boundary — known-too-large fake schema EXCEEDS the limit', () => {
  // Negative-case test: a fake schema with cumulative proxy > STAGE1 limit
  // must trip the guardrail. Confirms the threshold is actually enforceable.
  const overBudgetSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      huge_enum_a: {
        type: 'string',
        enum: Array.from({ length: 200 }, (_, i) => `option_a_${i}`),
      },
      huge_enum_b: {
        type: 'string',
        enum: Array.from({ length: 200 }, (_, i) => `option_b_${i}`),
      },
      // pad with primitives to push the node count up too
      ...Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [
          `pad_${i}`,
          { type: 'string', description: 'x'.repeat(400) },
        ]),
      ),
    },
    required: Array.from({ length: 50 }, (_, i) => `pad_${i}`),
  };
  const proxy = stateCountProxy(overBudgetSchema);
  assert(
    proxy > STAGE1_STATE_COUNT_LIMIT,
    `boundary test: known-too-large fake schema produced proxy ${proxy}, ` +
    `which is NOT > STAGE1_STATE_COUNT_LIMIT (${STAGE1_STATE_COUNT_LIMIT}). ` +
    `The guardrail would not catch a real regression of this magnitude.`,
  );
  assert(
    proxy > STAGE4_STATE_COUNT_LIMIT,
    `boundary test: same schema produced proxy ${proxy}, NOT > STAGE4_STATE_COUNT_LIMIT (${STAGE4_STATE_COUNT_LIMIT}).`,
  );
});

Deno.test('schemaStateCount: proxy is deterministic — same schema returns same proxy', () => {
  // The proxy must be a pure function of the schema. No time / env / random.
  const schema = universalSchemaForSource('internal_raw');
  const a = stateCountProxy(schema);
  const b = stateCountProxy(schema);
  const c = stateCountProxy(schema);
  assertEquals(a, b);
  assertEquals(b, c);
});

Deno.test('schemaStateCount: walker self-test — empty schema returns 0', () => {
  // Sanity: empty schema must produce 0, NOT a non-zero garbage number.
  const empty: Record<string, unknown> = {};
  assertEquals(stateCountProxy(empty), 0);
});
