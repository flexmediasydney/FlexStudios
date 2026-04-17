/**
 * AIAuditLog.jsx — Admin-only AI action audit log / live feed.
 *
 * Shows real-time AI actions with filtering by user, project, and date.
 * Each entry is expandable to reveal the full JSONB action payload.
 *
 * NOTE: Filters are applied server-side via Supabase queries. The previous
 * implementation only filtered loaded data, so date filters silently missed
 * entries beyond the loaded window. Now matches EdgeFunctionAuditLog pattern.
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
  Check, XCircle, Clock, DollarSign, Sparkles, Search, Download,
  ChevronLeft,
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

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

function downloadCsv(rows) {
  const header = [
    "created_at", "user_name", "project_name", "status", "duration_ms",
    "estimated_cost", "model_used", "intent_detected", "prompt_text", "error_message",
  ];
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const log of rows) {
    lines.push([
      log.created_at || "",
      log.user_name || "",
      log.project_name || log.project_title || "",
      log.status || (log.error_message ? "error" : "success"),
      log.duration_ms || "",
      log.estimated_cost ?? log.cost_usd ?? "",
      log.model_used || "",
      log.intent_detected || "",
      (log.prompt_text || log.input_text || "").slice(0, 500),
      (log.error_message || "").slice(0, 500),
    ].map(escape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ai_audit_log_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AIAuditLog() {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();

  // Pagination
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0); // 0-indexed

  // Filters (all server-side now)
  const [filterUser, setFilterUser] = useState("all");
  const [filterProject, setFilterProject] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Expanded entries
  const [expandedIds, setExpandedIds] = useState(new Set());

  // Reset page on filter change
  useEffect(() => {
    setPage(0);
  }, [filterUser, filterProject, filterDateFrom, filterDateTo, pageSize]);

  // ── Data fetching (server-side filtered + paginated) ────────────────
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["aiActionLogs", { filterUser, filterProject, filterDateFrom, filterDateTo, page, pageSize }],
    queryFn: async () => {
      let q = api._supabase
        .from("ai_action_logs")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (filterUser && filterUser !== "all") q = q.eq("user_id", filterUser);
      if (filterProject.trim()) {
        const term = filterProject.trim();
        q = q.or(`project_name.ilike.%${term}%,project_id.ilike.%${term}%`);
      }
      if (filterDateFrom) q = q.gte("created_at", new Date(filterDateFrom).toISOString());
      if (filterDateTo) {
        const to = new Date(filterDateTo);
        to.setHours(23, 59, 59, 999);
        q = q.lte("created_at", to.toISOString());
      }

      const from = page * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: data || [], count: count || 0 };
    },
    keepPreviousData: true,
    refetchInterval: 60_000,
  });

  const filteredLogs = data?.rows || [];
  const total = data?.count || 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min(total, (page + 1) * pageSize);
  const hasPrev = page > 0;
  const hasNext = (page + 1) < pageCount;

  // ── Summary stats (today, query-independent) ──────────────────────────
  const { data: todayStats } = useQuery({
    queryKey: ["aiActionLogs-today-stats"],
    queryFn: async () => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const { data, error } = await api._supabase
        .from("ai_action_logs")
        .select("error_message, estimated_cost")
        .gte("created_at", startOfToday.toISOString());
      if (error) throw error;
      const total = (data || []).length;
      const success = (data || []).filter(l => !l.error_message).length;
      const rate = total > 0 ? Math.round((success / total) * 100) : 0;
      const cost = (data || []).reduce((s, l) => s + (Number(l.estimated_cost) || 0), 0);
      return { total, rate, cost };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const stats = todayStats || { total: 0, rate: 0, cost: 0 };

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
      queryClient.invalidateQueries({ queryKey: ["aiActionLogs-today-stats"] });
    });
    return unsubscribe;
  }, [queryClient]);

  // ── Toggle expand ─────────────────────────────────────────────────────

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filterCount =
    (filterUser !== "all" ? 1 : 0) +
    (filterProject.trim() ? 1 : 0) +
    (filterDateFrom ? 1 : 0) +
    (filterDateTo ? 1 : 0);

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
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(parseInt(v, 10))}>
              <SelectTrigger className="w-32 h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map(n => (
                  <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs gap-1"
              onClick={() => downloadCsv(filteredLogs)}
              disabled={filteredLogs.length === 0}
              title="Download visible rows as CSV"
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
            {filterCount > 0 && (
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
                Clear ({filterCount})
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Log Feed */}
      {isLoading && filteredLogs.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : filteredLogs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Activity className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">
              {filterCount > 0 ? "No AI actions match the current filters." : "No AI actions found."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Pagination info */}
          <div className="flex items-center justify-between px-1 pb-1">
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-medium text-foreground tabular-nums">{showingFrom.toLocaleString()}</span>
              –<span className="font-medium text-foreground tabular-nums">{showingTo.toLocaleString()}</span>{" "}
              of <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span> entries
            </p>
            <p className="text-[10px] text-muted-foreground/70">
              Page {page + 1} of {pageCount}
            </p>
          </div>

          {filteredLogs.map((log) => (
            <LogEntry
              key={log.id}
              log={log}
              userName={userMap[log.user_id] || log.user_name || "Unknown"}
              isExpanded={expandedIds.has(log.id)}
              onToggle={() => toggleExpand(log.id)}
            />
          ))}

          {/* Pagination controls */}
          {total > pageSize && (
            <div className="flex items-center justify-between pt-3">
              <p className="text-xs text-muted-foreground">
                Page {page + 1} of {pageCount}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={!hasPrev || isFetching}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={!hasNext || isFetching}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
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
  // Schema uses error_message presence as the source-of-truth for failure
  // (no `status` column on ai_action_logs). Old schema had a `status` field —
  // keep both checks for backward compatibility.
  const isError = !!log.error_message || log.status === "error" || log.status === "failed";
  const projectName = log.project_name || log.project_title;
  const cost = log.estimated_cost ?? log.cost_usd;

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
              {projectName && (
                <span>Project: {projectName}</span>
              )}
              {log.duration_ms != null && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {(log.duration_ms / 1000).toFixed(1)}s
                </span>
              )}
              {cost != null && Number(cost) > 0 && (
                <span className="flex items-center gap-1">
                  <DollarSign className="h-3 w-3" />
                  ${Number(cost).toFixed(3)}
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
              {(log.actions_results || log.results) && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Results</p>
                  <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto max-h-48">
                    {JSON.stringify(log.actions_results || log.results, null, 2)}
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
