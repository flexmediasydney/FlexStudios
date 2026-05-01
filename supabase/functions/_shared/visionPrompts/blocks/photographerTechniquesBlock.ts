/**
 * photographerTechniquesBlock.ts — W11.7.1 (W7.6 block) deliberate-craft preamble.
 *
 * Real estate photographers use deliberate techniques in-camera to protect
 * image quality. Without explicit prompting, vision models (Gemini 2.5 Pro and
 * Anthropic Opus 4.7 alike) misread these techniques as flaws and emit
 * `major_reject`, `photographer_error`, or `requires_reshoot` verdicts that
 * actively destroy good work.
 *
 * The motivating case (Rainbow Cres, IMG_034A7991, 2026-05-01):
 *
 *   Stage 1 verdict: clutter_severity = "major_reject" (fingers in shot)
 *   Stage 4 override: photographer_error (manual hand visible)
 *
 *   Reality: photographer was holding fingers in front of the sun to block
 *   sunflare from striking the lens directly. WITHOUT the technique, the same
 *   frame would have suffered major sunflare artefacts (flare ghosts, lifted
 *   blacks, contrast loss, magenta cast). The technique PROTECTED a 9/10
 *   image that would otherwise have been a 5/10 image.
 *
 *   Joseph (CEO, master photographer, 2026-05-01):
 *     "the fingers in the shot is actually a tick photographers use to cover
 *      the sun, so the sunflare doesn't impact the fidelity of the image and
 *      contrast/sharpness etc stay intact - this is a good thing, fingers
 *      covering the sun, if you can detect it, should not be part of the
 *      equation to say its a negative impact - specifically if its covering
 *      the sun - the image should be evaluated ignoring the fingers. in fact,
 *      you could potentially have a brilliant 9/10 image but with fingers
 *      covering the sun, where the same shot without the fingers would have
 *      caused potentially major sunflare artifacts impacting quality."
 *
 * The block lists every deliberate technique we want the engine to recognise
 * and tells it: (a) this is craft, not a flaw, (b) evaluate the image AS IF
 * the technique-object weren't in frame, (c) optionally surface the technique
 * in observed_objects with a positive label.
 *
 * Inject AFTER sourceContextBlock and BEFORE voiceAnchorBlock in user_text on
 * Stage 1 + Stage 4. Versioned via PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION so
 * prompt-cache invalidation tracks block changes (persisted in
 * composition_classifications.prompt_block_versions and
 * engine_run_audit.prompt_block_versions).
 */

export const PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION = 'v1.0';

const PHOTOGRAPHER_TECHNIQUES_BLOCK = [
  '── PHOTOGRAPHER TECHNIQUES — RECOGNISE, DO NOT PENALISE ──',
  '',
  'Real estate photographers use deliberate in-camera techniques to PROTECT',
  'image quality. When you detect any of the patterns below, treat them as',
  'craft moves, not flaws. Score the image AS IF the technique-object were',
  'not in frame. Never emit clutter_severity = "major_reject" or stage_4_',
  'overrides "photographer_error" or "requires_reshoot" because of these.',
  '',
  '1. FINGERS / HAND BLOCKING THE SUN (sunflare suppression).',
  '   - Visual cue: fingers, knuckles, or a flat palm at the upper edge of',
  '     the frame, partially silhouetted, positioned exactly where the sun',
  '     would otherwise sit. Often paired with a strongly backlit scene,',
  '     long shadows, or a vista that opens toward the sky.',
  '   - Why: prevents lens flare ghosts, halo veiling, lifted blacks, and',
  '     magenta-cast haze that would otherwise destroy contrast + sharpness.',
  '     The technique is the ONLY way to keep a 9/10 architectural image at',
  '     9/10 when shooting into the sun — the alternative shot (without the',
  '     hand) is materially worse.',
  '   - How to score: imagine the frame with the fingers removed. Score',
  '     composition, vantage, lighting, and aesthetic on what is genuinely',
  '     visible of the architecture. The hand is a transient occluder that',
  '     post-production removes in seconds (clone/heal); it is NOT clutter,',
  '     NOT a styling failure, NOT a reshoot trigger.',
  '   - How to surface it: in observed_objects, you MAY emit a single entry',
  '     with object_label = "deliberate_sunflare_block" and a positive',
  '     framing in any rationale — e.g. "photographer used hand-block to',
  '     suppress flare from low sun". Do NOT add the hand to clutter or',
  '     retouch_priority. Do NOT mention it in master_listing copy.',
  '',
  '2. LEG / FOOT / SHADOW IN FRAME FOR SAFETY OR SCALE.',
  '   - Visual cue: a foot or leg in the lower edge of an exterior shot,',
  '     often on stairs, balconies, or steep terrain.',
  '   - Why: photographer braced for safety on uneven ground, or included a',
  '     human element to provide architectural scale reference.',
  '   - How to score: same rule — evaluate the image as if the limb were not',
  '     there. Post-production crops or clones it out trivially.',
  '',
  '3. INTENTIONAL TRIPOD SHADOW IN HARSH NOON SUN.',
  '   - Visual cue: a thin tripod-leg shadow on a foreground hard surface',
  '     (driveway, deck) when the sun is high and directly overhead.',
  '   - Why: at certain solar angles the tripod shadow is unavoidable, and',
  '     the photographer chose composition over that retouchable artefact.',
  '   - How to score: minor retouch flag is acceptable, but do NOT call it',
  '     "photographer_error" or reject the image. Note in retouch_priority',
  '     "tripod shadow on foreground" with severity "minor_photoshoppable".',
  '',
  '4. FLAG / GOBO / DIFFUSER VISIBLE AT FRAME EDGE.',
  '   - Visual cue: a soft black or white panel just inside the frame edge,',
  '     often along window walls or doorways.',
  '   - Why: photographer flagged ambient spill or bounced fill into a dark',
  '     area to balance ambient + window exposure.',
  '   - How to score: technique mark, not a flaw. Same rule — score as if',
  '     the panel were not there. Crop fixes it.',
  '',
  '5. INTENTIONAL OVEREXPOSURE / BLOOM ON A SINGLE WINDOW.',
  '   - Visual cue: one window deliberately blown to white in an interior',
  '     where every other window is properly exposed.',
  '   - Why: that view was the worst (powerlines, neighbour\'s wall, AC unit',
  '     on a roof) and the photographer chose to "kill" it with bloom rather',
  '     than capture an ugly view.',
  '   - How to score: do NOT call it a flaw. The composition decision is',
  '     correct: an ugly view is worse than a clean white pane.',
  '',
  'GENERAL RULE — when in doubt, ask "would removing this object in post',
  'reveal a strong image?" If yes, the object is a transient occluder and',
  'should NOT depress the per-image scores.',
  '',
].join('\n');

/**
 * Build the photographer-techniques preamble.
 * Inject AFTER sourceContextBlock and BEFORE voiceAnchorBlock in user_text
 * on Stage 1 + Stage 4 so the model reads it before scoring instructions.
 */
export function photographerTechniquesBlock(): string {
  return PHOTOGRAPHER_TECHNIQUES_BLOCK;
}
