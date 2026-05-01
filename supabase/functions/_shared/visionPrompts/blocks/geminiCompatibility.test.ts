/**
 * geminiCompatibility.test.ts — Wave 11.7.17 hotfix-3 schema-tree audit.
 *
 * Walks every JSON Schema we hand to Gemini's `responseSchema` and asserts
 * the OpenAPI 3.0 subset that Gemini actually accepts. Pre-fix this would
 * FAIL on every type-array nullable union; post-fix it should pass.
 *
 * Why a schema-tree walker instead of static greps: we want a single place
 * where the constraint is documented in code, and any future schema author
 * who adds a forbidden pattern gets a green deno test → red build, not a
 * silent runtime fail-over to Anthropic at 12x the cost.
 *
 * Forbidden patterns:
 *   - `type` field that is an array (OpenAPI 3.1 union form)
 *   - `oneOf`, `anyOf`, `$ref`
 *   - `patternProperties`, `additionalProperties`
 *   - `nullable: true` without a primary `type` set
 *
 * Schemas under audit:
 *   1. UNIVERSAL_VISION_RESPONSE_SCHEMA (W11.7.17 v2.1 universal)
 *   2. STAGE4_TOOL_SCHEMA (Stage 4 visual master synthesis)
 *
 * signalMeasurementBlock is a STRING renderer, not a JSON Schema, so it has
 * no responseSchema surface to audit (it ships as part of `system` text).
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { UNIVERSAL_VISION_RESPONSE_SCHEMA } from './universalVisionResponseSchemaV2.ts';
import { STAGE4_TOOL_SCHEMA } from '../../../shortlisting-shape-d-stage4/stage4Prompt.ts';

interface Violation {
  path: string;
  rule: string;
  detail?: string;
}

const FORBIDDEN_KEYS = [
  'oneOf',
  'anyOf',
  '$ref',
  'patternProperties',
  'additionalProperties',
];

/**
 * Recursive walker. Visits every node of the JSON Schema tree and records
 * any violation of the Gemini OpenAPI-3.0 subset.
 */
function walk(node: unknown, path: string, violations: Violation[]): void {
  if (node === null || node === undefined) return;
  if (typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, idx) => walk(item, `${path}[${idx}]`, violations));
    return;
  }

  const obj = node as Record<string, unknown>;

  // Rule 1: `type` must NOT be an array (OpenAPI 3.1 nullable union form is
  // rejected by Gemini's responseSchema validator).
  if ('type' in obj && Array.isArray(obj.type)) {
    violations.push({
      path: `${path}.type`,
      rule: 'type-must-not-be-array',
      detail: `Got: ${JSON.stringify(obj.type)} — use { type: '<primary>', nullable: true } instead.`,
    });
  }

  // Rule 2: forbidden composition keywords.
  for (const k of FORBIDDEN_KEYS) {
    if (k in obj) {
      violations.push({
        path: `${path}.${k}`,
        rule: 'forbidden-keyword',
        detail: `Gemini responseSchema does not support '${k}'.`,
      });
    }
  }

  // Rule 3: when `nullable: true` is set, a primary `type` MUST also be set
  // (a string singular, not an array).
  if (obj.nullable === true) {
    if (!('type' in obj)) {
      violations.push({
        path: `${path}.nullable`,
        rule: 'nullable-without-type',
        detail: 'nullable: true requires a primary `type` field.',
      });
    } else if (typeof obj.type !== 'string') {
      violations.push({
        path: `${path}.nullable`,
        rule: 'nullable-without-singular-type',
        detail: `nullable: true requires a singular primary type (string|number|boolean|object|array). Got: ${JSON.stringify(obj.type)}`,
      });
    }
  }

  // Recurse into known JSON Schema sub-trees only — avoid descending into
  // `description`, `required`, etc. as they're string/array of string.
  if (obj.properties && typeof obj.properties === 'object') {
    for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
      walk(v, `${path}.properties.${k}`, violations);
    }
  }
  if (obj.items) {
    walk(obj.items, `${path}.items`, violations);
  }
}

function auditSchema(name: string, schema: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];
  walk(schema, name, violations);
  return violations;
}

Deno.test('geminiCompat: UNIVERSAL_VISION_RESPONSE_SCHEMA — no forbidden patterns', () => {
  const violations = auditSchema('UNIVERSAL_VISION_RESPONSE_SCHEMA', UNIVERSAL_VISION_RESPONSE_SCHEMA);
  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  - ${v.path}: [${v.rule}] ${v.detail ?? ''}`)
      .join('\n');
    throw new Error(`Found ${violations.length} Gemini-incompat violations:\n${msg}`);
  }
  assertEquals(violations.length, 0);
});

Deno.test('geminiCompat: STAGE4_TOOL_SCHEMA — no forbidden patterns', () => {
  const violations = auditSchema('STAGE4_TOOL_SCHEMA', STAGE4_TOOL_SCHEMA);
  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  - ${v.path}: [${v.rule}] ${v.detail ?? ''}`)
      .join('\n');
    throw new Error(`Found ${violations.length} Gemini-incompat violations:\n${msg}`);
  }
  assertEquals(violations.length, 0);
});

Deno.test('geminiCompat: walker self-test — known-bad schema fails', () => {
  // Sanity check the walker by feeding it a schema that mimics the pre-fix
  // pattern. This guards against the walker silently passing everything.
  const knownBad: Record<string, unknown> = {
    type: 'object',
    properties: {
      bad_field: { type: ['string', 'null'] },
      bad_object: { type: ['object', 'null'], properties: { x: { type: 'number' } } },
      bad_oneof: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      bad_ref: { $ref: '#/definitions/Foo' },
    },
  };
  const violations = auditSchema('test', knownBad);
  // 4 violations expected: 2 type-array + 1 oneOf + 1 $ref.
  if (violations.length < 4) {
    throw new Error(`walker self-test under-detected: only ${violations.length} violations`);
  }
});
