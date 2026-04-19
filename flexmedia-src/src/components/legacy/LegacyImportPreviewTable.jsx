/**
 * LegacyImportPreviewTable.jsx
 *
 * Renders the first 50 rows of the mapped dataset with per-row validation.
 *
 * Validation tiers:
 *   - error   (red)    : missing required raw_address, unparseable JSON products
 *   - warning (amber)  : date cannot be parsed with chosen format, price non-numeric,
 *                        malformed email/phone
 *   - ok      (green)  : all mapped fields look valid
 *
 * Exposes validateRows() so parent can pre-compute summary stats.
 *
 * Props:
 *   rows          : object[]     (parsed raw rows, unmapped)
 *   mapping       : MappingState (fields + dateFormat)
 *   maxRows       : number       (default 50)
 */

import React, { useMemo } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, XCircle, Info } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

const PREVIEW_COLS = [
  "raw_address", "project_name", "completed_date", "package_name_legacy",
  "price", "currency", "agent_name", "agency_name", "client_name",
  "client_email", "client_phone", "external_id",
];

// ── Validators ──────────────────────────────────────────────────────────────

function parseDateWithFormat(value, fmt) {
  if (value == null || value === "") return { ok: true, value: null };
  const s = String(value).trim();
  if (!s) return { ok: true, value: null };

  if (fmt === "ISO") {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: "Could not auto-parse date" };
    return { ok: true, value: d.toISOString().slice(0, 10) };
  }

  // Explicit format — parse manually so we don't rely on Date.parse() ambiguities
  const re = {
    "YYYY-MM-DD": /^(\d{4})-(\d{1,2})-(\d{1,2})/,
    "DD/MM/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    "MM/DD/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    "DD-MM-YYYY": /^(\d{1,2})-(\d{1,2})-(\d{4})/,
  }[fmt];
  if (!re) return { ok: false, reason: `Unknown format ${fmt}` };
  const m = s.match(re);
  if (!m) return { ok: false, reason: `Does not match ${fmt}` };

  let y, mo, d;
  if (fmt === "YYYY-MM-DD") { [, y, mo, d] = m; }
  else if (fmt === "MM/DD/YYYY") { [, mo, d, y] = m; }
  else { [, d, mo, y] = m; }

  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return { ok: false, reason: `Invalid date` };
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { ok: true, value: iso };
}

function parsePrice(value) {
  if (value == null || value === "") return { ok: true, value: null };
  const s = String(value).replace(/[^0-9.\-]/g, "");
  if (!s) return { ok: false, reason: "Not numeric after currency strip" };
  const n = Number(s);
  if (Number.isNaN(n)) return { ok: false, reason: "Could not parse number" };
  return { ok: true, value: n };
}

function looksLikeEmail(v) {
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
}

function looksLikePhone(v) {
  if (!v) return true;
  // Permissive: allow +, digits, spaces, dashes, parens. Need at least 6 digits.
  const digits = String(v).replace(/\D/g, "");
  return digits.length >= 6;
}

/**
 * Map one raw row against the mapping spec. Returns:
 *   { mapped: {...}, status: "ok"|"warning"|"error", issues: [ {field, reason, severity} ] }
 */
export function validateRow(rawRow, mapping) {
  const fields = mapping?.fields || {};
  const dateFormat = mapping?.dateFormat || "YYYY-MM-DD";
  const issues = [];
  const mapped = {};

  for (const tgt of PREVIEW_COLS) {
    const srcCol = fields[tgt];
    mapped[tgt] = srcCol ? rawRow[srcCol] : null;
  }

  // Required: raw_address
  const rawAddr = mapped.raw_address;
  if (!rawAddr || String(rawAddr).trim() === "") {
    issues.push({ field: "raw_address", reason: "Missing — required", severity: "error" });
  }

  // Date
  if (mapped.completed_date) {
    const r = parseDateWithFormat(mapped.completed_date, dateFormat);
    if (!r.ok) {
      issues.push({ field: "completed_date", reason: r.reason, severity: "warning" });
    } else {
      mapped.completed_date = r.value;
    }
  }

  // Price
  if (mapped.price != null && mapped.price !== "") {
    const r = parsePrice(mapped.price);
    if (!r.ok) {
      issues.push({ field: "price", reason: r.reason, severity: "warning" });
    } else {
      mapped.price = r.value;
    }
  }

  // Email / phone sanity
  if (mapped.client_email && !looksLikeEmail(mapped.client_email)) {
    issues.push({ field: "client_email", reason: "Doesn't look like an email", severity: "warning" });
  }
  if (mapped.client_phone && !looksLikePhone(mapped.client_phone)) {
    issues.push({ field: "client_phone", reason: "Fewer than 6 digits", severity: "warning" });
  }

  // Products JSON
  if (fields.products_legacy) {
    const rawVal = rawRow[fields.products_legacy];
    if (rawVal && typeof rawVal === "string") {
      const trimmed = rawVal.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try { JSON.parse(trimmed); mapped.products_legacy = trimmed; }
        catch { issues.push({ field: "products_legacy", reason: "Malformed JSON", severity: "warning" }); }
      } else {
        // Treat as comma/semicolon list
        mapped.products_legacy = trimmed;
      }
    }
  }

  const hasError = issues.some(i => i.severity === "error");
  const hasWarn = issues.some(i => i.severity === "warning");
  const status = hasError ? "error" : hasWarn ? "warning" : "ok";

  return { mapped, status, issues };
}

export function validateRows(rows, mapping) {
  return rows.map(r => validateRow(r, mapping));
}

export function summariseValidation(results) {
  const valid = results.filter(r => r.status === "ok").length;
  const warnings = results.filter(r => r.status === "warning").length;
  const errors = results.filter(r => r.status === "error").length;
  // "geocodeable" = has a raw_address and is not error-level
  const geocodeable = results.filter(
    r => r.status !== "error" && r.mapped.raw_address && String(r.mapped.raw_address).trim()
  ).length;
  return { valid, warnings, errors, geocodeable, total: results.length };
}

// ── Row status pill ─────────────────────────────────────────────────────────

function StatusPill({ status }) {
  if (status === "ok") {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        OK
      </Badge>
    );
  }
  if (status === "warning") {
    return (
      <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300">
        <AlertTriangle className="h-3 w-3 mr-1" />
        Warning
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <XCircle className="h-3 w-3 mr-1" />
      Error
    </Badge>
  );
}

function fmt(v) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s === "") return <span className="text-muted-foreground">—</span>;
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}

export default function LegacyImportPreviewTable({ rows, mapping, maxRows = 50 }) {
  const validated = useMemo(
    () => validateRows(rows.slice(0, maxRows), mapping),
    [rows, mapping, maxRows]
  );
  const summary = useMemo(() => summariseValidation(validated), [validated]);

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded border bg-card p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Valid</div>
          <div className="text-xl font-semibold text-emerald-600">{summary.valid}</div>
        </div>
        <div className="rounded border bg-card p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Warnings</div>
          <div className="text-xl font-semibold text-amber-600">{summary.warnings}</div>
        </div>
        <div className="rounded border bg-card p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Errors</div>
          <div className="text-xl font-semibold text-red-600">{summary.errors}</div>
        </div>
        <div className="rounded border bg-card p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Geocodeable</div>
          <div className="text-xl font-semibold text-blue-600">{summary.geocodeable}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5" />
        Showing first {validated.length} rows. Validation is indicative — the edge
        function re-validates on the server before insert.
      </div>

      <div className="rounded border bg-card overflow-hidden">
        <ScrollArea className="max-h-[520px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-12">#</TableHead>
                {PREVIEW_COLS.map((c) => (
                  <TableHead key={c} className="text-xs whitespace-nowrap">{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {validated.map((v, idx) => (
                <React.Fragment key={idx}>
                  <TableRow className={
                    v.status === "error" ? "bg-red-50/50 dark:bg-red-950/20"
                    : v.status === "warning" ? "bg-amber-50/50 dark:bg-amber-950/20"
                    : ""
                  }>
                    <TableCell><StatusPill status={v.status} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{idx + 1}</TableCell>
                    {PREVIEW_COLS.map((c) => (
                      <TableCell key={c} className="text-xs whitespace-nowrap">
                        {fmt(v.mapped[c])}
                      </TableCell>
                    ))}
                  </TableRow>
                  {v.issues.length > 0 && (
                    <TableRow className={
                      v.status === "error" ? "bg-red-50/30 dark:bg-red-950/10"
                      : "bg-amber-50/30 dark:bg-amber-950/10"
                    }>
                      <TableCell colSpan={PREVIEW_COLS.length + 2} className="py-1.5">
                        <div className="flex flex-wrap gap-1.5 pl-2">
                          {v.issues.map((i, k) => (
                            <span
                              key={k}
                              className={`text-[11px] rounded px-1.5 py-0.5 ${
                                i.severity === "error"
                                  ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                                  : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                              }`}
                            >
                              <strong>{i.field}:</strong> {i.reason}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
              {validated.length === 0 && (
                <TableRow>
                  <TableCell colSpan={PREVIEW_COLS.length + 2} className="text-center text-muted-foreground py-6 text-sm">
                    No rows to preview.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>
    </div>
  );
}
