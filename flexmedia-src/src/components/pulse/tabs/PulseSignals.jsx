/**
 * PulseSignals — Industry Pulse "Signals" tab.
 * Filtered grid of PulseSignalCard components with Add Signal dialog.
 */
import React, { useState, useMemo, useCallback } from "react";
import PulseSignalCard from "@/components/nurturing/PulseSignalCard";
import PulseSignalQuickAdd from "@/components/nurturing/PulseSignalQuickAdd";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { cn } from "@/lib/utils";
import {
  Plus, Zap, ArrowDownUp, HelpCircle,
  ArrowRight, Building2, DollarSign, Link2, RefreshCw, Download,
} from "lucide-react";
import { exportFilteredCsv } from "@/components/pulse/utils/qolHelpers";
import PresetControls from "@/components/pulse/utils/PresetControls";

// ── Signal Legend ─────────────────────────────────────────────────────────────
// Every kind pulseSignalGenerator / pulseRelistDetector can emit today. Keep in
// sync with supabase/functions/pulseSignalGenerator/index.ts and
// supabase/functions/pulseRelistDetector/index.ts.
const SIGNAL_LEGEND = [
  {
    group: "Movement",
    items: [
      {
        kind: "agent_movement",
        label: "Agent moved agencies",
        icon: ArrowRight,
        level: "person",
        category: "movement",
        trigger: "pulse_timeline agency_change event detected in last 24h (agent switched agency between scrapes).",
        action: "Congratulate and reconnect with the agent at their new agency.",
      },
      {
        kind: "relist",
        label: "Listing re-listed (re-shoot candidate)",
        icon: RefreshCw,
        level: "person",
        category: "movement",
        trigger: "Same property_key went withdrawn then back to for_sale / for_rent / under_contract within 30 days.",
        action: "Offer the listing agent a re-shoot — owner has re-committed to marketing.",
      },
    ],
  },
  {
    group: "Market",
    items: [
      {
        kind: "price_drop",
        label: "Price drop",
        icon: DollarSign,
        level: "organisation",
        category: "market",
        trigger: "pulse_timeline price_change event with at least one listing's new price below old price.",
        action: "Reach out — motivated vendor may now need re-marketing or a fresh campaign.",
      },
      {
        kind: "agency_growth",
        label: "Agency growth surge",
        icon: Building2,
        level: "organisation",
        category: "market",
        trigger: "≥2 first_seen agent events at the same agency_rea_id within 24h.",
        action: "Review the agency — if a dormant prospect, re-engage while they're expanding.",
      },
    ],
  },
  {
    group: "CRM",
    items: [
      {
        kind: "crm_suggestion",
        label: "New CRM match suggestion",
        icon: Link2,
        level: "person / organisation",
        category: "custom",
        trigger: "pulse_crm_mappings row inserted with confidence='suggested' (auto-mapper proposes a link).",
        action: "Open the Mappings tab and confirm or reject.",
      },
    ],
  },
];

const LEVEL_BADGE = {
  industry:     "bg-purple-100 text-purple-700",
  organisation: "bg-blue-100 text-blue-700",
  person:       "bg-green-100 text-green-700",
};

// ── Filter config ─────────────────────────────────────────────────────────────

// Level values must match pulse_signals.level CHECK constraint and PulseSignalCard/QuickAdd
// vocab (industry/organisation/person). Earlier iteration used high/medium/low which
// doesn't match anything in the DB — result was an always-empty grid.
const LEVEL_OPTIONS = [
  { value: "all",          label: "All Levels" },
  { value: "industry",     label: "Industry" },
  { value: "organisation", label: "Organisation" },
  { value: "person",       label: "Person" },
];

// Status values must match pulse_signals.status CHECK (new/acknowledged/actioned/dismissed).
const STATUS_OPTIONS = [
  { value: "all",          label: "All Status" },
  { value: "new",          label: "New" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "actioned",     label: "Actioned" },
  { value: "dismissed",    label: "Dismissed" },
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

// ── Filter bar ────────────────────────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "level",  label: "By level" },
];

// Priority used by "By level" sort: industry first, then org, then person.
const LEVEL_PRIORITY = { industry: 0, organisation: 1, person: 2 };

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

export default function PulseSignals({ pulseSignals = [], search = "" }) {
  const [levelFilter, setLevelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [addOpen, setAddOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  // #46: update signal status (acknowledge / action / dismiss) with toast+undo
  // on dismiss. `restoreSignal` reverts back to the original status captured
  // at dismiss time.
  const updateStatus = useCallback(async (id, status) => {
    try {
      await api.entities.PulseSignal.update(id, { status });
      await refetchEntityList("PulseSignal");
    } catch (err) {
      toast.error("Failed to update signal: " + (err?.message || "Unknown error"));
    }
  }, []);

  const handleAcknowledge = useCallback((signal) => {
    updateStatus(signal.id, "acknowledged");
  }, [updateStatus]);

  const handleAction = useCallback((signal) => {
    updateStatus(signal.id, "actioned");
  }, [updateStatus]);

  const handleDismiss = useCallback((signal) => {
    const prevStatus = signal.status || "new";
    updateStatus(signal.id, "dismissed");
    // #46: show toast with Undo action that restores the prior status.
    toast("Signal dismissed", {
      action: {
        label: "Undo",
        onClick: () => updateStatus(signal.id, prevStatus),
      },
      duration: 5000,
    });
  }, [updateStatus]);

  // Counts for badges
  const counts = useMemo(() => {
    const result = { level: {}, status: {} };
    for (const s of pulseSignals) {
      if (s.level)  result.level[s.level]   = (result.level[s.level]   || 0) + 1;
      if (s.status) result.status[s.status] = (result.status[s.status] || 0) + 1;
    }
    return result;
  }, [pulseSignals]);

  // Filtered + sorted signals
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = pulseSignals.filter((s) => {
      if (levelFilter  !== "all" && s.level  !== levelFilter)  return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (q) {
        // PulseSignal has no agent_name/agency_name columns — those were
        // phantom references from a pre-schema draft. Search only the fields
        // that actually exist on the record.
        const hay = [s.title, s.description, s.suggested_action, s.category]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // Sort
    list = [...list].sort((a, b) => {
      if (sortBy === "newest") {
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      }
      if (sortBy === "oldest") {
        return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      }
      // by level: high > medium > low
      const pa = LEVEL_PRIORITY[a.level] ?? 3;
      const pb = LEVEL_PRIORITY[b.level] ?? 3;
      if (pa !== pb) return pa - pb;
      // secondary sort: newest first within same level
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    return list;
  }, [pulseSignals, levelFilter, statusFilter, search, sortBy]);

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
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
            onClick={() => setLegendOpen(true)}
            title="What are all these signal types?"
          >
            <HelpCircle className="h-3.5 w-3.5" />
            Legend
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Sort selector */}
          <div className="flex items-center gap-1">
            <ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="h-8 text-xs rounded-md border bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {/* #51: filter presets — persists levelFilter/statusFilter/sortBy per-tab */}
          <PresetControls
            namespace="signals"
            currentPreset={{ levelFilter, statusFilter, sortBy }}
            onLoad={(p) => {
              if (p?.levelFilter)  setLevelFilter(p.levelFilter);
              if (p?.statusFilter) setStatusFilter(p.statusFilter);
              if (p?.sortBy)       setSortBy(p.sortBy);
            }}
          />
          {/* #52: export filtered signals as CSV (UTF-8 BOM) */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px] gap-1"
            onClick={() => {
              const headers = [
                { key: "id",                label: "id" },
                { key: "created_at",        label: "created_at" },
                { key: "level",             label: "level" },
                { key: "status",            label: "status" },
                { key: "category",          label: "category" },
                { key: "title",             label: "title" },
                { key: "description",       label: "description" },
                { key: "suggested_action",  label: "suggested_action" },
                { key: "source_type",       label: "source_type" },
                { key: "is_actionable",     label: "is_actionable" },
              ];
              const stamp = new Date().toISOString().slice(0, 10);
              exportFilteredCsv(`pulse_signals_${stamp}.csv`, headers, filtered);
            }}
            disabled={filtered.length === 0}
            title="Download the currently filtered signals as CSV"
          >
            <Download className="h-3 w-3" />
            Download CSV
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Signal
          </Button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-1">
        {/* Level filters */}
        {LEVEL_OPTIONS.map((opt) => (
          <FilterButton
            key={opt.value}
            active={levelFilter === opt.value}
            label={
              opt.value === "all"
                ? opt.label
                : `${opt.label}${counts.level[opt.value] ? ` (${counts.level[opt.value]})` : ""}`
            }
            colorClass={LEVEL_COLORS[opt.value] || ""}
            onClick={() => setLevelFilter(opt.value)}
          />
        ))}
        <span className="text-muted-foreground text-xs mx-1">|</span>
        {/* Status filters */}
        {STATUS_OPTIONS.map((opt) => (
          <FilterButton
            key={opt.value}
            active={statusFilter === opt.value}
            label={
              opt.value === "all"
                ? opt.label
                : `${opt.label}${counts.status[opt.value] ? ` (${counts.status[opt.value]})` : ""}`
            }
            colorClass={STATUS_COLORS[opt.value] || ""}
            onClick={() => setStatusFilter(opt.value)}
          />
        ))}
      </div>

      {/* ── Grid ── */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Zap className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No signals found</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            {pulseSignals.length === 0
              ? "Add a signal manually or run a scrape to auto-generate signals."
              : "Try adjusting the filters above."}
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-7 text-xs mt-2"
            onClick={() => setLegendOpen(true)}
          >
            <HelpCircle className="h-3.5 w-3.5 mr-1" />
            See the signal legend
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((signal) => (
            <PulseSignalCard
              key={signal.id}
              signal={signal}
              onAcknowledge={handleAcknowledge}
              onAction={handleAction}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}

      {/* ── Add signal dialog ── */}
      {addOpen && (
        <PulseSignalQuickAdd open={addOpen} onClose={() => setAddOpen(false)} />
      )}

      {/* ── Signal legend ── */}
      <SignalLegendDialog open={legendOpen} onClose={() => setLegendOpen(false)} />
    </div>
  );
}
