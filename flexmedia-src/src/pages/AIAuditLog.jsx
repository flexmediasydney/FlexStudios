/**
 * AIAuditLog.jsx — Admin-only AI action audit log / live feed.
 *
 * Shows real-time AI actions with filtering by user, project, and date.
 * Each entry is expandable to reveal the full JSONB action payload.
 * Summary stats (today count, success rate, cost) computed from loaded data.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Activity, ChevronDown, ChevronRight, Filter, Loader2, RefreshCw,
  Check, XCircle, Clock, DollarSign, Sparkles, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

function isToday(isoString) {
  if (!isoString) return false;
  const d = new Date(isoString);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

// ── Component ───────────────────────────────────────────────────────────────

export default function AIAuditLog() {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();

  // Pagination
  const [limit, setLimit] = useState(50);

  // Filters
  const [filterUser, setFilterUser] = useState("all");
  const [filterProject, setFilterProject] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Expanded entries
  const [expandedIds, setExpandedIds] = useState(new Set());

  // ── Data fetching ─────────────────────────────────────────────────────

  const { data: logs = [], isLoading, refetch } = useQuery({
    queryKey: ["aiActionLogs", limit],
    queryFn: () => api.entities.AiActionLog.list("-created_at", limit),
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-audit"],
    queryFn: () => api.entities.User.list("full_name"),
    staleTime: 5 * 60 * 1000,
  });

  // User lookup map
  const userMap = useMemo(() => {
    const m = {};
    for (const u of users) {
      m[u.id] = u.full_name || u.email || u.id;
    }
    return m;
  }, [users]);

  // ── Realtime subscription ─────────────────────────────────────────────

  useEffect(() => {
    const unsubscribe = api.entities.AiActionLog.subscribe((event) => {
      queryClient.invalidateQueries({ queryKey: ["aiActionLogs"] });
    });
    return unsubscribe;
  }, [queryClient]);

  // ── Filtering ─────────────────────────────────────────────────────────

  const filteredLogs = useMemo(() => {
    let result = logs;

    if (filterUser && filterUser !== "all") {
      result = result.filter((l) => l.user_id === filterUser);
    }
    if (filterProject.trim()) {
      const q = filterProject.toLowerCase();
      result = result.filter((l) =>
        (l.project_title || "").toLowerCase().includes(q) ||
        (l.project_id || "").toLowerCase().includes(q)
      );
    }
    if (filterDateFrom) {
      const from = new Date(filterDateFrom);
      result = result.filter((l) => new Date(l.created_at) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter((l) => new Date(l.created_at) <= to);
    }

    return result;
  }, [logs, filterUser, filterProject, filterDateFrom, filterDateTo]);

  // ── Summary stats (from loaded data) ──────────────────────────────────

  const stats = useMemo(() => {
    const todayLogs = logs.filter((l) => isToday(l.created_at));
    const total = todayLogs.length;
    const success = todayLogs.filter((l) => l.status !== "error" && l.status !== "failed").length;
    const rate = total > 0 ? Math.round((success / total) * 100) : 0;
    const cost = todayLogs.reduce((sum, l) => sum + (l.cost_usd || 0), 0);
    return { total, rate, cost };
  }, [logs]);

  // ── Toggle expand ─────────────────────────────────────────────────────

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Load more ─────────────────────────────────────────────────────────

  const loadMore = () => setLimit((prev) => prev + 50);

  // ── Auth guard ────────────────────────────────────────────────────────

  if (user?.role !== "master_admin") {
    return (
      <div className="p-6 lg:p-8">
        <p className="text-muted-foreground">You do not have access to this page.</p>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Activity className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">AI Audit Log</h1>
          </div>
          <p className="text-muted-foreground text-sm">Real-time feed of all AI assistant actions.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading} title="Refresh audit log entries">
          <RefreshCw className={cn("h-4 w-4 mr-2", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{stats.total}</p>
              <p className="text-xs text-muted-foreground">Today</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{stats.rate}%</p>
              <p className="text-xs text-muted-foreground">Success</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <DollarSign className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">${stats.cost.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Today</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={filterUser} onValueChange={setFilterUser}>
              <SelectTrigger className="w-44 h-9 text-sm">
                <SelectValue placeholder="All users" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Users</SelectItem>
                {users.filter(u => u.is_active !== false).map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filterProject}
                onChange={(e) => setFilterProject(e.target.value)}
                placeholder="Search project..."
                className="w-44 h-9 text-sm pl-8"
              />
            </div>
            <Input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="w-36 h-9 text-sm"
              title="From date"
            />
            <Input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="w-36 h-9 text-sm"
              title="To date"
            />
            {(filterUser !== "all" || filterProject || filterDateFrom || filterDateTo) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-xs"
                onClick={() => {
                  setFilterUser("all");
                  setFilterProject("");
                  setFilterDateFrom("");
                  setFilterDateTo("");
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Log Feed */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : filteredLogs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Activity className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No AI actions found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Pagination info */}
          <div className="flex items-center justify-between px-1 pb-1">
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-medium text-foreground">{filteredLogs.length}</span>
              {filteredLogs.length !== logs.length && (
                <> of <span className="font-medium text-foreground">{logs.length}</span> loaded</>
              )}
              {" "}entries
            </p>
            {filteredLogs.length !== logs.length && (
              <p className="text-[10px] text-muted-foreground/70">Filtered from {logs.length}</p>
            )}
          </div>

          {filteredLogs.map((log) => (
            <LogEntry
              key={log.id}
              log={log}
              userName={userMap[log.user_id] || "Unknown"}
              isExpanded={expandedIds.has(log.id)}
              onToggle={() => toggleExpand(log.id)}
            />
          ))}

          {/* Load More */}
          {filteredLogs.length >= limit && (
            <div className="text-center pt-4">
              <Button variant="outline" size="sm" onClick={loadMore}>
                <Loader2 className="h-4 w-4 mr-2" />
                Load More
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Log Entry Component ─────────────────────────────────────────────────────

function LogEntry({ log, userName, isExpanded, onToggle }) {
  const actions = log.actions_executed || log.actions_planned || [];
  const isError = log.status === "error" || log.status === "failed";

  return (
    <Card className={cn("transition-colors", isError && "border-red-200 dark:border-red-800")}>
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isError ? (
                <XCircle className="h-4 w-4 text-red-500 shrink-0" />
              ) : (
                <Check className="h-4 w-4 text-green-500 shrink-0" />
              )}
              <span className="text-sm font-medium text-muted-foreground">
                {formatTime(log.created_at)}
              </span>
              <span className="text-sm font-semibold">{userName}</span>
              {!isToday(log.created_at) && (
                <Badge variant="secondary" className="text-[10px]">
                  {formatDate(log.created_at)}
                </Badge>
              )}
            </div>

            {/* Prompt */}
            <p className="text-sm mt-1 text-foreground">
              &ldquo;{log.prompt_text || log.input_text || "—"}&rdquo;
            </p>

            {/* Actions inline */}
            {actions.length > 0 && (
              <div className="mt-2 space-y-1">
                {actions.map((a, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    {a.success !== false ? (
                      <Check className="h-3 w-3 text-green-500 shrink-0" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                    )}
                    <span className="font-medium">{a.action_type || a.type || "action"}:</span>
                    <span className="text-muted-foreground truncate">
                      {a.description || a.result || "Done"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Project + duration */}
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              {log.project_title && (
                <span>Project: {log.project_title}</span>
              )}
              {log.duration_ms != null && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {(log.duration_ms / 1000).toFixed(1)}s
                </span>
              )}
              {log.cost_usd != null && log.cost_usd > 0 && (
                <span className="flex items-center gap-1">
                  <DollarSign className="h-3 w-3" />
                  ${log.cost_usd.toFixed(3)}
                </span>
              )}
            </div>
          </div>

          {/* Expand toggle */}
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onToggle} title={isExpanded ? "Collapse details" : "Expand details"} aria-label={isExpanded ? "Collapse details" : "Expand details"}>
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Expanded detail — full JSONB */}
        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="space-y-3">
              {log.actions_planned && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Actions Planned</p>
                  <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto max-h-48">
                    {JSON.stringify(log.actions_planned, null, 2)}
                  </pre>
                </div>
              )}
              {log.actions_executed && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Actions Executed</p>
                  <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto max-h-48">
                    {JSON.stringify(log.actions_executed, null, 2)}
                  </pre>
                </div>
              )}
              {log.results && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Results</p>
                  <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto max-h-48">
                    {JSON.stringify(log.results, null, 2)}
                  </pre>
                </div>
              )}
              {log.error_message && (
                <div>
                  <p className="text-xs font-semibold text-red-500 mb-1">Error</p>
                  <pre className="text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 p-2 rounded-md overflow-x-auto">
                    {log.error_message}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
