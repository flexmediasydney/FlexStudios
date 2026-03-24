import React, { useState, useEffect, useMemo } from "react";
import { Timer, User, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/api/supabaseClient";

function computeLiveSeconds(log) {
  if (!log?.start_time) return 0;
  if (log.status === "completed" || !log.is_active) return Math.max(0, log.total_seconds || 0);
  if (log.status === "paused") return Math.max(0, log.total_seconds || 0);
  // running
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000) - (log.paused_duration || 0)
  );
}

function formatHMS(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function LiveClock({ log }) {
  const [secs, setSecs] = useState(() => computeLiveSeconds(log));

  useEffect(() => {
    if (log.status !== "running") {
      setSecs(computeLiveSeconds(log));
      return;
    }
    const id = setInterval(() => setSecs(computeLiveSeconds(log)), 1000);
    return () => clearInterval(id);
  }, [log.id, log.status, log.start_time, log.paused_duration, log.total_seconds]);

  return (
    <span className="font-mono text-sm font-bold tabular-nums">
      {formatHMS(secs)}
    </span>
  );
}

const roleColors = {
  photographer: { bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500" },
  videographer: { bg: "bg-purple-100", text: "text-purple-700", dot: "bg-purple-500" },
  image_editor: { bg: "bg-emerald-100", text: "text-emerald-700", dot: "bg-emerald-500" },
  video_editor: { bg: "bg-rose-100", text: "text-rose-700", dot: "bg-rose-500" },
  admin: { bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500" },
};

const roleLabels = {
  photographer: "Photographer",
  videographer: "Videographer",
  image_editor: "Image Editor",
  video_editor: "Video Editor",
  admin: "Admin",
};

export default function ActiveTimersPanel({ projectId, tasks = [] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [timeLogs, setTimeLogs] = useState([]);

  // Fetch initial data + subscribe to real-time updates
  useEffect(() => {
    if (!projectId) return;
    
    let mounted = true;
    let retries = 0;

    const fetchLogs = async () => {
      try {
        const logs = await api.entities.TaskTimeLog.filter({ project_id: projectId, is_active: true });
        if (mounted) setTimeLogs(logs);
      } catch (err) {
        if (retries < 2 && err.message?.includes('Rate limit')) {
          retries++;
          setTimeout(fetchLogs, 2000);
        }
      }
    };

    fetchLogs();

    // Subscribe to changes - update local state in real-time
    //
    // BUG FIX (subscription audit): When a timer was updated to is_active: false
    // (e.g., completed or stopped), the UPDATE handler kept it in the list because
    // it only checked `existing` (maps it) or `event.data?.is_active` (adds it).
    // A deactivated timer stayed visible as an "active" timer until page refresh.
    const unsub = api.entities.TaskTimeLog.subscribe((event) => {
      if (!mounted) return;
      // For DELETE, event.data may be null — skip project_id check
      if (event.type !== 'delete' && event.data?.project_id !== projectId) return;

      if (event.type === 'create' || event.type === 'update') {
        setTimeLogs(prev => {
          const existing = prev.find(l => l.id === event.id);
          if (existing) {
            // BUG FIX: remove timer if it became inactive
            if (!event.data?.is_active) {
              return prev.filter(l => l.id !== event.id);
            }
            return prev.map(l => l.id === event.id ? event.data : l);
          } else if (event.data?.is_active) {
            // Prevent duplicates
            if (prev.some(l => l.id === event.data.id)) return prev;
            return [...prev, event.data];
          }
          return prev;
        });
      } else if (event.type === 'delete') {
        setTimeLogs(prev => prev.filter(l => l.id !== event.id));
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [projectId]);

  const activeTimers = useMemo(
    () => timeLogs.filter((l) => l.status === "running" || l.status === "paused"),
    [timeLogs]
  );

  // Build task title map
  const taskMap = useMemo(() => {
    const map = {};
    tasks.forEach((t) => { map[t.id] = t.title; });
    return map;
  }, [tasks]);

  if (activeTimers.length === 0) return null;

  const runningCount = activeTimers.filter((l) => l.status === "running").length;
  const pausedCount = activeTimers.filter((l) => l.status === "paused").length;

  return (
    <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 overflow-hidden shadow-sm">
      {/* Header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-emerald-100/50 transition-colors"
      >
        <div className="relative flex-shrink-0">
          <Timer className="h-4 w-4 text-emerald-600" />
          {runningCount > 0 && (
            <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
          )}
        </div>
        <div className="flex-1 flex items-center gap-2 text-left min-w-0">
          <span className="font-semibold text-emerald-900 text-sm">Active Timers</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {runningCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500 text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-card animate-pulse" />
                {runningCount} running
              </span>
            )}
            {pausedCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                {pausedCount} paused
              </span>
            )}
          </div>
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-emerald-600 flex-shrink-0" />
        ) : (
          <ChevronUp className="h-4 w-4 text-emerald-600 flex-shrink-0" />
        )}
      </button>

      {/* Timer rows */}
      {!collapsed && (
        <div className="divide-y divide-emerald-100 border-t border-emerald-200">
          {activeTimers.map((log) => {
            const colors = roleColors[log.role] || { bg: "bg-gray-100", text: "text-gray-700", dot: "bg-gray-400" };
            const taskTitle = taskMap[log.task_id];
            const isRunning = log.status === "running";
            return (
              <div key={log.id} className="flex items-center gap-3 px-4 py-2.5 bg-card/60">
                {/* Status dot */}
                <span className={cn(
                  "h-2 w-2 rounded-full flex-shrink-0",
                  colors.dot,
                  isRunning && "animate-pulse"
                )} />

                {/* User info */}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate leading-tight">
                      {log.user_name || "Unknown"}
                    </p>
                    {taskTitle && (
                      <p className="text-xs text-muted-foreground truncate leading-tight">{taskTitle}</p>
                    )}
                  </div>
                </div>

                {/* Role badge */}
                <span className={cn(
                  "hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0",
                  colors.bg, colors.text
                )}>
                  {roleLabels[log.role] || log.role}
                </span>

                {/* Status */}
                <span className={cn(
                  "text-xs flex-shrink-0",
                  isRunning ? "text-emerald-600" : "text-amber-600"
                )}>
                  {isRunning ? "Running" : "Paused"}
                </span>

                {/* Live clock */}
                <div className="flex-shrink-0 text-right w-20">
                  <LiveClock log={log} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}