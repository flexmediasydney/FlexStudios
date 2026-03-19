import React, { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtTimestampCustom, fixTimestamp } from "@/components/utils/dateUtils";
import { ChevronDown, ChevronRight, Clock, Layout, List, X, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffortLogs, formatDuration, getStatusColor } from "./useEffortLogging";
import TimerLogActions from "./TimerLogActions";
import TimerLogDetailModal from "./TimerLogDetailModal";

export default function EffortLoggingTab({ projectId, project }) {
  const [expandedLogs, setExpandedLogs] = useState(new Set());
  const [viewMode, setViewMode] = useState("cards"); // "cards" or "table"
  const [filterPerson, setFilterPerson] = useState("all");
  const [filterTask, setFilterTask] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [sortBy, setSortBy] = useState("recent"); // "recent" or "duration"
  const [selectedLog, setSelectedLog] = useState(null);

  const { data: user } = useQuery({ queryKey: ["current-user"], queryFn: () => base44.auth.me() });
  const { data: currentUser } = useQuery({ queryKey: ["user", user?.email], queryFn: () => base44.entities.User.filter({ email: user.email }, null, 1).then(users => users[0] || null), enabled: !!user?.email });
  const isMasterAdmin = currentUser?.role === "master_admin";

  const isClosed = ['delivered', 'cancelled'].includes(project?.status);

  const { timeLogs, groupedLogs } = useEffortLogs(projectId);
  const { data: tasks = [] } = useEntityList("ProjectTask", null, 200, (t) => t.project_id === projectId);

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
      return (b.total_seconds || 0) - (a.total_seconds || 0);
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
            >
              <Layout className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant={viewMode === "table" ? "default" : "outline"}
              onClick={() => setViewMode("table")}
              className="h-8 w-8 p-0"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {timeLogs.length === 0 ? (
          <div className="text-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No time logged yet</p>
          </div>
        ) : (
          <>
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
                   <CardViewContent groupedLogs={filteredGroupedLogs} tasks={tasks} expandedLogs={expandedLogs} toggleExpand={toggleExpand} onLogClick={setSelectedLog} currentUser={user} isMasterAdmin={isMasterAdmin} />
                 ) : (
                   <TableViewContent timeLogs={filteredLogs} tasks={tasks} onLogClick={setSelectedLog} currentUser={user} isMasterAdmin={isMasterAdmin} />
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
                currentUser={user}
                isMasterAdmin={isMasterAdmin}
                />
                )}
                </>
                );
                }

function CardViewContent({ groupedLogs, tasks, expandedLogs, toggleExpand, onLogClick, currentUser, isMasterAdmin }) {
  return (
    <div className="space-y-3">
      {Object.entries(groupedLogs).map(([groupKey, logs]) => {
        const isExpanded = expandedLogs.has(groupKey);
        const parentLog = logs[0];
        const totalLoggedTime = logs.reduce((sum, log) => sum + (log.total_seconds || 0), 0);
        const isMultiSession = logs.length > 1;
        const colors = getStatusColor(parentLog.status);
        const taskTitle = tasks.find(t => t.id === parentLog.task_id)?.title || parentLog.task_id?.slice(0, 8);

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
                     <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: colors.dot.includes('blue') ? '#3b82f6' : colors.dot.includes('green') ? '#10b981' : colors.dot.includes('orange') ? '#f97316' : '#6b7280' }}></div>
                    <span className={`text-xs font-semibold ${colors.text}`}>
                      {parentLog.status.charAt(0).toUpperCase() + parentLog.status.slice(1)}
                    </span>
                    {isMultiSession && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {logs.length} sessions
                      </span>
                    )}
                  </div>

                  {/* Task Context */}
                  <div className="mb-3 pb-3 border-b border-current border-opacity-10">
                    <p className="text-xs text-muted-foreground font-medium">Task</p>
                    <p className="font-medium text-sm truncate">{taskTitle}</p>
                    <p className="text-xs text-muted-foreground">Effort: <span className="font-semibold capitalize">{parentLog.role}</span></p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-2">
                    <div>
                      <p className="text-xs text-muted-foreground font-medium">User</p>
                      <p className="font-medium text-sm">{parentLog.user_name}</p>
                      <p className="text-xs text-muted-foreground truncate">{parentLog.user_email}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground font-medium">Total Time</p>
                      <p className="font-bold text-sm">{isMultiSession ? formatDuration(totalLoggedTime) : formatDuration(parentLog.total_seconds)}</p>
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
                       <span className="text-xs font-semibold text-muted-foreground">
                         Session {idx + 1}
                       </span>
                       <span className="text-xs font-mono font-bold">
                         {formatDuration(log.total_seconds)}
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
                    <p className="text-muted-foreground text-[10px] capitalize">{log.role}</p>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={`text-[10px] font-semibold ${colors.text}`}>
                    {log.status}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-[10px]">
                  {fmtTimestampCustom(log.start_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                </TableCell>
                <TableCell className="font-mono text-[10px]">
                  {fmtTimestampCustom(log.end_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                </TableCell>
                <TableCell className="text-right font-bold">
                  {formatDuration(log.total_seconds)}
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