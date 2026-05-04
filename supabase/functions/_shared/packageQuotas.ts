/**
 * packageQuotas — resolve a project/round's package into per-quota_bucket
 * deliverable counts that the shortlisting engine should aim for.
 *
 * Replaces the static slot lattice (`shortlisting_slot_definitions`) as the
 * source of truth for "how many images should the engine deliver?".  The
 * package row already carries the deliverable contract on its `products`
 * JSONB column (one row per `packages.products[].quantity`); this resolver
 * just classifies each product into a quota_bucket the engine knows how to
 * fill, so a "Dusk Video Package" automatically yields:
 *
 *   { sales_images: 25, dusk_images: 4 }
 *
 * — without any per-package recipe configuration.
 *
 * Out-of-scope products (Drone, Floorplan, Video) are returned in
 * `non_shortlisting_products` so callers can audit / surface them in the UI
 * but do NOT affect the shortlist quota.
 *
 * Defaults & error handling:
 *   - Missing package row → returns DEFAULT_QUOTAS (sales_images = ceiling).
 *   - Unrecognised product_name → captured in `unknown_products[]` warning
 *     so future product additions surface visibly instead of silently
 *     dropping deliverables.
 *
 * Used by:
 *   - shortlisting-shape-d-stage4 (Stage 4 quota injection into prompt)
 *   - any future "engine deliverable preview" UI
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

export type QuotaBucket =
  | 'sales_images'   // standard daytime interior+exterior listing photos
  | 'dusk_images'    // dusk / twilight exterior shots — distinct quota
  | 'aerial_images'; // drone-stills (treated as a separate bucket for now;
                     // most workflows route these through the drone pipeline)

export type PackageQuotas = Partial<Record<QuotaBucket, number>>;

export interface QuotaResolution {
  /** Per-bucket counts the shortlisting engine should aim to fill. */
  quotas: PackageQuotas;
  /** Total shortlistable images across all buckets — convenient sanity cap. */
  total: number;
  /** Products on the package that don't go through shortlisting (drone,
   *  floorplan, video, etc.).  Surfaced for transparency only. */
  non_shortlisting_products: Array<{ product_name: string; quantity: number }>;
  /** Product names we couldn't classify.  Quantity is dropped from the quota
   *  but tracked so ops can spot a mis-named product in the matrix. */
  unknown_products: Array<{ product_name: string; quantity: number }>;
  /** Source — for audit / debugging.  'package_products' is the canonical
   *  path; 'fallback_ceiling' is what we fall back to when the package row
   *  is unavailable or doesn't list shortlistable products. */
  source: 'package_products' | 'fallback_ceiling';
}

/**
 * Map product names → quota buckets the engine fills.
 *
 * Add new products here as the price matrix grows.  Anything not in this
 * map is logged as an `unknown_product` warning rather than silently dropped.
 *
 * Match is case-insensitive whole-string.  Aliases share the same bucket.
 */
const PRODUCT_TO_BUCKET: Record<string, QuotaBucket> = {
  // Daytime interior + exterior listing photos
  'sales images': 'sales_images',
  'sales image': 'sales_images',
  'photos': 'sales_images',
  'still images': 'sales_images',
  'photography': 'sales_images',
  'images - day': 'sales_images',

  // Dusk / twilight exterior shots
  'dusk images': 'dusk_images',
  'dusk image': 'dusk_images',
  'twilight images': 'dusk_images',
  'images - dusk': 'dusk_images',

  // Aerial — these are typically scoped through the drone pipeline rather
  // than the regular shortlist, but the bucket exists for future use.
  'aerial images': 'aerial_images',
  'aerial image': 'aerial_images',
};

/**
 * Products that appear on packages but are NOT shortlistable image
 * deliverables (drone-shot quotas go through their own pipeline; floorplans
 * via floorplan_extract; video via the video pipeline).  Listing them
 * explicitly so they don't fall into `unknown_products` warnings.
 */
const NON_SHORTLISTING_PRODUCT_NAMES = new Set([
  'drone shots',
  'drone shot',
  'aerial drone',
  'floor and site plan',
  'floor plan',
  'site plan',
  'siteplan',
  'floorplan',
  'dusk video',
  'cut down reel',
  'video',
  'videography',
  'walkthrough video',
  '3d tour',
  'matterport',
  'social reel',
  'social media reel',
  'cinematic reel',
]);

/**
 * Default quota when no package data is available — give the engine ceiling
 * worth of sales_images and let it self-cap.
 */
function defaultQuotas(ceiling: number): PackageQuotas {
  const safe = Math.max(1, Math.floor(ceiling || 1));
  return { sales_images: safe };
}

/**
 * Resolve quotas for a project's active package.  The round's `package_type`
 * column carries the package NAME (text) so this resolver looks the package
 * row up by name.
 *
 * If multiple packages share the name (shouldn't happen in production but
 * has been observed during seed migrations) we pick the most-recently-
 * updated active one.
 */
export async function resolvePackageQuotasByName(
  admin: SupabaseClient,
  packageName: string,
  fallbackCeiling: number,
): Promise<QuotaResolution> {
  const trimmed = (packageName || '').trim();
  if (!trimmed) {
    return {
      quotas: defaultQuotas(fallbackCeiling),
      total: Math.max(1, Math.floor(fallbackCeiling || 1)),
      non_shortlisting_products: [],
      unknown_products: [],
      source: 'fallback_ceiling',
    };
  }

  const { data: pkg, error } = await admin
    .from('packages')
    .select('id, name, products, is_active, updated_at')
    .ilike('name', trimmed)
    .order('is_active', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(
      `[packageQuotas] lookup failed for name="${trimmed}": ${error.message}` +
        ` — falling back to ceiling`,
    );
    return {
      quotas: defaultQuotas(fallbackCeiling),
      total: Math.max(1, Math.floor(fallbackCeiling || 1)),
      non_shortlisting_products: [],
      unknown_products: [],
      source: 'fallback_ceiling',
    };
  }

  if (!pkg || !Array.isArray((pkg as { products?: unknown }).products)) {
    return {
      quotas: defaultQuotas(fallbackCeiling),
      total: Math.max(1, Math.floor(fallbackCeiling || 1)),
      non_shortlisting_products: [],
      unknown_products: [],
      source: 'fallback_ceiling',
    };
  }

  return classifyProducts(
    (pkg as { products: Array<Record<string, unknown>> }).products,
    fallbackCeiling,
  );
}

/**
 * Classify a packages.products[] array into quota buckets.  Exposed
 * separately so callers that already have the package row in hand (e.g. a
 * batch resolver) can skip the lookup.
 */
export function classifyProducts(
  products: Array<Record<string, unknown>>,
  fallbackCeiling: number,
): QuotaResolution {
  const quotas: PackageQuotas = {};
  const nonShortlisting: Array<{ product_name: string; quantity: number }> = [];
  const unknown: Array<{ product_name: string; quantity: number }> = [];

  for (const p of products) {
    const rawName = typeof p.product_name === 'string' ? p.product_name : '';
    const qty = typeof p.quantity === 'number' && Number.isFinite(p.quantity)
      ? Math.max(0, Math.floor(p.quantity))
      : 0;
    if (!rawName || qty <= 0) continue;

    const norm = rawName.trim().toLowerCase();
    const bucket = PRODUCT_TO_BUCKET[norm];

    if (bucket) {
      quotas[bucket] = (quotas[bucket] ?? 0) + qty;
      continue;
    }

    if (NON_SHORTLISTING_PRODUCT_NAMES.has(norm)) {
      nonShortlisting.push({ product_name: rawName, quantity: qty });
      continue;
    }

    unknown.push({ product_name: rawName, quantity: qty });
  }

  // If after classification we have ZERO shortlistable buckets, fall back
  // to the package_ceiling so the engine doesn't propose 0 images on a
  // mis-classified package.
  const total = Object.values(quotas).reduce((acc, n) => acc + (n ?? 0), 0);
  if (total === 0) {
    return {
      quotas: defaultQuotas(fallbackCeiling),
      total: Math.max(1, Math.floor(fallbackCeiling || 1)),
      non_shortlisting_products: nonShortlisting,
      unknown_products: unknown,
      source: 'fallback_ceiling',
    };
  }

  return {
    quotas,
    total,
    non_shortlisting_products: nonShortlisting,
    unknown_products: unknown,
    source: 'package_products',
  };
}

/** Render a quota set as a single line for prompt injection / logs. */
export function renderQuotaLine(quotas: PackageQuotas): string {
  const parts: string[] = [];
  for (const [bucket, qty] of Object.entries(quotas)) {
    if (typeof qty === 'number' && qty > 0) {
      parts.push(`${qty} ${bucket}`);
    }
  }
  return parts.length > 0 ? parts.join(' + ') : '0 images';
}
