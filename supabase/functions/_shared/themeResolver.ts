/**
 * themeResolver.ts
 * ─────────────────
 * Pure-logic helpers for the drone theme inheritance chain.
 *
 * Resolution chain (highest → lowest priority):
 *   1. person       — primary_contact_person_id of the project
 *   2. organisation — agency_id of the project (FlexStudios calls "organisations" agencies)
 *   3. brand        — forward-compat (skipped in v1)
 *   4. system       — FlexMedia default (one row, owner_kind='system', is_default=true)
 *
 * Field-level merge: deep merge per-key, higher priority overrides lower. Nested
 * objects (e.g. anchor_line, poi_label) merge recursively so setting one nested
 * field at person level does NOT wipe sibling fields inherited from org/system.
 *
 * Arrays are treated as scalar values (replaced wholesale, not merged) — same
 * behaviour as Object.assign / Lodash merge. Theme arrays (output_variants,
 * safety_rules) are intentional whole-list overrides.
 *
 * No HTTP, no Supabase deps — keep this file pure for fast Deno test runs.
 */

export type OwnerKind = 'system' | 'person' | 'organisation' | 'brand';

export interface ThemeRow {
  id: string;
  name: string;
  owner_kind: OwnerKind;
  owner_id: string | null;
  config: Record<string, unknown>;
  version: number;
  is_default: boolean;
  status: string;
}

export interface SourceChainEntry {
  owner_kind: OwnerKind;
  theme_id: string;
  theme_name: string;
}

export interface ResolveResult {
  resolved_config: Record<string, unknown>;
  source_chain: SourceChainEntry[];
  /**
   * Per-top-level-key map: which level contributed the (possibly-merged) value.
   * For nested objects this reports the highest-priority level that touched
   * any sub-field, since the merged object is a synthesis of multiple levels.
   */
  inheritance_diff: Record<string, OwnerKind>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Deep merge two plain objects. `higher` wins for scalar collisions. Arrays
 * are replaced wholesale (not merged element-wise). Returns a new object —
 * inputs are not mutated.
 */
export function deepMerge(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...lower };
  for (const [key, hv] of Object.entries(higher)) {
    if (hv === undefined) continue; // explicit undefined ⇒ no override
    const lv = out[key];
    if (isPlainObject(lv) && isPlainObject(hv)) {
      out[key] = deepMerge(lv, hv);
    } else {
      out[key] = hv;
    }
  }
  return out;
}

/**
 * Merge an ordered array of theme configs.
 * Order: lowest priority first, highest last. Standard left-fold deep merge.
 */
export function mergeConfigChain(
  configs: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return configs.reduce<Record<string, unknown>>(
    (acc, cfg) => deepMerge(acc, cfg || {}),
    {},
  );
}

/**
 * Compute the inheritance_diff: for each top-level key in the resolved config,
 * report the HIGHEST-PRIORITY level that contributed any sub-field.
 *
 * `chain` is ordered lowest priority first (system) → highest (person) — matches
 * the order we feed mergeConfigChain. We walk it back-to-front so the first hit
 * for each key is the highest-priority contributor.
 */
export function buildInheritanceDiff(
  resolved: Record<string, unknown>,
  chain: Array<{ owner_kind: OwnerKind; config: Record<string, unknown> }>,
): Record<string, OwnerKind> {
  const diff: Record<string, OwnerKind> = {};
  for (const key of Object.keys(resolved)) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const cfg = chain[i].config || {};
      if (Object.prototype.hasOwnProperty.call(cfg, key)) {
        diff[key] = chain[i].owner_kind;
        break;
      }
    }
  }
  return diff;
}

/**
 * Compute a shallow diff between prior and next configs — set of changed top-
 * level keys plus, for plain objects, recursive sub-key diffs. Used to populate
 * drone_theme_revisions.diff so historic diffs are inspectable.
 */
export function computeConfigDiff(
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  const allKeys = new Set([...Object.keys(prior || {}), ...Object.keys(next || {})]);
  for (const key of allKeys) {
    const a = prior?.[key];
    const b = next?.[key];
    if (a === b) continue;
    if (isPlainObject(a) && isPlainObject(b)) {
      const sub = computeConfigDiff(a, b);
      if (Object.keys(sub).length > 0) diff[key] = sub;
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      diff[key] = { from: a ?? null, to: b ?? null };
    }
  }
  return diff;
}

/**
 * Build the resolved config + source_chain + inheritance_diff from a list of
 * themes already pulled from the DB in chain order (highest priority first —
 * person, then org, then brand, then system).
 *
 * The DB-fetching half lives in the Edge Function; this fn is pure so tests
 * can hit it directly without HTTP/Supabase.
 */
export function resolveFromChain(themes: ThemeRow[]): ResolveResult {
  // Reverse to lowest-first for the merge fold.
  const ordered = [...themes].reverse();
  const configs = ordered.map((t) => (t.config || {}) as Record<string, unknown>);
  const resolved = mergeConfigChain(configs);
  const source_chain: SourceChainEntry[] = themes.map((t) => ({
    owner_kind: t.owner_kind,
    theme_id: t.id,
    theme_name: t.name,
  }));
  const inheritance_diff = buildInheritanceDiff(
    resolved,
    ordered.map((t) => ({ owner_kind: t.owner_kind, config: (t.config || {}) as Record<string, unknown> })),
  );
  return { resolved_config: resolved, source_chain, inheritance_diff };
}
