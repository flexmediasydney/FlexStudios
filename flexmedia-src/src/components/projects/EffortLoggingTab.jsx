import React, { useState, useEffect, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtTimestampCustom, fixTimestamp } from "@/components/utils/dateUtils";
import { ChevronDown, ChevronRight, Clock, Layout, List, X, Lock, Plus, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffortLogs, formatDuration, getStatusColor } from "./useEffortLogging";
import TimerLogActions from "./TimerLogActions";
import TimerLogDetailModal from "./TimerLogDetailModal";
import ManualTimeEntryDialog from "./ManualTimeEntryDialog";

/** Compute live seconds for a log, accounting for running timers whose total_seconds is stale */
function computeLiveSeconds(log) {
  if (!log) return 0;
  if (log.status === 'running' && log.is_active && log.start_time) {
    // BUG FIX: use fixTimestamp to ensure start_time parses as UTC, not local time.
    // Without this, a timestamp like "2026-03-10T02:00:00" (no Z) is parsed as local midnight
    // on a UTC server, producing an 11h error in Sydney.
    return Math.max(0, Math.floor((Date.now() - new Date(fixTimestamp(log.start_time)).getTime()) / 1000) - (log.paused_duration || 0));
  }
  return log.total_seconds || 0;
}

export default function EffortLoggingTab({ projectId, project }) {
  const [expandedLogs, setExpandedLogs] = useState(new Set());
  const [viewMode, setViewMode] = useState("cards"); // "cards" or "table"
  const [filterPerson, setFilterPerson] = useState("all");
  const [filterTask, setFilterTask] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [sortBy, setSortBy] = useState("recent"); // "recent" or "duration"
  const [selectedLog, setSelectedLog] = useState(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualEntryTask, setManualEntryTask] = useState(null);

  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: () => api.auth.me() });
  const { data: currentUser } = useQuery({ queryKey: ["user", user?.email], queryFn: () => api.entities.User.filter({ email: user?.email }, null, 1).then(users => users[0] || null), enabled: !!user?.email });
  const isMasterAdmin = currentUser?.role === "master_admin";

  const isClosed = ['delivered', 'cancelled'].includes(project?.status);

  const { timeLogs: rawTimeLogs, groupedLogs } = useEffortLogs(projectId);
  const { data: tasks = [] } = useEntityList("ProjectTask", null, 200, (t) => t.project_id === projectId);

  // Exclude effort logs belonging to deleted tasks
  const deletedTaskIds = new Set(tasks.filter(t => t.is_deleted).map(t => t.id));
  const timeLogs = rawTimeLogs.filter(log => !deletedTaskIds.has(log.task_id));

  // Tick every second when any timer is running to keep durations live
  const [tick, setTick] = useState(0);
  const hasRunning = timeLogs.some(log => log.is_active && log.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Summary: total time and per-role breakdown (recomputes each tick for live timers)
  const summary = useMemo(() => {
    const roleMap = {};
    let total = 0;
    for (const log of timeLogs) {
      const secs = computeLiveSeconds(log);
      total += secs;
      const role = log.role || 'other';
      roleMap[role] = (roleMap[role] || 0) + secs;
    }
    return { total, byRole: roleMap };
  }, [timeLogs, tick]);

  const toggleExpand = (id) => {
    const newSet = new Set(expandedLogs);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setExpandedLogs(newSet);
  };

  // Get unique people and tasks for filter dropdowns
  const uniquePeople = [...new Set(timeLogs.map(log => `${log.user_id}:${log.user_name}`))];
  const uniqueTasks = [...new Set(timeLogs.map(log => log.task_id))];
  const statuses = ["running", "paused", "completed"];

  // Apply filters
  const filteredLogs = timeLogs.filter(log => {
    const personMatch = filterPerson === "all" || log.user_id === filterPerson.split(":")[0];
    const taskMatch = filterTask === "all" || log.task_id === filterTask;
    const statusMatch = filterStatus === "all" || log.status === filterStatus;
    return personMatch && taskMatch && statusMatch;
  });

  // Apply sorting
  const sortedLogs = [...filteredLogs].sort((a, b) => {
    if (sortBy === "duration") {
      return computeLiveSeconds(b) - computeLiveSeconds(a);
    }
    return new Date(fixTimestamp(b.created_date)) - new Date(fixTimestamp(a.created_date));
  });

  // Regroup filtered logs
  const filteredGroupedLogs = sortedLogs.reduce((acc, log) => {
    const key = `${log.task_id}_${log.user_id}`;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(log);
    return acc;
  }, {});

  return (
     <>
       <Card>
         <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base">Effort Logging</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Real-time entries with task context
          </p>
        </div>
        {isClosed && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground">
            <Lock className="h-4 w-4 flex-shrink-0" />
            Disabled — project is {project?.status}
          </div>
        )}
        {timeLogs.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={viewMode === "cards" ? "default" : "outline"}
              onClick={() => setViewMode("cards")}
              className="h-8 w-8 p-0"
              aria-label="Card view"
            >
              <Layout className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant={viewMode === "table" ? "default" : "outline"}
              onClick={() => setViewMode("table")}
              className="h-8 w-8 p-0"
              aria-label="Table view"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {timeLogs.length === 0 ? (
          <div className="text-center py-12">
            <Timer className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No time tracked yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1.5 max-w-xs mx-auto">
              Start a timer from the Tasks tab, or add a manual entry below.
            </p>
            {!isClosed && tasks.filter(t => !t.is_deleted).length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="mt-4 gap-1.5"
                onClick={() => {
                  const firstTask = tasks.find(t => !t.is_deleted);
                  if (firstTask) {
                    setManualEntryTask(firstTask);
                    setShowManualEntry(true);
                  }
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                Add Manual Entry
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Summary bar */}
            <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-lg bg-muted/50 border text-sm">
              <div className="flex items-center gap-1.5 font-semibold">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                Total: {formatDuration(summary.total)}
              </div>
              {Object.entries(summary.byRole).length > 1 && (
                <>
                  <span className="text-muted-foreground/40">|</span>
                  {Object.entries(summary.byRole)
                    .sort(([, a], [, b]) => b - a)
                    .map(([role, secs]) => (
                      <span key={role} className="text-xs text-muted-foreground">
                        <span className="capitalize">{role.replace(/_/g, ' ')}</span>: {formatDuration(secs)}
                      </span>
                    ))}
                </>
              )}
              {!isClosed && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto gap-1.5 h-7 text-xs"
                  onClick={() => {
                    const firstTask = tasks.find(t => !t.is_deleted);
                    if (firstTask) {
                      setManualEntryTask(firstTask);
                      setShowManualEntry(true);
                    }
                  }}
                  disabled={tasks.filter(t => !t.is_deleted).length === 0}
                >
                  <Plus className="h-3 w-3" />
                  Add Manual Entry
                </Button>
              )}
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-2 items-center pb-3 border-b">
              <Select value={filterPerson} onValueChange={setFilterPerson}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="All people" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">All People</SelectItem>
                    {uniquePeople.map(p => {
                      const [id, name] = p.split(":");
                      return <SelectItem key={id} value={`${id}:${name}`}>{name}</SelectItem>;
                    })}
                  </SelectContent>
              </Select>

              <Select value={filterTask} onValueChange={setFilterTask}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="All tasks" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tasks</SelectItem>
                  {uniqueTasks.map(taskId => {
                    const task = tasks.find(t => t.id === taskId);
                    return <SelectItem key={taskId} value={taskId}>{task?.title || taskId.slice(0, 8)}</SelectItem>;
                  })}
                </SelectContent>
              </Select>

              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue placeholder="All status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  {statuses.map(s => (
                    <SelectItem key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue placeholder="Recent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent">Most Recent</SelectItem>
                  <SelectItem value="duration">Longest Duration</SelectItem>
                </SelectContent>
              </Select>

              {(filterPerson !== "all" || filterTask !== "all" || filterStatus !== "all") && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setFilterPerson("all"); setFilterTask("all"); setFilterStatus("all"); }}
                  className="h-8 px-2 ml-auto text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                >
                  <X className="h-3 w-3 mr-1" />
                  Clear
                </Button>
              )}
            </div>

            {filteredLogs.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">No entries match your filters</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {filteredLogs.length} {filteredLogs.length === 1 ? "entry" : "entries"}
                </p>
                {viewMode === "cards" ? (
                  <CardViewContent groupedLogs={filteredGroupedLogs} tasks={tasks} expandedLogs={expandedLogs} toggleExpand={toggleExpand} onLogClick={setSelectedLog} currentUser={currentUser} isMasterAdmin={isMasterAdmin} />
                ) : (
                  <TableViewContent timeLogs={filteredLogs} tasks={tasks} onLogClick={setSelectedLog} currentUser={currentUser} isMasterAdmin={isMasterAdmin} />
                )}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>

      {selectedLog && (
        <TimerLogDetailModal
          log={selectedLog}
          onClose={() => setSelectedLog(null)}
          currentUser={currentUser}
          isMasterAdmin={isMasterAdmin}
        />
      )}

      {showManualEntry && manualEntryTask && (
        <ManualTimeEntryDialog
          open={showManualEntry}
          onClose={() => { setShowManualEntry(false); setManualEntryTask(null); }}
          task={manualEntryTask}
          project={project}
          user={currentUser}
          role={manualEntryTask.auto_assign_role || 'admin'}
        />
      )}
    </>
  );
}

function CardViewContent({ groupedLogs, tasks, expandedLogs, toggleExpand, onLogClick, currentUser, isMasterAdmin }) {
  // Group entries by task for clear visual separation
  const byTask = {};
  for (const [groupKey, logs] of Object.entries(groupedLogs)) {
    const taskId = logs[0]?.task_id;
    if (!byTask[taskId]) byTask[taskId] = [];
    byTask[taskId].push([groupKey, logs]);
  }
  const taskIds = Object.keys(byTask);
  const hasMultipleTasks = taskIds.length > 1;

  return (
    <div className="space-y-4">
      {taskIds.map((taskId, taskIdx) => {
        const taskTitle = tasks.find(t => t.id === taskId)?.title || taskId?.slice(0, 8);
        const taskGroups = byTask[taskId];
        const taskTotalSecs = taskGroups.reduce((sum, [, logs]) => sum + logs.reduce((s, l) => s + computeLiveSeconds(l), 0), 0);

        return (
          <div key={taskId}>
            {/* Task group header when multiple tasks */}
            {hasMultipleTasks && (
              <>
                {taskIdx > 0 && <div className="border-t my-2" />}
                <div className="flex items-center justify-between mb-2 px-1">
                  <p className="text-xs font-semibold text-muted-foreground truncate">{taskTitle}</p>
                  <span className="text-xs font-mono text-muted-foreground">{formatDuration(taskTotalSecs)}</span>
                </div>
              </>
            )}
            <div className="space-y-3">
              {taskGroups.map(([groupKey, logs]) => {
      const isExpanded = expandedLogs.has(groupKey);
      const parentLog = logs[0];
      const totalLoggedTime = logs.reduce((sum, log) => sum + computeLiveSeconds(log), 0);
      const isMultiSession = logs.length > 1;
      const colors = getStatusColor(parentLog.status);
      const entryTaskTitle = tasks.find(t => t.id === parentLog.task_id)?.title || parentLog.task_id?.slice(0, 8);

      return (
        <div key={groupKey}>
            <div
              onClick={() => {
                if (isMultiSession) {
                  toggleExpand(groupKey);
                } else {
                  onLogClick(parentLog);
                }
              }}
              className={cn(
                "border rounded-lg p-4 transition-all",
                colors.bg,
                colors.border,
                "cursor-pointer hover:shadow-sm"
              )}
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 pt-1">
                  {isMultiSession ? (
                    isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )
                  ) : (
                    <div className="w-4" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                   <div className="flex items-center gap-2 mb-2">
                     <div className={`w-2 h-2 rounded-full flex-shrink-0 ${colors.dot}`}></div>
                    <span className={`text-xs font-semibold ${colors.text}`}>
                      {(parentLog.status || 'unknown').charAt(0).toUpperCase() + (parentLog.status || 'unknown').slice(1)}
                    </span>
                    {(parentLog.log_source === 'auto_completion' || parentLog.log_source === 'auto_onsite') && (
                      <Badge variant="outline" className="text-[9px] font-medium bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-700">
                        Auto
                      </Badge>
                    )}
                    {(parentLog.log_source === 'manual' || parentLog.is_manual) && (
                      <Badge variant="outline" className="text-[9px] font-medium bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-700">
                        Manual
                      </Badge>
                    )}
                    {isMultiSession && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {logs.length} sessions
                      </span>
                    )}
                  </div>

                  {/* Task Context */}
                  <div className="mb-3 pb-3 border-b border-current border-opacity-10">
                    <p className="text-xs text-muted-foreground font-medium">Task</p>
                    <p className="font-medium text-sm truncate">{entryTaskTitle}</p>
                    <p className="text-xs text-muted-foreground">Effort: <span className="font-semibold capitalize">{parentLog.role?.replace(/_/g, ' ')}</span></p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-2">
                    <div>
                      <p className="text-xs text-muted-foreground font-medium">User</p>
                      <p className="font-medium text-sm">{parentLog.user_name}</p>
                      <p className="text-xs text-muted-foreground truncate">{parentLog.user_email}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground font-medium">Total Time</p>
                      <p className="font-bold text-sm">{isMultiSession ? formatDuration(totalLoggedTime) : formatDuration(computeLiveSeconds(parentLog))}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Start</p>
                      <p className="font-mono text-xs">{fmtTimestampCustom(parentLog.start_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">End</p>
                      <p className="font-mono text-xs">{fmtTimestampCustom(parentLog.end_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {isMultiSession && isExpanded && (
               <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
                 {logs.map((log, idx) => (
                   <div key={log.id} className="bg-muted/30 rounded-lg p-3 cursor-pointer hover:bg-muted/50" onClick={() => onLogClick(log)}>
                     <div className="flex items-center justify-between mb-2">
                       <div className="flex items-center gap-1.5">
                         <span className="text-xs font-semibold text-muted-foreground">
                           Session {idx + 1}
                         </span>
                         {(log.log_source === 'auto_completion' || log.log_source === 'auto_onsite') && (
                           <Badge variant="outline" className="text-[9px] font-medium bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-700">
                             Auto
                           </Badge>
                         )}
                         {(log.log_source === 'manual' || log.is_manual) && (
                           <Badge variant="outline" className="text-[9px] font-medium bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-700">
                             Manual
                           </Badge>
                         )}
                       </div>
                       <span className="text-xs font-mono font-bold">
                         {formatDuration(computeLiveSeconds(log))}
                       </span>
                     </div>
                     <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                       <div>
                         <p className="text-[10px] uppercase tracking-wider">Start</p>
                         <p className="font-mono">{fmtTimestampCustom(log.start_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
                       </div>
                       <div>
                         <p className="text-[10px] uppercase tracking-wider">End</p>
                         <p className="font-mono">{fmtTimestampCustom(log.end_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
                       </div>
                     </div>
                   </div>
                 ))}
               </div>
             )}
        </div>
      );
    })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TableViewContent({ timeLogs, tasks, onLogClick, currentUser, isMasterAdmin }) {
  const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));

  return (
    <div className="overflow-x-auto">
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="whitespace-nowrap">User</TableHead>
            <TableHead className="whitespace-nowrap">Task / Role</TableHead>
            <TableHead className="whitespace-nowrap">Status</TableHead>
            <TableHead className="whitespace-nowrap">Start</TableHead>
            <TableHead className="whitespace-nowrap">End</TableHead>
            <TableHead className="text-right whitespace-nowrap">Duration</TableHead>
            <TableHead className="w-8"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeLogs.map((log) => {
            const task = taskMap[log.task_id];
            const taskTitle = task?.title || log.task_id?.slice(0, 8);
            const colors = getStatusColor(log.status);

            return (
              <TableRow key={log.id} className={`${colors.bg} border-b cursor-pointer hover:opacity-80`} onClick={() => onLogClick(log)}>
                <TableCell className="text-xs">
                  <div>
                    <p className="font-medium">{log.user_name}</p>
                    <p className="text-muted-foreground text-[10px] truncate">{log.user_email}</p>
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  <div>
                    <p className="font-medium truncate">{taskTitle}</p>
                    <p className="text-muted-foreground text-[10px] capitalize">{log.role?.replace(/_/g, ' ')}</p>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className={`text-[10px] font-semibold ${colors.text}`}>
                      {log.status}
                    </Badge>
                    {(log.log_source === 'auto_completion' || log.log_source === 'auto_onsite') && (
                      <Badge variant="outline" className="text-[9px] font-medium bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-700">
                        Auto
                      </Badge>
                    )}
                    {(log.log_source === 'manual' || log.is_manual) && (
                      <Badge variant="outline" className="text-[9px] font-medium bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-700">
                        Manual
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[10px]">
                  {fmtTimestampCustom(log.start_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                </TableCell>
                <TableCell className="font-mono text-[10px]">
                  {fmtTimestampCustom(log.end_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                </TableCell>
                <TableCell className="text-right font-bold">
                  {formatDuration(computeLiveSeconds(log))}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <TimerLogActions log={log} currentUser={currentUser} isMasterAdmin={isMasterAdmin} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}