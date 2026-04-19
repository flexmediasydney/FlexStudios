import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import {
  Calendar, ArrowRight, Trophy, TrendingUp, TrendingDown, Star,
  MoreHorizontal, Eye, CheckCircle2, XCircle, Pencil,
  Zap, Globe, Building2, User, Newspaper, ExternalLink, History,
} from "lucide-react";

// ── Level config ─────────────────────────────────────────────────────────────

const LEVEL_CONFIG = {
  industry:     { label: "Industry",     color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300", border: "border-l-purple-500", icon: Globe },
  organisation: { label: "Organisation", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",       border: "border-l-blue-500",   icon: Building2 },
  person:       { label: "Person",       color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",     border: "border-l-green-500",  icon: User },
};

// ── Category config ──────────────────────────────────────────────────────────

const CATEGORY_CONFIG = {
  event:     { label: "Event",     icon: Calendar },
  movement:  { label: "Movement",  icon: ArrowRight },
  milestone: { label: "Milestone", icon: Trophy },
  market:    { label: "Market",    icon: TrendingUp },
  custom:    { label: "Custom",    icon: Star },
};

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  new:          { label: "New",          color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  acknowledged: { label: "Acknowledged", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  actioned:     { label: "Actioned",     color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  dismissed:    { label: "Dismissed",    color: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" },
};

// ── Source type config ───────────────────────────────────────────────────────
// 'auto' was only surfaced once migration 156 widened the CHECK constraint and
// pulseSignalGenerator started setting source_type explicitly. Before that
// every auto signal masqueraded as 'manual' (see spec #1).

const SOURCE_CONFIG = {
  observed:     { label: "Observed",     icon: Eye },
  social_media: { label: "Social Media", icon: Globe },
  news:         { label: "News",         icon: Newspaper },
  manual:       { label: "Manual",       icon: Pencil },
  auto:         { label: "Auto",         icon: Zap },
  system:       { label: "System",       icon: Zap },
};

// ── Helpers (exported so the table row can reuse the same rendering) ─────────

export function formatShortMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "-";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/**
 * Extract a normalised price delta { old, new, absDelta, pctDelta } from a
 * signal's source_data payload. Returns null for non-price signals.
 * Handles both the precomputed `top_drop` shape (new generator) and the legacy
 * `drops[0]` shape (pre-156 rows).
 */
export function extractPriceDelta(signal) {
  const sd = signal?.source_data || {};
  if (sd.kind !== "price_drop") return null;
  const top = sd.top_drop || (Array.isArray(sd.drops) ? sd.drops[0] : null);
  if (!top) return null;
  const oldP = Number(top.old);
  const newP = Number(top.new);
  if (!Number.isFinite(oldP) || !Number.isFinite(newP) || oldP <= 0 || newP <= 0) return null;
  const abs = top.abs_delta != null ? Number(top.abs_delta) : oldP - newP;
  const pct = top.pct_delta != null ? Number(top.pct_delta) : Math.round(((oldP - newP) / oldP) * 100);
  return { oldP, newP, absDelta: abs, pctDelta: pct, address: top.address || null };
}

/**
 * Small delta badge: colour-coded (red for drop, green for rise, gray flat).
 * Used both on the card and in the Delta column of the table.
 */
export function PriceDeltaBadge({ delta, compact = false }) {
  if (!delta) return null;
  const { oldP, newP, absDelta, pctDelta } = delta;
  const colour = absDelta > 0
    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : absDelta < 0
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
      : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  const Icon = absDelta > 0 ? TrendingDown : TrendingUp;
  return (
    <Badge variant="secondary" className={cn("text-[10px] font-medium px-1.5 py-0 gap-0.5", colour)}>
      <Icon className="h-2.5 w-2.5" />
      {compact
        ? `${formatShortMoney(oldP)} → ${formatShortMoney(newP)}`
        : `${formatShortMoney(oldP)} → ${formatShortMoney(newP)} (-${formatShortMoney(absDelta)}${pctDelta ? ` / -${pctDelta}%` : ""})`}
    </Badge>
  );
}

// ── Main card ────────────────────────────────────────────────────────────────

export default function PulseSignalCard({
  signal,
  agents = [],
  agencies = [],
  onAction,
  onAcknowledge,
  onDismiss,
  onOpenEntity,
  onOpenTimeline,
}) {
  const level    = (signal.level || "industry").toLowerCase();
  const category = (signal.category || "custom").toLowerCase();
  const status   = (signal.status || "new").toLowerCase();
  const source   = (signal.source_type || "manual").toLowerCase();

  const levelCfg    = LEVEL_CONFIG[level]    || LEVEL_CONFIG.industry;
  const categoryCfg = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.custom;
  const statusCfg   = STATUS_CONFIG[status]  || STATUS_CONFIG.new;
  const sourceCfg   = SOURCE_CONFIG[source]  || SOURCE_CONFIG.manual;

  const CategoryIcon = categoryCfg.icon;
  const SourceIcon   = sourceCfg.icon;

  // ── Resolve linked contacts ────────────────────────────────────────────────
  const linkedContacts = useMemo(() => {
    const contacts = [];
    const agentIds  = signal.linked_agent_ids  || [];
    const agencyIds = signal.linked_agency_ids || [];

    agentIds.forEach((id) => {
      const agent = agents.find((a) => a.id === id);
      if (agent) contacts.push({ id, name: agent.name, type: "agent" });
    });
    agencyIds.forEach((id) => {
      const agency = agencies.find((a) => a.id === id);
      if (agency) contacts.push({ id, name: agency.name, type: "agency" });
    });

    return contacts;
  }, [signal.linked_agent_ids, signal.linked_agency_ids, agents, agencies]);

  // ── Extract rich drill-through payloads from source_data ───────────────────
  const sd = signal.source_data || {};
  const priceDelta = useMemo(() => extractPriceDelta(signal), [signal]);
  const listingId  = sd.listing_id || sd.pulse_listing_id || null;
  const sourceUrl  = signal.source_url || sd.source_url || sd.url || null;

  // ── Format dates ───────────────────────────────────────────────────────────
  const eventDateStr = useMemo(() => {
    if (!signal.event_date) return null;
    try {
      return format(new Date(signal.event_date), "d MMM yyyy");
    } catch {
      return null;
    }
  }, [signal.event_date]);

  const createdRaw = signal.created_date || signal.created_at;
  const relativeTime = useMemo(() => {
    if (!createdRaw) return null;
    try { return formatDistanceToNow(new Date(createdRaw), { addSuffix: true }); }
    catch { return null; }
  }, [createdRaw]);
  const absoluteTime = useMemo(() => {
    if (!createdRaw) return null;
    try { return format(new Date(createdRaw), "d MMM yyyy, HH:mm"); }
    catch { return null; }
  }, [createdRaw]);

  return (
    <Card
      className={cn(
        "border-l-4 transition-colors hover:bg-accent/30",
        levelCfg.border,
        status === "dismissed" && "opacity-60"
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Category icon */}
          <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <CategoryIcon className="h-4 w-4 text-muted-foreground" />
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            {/* Top row: badges */}
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <Badge variant="secondary" className={cn("text-[10px] font-medium px-1.5 py-0 whitespace-nowrap", levelCfg.color)}>
                {levelCfg.label}
              </Badge>
              <Badge variant="secondary" className="text-[10px] font-medium px-1.5 py-0 whitespace-nowrap">
                {categoryCfg.label}
              </Badge>
              <Badge variant="secondary" className={cn("text-[10px] font-medium px-1.5 py-0 whitespace-nowrap", statusCfg.color)}>
                {statusCfg.label}
              </Badge>
              <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 gap-0.5 whitespace-nowrap">
                <SourceIcon className="h-2.5 w-2.5" />
                {sourceCfg.label}
              </Badge>
              {/* Timestamp chip — relative, absolute on hover */}
              {relativeTime && (
                <Badge
                  variant="outline"
                  className="text-[10px] font-normal px-1.5 py-0 whitespace-nowrap text-muted-foreground"
                  title={absoluteTime || ""}
                >
                  {relativeTime}
                </Badge>
              )}
            </div>

            {/* Title */}
            <h3 className="text-sm font-semibold leading-tight mb-0.5">{signal.title}</h3>

            {/* Description */}
            {signal.description && (
              <p className="text-xs text-muted-foreground leading-relaxed mb-1.5">
                {signal.description}
              </p>
            )}

            {/* Price delta badge (price_drop signals only) */}
            {priceDelta && (
              <div className="mb-1.5">
                <PriceDeltaBadge delta={priceDelta} />
              </div>
            )}

            {/* Suggested action */}
            {signal.suggested_action && (
              <p className="text-xs italic text-primary/80 mb-1.5 flex items-center gap-1">
                <Zap className="h-3 w-3 flex-shrink-0" />
                {signal.suggested_action}
              </p>
            )}

            {/* Event date */}
            {eventDateStr && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground mb-1.5">
                <Calendar className="h-3 w-3" />
                {eventDateStr}
              </div>
            )}

            {/* Linked contacts + listing + source URL — clickable pills */}
            {(linkedContacts.length > 0 || listingId || sourceUrl) && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {linkedContacts.map((c) => {
                  const Icon = c.type === "agent" ? User : Building2;
                  const badge = (
                    <Badge
                      variant="outline"
                      className="text-[10px] font-normal px-1.5 py-0 gap-0.5"
                    >
                      <Icon className="h-2.5 w-2.5" />
                      {c.name}
                    </Badge>
                  );
                  if (onOpenEntity) {
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenEntity({ type: c.type, id: c.id });
                        }}
                        title={`Open ${c.type} ${c.name}`}
                      >
                        {badge}
                      </button>
                    );
                  }
                  return (
                    <span key={c.id} title={`${c.type} ${c.name} (not clickable in this view)`}>
                      {badge}
                    </span>
                  );
                })}
                {/* Linked listing — opens the listing slideout */}
                {listingId && onOpenEntity && (
                  <button
                    type="button"
                    className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenEntity({ type: "listing", id: listingId });
                    }}
                    title="Open listing"
                  >
                    <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 gap-0.5">
                      <ExternalLink className="h-2.5 w-2.5" />
                      Listing
                    </Badge>
                  </button>
                )}
                {/* External source URL (e.g. REA) — fallback when no listing id */}
                {sourceUrl && !listingId && (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                    title={sourceUrl}
                  >
                    <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 gap-0.5">
                      <ExternalLink className="h-2.5 w-2.5" />
                      Source
                    </Badge>
                  </a>
                )}
              </div>
            )}

            {/* Footer: created by */}
            {signal.created_by_name && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{signal.created_by_name}</span>
              </div>
            )}
          </div>

          {/* Right side: action button + menu */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {signal.is_actionable && status !== "actioned" && status !== "dismissed" && (
              <Button
                size="sm"
                className="gap-1 h-7 text-xs"
                onClick={() => onAction?.(signal)}
                title="Take action on this signal"
              >
                <Zap className="h-3 w-3" />
                Action This
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {status !== "acknowledged" && status !== "actioned" && (
                  <DropdownMenuItem onClick={() => onAcknowledge?.(signal)} className="gap-2 text-xs">
                    <Eye className="h-3.5 w-3.5" />
                    Acknowledge
                  </DropdownMenuItem>
                )}
                {status !== "actioned" && (
                  <DropdownMenuItem onClick={() => onAction?.(signal)} className="gap-2 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Mark Actioned
                  </DropdownMenuItem>
                )}
                {/* View timeline (Φ3): jump to the linked entity's timeline. Prefers
                    the first linked contact, falls back to linked listing id. */}
                {onOpenTimeline && (linkedContacts.length > 0 || listingId) && (
                  <DropdownMenuItem
                    onClick={() => {
                      const primary = linkedContacts[0];
                      if (primary) onOpenTimeline({ type: primary.type, id: primary.id });
                      else if (listingId) onOpenTimeline({ type: "listing", id: listingId });
                    }}
                    className="gap-2 text-xs"
                  >
                    <History className="h-3.5 w-3.5" />
                    View timeline
                  </DropdownMenuItem>
                )}
                {status !== "dismissed" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onDismiss?.(signal)} className="gap-2 text-xs text-muted-foreground">
                      <XCircle className="h-3.5 w-3.5" />
                      Dismiss
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
