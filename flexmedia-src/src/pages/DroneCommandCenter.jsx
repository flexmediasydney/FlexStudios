/**
 * DroneCommandCenter — Drone Phase 7 Stream M
 *
 * Global ops dashboard for drone module. master_admin/admin only.
 * Layout (per IMPLEMENTATION_PLAN_V2.md §6.2):
 *   1. Hero stat cards: Today's shoots · Queue · SfM 30d success · Median residual · Cost today
 *   2. Pipeline kanban — drone_shoots grouped by status (6 columns, latest 6 each)
 *   3. Activity log — UNION of drone_events + project_folder_events (filterable, real-time)
 *   4. Alerts panel — SfM failures (7d), high-roll shots, missing-nadir-grid shoots
 *
 * Real-time:
 *   - api.entities.DroneEvent.subscribe()       → invalidate activity + alerts
 *   - api.entities.DroneShoot.subscribe()       → invalidate pipeline + stats
 *   - api.entities.ProjectFolderEvent.subscribe() → invalidate activity
 *
 * Auth: route guarded by routeAccess (DroneCommandCenter → admin+).
 *       Defensive permission check inside component too.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plane,
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  Gauge,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  ServerCog,
  TrendingUp,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

// ── Pipeline kanban columns ─────────────────────────────────────────────────
// Subset of the drone_shoots.status enum that represents "active" work.
// 'delivered' and 'sfm_failed' are excluded (terminal / shown in Alerts).
const PIPELINE_COLUMNS = [
  { key: "ingested",          label: "Ingested",     statuses: ["ingested", "analysing"] },
  { key: "sfm_complete",      label: "SfM done",      statuses: ["sfm_complete", "sfm_running"] },
  { key: "rendering",         label: "Rendering",     statuses: ["rendering"] },
  { key: "proposed_ready",    label: "Proposed",      statuses: ["proposed_ready"] },
  { key: "adjustments_ready", label: "Adjustments",   statuses: ["adjustments_ready"] },
  { key: "final_ready",       label: "Review/Final",  statuses: ["final_ready"] },
];

const STATUS_TONE = {
  ingested:          "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  analysing:         "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  sfm_running:       "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  sfm_complete:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  sfm_failed:        "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  rendering:         "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  proposed_ready:    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  adjustments_ready: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  final_ready:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  delivered:         "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

// Per-column shoots cap (UI bound — keeps wide rows readable).
const PER_COLUMN_LIMIT = 6;

// Activity log limit (server-side fetch).
const ACTIVITY_LIMIT = 100;

// Alerts thresholds.
const FLIGHT_ROLL_DANGER_DEG = 10;

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}
function num(v, fallback = "—") {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

// ── Hero stat card ─────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, suffix, hint, tone }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div className={cn(
            "h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0",
            tone || "bg-muted",
          )}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
              {label}
            </p>
            <p className="text-lg font-semibold tabular-nums leading-tight mt-0.5">
              {value}
              {suffix && <span className="text-xs font-normal text-muted-foreground ml-1">{suffix}</span>}
            </p>
            {hint && (
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{hint}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Pipeline kanban ─────────────────────────────────────────────────────────
function PipelineKanban({ shoots, projectsById }) {
  const navigate = useNavigate();
  const grouped = useMemo(() => {
    const byCol = new Map(PIPELINE_COLUMNS.map((c) => [c.key, []]));
    for (const shoot of shoots || []) {
      const col = PIPELINE_COLUMNS.find((c) => c.statuses.includes(shoot.status));
      if (col) byCol.get(col.key).push(shoot);
    }
    // Sort each column by created_at desc, cap to PER_COLUMN_LIMIT
    for (const col of PIPELINE_COLUMNS) {
      const arr = byCol.get(col.key);
      arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      byCol.set(col.key, arr.slice(0, PER_COLUMN_LIMIT));
    }
    return byCol;
  }, [shoots]);

  const totalsByCol = useMemo(() => {
    const totals = new Map();
    for (const col of PIPELINE_COLUMNS) {
      const count = (shoots || []).filter((s) => col.statuses.includes(s.status)).length;
      totals.set(col.key, count);
    }
    return totals;
  }, [shoots]);

  const handleShootClick = (shoot) => {
    if (!shoot?.project_id) return;
    navigate(
      createPageUrl("ProjectDetails") +
        `?id=${shoot.project_id}&tab=drones&shoot=${shoot.id}`,
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <div className="grid gap-2 p-3 min-w-[860px]" style={{ gridTemplateColumns: `repeat(${PIPELINE_COLUMNS.length}, minmax(140px, 1fr))` }}>
            {PIPELINE_COLUMNS.map((col) => {
              const items = grouped.get(col.key) || [];
              const total = totalsByCol.get(col.key) || 0;
              return (
                <div key={col.key} className="space-y-1.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {col.label}
                    </span>
                    <span className="text-[10px] font-medium text-muted-foreground tabular-nums">
                      {total}
                    </span>
                  </div>
                  {items.length === 0 ? (
                    <div className="rounded border border-dashed border-border/60 px-2 py-3 text-[11px] text-muted-foreground italic text-center">
                      empty
                    </div>
                  ) : (
                    items.map((shoot) => {
                      const proj = projectsById?.get?.(shoot.project_id);
                      const projName = proj?.title || proj?.property_address || `Project ${String(shoot.project_id).slice(0, 8)}`;
                      return (
                        <button
                          key={shoot.id}
                          onClick={() => handleShootClick(shoot)}
                          className="w-full text-left rounded border bg-background hover:bg-muted/40 transition-colors p-2 space-y-1"
                          title={projName}
                        >
                          <div className="flex items-center gap-1">
                            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATUS_TONE[shoot.status]?.split(" ")[0] || "bg-muted")} />
                            <span className="text-[11px] font-medium truncate flex-1">{projName}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="tabular-nums">{shoot.image_count || 0} imgs</span>
                            {shoot.has_nadir_grid && <Badge variant="outline" className="text-[9px] px-1 py-0">nadir</Badge>}
                            {typeof shoot.sfm_residual_median_m === "number" && (
                              <span className="tabular-nums">{shoot.sfm_residual_median_m.toFixed(2)}m</span>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground">{fmtTime(shoot.flight_started_at || shoot.created_at)}</div>
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Activity log ────────────────────────────────────────────────────────────
const ACTIVITY_KIND_LABEL = {
  drone: "Drone",
  folder: "Files",
};

function ActivityLog({ events, projectsById, isLoading, onRefresh, isFetching }) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [eventTypeFilter, setEventTypeFilter] = useState("all");

  const eventTypeOptions = useMemo(() => {
    const set = new Set();
    for (const e of events || []) if (e.event_type) set.add(e.event_type);
    return Array.from(set).sort();
  }, [events]);

  const filtered = useMemo(() => {
    if (!Array.isArray(events)) return [];
    return events.filter((e) => {
      if (kindFilter !== "all" && e._kind !== kindFilter) return false;
      if (eventTypeFilter !== "all" && e.event_type !== eventTypeFilter) return false;
      if (search.trim()) {
        const s = search.trim().toLowerCase();
        const proj = projectsById?.get?.(e.project_id);
        const haystack = [
          e.event_type,
          e.actor_type,
          e.file_name,
          e.folder_kind,
          proj?.title,
          proj?.property_address,
          typeof e.payload === "object" ? JSON.stringify(e.payload) : null,
          typeof e.metadata === "object" ? JSON.stringify(e.metadata) : null,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(s)) return false;
      }
      return true;
    });
  }, [events, kindFilter, eventTypeFilter, search, projectsById]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Activity log
            {isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={isFetching} className="h-7 px-2 text-xs">
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search project, event, actor…"
              className="pl-7 h-9 text-xs"
            />
          </div>
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="h-9 w-[140px] text-xs"><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="drone">Drone events</SelectItem>
              <SelectItem value="folder">Folder events</SelectItem>
            </SelectContent>
          </Select>
          <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
            <SelectTrigger className="h-9 w-[180px] text-xs"><SelectValue placeholder="Event type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {eventTypeOptions.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => <div key={i} className="h-12 rounded bg-muted/40 animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            No events match the current filters.
          </div>
        ) : (
          <ul className="divide-y rounded border">
            {filtered.map((e) => {
              const proj = projectsById?.get?.(e.project_id);
              const projName = proj?.title || proj?.property_address || (e.project_id ? `Project ${String(e.project_id).slice(0, 8)}` : "—");
              const ts = e.created_at ? new Date(e.created_at) : null;
              return (
                <li key={`${e._kind}-${e.id}`} className="px-3 py-2 hover:bg-muted/40 text-xs flex items-start gap-3">
                  <div className="h-5 w-5 rounded flex items-center justify-center flex-shrink-0 bg-muted mt-0.5">
                    {e._kind === "drone" ? <Plane className="h-3 w-3" /> : <ServerCog className="h-3 w-3" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">{e.event_type || "event"}</Badge>
                      <span className="text-muted-foreground">in</span>
                      {e.project_id ? (
                        <Link
                          to={createPageUrl("ProjectDetails") + `?id=${e.project_id}`}
                          className="font-medium text-foreground hover:text-primary truncate max-w-[280px]"
                          title={projName}
                        >
                          {projName}
                        </Link>
                      ) : (
                        <span className="font-medium text-foreground">—</span>
                      )}
                      {e.file_name && (
                        <span className="font-mono truncate max-w-[200px]" title={e.file_name}>{e.file_name}</span>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                      <span title={ts ? format(ts, "PPpp") : ""}>{fmtTime(e.created_at)}</span>
                      <span>·</span>
                      <span>{ACTIVITY_KIND_LABEL[e._kind]}</span>
                      <span>·</span>
                      <span>{e.actor_type || "system"}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Alerts panel ────────────────────────────────────────────────────────────
function AlertsPanel({ sfmFailures, highRollShoots, missingNadirShoots, projectsById }) {
  const navigate = useNavigate();
  const allAlerts = useMemo(() => {
    const out = [];
    for (const r of sfmFailures || []) {
      out.push({
        key: `sfm-${r.id}`,
        kind: "sfm_failed",
        severity: "error",
        label: "SfM failed",
        sub: r.shoot_id ? `shoot ${String(r.shoot_id).slice(0, 8)}` : "",
        ts: r.finished_at || r.started_at || r.created_at,
        project_id: r._project_id,
      });
    }
    for (const s of highRollShoots || []) {
      out.push({
        key: `roll-${s.id}`,
        kind: "high_roll",
        severity: "warning",
        label: `FlightRoll ${(s._max_roll || 0).toFixed(1)}° flagged`,
        sub: s.title || s.property_address || `shoot ${String(s.id).slice(0, 8)}`,
        ts: s.created_at,
        project_id: s.project_id,
      });
    }
    for (const s of missingNadirShoots || []) {
      const proj = projectsById?.get?.(s.project_id);
      out.push({
        key: `nadir-${s.id}`,
        kind: "no_nadir",
        severity: "warning",
        label: "Missing nadir grid",
        sub: proj?.title || proj?.property_address || `shoot ${String(s.id).slice(0, 8)}`,
        ts: s.created_at,
        project_id: s.project_id,
      });
    }
    out.sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());
    return out;
  }, [sfmFailures, highRollShoots, missingNadirShoots, projectsById]);

  const visible = allAlerts.slice(0, 5);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Alerts <span className="text-muted-foreground font-normal">({allAlerts.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {allAlerts.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            All clear.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {visible.map((a) => (
              <li key={a.key}>
                <button
                  onClick={() => a.project_id && navigate(createPageUrl("ProjectDetails") + `?id=${a.project_id}&tab=drones`)}
                  className="w-full text-left rounded border px-2 py-1.5 hover:bg-muted/40 flex items-start gap-2 text-xs"
                >
                  {a.severity === "error" ? (
                    <AlertCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{a.label}</p>
                    <p className="text-muted-foreground truncate">
                      {a.sub} · {fmtTime(a.ts)}
                    </p>
                  </div>
                </button>
              </li>
            ))}
            {allAlerts.length > visible.length && (
              <li className="text-[11px] text-muted-foreground text-center pt-1">
                +{allAlerts.length - visible.length} more
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function DroneCommandCenter() {
  const queryClient = useQueryClient();
  const { isAdminOrAbove } = usePermissions();

  // ─── Stats RPC ──────────────────────────────────────────────────────────
  // NB: hooks always run; permission gate is rendered below as a return.
  const statsQuery = useQuery({
    queryKey: ["drone_dashboard_stats"],
    queryFn: async () => {
      const rows = await api.rpc("get_drone_dashboard_stats", {});
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    staleTime: 30 * 1000,
    enabled: isAdminOrAbove,
  });

  // ─── Active shoots for kanban (last 30 days, all non-terminal statuses) ─
  const shootsQuery = useQuery({
    queryKey: ["drone_command_center_shoots"],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      // Filter via api.entities — generic shim, but we want statuses != delivered.
      // Simplest: fetch recent shoots, filter client-side.
      return await api.entities.DroneShoot.filter(
        { created_at: { $gte: since } },
        "-created_at",
        500,
      );
    },
    staleTime: 30 * 1000,
    enabled: isAdminOrAbove,
  });

  // ─── Project lookup map for the shoots/events we display ────────────────
  const projectIds = useMemo(() => {
    const set = new Set();
    for (const s of shootsQuery.data || []) if (s.project_id) set.add(s.project_id);
    return Array.from(set);
  }, [shootsQuery.data]);

  const projectsQuery = useQuery({
    queryKey: ["drone_command_center_projects", projectIds.length, projectIds.slice(0, 3).join(",")],
    queryFn: async () => {
      if (projectIds.length === 0) return [];
      return await api.entities.Project.filter(
        { id: { $in: projectIds } },
        null,
        500,
      );
    },
    enabled: isAdminOrAbove && projectIds.length > 0,
    staleTime: 60 * 1000,
  });

  const projectsById = useMemo(() => {
    const m = new Map();
    for (const p of projectsQuery.data || []) m.set(p.id, p);
    return m;
  }, [projectsQuery.data]);

  // ─── Activity log (drone_events ∪ project_folder_events) ────────────────
  const droneEventsQuery = useQuery({
    queryKey: ["drone_events_recent"],
    queryFn: () =>
      api.entities.DroneEvent.filter({}, "-created_at", ACTIVITY_LIMIT),
    staleTime: 5_000,
    enabled: isAdminOrAbove,
  });
  const folderEventsQuery = useQuery({
    queryKey: ["project_folder_events_recent_global"],
    queryFn: () =>
      api.entities.ProjectFolderEvent.filter({}, "-created_at", ACTIVITY_LIMIT),
    staleTime: 5_000,
    enabled: isAdminOrAbove,
  });

  const activityEvents = useMemo(() => {
    const drone = (droneEventsQuery.data || []).map((e) => ({ ...e, _kind: "drone" }));
    const folder = (folderEventsQuery.data || []).map((e) => ({ ...e, _kind: "folder" }));
    return [...drone, ...folder].sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
    ).slice(0, ACTIVITY_LIMIT);
  }, [droneEventsQuery.data, folderEventsQuery.data]);

  // ─── Alerts ─────────────────────────────────────────────────────────────
  const sfmFailuresQuery = useQuery({
    queryKey: ["drone_sfm_failures_7d"],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const rows = await api.entities.DroneSfmRun.filter(
        { status: "failed", started_at: { $gte: since } },
        "-started_at",
        50,
      );
      // Look up project_id via shoot
      const shootIds = Array.from(new Set(rows.map((r) => r.shoot_id).filter(Boolean)));
      if (shootIds.length === 0) return rows;
      const shoots = await api.entities.DroneShoot.filter(
        { id: { $in: shootIds } }, null, 200,
      );
      const projByShoot = new Map(shoots.map((s) => [s.id, s.project_id]));
      return rows.map((r) => ({ ...r, _project_id: projByShoot.get(r.shoot_id) || null }));
    },
    staleTime: 60 * 1000,
    enabled: isAdminOrAbove,
  });

  const highRollShotsQuery = useQuery({
    queryKey: ["drone_high_roll_shots"],
    queryFn: async () => {
      // Shots with flight_roll above the danger threshold, in shoots that
      // haven't successfully run SfM yet (pre-SfM warning to operator).
      const rows = await api.entities.DroneShot.filter(
        { flight_roll: { $gte: FLIGHT_ROLL_DANGER_DEG } },
        "-created_at",
        100,
      );
      // Reduce to shoot level: max roll per shoot
      const byShoot = new Map();
      for (const r of rows || []) {
        const cur = byShoot.get(r.shoot_id) || { count: 0, maxRoll: 0 };
        cur.count += 1;
        cur.maxRoll = Math.max(cur.maxRoll, Math.abs(Number(r.flight_roll) || 0));
        byShoot.set(r.shoot_id, cur);
      }
      const shootIds = Array.from(byShoot.keys());
      if (shootIds.length === 0) return [];
      const shoots = await api.entities.DroneShoot.filter(
        { id: { $in: shootIds } }, "-created_at", 200,
      );
      return shoots
        .filter((s) => !["sfm_complete", "sfm_running", "rendering", "proposed_ready", "adjustments_ready", "final_ready", "delivered"].includes(s.status))
        .map((s) => ({ ...s, _max_roll: byShoot.get(s.id)?.maxRoll || 0 }));
    },
    staleTime: 60 * 1000,
    enabled: isAdminOrAbove,
  });

  const missingNadirQuery = useQuery({
    queryKey: ["drone_missing_nadir"],
    queryFn: () =>
      api.entities.DroneShoot.filter(
        { has_nadir_grid: false },
        "-created_at",
        50,
      ),
    staleTime: 60 * 1000,
    enabled: isAdminOrAbove,
  });

  // ─── Realtime invalidations ─────────────────────────────────────────────
  useEffect(() => {
    if (!isAdminOrAbove) return;
    const unsubs = [];
    try {
      unsubs.push(
        api.entities.DroneEvent.subscribe(() => {
          queryClient.invalidateQueries({ queryKey: ["drone_events_recent"] });
          queryClient.invalidateQueries({ queryKey: ["drone_dashboard_stats"] });
        }),
      );
    } catch (e) { console.warn("[DroneCommandCenter] DroneEvent subscribe failed:", e); }
    try {
      unsubs.push(
        api.entities.DroneShoot.subscribe(() => {
          queryClient.invalidateQueries({ queryKey: ["drone_command_center_shoots"] });
          queryClient.invalidateQueries({ queryKey: ["drone_dashboard_stats"] });
          queryClient.invalidateQueries({ queryKey: ["drone_missing_nadir"] });
        }),
      );
    } catch (e) { console.warn("[DroneCommandCenter] DroneShoot subscribe failed:", e); }
    try {
      unsubs.push(
        api.entities.ProjectFolderEvent.subscribe(() => {
          queryClient.invalidateQueries({ queryKey: ["project_folder_events_recent_global"] });
        }),
      );
    } catch (e) { console.warn("[DroneCommandCenter] ProjectFolderEvent subscribe failed:", e); }
    try {
      unsubs.push(
        api.entities.DroneSfmRun.subscribe(() => {
          queryClient.invalidateQueries({ queryKey: ["drone_sfm_failures_7d"] });
          queryClient.invalidateQueries({ queryKey: ["drone_dashboard_stats"] });
        }),
      );
    } catch (e) { console.warn("[DroneCommandCenter] DroneSfmRun subscribe failed:", e); }

    return () => {
      for (const u of unsubs) {
        try { if (typeof u === "function") u(); } catch { /* ignore */ }
      }
    };
  }, [queryClient, isAdminOrAbove]);

  const stats = statsQuery.data || {};
  const isLoadingStats = statsQuery.isLoading;
  const activityIsLoading = droneEventsQuery.isLoading || folderEventsQuery.isLoading;
  const activityIsFetching = droneEventsQuery.isFetching || folderEventsQuery.isFetching;

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["drone_dashboard_stats"] });
    queryClient.invalidateQueries({ queryKey: ["drone_command_center_shoots"] });
    queryClient.invalidateQueries({ queryKey: ["drone_events_recent"] });
    queryClient.invalidateQueries({ queryKey: ["project_folder_events_recent_global"] });
    queryClient.invalidateQueries({ queryKey: ["drone_sfm_failures_7d"] });
    queryClient.invalidateQueries({ queryKey: ["drone_high_roll_shots"] });
    queryClient.invalidateQueries({ queryKey: ["drone_missing_nadir"] });
  };

  // Defensive permission check (route guard handles this too).
  // Placed AFTER all hooks above to satisfy React's rules-of-hooks.
  if (!isAdminOrAbove) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl p-8 max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">Access denied</h2>
          <p className="text-sm text-red-700 dark:text-red-300">
            The Drone Command Center is restricted to admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <Plane className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-none">Drone Command Center</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live ops view of drone shoots, SfM runs, render queue, and audit feed
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll} className="text-xs">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* Hero stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <StatCard
          icon={Plane}
          tone="bg-blue-500/15 text-blue-600 dark:text-blue-400"
          label="Today's shoots"
          value={isLoadingStats ? "…" : num(stats.shoots_today, 0)}
        />
        <StatCard
          icon={ListChecks}
          tone="bg-amber-500/15 text-amber-600 dark:text-amber-400"
          label="Queue"
          value={isLoadingStats ? "…" : num(stats.jobs_pending, 0)}
          hint={!isLoadingStats && stats.jobs_running != null ? `${num(stats.jobs_running, 0)} running` : null}
        />
        <StatCard
          icon={TrendingUp}
          tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          label="SfM 30d"
          value={isLoadingStats || stats.sfm_success_rate_30d == null ? "—" : num(stats.sfm_success_rate_30d, 0)}
          suffix={stats.sfm_success_rate_30d != null ? "%" : null}
          hint={!isLoadingStats && stats.sfm_runs_30d ? `${num(stats.sfm_runs_30d, 0)} runs` : null}
        />
        <StatCard
          icon={Gauge}
          tone="bg-purple-500/15 text-purple-600 dark:text-purple-400"
          label="Median residual"
          value={isLoadingStats || stats.sfm_residual_median_30d == null ? "—" : num(stats.sfm_residual_median_30d, 0)}
          suffix={stats.sfm_residual_median_30d != null ? "m" : null}
        />
        <StatCard
          icon={DollarSign}
          tone="bg-slate-500/15 text-slate-600 dark:text-slate-400"
          label="Cost today"
          value={isLoadingStats ? "…" : `$${num(stats.estimated_cost_today_usd, 0)}`}
          hint="estimated"
        />
      </div>

      {statsQuery.error && (
        <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <div>
            <p className="font-medium">Failed to load stats</p>
            <p>{statsQuery.error.message || "Unknown error"}</p>
          </div>
        </div>
      )}

      {/* Pipeline kanban */}
      {shootsQuery.isLoading ? (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-2 animate-pulse">
              <div className="h-4 bg-muted rounded w-1/4" />
              <div className="grid grid-cols-6 gap-2">
                {[...Array(6)].map((_, i) => <div key={i} className="h-32 bg-muted/60 rounded" />)}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : shootsQuery.error ? (
        <Card>
          <CardContent className="p-4 text-xs text-red-600">
            Failed to load shoots: {shootsQuery.error.message}
          </CardContent>
        </Card>
      ) : (
        <PipelineKanban shoots={shootsQuery.data || []} projectsById={projectsById} />
      )}

      {/* Activity + Alerts side by side on wide */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <ActivityLog
          events={activityEvents}
          projectsById={projectsById}
          isLoading={activityIsLoading}
          isFetching={activityIsFetching}
          onRefresh={() => {
            queryClient.invalidateQueries({ queryKey: ["drone_events_recent"] });
            queryClient.invalidateQueries({ queryKey: ["project_folder_events_recent_global"] });
          }}
        />
        <AlertsPanel
          sfmFailures={sfmFailuresQuery.data || []}
          highRollShoots={highRollShotsQuery.data || []}
          missingNadirShoots={missingNadirQuery.data || []}
          projectsById={projectsById}
        />
      </div>
    </div>
  );
}
