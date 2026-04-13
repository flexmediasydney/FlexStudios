import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Shield, ShieldAlert, CheckCircle2, AlertTriangle, RefreshCw, Loader2,
  ChevronDown, ChevronRight, MoreHorizontal, ArrowLeft,
  Eye, Flag, CheckCheck, CircleDot, Clock, User, FileText, Building2,
  Users, RotateCcw, Calendar, Search, TrendingDown
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
/*  Risk level priority helper                                         */
/* ------------------------------------------------------------------ */
const RISK_PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };

function worstRiskLevel(alerts) {
  let worst = "low";
  for (const a of alerts) {
    if (a.risk_level && (RISK_PRIORITY[a.risk_level] ?? 4) < (RISK_PRIORITY[worst] ?? 4)) {
      worst = a.risk_level;
    }
  }
  return worst;
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
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Alert actions" aria-label="Alert actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</span>
            <InvestigationStatusBadge status={status} />
          </div>

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
/*  Alerts Investigation Table (agent drill-down)                      */
/* ------------------------------------------------------------------ */
function AlertsTable({ alerts, onAction, isPending }) {
  if (!alerts || alerts.length === 0) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="py-16 text-center">
          <Shield className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
          <p className="font-semibold text-foreground">No active alerts</p>
          <p className="text-sm text-muted-foreground mt-1">
            All coverage gaps have been resolved or investigated. You're in good shape.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50 border-b border-border text-left">
            <th className="px-4 py-3 font-medium text-muted-foreground select-none">Address</th>
            <th className="px-4 py-3 font-medium text-muted-foreground select-none">Price</th>
            <th className="px-4 py-3 font-medium text-muted-foreground select-none">Listed</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Risk</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Seen</th>
            <th className="px-4 py-3 font-medium text-muted-foreground select-none">Investigator</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center w-[52px] select-none">Actions</th>
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
/*  Stat card component                                                */
/* ------------------------------------------------------------------ */
function StatCard({ label, value, icon: Icon, iconBg, iconColor, valueColor }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider select-none">{label}</p>
            <p className={cn("text-3xl font-bold tabular-nums mt-1", valueColor || "text-foreground")}>
              {value}
            </p>
          </div>
          <div className={cn("h-11 w-11 rounded-xl flex items-center justify-center", iconBg || "bg-slate-100")}>
            <Icon className={cn("h-5 w-5", iconColor || "text-slate-500")} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  MAIN PAGE — Client Retention Dashboard                             */
/* ================================================================== */
export default function ClientMonitor() {
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [expandedOrgs, setExpandedOrgs] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const queryClient = useQueryClient();

  /* ---- Current user (for investigation mutations) ---- */
  const { data: user } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  /* ================================================================ */
  /*  DASHBOARD DATA                                                   */
  /* ================================================================ */

  const { data: monitoredAgents = [], loading: agentsLoading } = useEntityList("Agent", "name");
  const filteredAgents = useMemo(
    () => monitoredAgents.filter((a) => a.domain_agent_id),
    [monitoredAgents]
  );

  const { data: allAlerts = [], loading: alertsLoading } = useEntityList("RetentionAlert", "first_detected_at");
  const { data: allAgencies = [], loading: agenciesLoading } = useEntityList("Agency", "name");

  const isLoadingDashboard = agentsLoading || alertsLoading || agenciesLoading;

  /* ---- Aggregate org + agent stats ---- */
  const { orgStats, totals } = useMemo(() => {
    // Build agent lookup
    const agentById = {};
    for (const a of filteredAgents) {
      agentById[a.id] = a;
    }

    // Build agency lookup
    const agencyById = {};
    for (const ag of allAgencies) {
      agencyById[ag.id] = ag;
    }

    // Group alerts by agent
    const alertsByAgent = {};
    for (const alert of allAlerts) {
      if (!alertsByAgent[alert.agent_id]) alertsByAgent[alert.agent_id] = [];
      alertsByAgent[alert.agent_id].push(alert);
    }

    // Build per-agent stats
    const agentStats = {};
    for (const agent of filteredAgents) {
      const agentAlerts = alertsByAgent[agent.id] || [];
      const active = agentAlerts.filter((a) => a.is_active !== false);
      const critical = active.filter((a) => a.risk_level === "critical");
      const identified = active.filter((a) => a.investigation_status === "identified");
      const investigating = active.filter((a) => a.investigation_status === "investigating");
      const resolved = agentAlerts.filter((a) =>
        ["passed", "checked"].includes(a.investigation_status)
      );
      const redFlagged = active.filter((a) => a.investigation_status === "red_flag");

      // Coverage: resolved + passed / total
      const total = agentAlerts.length;
      const covPct = total > 0 ? Math.round((resolved.length / total) * 100) : 100;

      // Last swept: most recent last_seen_at or sweep_date
      let lastSwept = null;
      for (const al of agentAlerts) {
        const d = al.last_seen_at || al.sweep_date;
        if (d && (!lastSwept || d > lastSwept)) lastSwept = d;
      }

      agentStats[agent.id] = {
        agent,
        alerts: agentAlerts,
        activeAlerts: active,
        activeCount: active.length,
        criticalCount: critical.length,
        identifiedCount: identified.length,
        investigatingCount: investigating.length,
        resolvedCount: resolved.length,
        redFlagCount: redFlagged.length,
        worstRisk: worstRiskLevel(active),
        coverage: covPct,
        lastSwept,
      };
    }

    // Group agents by agency
    const orgMap = {};
    const noOrg = { id: "__unassigned__", name: "Unassigned" };

    for (const agent of filteredAgents) {
      const orgId = agent.current_agency_id || "__unassigned__";
      if (!orgMap[orgId]) {
        const agency = agencyById[orgId] || noOrg;
        orgMap[orgId] = {
          id: orgId,
          name: agency.name || "Unassigned",
          agents: [],
          activeCount: 0,
          criticalCount: 0,
          identifiedCount: 0,
          investigatingCount: 0,
          resolvedCount: 0,
          redFlagCount: 0,
          worstRisk: "low",
          coverage: 0,
          engagementTypes: new Set(),
        };
      }
      const org = orgMap[orgId];
      const stat = agentStats[agent.id];
      org.agents.push(stat);
      org.activeCount += stat.activeCount;
      org.criticalCount += stat.criticalCount;
      org.identifiedCount += stat.identifiedCount;
      org.investigatingCount += stat.investigatingCount;
      org.resolvedCount += stat.resolvedCount;
      org.redFlagCount += stat.redFlagCount;

      if (agent.engagement_type) org.engagementTypes.add(agent.engagement_type);

      // Worst risk across agents in org
      if ((RISK_PRIORITY[stat.worstRisk] ?? 4) < (RISK_PRIORITY[org.worstRisk] ?? 4)) {
        org.worstRisk = stat.worstRisk;
      }
    }

    // Compute average coverage per org
    for (const org of Object.values(orgMap)) {
      if (org.agents.length > 0) {
        org.coverage = Math.round(
          org.agents.reduce((sum, a) => sum + a.coverage, 0) / org.agents.length
        );
      }
    }

    // Sort orgs: those with critical alerts first, then by active count desc
    const sorted = Object.values(orgMap).sort((a, b) => {
      if (a.criticalCount !== b.criticalCount) return b.criticalCount - a.criticalCount;
      if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
      return a.name.localeCompare(b.name);
    });

    // Compute grand totals
    const totalActive = allAlerts.filter((a) => a.is_active !== false);
    const totalCritical = totalActive.filter((a) => a.risk_level === "critical");
    const totalInvestigating = totalActive.filter((a) => a.investigation_status === "investigating");

    return {
      orgStats: sorted,
      totals: {
        monitoredAgents: filteredAgents.length,
        activeAlerts: totalActive.length,
        critical: totalCritical.length,
        investigating: totalInvestigating.length,
      },
    };
  }, [allAlerts, filteredAgents, allAgencies]);

  // Search filtering for orgs
  const filteredOrgStats = useMemo(() => {
    if (!searchQuery.trim()) return orgStats;
    const q = searchQuery.toLowerCase();
    return orgStats
      .map((org) => {
        // Check if org name matches
        if (org.name.toLowerCase().includes(q)) return org;
        // Otherwise filter agents within org
        const matchingAgents = org.agents.filter((a) =>
          a.agent.name?.toLowerCase().includes(q) ||
          a.agent.email?.toLowerCase().includes(q)
        );
        if (matchingAgents.length === 0) return null;
        return { ...org, agents: matchingAgents };
      })
      .filter(Boolean);
  }, [orgStats, searchQuery]);

  /* ---- Most recent sweep date ---- */
  const lastSweptDate = useMemo(() => {
    let latest = null;
    for (const a of allAlerts) {
      const d = a.last_seen_at || a.sweep_date;
      if (d && (!latest || d > latest)) latest = d;
    }
    return latest;
  }, [allAlerts]);

  /* ================================================================ */
  /*  SWEEP MUTATION                                                   */
  /* ================================================================ */
  const sweepMutation = useMutation({
    mutationFn: async () => {
      const res = await api.functions.invoke("retentionSweep", { source: "manual" });
      return res?.data || res;
    },
    onSuccess: (data) => {
      toast.success(
        `Sweep complete: ${data?.agents_scanned ?? data?.agents?.length ?? 0} agents scanned, ${data?.new_alerts ?? data?.totalNewAlerts ?? 0} new alerts`
      );
      queryClient.invalidateQueries({ queryKey: ["RetentionAlert"] });
      refetchEntityList("RetentionAlert");
    },
    onError: () => toast.error("Sweep failed"),
  });

  /* ================================================================ */
  /*  AGENT DRILL-DOWN                                                 */
  /* ================================================================ */

  const selectedAgent = useMemo(
    () => filteredAgents.find((a) => a.id === selectedAgentId),
    [filteredAgents, selectedAgentId]
  );

  const { data: agentData, isLoading: agentDataLoading, isFetching: agentDataFetching } = useQuery({
    queryKey: ["domain-monitor", selectedAgentId],
    queryFn: async () => {
      const res = await api.functions.invoke("domainAgentMonitor", { agent_id: selectedAgentId });
      return res?.data || res;
    },
    enabled: !!selectedAgentId,
    staleTime: 5 * 60_000,
  });

  const drillDownAlerts = useMemo(() => {
    if (!agentData?.alerts) return [];
    return agentData.alerts;
  }, [agentData]);

  const drillDownActiveAlerts = useMemo(
    () => drillDownAlerts.filter((a) => a.is_active !== false),
    [drillDownAlerts]
  );

  /* ---- Alert mutation (drill-down) ---- */
  const alertMutation = useMutation({
    mutationFn: async ({ action, alert_id, notes }) => {
      const statusMap = {
        start_investigating: "investigating",
        pass: "passed",
        check: "checked",
        red_flag: "red_flag",
        reopen: "investigating",
      };
      const body = action === "update_notes"
        ? { action: "update_notes", alert_id, notes, user_name: user?.full_name || user?.email, user_email: user?.email }
        : { action: "update_status", alert_id, status: statusMap[action] || action, user_id: user?.id, user_name: user?.full_name || user?.email, user_email: user?.email };
      const res = await api.functions.invoke("updateRetentionAlert", body);
      return res?.data || res;
    },
    onMutate: async ({ action, alert_id, notes }) => {
      await queryClient.cancelQueries({ queryKey: ["domain-monitor", selectedAgentId] });
      const prev = queryClient.getQueryData(["domain-monitor", selectedAgentId]);

      queryClient.setQueryData(["domain-monitor", selectedAgentId], (old) => {
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
        queryClient.setQueryData(["domain-monitor", selectedAgentId], context.prev);
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
      queryClient.invalidateQueries({ queryKey: ["domain-monitor", selectedAgentId] });
      refetchEntityList("RetentionAlert");
    },
  });

  const handleAlertAction = useCallback(
    (payload) => alertMutation.mutate(payload),
    [alertMutation]
  );

  /* ---- Toggle org expansion ---- */
  const toggleOrg = useCallback((orgId) => {
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) next.delete(orgId);
      else next.add(orgId);
      return next;
    });
  }, []);

  /* ================================================================ */
  /*  RENDER: AGENT DRILL-DOWN MODE                                    */
  /* ================================================================ */
  if (selectedAgentId && selectedAgent) {
    const agentInfo = agentData?.agent || selectedAgent;
    const dataSource = agentData?.data_source;
    const engagementType = agentInfo.engagement_type || selectedAgent.engagement_type;

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="max-w-7xl mx-auto p-6 space-y-6">
          {/* Back button + header */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-foreground mb-2 -ml-2"
                onClick={() => setSelectedAgentId(null)}
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Dashboard
              </Button>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-foreground leading-tight">
                  {agentInfo.name || selectedAgent.name}
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
              {(agentInfo.agency || selectedAgent.current_agency_name) && (
                <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  {agentInfo.agency || selectedAgent.current_agency_name}
                </p>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["domain-monitor", selectedAgentId] })
              }
              disabled={agentDataFetching}
              className="gap-1.5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", agentDataFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>

          {/* Exclusive banner */}
          {engagementType === "exclusive" && !agentDataLoading && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-800 text-sm">Exclusive Agent</p>
                <p className="text-xs text-red-700 mt-1">
                  All coverage gaps are flagged as <strong>critical retention risks</strong>. This agent expects full coverage on every listing.
                </p>
              </div>
            </div>
          )}

          {/* Loading */}
          {agentDataLoading && (
            <div className="flex items-center justify-center py-24">
              <div className="text-center space-y-3">
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">Scanning listings and retention risks...</p>
              </div>
            </div>
          )}

          {/* Agent stats strip */}
          {!agentDataLoading && agentData && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  label="Active Alerts"
                  value={drillDownActiveAlerts.length}
                  icon={ShieldAlert}
                  iconBg={drillDownActiveAlerts.length > 0 ? "bg-red-100" : "bg-emerald-100"}
                  iconColor={drillDownActiveAlerts.length > 0 ? "text-red-600" : "text-emerald-600"}
                  valueColor={drillDownActiveAlerts.length > 0 ? "text-red-600" : "text-emerald-600"}
                />
                <StatCard
                  label="Coverage"
                  value={`${agentData.stats?.coverage_pct ?? 0}%`}
                  icon={Shield}
                  iconBg="bg-blue-100"
                  iconColor="text-blue-600"
                  valueColor="text-foreground"
                />
                <StatCard
                  label="Total Listings"
                  value={agentData.all_listings?.length ?? 0}
                  icon={Building2}
                  iconBg="bg-slate-100"
                  iconColor="text-slate-500"
                />
              </div>

              <AlertsTable
                alerts={drillDownAlerts}
                onAction={handleAlertAction}
                isPending={alertMutation.isPending}
              />
            </>
          )}
        </div>
      </div>
    );
  }

  /* ================================================================ */
  /*  RENDER: DASHBOARD MODE                                           */
  /* ================================================================ */

  const riskColor = (level) => ({
    critical: "text-red-600",
    high: "text-orange-600",
    medium: "text-amber-600",
    low: "text-slate-500",
  }[level] || "text-slate-500");

  const riskBg = (level) => ({
    critical: "bg-red-100",
    high: "bg-orange-100",
    medium: "bg-amber-100",
    low: "bg-slate-100",
  }[level] || "bg-slate-100");

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto p-6 space-y-6">

        {/* ---------------------------------------------------------- */}
        {/*  Header                                                     */}
        {/* ---------------------------------------------------------- */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Shield className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground leading-tight select-none">
                  Client Retention
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Monitor customer engagement and coverage gaps across all agents
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {lastSweptDate && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                Last swept: {relativeTime(lastSweptDate)}
              </span>
            )}
            <Button
              variant="default"
              size="sm"
              className="gap-1.5"
              onClick={() => sweepMutation.mutate()}
              disabled={sweepMutation.isPending}
            >
              {sweepMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Run Sweep
            </Button>
          </div>
        </div>

        {/* ---------------------------------------------------------- */}
        {/*  Summary Stats Strip                                        */}
        {/* ---------------------------------------------------------- */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Monitored Agents"
            value={totals.monitoredAgents}
            icon={Users}
            iconBg="bg-blue-100"
            iconColor="text-blue-600"
          />
          <StatCard
            label="Active Alerts"
            value={totals.activeAlerts}
            icon={ShieldAlert}
            iconBg={totals.activeAlerts > 0 ? riskBg("high") : "bg-emerald-100"}
            iconColor={totals.activeAlerts > 0 ? "text-orange-600" : "text-emerald-600"}
            valueColor={totals.activeAlerts > 0 ? "text-orange-600" : "text-emerald-600"}
          />
          <StatCard
            label="Critical"
            value={totals.critical}
            icon={AlertTriangle}
            iconBg={totals.critical > 0 ? "bg-red-100" : "bg-slate-100"}
            iconColor={totals.critical > 0 ? "text-red-600" : "text-slate-400"}
            valueColor={totals.critical > 0 ? "text-red-600" : "text-slate-500"}
          />
          <StatCard
            label="Investigating"
            value={totals.investigating}
            icon={Eye}
            iconBg={totals.investigating > 0 ? "bg-amber-100" : "bg-slate-100"}
            iconColor={totals.investigating > 0 ? "text-amber-600" : "text-slate-400"}
            valueColor={totals.investigating > 0 ? "text-amber-600" : "text-slate-500"}
          />
        </div>

        {/* ---------------------------------------------------------- */}
        {/*  Search                                                     */}
        {/* ---------------------------------------------------------- */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search organisations or agents..."
            className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border border-border bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors"
          />
        </div>

        {/* ---------------------------------------------------------- */}
        {/*  Loading state                                              */}
        {/* ---------------------------------------------------------- */}
        {isLoadingDashboard && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center space-y-3">
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">Loading retention data...</p>
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------- */}
        {/*  Empty state                                                */}
        {/* ---------------------------------------------------------- */}
        {!isLoadingDashboard && filteredAgents.length === 0 && (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-20 text-center">
              <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-slate-100 mb-4">
                <Users className="h-8 w-8 text-slate-400" />
              </div>
              <p className="font-semibold text-foreground text-lg">No monitored agents yet</p>
              <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                No agents have a Domain Agent ID configured yet. Set up agent domain IDs in the Contacts section to begin monitoring retention.
              </p>
            </CardContent>
          </Card>
        )}

        {/* ---------------------------------------------------------- */}
        {/*  No search results                                          */}
        {/* ---------------------------------------------------------- */}
        {!isLoadingDashboard && filteredAgents.length > 0 && filteredOrgStats.length === 0 && searchQuery && (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <Search className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-semibold text-foreground">No results found</p>
              <p className="text-sm text-muted-foreground mt-1">
                No organisations or agents match your search. Try a different term.
              </p>
            </CardContent>
          </Card>
        )}

        {/* ---------------------------------------------------------- */}
        {/*  Organisation table                                         */}
        {/* ---------------------------------------------------------- */}
        {!isLoadingDashboard && filteredOrgStats.length > 0 && (
          <div className="rounded-xl border border-border bg-white shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground w-8 select-none"></th>
                  <th className="px-4 py-3 font-medium text-muted-foreground select-none">Organisation</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Agents</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Active Alerts</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Critical</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Coverage</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-center select-none">Worst Risk</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground select-none">Status Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredOrgStats.map((org) => {
                  const isExpanded = expandedOrgs.has(org.id);
                  const hasCritical = org.criticalCount > 0;
                  const engTypes = Array.from(org.engagementTypes);

                  return (
                    <OrgRowGroup
                      key={org.id}
                      org={org}
                      isExpanded={isExpanded}
                      hasCritical={hasCritical}
                      engTypes={engTypes}
                      onToggle={() => toggleOrg(org.id)}
                      onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Org Row Group — parent row + expandable agent rows                 */
/* ================================================================== */
function OrgRowGroup({ org, isExpanded, hasCritical, engTypes, onToggle, onSelectAgent }) {
  return (
    <>
      {/* Organisation row */}
      <tr
        className={cn(
          "hover:bg-muted/30 transition-colors cursor-pointer select-none",
          hasCritical && "bg-red-50/30"
        )}
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-center">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4 text-slate-500" />
            </div>
            <div>
              <p className="font-semibold text-foreground">{org.name}</p>
              {engTypes.length > 0 && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  {engTypes.map((t) => (
                    <EngagementBadge key={t} type={t} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-center">
          <span className="tabular-nums font-medium text-foreground">{org.agents.length}</span>
        </td>
        <td className="px-4 py-3 text-center">
          {org.activeCount > 0 ? (
            <Badge
              variant="outline"
              className={cn(
                "text-xs font-semibold border tabular-nums",
                hasCritical
                  ? "bg-red-100 text-red-700 border-red-300"
                  : "bg-amber-100 text-amber-700 border-amber-300"
              )}
            >
              {org.activeCount}
            </Badge>
          ) : (
            <span className="text-sm text-emerald-600 font-medium">0</span>
          )}
        </td>
        <td className="px-4 py-3 text-center">
          {org.criticalCount > 0 ? (
            <Badge variant="outline" className="text-xs font-semibold border bg-red-100 text-red-700 border-red-300 tabular-nums">
              {org.criticalCount}
            </Badge>
          ) : (
            <span className="text-sm text-muted-foreground">0</span>
          )}
        </td>
        <td className="px-4 py-3 text-center">
          <CoverageIndicator value={org.coverage} />
        </td>
        <td className="px-4 py-3 text-center">
          <RiskBadge level={org.worstRisk} />
        </td>
        <td className="px-4 py-3">
          <StatusSummary
            identified={org.identifiedCount}
            investigating={org.investigatingCount}
            resolved={org.resolvedCount}
            redFlag={org.redFlagCount}
          />
        </td>
      </tr>

      {/* Expanded agent rows */}
      {isExpanded &&
        org.agents.map((agentStat) => (
          <tr
            key={agentStat.agent.id}
            className="hover:bg-blue-50/40 transition-colors bg-muted/20"
          >
            <td className="px-4 py-2.5"></td>
            <td className="px-4 py-2.5 pl-16">
              <button
                className="text-left group"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(agentStat.agent.id);
                }}
              >
                <span className="font-medium text-foreground group-hover:text-primary group-hover:underline underline-offset-2 transition-colors">
                  {agentStat.agent.name}
                </span>
                {agentStat.agent.email && (
                  <p className="text-xs text-muted-foreground mt-0.5">{agentStat.agent.email}</p>
                )}
              </button>
            </td>
            <td className="px-4 py-2.5 text-center">
              <EngagementBadge type={agentStat.agent.engagement_type} />
            </td>
            <td className="px-4 py-2.5 text-center">
              {agentStat.activeCount > 0 ? (
                <span className={cn("font-semibold tabular-nums", agentStat.criticalCount > 0 ? "text-red-600" : "text-amber-600")}>
                  {agentStat.activeCount}
                </span>
              ) : (
                <span className="text-sm text-emerald-600 font-medium">0</span>
              )}
            </td>
            <td className="px-4 py-2.5 text-center">
              <RiskBadge level={agentStat.worstRisk} />
            </td>
            <td className="px-4 py-2.5 text-center">
              <CoverageIndicator value={agentStat.coverage} />
            </td>
            <td className="px-4 py-2.5 text-center">
              {/* Worst risk is already shown in adjacent column */}
            </td>
            <td className="px-4 py-2.5">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {agentStat.lastSwept ? relativeTime(agentStat.lastSwept) : "Never"}
              </span>
            </td>
          </tr>
        ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Coverage % indicator                                               */
/* ------------------------------------------------------------------ */
function CoverageIndicator({ value }) {
  const color =
    value >= 80 ? "text-emerald-600" :
    value >= 50 ? "text-amber-600" :
    "text-red-600";

  const barColor =
    value >= 80 ? "bg-emerald-500" :
    value >= 50 ? "bg-amber-500" :
    "bg-red-500";

  return (
    <div className="flex items-center gap-2 justify-center">
      <div className="w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className={cn("text-xs font-semibold tabular-nums", color)}>{value}%</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Status summary (mini breakdown)                                    */
/* ------------------------------------------------------------------ */
function StatusSummary({ identified, investigating, resolved, redFlag }) {
  if (identified + investigating + resolved + redFlag === 0) {
    return <span className="text-xs text-muted-foreground">No alerts</span>;
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      {identified > 0 && (
        <span className="flex items-center gap-1 text-blue-600">
          <CircleDot className="h-3 w-3" />
          <span className="tabular-nums font-medium">{identified}</span>
          <span className="text-blue-500 hidden lg:inline">new</span>
        </span>
      )}
      {investigating > 0 && (
        <span className="flex items-center gap-1 text-amber-600">
          <Eye className="h-3 w-3" />
          <span className="tabular-nums font-medium">{investigating}</span>
          <span className="text-amber-500 hidden lg:inline">open</span>
        </span>
      )}
      {resolved > 0 && (
        <span className="flex items-center gap-1 text-emerald-600">
          <CheckCircle2 className="h-3 w-3" />
          <span className="tabular-nums font-medium">{resolved}</span>
          <span className="text-emerald-500 hidden lg:inline">done</span>
        </span>
      )}
      {redFlag > 0 && (
        <span className="flex items-center gap-1 text-red-600">
          <Flag className="h-3 w-3" />
          <span className="tabular-nums font-medium">{redFlag}</span>
          <span className="text-red-500 hidden lg:inline">flagged</span>
        </span>
      )}
    </div>
  );
}
