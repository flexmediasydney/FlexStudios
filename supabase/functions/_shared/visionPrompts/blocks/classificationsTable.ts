/**
 * classificationsTable.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Renders Pass 1 classifications as a packed text table — one line per
 * composition, sorted by group_index (capture order). The line format is
 * documented inline so the model can parse it without ambiguity.
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix ALL CLASSIFICATIONS section
 * + the inlined `formatClassificationLine()` helper. Both the helper and this
 * block are exported so other call sites (e.g. the benchmark runner) can reuse
 * the canonical line shape.
 */

import type { Pass2ClassificationRow } from '../../pass2Prompt.ts';

export const CLASSIFICATIONS_TABLE_BLOCK_VERSION = 'v1.0';

export interface ClassificationsTableBlockOpts {
  /** All Pass 1 classifications for the round (one per composition). */
  classifications: Pass2ClassificationRow[];
}

/**
 * Format one classification as a single line (spec §6). Format:
 *
 *   [stem] | [room_type] | [comp_type] | [vantage_point] | C=N L=N T=N A=N avg=N | styled=B io=B | [analysis excerpt 80 chars]
 *
 * - Numbers rounded to one decimal, fall back to "?" when null.
 * - Booleans rendered T/F to keep lines short.
 * - Analysis excerpt is the first 80 chars; trailing whitespace collapsed.
 */
export function formatClassificationLine(c: Pass2ClassificationRow): string {
  const num = (v: number | null): string =>
    v == null ? '?' : (Math.round(v * 10) / 10).toString();
  const bool = (v: boolean | null): string =>
    v === true ? 'T' : v === false ? 'F' : '?';

  const stem = c.stem || `group_${c.group_index}`;
  const room = c.room_type || 'unknown';
  const comp = c.composition_type || 'unknown';
  const vp = c.vantage_point || 'neutral';
  const t = num(c.technical_score);
  const l = num(c.lighting_score);
  const cs = num(c.composition_score);
  const a = num(c.aesthetic_score);
  const avg = num(c.combined_score);

  // Trim + collapse whitespace + cap at 80 chars
  const analysis = (c.analysis || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  // Eligibility badges that materially affect routing — keep ultra-compact
  const badges: string[] = [];
  if (c.eligible_for_exterior_rear) badges.push('eligXR');
  if (c.flag_for_retouching) badges.push('retouch');
  if (c.clutter_severity && c.clutter_severity !== 'none') {
    badges.push(`clutter=${c.clutter_severity}`);
  }
  if (c.is_drone) badges.push('drone');
  const badgeStr = badges.length > 0 ? ` | ${badges.join(' ')}` : '';

  return (
    `${stem} | ${room} | ${comp} | ${vp} | C=${cs} L=${l} T=${t} A=${a} avg=${avg} | ` +
    `styled=${bool(c.is_styled)} io=${bool(c.indoor_outdoor_visible)}${badgeStr} | ${analysis}`
  );
}

export function classificationsTableBlock(
  opts: ClassificationsTableBlockOpts,
): string {
  // Sort by group_index so the model sees them in capture order — same order
  // an editor scrolls through. Stable order also makes diffs across re-runs
  // human-readable.
  const sortedClass = [...opts.classifications].sort(
    (a, b) => a.group_index - b.group_index,
  );
  const classBlockLines = sortedClass.map((c) => formatClassificationLine(c));

  return [
    `ALL CLASSIFICATIONS — FULL SHOOT (${sortedClass.length} compositions, in capture order):`,
    'Format: [stem] | [room_type] | [comp_type] | [vantage_point] | C=composition L=lighting T=technical A=aesthetic avg=combined | styled=T/F io=indoor_outdoor | [optional badges] | [analysis excerpt]',
    '',
    ...classBlockLines,
  ].join('\n');
}
