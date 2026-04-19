/**
 * PropertyTimelineEventDrawer — right-side Sheet that surfaces the full detail
 * of a single property-timeline event. Opens whenever a row on the
 * PropertyDetails Timeline tab is clicked.
 *
 * What's inside:
 *   • event type + category pill (colored via timelineIcons registry)
 *   • full title + description
 *   • previous_value → new_value diff (price_change etc.)
 *   • metadata key/value table (best-effort flatten)
 *   • Source chip — clicking it opens the shared SourceDrillDrawer
 *   • Apify run deep-link when apify_run_id present in metadata
 *   • Sync-log deep-link into /IndustryPulse?tab=sources when sync_log_id set
 *   • Created-at (relative + absolute in tooltip)
 *   • Related listing link when event carries a listing_id
 *
 * Props:
 *   event — normalized timeline row (the _augmented shape used by
 *           PropertyDetails.TimelineTab). Nullable — when null we render
 *           nothing (the parent manages open state by setting this).
 *   open  — boolean; when true the Sheet is open
 *   onClose — () => void
 *
 * We intentionally do NOT modify the shared `flexmedia-src/src/components/pulse`
 * surfaces — that ownership is with other FE-QC agents right now. Instead we
 * *consume* SourceDrillDrawer via lazy load so pricing-timeline clicks don't
 * ship its JS until the user actually drills into a source.
 */
import React, { Suspense, lazy, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";
import {
  ExternalLink, Clock, Database, ArrowRight, Home, Camera, DollarSign,
  Building2, AlertTriangle, ChevronRight, List, FileText,
} from "lucide-react";

// Lazy-load SourceDrillDrawer so we don't pull its query hook + payload viewer
// into the main PropertyDetails bundle. Graceful fallback if it errors.
const SourceDrillDrawer = lazy(() =>
  import("@/components/pulse/timeline/SourceDrillDrawer").catch(() => ({
    default: () => null,
  }))
);

/* ── Helpers ────────────────────────────────────────────────────────────── */

function fmtRelative(d) {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  if (!isFinite(ms)) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function fmtAbsolute(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleString("en-AU", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

function fmtPriceValue(v) {
  if (v == null || v === "") return "—";
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  if (!isFinite(n) || n === 0) return String(v);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

/** Pick the best "source" identifier from a normalized event. Different
 *  producers stash this in `source`, `source_id`, or `metadata.source_id`. */
function extractSourceId(e) {
  if (!e) return null;
  return e.source_id || e.source || e?.metadata?.source_id || null;
}

/** Pull the apify_run_id out wherever it might be buried. */
function extractApifyRunId(e) {
  if (!e) return null;
  return (
    e.apify_run_id
    || e?.metadata?.apify_run_id
    || e?.metadata?.run_id
    || null
  );
}

/** Prefer event_category, fall back to the synthetic `_kind` used by the
 *  TimelineTab fallback synth. */
function extractCategory(e) {
  if (!e) return null;
  return e.event_category || e._kind || null;
}

/** When `previous_value`/`new_value` are jsonb objects, flatten them. */
function flattenValue(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch { return String(v); }
}

/** Heuristic — is this event a price-change where prev/new are numeric? */
function isPriceDiff(prev, next) {
  const a = Number(String(prev ?? "").replace(/[^0-9.-]/g, ""));
  const b = Number(String(next ?? "").replace(/[^0-9.-]/g, ""));
  return isFinite(a) && isFinite(b) && (a > 0 || b > 0);
}

/* ── Visual config per kind ─────────────────────────────────────────────── */

const KIND_CONFIG = {
  shoot:  { Icon: Camera,    cls: "text-violet-600 bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-800/50", label: "FlexStudios shoot" },
  sale:   { Icon: DollarSign, cls: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50", label: "Sale" },
  rea:    { Icon: Building2,  cls: "text-blue-600 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/50", label: "Listing event" },
  signal: { Icon: AlertTriangle, cls: "text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/50", label: "Signal" },
};

function getKindConfig(kind) {
  return KIND_CONFIG[kind] || { Icon: List, cls: "text-muted-foreground bg-muted border-border", label: "Event" };
}

/* ── Main component ─────────────────────────────────────────────────────── */

export default function PropertyTimelineEventDrawer({ event, open, onClose }) {
  const [drillOpen, setDrillOpen] = useState(false);

  const category = extractCategory(event);
  const { Icon: KindIcon, cls: kindCls, label: kindLabel } = getKindConfig(category);

  const source = extractSourceId(event);
  const apifyRunId = extractApifyRunId(event);
  const apifyUrl = apifyRunId
    ? `https://console.apify.com/actors/runs/${apifyRunId}`
    : null;
  const syncLogUrl = event?.sync_log_id
    ? `/IndustryPulse?tab=sources&sync_log_id=${event.sync_log_id}`
    : null;

  const prev = event?.previous_value;
  const next = event?.new_value;
  const showDiff = prev != null || next != null;
  const priceDiff = showDiff && isPriceDiff(prev, next);

  // Flatten metadata for a k/v preview — strip keys we've already surfaced.
  const metaEntries = useMemo(() => {
    if (!event?.metadata || typeof event.metadata !== "object") return [];
    const skip = new Set([
      "apify_run_id", "run_id", "source_id", "sync_log_id",
      "previous_value", "new_value",
    ]);
    return Object.entries(event.metadata)
      .filter(([k, v]) => !skip.has(k) && v != null && v !== "")
      .slice(0, 12); // cap — anything deeper lives in SourceDrillDrawer
  }, [event]);

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => !v && onClose?.()}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {event ? (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                      kindCls,
                    )}
                  >
                    <KindIcon className="h-3 w-3" />
                    {event.event_type || kindLabel}
                  </span>
                  {category && category !== event.event_type && (
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {category}
                    </Badge>
                  )}
                </div>
                <SheetTitle className="text-base leading-tight pr-6">
                  {event.title || event.event_type || "Timeline event"}
                </SheetTitle>
                {event.subtitle && (
                  <SheetDescription className="text-xs">
                    {event.subtitle}
                  </SheetDescription>
                )}
              </SheetHeader>

              <div className="mt-4 space-y-4">
                {/* ── Description ────────────────────────────────────── */}
                {event.description && (
                  <div className="rounded-lg border p-3 bg-muted/30">
                    <p className="text-xs whitespace-pre-wrap leading-relaxed">
                      {event.description}
                    </p>
                  </div>
                )}

                {/* ── Value diff ─────────────────────────────────────── */}
                {showDiff && (
                  <div className="rounded-lg border p-3 space-y-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                      Change
                    </p>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="px-2 py-1 rounded bg-muted font-mono text-[11px] truncate">
                        {priceDiff ? fmtPriceValue(prev) : (flattenValue(prev) || "—")}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className={cn(
                        "px-2 py-1 rounded font-mono text-[11px] truncate",
                        priceDiff ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300" : "bg-muted",
                      )}>
                        {priceDiff ? fmtPriceValue(next) : (flattenValue(next) || "—")}
                      </span>
                    </div>
                  </div>
                )}

                {/* ── Timing ─────────────────────────────────────────── */}
                <div className="rounded-lg border p-3 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                    When
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span
                      className="tabular-nums"
                      title={fmtAbsolute(event._date || event.event_date || event.created_at)}
                    >
                      {fmtRelative(event._date || event.event_date || event.created_at)}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground text-[11px]">
                      {fmtAbsolute(event._date || event.event_date || event.created_at)}
                    </span>
                  </div>
                </div>

                {/* ── Source / Apify / sync-log ──────────────────────── */}
                {(source || apifyUrl || syncLogUrl) && (
                  <div className="rounded-lg border p-3 space-y-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                      Source
                    </p>
                    {source && (
                      <button
                        type="button"
                        onClick={() => setDrillOpen(true)}
                        className={cn(
                          "w-full inline-flex items-center justify-between gap-2 rounded-md border px-2 py-1.5",
                          "text-[11px] font-mono hover:bg-muted transition-colors",
                        )}
                        title="Open source drill-through"
                      >
                        <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                          <Database className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate">{source}</span>
                        </span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      </button>
                    )}
                    {apifyUrl && (
                      <a
                        href={apifyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Apify run <span className="font-mono">{apifyRunId}</span>
                      </a>
                    )}
                    {syncLogUrl && (
                      <Link
                        to={syncLogUrl}
                        className="inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
                      >
                        <FileText className="h-3 w-3" />
                        View sync log
                      </Link>
                    )}
                  </div>
                )}

                {/* ── Source URL (direct link to the REA listing, etc.) */}
                {event.source_url && (
                  <a
                    href={event.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open source link
                  </a>
                )}

                {/* ── Related entities ──────────────────────────────── */}
                {(event.listing_id || event.project_id) && (
                  <div className="rounded-lg border p-3 space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                      Related
                    </p>
                    {event.project_id && (
                      <Link
                        to={createPageUrl(`ProjectDetails?id=${event.project_id}`)}
                        className="inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
                      >
                        <Camera className="h-3 w-3" />
                        Project
                      </Link>
                    )}
                    {event.listing_id && (
                      <div className="text-[11px] text-muted-foreground">
                        <Home className="h-3 w-3 inline mr-1" />
                        Listing <span className="font-mono">{String(event.listing_id).slice(0, 8)}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Metadata blob ──────────────────────────────────── */}
                {metaEntries.length > 0 && (
                  <details className="rounded-lg border p-3 [&[open]>summary]:mb-2">
                    <summary className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold cursor-pointer select-none">
                      Metadata ({metaEntries.length})
                    </summary>
                    <dl className="text-[11px] space-y-1 font-mono">
                      {metaEntries.map(([k, v]) => (
                        <div key={k} className="flex items-start gap-2">
                          <dt className="text-muted-foreground min-w-[7rem] shrink-0 truncate">{k}</dt>
                          <dd className="flex-1 break-all">{flattenValue(v) ?? "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </div>

              <div className="mt-4 flex justify-end">
                <Button variant="outline" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No event selected.
            </div>
          )}
        </SheetContent>
      </Sheet>

      {source && drillOpen && (
        <Suspense fallback={null}>
          <SourceDrillDrawer
            source={source}
            createdAt={event?._date || event?.event_date || event?.created_at}
            open={drillOpen}
            onClose={() => setDrillOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
