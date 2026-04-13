import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Shield, AlertTriangle, CheckCircle2, Search, Clock, MoreHorizontal } from "lucide-react";

const RISK_STYLES = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high:     "bg-orange-100 text-orange-800 border-orange-200",
  medium:   "bg-amber-100 text-amber-800 border-amber-200",
  low:      "bg-gray-100 text-gray-700 border-gray-200",
};

const STATUS_STYLES = {
  identified:    "bg-blue-100 text-blue-800 border-blue-200",
  investigating: "bg-amber-100 text-amber-800 border-amber-200",
  passed:        "bg-green-100 text-green-800 border-green-200",
  checked:       "bg-green-100 text-green-800 border-green-200",
  red_flag:      "bg-red-100 text-red-800 border-red-200",
};

const STATUS_TRANSITIONS = {
  identified:    ["investigating", "passed", "red_flag"],
  investigating: ["passed", "checked", "red_flag"],
  passed:        ["investigating", "red_flag"],
  checked:       ["investigating", "red_flag"],
  red_flag:      ["investigating", "checked"],
};

function fmtDate(val) {
  if (!val) return "-";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function fmtCurrency(val) {
  if (val == null) return "-";
  const n = Number(val);
  if (isNaN(n)) return "-";
  return `$${n.toLocaleString()}`;
}

export default function RetentionSubtab({ entityType, entityId, entityLabel }) {
  const queryClient = useQueryClient();
  const [expandedNotes, setExpandedNotes] = useState({});
  const [editingNotes, setEditingNotes] = useState({});
  const [notesDraft, setNotesDraft] = useState({});

  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ["retention-alerts", entityType, entityId],
    queryFn: async () => {
      const col = entityType === "agent" ? "agent_id" : "agency_id";
      const result = await api.entities.RetentionAlert.filter(
        { [col]: entityId },
        "first_detected_at",
        500
      );
      return result || [];
    },
    enabled: !!entityId,
  });

  const { data: user } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  const updateMutation = useMutation({
    mutationFn: (payload) =>
      api.functions.invoke("updateRetentionAlert", { body: payload }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["retention-alerts", entityType, entityId],
      });
    },
    onError: () => {
      toast.error("Failed to update alert");
    },
  });

  const handleStatusChange = (alertId, newStatus) => {
    updateMutation.mutate({
      id: alertId,
      status: newStatus,
      updated_by: user?.email || "",
    });
    toast.success(`Status changed to ${newStatus.replace("_", " ")}`);
  };

  const handleSaveNotes = (alertId) => {
    const draft = notesDraft[alertId];
    if (draft == null) return;
    updateMutation.mutate({
      id: alertId,
      notes: draft,
      updated_by: user?.email || "",
    });
    setEditingNotes((p) => ({ ...p, [alertId]: false }));
    toast.success("Notes saved");
  };

  // Stats
  const activeAlerts = alerts.filter(
    (a) => a.status !== "passed" && a.status !== "checked"
  );
  const resolvedAlerts = alerts.filter(
    (a) => a.status === "passed" || a.status === "checked"
  );
  const criticalCount = alerts.filter((a) => a.risk_level === "critical").length;
  const investigatingCount = alerts.filter(
    (a) => a.status === "investigating"
  ).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center px-6">
        <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
          <Shield className="h-6 w-6 text-green-600" />
        </div>
        <p className="text-sm font-medium text-foreground">
          No retention alerts
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
          All coverage gaps are accounted for. No retention alerts found for{" "}
          {entityLabel || "this entity"}.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Summary stats bar */}
      <div className="flex items-center gap-4 px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Total</span>
          <span className="text-xs font-bold">{alerts.length}</span>
          <span className="text-[10px] text-muted-foreground">
            ({activeAlerts.length} active / {resolvedAlerts.length} resolved)
          </span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <AlertTriangle
            className={cn(
              "h-3.5 w-3.5",
              criticalCount > 0 ? "text-red-500" : "text-muted-foreground"
            )}
          />
          <span className="text-xs text-muted-foreground">Critical</span>
          <span
            className={cn(
              "text-xs font-bold",
              criticalCount > 0 ? "text-red-600" : ""
            )}
          >
            {criticalCount}
          </span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Investigating</span>
          <span className="text-xs font-bold">{investigatingCount}</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Resolved</span>
          <span className="text-xs font-bold">{resolvedAlerts.length}</span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/20">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                Address
              </th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                Price
              </th>
              {entityType === "agency" && (
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                  Agent
                </th>
              )}
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                Risk
              </th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                Status
              </th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">
                Seen
              </th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                First Detected
              </th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                Notes
              </th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr
                key={alert.id}
                className="border-b hover:bg-muted/30 transition-colors"
              >
                {/* Address + headline */}
                <td className="px-3 py-2.5 max-w-[220px]">
                  <p className="font-medium truncate">{alert.address || "-"}</p>
                  {alert.headline && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {alert.headline}
                    </p>
                  )}
                </td>

                {/* Price */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {fmtCurrency(alert.price)}
                </td>

                {/* Agent (agency only) */}
                {entityType === "agency" && (
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {alert.agent_name || "-"}
                  </td>
                )}

                {/* Risk */}
                <td className="px-3 py-2.5">
                  <Badge
                    className={cn(
                      "text-[10px] font-medium border px-1.5 py-0",
                      RISK_STYLES[alert.risk_level] || RISK_STYLES.low
                    )}
                  >
                    {alert.risk_level || "low"}
                  </Badge>
                </td>

                {/* Status */}
                <td className="px-3 py-2.5">
                  <Badge
                    className={cn(
                      "text-[10px] font-medium border px-1.5 py-0",
                      STATUS_STYLES[alert.status] || STATUS_STYLES.identified
                    )}
                  >
                    {(alert.status || "identified").replace("_", " ")}
                  </Badge>
                </td>

                {/* Times Seen */}
                <td className="px-3 py-2.5 text-center">
                  {alert.times_seen ?? 1}
                </td>

                {/* First Detected */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {fmtDate(alert.first_detected_at)}
                </td>

                {/* Notes preview */}
                <td className="px-3 py-2.5 max-w-[180px]">
                  {alert.notes ? (
                    <button
                      onClick={() =>
                        setExpandedNotes((p) => ({
                          ...p,
                          [alert.id]: !p[alert.id],
                        }))
                      }
                      className="text-left text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <p
                        className={cn(
                          "text-[11px]",
                          expandedNotes[alert.id] ? "" : "truncate max-w-[160px]"
                        )}
                      >
                        {alert.notes}
                      </p>
                    </button>
                  ) : (
                    <span className="text-muted-foreground/50">-</span>
                  )}
                </td>

                {/* Actions */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center justify-center gap-1">
                    {/* Status transitions */}
                    {(STATUS_TRANSITIONS[alert.status] || [])
                      .slice(0, 2)
                      .map((next) => (
                        <Button
                          key={next}
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() => handleStatusChange(alert.id, next)}
                          disabled={updateMutation.isPending}
                        >
                          {next.replace("_", " ")}
                        </Button>
                      ))}

                    {/* More actions + Notes popover */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-72 p-3"
                        align="end"
                        side="bottom"
                      >
                        <div className="space-y-3">
                          {/* All status transitions */}
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5">
                              Change Status
                            </p>
                            <div className="flex flex-wrap gap-1">
                              {(STATUS_TRANSITIONS[alert.status] || []).map(
                                (next) => (
                                  <Button
                                    key={next}
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() =>
                                      handleStatusChange(alert.id, next)
                                    }
                                    disabled={updateMutation.isPending}
                                  >
                                    {next.replace("_", " ")}
                                  </Button>
                                )
                              )}
                            </div>
                          </div>

                          {/* Notes editing */}
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5">
                              Notes
                            </p>
                            {editingNotes[alert.id] ? (
                              <div className="space-y-2">
                                <Textarea
                                  className="text-xs min-h-[60px] resize-none"
                                  placeholder="Add notes..."
                                  value={
                                    notesDraft[alert.id] ?? alert.notes ?? ""
                                  }
                                  onChange={(e) =>
                                    setNotesDraft((p) => ({
                                      ...p,
                                      [alert.id]: e.target.value,
                                    }))
                                  }
                                />
                                <div className="flex gap-1.5">
                                  <Button
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() => handleSaveNotes(alert.id)}
                                    disabled={updateMutation.isPending}
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() =>
                                      setEditingNotes((p) => ({
                                        ...p,
                                        [alert.id]: false,
                                      }))
                                    }
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div>
                                {alert.notes && (
                                  <p className="text-[11px] text-muted-foreground mb-1.5 whitespace-pre-wrap">
                                    {alert.notes}
                                  </p>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => {
                                    setNotesDraft((p) => ({
                                      ...p,
                                      [alert.id]: alert.notes ?? "",
                                    }));
                                    setEditingNotes((p) => ({
                                      ...p,
                                      [alert.id]: true,
                                    }));
                                  }}
                                >
                                  {alert.notes ? "Edit notes" : "Add notes"}
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
