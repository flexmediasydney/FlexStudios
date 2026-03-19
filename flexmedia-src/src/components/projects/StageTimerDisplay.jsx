import { useState, useEffect } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { differenceInSeconds } from "date-fns";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fixTimestamp, fmtTimestampCustom } from "@/components/utils/dateUtils";

function formatDuration(seconds) {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.floor((seconds % 86400) / 3600);
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function LiveTimer({ entryTime }) {
  const [elapsed, setElapsed] = useState(() => 
    Math.max(0, differenceInSeconds(new Date(), new Date(fixTimestamp(entryTime))))
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.max(0, differenceInSeconds(new Date(), new Date(fixTimestamp(entryTime)))));
    }, 1000);
    return () => clearInterval(interval);
  }, [entryTime]);

  return <span>{formatDuration(elapsed)}</span>;
}

export default function StageTimerDisplay({ stage, stageLabel, projectId }) {
  const { data: timers } = useEntityList(
    "ProjectStageTimer",
    "-created_date",
    null,
    (t) => t.project_id === projectId && t.stage === stage
  );

  if (timers.length === 0) return null;

  // Calculate total accumulated time across all visits
  let totalAccumulated = 0;
  const currentTimer = timers.find(t => !t.exit_time);

  timers.forEach(timer => {
    if (timer.exit_time) {
      totalAccumulated += timer.duration_seconds || 0;
    } else if (currentTimer) {
      // For current timer, add accumulated + live time
      const liveTime = differenceInSeconds(new Date(), new Date(fixTimestamp(timer.entry_time)));
      totalAccumulated += (timer.duration_seconds || 0) + liveTime;
    }
  });

  const visitCount = timers.length;
  const isReEntry = visitCount > 1;
  const lastTimer = timers[timers.length - 1];

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold">{formatDuration(Math.floor(totalAccumulated))}</span>
            {isReEntry && (
              <span className="text-xs bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">
                ×{visitCount}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="p-0 overflow-hidden shadow-lg border-0 w-56">
          <div className="bg-[#3c4043] text-white rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10">
              <p className="font-semibold text-sm">{stageLabel}</p>
              {!lastTimer.exit_time && (
                <p className="text-xs text-white/70 mt-0.5">Currently in stage</p>
              )}
            </div>
            <div className="px-4 py-3 space-y-2 text-xs text-white/80">
              {lastTimer.entry_time && (
                <div className="flex justify-between">
                  <span className="text-white/60">{isReEntry ? "Last entered" : "Entered"}</span>
                  <span className="font-medium">{fmtTimestampCustom(lastTimer.entry_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                </div>
              )}
              {lastTimer.exit_time && (
                <div className="flex justify-between">
                  <span className="text-white/60">Exited</span>
                  <span className="font-medium">{fmtTimestampCustom(lastTimer.exit_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-white/10">
                <span className="font-semibold text-white">Total time in stage</span>
                <span className="font-bold text-white">
                  {!lastTimer.exit_time ? (
                    <LiveTimer entryTime={lastTimer.entry_time} />
                  ) : (
                    formatDuration(totalAccumulated)
                  )}
                </span>
              </div>
              {isReEntry && (
                <div className="flex justify-between items-center pt-1">
                  <span className="text-amber-300 font-semibold">Times in stage</span>
                  <span className="bg-amber-400/20 text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-bold">
                    {visitCount}×
                  </span>
                </div>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}