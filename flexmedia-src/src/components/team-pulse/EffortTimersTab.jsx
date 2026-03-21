import { useMemo, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Clock, Play, Zap, BarChart3, Users, TrendingUp,
  AlertCircle, CheckCircle2, Pause
} from "lucide-react";
import { cn } from "@/lib/utils";

const formatSeconds = (secs) => {
  if (!secs || secs < 0) return "0m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const getTimerColor = (secs) => {
  if (secs < 300) return "bg-blue-100 text-blue-700 border-blue-200";
  if (secs < 1800) return "bg-green-100 text-green-700 border-green-200";
  if (secs < 3600) return "bg-amber-100 text-amber-700 border-amber-200";
  return "bg-red-100 text-red-700 border-red-200";
};

function LiveTimersSection({ timers, onRefresh }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const activeTimers = useMemo(() => {
    return timers
      .filter(t => t.is_active === true && t.status === 'running' && t.started_at)
      .map(t => {
        const startedMs = new Date(t.started_at).getTime();
        const elapsed = Math.floor((now - startedMs) / 1000);
        return { ...t, elapsedSeconds: Math.max(0, elapsed) };
      })
      .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds);
  }, [timers, now]);

  if (activeTimers.length === 0) {
    return (
      <Card className="border-dashed bg-muted/20">
        <CardContent className="pt-8 pb-8 text-center">
          <Pause className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No active timers</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Timers will appear here as team members log effort
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {activeTimers.map(timer => {
        const colorClass = getTimerColor(timer.elapsedSeconds);
        return (
          <div
            key={timer.id}
            className={cn(
              "p-3 rounded-lg border transition-all",
              colorClass
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-3 h-3 rounded-full bg-current animate-pulse" />
                  <p className="font-semibold text-sm truncate">
                    {timer.assigned_to_name || "Unassigned"}
                  </p>
                </div>
                {timer.title && (
                  <p className="text-xs opacity-75 truncate">{timer.title}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="font-mono font-bold text-sm">
                  {formatSeconds(timer.elapsedSeconds)}
                </p>
                <p className="text-[10px] opacity-70">
                  {new Date(timer.started_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HistoricalBreakdownSection({ timers, window }) {
  const WINDOW_MS = {
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000
  };

  const windowed = useMemo(() => {
    if (!timers || timers.length === 0) return [];
    const ms = WINDOW_MS[window] || WINDOW_MS["24h"];
    const cutoff = Date.now() - ms;

    return timers
      .filter(t => t.stopped_at && t.started_at && t.duration_seconds)
      .filter(t => {
        const ts = new Date(t.stopped_at).getTime();
        return !isNaN(ts) && ts >= cutoff;
      });
  }, [timers, window]);

  // By person
  const byPerson = useMemo(() => {
    const map = new Map();
    windowed.forEach(t => {
      const name = t.assigned_to_name || "Unassigned";
      if (!map.has(name)) {
        map.set(name, { name, totalSecs: 0, count: 0, tasks: [] });
      }
      const entry = map.get(name);
      entry.totalSecs += t.duration_seconds || 0;
      entry.count++;
      if (entry.tasks.length < 3) entry.tasks.push(t.title);
    });

    return Array.from(map.values())
      .sort((a, b) => b.totalSecs - a.totalSecs)
      .slice(0, 10);
  }, [windowed]);

  // By task type
  const byTaskType = useMemo(() => {
    const map = new Map();
    windowed.forEach(t => {
      const type = t.task_type || "back_office";
      if (!map.has(type)) {
        map.set(type, { type, totalSecs: 0, count: 0 });
      }
      const entry = map.get(type);
      entry.totalSecs += t.duration_seconds || 0;
      entry.count++;
    });

    return Array.from(map.values()).sort((a, b) => b.totalSecs - a.totalSecs);
  }, [windowed]);

  // Totals
  const totals = useMemo(() => {
    const totalSecs = windowed.reduce((sum, t) => sum + (t.duration_seconds || 0), 0);
    const avgPerEntry = windowed.length > 0 ? totalSecs / windowed.length : 0;
    return { totalSecs, count: windowed.length, avgPerEntry };
  }, [windowed]);

  const maxPersonSecs = byPerson[0]?.totalSecs || 1;
  const maxTypeSecs = byTaskType[0]?.totalSecs || 1;

  return (
    <div className="space-y-4">
      {/* Overview cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="shadow-sm border-blue-200 bg-blue-50/30">
          <CardContent className="pt-4 pb-3">
            <p className="text-3xl font-bold text-blue-600 tabular-nums">
              {formatSeconds(totals.totalSecs)}
            </p>
            <p className="text-xs text-blue-600/70 flex items-center gap-1 font-medium mt-1">
              <Clock className="h-3.5 w-3.5" /> Total time logged
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-emerald-200 bg-emerald-50/30">
          <CardContent className="pt-4 pb-3">
            <p className="text-3xl font-bold text-emerald-600 tabular-nums">
              {totals.count}
            </p>
            <p className="text-xs text-emerald-600/70 flex items-center gap-1 font-medium mt-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Completed entries
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-violet-200 bg-violet-50/30">
          <CardContent className="pt-4 pb-3">
            <p className="text-3xl font-bold text-violet-600 tabular-nums">
              {formatSeconds(totals.avgPerEntry)}
            </p>
            <p className="text-xs text-violet-600/70 flex items-center gap-1 font-medium mt-1">
              <TrendingUp className="h-3.5 w-3.5" /> Average entry
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Breakdown tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* By person */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 font-bold">
              <Users className="h-4 w-4 text-primary" /> By Team Member
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {byPerson.length === 0 ? (
              <p className="text-xs text-muted-foreground">No logged effort in this window</p>
            ) : (
              byPerson.map(person => (
                <div key={person.name} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate flex-1">{person.name}</span>
                    <span className="text-sm font-mono font-bold text-primary">
                      {formatSeconds(person.totalSecs)}
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className="h-2 rounded-full bg-gradient-to-r from-blue-400 to-cyan-400"
                      style={{ width: `${Math.round((person.totalSecs / maxPersonSecs) * 100)}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground flex items-center justify-between">
                    <span>{person.count} entries</span>
                    <span>{formatSeconds(person.totalSecs / person.count)} avg</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* By task type */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 font-bold">
              <Zap className="h-4 w-4 text-primary" /> By Task Type
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {byTaskType.length === 0 ? (
              <p className="text-xs text-muted-foreground">No logged effort in this window</p>
            ) : (
              byTaskType.map(type => (
                <div key={type.type} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium capitalize">
                        {type.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-sm font-mono font-bold text-primary">
                        {formatSeconds(type.totalSecs)}
                      </span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full bg-gradient-to-r from-emerald-400 to-teal-400"
                        style={{ width: `${Math.round((type.totalSecs / maxTypeSecs) * 100)}%` }}
                      />
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {type.count}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function EffortTimersTab() {
  const [window, setWindow] = useState("24h");

  const { data: timers = [], isLoading } = useQuery({
    queryKey: ["taskTimeLogs"],
    queryFn: () => api.entities.TaskTimeLog.list("-created_date", 500),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4">
      {/* Active timers header */}
      <div>
        <h2 className="text-sm font-bold flex items-center gap-2 mb-3">
          <Play className="h-4 w-4 text-emerald-600" /> Active Live Timers
        </h2>
        {isLoading ? (
          <div className="space-y-2">
            {Array(2)
              .fill(0)
              .map((_, i) => (
                <div key={i} className="h-12 bg-muted animate-pulse rounded-lg" />
              ))}
          </div>
        ) : (
          <LiveTimersSection timers={timers} />
        )}
      </div>

      {/* Historical breakdown header */}
      <div>
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="text-sm font-bold flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" /> Historical Breakdown
          </h2>
          <div className="flex items-center gap-1.5">
            {["24h", "7d", "30d"].map(w => (
              <Button
                key={w}
                variant={window === w ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs font-bold"
                onClick={() => setWindow(w)}
              >
                {w}
              </Button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Array(3)
              .fill(0)
              .map((_, i) => (
                <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
              ))}
          </div>
        ) : (
          <HistoricalBreakdownSection timers={timers} window={window} />
        )}
      </div>
    </div>
  );
}