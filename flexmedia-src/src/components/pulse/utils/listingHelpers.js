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

// ── Detail-enrichment helpers (migration 108+) ───────────────────────────

const _DAYS_AU = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const _MONTHS_AU = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format an auction timestamptz for display.
 *
 *   "2026-05-02T14:30:00+00:00" → "Sat 2 May 2026, 2:30pm"
 *
 * B15: prefer the explicit `timeKnown` flag from the caller (usually
 * `listing.auction_time_known`) rather than sniffing for "00:00 UTC", because
 * a legitimate 10am AEST auction equals 00:00 UTC and was being mis-rendered
 * as date-only. When `timeKnown === false`, render date only. When
 * `timeKnown === true` or `undefined` (legacy call-sites without access to
 * the flag), render with time.
 *
 * Returns "" for null/invalid input.
 */
export function formatAuctionDateTime(auctionTs, timeKnown) {
  if (!auctionTs) return "";
  const d = new Date(auctionTs);
  if (isNaN(d.getTime())) return "";

  const dayName = _DAYS_AU[d.getDay()];
  const dayNum = d.getDate();
  const monthName = _MONTHS_AU[d.getMonth()];
  const year = d.getFullYear();
  const datePart = `${dayName} ${dayNum} ${monthName} ${year}`;

  // B15: explicit flag wins. When the caller tells us the time is NOT known
  // (auction_time_known=false), render date only — regardless of UTC hour.
  if (timeKnown === false) return datePart;

  // Render local time as h:mm am/pm.
  let hour = d.getHours();
  const mins = d.getMinutes();
  const ampm = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  const minsStr = mins === 0 ? "" : `:${String(mins).padStart(2, "0")}`;
  return `${datePart}, ${hour}${minsStr}${ampm}`;
}

/** Internal: parse a JSONB-ish value that may already be an array/object. */
function _parseMaybeJson(val) {
  if (val == null) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  return val;
}

/**
 * Derive the primary contact summary for a field on an agent / agency.
 *
 * @param entity — pulse_agent or pulse_agency row
 * @param field  — "email" | "mobile" | "phone" | "business_phone" — the
 *                 canonical column name. The helper looks up
 *                 `${field}_source`, `${field}_confidence`, and the matching
 *                 `alternate_*s` column by pluralising the name.
 *
 * Returns:
 *   { value, source, confidence, sourcesCount, verified, stale }
 *
 *   - `verified` — true when 2+ sources have seen this exact value
 *   - `stale`    — true when every source's last_seen_at is > 90d ago
 *
 * Returns `{ value: null }` when the entity has no value for the field.
 */
export function primaryContact(entity, field) {
  if (!entity || !field) return { value: null };
  const value = entity[field] || null;
  if (!value) return { value: null };

  // alternate_*s column name: email→alternate_emails, mobile→alternate_mobiles,
  // phone→alternate_phones, business_phone→alternate_phones (shared pool on agents).
  let altKey;
  if (field === "email") altKey = "alternate_emails";
  else if (field === "mobile") altKey = "alternate_mobiles";
  else altKey = "alternate_phones";

  const altArr = _parseMaybeJson(entity[altKey]);
  const alternates = Array.isArray(altArr) ? altArr : [];

  // Find the record matching this primary value (case-insensitive on emails).
  const norm = (s) => (field === "email" ? String(s || "").toLowerCase() : String(s || ""));
  const match = alternates.find((a) => a && norm(a.value) === norm(value));

  const sources = Array.isArray(match?.sources) ? match.sources : [];
  const confidence = match?.confidence ?? entity[`${field}_confidence`] ?? null;
  const source = entity[`${field}_source`] || (sources[0] || null);

  // Stale: last_seen_at > 90 days ago
  let stale = false;
  if (match?.last_seen_at) {
    const lastSeen = new Date(match.last_seen_at).getTime();
    if (!isNaN(lastSeen)) {
      stale = Date.now() - lastSeen > 90 * 86400000;
    }
  }

  return {
    value,
    source,
    confidence,
    sourcesCount: sources.length,
    verified: sources.length >= 2,
    stale,
  };
}

/**
 * Return the alternate-contact entries for a field, EXCLUDING the current
 * primary value. Sorted by last_seen_at DESC.
 *
 * Shape: [{value, sources[], confidence, first_seen_at, last_seen_at}]
 */
export function alternateContacts(entity, field) {
  if (!entity || !field) return [];
  const primaryVal = entity[field];
  let altKey;
  if (field === "email") altKey = "alternate_emails";
  else if (field === "mobile") altKey = "alternate_mobiles";
  else altKey = "alternate_phones";

  const altArr = _parseMaybeJson(entity[altKey]);
  if (!Array.isArray(altArr)) return [];

  const norm = (s) => (field === "email" ? String(s || "").toLowerCase() : String(s || ""));
  const primaryNorm = norm(primaryVal);

  const filtered = altArr.filter((a) => a && a.value && norm(a.value) !== primaryNorm);
  // Sort by last_seen_at DESC (newest first)
  return filtered
    .slice()
    .sort((a, b) => {
      const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      return tb - ta;
    })
    .map((a) => ({
      value: a.value,
      sources: Array.isArray(a.sources) ? a.sources : [],
      confidence: a.confidence ?? null,
      first_seen_at: a.first_seen_at || null,
      last_seen_at: a.last_seen_at || null,
    }));
}

/**
 * Parse a listing's media into { photos, floorplans, video }.
 *
 * Preference order:
 *   1. `listing.media_items` — the structured column (detail-enriched rows)
 *   2. Legacy fallbacks: `floorplan_urls[]` + `video_url` (+ `video_thumb_url`)
 *      + `images[]` for photos.
 *
 * Returns:
 *   {
 *     photos:     [{url, thumb?, order_index?}],
 *     floorplans: [{url, thumb?, order_index?}],
 *     video:      {url, thumb?} | null,
 *   }
 */
export function parseMediaItems(listing) {
  if (!listing) return { photos: [], floorplans: [], video: null };

  const items = _parseMaybeJson(listing.media_items);
  if (Array.isArray(items) && items.length > 0) {
    const photos = [];
    const floorplans = [];
    let video = null;
    for (const it of items) {
      if (!it || !it.url) continue;
      const rec = { url: it.url, thumb: it.thumb || null, order_index: it.order_index ?? null };
      if (it.type === "photo") photos.push(rec);
      else if (it.type === "floorplan") floorplans.push(rec);
      else if (it.type === "video" && !video) video = rec;
    }
    const byOrder = (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0);
    return {
      photos: photos.sort(byOrder),
      floorplans: floorplans.sort(byOrder),
      video,
    };
  }

  // Fallbacks
  const fpRaw = _parseMaybeJson(listing.floorplan_urls);
  const floorplans = Array.isArray(fpRaw)
    ? fpRaw.filter(Boolean).map((url, i) => ({ url, thumb: null, order_index: i }))
    : [];

  // B16: legacy images[] is a flat text[] of URLs with no type info. Old code
  // assumed every entry was a photo, but some legacy rows have floorplan/video
  // URLs mixed in. Classify by URL pattern so those surface to the right bucket.
  const imgRaw = _parseMaybeJson(listing.images);
  const photos = [];
  let legacyVideoFromImages = null;
  if (Array.isArray(imgRaw)) {
    imgRaw.forEach((img, i) => {
      const url = typeof img === "string" ? img : img?.url || img?.src;
      if (!url) return;
      const urlLc = String(url).toLowerCase();
      const rec = {
        url,
        thumb: typeof img === "object" ? img?.thumb || null : null,
        order_index: i,
      };
      if (
        urlLc.includes("youtube.com") ||
        urlLc.includes("youtu.be") ||
        urlLc.includes("img.youtube.com")
      ) {
        // B16: video URL hiding in images[] — only capture first one
        if (!legacyVideoFromImages) legacyVideoFromImages = rec;
      } else if (
        urlLc.includes("floorplan") ||
        urlLc.includes("floor-plan") ||
        urlLc.includes("/fp/")
      ) {
        // B16: floorplan URL misfiled in images[]
        floorplans.push({ ...rec, order_index: floorplans.length });
      } else {
        photos.push(rec);
      }
    });
  }

  const video = listing.video_url
    ? { url: listing.video_url, thumb: listing.video_thumb_url || null }
    : legacyVideoFromImages; // B16: fall through to video we pulled from images[]

  return { photos, floorplans, video };
}

/**
 * Returns provenance for the three time-relevant fields on a listing, so
 * the UI can tag values as "detail-enriched" vs "first_seen proxy".
 *
 * Returned shape: {
 *   listed_date:  {value, source: 'first_seen' | 'detail_enriched'},
 *   sold_date:    {value, source},
 *   auction_date: {value, source},
 * }
 *
 * Heuristic: if `detail_enriched_at` on the listing is set AND the field has
 * a value, we mark it as detail_enriched. Otherwise (or when the listing
 * hasn't been detail-enriched) the source is 'first_seen'.
 */
export function listingDatesProvenance(listing) {
  if (!listing) {
    return {
      listed_date: { value: null, source: null },
      sold_date: { value: null, source: null },
      auction_date: { value: null, source: null },
    };
  }
  const enriched = !!listing.detail_enriched_at;
  const srcFor = (v) => (v ? (enriched ? "detail_enriched" : "first_seen") : null);
  return {
    listed_date: { value: listing.listed_date || null, source: srcFor(listing.listed_date) },
    sold_date: { value: listing.sold_date || null, source: srcFor(listing.sold_date) },
    auction_date: { value: listing.auction_date || null, source: srcFor(listing.auction_date) },
  };
}
