/**
 * PulseDataSources — Industry Pulse "Sources" tab.
 * Manages REA scraper runs, cron schedule display, sync history,
 * suburb pool, and raw payload drill-through.
 */
import React, { useState, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Database, Users, Home, DollarSign, Clock, CheckCircle2,
  AlertTriangle, Loader2, Plus, Trash2, Settings2,
  ChevronDown, ChevronUp, Eye, MapPin, ToggleLeft, ToggleRight,
} from "lucide-react";

// ── Source definitions ────────────────────────────────────────────────────────

const SOURCES = [
  {
    source_id: "rea_agents",
    label: "REA Agent Profiles",
    description: "websift — Agent profiles, stats, reviews, awards from realestate.com.au",
    icon: Users,
    color: "text-red-600",
    defaultMax: 30,
    runParams: (subs, max) => ({
      suburbs: subs,
      state: "NSW",
      maxAgentsPerSuburb: max,
      maxListingsPerSuburb: 0,
      skipListings: true,
    }),
  },
  {
    source_id: "rea_listings",
    label: "REA Listings (per suburb)",
    description: "azzouzana — Listings with agent emails, photos, IDs from realestate.com.au",
    icon: Home,
    color: "text-blue-600",
    defaultMax: 20,
    runParams: (subs, max) => ({
      suburbs: subs,
      state: "NSW",
      maxAgentsPerSuburb: 0,
      maxListingsPerSuburb: max,
      skipListings: false,
    }),
  },
  {
    source_id: "rea_listings_bb_buy",
    label: "REA Sales (Greater Sydney)",
    description: "azzouzana — Bounding box buy listings, sorted by newest",
    icon: DollarSign,
    color: "text-green-600",
    defaultMax: 500,
    isBoundingBox: true,
    runParams: (_, max) => ({
      suburbs: [],
      state: "NSW",
      listingsStartUrl:
        "https://www.realestate.com.au/buy/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date",
      maxListingsTotal: max,
    }),
  },
  {
    source_id: "rea_listings_bb_rent",
    label: "REA Rentals (Greater Sydney)",
    description: "azzouzana — Bounding box rental listings",
    icon: Home,
    color: "text-teal-600",
    defaultMax: 500,
    isBoundingBox: true,
    runParams: (_, max) => ({
      suburbs: [],
      state: "NSW",
      listingsStartUrl:
        "https://www.realestate.com.au/rent/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date",
      maxListingsTotal: max,
    }),
  },
  {
    source_id: "rea_listings_bb_sold",
    label: "REA Sold (Greater Sydney)",
    description: "azzouzana — Bounding box recently sold",
    icon: DollarSign,
    color: "text-orange-600",
    defaultMax: 500,
    isBoundingBox: true,
    runParams: (_, max) => ({
      suburbs: [],
      state: "NSW",
      listingsStartUrl:
        "https://www.realestate.com.au/sold/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534",
      maxListingsTotal: max,
    }),
  },
];

// ── Cron schedule ─────────────────────────────────────────────────────────────

const CRON_SCHEDULE = [
  { label: "REA Agents",      schedule: "Weekly (Sunday)",  source_id: "rea_agents" },
  { label: "REA Sales BB",    schedule: "Daily 6am",        source_id: "rea_listings_bb_buy" },
  { label: "REA Rentals BB",  schedule: "Daily 7am",        source_id: "rea_listings_bb_rent" },
  { label: "REA Sold BB",     schedule: "Daily 8am",        source_id: "rea_listings_bb_sold" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtDuration(start, end) {
  if (!start || !end) return "—";
  const ms = new Date(end) - new Date(start);
  if (isNaN(ms) || ms < 0) return "—";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function nextCronLabel(schedule) {
  const now = new Date();
  if (schedule === "Weekly (Sunday)") {
    const daysUntilSun = (7 - now.getDay()) % 7 || 7;
    const next = new Date(now.getTime() + daysUntilSun * 86400000);
    next.setHours(0, 0, 0, 0);
    return next.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  }
  const match = schedule.match(/Daily (\d+)(am|pm)?/i);
  if (match) {
    let hr = parseInt(match[1], 10);
    if (match[2] === "pm" && hr !== 12) hr += 12;
    const next = new Date(now);
    next.setHours(hr, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  return "—";
}

function recordsSummary(log) {
  if (!log?.result_summary) return "—";
  const s = log.result_summary;
  const parts = [];
  if (s.agents_processed != null)   parts.push(`${s.agents_processed} agents`);
  if (s.listings_stored != null) parts.push(`${s.listings_stored} listings`);
  if (s.records_saved != null && !parts.length) parts.push(`${s.records_saved} records`);
  return parts.join(", ") || "—";
}

function StatusBadge({ status }) {
  if (status === "completed")
    return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] px-1.5 py-0">Completed</Badge>;
  if (status === "running")
    return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-[10px] px-1.5 py-0 animate-pulse">Running</Badge>;
  if (status === "failed")
    return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] px-1.5 py-0">Failed</Badge>;
  return <Badge variant="outline" className="text-[10px] px-1.5 py-0">{status || "—"}</Badge>;
}

// ── Sub-components ────────────────────────────────────────────────────────────

// --- Source Card ---

function SourceCard({ source, lastLog, isRunning, onRun }) {
  const Icon = source.icon;
  const lastStatus = lastLog?.status;

  return (
    <Card className="rounded-xl border shadow-sm hover:shadow-md transition-shadow">
      <CardContent className="p-4 flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1.5 rounded-lg bg-muted/60 shrink-0">
              <Icon className={cn("h-4 w-4", source.color)} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight truncate">{source.label}</p>
              <p className="text-[10px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                {source.description}
              </p>
            </div>
          </div>
          {/* Last run status icon */}
          {lastStatus === "completed" && (
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
          )}
          {lastStatus === "failed" && (
            <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {lastLog ? fmtTs(lastLog.started_at) : "Never run"}
          </span>
          {lastLog && (
            <span className="font-medium text-foreground/70">{recordsSummary(lastLog)}</span>
          )}
        </div>

        {/* Run button */}
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-xs"
          onClick={() => onRun(source)}
          disabled={isRunning}
        >
          {isRunning ? (
            <>
              <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              Running…
            </>
          ) : (
            "Run Now"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// --- Cron Schedule Table ---

function CronScheduleTable({ runningSources }) {
  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          Scheduled Runs
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="text-left pb-2 font-medium text-muted-foreground">Source</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Schedule</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Next Run</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {CRON_SCHEDULE.map((row) => (
              <tr key={row.source_id} className="border-b last:border-0">
                <td className="py-2 pr-3 font-medium">{row.label}</td>
                <td className="py-2 pr-3 text-muted-foreground">{row.schedule}</td>
                <td className="py-2 pr-3 text-muted-foreground">{nextCronLabel(row.schedule)}</td>
                <td className="py-2">
                  {runningSources.has(row.source_id) ? (
                    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-[10px] px-1.5 py-0 animate-pulse">
                      Running
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">Scheduled</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// --- Sync History Table ---

function SyncHistory({ syncLogs, onDrill }) {
  const recent = useMemo(() => syncLogs.slice(0, 20), [syncLogs]);

  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          Sync History
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{recent.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 overflow-x-auto">
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No sync logs yet.</p>
        ) : (
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="border-b">
                <th className="text-left pb-2 font-medium text-muted-foreground">Source</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Status</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Started</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Duration</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Records</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {recent.map((log) => (
                <tr key={log.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="py-2 pr-3 font-medium max-w-[180px] truncate">{log.source_label || log.source_id || "—"}</td>
                  <td className="py-2 pr-3"><StatusBadge status={log.status} /></td>
                  <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{fmtTs(log.started_at)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{fmtDuration(log.started_at, log.completed_at)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{recordsSummary(log)}</td>
                  <td className="py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => onDrill(log)}
                      title="View raw payload"
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// --- Suburb Pool ---

function SuburbPool({ targetSuburbs }) {
  const [newSuburb, setNewSuburb] = useState("");

  const handleAdd = useCallback(async () => {
    const name = newSuburb.trim();
    if (!name) return;
    try {
      await api.entities.PulseTargetSuburb.create({ name, is_active: true, region: "Greater Sydney", priority: 5 });
      await refetchEntityList("PulseTargetSuburb");
      setNewSuburb("");
      toast.success(`Added suburb: ${name}`);
    } catch (err) {
      toast.error(`Failed to add suburb: ${err.message}`);
    }
  }, [newSuburb]);

  const handleToggle = useCallback(async (suburb) => {
    try {
      await api.entities.PulseTargetSuburb.update(suburb.id, { is_active: !suburb.is_active });
      await refetchEntityList("PulseTargetSuburb");
    } catch (err) {
      toast.error(`Failed to update: ${err.message}`);
    }
  }, []);

  const handleDelete = useCallback(async (suburb) => {
    try {
      await api.entities.PulseTargetSuburb.delete(suburb.id);
      await refetchEntityList("PulseTargetSuburb");
      toast.success(`Removed ${suburb.name}`);
    } catch (err) {
      toast.error(`Failed to remove: ${err.message}`);
    }
  }, []);

  const sorted = useMemo(
    () => [...targetSuburbs].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    [targetSuburbs]
  );

  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          Suburb Pool
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {targetSuburbs.filter((s) => s.is_active).length} active
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {/* Add row */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Add suburb…"
            value={newSuburb}
            onChange={(e) => setNewSuburb(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            className="h-7 text-xs flex-1"
          />
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={handleAdd}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {/* Suburb list */}
        {sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">No suburbs configured.</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {sorted.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors",
                  s.is_active ? "bg-muted/40" : "bg-muted/10 opacity-60"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{s.name}</span>
                  {s.region && (
                    <span className="text-[10px] text-muted-foreground shrink-0">{s.region}</span>
                  )}
                  {s.priority != null && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                      P{s.priority}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => handleToggle(s)}
                    title={s.is_active ? "Deactivate" : "Activate"}
                  >
                    {s.is_active ? (
                      <ToggleRight className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <ToggleLeft className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    className="text-muted-foreground hover:text-red-500 transition-colors"
                    onClick={() => handleDelete(s)}
                    title="Remove suburb"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Drill-through Dialog ---

const DRILL_PAGE_SIZE = 50;

function DrillPayloadRow({ item, index }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    if (!item) return "—";
    const name = item.name || item.agent_name || item.address || item.listing_id || `Item ${index + 1}`;
    const sub = item.suburb || item.agency_name || item.agent_id || "";
    return sub ? `${name} — ${sub}` : name;
  }, [item, index]);

  return (
    <div className="border-b last:border-0">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-medium truncate pr-2">{preview}</span>
        {expanded ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
      </button>
      {expanded && (
        <pre className="bg-muted/30 text-[10px] px-3 py-2 overflow-x-auto rounded-b-md whitespace-pre-wrap break-all">
          {JSON.stringify(item, null, 2)}
        </pre>
      )}
    </div>
  );
}

function DrillDialog({ log, onClose }) {
  const [agentsPage, setAgentsPage] = useState(0);
  const [listingsPage, setListingsPage] = useState(0);

  const payload = log?.raw_payload ?? {};
  const agents   = useMemo(() => Array.isArray(payload?.rea_agents) ? payload.rea_agents : Array.isArray(payload?.agents) ? payload.agents : [], [payload]);
  const listings = useMemo(() => Array.isArray(payload?.listings) ? payload.listings : [], [payload]);
  const hasAgents   = agents.length > 0;
  const hasListings = listings.length > 0;

  const defaultTab = hasAgents ? "agents" : hasListings ? "listings" : "raw";

  return (
    <Dialog open={!!log} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Raw Payload — {log?.source_label || log?.source_id || "Sync Log"}
            <span className="text-muted-foreground font-normal ml-2 text-xs">{fmtTs(log?.started_at)}</span>
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={defaultTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="shrink-0 h-8 text-xs">
            {hasAgents   && <TabsTrigger value="agents"   className="text-xs h-7">{`Agents (${agents.length})`}</TabsTrigger>}
            {hasListings && <TabsTrigger value="listings" className="text-xs h-7">{`Listings (${listings.length})`}</TabsTrigger>}
            <TabsTrigger value="raw" className="text-xs h-7">Raw JSON</TabsTrigger>
          </TabsList>

          {hasAgents && (
            <TabsContent value="agents" className="flex-1 overflow-y-auto mt-2">
              <DrillPaginatedList items={agents} page={agentsPage} setPage={setAgentsPage} />
            </TabsContent>
          )}
          {hasListings && (
            <TabsContent value="listings" className="flex-1 overflow-y-auto mt-2">
              <DrillPaginatedList items={listings} page={listingsPage} setPage={setListingsPage} />
            </TabsContent>
          )}
          <TabsContent value="raw" className="flex-1 overflow-y-auto mt-2">
            <pre className="text-[10px] bg-muted/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function DrillPaginatedList({ items, page, setPage }) {
  const totalPages = Math.ceil(items.length / DRILL_PAGE_SIZE);
  const slice = items.slice(page * DRILL_PAGE_SIZE, (page + 1) * DRILL_PAGE_SIZE);

  return (
    <div className="space-y-0 border rounded-lg overflow-hidden">
      {/* Pagination header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b text-[10px] text-muted-foreground">
        <span>{items.length} items</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost" size="sm" className="h-5 w-5 p-0"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >‹</Button>
          <span>Page {page + 1} / {totalPages || 1}</span>
          <Button
            variant="ghost" size="sm" className="h-5 w-5 p-0"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >›</Button>
        </div>
      </div>
      {/* Rows */}
      {slice.map((item, i) => (
        <DrillPayloadRow key={page * DRILL_PAGE_SIZE + i} item={item} index={page * DRILL_PAGE_SIZE + i} />
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PulseDataSources({ syncLogs = [], sourceConfigs = [], targetSuburbs = [], pulseTimeline = [], stats = {}, user }) {
  const [runningSources, setRunningSources] = useState(new Set());
  const [drillLog, setDrillLog] = useState(null);

  // Last log per source
  const lastLogBySource = useMemo(() => {
    const map = {};
    for (const log of syncLogs) {
      const sid = log.source_id;
      if (!sid) continue;
      if (!map[sid] || new Date(log.started_at) > new Date(map[sid].started_at)) {
        map[sid] = log;
      }
    }
    return map;
  }, [syncLogs]);

  const runSource = useCallback(async (source) => {
    setRunningSources((prev) => new Set([...prev, source.source_id]));
    try {
      const subs = targetSuburbs.filter((s) => s.is_active).map((s) => s.name);
      const params = {
        ...source.runParams(subs, source.defaultMax),
        source_id: source.source_id,
        source_label: source.label,
        triggered_by_name: user?.name || "Manual",
      };
      await api.functions.invoke("pulseDataSync", params);
      toast.success(`${source.label} started`);
      setTimeout(() => {
        refetchEntityList("PulseSyncLog");
        refetchEntityList("PulseTimeline");
      }, 5000);
    } catch (err) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setRunningSources((prev) => {
        const n = new Set(prev);
        n.delete(source.source_id);
        return n;
      });
    }
  }, [targetSuburbs, user]);

  return (
    <div className="space-y-5">
      {/* ── Source cards grid ── */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Data Sources
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {SOURCES.map((source) => (
            <SourceCard
              key={source.source_id}
              source={source}
              lastLog={lastLogBySource[source.source_id]}
              isRunning={runningSources.has(source.source_id)}
              onRun={runSource}
            />
          ))}
        </div>
      </div>

      {/* ── Cron schedule + Suburb pool side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CronScheduleTable runningSources={runningSources} />
        <SuburbPool targetSuburbs={targetSuburbs} />
      </div>

      {/* ── Sync history ── */}
      <SyncHistory syncLogs={syncLogs} onDrill={setDrillLog} />

      {/* ── Drill-through dialog ── */}
      {drillLog && (
        <DrillDialog log={drillLog} onClose={() => setDrillLog(null)} />
      )}
    </div>
  );
}
