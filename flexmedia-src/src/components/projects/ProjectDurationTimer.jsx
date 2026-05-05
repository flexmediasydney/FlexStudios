import React, { useState, useEffect, useCallback } from "react";
import { useVisibleInterval } from "@/components/hooks/useVisibleInterval";
import { fixTimestamp } from '@/components/utils/dateUtils';

const APP_TZ = 'Australia/Sydney';

function parseCreatedMs(createdDate) {
  if (!createdDate) return null;
  const str = String(createdDate);

  // Full UTC timestamp — new Date() is correct, timezone irrelevant for ms math
  if (str.includes('T') || str.includes('Z')) {
    return new Date(fixTimestamp(str)).getTime();
  }

  // Date-only string e.g. "2026-03-11" — new Date() would give UTC midnight
  // which is 11am Sydney, causing an instant ~11h head start.
  // Instead treat it as Sydney local midnight.
  const [y, m, d] = str.substring(0, 10).split('-').map(Number);
  const approxUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetStr = new Intl.DateTimeFormat('en-AU', {
    timeZone: APP_TZ, timeZoneName: 'shortOffset'
  }).formatToParts(new Date(approxUTC))
    .find(p => p.type === 'timeZoneName')?.value ?? '+11:00';
  const sign = offsetStr[0] === '+' ? -1 : 1;
  const [hh, mm] = offsetStr.slice(1).split(':').map(Number);
  return approxUTC + sign * (hh * 60 + (mm || 0)) * 60000;
}

function formatDuration(seconds) {
  if (seconds < 0) seconds = 0;
  const days  = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins  = Math.floor((seconds % 3600) / 60);
  const secs  = Math.floor(seconds % 60);
  if (days > 0)  return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0)  return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function ProjectDurationTimer({ project }) {
  const [elapsed, setElapsed] = useState(0);

  const createdMs = parseCreatedMs(project?.created_date);
  const isLive = !!createdMs && project?.status !== 'delivered';

  // One-shot compute on mount / dep change so the static delivered case
  // (and the initial value) is set without waiting for the first tick.
  useEffect(() => {
    if (!createdMs) return;
    setElapsed(Math.floor((Date.now() - createdMs) / 1000));
  }, [createdMs, project?.status]);

  // Live ticking, paused when the tab is hidden.
  const onTick = useCallback(() => {
    if (createdMs) setElapsed(Math.floor((Date.now() - createdMs) / 1000));
  }, [createdMs]);
  useVisibleInterval(onTick, 1000, { enabled: isLive });

  if (!project?.created_date) return null;
  return <span className="tabular-nums">{formatDuration(elapsed)}</span>;
}

export default React.memo(ProjectDurationTimer);