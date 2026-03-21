import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useEffortLogs, formatDuration, getStatusColor } from "./useEffortLogging";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { fmtTimestampCustom, fixTimestamp } from "@/components/utils/dateUtils";
import { Clock, Plus, ChevronDown, Lock, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import TimerLogActions from "./TimerLogActions";
import ManualTimeEntryDialog from "./ManualTimeEntryDialog";

const ROWS_PER_PAGE = 25;

export default function TaskEffortSectionVirtualized({ taskId, onLogClick, task, project, user }) {
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [displayedCount, setDisplayedCount] = useState(ROWS_PER_PAGE);
  const [error, setError] = useState(null);

  // Validate inputs
  if (!taskId || !task || !project) {
    return null;
  }

  // Scoped to this project — useEntityList handles real-time create/update/delete automatically.
  // No local subscription needed. forceRefresh pattern removed (was dead code).
  const { timeLogs = [] } = useEffortLogs(project?.id) || {};

  // Filtered User lookup — avoids full table scan
  const { data: currentUser } = useQuery({ 
    queryKey: ["user-by-email", user?.email], 
    queryFn: async () => {
      const users = await api.entities.User.filter({ email: user.email }, null, 1);
      return users[0] || null;
    }, 
    enabled: !!user?.email,
    retry: 1
  });

  // Fix: Fallback if user lookup fails
  const isMasterAdmin = currentUser?.role === "master_admin" || user?.role === "master_admin";
  const isTaskLocked = task?.is_locked === true;
  
  // Fix: Validate array before filtering + handle null dates
  const taskLogs = useMemo(() => {
    if (!Array.isArray(timeLogs)) return [];
    
    return timeLogs
      .filter(log => log?.task_id === taskId && log?.id)
      .sort((a, b) => {
        const dateA = a?.created_date ? new Date(fixTimestamp(a.created_date)).getTime() : 0;
        const dateB = b?.created_date ? new Date(fixTimestamp(b.created_date)).getTime() : 0;
        return dateB - dateA;
      });
  }, [timeLogs, taskId]);

  // Virtual scrolling: slice displayed rows
  const displayedLogs = useMemo(() => taskLogs.slice(0, displayedCount), [taskLogs, displayedCount]);
  const hasMore = displayedCount < taskLogs.length;

  const loadMore = useCallback(() => {
    setDisplayedCount(prev => prev + ROWS_PER_PAGE);
  }, []);

  const handleOpenManualEntry = useCallback(() => {
    if (isTaskLocked) return; // Prevent opening if locked
    setShowManualEntry(true);
  }, [isTaskLocked]);

  if (taskLogs.length === 0) {
    return (
      <div className="mt-2 space-y-2">
        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
            <AlertCircle className="h-3 w-3" />
            {error}
          </div>
        )}

        {isTaskLocked && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
            <Lock className="h-3 w-3" />
            Task locked - no new entries allowed
          </div>
        )}

        <div className="text-center py-3 text-xs text-muted-foreground">
          <Clock className="h-4 w-4 mx-auto mb-1 opacity-30" />
          No time logged yet
        </div>

        {user && !isTaskLocked && (
          <Button 
            size="sm" 
            variant="outline" 
            className="h-6 text-xs w-full"
            onClick={handleOpenManualEntry}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Manual Entry
          </Button>
        )}

        {task && project && user && (
          <ManualTimeEntryDialog
            open={showManualEntry}
            onClose={() => setShowManualEntry(false)}
            task={task}
            project={project}
            user={user}
            role={user.role || "admin"}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}

      {isTaskLocked && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
          <Lock className="h-3 w-3" />
          Task locked - no new entries allowed
        </div>
      )}

      <div className="overflow-x-auto border rounded-lg">
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="whitespace-nowrap">Person</TableHead>
              <TableHead className="whitespace-nowrap">Role</TableHead>
              <TableHead className="whitespace-nowrap">Status</TableHead>
              <TableHead className="whitespace-nowrap">Start</TableHead>
              <TableHead className="whitespace-nowrap">End</TableHead>
              <TableHead className="text-right whitespace-nowrap">Duration</TableHead>
              <TableHead className="w-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayedLogs.map((log) => {
              if (!log?.id) return null; // Fix: Skip invalid logs
              
              const colors = getStatusColor(log.status);
              return (
                <TableRow 
                  key={log.id} 
                  className={`${colors.bg} border-b cursor-pointer hover:opacity-80`} 
                  onClick={() => onLogClick?.(log)}
                >
                  <TableCell className="text-xs">
                    <p className="font-medium">{log.user_name || 'Unknown'}</p>
                  </TableCell>
                  <TableCell className="text-xs capitalize">{log.role || 'admin'}</TableCell>
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
                    {formatDuration(log.total_seconds || 0)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {user && isMasterAdmin && (
                      <TimerLogActions log={log} currentUser={user} isMasterAdmin={isMasterAdmin} />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {hasMore && (
        <Button 
          variant="outline" 
          className="w-full h-8 text-xs"
          onClick={loadMore}
        >
          <ChevronDown className="h-3 w-3 mr-1" />
          Load {Math.min(ROWS_PER_PAGE, taskLogs.length - displayedCount)} more
        </Button>
      )}

      {user && !isTaskLocked && (
        <Button 
          size="sm" 
          variant="outline" 
          className="h-6 text-xs w-full"
          onClick={handleOpenManualEntry}
        >
          <Plus className="h-3 w-3 mr-1" />
          Add Manual Entry
        </Button>
      )}

      {task && project && user && (
        <ManualTimeEntryDialog
          open={showManualEntry}
          onClose={() => setShowManualEntry(false)}
          task={task}
          project={project}
          user={user}
          role={user.role || "admin"}
        />
      )}
    </div>
  );
}