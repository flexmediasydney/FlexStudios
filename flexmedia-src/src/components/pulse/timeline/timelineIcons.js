/**
 * timelineIcons — canonical event_type → { icon, color, label, category_color }
 * registry shared by every timeline surface in the Pulse module.
 *
 * Why here (not inlined in PulseTimeline.jsx)?
 *   - Keeps PulseTimeline.jsx, PulseTimelineTab.jsx (Agent A), PulseCommandCenter,
 *     and PulseIntelligencePanel reading from ONE source of truth.
 *   - Lets us add category-level colors + source-status chip colors in one place
 *     so a designer audit never needs to grep 4 files.
 *
 * The legacy `EVENT_CONFIG` export on PulseTimeline.jsx is kept as a re-export
 * for backward compatibility (PulseTimelineTab.jsx already imports it).
 */
import {
  ArrowRight, Star, Home, User, Zap, RefreshCw, Link2, UserPlus,
  TrendingUp, DollarSign, Play, CheckCircle2, Timer, ListPlus,
  Sparkles, AtSign, Phone, Gavel, FileImage, Video, XCircle,
  ArrowRightLeft, Database, Target, CircleDollarSign, ShieldOff,
  LayoutGrid, ArrowUpDown,
} from "lucide-react";

/* ── System event types filtered out in compact dossier mode ──────────────── */
export const SYSTEM_EVENT_TYPES = new Set([
  "cron_dispatched",
  "scheduled_scrape_started",
  "scheduled_scrape_completed",
  "data_sync",
  "detail_enriched",
]);

/* ── Event type configuration ─────────────────────────────────────────────── */
export const EVENT_CONFIG = {
  // Agent / entity events
  first_seen:               { icon: Zap,          color: "bg-cyan-500",    label: "First Detected",     category_color: "text-cyan-600 dark:text-cyan-400",    category: "agent"    },
  agency_change:            { icon: ArrowRight,   color: "bg-blue-500",    label: "Agency Change",      category_color: "text-blue-600 dark:text-blue-400",    category: "movement" },
  new_listings_detected:    { icon: ListPlus,     color: "bg-green-500",   label: "New Listings",       category_color: "text-green-600 dark:text-green-400",  category: "movement" },
  client_new_listing:       { icon: Home,         color: "bg-emerald-500", label: "Client Listing",     category_color: "text-emerald-600 dark:text-emerald-400", category: "movement" },
  price_change:             { icon: DollarSign,   color: "bg-amber-500",   label: "Price Change",       category_color: "text-amber-600 dark:text-amber-400",  category: "market"   },
  status_change:            { icon: ArrowRight,   color: "bg-blue-500",    label: "Status Change",      category_color: "text-blue-600 dark:text-blue-400",    category: "movement" },

  // Legacy / other entity events
  listing_new:              { icon: Home,         color: "bg-green-500",   label: "New Listing",        category_color: "text-green-600 dark:text-green-400",  category: "movement" },
  listing_sold:             { icon: TrendingUp,   color: "bg-emerald-500", label: "Listing Sold",       category_color: "text-emerald-600 dark:text-emerald-400", category: "movement" },
  rating_change:            { icon: Star,         color: "bg-amber-500",   label: "Rating Changed",     category_color: "text-amber-600 dark:text-amber-400",  category: "agent"    },
  title_change:             { icon: User,         color: "bg-purple-500",  label: "Title Changed",      category_color: "text-purple-600 dark:text-purple-400", category: "agent"    },
  crm_mapped:               { icon: Link2,        color: "bg-indigo-500",  label: "CRM Mapped",         category_color: "text-indigo-600 dark:text-indigo-400", category: "mapping"  },
  crm_added:                { icon: UserPlus,     color: "bg-green-600",   label: "Added to CRM",       category_color: "text-green-600 dark:text-green-400",  category: "mapping"  },

  // System events
  cron_dispatched:          { icon: Timer,        color: "bg-gray-400",    label: "Cron Dispatched",    category_color: "text-gray-500",                       category: "system"   },
  scheduled_scrape_started: { icon: Play,         color: "bg-gray-400",    label: "Scrape Started",     category_color: "text-gray-500",                       category: "system"   },
  scheduled_scrape_completed: { icon: CheckCircle2, color: "bg-gray-400",  label: "Scrape Completed",   category_color: "text-gray-500",                       category: "system"   },
  data_sync:                { icon: RefreshCw,    color: "bg-gray-400",    label: "Data Sync",          category_color: "text-gray-500",                       category: "system"   },

  // Detail-enrichment events (migration 108+)
  detail_enriched:          { icon: Sparkles,     color: "bg-indigo-500",  label: "Detail Enriched",    category_color: "text-indigo-600 dark:text-indigo-400", category: "system"   },
  agent_email_discovered:   { icon: AtSign,       color: "bg-emerald-500", label: "Email Found",        category_color: "text-emerald-600 dark:text-emerald-400", category: "contact"  },
  agent_mobile_discovered:  { icon: Phone,        color: "bg-emerald-500", label: "Mobile Found",       category_color: "text-emerald-600 dark:text-emerald-400", category: "contact"  },
  agent_email_changed:      { icon: RefreshCw,    color: "bg-amber-500",   label: "Email Changed",      category_color: "text-amber-600 dark:text-amber-400",  category: "contact"  },
  agent_mobile_changed:     { icon: RefreshCw,    color: "bg-amber-500",   label: "Mobile Changed",     category_color: "text-amber-600 dark:text-amber-400",  category: "contact"  },
  listing_auction_scheduled:{ icon: Gavel,        color: "bg-amber-500",   label: "Auction Scheduled",  category_color: "text-amber-600 dark:text-amber-400",  category: "market"   },
  listing_floorplan_added:  { icon: FileImage,    color: "bg-blue-500",    label: "Floorplan Added",    category_color: "text-blue-600 dark:text-blue-400",    category: "media"    },
  listing_video_added:      { icon: Video,        color: "bg-blue-500",    label: "Video Added",        category_color: "text-blue-600 dark:text-blue-400",    category: "media"    },
  listing_withdrawn:        { icon: XCircle,      color: "bg-red-500",     label: "Withdrawn",          category_color: "text-red-600 dark:text-red-400",      category: "movement" },
  listing_relisted:         { icon: RefreshCw,    color: "bg-indigo-500",  label: "Relisted",           category_color: "text-indigo-600 dark:text-indigo-400", category: "movement" },
  sold_date_captured:       { icon: CheckCircle2, color: "bg-emerald-500", label: "Sold Date Captured", category_color: "text-emerald-600 dark:text-emerald-400", category: "market"   },
  agency_contact_discovered:{ icon: AtSign,       color: "bg-emerald-500", label: "Agency Contact Found", category_color: "text-emerald-600 dark:text-emerald-400", category: "contact" },
  signal_emitted:           { icon: Zap,          color: "bg-yellow-500",  label: "Signal",             category_color: "text-yellow-600 dark:text-yellow-400", category: "signal"  },

  // SAFR (Source-Aware Field Resolution) — migration 180 writes these event
  // types onto pulse_timeline whenever entity_field_sources promotes a value
  // from one source to another. Rendered with provenance chip (from_source →
  // to_source) in TimelineRow's renderDetail pathway.
  field_promoted:           { icon: Database,       color: "bg-indigo-500",  label: "Field promoted",       category_color: "text-indigo-600 dark:text-indigo-400", category: "safr"    },
  agent_movement_detected:  { icon: ArrowRightLeft, color: "bg-violet-500",  label: "Agent movement",       category_color: "text-violet-600 dark:text-violet-400", category: "movement" },

  // Missed-opportunity quote lifecycle — migration 194. Emitted by the
  // substrate (pulse_listing_missed_opportunity) AFTER UPDATE trigger when
  // pulse_compute_listing_quote produces a materially different quote vs the
  // previous row. Answers "why did Market Share shift?" per listing.
  quote_materially_changed: { icon: CircleDollarSign, color: "bg-amber-500",   label: "Quote Shifted",       category_color: "text-amber-600 dark:text-amber-400",   category: "market"  },
  listing_captured:         { icon: Target,           color: "bg-emerald-500", label: "Newly Captured",      category_color: "text-emerald-600 dark:text-emerald-400", category: "market"  },
  listing_un_captured:      { icon: ShieldOff,        color: "bg-rose-500",    label: "Lost Capture",        category_color: "text-rose-600 dark:text-rose-400",     category: "market"  },
  classification_changed:   { icon: LayoutGrid,       color: "bg-indigo-500",  label: "Re-classified",       category_color: "text-indigo-600 dark:text-indigo-400", category: "market"  },
  tier_changed:             { icon: ArrowUpDown,      color: "bg-blue-500",    label: "Tier Changed",        category_color: "text-blue-600 dark:text-blue-400",     category: "market"  },
};

/* ── Fallback config for unknown event types ─────────────────────────────── */
export const FALLBACK_CONFIG = {
  icon: RefreshCw,
  color: "bg-gray-400",
  label: "Event",
  category_color: "text-gray-500",
  category: "other",
};

export function configFor(eventType) {
  return EVENT_CONFIG[eventType] || FALLBACK_CONFIG;
}

/* ── Category color palette — left-border accent on each row ─────────────── */
export const CATEGORY_BORDER = {
  agent:    "border-l-purple-400/70",
  contact:  "border-l-emerald-400/70",
  mapping:  "border-l-indigo-400/70",
  market:   "border-l-amber-400/70",
  media:    "border-l-sky-400/70",
  movement: "border-l-blue-400/70",
  signal:   "border-l-yellow-400/70",
  safr:     "border-l-indigo-400/70",
  system:   "border-l-gray-300",
  other:    "border-l-gray-300",
};

/* ── Sync-log status → source chip color ─────────────────────────────────── */
export function sourceChipClass(status) {
  switch ((status || "").toLowerCase()) {
    case "success":
    case "completed":
      return "bg-emerald-50 text-emerald-800 border-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50";
    case "running":
    case "in_progress":
    case "pending":
      return "bg-amber-50 text-amber-800 border-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50";
    case "failed":
    case "error":
    case "timeout":
      return "bg-rose-50 text-rose-800 border-rose-200/70 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/50";
    default:
      return "bg-muted/60 text-muted-foreground border-border/60";
  }
}
