/**
 * finalsFilenameParser.ts — pure parser for editor-delivered final filenames.
 *
 * Extracts the camera "stem" (canonical group identifier) + variant index
 * from an editor's delivered file. Lives here so we can unit test it
 * independently of the finals-watcher edge function (which has Dropbox + DB
 * side effects).
 *
 * Used by:
 *   - shortlisting-finals-watcher (Phase 8 B4) to compute variant_count per
 *     stem from a batch of file paths arriving in Photos/Finals/.
 *
 * Real-world filename patterns we need to parse:
 *
 *   IMG_5620.jpg            → stem='IMG_5620',     variantIndex=1 (base only)
 *   IMG_5620-2.jpg          → stem='IMG_5620',     variantIndex=2
 *   IMG_5620-2-2.jpg        → stem='IMG_5620',     variantIndex=3 (numeric chain)
 *   IMG_5620_HDR.jpg        → stem='IMG_5620',     variantIndex=2 (named tag)
 *   IMG_5620-vs.jpg         → stem='IMG_5620',     variantIndex=2 (letter tag)
 *   IMG_5620 (copy).jpg     → stem='IMG_5620',     variantIndex=2 (Finder paren)
 *   IMG_5620-Edit.jpg       → stem='IMG_5620',     variantIndex=2 (named edit)
 *
 *   DSC_1234.jpg            → stem='DSC_1234',     variantIndex=1 (Nikon)
 *   _DSC1234.jpg            → stem='_DSC1234',     variantIndex=1 (Nikon alt)
 *   DSC04567.jpg            → stem='DSC04567',     variantIndex=1 (Sony, no separator)
 *   DSCF0987.jpg            → stem='DSCF0987',     variantIndex=1 (Fujifilm)
 *   KELV4091.jpg            → stem='KELV4091',     variantIndex=1 (generic)
 *
 * Burst 2 H1 generalised the original Canon-only regex to cover Nikon
 * underscore conventions. The current regex matches:
 *   optional leading underscore + letters + optional internal underscore + digits
 */

const VARIANT_FILENAME_RE =
  /^(?<stem>_?[A-Za-z]+_?\d+)(?<suffix>[^.]*)\.(?:jpg|jpeg|png|webp)$/i;

export interface ParsedFinal {
  /** Canonical camera stem — matches the bracket group's delivery_reference_stem. */
  stem: string;
  /** Suffix between stem and extension. Empty string if base filename. */
  suffix: string;
  /**
   * Variant index — how many distinct variants of the same composition exist.
   *
   *   no suffix               → 1 (just the base file)
   *   any non-numeric suffix  → 2 (e.g. _HDR, -vs, " (copy)", -Edit)
   *   numeric chain -N(-N)*   → segCount + 1 (e.g. -2 → 2; -2-2 → 3)
   */
  variantIndex: number;
}

/**
 * Parse a finals filename. Returns null when the filename doesn't match a
 * camera-stem pattern (e.g. "JobOffer.pdf", "agent_headshot.jpg").
 */
export function parseFinalFilename(basename: string): ParsedFinal | null {
  if (!basename || typeof basename !== 'string') return null;
  const m = basename.match(VARIANT_FILENAME_RE);
  if (!m) return null;
  const stem = m.groups?.stem;
  if (!stem) return null;
  const suffix = m.groups?.suffix ?? '';
  const numericChain = suffix.match(/-\d+/g) || [];
  const variantIndex = numericChain.length > 0
    ? numericChain.length + 1            // numeric chain
    : suffix.length > 0
      ? 2                                // any non-numeric suffix → 2
      : 1;                               // base
  return { stem, suffix, variantIndex };
}

/**
 * Aggregate variant counts across a batch of filenames. Returns a map of
 * stem → max variantIndex seen for that stem.
 *
 * Mirrors the per-stem maximum logic the finals-watcher edge function uses
 * (a single delivery batch may contain IMG_5620.jpg AND IMG_5620-2.jpg AND
 * IMG_5620-2-2.jpg — variantCount for that stem is 3).
 */
export function aggregateVariantCounts(filenames: string[]): Map<string, number> {
  const variantsByStem = new Map<string, number>();
  for (const name of filenames) {
    const parsed = parseFinalFilename(name);
    if (!parsed) continue;
    const cur = variantsByStem.get(parsed.stem) || 0;
    if (parsed.variantIndex > cur) {
      variantsByStem.set(parsed.stem, parsed.variantIndex);
    }
  }
  return variantsByStem;
}
