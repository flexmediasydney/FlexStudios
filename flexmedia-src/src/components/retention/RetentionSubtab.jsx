import { useState, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Shield, AlertTriangle, CheckCircle2, Eye, Clock, MoreHorizontal, Flag, CircleDot, CheckCheck, Archive } from "lucide-react";

const RISK_STYLES = {
  critical: "bg-red-100 text-red-700 border-red-300",
  high:     "bg-orange-100 text-orange-700 border-orange-300",
  medium:   "bg-amber-100 text-amber-700 border-amber-300",
  low:      "bg-slate-100 text-slate-600 border-slate-200",
};

const STATUS_CONFIG = {
  identified:    { label: "Identified",    cls: "bg-blue-100 text-blue-700 border-blue-200",       icon: CircleDot },
  investigating: { label: "Investigating", cls: "bg-amber-100 text-amber-700 border-amber-200",    icon: Eye },
  passed:        { label: "Passed",        cls: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  checked:       { label: "Checked",       cls: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCheck },
  red_flag:      { label: "Red Flag",      cls: "bg-red-100 text-red-700 border-red-300",          icon: Flag },
};

const STATUS_TRANSITIONS = {
  identified:    ["investigating", "passed", "red_flag"],
  investigating: ["passed", "checked", "red_flag"],
  passed:        ["investigating"],
  checked:       ["investigating"],
  red_flag:      ["investigating"],
};

function fmtDate(val) {
  if (!val) return "—";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.identified;
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium border gap-1 px-1.5 py-0", cfg.cls)}>
      <Icon className="h-3 w-3" /> {cfg.label}
    </Badge>
  );
}

function RiskBadge({ level }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] font-semibold border px-1.5 py-0 capitalize", RISK_STYLES[level] || RISK_STYLES.low)}>
      {level || "low"}
    </Badge>
  );
}

export default function RetentionSubtab({ entityType, entityId, entityLabel }) {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useState("active"); // "active" | "historical"
  const [editingNotes, setEditingNotes] = useState({});
  const [notesDraft, setNotesDraft] = useState({});

  // Load ALL alerts for this entity
  const { data: allAlerts = [], isLoading } = useQuery({
    queryKey: ["retention-alerts", entityType, entityId],
    queryFn: async () => {
      const col = entityType === "agent" ? "agent_id" : "agency_id";
      return await api.entities.RetentionAlert.filter({ [col]: entityId }, "first_detected_at", 500) || [];
    },
    enabled: !!entityId,
  });

  // Load agents for agency-level view (to show agent names)
  const { data: agents = [] } = useEntityList(entityType === "agency" ? "Agent" : null, "name");
  const agentMap = useMemo(() => {
    const m = {};
    agents.forEach(a => { m[a.id] = a.name; });
    return m;
  }, [agents]);

  const { data: user } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });

  // Split active vs historical
  const activeAlerts = useMemo(() => allAlerts.filter(a => a.is_active), [allAlerts]);
  const historicalAlerts = useMemo(() => allAlerts.filter(a => !a.is_active), [allAlerts]);

  const displayAlerts = activeView === "active" ? activeAlerts : historicalAlerts;

  // Stats
  const criticalCount = activeAlerts.filter(a => a.risk_level === "critical").length;
  const investigatingCount = activeAlerts.filter(a => a.investigation_status === "investigating").length;
  const redFlagCount = allAlerts.filter(a => a.investigation_status === "red_flag").length;

  // Mutation for status/notes changes
  const updateMutation = useMutation({
    mutationFn: async (payload) => {
      const res = await api.functions.invoke("updateRetentionAlert", payload);
      return res?.data || res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["retention-alerts", entityType, entityId] });
    },
    onError: () => toast.error("Failed to update alert"),
  });

  const handleStatusChange = (alertId, newStatus) => {
    updateMutation.mutate({
      action: "update_status",
      alert_id: alertId,
      status: newStatus,
      user_id: user?.id,
      user_name: user?.full_name || user?.email,
      user_email: user?.email,
    });
    toast.success(`Status → ${newStatus.replace("_", " ")}`);
  };

  const handleSaveNotes = (alertId) => {
    const draft = notesDraft[alertId];
    if (draft == null) return;
    updateMutation.mutate({
      action: "update_notes",
      alert_id: alertId,
      notes: draft,
      user_name: user?.full_name || user?.email,
      user_email: user?.email,
    });
    setEditingNotes(p => ({ ...p, [alertId]: false }));
    toast.success("Notes saved");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (allAlerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center px-6">
        <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
          <Shield className="h-6 w-6 text-green-600" />
        </div>
        <p className="text-sm font-medium text-foreground">No retention alerts</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
          No coverage gaps detected for {entityLabel || "this entity"}. Run a sweep from the Client Retention dashboard to check.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Summary stats */}
      <div className="flex items-center gap-4 px-4 py-3 border-b bg-muted/30 flex-wrap select-none">
        <div className="flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Total</span>
          <span className="text-xs font-bold">{allAlerts.length}</span>
          <span className="text-[10px] text-muted-foreground">({activeAlerts.length} active / {historicalAlerts.length} historical)</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <AlertTriangle className={cn("h-3.5 w-3.5", criticalCount > 0 ? "text-red-500" : "text-muted-foreground")} />
          <span className="text-xs text-muted-foreground">Critical</span>
          <span className={cn("text-xs font-bold", criticalCount > 0 && "text-red-600")}>{criticalCount}</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Investigating</span>
          <span className="text-xs font-bold">{investigatingCount}</span>
        </div>
        {redFlagCount > 0 && (
          <>
            <div className="w-px h-4 bg-border" />
            <div className="flex items-center gap-1.5">
              <Flag className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs text-muted-foreground">Red Flags</span>
              <span className="text-xs font-bold text-red-600">{redFlagCount}</span>
            </div>
          </>
        )}
      </div>

      {/* Active / Historical toggle */}
      <div className="flex items-center gap-1 px-4 py-2 border-b">
        <Button
          size="sm"
          variant={activeView === "active" ? "default" : "ghost"}
          className="h-7 text-xs gap-1.5"
          onClick={() => setActiveView("active")}
        >
          <Shield className="h-3 w-3" />
          Active Listings ({activeAlerts.length})
        </Button>
        <Button
          size="sm"
          variant={activeView === "historical" ? "default" : "ghost"}
          className="h-7 text-xs gap-1.5"
          onClick={() => setActiveView("historical")}
        >
          <Archive className="h-3 w-3" />
          Historical ({historicalAlerts.length})
        </Button>
      </div>

      {/* Table */}
      {displayAlerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {activeView === "active" ? "All clear. No active retention alerts for this record." : "No historical records yet. Resolved alerts will appear here."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/20 select-none">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Address</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Price</th>
                {entityType === "agency" && <th className="text-left px-3 py-2 font-medium text-muted-foreground">Agent</th>}
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Listing</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Risk</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Seen</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Detected</th>
                {activeView === "historical" && <th className="text-left px-3 py-2 font-medium text-muted-foreground">Resolved</th>}
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Investigator</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayAlerts.map(alert => (
                <tr key={alert.id} className={cn("border-b hover:bg-muted/30 transition-colors", !alert.is_active && "opacity-60")}>
                  <td className="px-3 py-2.5 max-w-[220px]">
                    <p className="font-medium truncate">{alert.address || "—"}</p>
                    {alert.headline && <p className="text-[10px] text-muted-foreground truncate mt-0.5">{alert.headline}</p>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{alert.display_price || "—"}</td>
                  {entityType === "agency" && (
                    <td className="px-3 py-2.5 whitespace-nowrap">{agentMap[alert.agent_id] || "—"}</td>
                  )}
                  <td className="px-3 py-2.5">
                    <Badge variant="outline" className={cn("text-[10px] border px-1.5 py-0",
                      alert.listing_status === "for_sale" ? "bg-blue-50 text-blue-700 border-blue-200" :
                      alert.listing_status === "sold" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                      "bg-slate-50 text-slate-600 border-slate-200"
                    )}>
                      {alert.listing_status === "for_sale" ? "For Sale" : alert.listing_status === "sold" ? "Sold" : alert.listing_status || "—"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5"><RiskBadge level={alert.risk_level} /></td>
                  <td className="px-3 py-2.5"><StatusBadge status={alert.investigation_status} /></td>
                  <td className="px-3 py-2.5 text-center tabular-nums">{alert.times_seen ?? 1}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(alert.first_detected_at)}</td>
                  {activeView === "historical" && <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(alert.resolved_at)}</td>}
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {alert.investigated_by_name ? (
                      <span className="text-muted-foreground">{alert.investigated_by_name}</span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="Alert actions" aria-label="Alert actions">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-72 p-3" align="end" side="bottom">
                        <div className="space-y-3">
                          {/* Status transitions */}
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5">Change Status</p>
                            <div className="flex flex-wrap gap-1">
                              {(STATUS_TRANSITIONS[alert.investigation_status] || []).map(next => (
                                <Button key={next} size="sm" variant="outline" className="h-6 px-2 text-[10px] capitalize"
                                  onClick={() => handleStatusChange(alert.id, next)}
                                  disabled={updateMutation.isPending}>
                                  {next.replace("_", " ")}
                                </Button>
                              ))}
                            </div>
                          </div>
                          {/* Notes */}
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5">Notes</p>
                            {editingNotes[alert.id] ? (
                              <div className="space-y-2">
                                <Textarea className="text-xs min-h-[60px] resize-none" placeholder="Add investigation notes..."
                                  value={notesDraft[alert.id] ?? alert.notes ?? ""}
                                  onChange={e => setNotesDraft(p => ({ ...p, [alert.id]: e.target.value }))} />
                                <div className="flex gap-1.5">
                                  <Button size="sm" className="h-6 px-2 text-[10px]" onClick={() => handleSaveNotes(alert.id)} disabled={updateMutation.isPending}>Save</Button>
                                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setEditingNotes(p => ({ ...p, [alert.id]: false }))}>Cancel</Button>
                                </div>
                              </div>
                            ) : (
                              <div>
                                {alert.notes && (
                                  <div className="mb-1.5">
                                    <p className="text-[11px] text-muted-foreground whitespace-pre-wrap">{alert.notes}</p>
                                    {alert.notes_updated_by && (
                                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">— {alert.notes_updated_by}, {fmtDate(alert.notes_updated_at)}</p>
                                    )}
                                  </div>
                                )}
                                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                                  onClick={() => { setNotesDraft(p => ({ ...p, [alert.id]: alert.notes ?? "" })); setEditingNotes(p => ({ ...p, [alert.id]: true })); }}>
                                  {alert.notes ? "Edit notes" : "Add notes"}
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
