/**
 * roomTypesFromDb.ts — Wave 11.6.7 P1-3 dynamic prompt block.
 *
 * Replaces the static `roomTypeTaxonomy.ts` block with a DB-driven version
 * that reads `shortlisting_room_types` (admin-editable). Cached 60s in-memory
 * so we don't hammer the DB across the per-image Stage 1 fan-out.
 *
 * Fallback: when the DB query errors OR returns zero active rows, falls back
 * to the static taxonomy block so Stage 1 still works.
 *
 * Block-versioned: ROOM_TYPES_FROM_DB_BLOCK_VERSION for DB-sourced rows;
 * ROOM_TYPES_FROM_DB_FALLBACK_VERSION for static fallback (audit can tell).
 *
 * Spec: docs/WAVE_7_BACKLOG.md L183-201.
 */

import { getAdminClient } from '../../supabase.ts';
import { roomTypeTaxonomyBlock } from './roomTypeTaxonomy.ts';

export const ROOM_TYPES_FROM_DB_BLOCK_VERSION = 'v1.0';
export const ROOM_TYPES_FROM_DB_FALLBACK_VERSION = 'v1.0_fallback';

interface RoomTypeRow {
  key: string;
  display_name: string;
  description: string | null;
  detection_hints: string[] | null;
  category: string | null;
}

interface CacheEntry {
  expiresAt: number;
  text: string;
  version: string;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

export function _resetRoomTypesFromDbCache(): void {
  cache = null;
}

export interface RoomTypesFromDbOpts {
  cacheTtlMs?: number;
}

export async function roomTypesFromDb(
  opts: RoomTypesFromDbOpts = {},
): Promise<{ text: string; version: string }> {
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return { text: cache.text, version: cache.version };
  }

  let text: string;
  let version: string;
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('shortlisting_room_types')
      .select('key, display_name, description, detection_hints, category')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('key', { ascending: true });

    if (error) {
      console.warn(
        `[roomTypesFromDb] query failed (${error.message}) — falling back to static taxonomy`,
      );
      text = roomTypeTaxonomyBlock();
      version = ROOM_TYPES_FROM_DB_FALLBACK_VERSION;
    } else {
      const rows = (data || []) as RoomTypeRow[];
      if (rows.length === 0) {
        console.warn(
          '[roomTypesFromDb] zero active rows — falling back to static taxonomy',
        );
        text = roomTypeTaxonomyBlock();
        version = ROOM_TYPES_FROM_DB_FALLBACK_VERSION;
      } else {
        text = renderBlock(rows);
        version = ROOM_TYPES_FROM_DB_BLOCK_VERSION;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[roomTypesFromDb] unexpected error (${msg}) — falling back to static taxonomy`,
    );
    text = roomTypeTaxonomyBlock();
    version = ROOM_TYPES_FROM_DB_FALLBACK_VERSION;
  }

  cache = { expiresAt: now + ttl, text, version };
  return { text, version };
}

export function renderBlock(rows: RoomTypeRow[]): string {
  const sortedKeys = rows.map((r) => r.key);
  const taxonomyLine = sortedKeys.join(' | ');

  const lines: string[] = [
    'ROOM TYPE TAXONOMY (use exactly these values):',
    taxonomyLine,
    '',
  ];

  const byCat = new Map<string, RoomTypeRow[]>();
  for (const r of rows) {
    const cat = r.category || 'other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(r);
  }

  const knownOrder = [
    'interior_living',
    'interior_private',
    'interior_circulation',
    'interior_special',
    'utility',
    'exterior_living',
    'exterior_facade',
    'aerial',
    'reference',
    'detail',
    'lifestyle',
    'other',
  ];
  const orderedCats = [
    ...knownOrder.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !knownOrder.includes(c)).sort(),
  ];

  lines.push('Reference detail by category:');
  for (const cat of orderedCats) {
    const catRows = byCat.get(cat)!;
    lines.push('');
    lines.push(`[${cat}]`);
    for (const r of catRows) {
      const desc = (r.description || '').trim();
      const hints = Array.isArray(r.detection_hints) && r.detection_hints.length > 0
        ? ` Hints: ${r.detection_hints.join(', ')}.`
        : '';
      const descPart = desc ? ` — ${desc}` : '';
      lines.push(`- ${r.key} (${r.display_name})${descPart}${hints}`);
    }
  }

  lines.push('');
  lines.push(
    'Note on living_secondary (spec L18): Use for upstairs lounges, sitting rooms, rumpus rooms, and secondary living zones on different floors from the main open-plan area. These are NOT near-duplicates of living_room — they are physically distinct rooms that happen to share a function. Misclassifying an upstairs lounge as living_room causes it to be culled as a near-duplicate downstream — use living_secondary instead.',
  );

  return lines.join('\n');
}
