import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import AgentSearch from "@/components/clientMonitor/AgentSearch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Search, CheckCircle2, AlertTriangle, Shield, ShieldAlert,
  Home, Bed, Bath, Car, Calendar, Eye, RefreshCw, Loader2,
  MoreHorizontal, ArrowRight, Clock, User, FileText,
  RotateCcw, Flag, CheckCheck, CircleDot
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Listing Status Badge                                               */
/* ------------------------------------------------------------------ */
function ListingStatusBadge({ status }) {
  if (!status) return null;
  const map = {
    for_sale:  { label: "For Sale",  className: "bg-blue-100 text-blue-700 border-blue-200" },
    sold:      { label: "Sold",      className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
    withdrawn: { label: "Withdrawn", className: "bg-slate-100 text-slate-600 border-slate-200" },
  };
  const c = map[status] || { label: status, className: "bg-slate-100 text-slate-600 border-slate-200" };
  return <Badge variant="outline" className={cn("text-xs border", c.className)}>{c.label}</Badge>;
}

/* ------------------------------------------------------------------ */
/*  Risk Level Badge                                                   */
/* ------------------------------------------------------------------ */
function RiskBadge({ level }) {
  if (!level) return null;
  const config = {
    critical: { label: "Critical", className: "bg-red-100 text-red-700 border-red-300" },
    high:     { label: "High",     className: "bg-orange-100 text-orange-700 border-orange-300" },
    medium:   { label: "Medium",   className: "bg-amber-100 text-amber-700 border-amber-300" },
    low:      { label: "Low",      className: "bg-slate-100 text-slate-600 border-slate-200" },
  };
  const c = config[level] || config.low;
  return <Badge variant="outline" className={cn("text-[11px] font-semibold border", c.className)}>{c.label}</Badge>;
}

/* ------------------------------------------------------------------ */
/*  Investigation Status Badge                                         */
/* ------------------------------------------------------------------ */
function InvestigationStatusBadge({ status }) {
  if (!status) return null;
  const config = {
    identified:    { label: "Identified",    className: "bg-blue-100 text-blue-700 border-blue-200",       icon: CircleDot },
    investigating: { label: "Investigating", className: "bg-amber-100 text-amber-700 border-amber-200",    icon: Eye },
    passed:        { label: "Passed",        className: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
    checked:       { label: "Checked",       className: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCheck },
    red_flag:      { label: "Red Flag",      className: "bg-red-100 text-red-700 border-red-300",          icon: Flag },
  };
  const c = config[status] || { label: status, className: "bg-slate-100 text-slate-600 border-slate-200", icon: CircleDot };
  const Icon = c.icon;
  return (
    <Badge variant="outline" className={cn("text-[11px] font-medium border gap-1", c.className)}>
      <Icon className="h-3 w-3" />
      {c.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/*  Engagement Type Badge                                              */
/* ------------------------------------------------------------------ */
function EngagementBadge({ type }) {
  if (type === "exclusive") {
    return (
      <Badge variant="outline" className="text-xs font-semibold border-2 border-red-400 text-red-700 bg-red-50">
        Exclusive
      </Badge>
    );
  }
  if (type === "non-exclusive" || type === "non_exclusive") {
    return (
      <Badge variant="outline" className="text-xs font-semibold border border-slate-300 text-slate-600 bg-slate-50">
        Non-Exclusive
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs font-medium border border-dashed border-slate-300 text-slate-400">
      Not Set
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/*  Relative time helper                                               */
/* ------------------------------------------------------------------ */
function relativeTime(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/* ------------------------------------------------------------------ */
/*  Format date as "13 Apr 2026"                                       */
/* ------------------------------------------------------------------ */
function formatDate(dateStr) {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-AU", {
    day: "numeric", month: "short", year: "numeric"
  });
}

/* ------------------------------------------------------------------ */
/*  Generate synthetic alerts from gaps (fallback)                     */
/* ------------------------------------------------------------------ */
function generateAlertsFromGaps(gaps, engagementType) {
  if (!gaps || gaps.length === 0) return [];
  return gaps.map((g, i) => {
    const listing = g.listing || g;
    return {
      id: `gap-${listing.domain_listing_id || i}`,
      address: listing.address,
      headline: listing.headline,
      display_price: listing.display_price,
      listing_status: listing.status,
      date_listed: listing.date_listed,
      investigation_status: "identified",
      risk_level: engagementType === "exclusive" ? "critical" : "medium",
      engagement_type: engagementType,
      investigated_by_name: null,
      investigated_at: null,
      resolved_at: null,
      notes: null,
      notes_updated_by: null,
      notes_updated_at: null,
      times_seen: 1,
      first_detected_at: listing.date_listed,
      last_seen_at: new Date().toISOString(),
      is_active: true,
      _synthetic: true,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Alert Action Popover                                               */
/* ------------------------------------------------------------------ */
function AlertActionPopover({ alert, onAction, isPending }) {
  const [notes, setNotes] = useState(alert.notes || "");
  const [open, setOpen] = useState(false);

  const status = alert.investigation_status;
  const isConcluded = ["passed", "checked", "red_flag"].includes(status);

  const handleAction = (action) => {
    onAction({ action, alert_id: alert.id, notes: undefined });
  };

  const handleSaveNotes = () => {
    onAction({ action: "update_notes", alert_id: alert.id, notes });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-4 space-y-4">
          {/* Current status header */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</span>
            <InvestigationStatusBadge status={status} />
          </div>

          {/* Status transition buttons */}
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</span>

            {status === "identified" && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2 text-amber-700 border-amber-200 hover:bg-amber-50"
                onClick={() => handleAction("start_investigating")}
                disabled={isPending}
              >
                <Eye className="h-3.5 w-3.5" />
                Start Investigating
              </Button>
            )}

            {status === "investigating" && (
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-center gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50 text-xs"
                  onClick={() => handleAction("pass")}
                  disabled={isPending}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Pass
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-center gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50 text-xs"
                  onClick={() => handleAction("check")}
                  disabled={isPending}
                >
                  <CheckCheck className="h-3 w-3" />
                  Checked
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-center gap-1 text-red-700 border-red-200 hover:bg-red-50 text-xs"
                  onClick={() => handleAction("red_flag")}
                  disabled={isPending}
                >
                  <Flag className="h-3 w-3" />
                  Red Flag
                </Button>
              </div>
            )}

            {isConcluded && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2 text-slate-700 border-slate-200 hover:bg-slate-50"
                onClick={() => handleAction("reopen")}
                disabled={isPending}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reopen Investigation
              </Button>
            )}
          </div>

          {/* Notes section */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</span>
              {alert.notes_updated_by && (
                <span className="text-[10px] text-muted-foreground">
                  {alert.notes_updated_by} {relativeTime(alert.notes_updated_at)}
                </span>
              )}
            </div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add investigation notes..."
              className="text-sm min-h-[72px] resize-none"
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={handleSaveNotes}
              disabled={isPending || notes === (alert.notes || "")}
            >
              <FileText className="h-3.5 w-3.5" />
              Save Notes
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/*  Alerts Table                                                       */
/* ------------------------------------------------------------------ */
function AlertsTable({ alerts, onAction, isPending }) {
  if (!alerts || alerts.length === 0) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="py-16 text-center">
          <Shield className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
          <p className="font-semibold text-foreground">No active alerts</p>
          <p className="text-sm text-muted-foreground mt-1">
            All coverage gaps have been resolved or investigated
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50 border-b border-border text-left">
            <th className="px-4 py-3 font-medium text-muted-foreground">Address</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Price</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Listed</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Risk</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Seen</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Investigator</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center w-[52px]">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {alerts.map((a) => (
            <tr
              key={a.id}
              className={cn(
                "hover:bg-muted/30 transition-colors",
                a.risk_level === "critical" && "bg-red-50/40",
                a.risk_level === "high" && "bg-orange-50/30"
              )}
            >
              <td className="px-4 py-3 max-w-[300px]">
                <p className="font-medium text-foreground truncate">{a.address}</p>
                {a.headline && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{a.headline}</p>
                )}
              </td>
              <td className="px-4 py-3 text-foreground whitespace-nowrap font-medium">
                {a.display_price || "--"}
              </td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs">
                {formatDate(a.date_listed)}
              </td>
              <td className="px-4 py-3 text-center">
                <RiskBadge level={a.risk_level} />
              </td>
              <td className="px-4 py-3 text-center">
                <InvestigationStatusBadge status={a.investigation_status} />
              </td>
              <td className="px-4 py-3 text-center tabular-nums font-medium text-muted-foreground">
                {a.times_seen ?? 1}
              </td>
              <td className="px-4 py-3">
                {a.investigated_by_name ? (
                  <div className="flex items-center gap-1.5 text-xs">
                    <User className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-foreground font-medium truncate max-w-[100px]">{a.investigated_by_name}</span>
                    {a.investigated_at && (
                      <span className="text-muted-foreground shrink-0">{relativeTime(a.investigated_at)}</span>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">--</span>
                )}
              </td>
              <td className="px-4 py-3 text-center">
                <AlertActionPopover alert={a} onAction={onAction} isPending={isPending} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  All Listings Table                                                 */
/* ------------------------------------------------------------------ */
function AllListingsTable({ listings, matches, alerts, dataSource }) {
  const matchedIds = useMemo(
    () => new Set((matches || []).map((m) => m.listing?.domain_listing_id)),
    [matches]
  );

  const alertsByListing = useMemo(() => {
    const map = {};
    (alerts || []).forEach((a) => {
      if (a.address) map[a.address] = a;
    });
    return map;
  }, [alerts]);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50 border-b border-border text-left">
            <th className="px-4 py-3 font-medium text-muted-foreground">Address</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Price</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Beds</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Baths</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Cars</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Match</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Risk</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {(listings || []).map((l, i) => {
            const isMatched = matchedIds.has(l.domain_listing_id);
            const alert = !isMatched ? alertsByListing[l.address] : null;
            return (
              <tr key={l.domain_listing_id || i} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium text-foreground max-w-[280px] truncate">
                  {l.address}
                  {dataSource === "simulation" && (
                    <Badge variant="outline" className="ml-2 text-[8px] uppercase tracking-wider font-bold bg-amber-100 text-amber-600 border-amber-300">Sample</Badge>
                  )}
                </td>
                <td className="px-4 py-3"><ListingStatusBadge status={l.status} /></td>
                <td className="px-4 py-3 text-foreground whitespace-nowrap">{l.display_price || "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.bedrooms ?? "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.bathrooms ?? "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.carspaces ?? "--"}</td>
                <td className="px-4 py-3 text-center">
                  {isMatched ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-medium">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Matched
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" /> Gap
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  {alert ? <RiskBadge level={alert.risk_level} /> : (
                    <span className="text-xs text-muted-foreground">--</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(!listings || listings.length === 0) && (
        <div className="text-center py-12 text-muted-foreground text-sm">No listings found</div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  MAIN PAGE — Client Retention Engine                                */
/* ================================================================== */
export default function ClientMonitor() {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [activeView, setActiveView] = useState("alerts");
  const queryClient = useQueryClient();

  /* ---- Current user (for mutations) ---- */
  const { data: user } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  /* ---- Main data query ---- */
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["domain-monitor", selectedAgent?.id],
    queryFn: async () => {
      const res = await api.functions.invoke("domainAgentMonitor", { agent_id: selectedAgent.id });
      return res?.data || res || {};
    },
    enabled: !!selectedAgent?.id,
    staleTime: 5 * 60 * 1000,
  });

  /* ---- Derived data ---- */
  const stats = data?.stats || {};
  const agent = data?.agent || selectedAgent || {};
  const gaps = data?.gaps || [];
  const matches = data?.matches || [];
  const allListings = data?.all_listings || [];
  const dataSource = data?.data_source;
  const engagementType = agent.engagement_type;

  // Use server-provided alerts or fall back to generating from gaps
  const alerts = useMemo(() => {
    if (data?.alerts && data.alerts.length > 0) return data.alerts;
    return generateAlertsFromGaps(gaps, engagementType);
  }, [data?.alerts, gaps, engagementType]);

  const activeAlerts = useMemo(() => alerts.filter((a) => a.is_active !== false), [alerts]);

  const worstRisk = useMemo(() => {
    const priority = { critical: 0, high: 1, medium: 2, low: 3 };
    let worst = "low";
    for (const a of activeAlerts) {
      if (a.risk_level && (priority[a.risk_level] ?? 4) < (priority[worst] ?? 4)) {
        worst = a.risk_level;
      }
    }
    return worst;
  }, [activeAlerts]);

  /* ---- Alert mutation ---- */
  const alertMutation = useMutation({
    mutationFn: async ({ action, alert_id, notes }) => {
      const res = await api.functions.invoke("updateRetentionAlert", {
        action,
        alert_id,
        notes,
        user_id: user?.id,
        user_name: user?.full_name || user?.email,
      });
      return res?.data || res;
    },
    onMutate: async ({ action, alert_id, notes }) => {
      await queryClient.cancelQueries({ queryKey: ["domain-monitor", selectedAgent?.id] });
      const prev = queryClient.getQueryData(["domain-monitor", selectedAgent?.id]);

      queryClient.setQueryData(["domain-monitor", selectedAgent?.id], (old) => {
        if (!old?.alerts) return old;
        const statusMap = {
          start_investigating: "investigating",
          pass: "passed",
          check: "checked",
          red_flag: "red_flag",
          reopen: "investigating",
        };
        return {
          ...old,
          alerts: old.alerts.map((a) => {
            if (a.id !== alert_id) return a;
            const updates = {};
            if (action === "update_notes") {
              updates.notes = notes;
              updates.notes_updated_by = user?.full_name || user?.email || "You";
              updates.notes_updated_at = new Date().toISOString();
            } else if (statusMap[action]) {
              updates.investigation_status = statusMap[action];
              updates.investigated_by_name = user?.full_name || user?.email || "You";
              updates.investigated_at = new Date().toISOString();
            }
            return { ...a, ...updates };
          }),
        };
      });

      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(["domain-monitor", selectedAgent?.id], context.prev);
      }
      toast.error("Failed to update alert");
    },
    onSuccess: (_data, { action }) => {
      const labels = {
        start_investigating: "Investigation started",
        pass: "Alert passed",
        check: "Alert checked",
        red_flag: "Flagged as red flag",
        reopen: "Investigation reopened",
        update_notes: "Notes saved",
      };
      toast.success(labels[action] || "Alert updated");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["domain-monitor", selectedAgent?.id] });
    },
  });

  const handleAlertAction = (payload) => {
    alertMutation.mutate(payload);
  };

  /* ---------------------------------------------------------------- */
  /*  Phase 1: Agent Selection                                        */
  /* ---------------------------------------------------------------- */
  if (!selectedAgent) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
        <div className="max-w-2xl mx-auto pt-12">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-primary/10 mb-4">
              <ShieldAlert className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Client Retention</h1>
            <p className="text-muted-foreground text-lg">
              Select an agent to monitor retention risks and coverage alerts
            </p>
          </div>

          <Card className="p-8 shadow-lg border-0 bg-white">
            <AgentSearch onSelect={setSelectedAgent} />
          </Card>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Phase 2: Retention Dashboard                                    */
  /* ---------------------------------------------------------------- */
  const coveragePct = stats.coverage_pct ?? 0;

  const alertCountColor = {
    critical: "text-red-600",
    high: "text-orange-600",
    medium: "text-amber-600",
    low: "text-slate-500",
  }[worstRisk] || "text-slate-500";

  const alertCountBg = {
    critical: "bg-red-100",
    high: "bg-orange-100",
    medium: "bg-amber-100",
    low: "bg-slate-100",
  }[worstRisk] || "bg-slate-100";

  const alertIconColor = {
    critical: "text-red-600",
    high: "text-orange-600",
    medium: "text-amber-600",
    low: "text-slate-400",
  }[worstRisk] || "text-slate-400";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto p-6 space-y-6">

        {/* -------------------------------------------------------- */}
        {/*  Header                                                   */}
        {/* -------------------------------------------------------- */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-foreground leading-tight">
                {agent.name || selectedAgent.name}
              </h1>
              <EngagementBadge type={engagementType} />
              {dataSource && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] uppercase tracking-wider font-semibold border",
                    dataSource === "domain_api"
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-amber-50 text-amber-700 border-amber-200"
                  )}
                >
                  {dataSource === "domain_api" ? "Live" : "Simulation"}
                </Badge>
              )}
            </div>
            {(agent.agency || selectedAgent.current_agency_name) && (
              <p className="text-sm text-muted-foreground mt-1">
                {agent.agency || selectedAgent.current_agency_name}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="gap-1.5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedAgent(null);
                setActiveView("alerts");
              }}
            >
              Change Agent
            </Button>
          </div>
        </div>

        {/* -------------------------------------------------------- */}
        {/*  Exclusive agent warning banner                           */}
        {/* -------------------------------------------------------- */}
        {engagementType === "exclusive" && !isLoading && (
          <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-4 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-800 dark:text-red-300 text-sm">Exclusive Agent</p>
              <p className="text-xs text-red-700 dark:text-red-400 mt-1">
                All coverage gaps are flagged as <strong>critical retention risks</strong>. This agent expects full coverage on every listing.
              </p>
            </div>
          </div>
        )}

        {/* -------------------------------------------------------- */}
        {/*  Simulation warning banner                                */}
        {/* -------------------------------------------------------- */}
        {dataSource === "simulation" && !isLoading && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm">Simulated Data</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                This agent does not have a Domain Agent ID configured, so all listings shown are <strong>sample data</strong> for demonstration purposes.
                To show real listings, edit the agent record and set their Domain Agent ID.
              </p>
            </div>
          </div>
        )}

        {/* -------------------------------------------------------- */}
        {/*  Loading state                                            */}
        {/* -------------------------------------------------------- */}
        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center space-y-3">
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">Scanning listings and retention risks...</p>
            </div>
          </div>
        )}

        {!isLoading && data && (
          <>
            {/* ------------------------------------------------------ */}
            {/*  Stats Strip                                            */}
            {/* ------------------------------------------------------ */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Active Alerts */}
              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Active Alerts</p>
                      <p className={cn("text-3xl font-bold tabular-nums mt-1", alertCountColor)}>
                        {activeAlerts.length}
                      </p>
                    </div>
                    <div className={cn("h-11 w-11 rounded-xl flex items-center justify-center", alertCountBg)}>
                      <ShieldAlert className={cn("h-5 w-5", alertIconColor)} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Matched */}
              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Matched</p>
                      <p className="text-3xl font-bold text-emerald-600 tabular-nums mt-1">{stats.matched ?? 0}</p>
                    </div>
                    <div className="h-11 w-11 rounded-xl bg-emerald-100 flex items-center justify-center">
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Coverage */}
              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Coverage</p>
                      <div className="flex items-baseline gap-1 mt-1">
                        <span className={cn(
                          "text-3xl font-bold tabular-nums",
                          coveragePct >= 75 ? "text-emerald-600" : coveragePct >= 50 ? "text-amber-600" : "text-red-600"
                        )}>
                          {coveragePct}
                        </span>
                        <span className="text-lg font-semibold text-muted-foreground">%</span>
                      </div>
                    </div>
                    <div className={cn(
                      "h-11 w-11 rounded-xl flex items-center justify-center",
                      coveragePct >= 75 ? "bg-emerald-100" : coveragePct >= 50 ? "bg-amber-100" : "bg-red-100"
                    )}>
                      <Shield className={cn(
                        "h-5 w-5",
                        coveragePct >= 75 ? "text-emerald-600" : coveragePct >= 50 ? "text-amber-600" : "text-red-600"
                      )} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* ------------------------------------------------------ */}
            {/*  View Toggle                                            */}
            {/* ------------------------------------------------------ */}
            <div className="flex items-center gap-1 bg-white border shadow-sm rounded-lg p-1 w-fit">
              <button
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5",
                  activeView === "alerts"
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
                onClick={() => setActiveView("alerts")}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Alerts
                {activeAlerts.length > 0 && (
                  <span className={cn(
                    "ml-1 text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[20px] text-center leading-none",
                    activeView === "alerts" ? "bg-white/20 text-white" : "bg-red-100 text-red-700"
                  )}>
                    {activeAlerts.length}
                  </span>
                )}
              </button>
              <button
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5",
                  activeView === "listings"
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
                onClick={() => setActiveView("listings")}
              >
                <Home className="h-3.5 w-3.5" />
                All Listings
                {allListings.length > 0 && (
                  <span className={cn(
                    "ml-1 text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[20px] text-center leading-none",
                    activeView === "listings" ? "bg-white/20 text-white" : "bg-slate-200 text-slate-600"
                  )}>
                    {allListings.length}
                  </span>
                )}
              </button>
            </div>

            {/* ------------------------------------------------------ */}
            {/*  Alerts View                                            */}
            {/* ------------------------------------------------------ */}
            {activeView === "alerts" && (
              <AlertsTable
                alerts={activeAlerts}
                onAction={handleAlertAction}
                isPending={alertMutation.isPending}
              />
            )}

            {/* ------------------------------------------------------ */}
            {/*  All Listings View                                      */}
            {/* ------------------------------------------------------ */}
            {activeView === "listings" && (
              <Card className="border-0 shadow-sm overflow-hidden">
                <AllListingsTable
                  listings={allListings}
                  matches={matches}
                  alerts={alerts}
                  dataSource={dataSource}
                />
              </Card>
            )}
          </>
        )}

        {/* No data / error fallback */}
        {!isLoading && !data && selectedAgent && (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <AlertTriangle className="h-12 w-12 text-amber-300 mx-auto mb-3" />
              <p className="font-semibold text-foreground">Unable to load retention data</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                The monitor did not return data for this agent.
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" /> Try Again
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
