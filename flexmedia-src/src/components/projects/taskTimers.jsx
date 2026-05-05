/**
 * taskTimers — extracted from TaskManagement.jsx to break a circular import
 * cycle that produced a TDZ ("Cannot access 'te' before initialization") on
 * the Project Detail page in production minified builds.
 *
 * Cycle was:
 *   TaskManagement → TaskListView → TaskManagement (named: CountdownTimer / …)
 *   TaskManagement → TaskListView → TaskDetailPanel → TaskManagement
 *
 * Hosting these tiny presentational helpers in their own leaf module breaks
 * the cycle. TaskManagement still re-exports them for back-compat with the
 * other (non-cyclic) consumers (ProjectCardFields, ProjectRevisionsTab,
 * pages/Tasks).
 */
import React, { useState, useEffect, useCallback } from "react";
import { differenceInSeconds } from "date-fns";
import { useVisibleInterval } from "@/components/hooks/useVisibleInterval";

export function getCountdownState({ dueDate, thresholds }) {
  if (!dueDate) return "normal";

  const defaults = { yellow_start: 12, yellow_end: 6, red_threshold: 6 };
  const t = thresholds || defaults;

  let due;
  try {
    due = new Date(dueDate);
    if (isNaN(due.getTime())) return "normal";
  } catch {
    return "normal";
  }

  const secondsLeft = differenceInSeconds(due, new Date());
  const isPast = secondsLeft < 0;
  const absSeconds = Math.abs(secondsLeft);
  const totalHours = absSeconds / 3600;

  if (isPast) {
    return "overdue"; // red
  } else if (totalHours < t.red_threshold) {
    return "critical"; // red
  } else if (totalHours < t.yellow_end) {
    return "warning"; // orange
  } else if (totalHours < t.yellow_start) {
    return "caution"; // amber
  }
  return "normal"; // neutral
}

export function CountdownTimer({ dueDate, compact = false, thresholds }) {
  const [now, setNow] = useState(Date.now());
  const onTick = useCallback(() => setNow(Date.now()), []);
  useVisibleInterval(onTick, 1000, { enabled: !!dueDate });

  if (!dueDate) return <span className="text-xs text-muted-foreground">No deadline</span>;

  const defaults = { yellow_start: 12, yellow_end: 6, red_threshold: 6 };
  const t = thresholds || defaults;

  let due;
  try {
    due = new Date(dueDate);
    if (isNaN(due.getTime())) throw new Error('Invalid date');
  } catch {
    return <span className="text-xs text-destructive">Invalid date</span>;
  }

  const secondsLeft = differenceInSeconds(due, new Date(now));
  const isPast = secondsLeft < 0;
  const absSeconds = Math.abs(secondsLeft);
  const days = Math.floor(absSeconds / 86400);
  const hours = Math.floor((absSeconds % 86400) / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);

  // Always show all components: xD XXh XXm
  const totalHours = absSeconds / 3600;

  let text, color;
  if (isPast) {
    text = `${days}d ${hours}h ${minutes}m overdue`;
    color = "text-red-600 dark:text-red-400";
  } else if (totalHours < t.red_threshold) {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-red-500 dark:text-red-400";
  } else if (totalHours < t.yellow_end) {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-orange-500 dark:text-orange-400";
  } else if (totalHours < t.yellow_start) {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-amber-500 dark:text-amber-400";
  } else {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-muted-foreground";
  }

  return <span className={`text-xs font-mono flex-shrink-0 ${color}`}>{text}</span>;
}

export function CompletionTimer({ dueDate, completedDate }) {
  if (!dueDate || !completedDate) return null;
  let due, completed;
  try {
    due = new Date(dueDate);
    completed = new Date(completedDate);
    if (isNaN(due.getTime()) || isNaN(completed.getTime())) return null;
  } catch {
    return null;
  }
  const absSeconds = Math.abs(differenceInSeconds(completed, due));
  const days = Math.floor(absSeconds / 86400);
  const hours = Math.floor((absSeconds % 86400) / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);

  const text = `completed in ${days}d ${hours}h ${minutes}m`;
  const color = differenceInSeconds(completed, due) <= 0 ? "text-green-600 dark:text-green-400" : "text-orange-500 dark:text-orange-400";

  return <span className={`text-xs font-mono flex-shrink-0 ${color}`}>{text}</span>;
}
