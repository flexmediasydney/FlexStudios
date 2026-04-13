import { useState, useMemo } from "react";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/api/supabaseClient";
import PulseSignalCard from "@/components/nurturing/PulseSignalCard";
import PulseSignalQuickAdd from "@/components/nurturing/PulseSignalQuickAdd";
import {
  Rss, Plus, Loader2, Zap, Building2, User, Globe, Search,
  CheckCircle2, Eye, Sparkles,
} from "lucide-react";

const LEVEL_FILTERS = [
  { key: "all",          label: "All",          icon: Globe },
  { key: "industry",     label: "Industry",     icon: Globe },
  { key: "organisation", label: "Organisation", icon: Building2 },
  { key: "person",       label: "Person",       icon: User },
];

const STATUS_FILTERS = [
  { key: "all",          label: "All" },
  { key: "new",          label: "New" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "actioned",     label: "Actioned" },
];

export default function IndustryPulse() {
  const { data: signals = [], loading } = useEntityList("PulseSignal", "-created_at");
  const { data: agents = [] } = useEntityList("Agent", "name");
  const { data: agencies = [] } = useEntityList("Agency", "name");

  const [levelFilter, setLevelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filteredSignals = useMemo(() => {
    return signals.filter((s) => {
      if (levelFilter !== "all" && (s.level || "").toLowerCase() !== levelFilter) return false;
      if (statusFilter !== "all" && (s.status || "new").toLowerCase() !== statusFilter) return false;
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const inTitle = (s.title || "").toLowerCase().includes(term);
        const inDesc = (s.description || "").toLowerCase().includes(term);
        if (!inTitle && !inDesc) return false;
      }
      return true;
    });
  }, [signals, levelFilter, statusFilter, searchTerm]);

  // ── Counts for filter badges ───────────────────────────────────────────────
  const levelCounts = useMemo(() => {
    const counts = { all: signals.length, industry: 0, organisation: 0, person: 0 };
    signals.forEach((s) => {
      const lev = (s.level || "").toLowerCase();
      if (counts[lev] !== undefined) counts[lev]++;
    });
    return counts;
  }, [signals]);

  const statusCounts = useMemo(() => {
    const counts = { all: signals.length, new: 0, acknowledged: 0, actioned: 0 };
    signals.forEach((s) => {
      const st = (s.status || "new").toLowerCase();
      if (counts[st] !== undefined) counts[st]++;
    });
    return counts;
  }, [signals]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleAction = async (signal) => {
    try {
      await api.entities.PulseSignal.update(signal.id, { status: "actioned" });
      refetchEntityList("PulseSignal");
      toast.success("Signal marked as actioned");
    } catch {
      toast.error("Failed to update signal");
    }
  };

  const handleAcknowledge = async (signal) => {
    try {
      await api.entities.PulseSignal.update(signal.id, { status: "acknowledged" });
      refetchEntityList("PulseSignal");
      toast.success("Signal acknowledged");
    } catch {
      toast.error("Failed to acknowledge signal");
    }
  };

  const handleDismiss = async (signal) => {
    try {
      await api.entities.PulseSignal.update(signal.id, { status: "dismissed" });
      refetchEntityList("PulseSignal");
      toast.success("Signal dismissed");
    } catch {
      toast.error("Failed to dismiss signal");
    }
  };

  // ── Skeleton loader ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-background p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-6 w-48 bg-muted rounded animate-pulse" />
            <div className="h-3 w-72 bg-muted rounded animate-pulse" />
          </div>
          <div className="h-8 w-28 bg-muted rounded animate-pulse" />
        </div>
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-7 w-24 bg-muted rounded-full animate-pulse" />
          ))}
        </div>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 w-full bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2 select-none">
              <Rss className="h-5 w-5 text-primary" />
              Industry Pulse
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Track events, movements, and signals across the real estate industry
            </p>
          </div>
          <Button size="sm" className="gap-1.5 h-8" onClick={() => setShowQuickAdd(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add Signal
          </Button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Level pills */}
          <div className="flex gap-1 bg-card p-1 rounded-lg shadow-sm">
            {LEVEL_FILTERS.map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                variant={levelFilter === key ? "default" : "ghost"}
                size="sm"
                className="gap-1.5 h-7 text-xs"
                onClick={() => setLevelFilter(key)}
              >
                <Icon className="h-3 w-3" />
                {label}
                <Badge
                  variant="secondary"
                  className="h-4 min-w-4 px-1 text-[9px] font-bold"
                >
                  {levelCounts[key]}
                </Badge>
              </Button>
            ))}
          </div>

          {/* Status pills */}
          <div className="flex gap-1 bg-card p-1 rounded-lg shadow-sm">
            {STATUS_FILTERS.map(({ key, label }) => (
              <Button
                key={key}
                variant={statusFilter === key ? "default" : "ghost"}
                size="sm"
                className="gap-1.5 h-7 text-xs"
                onClick={() => setStatusFilter(key)}
              >
                {label}
                <Badge
                  variant="secondary"
                  className="h-4 min-w-4 px-1 text-[9px] font-bold"
                >
                  {statusCounts[key]}
                </Badge>
              </Button>
            ))}
          </div>

          {/* Search */}
          <div className="relative ml-auto max-w-xs">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search signals..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 h-7 text-xs"
            />
          </div>
        </div>

        {/* Signal feed */}
        {filteredSignals.length > 0 ? (
          <div className="space-y-3 pb-6">
            {filteredSignals.map((signal) => (
              <PulseSignalCard
                key={signal.id}
                signal={signal}
                agents={agents}
                agencies={agencies}
                onAction={handleAction}
                onAcknowledge={handleAcknowledge}
                onDismiss={handleDismiss}
              />
            ))}
          </div>
        ) : (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-20 text-center select-none">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-5">
              <Rss className="h-8 w-8 text-primary/40" />
            </div>
            <h2 className="text-lg font-semibold mb-1">
              {signals.length === 0 ? "No signals captured yet" : "No matching signals found"}
            </h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              {signals.length === 0
                ? "Start tracking industry events, agent movements, and market signals to stay ahead of the competition."
                : "Try adjusting your filters or broadening your search to find what you're looking for."}
            </p>
            {signals.length === 0 ? (
              <Button size="sm" className="mt-4 gap-1.5" onClick={() => setShowQuickAdd(true)}>
                <Plus className="h-3.5 w-3.5" />
                Capture First Signal
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setLevelFilter("all");
                  setStatusFilter("all");
                  setSearchTerm("");
                }}
              >
                Clear Filters
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Quick-add dialog */}
      <PulseSignalQuickAdd
        open={showQuickAdd}
        onClose={() => setShowQuickAdd(false)}
        agents={agents}
        agencies={agencies}
      />
    </div>
  );
}
