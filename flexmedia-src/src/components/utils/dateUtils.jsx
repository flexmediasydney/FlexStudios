import { differenceInDays, differenceInHours, differenceInMinutes, format, parseISO, addDays, startOfDay, endOfDay } from "date-fns";

// Base44 stores timestamps without a Z suffix e.g. "2026-03-10T13:29:00"
// Browsers parse no-Z strings as LOCAL time, not UTC — causing an 11h shift in Sydney.
// This function forces the Z, making every timestamp parse correctly as UTC.
export function fixTimestamp(str) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= 10) return str; // date-only, leave alone
  // BUG FIX: also match compact offset formats like -0800 (no colon), not just -08:00
  if (str.endsWith('Z') || str.includes('+') || str.match(/[-+]\d{2}:?\d{2}$/)) return str;
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

// BUG FIX: daysAgo was comparing raw Date objects — which works for elapsed-time
// calculations (hours/minutes), but differenceInDays uses calendar-day boundaries
// in the *local* machine timezone, not Sydney. On a UTC server at 23:00 UTC
// (= 10:00 AEST next day), a timestamp from "today in Sydney" would show as "0d ago"
// when it should show "1d ago". Now we compare Sydney date strings for day-level diffs.
export function daysAgo(date) {
  if (!date) return 0;
  const todayStr = todaySydney();
  const targetStr = fmtTimestampCustom(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (!targetStr || targetStr === '—') return 0;
  // targetStr is "DD/MM/YYYY" in en-AU format — convert to YYYY-MM-DD
  const targetISO = targetStr.split('/').reverse().join('-');
  const todayD = parseDate(todayStr);
  const targetD = parseDate(targetISO);
  if (!todayD || !targetD) return 0;
  return differenceInDays(todayD, targetD);
}

export function hoursAgo(date) {
  if (!date) return 0;
  return differenceInHours(new Date(), new Date(fixTimestamp(date)));
}

export function minutesAgo(date) {
  if (!date) return 0;
  return differenceInMinutes(new Date(), new Date(fixTimestamp(date)));
}

export function formatRelative(date) {
  // BUG FIX: null/undefined date caused fixTimestamp(null) → null → new Date(null) = epoch → wrong "Xd ago"
  if (!date) return "—";
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

// BUG FIX: was using new Date() which gives local machine's "today", not Sydney's "today".
// On a Vercel edge or any non-AEST server, "today" could be yesterday/tomorrow in Sydney.
// Now we derive "today" from todaySydney() and build ranges from that date-only string.
export function getDateRange(type) {
  const sydneyToday = parseDate(todaySydney()); // midnight local-parse of Sydney date
  if (!sydneyToday) return undefined;
  const ranges = {
    today: { start: startOfDay(sydneyToday), end: endOfDay(sydneyToday) },
    yesterday: { start: startOfDay(addDays(sydneyToday, -1)), end: endOfDay(addDays(sydneyToday, -1)) },
    week: { start: startOfDay(addDays(sydneyToday, -7)), end: endOfDay(sydneyToday) },
    month: { start: startOfDay(addDays(sydneyToday, -30)), end: endOfDay(sydneyToday) },
  };
  return ranges[type];
}

export function isSameDay(date1, date2) {
  // BUG FIX: used format() in LOCAL machine timezone instead of Sydney timezone.
  // Two timestamps straddling midnight in Sydney would compare as same-day when they aren't.
  if (!date1 || !date2) return false;
  const toSydneyDay = (d) => new Intl.DateTimeFormat('en-AU', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(fixTimestamp(d)));
  return toSydneyDay(date1) === toSydneyDay(date2);
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

// ─── Sydney-aware time extraction ─────────────────────────────────────────────
// Returns { hour, minute } in Sydney time for a UTC timestamp string.
// Used by Calendar views to position events on the hour grid correctly.
export function getSydneyHourMinute(utcStr) {
  if (!utcStr) return { hour: 0, minute: 0 };
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: APP_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(fixTimestamp(utcStr)));
    const get = (t) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
    const h = get('hour');
    return { hour: h === 24 ? 0 : h, minute: get('minute') };
  } catch {
    return { hour: 0, minute: 0 };
  }
}

// Format a UTC timestamp in Sydney time using date-fns-compatible pattern shorthand.
// Convenience wrapper around fmtTimestampCustom for common time-only displays.
export function fmtSydneyTime(utcStr, options = { hour: 'numeric', minute: '2-digit', hour12: true }) {
  return fmtTimestampCustom(utcStr, options);
}

// ─── Shared duration formatters ───────────────────────────────────────────────
export function formatDurationCompact(seconds) {
  // BUG FIX: !seconds treated 0 as falsy — 0 seconds is a valid duration
  if (seconds == null || isNaN(seconds) || seconds < 0) return "—";
  if (seconds === 0) return "0s";
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
  // BUG FIX: !seconds treated 0 as falsy — 0 seconds is a valid duration
  if (seconds == null || isNaN(seconds) || seconds < 0) return "—";
  if (seconds === 0) return "0s";
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