/**
 * stepOrdering.ts — Wave 7 P1-10 (W7.6) block.
 *
 * STEP 1 / STEP 2 reasoning-first contract — instructs the model to write the
 * full ANALYSIS paragraph BEFORE producing scores. Without this, the prose
 * becomes post-hoc justification of an arbitrary number and prose/score
 * consistency drops.
 *
 * Today's prompts use this in two distinct surfaces:
 *
 *   - System framing (paragraphs 2-4 of Pass 1 SYSTEM_PROMPT) — sets the
 *     contract: two strict steps + analysis-first commitment + Pass 1 is not
 *     making selection decisions.
 *
 *   - User imperative (STEP 1 / STEP 2 instructions inside userPrefix) — the
 *     concrete task instruction the model executes per-image.
 *
 * `placement` opt lets callers pick which surface they're rendering. Both
 * texts are byte-stable lifts from `pass1Prompt.ts`.
 */

export const STEP_ORDERING_BLOCK_VERSION = 'v1.0';

export interface StepOrderingBlockOpts {
  /**
   * Where this block is being placed.
   *   - 'system' → renders the contract framing (system-message use)
   *   - 'user'   → renders the STEP 1 / STEP 2 imperative (user-message use)
   * Defaults to 'system'.
   */
  placement?: 'system' | 'user';
}

const SYSTEM_STEP_CONTRACT =
  'You operate in two strict steps:\n' +
  '  STEP 1 — Write a full descriptive ANALYSIS paragraph FIRST.\n' +
  '  STEP 2 — Derive structured SCORES from your analysis.\n' +
  '\n' +
  'The analysis must be written before any scores. The scores must be consistent with — and derivable from — what you wrote in the analysis. Do not skip the analysis. Do not produce scores that contradict your analysis text.\n' +
  '\n' +
  'You are NOT making shortlisting decisions in this pass. You are classifying and scoring every composition individually. Selection happens in a separate downstream pass that has access to the entire shoot. Do not try to be selective here — score what you see.';

const USER_STEP_IMPERATIVE = [
  'STEP 1 — WRITE YOUR ANALYSIS FIRST.',
  'Before producing any scores or classifications, write a paragraph describing what you observe about this composition. Cover:',
  '- What space or room is shown',
  '- Camera angle and height choice',
  '- What depth layers are visible (foreground / midground / background)',
  '- Key architectural elements and features visible',
  '- Composition strengths and any weaknesses',
  '- Whether this appears to be a hero shot, a supporting angle, or a detail',
  '- Any quality concerns (clutter, distraction, technical issue)',
  '',
  'Minimum 3 sentences. The analysis is the primary reasoning artifact — the scores must be derivable from it.',
  '',
  'STEP 2 — DERIVE SCORES FROM YOUR ANALYSIS.',
  'Using your analysis above as the basis, produce the structured output below. Your scores must be consistent with and derivable from your written analysis. The Stream B scoring anchors define the reference scale.',
].join('\n');

export function stepOrderingBlock(opts: StepOrderingBlockOpts = {}): string {
  const placement = opts.placement ?? 'system';
  return placement === 'user' ? USER_STEP_IMPERATIVE : SYSTEM_STEP_CONTRACT;
}
