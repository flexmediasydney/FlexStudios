/**
 * retentionFormat.js — shared formatters + constants for the Retention tab.
 *
 * Kept small and side-effect-free. Pulled out of PulseRetention.jsx so the
 * main component stays focused on layout/state.
 */

// Each window is a half-open interval [from, to). `to` is startOfTomorrow
// (not `new Date()`) so today is fully included in aggregations. The Pulse
// retention + market-share RPCs cast `p_to AT TIME ZONE 'Australia/Sydney'::date`
// with an exclusive upper bound, so `to = now` would silently drop today's
// sold/shoot rows. Yesterday is [yesterday 00:00, today 00:00).
export const WINDOWS = [
  { value: "day",       label: "Today",        from: () => startOfDay(new Date()),     to: () => startOfTomorrow() },
  { value: "yesterday", label: "Yesterday",    from: () => startOfYesterday(),         to: () => startOfDay(new Date()) },
  { value: "week",      label: "This week",    from: () => startOfWeek(new Date()),    to: () => startOfTomorrow() },
  { value: "month",     label: "This month",   from: () => startOfMonth(new Date()),   to: () => startOfTomorrow() },
  { value: "quarter",   label: "This quarter", from: () => startOfQuarter(new Date()), to: () => startOfTomorrow() },
  { value: "ytd",       label: "YTD",          from: () => startOfYear(new Date()),    to: () => startOfTomorrow() },
  { value: "12m",       label: "12m rolling",  from: () => minusMonths(new Date(), 12),to: () => startOfTomorrow() },
];

export function startOfDay(d)     { const x = new Date(d); x.setHours(0,0,0,0); return x; }
export function startOfYesterday(){ const x = startOfDay(new Date()); x.setDate(x.getDate() - 1); return x; }
export function startOfTomorrow() { const x = startOfDay(new Date()); x.setDate(x.getDate() + 1); return x; }
export function startOfWeek(d)    { const x = startOfDay(d); const dow = x.getDay(); x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1)); return x; }
export function startOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth(), 1); }
export function startOfQuarter(d) { return new Date(d.getFullYear(), Math.floor(d.getMonth()/3)*3, 1); }
export function startOfYear(d)    { return new Date(d.getFullYear(), 0, 1); }
export function minusMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() - n); return x; }
export function minusWeeks(d, n)  { const x = new Date(d); x.setDate(x.getDate() - n*7); return x; }

export function fmtMoney(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)         return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function fmtInt(v) { return v == null ? "—" : Number(v).toLocaleString(); }
export function fmtPct(v) { return v == null ? "—" : `${Number(v).toFixed(1)}%`; }
export function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" }); }
  catch { return "—"; }
}
export function monthsSince(d) {
  if (!d) return null;
  try {
    const dt = new Date(d);
    const now = new Date();
    return (now.getFullYear() - dt.getFullYear()) * 12 + (now.getMonth() - dt.getMonth());
  } catch { return null; }
}

/**
 * Build a CSV string from a row array (header is taken from `columns`).
 * columns: [{ key, label, fmt? }]
 */
export function toCsv(rows, columns) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => escape(c.label)).join(",");
  const body = rows.map(r =>
    columns.map(c => escape(c.fmt ? c.fmt(r[c.key], r) : r[c.key])).join(",")
  ).join("\n");
  return `${header}\n${body}`;
}

export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
