import { differenceInDays, differenceInHours, differenceInMinutes, format, parseISO, addDays, startOfDay, endOfDay } from "date-fns";

// Base44 stores timestamps without a Z suffix e.g. "2026-03-10T13:29:00"
// Browsers parse no-Z strings as LOCAL time, not UTC — causing an 11h shift in Sydney.
// This function forces the Z, making every timestamp parse correctly as UTC.
export function fixTimestamp(str) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= 10) return str; // date-only, leave alone
  if (str.endsWith('Z') || str.includes('+') || str.match(/[-+]\d{2}:\d{2}$/)) return str;
  return str + 'Z';
}

// ─── App timezone ─────────────────────────────────────────────────────────────
export const APP_TZ = 'Australia/Sydney';

// ─── CATEGORY A: Date-only strings ("2026-03-10") ─────────────────────────────
// parseISO treats "2026-03-10" as LOCAL midnight, not UTC midnight.
export function parseDate(dateStr) {
  if (!dateStr) return null;
  try { return parseISO(String(dateStr).substring(0, 10)); } catch { return null; }
}

// Format a date-only string for display. Safe — never shifts the day.
// e.g. fmtDate("2026-03-10", "d MMM yyyy") → "10 Mar 2026"
export function fmtDate(dateStr, pattern = 'd MMM yyyy') {
  const d = parseDate(dateStr);
  if (!d) return '—';
  try { return format(d, pattern); } catch { return '—'; }
}

// ─── CATEGORY B: Full UTC timestamps ──────────────────────────────────────────
// Full control timestamp formatter using Intl.DateTimeFormat in Sydney time.
// e.g. fmtTimestampCustom(ts, { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
export function fmtTimestampCustom(utcStr, options = {}) {
  if (!utcStr) return '—';
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone: APP_TZ, ...options })
      .format(new Date(fixTimestamp(utcStr)));
  } catch { return '—'; }
}

// Is a date-only string overdue relative to today in Sydney time?
export function isOverdue(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const todayStr = new Intl.DateTimeFormat('en-AU', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).split('/').reverse().join('-');
  const todayD = parseDate(todayStr);
  return d < todayD;
}

// Today's date string in Sydney time: "2026-03-10"
export function todaySydney() {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).split('/').reverse().join('-');
}

export function daysAgo(date) {
  return differenceInDays(new Date(), new Date(fixTimestamp(date)));
}

export function hoursAgo(date) {
  return differenceInHours(new Date(), new Date(fixTimestamp(date)));
}

export function minutesAgo(date) {
  return differenceInMinutes(new Date(), new Date(fixTimestamp(date)));
}

export function formatRelative(date) {
  const mins = minutesAgo(date);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  
  const hrs = hoursAgo(date);
  if (hrs < 24) return `${hrs}h ago`;
  
  const dys = daysAgo(date);
  if (dys < 7) return `${dys}d ago`;
  if (dys < 30) return `${Math.floor(dys / 7)}w ago`;
  if (dys < 365) return `${Math.floor(dys / 30)}mo ago`;
  
  return `${Math.floor(dys / 365)}y ago`;
}

export function getDateRange(type) {
  const today = new Date();
  const ranges = {
    today: { start: startOfDay(today), end: endOfDay(today) },
    yesterday: { start: startOfDay(addDays(today, -1)), end: endOfDay(addDays(today, -1)) },
    week: { start: startOfDay(addDays(today, -7)), end: endOfDay(today) },
    month: { start: startOfDay(addDays(today, -30)), end: endOfDay(today) },
  };
  return ranges[type];
}

export function isSameDay(date1, date2) {
  return format(new Date(fixTimestamp(date1)), "yyyy-MM-dd") === format(new Date(fixTimestamp(date2)), "yyyy-MM-dd");
}

export function isBefore(date1, date2) {
  return new Date(fixTimestamp(date1)) < new Date(fixTimestamp(date2));
}

export function isAfter(date1, date2) {
  return new Date(fixTimestamp(date1)) > new Date(fixTimestamp(date2));
}

export function isBetween(date, start, end) {
  const d = new Date(fixTimestamp(date));
  return d >= new Date(fixTimestamp(start)) && d <= new Date(fixTimestamp(end));
}

// ─── Calendar event timezone helpers ──────────────────────────────────────────
// Convert UTC timestamp to Sydney local time for HTML input (datetime-local)
export function utcToSydneyInput(utcStr) {
  if (!utcStr) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: APP_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(fixTimestamp(utcStr)));
    const get = t => parts.find(p => p.type === t)?.value ?? '00';
    const h = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}`;
  } catch {
    return '';
  }
}

// Convert Sydney local time (from HTML input) to UTC timestamp
function getLocalDateComponents(utcInstant, timezone) {
  const d = new Date(utcInstant);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value ?? '0';
  return {
    year: parseInt(get('year')),
    month0: parseInt(get('month')) - 1,
    day: parseInt(get('day')),
    hour: parseInt(get('hour')),
    minute: parseInt(get('minute')),
    second: parseInt(get('second'))
  };
}

function wallClockToUTC(year, month0, day, hours, minutes, seconds, timezone) {
  const targetLocalMs = Date.UTC(year, month0, day, hours, minutes, seconds);
  let utcMs = targetLocalMs;
  for (let i = 0; i < 5; i++) {
    const c = getLocalDateComponents(utcMs, timezone);
    const shown = Date.UTC(c.year, c.month0, c.day, c.hour, c.minute, c.second);
    const diff = shown - targetLocalMs;
    if (diff === 0) break;
    utcMs -= diff;
  }
  return new Date(utcMs);
}

export function sydneyInputToUtc(localStr) {
  if (!localStr) return null;
  try {
    const [datePart, timePart] = localStr.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes] = (timePart || '00:00').split(':').map(Number);
    return wallClockToUTC(year, month - 1, day, hours, minutes, 0, APP_TZ).toISOString();
  } catch {
    return null;
  }
}

// ─── Shared duration formatters ───────────────────────────────────────────────
export function formatDurationCompact(seconds) {
  if (!seconds || seconds < 0) return "—";
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.floor((seconds % 86400) / 3600);
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function formatDurationFull(seconds) {
  if (!seconds || seconds < 0) return "—";
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(seconds / 3600);
  const remMins = Math.floor((seconds % 3600) / 60);
  const remSecs = seconds % 60;
  if (hours < 24) return `${hours}h ${remMins}m ${remSecs}s`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.floor((seconds % 86400) / 3600);
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}