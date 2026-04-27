/**
 * One-shot snapshot generator for the W7.6 prompt-block regression gate.
 *
 * Run ONCE against the pre-refactor monolithic pass1Prompt / pass2Prompt to
 * capture the byte-stable baseline. Snapshot test files then read the
 * resulting .snap.txt files and assert byte-equality against the new modular
 * builders. Do NOT re-run after refactor — the baseline is the contract.
 *
 * Run:
 *   deno run --allow-write --no-check supabase/functions/_shared/visionPrompts/__snapshots__/_generate.ts
 */

import { buildPass1Prompt } from '../../pass1Prompt.ts';
import { buildPass2Prompt } from '../../pass2Prompt.ts';
import { FIXTURE_ANCHORS, FIXTURE_PASS2_OPTS } from './_fixtures.ts';

const here = new URL('.', import.meta.url).pathname;

const p1 = buildPass1Prompt(FIXTURE_ANCHORS);
const p2 = buildPass2Prompt(FIXTURE_PASS2_OPTS);

const p1Snap = `${p1.system}\n---\n${p1.userPrefix}`;
const p2Snap = `${p2.system}\n---\n${p2.userPrefix}`;

await Deno.writeTextFile(`${here}pass1Prompt.snap.txt`, p1Snap);
await Deno.writeTextFile(`${here}pass2Prompt.snap.txt`, p2Snap);

console.log(`Wrote ${p1Snap.length} chars to pass1Prompt.snap.txt`);
console.log(`Wrote ${p2Snap.length} chars to pass2Prompt.snap.txt`);
