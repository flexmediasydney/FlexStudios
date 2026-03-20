import {
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, subDays, subWeeks, subMonths,
  format
} from 'date-fns';

const WEEK_OPTIONS = { weekStartsOn: 1 };

export function logSeconds(log) {
  if (!log) return 0;
  if (log.status === 'completed' || (!log.is_active && log.total_seconds > 0)) {
    return Math.max(0, log.total_seconds || 0);
  }
  if (log.status === 'paused') {
    return Math.max(0, log.total_seconds || 0);
  }
  // running – compute live elapsed minus accumulated paused time
  if (log.start_time) {
    const elapsed = Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000);
    return Math.max(0, elapsed - (log.paused_duration || 0));
  }
  return Math.max(0, log.total_seconds || 0);
}

export function calcActualSeconds(logs) {
  return logs.reduce((sum, log) => sum + logSeconds(log), 0);
}

export function fmtHoursMins(seconds) {
  const secs = Math.max(0, seconds);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function getPeriodBounds(period, referenceDate = new Date()) {
  const now = referenceDate;
  if (period === 'day') {
    return { start: startOfDay(now), end: now };
  }
  if (period === 'week') {
    return { start: startOfWeek(now, WEEK_OPTIONS), end: now };
  }
  // month
  return { start: startOfMonth(now), end: now };
}

export function buildPeriodBuckets(period, count = 5) {
  const now = new Date();
  const buckets = [];

  if (period === 'day') {
    for (let i = count - 1; i >= 0; i--) {
      const d = subDays(now, i);
      const start = startOfDay(d);
      const end = i === 0 ? now : endOfDay(d);
      buckets.push({ label: format(d, 'EEE d'), start, end });
    }
  } else if (period === 'week') {
    for (let i = count - 1; i >= 0; i--) {
      const d = subWeeks(now, i);
      const start = startOfWeek(d, WEEK_OPTIONS);
      const end = i === 0 ? now : endOfWeek(d, WEEK_OPTIONS);
      buckets.push({ label: format(start, 'MMM d'), start, end });
    }
  } else {
    for (let i = count - 1; i >= 0; i--) {
      const d = subMonths(now, i);
      const start = startOfMonth(d);
      const end = i === 0 ? now : endOfMonth(d);
      buckets.push({ label: format(start, 'MMM yyyy'), start, end });
    }
  }

  return buckets;
}

export function utilizationStatus(percent) {
  if (percent > 120) return 'overutilized';
  if (percent < 80) return 'underutilized';
  return 'balanced';
}

export function buildEmployeeUtilization({
  user,
  empRole,
  utilRecord,
  userLogs,
  period,
}) {
  // Skip only if there is neither a role assignment nor any time logs
  if (!empRole && (!userLogs || userLogs.length === 0)) return null;

  const actualSeconds = calcActualSeconds(userLogs);
  const estimatedSeconds = utilRecord?.estimated_seconds || 0;

  const utilizationPercent = estimatedSeconds > 0
    ? Math.round((actualSeconds / estimatedSeconds) * 100)
    : 0;

  const status = utilizationStatus(utilizationPercent);

  // has_data: true only if there are real logs in this period
  const has_data = actualSeconds > 0;

  return {
    id: user.id,
    user_id: user.id,
    user_name: user.full_name || user.email,
    user_email: user.email,
    role: empRole?.role || utilRecord?.role || 'admin',
    team_id: empRole?.team_id || utilRecord?.team_id || null,
    team_name: empRole?.team_name || utilRecord?.team_name || null,
    period,
    estimated_seconds: estimatedSeconds,
    actual_seconds: actualSeconds,
    utilization_percent: utilizationPercent,
    status,
    project_ids: [...new Set(userLogs.map(l => l.project_id).filter(Boolean))],
    has_data,
  };
}