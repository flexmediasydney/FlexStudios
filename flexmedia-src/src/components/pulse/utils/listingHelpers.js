/**
 * Shared helpers for rendering pulse_listings / pulse_agents / pulse_agencies.
 *
 * Lives here (not inline in a single tab) so every renderer uses the SAME
 * logic — no more "sold_price || asking_price" in one file and
 * "asking_price || sold_price" in another (Tier 2 UI consistency fix).
 *
 * Key invariants after Migration 100 (Apr 2026):
 *   - sold listings have sold_price populated; asking_price is NULL
 *   - for_sale / for_rent / under_contract have asking_price populated;
 *     sold_price is NULL
 *   - `price_text` is the raw scraped string (may say "Offers over $1.2M")
 *     and is a FALLBACK, not a display primary
 */

// ── Price display ────────────────────────────────────────────────────────

/**
 * Canonical display price for a pulse_listing row, regardless of state.
 * Returns a { amount: number|null, label: string, suffix: string } tuple.
 *
 * label examples:
 *   - "$1.4M" for a sold property with sold_price
 *   - "$750K" for a for_sale property with asking_price
 *   - "$650/wk" for a for_rent property
 *   - "Price on request" when we have no numeric price
 *
 * Use this everywhere instead of rolling fallback logic inline.
 */
export function displayPrice(listing) {
  if (!listing) return { amount: null, label: "—", suffix: "" };

  const isSold   = listing.listing_type === "sold";
  const isRent   = listing.listing_type === "for_rent";
  const isUnderContract = listing.listing_type === "under_contract";

  // Primary numeric — use the CANONICAL column for this state after migration 100
  let primary = null;
  if (isSold) primary = Number(listing.sold_price) || null;
  else if (isRent || isUnderContract) primary = Number(listing.asking_price) || null;
  else primary = Number(listing.asking_price) || null;

  // Legacy fallback — covers pre-migration-100 rows where sold_price was null
  // but the amount was miswritten to asking_price. Safe for all new rows
  // (where this fallback won't trigger).
  if (primary == null) {
    if (isSold) primary = Number(listing.asking_price) || null;
    else primary = Number(listing.sold_price) || null;
  }

  if (primary == null || primary <= 0) {
    // No numeric — try the raw price_text; otherwise "Price on request"
    return {
      amount: null,
      label: listing.price_text || "Price on request",
      suffix: "",
    };
  }

  const suffix = isRent ? "/wk" : "";
  const label  = formatPriceShort(primary) + suffix;
  return { amount: primary, label, suffix };
}

/** $1.4M / $750K / $650 formatter */
export function formatPriceShort(n) {
  if (n == null || n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

// ── Listing type labels + badge colors ───────────────────────────────────

/**
 * Canonical human label for every listing_type value. Add new types here.
 * Used instead of scattered inline "sold"/"for_sale" strings.
 */
export const LISTING_TYPE_LABEL = {
  for_sale:       "For Sale",
  for_rent:       "For Rent",
  sold:           "Sold",
  under_contract: "Under Contract",
  off_market:     "Off Market",
};

/**
 * Tailwind class set for listing_type badges.
 * Returns { bg, text, border } — compose into className.
 */
export function listingTypeBadgeClasses(listingType) {
  switch (listingType) {
    case "for_sale":
      return {
        bg: "bg-blue-100 dark:bg-blue-900/30",
        text: "text-blue-700 dark:text-blue-300",
        border: "border-blue-200 dark:border-blue-800/50",
      };
    case "for_rent":
      return {
        bg: "bg-purple-100 dark:bg-purple-900/30",
        text: "text-purple-700 dark:text-purple-300",
        border: "border-purple-200 dark:border-purple-800/50",
      };
    case "sold":
      return {
        bg: "bg-emerald-100 dark:bg-emerald-900/30",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-200 dark:border-emerald-800/50",
      };
    case "under_contract":
      return {
        bg: "bg-amber-100 dark:bg-amber-900/30",
        text: "text-amber-700 dark:text-amber-400",
        border: "border-amber-300 dark:border-amber-800/50",
      };
    default:
      return { bg: "bg-muted", text: "text-muted-foreground", border: "border-border" };
  }
}

// ── Active-listing classifier ────────────────────────────────────────────

/**
 * Returns true if a listing is "active on market" in any sense — includes
 * under_contract (pre-settlement listings are still meaningfully attached
 * to the agent/agency's current workload).
 *
 * Previously 4+ places filtered only on `for_sale` / `for_rent`, silently
 * dropping under_contract listings from agent workload + market stats.
 */
export function isActiveListing(listing) {
  if (!listing?.listing_type) return false;
  return ["for_sale", "for_rent", "under_contract"].includes(listing.listing_type);
}

// ── Stale-data badge helpers ─────────────────────────────────────────────

/**
 * How old is this record's last_synced_at? Returns { days, isStale, label }
 * where isStale=true past `thresholdDays` (default 7).
 */
export function stalenessInfo(lastSyncedAt, thresholdDays = 7) {
  if (!lastSyncedAt) return { days: null, isStale: false, label: "" };
  const ms = Date.now() - new Date(lastSyncedAt).getTime();
  const days = Math.floor(ms / 86400000);
  const isStale = days > thresholdDays;
  return { days, isStale, label: isStale ? `Stale ${days}d` : "" };
}

// ── rea_id type-safe comparison ──────────────────────────────────────────

/**
 * Compare two rea_ids safely across string/number drift.
 * pulse_timeline.rea_id is stored as text; pulse_agents.rea_agent_id can be
 * either depending on how the row was inserted. Previous code used strict
 * `===` and silently missed matches.
 */
export function reaIdEquals(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// ── Normalised CRM relationship state ────────────────────────────────────

/**
 * Case-insensitive relationship_state comparison. CRM data has drifted
 * between "Active" / "active" / "Prospecting" / "prospect" casings.
 */
export function isRelationshipState(crmEntity, target) {
  if (!crmEntity?.relationship_state || !target) return false;
  return crmEntity.relationship_state.toLowerCase().trim() === target.toLowerCase().trim();
}
