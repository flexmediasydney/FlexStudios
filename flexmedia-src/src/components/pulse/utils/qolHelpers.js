/**
 * Shared QoL helpers for Industry Pulse tabs.
 *
 * Contains:
 *   - exportFilteredCsv  → UTF-8 BOM CSV download for arbitrary visible-rows
 *                          export (#52).
 *   - filterPresets.*    → localStorage-backed per-tab filter preset store
 *                          for "Save preset" / "Presets ▾" (#51).
 *   - buildIcs           → RFC-5545-ish .ics blob builder for Events (#53).
 */

// ── CSV export (#52) ─────────────────────────────────────────────────────────
//
// Accepts an array of header strings OR an array of { key, label } objects.
// `rows` may contain arbitrary values; everything is coerced to string.
// Writes a UTF-8 BOM prefix so Excel opens it in the correct codepage.

export function exportFilteredCsv(filename, headers, rows) {
  const cols = headers.map((h) =>
    typeof h === "string" ? { key: h, label: h } : h
  );

  const esc = (v) => {
    if (v == null) return "";
    let s;
    if (typeof v === "object") {
      // Arrays → pipe-joined scalars; objects → JSON (last-resort)
      s = Array.isArray(v) ? v.join(" | ") : JSON.stringify(v);
    } else {
      s = String(v);
    }
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [cols.map((c) => esc(c.label)).join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(r[c.key])).join(","));
  }

  // UTF-8 BOM prefix — required so Excel opens non-ASCII (AU suburb names,
  // accented agent names, en-dashes) without mojibake.
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Filter presets (#51) ─────────────────────────────────────────────────────
//
// One localStorage key per tab ("pulse_presets_events", etc.) → JSON map of
// { [userName]: payload }. Payload shape is caller-defined; this module
// doesn't care what's in it.

const PRESET_PREFIX = "pulse_presets_";

function presetKey(namespace) {
  return `${PRESET_PREFIX}${namespace}`;
}

export const filterPresets = {
  list(namespace) {
    try {
      const raw = localStorage.getItem(presetKey(namespace));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  },

  save(namespace, name, payload) {
    if (!name || !name.trim()) return false;
    try {
      const all = filterPresets.list(namespace);
      all[name.trim()] = payload;
      localStorage.setItem(presetKey(namespace), JSON.stringify(all));
      return true;
    } catch {
      return false;
    }
  },

  load(namespace, name) {
    const all = filterPresets.list(namespace);
    return Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null;
  },

  delete(namespace, name) {
    try {
      const all = filterPresets.list(namespace);
      if (!Object.prototype.hasOwnProperty.call(all, name)) return false;
      delete all[name];
      localStorage.setItem(presetKey(namespace), JSON.stringify(all));
      return true;
    } catch {
      return false;
    }
  },
};

// ── .ics builder (#53) ──────────────────────────────────────────────────────
//
// Minimal RFC-5545 VCALENDAR envelope with one VEVENT. `date` may be any
// parseable date string or Date; if falsy we emit a 1-hour all-day event
// starting at `new Date()`.
//
// Returns an object URL the caller can use to trigger the download.

function toIcsDate(d) {
  // ICS format: YYYYMMDDTHHMMSSZ (UTC)
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function escapeIcsText(v) {
  if (v == null) return "";
  // Per RFC-5545: escape backslash, semicolon, comma, newline
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function buildIcs({ id, title, date, venue, location, description, durationMs = 60 * 60 * 1000 }) {
  const start = date ? new Date(date) : new Date();
  const validStart = !isNaN(start.getTime()) ? start : new Date();
  const end = new Date(validStart.getTime() + durationMs);
  const stamp = toIcsDate(new Date());
  const uid = `${id || Math.random().toString(36).slice(2)}@flexmedia`;

  const loc = [venue, location].filter(Boolean).join(", ");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FlexMedia//IndustryPulse//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toIcsDate(validStart)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escapeIcsText(title || "Event")}`,
    loc ? `LOCATION:${escapeIcsText(loc)}` : null,
    description ? `DESCRIPTION:${escapeIcsText(description)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.join("\r\n");
}

export function downloadIcs(event) {
  const text = buildIcs(event);
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Filename: safe slug of title, short fallback to id
  const slug =
    (event.title || "event")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "event";
  a.download = `${slug}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
