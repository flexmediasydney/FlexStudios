/**
 * voiceAnchorBlock.ts — Wave 11.7.7/11.7.8 (W7.6 block) voice tier rubrics.
 *
 * Promoted to production from `vendor-retroactive-compare/iter5VoiceAnchor.ts`
 * after iter-5 Saladine validation. Each rubric block is a 50-100-line prompt-
 * text constant injected into BOTH:
 *   - Stage 1 user_text (drives per-image listing_copy.headline/paragraphs)
 *   - Stage 4 user_text (drives master_listing.* body + derivatives)
 *
 * The point: same architectural specificity, different prose register. Apply
 * Belle Property luxury voice to a $1M Punchbowl cottage and the copy reads
 * pretentious. Apply approachable voice to a $7M Mosman pavilion and the copy
 * underqualifies. Tier modulation prevents both.
 *
 * Three presets:
 *   premium      — Belle Property / luxury magazine ($5M+ harbour, Federation)
 *   standard     — Domain editorial ($1M-$3M family homes, Saladine fits here)
 *   approachable — friendly plain-language (sub-$1M, units, investor stock)
 *
 * Override path: when property_voice_anchor_override is set, the entire tier
 * rubric is replaced with the operator's free-text directive (forbidden
 * patterns from standard tier still apply).
 *
 * Block architecture (W7.6 pattern): pure exported builder function returning
 * a multi-line string. Versioned via VOICE_ANCHOR_BLOCK_VERSION so prompt-
 * cache invalidation tracks block changes. Persisted in
 * `composition_classifications.prompt_block_versions` and
 * `engine_run_audit.prompt_block_versions` for replay reproducibility.
 */

export const VOICE_ANCHOR_BLOCK_VERSION = 'v1.0';

export type PropertyTier = 'premium' | 'standard' | 'approachable';

export interface VoiceAnchorOpts {
  tier: PropertyTier;
  /** Optional free-text override that replaces the tier preset block. */
  override?: string | null;
}

const PREMIUM_RUBRIC_TEXT = [
  'VOICE ANCHOR — PREMIUM TIER',
  '',
  "You are writing in the voice of a senior editor at Belle Property's print",
  'magazine, with the discipline of a Domain editorial copywriter on a feature',
  'listing. Your craft is restrained evocative prose, grounded in materials and',
  'period — never in adjectives. The reader has seen ten luxury listings this',
  'month already; the difference between this listing and the others is whether',
  'the prose earns its place.',
  '',
  'OPENING DISCIPLINE',
  '- Never open with "Welcome to" or "Step inside".',
  '- Never open with the address.',
  "- Open with the property's defining gesture — the architectural move that",
  '  makes this house this house. Materials, period, or the orientation of the',
  '  principal room.',
  '',
  'VOCABULARY REGISTER',
  '- Specific materials over generic adjectives. "Brushed-bronze tapware" not',
  '  "designer fittings". "1920s Federation oak floors" not "timber floors".',
  '  "Calacatta marble waterfall" not "stone island".',
  '- Period references where the architecture warrants. "Inter-war duplex",',
  '  "post-war pavilion", "1960s Boyd-influenced living wing".',
  '- Architectural lineage names where the property genuinely echoes them.',
  '  Glenn Murcutt, Peter Stutchbury, Richard Leplastrier — the Sydney School.',
  '  Do not name them gratuitously; only when the building actually shows that',
  '  influence.',
  '',
  'SENTENCE PACING',
  '- Vary sentence length. Mix one short declarative every paragraph or two',
  '  with longer evocative sentences.',
  '- One subordinate clause per sentence is the ceiling. Never two.',
  '- Comma-spliced run-ons are forbidden. Use the em-dash for the single',
  '  parenthetical aside per paragraph.',
  '',
  'FORBIDDEN PATTERNS',
  '- "stunning", "must inspect", "do not miss", "modern living at its best/finest"',
  '- "a rare opportunity", "beautifully/perfectly/exquisitely appointed/presented/finished"',
  '- "boasts" (any context), "nestled" (any context), "prime" as adjective',
  '- "this property offers/features/presents/boasts"',
  '- exclamation marks (zero tolerance)',
  '',
  'ENCOURAGED PATTERNS',
  '- Period openings: "Built in 1928", "A 1958 post-war duplex", "The 1990',
  '  rear pavilion sits above..."',
  '- Material specificity: "honed Carrara", "tongue-and-groove cedar",',
  '  "wide-board European oak"',
  '- Lifestyle through architecture: "the principal living room is lifted',
  '  half a level above the garden, which keeps morning sun on the floor',
  '  through winter"',
  '- Restrained closing: "It is the kind of house that does not shout."',
  '',
  'READING-GRADE TARGET',
  '- Flesch-Kincaid 9-12. Premium readers tolerate longer clauses and',
  '  Latinate vocabulary, but never at the cost of clarity.',
  '',
  'WORD-COUNT TARGET',
  '- Master listing body 700-1000 words across 3-4 paragraphs.',
  '- Per-image listing_copy.paragraphs: 140-200 words. Headline: 8-12 words.',
  '',
  'EXAMPLE PROPERTY THIS VOICE FITS',
  '- $5M+ harbour-side architectural piece, Mosman pavilion, eastern-suburbs',
  '  Federation, North Shore Californian bungalow with a contemporary',
  '  rear addition.',
].join('\n');

const STANDARD_RUBRIC_TEXT = [
  'VOICE ANCHOR — STANDARD TIER',
  '',
  'You are writing in the voice of a Domain editorial copywriter on a Saturday',
  'weekend feature — confident, warm, specific but accessible. The reader is a',
  'working professional or a young family scrolling on their phone after dinner;',
  'they want to know what the house is actually like, not what adjectives it',
  'deserves.',
  '',
  'OPENING DISCIPLINE',
  "- Open with the property's character, suburb position, or defining feature.",
  '  "Set behind a low brick fence...", "Three bedrooms on a level block...",',
  '  "Built in 1985 and refreshed top-to-bottom in 2021..."',
  '- Avoid generic openings ("Welcome to", "Step inside", "This stunning home").',
  '',
  'VOCABULARY REGISTER',
  '- Specific but accessible. "Caesarstone bench" not "calacatta marble".',
  '  "Shaker cabinetry" not "bespoke joinery". "Covered alfresco" not',
  '  "outdoor entertaining pavilion".',
  '- Period references when relevant but plain-language. "1980s brick',
  '  veneer", "post-war fibro cottage", "renovated 2021".',
  '- No name-dropping of architects unless the property genuinely is by one.',
  '',
  'SENTENCE PACING',
  '- Conversational. Short to medium sentences. Vary length but not',
  '  dramatically.',
  '- Use the em-dash sparingly for a parenthetical. Do not comma-splice.',
  '- Lead with subject-verb clarity. "The kitchen runs along the south wall"',
  '  not "Running along the south wall is a kitchen".',
  '',
  'FORBIDDEN PATTERNS',
  '- "stunning", "must inspect", "do not miss", "modern living at its best/finest"',
  '- "beautifully/perfectly/exquisitely appointed/presented/finished"',
  '- "boasts", "nestled", "prime location"',
  '- exclamation marks (zero tolerance)',
  '- realtor jargon: "expansive", "sprawling", "executive"',
  '',
  'ENCOURAGED PATTERNS',
  '- Specific count + material: "20mm Caesarstone island", "three north-',
  '  facing windows in the main bedroom", "covered alfresco with a mains-gas BBQ',
  '  outlet"',
  '- Concrete lifestyle: "level back lawn fenced on three sides — room for',
  '  a trampoline and a clothesline both"',
  '- Practical orientation: "north-facing rear", "south-side bathroom",',
  '  "morning sun on the kitchen bench"',
  '',
  'READING-GRADE TARGET',
  '- Flesch-Kincaid 8-10. The Domain reader is educated but tired; clarity',
  '  trumps cleverness.',
  '',
  'WORD-COUNT TARGET',
  '- Master listing body 500-750 words across 3-4 paragraphs.',
  '- Per-image listing_copy.paragraphs: 120-180 words. Headline: 6-10 words.',
  '',
  'EXAMPLE PROPERTY THIS VOICE FITS',
  '- Saladine ($1M-ish project home in Punchbowl), inner-west semi, suburban',
  '  family home, three-bedroom unit in a 12-pack apartment block.',
].join('\n');

const APPROACHABLE_RUBRIC_TEXT = [
  'VOICE ANCHOR — APPROACHABLE TIER',
  '',
  'You are writing for a first-home buyer, an investor, or a buyer who reads',
  'listings on their phone in the kitchen with the kettle on. Plain, friendly,',
  'concrete. No pretension. No condescension either — just plain prose that',
  "respects the reader's time.",
  '',
  'OPENING DISCIPLINE',
  '- Lead with the practical headline: bed/bath count, location, the one',
  '  feature that distinguishes this property from the next.',
  '- "A two-bedroom unit in a quiet 12-pack, six minutes from the station..."',
  '- "Three bedrooms, one bathroom, on a 480sqm block..."',
  '',
  'VOCABULARY REGISTER',
  '- Plain English. Avoid jargon — both architectural and real estate. Just',
  "  describe what's there.",
  '- "Big lounge room" not "expansive living domain".',
  '- "Renovated bathroom" not "fully appointed wet area".',
  '- Material specifics where they help (Caesarstone, ducted air-con,',
  '  timber-look flooring) but never for show.',
  '',
  'SENTENCE PACING',
  '- Short. Most sentences under 15 words. Compound sentences only when the',
  '  meaning is clearer that way.',
  '- Active voice always.',
  '',
  'FORBIDDEN PATTERNS',
  '- "stunning", "must inspect", "do not miss", "modern living"',
  '- "boasts", "nestled", "prime location", "executive"',
  '- exclamation marks (zero tolerance)',
  '- false elevation: "presented to perfection", "showpiece"',
  '',
  'ENCOURAGED PATTERNS',
  '- Concrete features: "ducted air-conditioning throughout", "secure',
  '  parking for one car", "courtyard pavers, easy upkeep"',
  '- Practical orientation: "north-facing balcony", "morning-sun kitchen"',
  '- Honest framing: "renovated 2019" (not "recently refurbished"),',
  '  "shared driveway" (not "private access")',
  '',
  'READING-GRADE TARGET',
  '- Flesch-Kincaid 6-8. Reads as comfortably as a well-written news brief.',
  '',
  'WORD-COUNT TARGET',
  '- Master listing body 350-500 words across 3-4 paragraphs.',
  '- Per-image listing_copy.paragraphs: 80-140 words. Headline: 5-8 words.',
  '',
  'EXAMPLE PROPERTY THIS VOICE FITS',
  '- Entry-level unit, investor-grade two-bedroom, student rental, ex-Housing',
  '  Commission cottage, suburban first-home stock.',
].join('\n');

export function voiceAnchorBlock(opts: VoiceAnchorOpts): string {
  if (opts.override && opts.override.trim().length > 0) {
    return [
      'VOICE ANCHOR — CUSTOM OVERRIDE',
      '',
      'The operator has supplied a voice rubric for this listing. Apply it',
      'verbatim:',
      '',
      '  ' + opts.override.trim(),
      '',
      'Forbidden patterns from the standard tier rubric still apply',
      '(no "stunning", "must inspect", "boasts", "nestled", "prime location",',
      'no exclamation marks).',
      `Reading-grade and word-count targets default to the ${opts.tier} tier band`,
      'unless the override specifies otherwise.',
    ].join('\n');
  }
  switch (opts.tier) {
    case 'premium':
      return PREMIUM_RUBRIC_TEXT;
    case 'standard':
      return STANDARD_RUBRIC_TEXT;
    case 'approachable':
      return APPROACHABLE_RUBRIC_TEXT;
  }
}

/**
 * Sydney typology primer — light version (W11.7.9 lite).
 * 100 words on the dominant Sydney residential periods + materials so the
 * model anchors `style_archetype` / `era_hint` / scene-setting prose against
 * Sydney-specific architecture rather than generic real estate prose.
 */
export const SYDNEY_PRIMER_BLOCK = [
  'SYDNEY ARCHITECTURAL PRIMER (light)',
  '',
  'When identifying style_archetype and era_hint, anchor against the dominant',
  'Sydney residential typologies:',
  '- Federation (c.1890-1915): red-brick, terracotta tile, leadlight, fretwork,',
  '  bullnose verandahs, ornate ceiling roses.',
  '- Inter-war (c.1915-1940): California Bungalow, Spanish Mission, Tudor revival;',
  '  rendered brick, gable roofs, casement windows.',
  '- Post-war (c.1945-1965): brick veneer cottages, fibro on Sydney clay; Hardie',
  '  weatherboard, terracotta hipped roofs, low-pitched roof lines.',
  '- Mid-century / Sydney School (c.1955-1975): Murcutt-influenced timber and',
  '  glass, raked ceilings, bagged brick, courtyard plans.',
  '- Project home (c.1975-2005): Henley/Beechwood/Clarendon templates, double-',
  '  brick facades, terracotta tile, pitched roofs, formal-front + open-plan-rear.',
  '- Contemporary (2005-): rendered brick, Colorbond, full-height glazing, raked',
  '  flat roofs, indoor-outdoor pavilion plans.',
  '',
  'Sydney-specific materials worth naming when visible: face brick (multi-hue),',
  'Colorbond (Surfmist / Monument / Basalt), Caesarstone, terracotta tile,',
  'spotted gum / blackbutt / Tasmanian oak floors, Hills Hoist clothesline,',
  'jacaranda / frangipani in front yard, blueswimstone / Castlemaine slate.',
].join('\n');

export const SYDNEY_PRIMER_BLOCK_VERSION = 'v1.0';

/**
 * Self-critique block — appended to Stage 1 + Stage 4 prompts.
 * Master-class enrichment lite (W11.7.9). Three lightest-touch wins:
 *   1. Self-critique (re-read as senior editor reviewing junior)
 *   2. Failure-mode constraints (don't fabricate)
 *   3. (Sydney primer is separate, injected only in system prompt)
 */
export const SELF_CRITIQUE_BLOCK = [
  'SELF-CRITIQUE (apply before returning the JSON)',
  '',
  'Before emitting your output, re-read your draft as if you were a senior',
  "architectural photo editor reviewing a junior's submission.",
  '',
  '1. For each entry in `key_elements`, ask: "could this phrase appear in any',
  '   generic real estate listing?" If yes, replace it with something specific',
  '   to this image — name the material, the period, the treatment, the count.',
  '',
  '2. Verify every architectural claim is image-grounded. If you cannot point',
  '   to the visual evidence for a claim, remove the claim. Do not infer a',
  '   period unless the building genuinely shows it.',
  '',
  '3. For listing_copy: re-read against the voice anchor rubric. If a forbidden',
  '   pattern slipped in ("stunning", "must inspect", "boasts", "nestled",',
  '   exclamation marks), rewrite the sentence.',
  '',
  '4. Apply the failure-mode constraint: if a feature is implied but not',
  '   visible, say "implied" or "uncertain" or omit. Never describe what is not',
  '   in the frame. Do not fabricate periods, styles, or measurements. If you',
  '   are uncertain about era_hint or style_archetype, set them to',
  '   "uncertain provenance" rather than guessing.',
].join('\n');

export const SELF_CRITIQUE_BLOCK_VERSION = 'v1.0';
