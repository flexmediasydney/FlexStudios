// Shared utility functions for processTonomoQueue

import { PROCESSOR_VERSION } from './types.ts';
import {
  diffProjectPackages,
  isAddOnly,
  isNoOp,
  applyDiff,
  extractAddedFromNew,
  type ProjectItemsDiff,
  type ProjectProduct,
  type ProjectPackage,
} from './diffTonomoProducts.ts';

// Safe JSON parse with fallback — prevents crashes on corrupt stored JSON
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Multi-appointment & lifecycle helpers
export function trackAppointment(existingIdsJson: string | null, newEventId: string | null) {
  if (!newEventId) return { isNew: false, updatedIds: [] as string[] };
  let ids: string[] = [];
  try { ids = JSON.parse(existingIdsJson || '[]'); } catch { ids = []; }
  const isNew = !ids.includes(newEventId);
  if (isNew) ids = [...ids, newEventId];
  return { isNew, updatedIds: ids };
}

export function determineReviewType(projectStatus: string, _tonomoLifecycle: string, isAdditionalAppointment: boolean, originAction: string) {
  if (projectStatus === 'cancelled') return 'restoration';
  if (projectStatus === 'delivered') return 'reopened_after_delivery';
  if (isAdditionalAppointment) return 'additional_appointment';
  if (originAction === 'rescheduled') return 'rescheduled';
  return 'new_booking';
}

export function stripAddressTail(address: string): string {
  if (!address) return address;
  const parts = address.split(',').map(s => s.trim());
  const STATE_RE = /\b(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\b/i;
  const POSTCODE_RE = /^\d{4}$/;
  const COUNTRY_RE = /^Australia$/i;

  const stripped: string[] = [];
  for (const part of parts) {
    if (COUNTRY_RE.test(part)) continue;
    if (POSTCODE_RE.test(part)) continue;
    if (STATE_RE.test(part)) {
      const cleaned = part
        .replace(/(?:^|\s+)(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, '')
        .trim();
      if (cleaned.length > 0) stripped.push(cleaned);
      break;
    }
    stripped.push(part);
  }
  return stripped.join(', ') || address;
}

export function extractSuburbFromAddress(address: string): string | null {
  if (!address) return null;
  const POSTCODE_RE = /^\d{4}$/;
  const parts = address.split(',').map((s: string) => s.trim());
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const stateMatch = part.match(/\b(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\b/i);
    if (stateMatch) {
      // Strip state (+optional postcode) from end of part. Use (?:^|\s+) to also handle
      // parts that ARE just the state (e.g. "NSW 2010" as its own comma-separated segment).
      const cleaned = part.replace(/(?:^|\s+)(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, '').trim();
      if (cleaned.length > 0 && !POSTCODE_RE.test(cleaned)) return cleaned;
      // State part had no suburb prefix — look at the previous comma-separated part
      if (cleaned.length === 0 && i > 0) {
        const prev = parts[i - 1];
        if (prev && prev.length > 0 && !POSTCODE_RE.test(prev)) return prev;
      }
      break;
    }
  }
  const STATE_RE = /^(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const cleaned = part.replace(/\s+\d{4}$/, '').trim();
    if (cleaned.length > 0 && !STATE_RE.test(cleaned) && !POSTCODE_RE.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

export function detectTierHint(serviceName: string): 'standard' | 'premium' | null {
  if (!serviceName) return null;
  if (/\(s\)\s*$/i.test(serviceName)) return 'standard';
  if (/\(p\)\s*$/i.test(serviceName)) return 'premium';
  return null;
}

export async function resolveBookingFlowTier(
  entities: any,
  bookingFlow: { id: string; name: string; type?: string } | null
): Promise<{ tier: 'standard' | 'premium' | null; isUnmapped: boolean }> {
  if (!bookingFlow?.id) return { tier: null, isUnmapped: false };

  const existing = await entities.TonomoBookingFlowTier
    .filter({ tonomo_flow_id: bookingFlow.id }, null, 1)
    .catch(() => []);

  const record = existing?.[0];

  if (record) {
    await entities.TonomoBookingFlowTier.update(record.id, {
      tonomo_flow_name: bookingFlow.name || record.tonomo_flow_name,
      tonomo_flow_type: bookingFlow.type || record.tonomo_flow_type,
      last_seen_at: new Date().toISOString(),
      seen_count: (record.seen_count || 0) + 1,
    }).catch(() => {});
    return {
      tier: record.pricing_tier || null,
      isUnmapped: !record.pricing_tier,
    };
  }

  await entities.TonomoBookingFlowTier.create({
    tonomo_flow_id: bookingFlow.id,
    tonomo_flow_name: bookingFlow.name || 'Unknown flow',
    tonomo_flow_type: bookingFlow.type || null,
    pricing_tier: null,
    last_seen_at: new Date().toISOString(),
    seen_count: 1,
  }).catch(() => {});

  return { tier: null, isUnmapped: true };
}

export async function resolveProjectTypeFromFlowType(
  entities: any,
  flowType: string | null
): Promise<{ projectTypeId: string | null; projectTypeName: string | null; isUnmapped: boolean }> {
  if (!flowType) return { projectTypeId: null, projectTypeName: null, isUnmapped: false };

  try {
    const mappings = await entities.TonomoProjectTypeMapping
      .list('-created_date', 50)
      .catch(() => []);

    const exactMatch = mappings.find((m: any) =>
      m.tonomo_flow_type?.toLowerCase() === flowType.toLowerCase()
    );
    if (exactMatch?.project_type_id) {
      entities.TonomoProjectTypeMapping.update(exactMatch.id, {
        last_seen_at: new Date().toISOString(),
        seen_count: (exactMatch.seen_count || 0) + 1,
      }).catch(() => {});
      return {
        projectTypeId: exactMatch.project_type_id,
        projectTypeName: exactMatch.project_type_name || null,
        isUnmapped: false,
      };
    }

    const defaultMapping = mappings.find((m: any) => m.is_default && m.project_type_id);
    if (defaultMapping) {
      return {
        projectTypeId: defaultMapping.project_type_id,
        projectTypeName: defaultMapping.project_type_name || null,
        isUnmapped: false,
      };
    }

    const existingUnmapped = mappings.find((m: any) =>
      m.tonomo_flow_type?.toLowerCase() === flowType.toLowerCase() && !m.project_type_id
    );
    if (!existingUnmapped) {
      entities.TonomoProjectTypeMapping.create({
        tonomo_flow_type: flowType,
        project_type_id: null,
        project_type_name: null,
        is_default: false,
        last_seen_at: new Date().toISOString(),
        seen_count: 1,
      }).catch(() => {});
    } else {
      entities.TonomoProjectTypeMapping.update(existingUnmapped.id, {
        last_seen_at: new Date().toISOString(),
        seen_count: (existingUnmapped.seen_count || 0) + 1,
      }).catch(() => {});
    }

    return { projectTypeId: null, projectTypeName: null, isUnmapped: true };
  } catch {
    return { projectTypeId: null, projectTypeName: null, isUnmapped: false };
  }
}

// Role-aware assignment
export function detectBookingTypes(serviceNames: string[]) {
  const names = serviceNames.map((s) => s.toLowerCase());
  const isVideoBooking    = names.some(n => n.includes('video') || n.includes('reel') || n.includes('footage'));
  const isDroneBooking    = names.some(n => n.includes('drone'));
  const isFloorPlanBooking = names.some(n => n.includes('floor') || n.includes('floorplan'));
  const isPhotoBooking    = !isVideoBooking || names.some(n =>
    n.includes('image') || n.includes('photo') || n.includes('sales') || n.includes('rental')
  );
  return { isVideoBooking, isDroneBooking, isFloorPlanBooking, isPhotoBooking };
}

export function assignStaffToProjectFields(resolvedPhotographers: any[], bookingTypes: any) {
  // Each person's default_staff_role determines their project slot.
  // Webhook never sets project_owner — that comes from applyProjectRoleDefaults.
  // Roles not covered by webhook staff are left null for defaults to fill.
  const fields: Record<string, any> = {};

  if (resolvedPhotographers.length === 0) return fields;

  // Map default_staff_role → project field
  const roleToField: Record<string, { idField: string; onsiteField: string | null }> = {
    photographer:     { idField: 'photographer_id',    onsiteField: 'onsite_staff_1_id' },
    videographer:     { idField: 'videographer_id',    onsiteField: 'onsite_staff_2_id' },
    drone_operator:   { idField: 'photographer_id',    onsiteField: 'onsite_staff_1_id' },
    floor_plan:       { idField: 'photographer_id',    onsiteField: 'onsite_staff_1_id' },
  };

  const assigned = new Set<string>();

  // Pass 1: assign anyone with a declared default_staff_role
  for (const person of resolvedPhotographers) {
    const mapping = person.role ? roleToField[person.role] : null;
    if (mapping && !fields[mapping.idField]) {
      fields[mapping.idField] = person.userId;
      // Webhook staff are always users, not teams — set type explicitly
      const typeField = mapping.idField.replace('_id', '_type');
      fields[typeField] = 'user';
      if (mapping.onsiteField) fields[mapping.onsiteField] = person.userId;
      assigned.add(person.userId);
    }
  }

  // Pass 2: anyone without a role (or whose slot was already taken) — use booking type
  for (const person of resolvedPhotographers) {
    if (assigned.has(person.userId)) continue;
    if (bookingTypes.isVideoBooking && !fields.videographer_id) {
      fields.videographer_id   = person.userId;
      fields.videographer_type = 'user';
      fields.onsite_staff_2_id = person.userId;
    } else if (!fields.photographer_id) {
      fields.photographer_id   = person.userId;
      fields.photographer_type = 'user';
      fields.onsite_staff_1_id = person.userId;
    }
    assigned.add(person.userId);
  }

  return fields;
}

// Deduplicate products/packages on a project.
// 1. Dedup identical product_id / package_id entries.
// 2. Remove standalone products that are already included inside a resolved package
//    (package takes precedence as a bundled offering). If the standalone qty is higher
//    than the package's included qty, keep the higher qty on the package's nested entry.
export function deduplicateProjectItems(autoProducts: any[], autoPackages: any[], _allProducts: any[], allPackages: any[]) {
  // --- Dedup identical IDs first ---
  const seenProducts = new Map<string, any>();
  for (const p of autoProducts) {
    const existing = seenProducts.get(p.product_id);
    if (!existing || (p.quantity || 1) > (existing.quantity || 1)) {
      seenProducts.set(p.product_id, p);
    }
  }
  const seenPackages = new Map<string, any>();
  for (const p of autoPackages) {
    if (!seenPackages.has(p.package_id)) {
      seenPackages.set(p.package_id, p);
    }
  }

  // --- Cross-reference: collect all product IDs included in resolved packages ---
  // Map of product_id → max included quantity across all packages
  const packageProductQty = new Map<string, number>();
  for (const ap of seenPackages.values()) {
    const pkgDef = allPackages.find((pk: any) => pk.id === ap.package_id);
    if (!pkgDef?.products || !Array.isArray(pkgDef.products)) continue;
    for (const nested of pkgDef.products) {
      const pid = nested.product_id;
      if (!pid) continue;
      const inclQty = nested.quantity || 1;
      packageProductQty.set(pid, Math.max(packageProductQty.get(pid) || 0, inclQty));
    }
  }

  // Remove standalone products already covered by a package.
  // ALWAYS add the product to the package's project-level products array so that
  // downstream task generation (syncProjectTasksFromProducts) can see every product
  // in the package. Use the higher of standalone vs package-definition quantity.
  for (const [productId, standaloneItem] of seenProducts) {
    if (packageProductQty.has(productId)) {
      const standaloneQty = standaloneItem.quantity || 1;
      const packageQty = packageProductQty.get(productId)!;
      const finalQty = Math.max(standaloneQty, packageQty);
      for (const ap of seenPackages.values()) {
        const pkgDef = allPackages.find((pk: any) => pk.id === ap.package_id);
        const nestedMatch = (pkgDef?.products || []).find((n: any) => n.product_id === productId);
        if (nestedMatch) {
          if (!ap.products) ap.products = [];
          const existingOverride = ap.products.find((p: any) => p.product_id === productId);
          if (existingOverride) {
            existingOverride.quantity = Math.max(existingOverride.quantity || 1, finalQty);
          } else {
            ap.products.push({ product_id: productId, quantity: finalQty });
          }
          break;
        }
      }
      seenProducts.delete(productId);
    }
  }

  return {
    products: Array.from(seenProducts.values()),
    packages: Array.from(seenPackages.values()),
  };
}

/**
 * Lock-aware reconciliation of a Tonomo product/package rebuild against a
 * project that may have manually_overridden_fields / per-line locks.
 *
 * Inputs:
 *  - project: the existing project row
 *  - proposedProducts / proposedPackages: the deduped "after" state from
 *    resolveProductsFromTiers + resolveProductsFromWorkDays
 *  - allProducts / allPackages: product/package catalog (for name resolution
 *    and dedup inside merges)
 *  - context: { queueRowId, webhookLogId, eventType } — threaded through for
 *    audit purposes when stashing a pending delta
 *
 * Outputs (as a subset of an "updates" object ready to merge into Project.update):
 *  - decision: 'no_lock_apply' | 'noop' | 'auto_merge' | 'stash_for_review'
 *  - updates: the field patch for this decision (e.g. products/packages for
 *    a merge, or tonomo_pending_delta for a stash)
 *  - reviewReason: human-readable reason string (for decision='stash_for_review')
 *  - activityDescription: string for writeProjectActivity (for logging)
 *  - diff: the computed diff (always populated when lock path is taken)
 */
export interface ReconcileContext {
  queueRowId?: string | null;
  webhookLogId?: string | null;
  eventType?: string | null;
}

export interface ReconcileResult {
  decision: 'no_lock_apply' | 'noop' | 'auto_merge' | 'stash_for_review';
  updates: Record<string, any>;
  reviewReason?: string;
  activityDescription?: string;
  diff?: ProjectItemsDiff;
  summary?: string;
}

export function reconcileProductsPackagesAgainstLock(
  project: any,
  proposedProducts: ProjectProduct[],
  proposedPackages: ProjectPackage[],
  allProducts: any[],
  allPackages: any[],
  context: ReconcileContext = {},
): ReconcileResult {
  const overriddenFields = safeJsonParse(project?.manually_overridden_fields, [] as string[]);
  const legacyLock = overriddenFields.includes('products') || overriddenFields.includes('packages');
  const lockedProductIds = new Set<string>(
    safeJsonParse<string[]>(project?.manually_locked_product_ids, []) || []
  );
  const lockedPackageIds = new Set<string>(
    safeJsonParse<string[]>(project?.manually_locked_package_ids, []) || []
  );

  const hasAnyLock = legacyLock || lockedProductIds.size > 0 || lockedPackageIds.size > 0;

  // No lock at all → just overwrite with proposed state (legacy behavior preserved).
  if (!hasAnyLock) {
    if ((proposedProducts?.length || 0) === 0 && (proposedPackages?.length || 0) === 0) {
      return { decision: 'noop', updates: {} };
    }
    return {
      decision: 'no_lock_apply',
      updates: {
        products: proposedProducts,
        packages: proposedPackages,
        products_auto_applied: true,
        products_needs_recalc: true,
      },
    };
  }

  // Lock path — compute diff for visibility.
  const diff = diffProjectPackages(
    project?.products, project?.packages,
    proposedProducts, proposedPackages,
    allProducts, allPackages,
  );

  // Prune additions that target a per-line locked id — the user intentionally
  // blocked that specific line, so respect it even on add-only merges.
  const prunedAddedProducts = diff.added_products.filter(d => !lockedProductIds.has(d.product_id));
  const prunedAddedPackages = diff.added_packages.filter(d => !lockedPackageIds.has(d.package_id));
  const diffForApply: ProjectItemsDiff = {
    ...diff,
    added_products: prunedAddedProducts,
    added_packages: prunedAddedPackages,
  };

  if (isNoOp(diffForApply) && isNoOp(diff)) {
    return { decision: 'noop', updates: {}, diff };
  }

  // Only additions (that aren't themselves locked out) → safe auto-merge.
  if (isAddOnly(diffForApply)) {
    const { addedProducts, addedPackages } = extractAddedFromNew(
      proposedProducts, proposedPackages, diffForApply,
    );
    const merged = applyDiff(
      project?.products || [], project?.packages || [],
      addedProducts, addedPackages,
    );
    const addedSummary = [
      prunedAddedProducts.length > 0 ? `${prunedAddedProducts.length} product(s): ${prunedAddedProducts.map(d => d.product_name).join(', ')}` : null,
      prunedAddedPackages.length > 0 ? `${prunedAddedPackages.length} package(s): ${prunedAddedPackages.map(d => d.package_name).join(', ')}` : null,
    ].filter(Boolean).join(' and ');
    return {
      decision: 'auto_merge',
      diff: diffForApply,
      updates: {
        products: merged.products,
        packages: merged.packages,
        products_needs_recalc: true,
        tonomo_pending_delta: null, // clear any prior stash — we just applied
      },
      activityDescription: `Tonomo added ${addedSummary} (add-only, auto-merged despite override lock).`,
      summary: `auto-merged: added ${prunedAddedProducts.length} product(s), ${prunedAddedPackages.length} package(s)`,
    };
  }

  // Destructive (removal or qty change) → stash for manual review.
  const stash = {
    detected_at: new Date().toISOString(),
    source_queue_id: context.queueRowId || null,
    source_webhook_log_id: context.webhookLogId || null,
    source_event_type: context.eventType || null,
    before: {
      products: project?.products || [],
      packages: project?.packages || [],
    },
    after: {
      products: proposedProducts,
      packages: proposedPackages,
    },
    diff,
    safe_to_auto_apply: false,
    auto_applied_at: null,
  };
  const reviewReason = `Tonomo wants to change products/packages but manually-overridden lock is on. ${diff.added_products.length} added, ${diff.removed_products.length} removed, ${diff.qty_changed.length} qty change(s). Review required.`;
  const activityDescription = `Tonomo pending delta stashed: +${diff.added_products.length}/−${diff.removed_products.length} products, ${diff.qty_changed.length} qty changes, +${diff.added_packages.length}/−${diff.removed_packages.length} packages.`;
  return {
    decision: 'stash_for_review',
    diff,
    updates: {
      // Pass the object directly — PostgREST encodes it as a proper jsonb
      // object. Prior version used JSON.stringify() which produced a nested
      // "string-in-jsonb" that needed double-parsing.
      tonomo_pending_delta: stash,
    },
    reviewReason,
    activityDescription,
    summary: 'stashed pending delta (destructive change while lock on)',
  };
}

// Resolution helpers
export async function resolveProductsFromTiers(entities: any, tiers: any[], allMappings: any[]) {
  if (!tiers || tiers.length === 0) {
    return { autoProducts: [], autoPackages: [], mappingGaps: [] as any[], allConfirmed: true };
  }

  const [allProducts, allPackages] = await Promise.all([
    entities.Product.list('-updated_date', 500).catch(() => []),
    entities.Package.list('-updated_date', 200).catch(() => []),
  ]);

  const autoProducts: any[] = [];
  const autoPackages: any[] = [];
  const mappingGaps: any[] = [];

  for (const tier of tiers) {
    const serviceId = tier.serviceId;
    const serviceName = tier.serviceName || 'Unknown service';
    const selectedTierName = tier.selected?.name || '';
    const qty = extractQtyFromTierName(selectedTierName);

    if (!serviceId) {
      mappingGaps.push({ serviceId: 'unknown', serviceName });
      continue;
    }

    const confirmedService = allMappings.find(
      (m: any) => m.tonomo_id === serviceId &&
             m.mapping_type === 'service' &&
             m.is_confirmed === true &&
             m.flexmedia_entity_id
    );

    const confirmedPackage = allMappings.find(
      (m: any) => m.tonomo_id === serviceId &&
             m.mapping_type === 'package' &&
             m.is_confirmed === true &&
             m.flexmedia_entity_id
    );

    if (confirmedService) {
      const product = allProducts.find((p: any) => p.id === confirmedService.flexmedia_entity_id);
      const finalQty = clampQty(qty, product);
      const tierHint = detectTierHint(serviceName);

      if (tierHint && !confirmedService.detected_tier_hint) {
        entities.TonomoMappingTable.update(confirmedService.id, {
          detected_tier_hint: tierHint,
        }).catch(() => {});
      }

      autoProducts.push({
        product_id: confirmedService.flexmedia_entity_id,
        quantity: finalQty,
        tier_hint: tierHint || null,
      });

    } else if (confirmedPackage) {
      autoPackages.push({
        package_id: confirmedPackage.flexmedia_entity_id,
        quantity: 1,
        products: [],
      });

    } else {
      mappingGaps.push({ serviceId, serviceName });

      const nameMatchProduct = allProducts.find(
        (p: any) => p.name?.toLowerCase() === serviceName.toLowerCase() && p.is_active
      );
      const nameMatchPackage = allPackages.find(
        (p: any) => p.name?.toLowerCase() === serviceName.toLowerCase()
      );
      const nameMatch = nameMatchProduct || nameMatchPackage;
      const entityType = nameMatchProduct ? 'Product' : nameMatchPackage ? 'Package' : 'Product';
      const mappingType = nameMatchPackage ? 'package' : 'service';

      await upsertMappingSuggestion(
        entities,
        serviceId,
        serviceName,
        mappingType,
        entityType,
        nameMatch?.id || null,
        nameMatch?.name || null,
        nameMatch ? 'high' : 'low',
        allMappings
      );
    }
  }

  const seenProducts = new Set();
  const dedupedProducts = autoProducts.filter(p => {
    if (seenProducts.has(p.product_id)) return false;
    seenProducts.add(p.product_id);
    return true;
  });

  const seenPackages = new Set();
  const dedupedPackages = autoPackages.filter(p => {
    if (seenPackages.has(p.package_id)) return false;
    seenPackages.add(p.package_id);
    return true;
  });

  return {
    autoProducts: dedupedProducts,
    autoPackages: dedupedPackages,
    mappingGaps,
    allConfirmed: mappingGaps.length === 0,
  };
}

/**
 * Resolve workDays (weekend/day-specific fees) from Tonomo payload to FlexMedia products.
 *
 * Tonomo uses JS getDay() convention: 0=Sunday, 6=Saturday. We also accept 7=Sunday (ISO 8601) defensively.
 * Each entry: { dayOfWeek, fee, feeName, id }
 *
 * Matching strategy (in order):
 *  1. tonomo_mapping_tables entry with mapping_type='workday_fee' and tonomo_id=feeName (confirmed)
 *  2. Fallback: dayOfWeek-based default mapping (Saturday Surcharge / Sunday Surcharge products)
 *
 * Uses Tonomo's actual `fee` as the line-item price via custom_price override (not the catalogue base_price).
 */
const DEFAULT_WORKDAY_PRODUCTS: Record<string, string> = {
  // dayOfWeek -> product_id
  '0': 'b2e68671-1d70-4bc2-b4c5-17614be4d7a2', // Sunday (JS convention)
  '6': '30000000-0000-4000-a000-000000000041', // Saturday
  '7': 'b2e68671-1d70-4bc2-b4c5-17614be4d7a2', // Sunday (ISO 8601 defensive)
};

const WORKDAY_FEENAME_FALLBACK: Record<string, string> = {
  // feeName (lowercased) -> product_id
  'saturday fee': '30000000-0000-4000-a000-000000000041',
  'saturday surcharge': '30000000-0000-4000-a000-000000000041',
  'sunday fee': 'b2e68671-1d70-4bc2-b4c5-17614be4d7a2',
  'sunday surcharge': 'b2e68671-1d70-4bc2-b4c5-17614be4d7a2',
};

export async function resolveProductsFromWorkDays(entities: any, workDays: any[], allMappings: any[]) {
  if (!Array.isArray(workDays) || workDays.length === 0) {
    return { autoProducts: [] as any[], mappingGaps: [] as any[], allConfirmed: true };
  }

  const feeEntries = workDays.filter((w: any) => Number(w?.fee) > 0);
  if (feeEntries.length === 0) {
    return { autoProducts: [], mappingGaps: [], allConfirmed: true };
  }

  const autoProducts: any[] = [];
  const mappingGaps: any[] = [];
  const seenFeeNames = new Set<string>();

  for (const w of feeEntries) {
    const feeName = String(w.feeName || '').trim();
    const fee = Number(w.fee);
    const dayOfWeek = w.dayOfWeek;

    // Dedup by feeName (same fee appearing twice in workDays array)
    const dedupKey = `${feeName}:${dayOfWeek}:${fee}`;
    if (seenFeeNames.has(dedupKey)) continue;
    seenFeeNames.add(dedupKey);

    let productId: string | null = null;
    let matchSource: string = '';

    // Priority 1: confirmed mapping table entry
    const confirmed = allMappings.find(
      (m: any) => m.mapping_type === 'workday_fee' &&
                  (m.tonomo_id === feeName || (m.tonomo_label || '').toLowerCase() === feeName.toLowerCase()) &&
                  m.is_confirmed === true &&
                  m.flexmedia_entity_id
    );

    if (confirmed) {
      productId = confirmed.flexmedia_entity_id;
      matchSource = 'mapping_table';

      // Bump seen_count for analytics
      try {
        await entities.TonomoMappingTable.update(confirmed.id, {
          seen_count: (confirmed.seen_count || 0) + 1,
          last_seen_at: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    }

    // Priority 2: feeName fallback (catches cases where mapping table is missing)
    if (!productId) {
      const nameKey = feeName.toLowerCase();
      if (WORKDAY_FEENAME_FALLBACK[nameKey]) {
        productId = WORKDAY_FEENAME_FALLBACK[nameKey];
        matchSource = 'feename_fallback';
      }
    }

    // Priority 3: dayOfWeek fallback
    if (!productId && dayOfWeek !== undefined && dayOfWeek !== null) {
      const dayKey = String(dayOfWeek);
      if (DEFAULT_WORKDAY_PRODUCTS[dayKey]) {
        productId = DEFAULT_WORKDAY_PRODUCTS[dayKey];
        matchSource = 'dayofweek_fallback';
      }
    }

    if (productId) {
      autoProducts.push({
        product_id: productId,
        quantity: 1,
        custom_price: fee, // use Tonomo's actual fee value, not catalogue base_price
        source: 'workday_fee',
        source_note: `${feeName || `Day ${dayOfWeek}`} ($${fee}) [${matchSource}]`,
      });
    } else {
      // No match at all — create a mapping gap so this surfaces in the UI
      mappingGaps.push({
        serviceId: feeName || `workday_${dayOfWeek}`,
        serviceName: feeName || `Day-of-week fee (${dayOfWeek})`,
        type: 'workday_fee',
      });

      // Auto-suggest a mapping based on any name match in the catalogue
      try {
        const allProducts = await entities.Product.list('-updated_date', 500).catch(() => []);
        const match = allProducts.find(
          (p: any) => (p.name || '').toLowerCase().includes((feeName || '').toLowerCase().replace(' fee', ''))
                      && p.category === 'Fees'
        );
        if (match) {
          await upsertMappingSuggestion(
            entities,
            feeName,
            feeName,
            'workday_fee',
            'Product',
            match.id,
            match.name,
            'high',
            allMappings
          );
        }
      } catch { /* non-fatal */ }
    }
  }

  return {
    autoProducts,
    mappingGaps,
    allConfirmed: mappingGaps.length === 0,
  };
}

export async function resolveMappingsMulti(entities: any, { agent, photographers = [], agencyId = null }: any, allMappings: any[]) {
  let agentId = null;
  const resolvedPhotographers: any[] = [];
  const unresolvedPhotographers: string[] = [];
  const mappingGaps: string[] = [];
  let resolvedCount = 0;
  let totalCount = 0;

  // Load all users once so we can look up default_staff_role for resolved photographers
  const allUsers: any[] = photographers.length > 0
    ? await entities.User.list('-created_date', 500).catch(() => [])
    : [];

  if (agent) {
    totalCount++;
    const result = await resolveEntity(entities, agent.uid, agent.email, agent.displayName, 'agent', 'Agent', allMappings, agencyId);
    if (result.entityId) { agentId = result.entityId; resolvedCount++; }
    else mappingGaps.push(`agent:${agent.email || agent.displayName || agent.uid}`);
  }

  for (const photographer of photographers) {
    totalCount++;
    const result = await resolveEntity(entities, photographer.id, photographer.email, photographer.name, 'photographer', 'User', allMappings);
    if (result.entityId) {
      // Look up the user's default_staff_role from the users table
      const userRecord = allUsers.find((u: any) => u.id === result.entityId);
      const role = userRecord?.default_staff_role || null;

      resolvedPhotographers.push({
        name: photographer.name,
        userId: result.entityId,
        role,
      });
      resolvedCount++;

      const confirmedMapping = allMappings.find(
        (m: any) => m.tonomo_id === photographer.id && m.mapping_type === 'photographer' && m.is_confirmed
      );
      if (confirmedMapping) {
        try {
          await entities.TonomoMappingTable.update(confirmedMapping.id, {
            seen_count: (confirmedMapping.seen_count || 0) + 1,
            last_seen_at: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      }
    } else {
      unresolvedPhotographers.push(photographer.name || photographer.id || 'unknown');
      mappingGaps.push(`photographer:${photographer.email || photographer.name || photographer.id}`);
    }
  }

  const mappingConfidence = mappingGaps.length === 0 ? 'full' : resolvedCount > 0 ? 'partial' : totalCount > 0 ? 'none' : 'full';
  return { agentId, resolvedPhotographers, unresolvedPhotographers, mappingConfidence, mappingGaps };
}

export async function resolveEntity(entities: any, tonomoUid: string, email: string, name: string, mappingType: string, entityDbName: string, allMappings: any[], agencyId: string | null = null) {
  if (!tonomoUid) return { entityId: null };

  const confirmed = allMappings.find((m: any) => m.tonomo_id === tonomoUid && m.mapping_type === mappingType && m.is_confirmed === true);
  if (confirmed) return { entityId: confirmed.flexmedia_entity_id };

  const nameField = entityDbName === 'User' ? 'full_name' : 'name';
  const allEntities = await entities[entityDbName].list('-created_date', 500);
  const byEmail = email ? allEntities?.filter((e: any) => e.email?.toLowerCase() === email?.toLowerCase()) : [];
  const byName = !byEmail?.length && name ? allEntities?.filter((e: any) => e[nameField]?.toLowerCase() === name.toLowerCase()) : [];
  let match = byEmail?.[0] || byName?.[0] || null;

  // Auto-create Agent record when no match found — Tonomo agents are real estate
  // agents who booked shoots and should exist in FlexStudios for project linking.
  // Only creates if the Tonomo UID hasn't been mapped before.
  if (!match && mappingType === 'agent' && entityDbName === 'Agent' && (name || email)) {
    // Check if this UID was already seen (even unconfirmed) — don't duplicate
    const existingMapping = allMappings.find((m: any) => m.tonomo_id === tonomoUid && m.mapping_type === 'agent');
    if (!existingMapping?.flexmedia_entity_id) {
      try {
        // Compute data integrity issues
        const integrityIssues: string[] = [];
        if (!email) integrityIssues.push('missing_email');
        if (!agencyId) integrityIssues.push('missing_organisation');
        // Phone is never available from Tonomo webhooks — always flag
        integrityIssues.push('missing_phone');

        const newAgent = await entities.Agent.create({
          name: name || email || 'Unknown Agent',
          email: email || null,
          source: 'tonomo',
          tonomo_uid: tonomoUid,
          current_agency_id: agencyId || null,
          status: 'active',
          relationship_state: 'New',
          auto_created: true,
          needs_review: true,
          data_integrity_issues: JSON.stringify(integrityIssues),
        });
        if (newAgent?.id) {
          match = newAgent;
          console.log(`[agent-autocreate] Created Agent "${name}" (${newAgent.id}) from Tonomo uid ${tonomoUid}. Integrity issues: ${integrityIssues.join(', ') || 'none'}`);
        }
      } catch (createErr: any) {
        console.error(`[agent-autocreate] Failed to create Agent "${name}":`, createErr?.message);
      }
    }
  }

  // For existing agents matched by email/name, update their tonomo_uid if not set
  if (match && !match.tonomo_uid && tonomoUid) {
    try {
      await entities.Agent.update(match.id, { tonomo_uid: tonomoUid });
    } catch { /* non-fatal */ }
  }

  await upsertMappingSuggestion(entities, tonomoUid, name || email || tonomoUid, mappingType, entityDbName, match?.id || null, match?.[nameField] || null, match ? 'high' : 'low', allMappings);
  return { entityId: match?.id || null };
}

export async function loadMappingTable(entities: any) {
  try { return await entities.TonomoMappingTable.list('-last_seen_at', 500) || []; } catch { return []; }
}

export async function upsertMappingSuggestion(entities: any, tonomoId: string, tonomoLabel: string, mappingType: string, entityType: string, entityId: string | null, entityLabel: string | null, confidence: string, allMappings: any[]) {
  // Check for exact match (same tonomo_id + mapping_type)
  const exactMatch = allMappings.filter((m: any) => m.tonomo_id === tonomoId && m.mapping_type === mappingType);
  // Also check if a CONFIRMED mapping of ANY type already exists for this tonomo_id
  // (prevents creating both service + package rows for the same item)
  const confirmedAny = allMappings.find((m: any) => m.tonomo_id === tonomoId && m.is_confirmed);
  if (confirmedAny) return; // Already has a confirmed mapping — don't create a competing suggestion

  const data = { tonomo_id: tonomoId, tonomo_label: tonomoLabel, mapping_type: mappingType, flexmedia_entity_type: entityType, flexmedia_entity_id: entityId, flexmedia_label: entityLabel, auto_suggested: true, confidence, last_seen_at: new Date().toISOString() };
  if (exactMatch?.length > 0 && !exactMatch[0].is_confirmed) {
    await entities.TonomoMappingTable.update(exactMatch[0].id, data);
  } else if (!exactMatch?.length) {
    const created = await entities.TonomoMappingTable.create(data);
    // Push into allMappings so subsequent calls in the same webhook batch won't create duplicates
    if (created) allMappings.push({ ...data, id: created.id });
  }
}

export async function findProjectByOrderId(entities: any, orderId: string) {
  if (!orderId) return null;
  try {
    const results = await entities.Project.filter({ tonomo_order_id: orderId }, null, 1);
    return results?.[0] || null;
  } catch { return null; }
}

export function extractOrderIdFromPayload(p: any) {
  // CRITICAL: Never fall back to p.id — that's the appointment/event ID, not the order ID.
  // Using it causes duplicate projects for appointment-level events (time change, people change).
  return p.orderId || p.order?.orderId || '';
}

export function extractQtyFromTierName(tierName: string) {
  const match = (tierName || '').match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

export function clampQty(qty: number, product: any) {
  const min = Math.max(1, product?.min_quantity || 1);
  const max = product?.max_quantity ? parseInt(String(product.max_quantity)) : null;
  let clamped = Math.max(min, qty);
  if (max !== null) clamped = Math.min(clamped, max);
  return clamped;
}

export function buildReviewReason(confidence: string, gaps: string[], serviceUncertain: boolean, unresolvedPhotographers: string[] = [], unmappedServices: string[] = [], flowUnmapped = false, typeUnmapped = false) {
  const reasons: string[] = [];
  if (confidence !== 'full') reasons.push(`Mapping confidence: ${confidence}. Gaps: ${gaps.join(', ')}`);
  if (serviceUncertain) reasons.push('Service assignment uncertain — using order-level services as fallback');
  if (unresolvedPhotographers.length > 0) reasons.push(`Unresolved photographer(s): ${unresolvedPhotographers.join(', ')} — manual assignment required`);
  if (unmappedServices.length > 0) reasons.push(`Unmapped services (products not applied): ${unmappedServices.join(', ')} — confirm in Bookings Engine > Mappings`);
  if (flowUnmapped) reasons.push('Booking flow not mapped to a pricing tier — defaulting to standard. Set it in Settings > Tonomo Mappings > Booking Flows');
  if (typeUnmapped) reasons.push('Booking flow type not mapped to a project type — project type unset. Map it in Settings > Tonomo Mappings > Project Types');
  return reasons.join(' | ') || 'Auto-imported from Tonomo';
}

export function filterOverriddenFields(data: any, overriddenFields: string[]) {
  if (!overriddenFields.length) return data;
  const result = { ...data };
  for (const field of overriddenFields) delete result[field];
  return result;
}

export async function writeProjectActivity(entities: any, params: any) {
  try {
    await entities.ProjectActivity.create({
      project_id: params.project_id,
      project_title: params.project_title || '',
      action: params.action,
      description: params.description,
      actor_type: 'tonomo',
      actor_source: 'processTonomoQueue',
      user_name: 'Tonomo System',
      user_email: 'system@tonomo',
      tonomo_order_id: params.tonomo_order_id || null,
      tonomo_event_type: params.tonomo_event_type || null,
      changed_fields: params.changed_fields || [],
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });
  } catch (e: any) {
    console.error('writeProjectActivity failed:', e.message);
  }
}

export async function writeAudit(entities: any, params: any) {
  try {
    await entities.TonomoAuditLog.create({ ...params, processor_version: PROCESSOR_VERSION, processed_at: new Date().toISOString() });
  } catch (e: any) { console.error('Audit log write failed:', e.message); }
}

export async function releaseLock(entities: any, settings: any, adminClient?: any) {
  // Release Postgres advisory lock if we have an admin client
  if (adminClient) {
    try { await adminClient.rpc('pg_advisory_unlock', { lock_id: 424242 }); }
    catch { /* advisory lock may not have been acquired */ }
  }
  if (settings?.id) {
    try { await entities.TonomoIntegrationSettings.update(settings.id, { processing_lock_at: null }); }
    catch { /* self-expires after TTL */ }
  }
}

export async function safeList(entities: any, entity: string, limit = 10) {
  try { return await entities[entity].list('-created_date', limit); } catch { return []; }
}

export async function safeUpdate(entities: any, entity: string, data: any) {
  try {
    const items = await entities[entity].list('-created_date', 1);
    if (items?.[0]?.id) await entities[entity].update(items[0].id, data);
  } catch { /* silent */ }
}

// Notification helpers
export async function fireAdminNotif(entities: any, params: any) {
  try {
    const users = await entities.User.list('-created_date', 200);
    const adminIds = users
      .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
      .map((u: any) => u.id);

    for (const userId of adminIds) {
      const idemKey = params.idempotencyKey
        ? `${params.idempotencyKey}:${userId}`
        : params.idempotencyKeySuffix
        ? `${params.idempotencyKeySuffix}:${userId}`
        : null;
      await fireNotif(entities, { ...params, userId, idempotencyKey: idemKey });
    }
  } catch (e: any) {
    console.warn('fireAdminNotif error:', e.message);
  }
}

export async function fireRoleNotif(entities: any, roles: string[], params: any, project: any) {
  try {
    const ROLE_FIELDS: Record<string, string[]> = {
      project_owner: ['project_owner_id'],
      photographer: ['photographer_id', 'onsite_staff_1_id'],
      videographer: ['videographer_id', 'onsite_staff_2_id'],
      image_editor: ['image_editor_id'],
      video_editor: ['video_editor_id'],
      assigned_users: ['assigned_users'],
      master_admin: [],
    };

    const ids = new Set<string>();

    // For master_admin role, look up actual admin users
    if (roles.includes('master_admin')) {
      const users = await entities.User.list('-created_date', 200);
      users
        .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
        .forEach((u: any) => ids.add(u.id));
    }

    for (const role of roles) {
      for (const field of (ROLE_FIELDS[role] || [])) {
        const val = project?.[field];
        if (!val) continue;
        if (field === 'assigned_users') {
          const arr = Array.isArray(val) ? val : (() => { try { return JSON.parse(val); } catch { return []; } })();
          arr.forEach((id: string) => id && ids.add(id));
        } else {
          ids.add(val);
        }
      }
    }

    for (const userId of Array.from(ids)) {
      const idemKey = params.idempotencyKey ? `${params.idempotencyKey}:${userId}` : null;
      await fireNotif(entities, { ...params, userId, idempotencyKey: idemKey });
    }
  } catch (e: any) {
    console.warn('fireRoleNotif error:', e.message);
  }
}

export async function fireNotif(entities: any, p: any) {
  try {
    // Preference check
    if (p.userId && p.type && p.category) {
      try {
        const prefs = await entities.NotificationPreference.filter({ user_id: p.userId }, null, 50);
        const typePref = prefs.find((pr: any) => pr.notification_type === p.type);
        if (typePref !== undefined && typePref.in_app_enabled === false) return;
        const catPref = prefs.find((pr: any) => pr.category === p.category && (!pr.notification_type || pr.notification_type === '*'));
        if (catPref !== undefined && catPref.in_app_enabled === false) return;
      } catch { /* allow if pref check fails */ }
    }

    // Dedup: skip if a notification with this idempotency_key already exists.
    // The filter check handles the common case; the unique constraint catch (below)
    // handles concurrent race conditions where multiple processors run simultaneously.
    if (p.idempotencyKey) {
      const existing = await entities.Notification.filter(
        { idempotency_key: p.idempotencyKey }, null, 1
      );
      if (existing.length > 0) return;
    }

    try {
      await entities.Notification.create({
        user_id: p.userId,
        type: p.type,
        category: p.category,
        severity: p.severity,
        title: p.title,
        message: p.message,
        project_id: p.projectId || null,
        project_name: p.projectName || null,
        cta_label: p.ctaLabel || 'View',
        is_read: false,
        is_dismissed: false,
        source: p.source || 'system',
        idempotency_key: p.idempotencyKey || null,
        created_date: new Date().toISOString(),
      });
    } catch (createErr: any) {
      // Silently swallow unique constraint violations (duplicate idempotency_key)
      const isDupe = createErr?.code === '23505' || createErr?.message?.includes('duplicate key') || createErr?.message?.includes('unique constraint');
      if (isDupe) return; // Already exists — race condition dedup
      throw createErr; // Re-throw real errors
    }
  } catch (e: any) {
    console.warn('fireNotif error:', e.message);
  }
}

// Retry recovery
export async function recoverFailedItems(entities: any) {
  try {
    const failedItems = await entities.TonomoProcessingQueue.filter(
      { status: 'failed' },
      'last_failed_at',
      50
    ) || [];

    const now = Date.now();
    const toRecover = failedItems.filter((item: any) => {
      if ((item.retry_count || 0) >= 3) return false;
      const backoffSeconds = Math.pow(2, item.retry_count || 0) * 60; // 60s, 120s, 240s for retries 0,1,2
      const lastFailed = item.last_failed_at
        ? new Date(item.last_failed_at.replace(/Z$/, '') + 'Z').getTime()
        : 0;
      return (now - lastFailed) / 1000 >= backoffSeconds;
    });

    if (toRecover.length) {
      await Promise.all(toRecover.map((item: any) =>
        entities.TonomoProcessingQueue.update(item.id, {
          status: 'pending',
          error_message: `Retrying (attempt ${(item.retry_count || 0) + 1})`,
        })
      ));
    }
  } catch (e: any) {
    console.error('recoverFailedItems error:', e.message);
  }
}
