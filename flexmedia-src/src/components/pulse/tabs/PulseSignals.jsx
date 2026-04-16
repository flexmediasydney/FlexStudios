/**
 * PulseSignals — Industry Pulse "Signals" tab.
 * Filtered grid of PulseSignalCard components with Add Signal dialog.
 */
import React, { useState, useMemo } from "react";
import PulseSignalCard from "@/components/nurturing/PulseSignalCard";
import PulseSignalQuickAdd from "@/components/nurturing/PulseSignalQuickAdd";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Plus, Zap, ArrowDownUp } from "lucide-react";

// ── Filter config ─────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [
  { value: "all",    label: "All Levels" },
  { value: "high",   label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low",    label: "Low" },
];

const STATUS_OPTIONS = [
  { value: "all",          label: "All Status" },
  { value: "new",          label: "New" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved",     label: "Resolved" },
];

const LEVEL_COLORS = {
  high:   "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  low:    "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400",
};

const STATUS_COLORS = {
  new:          "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  acknowledged: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  resolved:     "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
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

const LEVEL_PRIORITY = { high: 0, medium: 1, low: 2 };

export default function PulseSignals({ pulseSignals = [], search = "" }) {
  const [levelFilter, setLevelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [addOpen, setAddOpen] = useState(false);

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
        const hay = [s.title, s.description, s.agent_name, s.agency_name]
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
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((signal) => (
            <PulseSignalCard key={signal.id} signal={signal} />
          ))}
        </div>
      )}

      {/* ── Add signal dialog ── */}
      {addOpen && (
        <PulseSignalQuickAdd open={addOpen} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}
