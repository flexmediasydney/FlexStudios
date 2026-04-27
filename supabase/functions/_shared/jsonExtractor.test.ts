/**
 * Unit tests for jsonExtractor (Wave 0 burst 0.4).
 * Run: deno test supabase/functions/_shared/jsonExtractor.test.ts
 *
 * Covers the hard-won fixes from bursts 6 L1/L2 / 7 M5 / 9 O1 / 14 W2:
 *   - Multi-fence resolution (prefer the fence containing `{`)
 *   - Lenient boolean coercion ("true"/"yes"/"1" → true)
 *   - Score clamping
 *   - Confidence clamping
 *   - Defensive empty/null handling
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  extractJsonBlock,
  lenientBool,
  clampScore,
  clampConfidence,
} from './jsonExtractor.ts';

// ─── extractJsonBlock — empty / invalid ──────────────────────────────────────

Deno.test('extractJsonBlock: empty string → ok=false', () => {
  const r = extractJsonBlock('');
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes('empty'));
});

Deno.test('extractJsonBlock: whitespace-only → ok=false', () => {
  const r = extractJsonBlock('   \n  \t  ');
  assertEquals(r.ok, false);
});

Deno.test('extractJsonBlock: not-a-string → ok=false', () => {
  // deno-lint-ignore no-explicit-any
  const r = extractJsonBlock(null as any);
  assertEquals(r.ok, false);
});

Deno.test('extractJsonBlock: no JSON object in text → ok=false', () => {
  const r = extractJsonBlock('just some prose, no braces here.');
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes('no JSON object'));
});

Deno.test('extractJsonBlock: malformed JSON → ok=false with parse error', () => {
  const r = extractJsonBlock('{ "foo": "bar", "missing": }');
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes('JSON.parse'));
});

// ─── extractJsonBlock — single fence ─────────────────────────────────────────

Deno.test('extractJsonBlock: bare JSON object → ok with parsed value', () => {
  const r = extractJsonBlock('{"foo": "bar", "num": 42}');
  assertEquals(r.ok, true);
  if (r.ok) {
    const v = r.value as { foo: string; num: number };
    assertEquals(v.foo, 'bar');
    assertEquals(v.num, 42);
  }
});

Deno.test('extractJsonBlock: ```json fence around JSON → ok', () => {
  const r = extractJsonBlock('```json\n{"foo": "bar"}\n```');
  assertEquals(r.ok, true);
  if (r.ok) assertEquals((r.value as { foo: string }).foo, 'bar');
});

Deno.test('extractJsonBlock: ``` plain fence (no json language tag) → ok', () => {
  const r = extractJsonBlock('```\n{"foo": "bar"}\n```');
  assertEquals(r.ok, true);
});

Deno.test('extractJsonBlock: prose before bare JSON → finds object', () => {
  const r = extractJsonBlock('Here is my output:\n{"result": "ok"}\nThanks.');
  assertEquals(r.ok, true);
  if (r.ok) assertEquals((r.value as { result: string }).result, 'ok');
});

// ─── extractJsonBlock — multi-fence (the critical fix) ───────────────────────

Deno.test('extractJsonBlock: TWO fences (analysis prose + JSON) → picks the JSON fence', () => {
  // This was the bug from bursts 6 L2 / 7 M5 / 9 O1 / 14 W2 — old non-greedy
  // regex picked the FIRST fence (analysis text) and brace-finder failed.
  const text = `Here is my analysis:
\`\`\`
This image shows a kitchen with marble countertops and pendant lighting
above the island. The composition uses a corner-two-point perspective.
\`\`\`

Now my structured output:
\`\`\`json
{"room_type": "kitchen_main", "score": 8}
\`\`\``;
  const r = extractJsonBlock(text);
  assertEquals(r.ok, true);
  if (r.ok) {
    const v = r.value as { room_type: string; score: number };
    assertEquals(v.room_type, 'kitchen_main');
    assertEquals(v.score, 8);
  }
});

Deno.test('extractJsonBlock: TWO fences both contain `{` → picks first (no preference)', () => {
  // When both fences contain `{`, behaviour is "first one wins" — used to be
  // the legacy single-fence regex behaviour, preserved as a fallback.
  const text = '```\n{"first": true}\n```\n```\n{"second": true}\n```';
  const r = extractJsonBlock(text);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals((r.value as { first?: boolean }).first, true);
});

Deno.test('extractJsonBlock: THREE fences, only middle has JSON → picks the JSON fence', () => {
  const text = '```\nfirst prose\n```\n```json\n{"the_one": "yes"}\n```\n```\nthird prose\n```';
  const r = extractJsonBlock(text);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals((r.value as { the_one: string }).the_one, 'yes');
});

Deno.test('extractJsonBlock: model emits NO JSON between fences → ok=false', () => {
  const text = '```\nprose only\n```\nnothing here either\n```\nmore prose\n```';
  const r = extractJsonBlock(text);
  assertEquals(r.ok, false);
});

// ─── extractJsonBlock — edge cases ───────────────────────────────────────────

Deno.test('extractJsonBlock: nested braces inside string values are preserved', () => {
  // The first/last brace approach handles "{key: \"value with {braces}\"}"
  // correctly because JSON.parse balances them.
  const text = '{"analysis": "the {kitchen} has {marble} counters", "score": 7}';
  const r = extractJsonBlock(text);
  assertEquals(r.ok, true);
  if (r.ok) {
    const v = r.value as { analysis: string; score: number };
    assert(v.analysis.includes('{kitchen}'));
    assertEquals(v.score, 7);
  }
});

Deno.test('extractJsonBlock: array at top level (not object) → ok=false', () => {
  const r = extractJsonBlock('[{"foo": 1}, {"foo": 2}]');
  // Documented limitation: top-level arrays return ok=false because we look
  // for { ... }. Pass-specific parsers can change this if needed.
  assertEquals(r.ok, false);
});

Deno.test('extractJsonBlock: deeply nested object', () => {
  const r = extractJsonBlock('{"a": {"b": {"c": {"d": "deep"}}}}');
  assertEquals(r.ok, true);
  if (r.ok) {
    // deno-lint-ignore no-explicit-any
    const v = r.value as any;
    assertEquals(v.a.b.c.d, 'deep');
  }
});

// ─── lenientBool ─────────────────────────────────────────────────────────────

Deno.test('lenientBool: canonical booleans', () => {
  assertEquals(lenientBool(true), true);
  assertEquals(lenientBool(false), false);
});

Deno.test('lenientBool: null/undefined → false', () => {
  assertEquals(lenientBool(null), false);
  assertEquals(lenientBool(undefined), false);
});

Deno.test('lenientBool: string variants for true', () => {
  assertEquals(lenientBool('true'), true);
  assertEquals(lenientBool('TRUE'), true);
  assertEquals(lenientBool('True'), true);
  assertEquals(lenientBool('  true  '), true);
  assertEquals(lenientBool('yes'), true);
  assertEquals(lenientBool('y'), true);
  assertEquals(lenientBool('1'), true);
});

Deno.test('lenientBool: string variants for false (anything not in true list)', () => {
  assertEquals(lenientBool('false'), false);
  assertEquals(lenientBool('no'), false);
  assertEquals(lenientBool('n'), false);
  assertEquals(lenientBool('0'), false);
  assertEquals(lenientBool(''), false);
  assertEquals(lenientBool('arbitrary'), false);
});

Deno.test('lenientBool: numeric variants', () => {
  assertEquals(lenientBool(1), true);
  assertEquals(lenientBool(0), false);
  assertEquals(lenientBool(2), false); // only exactly 1 is true
  assertEquals(lenientBool(-1), false);
});

Deno.test('lenientBool: object/array → false', () => {
  assertEquals(lenientBool({}), false);
  assertEquals(lenientBool([]), false);
  assertEquals(lenientBool({ truthy: true }), false);
});

// ─── clampScore ──────────────────────────────────────────────────────────────

Deno.test('clampScore: valid range preserved', () => {
  assertEquals(clampScore(0, 5), 0);
  assertEquals(clampScore(5, 0), 5);
  assertEquals(clampScore(7.5, 0), 7.5);
  assertEquals(clampScore(10, 0), 10);
});

Deno.test('clampScore: above 10 → clamped to 10', () => {
  assertEquals(clampScore(15, 0), 10);
  assertEquals(clampScore(100, 0), 10);
});

Deno.test('clampScore: below 0 → clamped to 0', () => {
  assertEquals(clampScore(-1, 5), 0);
  assertEquals(clampScore(-100, 5), 0);
});

Deno.test('clampScore: string-numeric coerced', () => {
  assertEquals(clampScore('7.5', 0), 7.5);
  assertEquals(clampScore('9.5', 0), 9.5);
});

Deno.test('clampScore: NaN/non-finite → fallback', () => {
  assertEquals(clampScore(NaN, 5), 5);
  assertEquals(clampScore('not a number', 5), 5);
  assertEquals(clampScore(undefined, 5), 5);
  assertEquals(clampScore(null, 5), 5);
  assertEquals(clampScore(Infinity, 5), 5);
});

// ─── clampConfidence ─────────────────────────────────────────────────────────

Deno.test('clampConfidence: valid range', () => {
  assertEquals(clampConfidence(0), 0);
  assertEquals(clampConfidence(0.5), 0.5);
  assertEquals(clampConfidence(0.95), 0.95);
  assertEquals(clampConfidence(1), 1);
});

Deno.test('clampConfidence: above 1 → 1', () => {
  assertEquals(clampConfidence(1.5), 1);
  assertEquals(clampConfidence(2), 1);
});

Deno.test('clampConfidence: below 0 → 0', () => {
  assertEquals(clampConfidence(-0.5), 0);
});

Deno.test('clampConfidence: NaN/non-finite → 0', () => {
  assertEquals(clampConfidence(NaN), 0);
  assertEquals(clampConfidence('not a number'), 0);
  assertEquals(clampConfidence(null), 0);
  assertEquals(clampConfidence(undefined), 0);
});
