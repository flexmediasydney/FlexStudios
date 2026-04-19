/**
 * PulseSignals — Industry Pulse "Signals" tab.
 *
 * Two view modes:
 *   • Cards   — the original PulseSignalCard grid (dense, visual).
 *   • Table   — virtualized compact row list mirroring PulseTimelineTab's
 *               table pattern, with Level / Category / Delta / Linked /
 *               Status / Created / Actions columns + column filters + CSV.
 *
 * View mode persists in URL (?view=cards|table) with localStorage fallback so
 * bookmarked links round-trip.
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import PulseSignalCard, { extractPriceDelta, PriceDeltaBadge, formatShortMoney } from "@/components/nurturing/PulseSignalCard";
import PulseSignalQuickAdd from "@/components/nurturing/PulseSignalQuickAdd";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { toast } from "sonner";
import { api } from "@/api/supabaseClient";
import { refetchEntityList, useEntityList } from "@/components/hooks/useEntityData";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import {
  Plus, Zap, ArrowDownUp, HelpCircle,
  ArrowRight, Building2, DollarSign, Link2, RefreshCw, Download,
  LayoutGrid, ListIcon, User, ExternalLink, MoreHorizontal,
  CheckCircle2, Eye, XCircle, History,
  ArrowRightLeft, Mail, Phone, Briefcase,
} from "lucide-react";
import { exportFilteredCsv } from "@/components/pulse/utils/qolHelpers";
import PresetControls from "@/components/pulse/utils/PresetControls";

const LS_VIEW_MODE = "pulse-signals-view-mode";

// ── Signal Legend ─────────────────────────────────────────────────────────────
const SIGNAL_LEGEND = [
  {
    group: "Movement",
    items: [
      { kind: "agent_movement", label: "Agent moved agencies", icon: ArrowRight, level: "person", category: "movement",
        trigger: "pulse_timeline agency_change event detected in last 24h (agent switched agency between scrapes).",
        action: "Congratulate and reconnect with the agent at their new agency." },
      { kind: "relist", label: "Listing re-listed (re-shoot candidate)", icon: RefreshCw, level: "person", category: "movement",
        trigger: "Same property_key went withdrawn then back to for_sale / for_rent / under_contract within 30 days.",
        action: "Offer the listing agent a re-shoot — owner has re-committed to marketing." },
    ],
  },
  {
    group: "Market",
    items: [
      { kind: "price_drop", label: "Price drop", icon: DollarSign, level: "organisation", category: "market",
        trigger: "pulse_timeline price_change event with at least one listing's new price below old price. Noise floor: >=$5K and >=2% on sales, >=$25/wk on rent.",
        action: "Reach out — motivated vendor may now need re-marketing or a fresh campaign." },
      { kind: "agency_growth", label: "Agency growth surge", icon: Building2, level: "organisation", category: "market",
        trigger: ">=2 first_seen agent events at the same agency_rea_id within 24h.",
        action: "Review the agency — if a dormant prospect, re-engage while they're expanding." },
    ],
  },
  {
    group: "CRM",
    items: [
      { kind: "crm_suggestion", label: "New CRM match suggestion", icon: Link2, level: "person / organisation", category: "custom",
        trigger: "pulse_crm_mappings row inserted with confidence='suggested' (auto-mapper proposes a link).",
        action: "Open the Mappings tab and confirm or reject." },
    ],
  },
  {
    group: "SAFR (Source-Aware Field Resolution)",
    items: [
      { kind: "agent_movement", label: "Agent moved agency", icon: ArrowRightLeft, level: "person", category: "agent_movement",
        trigger: "SAFR trigger on entity_field_sources fires when agent.agency_name or agent.agency_rea_id is promoted to a new value.",
        action: "Congratulate and reconnect with the agent at their new agency." },
      { kind: "contact_change", label: "Contact details changed", icon: Mail, level: "person", category: "contact_change",
        trigger: "SAFR trigger on entity_field_sources fires when contact.email, contact.mobile or contact.phone is promoted.",
        action: "Update CRM; follow up if the change suggests a life event." },
      { kind: "role_change", label: "Job title / role change", icon: Briefcase, level: "person", category: "role_change",
        trigger: "SAFR trigger on entity_field_sources fires when contact.job_title is promoted to a new value.",
        action: "Update CRM notes; send a congratulatory touchpoint." },
    ],
  },
];

const LEVEL_BADGE = {
  industry:     "bg-purple-100 text-purple-700",
  organisation: "bg-blue-100 text-blue-700",
  person:       "bg-green-100 text-green-700",
};

// ── Filter config ─────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [
  { value: "all",          label: "All Levels" },
  { value: "industry",     label: "Industry" },
  { value: "organisation", label: "Organisation" },
  { value: "person",       label: "Person" },
];

const STATUS_OPTIONS = [
  { value: "all",          label: "All Status" },
  { value: "new",          label: "New" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "actioned",     label: "Actioned" },
  { value: "dismissed",    label: "Dismissed" },
];

// Category filter — lines up with pulse_signals.category CHECK plus the three
// SAFR categories introduced by migration 180 (agent_movement / contact_change /
// role_change).
const CATEGORY_OPTIONS = [
  { value: "all",             label: "All" },
  { value: "event",           label: "Event" },
  { value: "movement",        label: "Movement" },
  { value: "milestone",       label: "Milestone" },
  { value: "market",          label: "Market" },
  { value: "custom",          label: "Custom" },
  { value: "agent_movement",  label: "Agent moved" },
  { value: "contact_change",  label: "Contact change" },
  { value: "role_change",     label: "Role change" },
];

// Source type filter — only the values a real pulse_signals row can carry.
const SOURCE_TYPE_OPTIONS = [
  { value: "all",    label: "All Sources" },
  { value: "auto",   label: "Auto" },
  { value: "manual", label: "Manual" },
  { value: "system", label: "System" },
];

const LEVEL_COLORS = {
  industry:     "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  organisation: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  person:       "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const STATUS_COLORS = {
  new:          "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  acknowledged: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  actioned:     "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  dismissed:    "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

// ── Filter bar button ─────────────────────────────────────────────────────────

function FilterButton({ active, label, colorClass, onClick }) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className={cn("h-7 px-2.5 text-xs", active && colorClass)}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

// ── Sort ──────────────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "level",  label: "By level" },
];
const LEVEL_PRIORITY = { industry: 0, organisation: 1, person: 2 };

// ── Legend dialog ─────────────────────────────────────────────────────────────

function SignalLegendDialog({ open, onClose }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4" />
            Signal Legend
          </DialogTitle>
          <DialogDescription>
            Every event type the auto-generators can emit, what triggers it, and what to do about it.
            Signals also appear on each linked entity&apos;s dossier timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 pt-2">
          {SIGNAL_LEGEND.map((group) => (
            <div key={group.group}>
              <h3 className="text-xs uppercase tracking-wide font-semibold text-muted-foreground mb-2">{group.group}</h3>
              <div className="space-y-2">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.kind} className="rounded-md border p-3 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-sm">{item.label}</span>
                        <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{item.kind}</code>
                        {item.level.split(" / ").map((lvl) => (
                          <Badge key={lvl} variant="secondary" className={cn("text-[10px] px-1.5 py-0", LEVEL_BADGE[lvl] || "")}>
                            {lvl}
                          </Badge>
                        ))}
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">{item.category}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground"><span className="font-semibold">Triggers when:</span> {item.trigger}</p>
                      <p className="text-xs text-muted-foreground"><span className="font-semibold">What to do:</span> {item.action}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="rounded-md bg-muted/40 border p-3 text-xs text-muted-foreground">
            <p className="font-semibold mb-1">Manual signals</p>
            <p>Signals can also be added by hand via <strong>Add Signal</strong>. Manual signals use the same levels (industry / organisation / person) and show alongside auto-generated ones.</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Signal detail drawer ──────────────────────────────────────────────────────
// Surfaces the full source_data jsonb plus rich linked-entity jumps. Opens from
// a table row click or the "View details" dropdown item.

function SignalDetailDrawer({ signal, agents, agencies, onClose, onOpenEntity }) {
  if (!signal) return null;
  const priceDelta = extractPriceDelta(signal);
  const sd = signal.source_data || {};
  const listingId = sd.listing_id || sd.pulse_listing_id || null;
  const sourceUrl = signal.source_url || sd.source_url || sd.url || null;

  const linkedAgents = (signal.linked_agent_ids || []).map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  const linkedAgencies = (signal.linked_agency_ids || []).map((id) => agencies.find((a) => a.id === id)).filter(Boolean);

  const createdStr = signal.created_at
    ? `${format(new Date(signal.created_at), "d MMM yyyy, HH:mm")} (${formatDistanceToNow(new Date(signal.created_at), { addSuffix: true })})`
    : "-";

  return (
    <Sheet open={!!signal} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">{signal.title}</SheetTitle>
          <SheetDescription>
            <span className="text-xs">{createdStr}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          {/* Badges */}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className={cn("text-[10px]", LEVEL_COLORS[signal.level] || "")}>{signal.level || "-"}</Badge>
            <Badge variant="secondary" className="text-[10px]">{signal.category || "-"}</Badge>
            <Badge variant="secondary" className={cn("text-[10px]", STATUS_COLORS[signal.status] || "")}>{signal.status || "new"}</Badge>
            <Badge variant="outline" className="text-[10px]">source: {signal.source_type || "-"}</Badge>
          </div>

          {priceDelta && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Delta</h4>
              <PriceDeltaBadge delta={priceDelta} />
              {priceDelta.address && (
                <p className="text-xs text-muted-foreground mt-1">{priceDelta.address}</p>
              )}
            </div>
          )}

          {signal.description && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Description</h4>
              <p className="text-sm">{signal.description}</p>
            </div>
          )}

          {signal.suggested_action && (
            <div className="rounded-md border bg-accent/30 p-3">
              <h4 className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <Zap className="h-3 w-3" /> Suggested action
              </h4>
              <p className="text-sm italic">{signal.suggested_action}</p>
            </div>
          )}

          {(linkedAgents.length > 0 || linkedAgencies.length > 0 || listingId) && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Linked entities</h4>
              <div className="flex flex-wrap gap-1.5">
                {linkedAgents.map((a) => (
                  <button key={a.id} onClick={() => onOpenEntity?.({ type: "agent", id: a.id })}
                    className="hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
                    <Badge variant="outline" className="text-xs gap-0.5">
                      <User className="h-3 w-3" />{a.name}
                    </Badge>
                  </button>
                ))}
                {linkedAgencies.map((a) => (
                  <button key={a.id} onClick={() => onOpenEntity?.({ type: "agency", id: a.id })}
                    className="hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
                    <Badge variant="outline" className="text-xs gap-0.5">
                      <Building2 className="h-3 w-3" />{a.name}
                    </Badge>
                  </button>
                ))}
                {listingId && (
                  <button onClick={() => onOpenEntity?.({ type: "listing", id: listingId })}
                    className="hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
                    <Badge variant="outline" className="text-xs gap-0.5">
                      <ExternalLink className="h-3 w-3" />Listing
                    </Badge>
                  </button>
                )}
                {sourceUrl && (
                  <a href={sourceUrl} target="_blank" rel="noreferrer noopener">
                    <Badge variant="outline" className="text-xs gap-0.5">
                      <ExternalLink className="h-3 w-3" />External
                    </Badge>
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Full source_data jsonb — the rich payload from the generator. */}
          {sd && Object.keys(sd).length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Source data</h4>
              <pre className="text-[10px] bg-muted/50 rounded p-2 overflow-x-auto max-h-60">
                {JSON.stringify(sd, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────
// Compact row mirroring PulseTimeline table density. Inline actions on hover.

function SignalTableRow({
  signal, agents, agencies, onOpen, onAcknowledge, onAction, onDismiss, onOpenEntity,
}) {
  const level    = (signal.level || "industry").toLowerCase();
  const status   = (signal.status || "new").toLowerCase();
  const priceDelta = extractPriceDelta(signal);

  const primaryAgent   = (signal.linked_agent_ids || []).map((id) => agents.find((a) => a.id === id)).filter(Boolean)[0];
  const primaryAgency  = (signal.linked_agency_ids || []).map((id) => agencies.find((a) => a.id === id)).filter(Boolean)[0];
  const relative = signal.created_at ? formatDistanceToNow(new Date(signal.created_at), { addSuffix: true }) : "-";
  const absolute = signal.created_at ? format(new Date(signal.created_at), "d MMM yyyy, HH:mm") : null;

  return (
    <div
      className="grid grid-cols-[70px_90px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_90px_90px_40px] items-center gap-2 px-2 py-1.5 text-xs border-b border-border/30 hover:bg-accent/30 cursor-pointer"
      onClick={() => onOpen?.(signal)}
    >
      {/* Level chip */}
      <div>
        <Badge variant="secondary" className={cn("text-[9px] px-1.5 py-0 whitespace-nowrap", LEVEL_COLORS[level] || "")}>
          {level}
        </Badge>
      </div>
      {/* Category */}
      <div className="text-[10px] text-muted-foreground capitalize truncate">{signal.category || "-"}</div>
      {/* Title */}
      <div className="truncate font-medium" title={signal.title}>{signal.title}</div>
      {/* Delta (price if present, else source type chip) */}
      <div className="min-w-0">
        {priceDelta
          ? <PriceDeltaBadge delta={priceDelta} compact />
          : <span className="text-[10px] text-muted-foreground capitalize">{signal.source_type || "-"}</span>}
      </div>
      {/* Linked */}
      <div className="flex flex-wrap gap-1 min-w-0">
        {primaryAgent && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenEntity?.({ type: "agent", id: primaryAgent.id }); }}
            className="hover:opacity-80 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={primaryAgent.name}
          >
            <Badge variant="outline" className="text-[9px] px-1 py-0 gap-0.5 max-w-[140px] truncate">
              <User className="h-2.5 w-2.5" />{primaryAgent.name}
            </Badge>
          </button>
        )}
        {primaryAgency && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenEntity?.({ type: "agency", id: primaryAgency.id }); }}
            className="hover:opacity-80 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={primaryAgency.name}
          >
            <Badge variant="outline" className="text-[9px] px-1 py-0 gap-0.5 max-w-[140px] truncate">
              <Building2 className="h-2.5 w-2.5" />{primaryAgency.name}
            </Badge>
          </button>
        )}
      </div>
      {/* Status */}
      <div>
        <Badge variant="secondary" className={cn("text-[9px] px-1.5 py-0 whitespace-nowrap", STATUS_COLORS[status] || "")}>
          {status}
        </Badge>
      </div>
      {/* Created */}
      <div className="text-[10px] text-muted-foreground truncate" title={absolute || ""}>{relative}</div>
      {/* Actions */}
      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {status !== "acknowledged" && status !== "actioned" && (
              <DropdownMenuItem onClick={() => onAcknowledge?.(signal)} className="gap-2 text-xs">
                <Eye className="h-3.5 w-3.5" /> Acknowledge
              </DropdownMenuItem>
            )}
            {status !== "actioned" && (
              <DropdownMenuItem onClick={() => onAction?.(signal)} className="gap-2 text-xs">
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark Actioned
              </DropdownMenuItem>
            )}
            {(primaryAgent || primaryAgency) && (
              <DropdownMenuItem
                onClick={() => {
                  const e = primaryAgent ? { type: "agent", id: primaryAgent.id } : { type: "agency", id: primaryAgency.id };
                  onOpenEntity?.(e);
                }}
                className="gap-2 text-xs"
              >
                <History className="h-3.5 w-3.5" /> View timeline
              </DropdownMenuItem>
            )}
            {status !== "dismissed" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onDismiss?.(signal)} className="gap-2 text-xs text-muted-foreground">
                  <XCircle className="h-3.5 w-3.5" /> Dismiss
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PulseSignals({
  pulseSignals = [],
  pulseAgents: pulseAgentsProp = [],
  pulseAgencies: pulseAgenciesProp = [],
  onOpenEntity,
  search = "",
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Parent passes empty entity arrays ("tabs fetch what they need") so hydrate
  // locally. Needed to resolve linked-entity pills and avoid phantom rendering.
  const { data: fetchedAgents }   = useEntityList("PulseAgent");
  const { data: fetchedAgencies } = useEntityList("PulseAgency");
  const pulseAgents   = pulseAgentsProp.length   ? pulseAgentsProp   : (fetchedAgents   || []);
  const pulseAgencies = pulseAgenciesProp.length ? pulseAgenciesProp : (fetchedAgencies || []);

  const [levelFilter, setLevelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  // Seed the category filter from ?category= so deep-links from the Command
  // Center "Movements this week" widget land pre-filtered. Validated against
  // the known CATEGORY_OPTIONS so a stray ?category=foo doesn't hide every row.
  const [categoryFilter, setCategoryFilter] = useState(() => {
    const urlCat = searchParams.get("category");
    const valid = CATEGORY_OPTIONS.some((o) => o.value === urlCat);
    return valid ? urlCat : "all";
  });
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [addOpen, setAddOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  // View mode — URL param primary, localStorage fallback for fresh tabs.
  const [viewMode, setViewMode] = useState(() => {
    const urlView = searchParams.get("view");
    if (urlView === "cards" || urlView === "table") return urlView;
    try { return localStorage.getItem(LS_VIEW_MODE) || "cards"; } catch { return "cards"; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_VIEW_MODE, viewMode); } catch { /* ignore */ }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (viewMode === "cards") next.delete("view");
      else next.set("view", viewMode);
      return next;
    }, { replace: true });
  }, [viewMode, setSearchParams]);

  // Drawer for the signal detail view (table row click or card details action).
  const [detailSignal, setDetailSignal] = useState(null);

  // Status transitions — same toast-with-undo pattern as before.
  const updateStatus = useCallback(async (id, status) => {
    try {
      await api.entities.PulseSignal.update(id, { status });
      await refetchEntityList("PulseSignal");
    } catch (err) {
      toast.error("Failed to update signal: " + (err?.message || "Unknown error"));
    }
  }, []);

  const handleAcknowledge = useCallback((signal) => updateStatus(signal.id, "acknowledged"), [updateStatus]);
  const handleAction      = useCallback((signal) => updateStatus(signal.id, "actioned"), [updateStatus]);
  const handleDismiss     = useCallback((signal) => {
    const prevStatus = signal.status || "new";
    updateStatus(signal.id, "dismissed");
    toast("Signal dismissed", {
      action: { label: "Undo", onClick: () => updateStatus(signal.id, prevStatus) },
      duration: 5000,
    });
  }, [updateStatus]);

  // Counts for chip badges.
  const counts = useMemo(() => {
    const result = { level: {}, status: {}, category: {}, source: {} };
    for (const s of pulseSignals) {
      if (s.level)       result.level[s.level]       = (result.level[s.level]       || 0) + 1;
      if (s.status)      result.status[s.status]     = (result.status[s.status]     || 0) + 1;
      if (s.category)    result.category[s.category] = (result.category[s.category] || 0) + 1;
      if (s.source_type) result.source[s.source_type] = (result.source[s.source_type] || 0) + 1;
    }
    return result;
  }, [pulseSignals]);

  // Filtered + sorted signals.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = pulseSignals.filter((s) => {
      if (levelFilter    !== "all" && s.level       !== levelFilter)    return false;
      if (statusFilter   !== "all" && s.status      !== statusFilter)   return false;
      if (categoryFilter !== "all" && s.category    !== categoryFilter) return false;
      if (sourceFilter   !== "all" && s.source_type !== sourceFilter)   return false;
      if (q) {
        const hay = [s.title, s.description, s.suggested_action, s.category]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sortBy === "newest") return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      if (sortBy === "oldest") return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      const pa = LEVEL_PRIORITY[a.level] ?? 3;
      const pb = LEVEL_PRIORITY[b.level] ?? 3;
      if (pa !== pb) return pa - pb;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    return list;
  }, [pulseSignals, levelFilter, statusFilter, categoryFilter, sourceFilter, search, sortBy]);

  // Virtualized table. Only mounted when viewMode === "table" to avoid
  // allocating virtualizer state for the cards path.
  const tableParentRef = useRef(null);
  const rowVirtualizer = useVirtualizer({
    count: viewMode === "table" ? filtered.length : 0,
    getScrollElement: () => tableParentRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  return (
    <div className="space-y-4">
      {/* ── Header row ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Signals</h2>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {filtered.length}
            {filtered.length !== pulseSignals.length && ` / ${pulseSignals.length}`}
          </Badge>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
            onClick={() => setLegendOpen(true)} title="What are all these signal types?">
            <HelpCircle className="h-3.5 w-3.5" />
            Legend
          </Button>
          {/* View mode toggle */}
          <div className="inline-flex items-center rounded-md border bg-background p-0.5 ml-1">
            <button type="button" onClick={() => setViewMode("cards")}
              className={cn("flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                viewMode === "cards" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              aria-pressed={viewMode === "cards"}>
              <LayoutGrid className="h-3 w-3" /> Cards
            </button>
            <button type="button" onClick={() => setViewMode("table")}
              className={cn("flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                viewMode === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              aria-pressed={viewMode === "table"}>
              <ListIcon className="h-3 w-3" /> Table
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              className="h-8 text-xs rounded-md border bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
              {SORT_OPTIONS.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
            </select>
          </div>
          <PresetControls
            namespace="signals"
            currentPreset={{ levelFilter, statusFilter, categoryFilter, sourceFilter, sortBy, viewMode }}
            onLoad={(p) => {
              if (p?.levelFilter)    setLevelFilter(p.levelFilter);
              if (p?.statusFilter)   setStatusFilter(p.statusFilter);
              if (p?.categoryFilter) setCategoryFilter(p.categoryFilter);
              if (p?.sourceFilter)   setSourceFilter(p.sourceFilter);
              if (p?.sortBy)         setSortBy(p.sortBy);
              if (p?.viewMode === "cards" || p?.viewMode === "table") setViewMode(p.viewMode);
            }}
          />
          <Button
            variant="outline" size="sm" className="h-7 text-[11px] gap-1"
            onClick={() => {
              const headers = [
                { key: "id",               label: "id" },
                { key: "created_at",       label: "created_at" },
                { key: "level",            label: "level" },
                { key: "status",           label: "status" },
                { key: "category",         label: "category" },
                { key: "title",            label: "title" },
                { key: "description",      label: "description" },
                { key: "suggested_action", label: "suggested_action" },
                { key: "source_type",      label: "source_type" },
                { key: "is_actionable",    label: "is_actionable" },
              ];
              const stamp = new Date().toISOString().slice(0, 10);
              exportFilteredCsv(`pulse_signals_${stamp}.csv`, headers, filtered);
            }}
            disabled={filtered.length === 0}
            title="Download the currently filtered signals as CSV"
          >
            <Download className="h-3 w-3" /> Download CSV
          </Button>
          <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add Signal
          </Button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-1">
        {LEVEL_OPTIONS.map((opt) => (
          <FilterButton
            key={opt.value}
            active={levelFilter === opt.value}
            label={opt.value === "all" ? opt.label : `${opt.label}${counts.level[opt.value] ? ` (${counts.level[opt.value]})` : ""}`}
            colorClass={LEVEL_COLORS[opt.value] || ""}
            onClick={() => setLevelFilter(opt.value)}
          />
        ))}
        <span className="text-muted-foreground text-xs mx-1">|</span>
        {STATUS_OPTIONS.map((opt) => (
          <FilterButton
            key={opt.value}
            active={statusFilter === opt.value}
            label={opt.value === "all" ? opt.label : `${opt.label}${counts.status[opt.value] ? ` (${counts.status[opt.value]})` : ""}`}
            colorClass={STATUS_COLORS[opt.value] || ""}
            onClick={() => setStatusFilter(opt.value)}
          />
        ))}
        <span className="text-muted-foreground text-xs mx-1">|</span>
        {/* Category + source filters — secondary row, always visible so the
            table view matches Timeline's filter density. */}
        {CATEGORY_OPTIONS.map((opt) => (
          <FilterButton
            key={`cat-${opt.value}`}
            active={categoryFilter === opt.value}
            label={opt.value === "all" ? opt.label : `${opt.label}${counts.category[opt.value] ? ` (${counts.category[opt.value]})` : ""}`}
            colorClass=""
            onClick={() => setCategoryFilter(opt.value)}
          />
        ))}
        <span className="text-muted-foreground text-xs mx-1">|</span>
        {SOURCE_TYPE_OPTIONS.map((opt) => (
          <FilterButton
            key={`src-${opt.value}`}
            active={sourceFilter === opt.value}
            label={opt.value === "all" ? opt.label : `${opt.label}${counts.source[opt.value] ? ` (${counts.source[opt.value]})` : ""}`}
            colorClass=""
            onClick={() => setSourceFilter(opt.value)}
          />
        ))}
      </div>

      {/* ── Content ── */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Zap className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No signals found</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            {pulseSignals.length === 0
              ? "Add a signal manually or run a scrape to auto-generate signals."
              : "Try adjusting the filters above."}
          </p>
          <Button variant="link" size="sm" className="h-7 text-xs mt-2" onClick={() => setLegendOpen(true)}>
            <HelpCircle className="h-3.5 w-3.5 mr-1" /> See the signal legend
          </Button>
        </div>
      ) : viewMode === "cards" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((signal) => (
            <PulseSignalCard
              key={signal.id}
              signal={signal}
              agents={pulseAgents}
              agencies={pulseAgencies}
              onOpenEntity={onOpenEntity}
              onOpenTimeline={onOpenEntity /* jumping to an entity opens its slideout/timeline */}
              onAcknowledge={handleAcknowledge}
              onAction={handleAction}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      ) : (
        // Table view — virtualized rows with sticky header.
        <div className="rounded-md border border-border/40 overflow-hidden">
          <div className="grid grid-cols-[70px_90px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_90px_90px_40px] items-center gap-2 px-2 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground border-b bg-muted/30">
            <span>Level</span>
            <span>Category</span>
            <span>Title</span>
            <span>Delta</span>
            <span>Linked</span>
            <span>Status</span>
            <span>Created</span>
            <span>{/* actions */}</span>
          </div>
          <div ref={tableParentRef} className="overflow-auto max-h-[720px]">
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
              {rowVirtualizer.getVirtualItems().map((vRow) => {
                const signal = filtered[vRow.index];
                if (!signal) return null;
                return (
                  <div
                    key={signal.id}
                    style={{
                      position: "absolute",
                      top: 0, left: 0, right: 0,
                      height: vRow.size,
                      transform: `translateY(${vRow.start}px)`,
                    }}
                  >
                    <SignalTableRow
                      signal={signal}
                      agents={pulseAgents}
                      agencies={pulseAgencies}
                      onOpen={setDetailSignal}
                      onOpenEntity={onOpenEntity}
                      onAcknowledge={handleAcknowledge}
                      onAction={handleAction}
                      onDismiss={handleDismiss}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Add signal dialog ── */}
      {addOpen && (
        <PulseSignalQuickAdd open={addOpen} onClose={() => setAddOpen(false)} />
      )}

      {/* ── Signal legend ── */}
      <SignalLegendDialog open={legendOpen} onClose={() => setLegendOpen(false)} />

      {/* ── Detail drawer ── */}
      {detailSignal && (
        <SignalDetailDrawer
          signal={detailSignal}
          agents={pulseAgents}
          agencies={pulseAgencies}
          onClose={() => setDetailSignal(null)}
          onOpenEntity={(e) => { onOpenEntity?.(e); setDetailSignal(null); }}
        />
      )}
    </div>
  );
}
