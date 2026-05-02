/**
 * ObservationsPanel — shared right-panel renderer for source-attributed
 * observation rows (mig 441).
 *
 * Used by HierarchyADetail (observations[]) and HierarchyBDetail (samples[]).
 * Both RPCs return the same row shape post-mig 441:
 *
 *   {
 *     composition_classification_id, group_id, round_id, project_id,
 *     project_name, project_url, image_filename, image_dropbox_path,
 *     source_type, attribution_source, image_type, pulse_listing_id,
 *     pulse_listing_url, pulse_listing_address, classified_at
 *   }
 *
 * UI:
 *   [counter line]  47 observations across 12 properties (3 ours, 9 Pulse)
 *   [chip strip]    Raws (47) · Finals (12) · Pulse (1,247) · External (3)
 *   [scroll list]   per-row: Source badge · Project link · Pulse link ·
 *                   Image filename · classified_at (relative)
 *
 * Filter is client-side — the rows are already loaded (cap 50). Toggling
 * chips slices the array.
 */

import React, { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, Building, Globe } from "lucide-react";

// Source-type → visual style. Emerald = our raws, blue = our finals,
// purple = pulse, gray = external/floorplan.
const SOURCE_STYLES = {
  internal_raw: {
    label: "Raw",
    badge:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  },
  internal_finals: {
    label: "Finals",
    badge:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
  },
  pulse_listing: {
    label: "Pulse",
    badge:
      "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-900",
  },
  external_listing: {
    label: "External",
    badge:
      "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  },
  floorplan_image: {
    label: "Floorplan",
    badge:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  },
};

const FILTER_ORDER = [
  "internal_raw",
  "internal_finals",
  "pulse_listing",
  "external_listing",
  "floorplan_image",
];

const FILTER_CHIP_LABELS = {
  internal_raw: "Raws",
  internal_finals: "Finals",
  pulse_listing: "Pulse",
  external_listing: "External",
  floorplan_image: "Floorplan",
};

function bucketOf(row) {
  return row?.attribution_source || row?.source_type || "unknown";
}

export default function ObservationsPanel({
  rows,
  totalCount,
  emptyMessage = "No classifications reference this yet.",
  defaultLimit = 25,
  testId = "observations-panel",
}) {
  const list = Array.isArray(rows) ? rows : [];

  // Per-bucket counts across the full row set (NOT post-filter).
  const counts = useMemo(() => {
    const c = {};
    list.forEach((r) => {
      const k = bucketOf(r);
      c[k] = (c[k] || 0) + 1;
    });
    return c;
  }, [list]);

  // Property counts for the ours/pulse top line.
  const summary = useMemo(() => {
    const projectIds = new Set();
    const pulseIds = new Set();
    list.forEach((r) => {
      if (r.project_id) projectIds.add(r.project_id);
      if (r.pulse_listing_id) pulseIds.add(r.pulse_listing_id);
    });
    return {
      properties: projectIds.size + pulseIds.size,
      ours: projectIds.size,
      pulse: pulseIds.size,
    };
  }, [list]);

  // Multi-select chip filter (default: all selected).
  const [selected, setSelected] = useState(() => new Set(FILTER_ORDER));

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const filtered = useMemo(
    () => list.filter((r) => selected.has(bucketOf(r))),
    [list, selected],
  );

  const visible = filtered.slice(0, defaultLimit);
  const hiddenCount = filtered.length - visible.length;

  if (list.length === 0) {
    return (
      <div className="text-muted-foreground italic text-xs" data-testid={`${testId}-empty`}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-muted-foreground" data-testid={`${testId}-summary`}>
        <span>
          <span className="font-medium text-foreground">
            {totalCount ?? list.length}
          </span>{" "}
          observations across{" "}
          <span className="font-medium text-foreground">
            {summary.properties}
          </span>{" "}
          properties
        </span>
        {(summary.ours > 0 || summary.pulse > 0) && (
          <span>
            ({summary.ours} ours, {summary.pulse} Pulse)
          </span>
        )}
      </div>

      {/* Chip strip — client-side filter */}
      <div className="flex flex-wrap gap-1" data-testid={`${testId}-chips`}>
        {FILTER_ORDER.map((key) => {
          const n = counts[key] || 0;
          const isOn = selected.has(key);
          const label = FILTER_CHIP_LABELS[key] || key;
          // Hide chips with 0 count to keep the strip compact, unless the
          // user toggled it off (we still want to show that they can re-enable).
          if (n === 0) return null;
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              className={`text-[10px] px-1.5 py-0.5 rounded border font-mono transition-colors ${
                isOn
                  ? SOURCE_STYLES[key]?.badge ||
                    "bg-slate-100 text-slate-700 border-slate-300"
                  : "bg-transparent text-muted-foreground border-border line-through opacity-60"
              }`}
              data-testid={`${testId}-chip-${key}`}
              data-active={isOn ? "true" : "false"}
            >
              {label} ({n.toLocaleString()})
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted-foreground italic text-[11px] py-2" data-testid={`${testId}-filtered-empty`}>
          No rows match the active filter chips.
        </div>
      ) : (
        <ScrollArea className="h-56 pr-2">
          <div className="space-y-0.5">
            {visible.map((r) => (
              <ObservationRow key={`obs:${r.composition_classification_id}`} row={r} />
            ))}
            {hiddenCount > 0 && (
              <div className="text-[10px] text-muted-foreground italic pt-1 px-1">
                {hiddenCount} more rows available (showing top {defaultLimit}).
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ObservationRow({ row }) {
  const bucket = bucketOf(row);
  const style = SOURCE_STYLES[bucket] || SOURCE_STYLES.external_listing;
  const filename = row.image_filename || "—";

  return (
    <div
      className="grid grid-cols-12 gap-1 items-center text-[11px] border-b border-dashed border-border/50 py-0.5"
      data-testid={`obs-row-${row.composition_classification_id}`}
    >
      <div className="col-span-2">
        <Badge
          variant="outline"
          className={`text-[9px] px-1 py-0 font-mono ${style.badge}`}
        >
          {style.label}
        </Badge>
      </div>
      <div className="col-span-4 truncate flex items-center gap-1">
        {row.project_url ? (
          <a
            href={row.project_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5 truncate"
            title={row.project_name || row.project_id || ""}
            onClick={(e) => e.stopPropagation()}
            data-testid="obs-row-project-link"
          >
            <Building className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">
              {row.project_name || (row.project_id || "").slice(0, 8)}
            </span>
          </a>
        ) : row.pulse_listing_url ? (
          <a
            href={row.pulse_listing_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-600 dark:text-purple-400 hover:underline inline-flex items-center gap-0.5 truncate"
            title={row.pulse_listing_address || row.pulse_listing_id || ""}
            onClick={(e) => e.stopPropagation()}
            data-testid="obs-row-pulse-link"
          >
            <Globe className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">
              {row.pulse_listing_address ||
                (row.pulse_listing_id || "").slice(0, 8)}
            </span>
          </a>
        ) : (
          <span className="text-muted-foreground italic">—</span>
        )}
      </div>
      <div className="col-span-4 truncate font-mono text-muted-foreground" title={filename}>
        {filename}
      </div>
      <div className="col-span-2 text-right text-[10px] text-muted-foreground">
        {fmtRelative(row.classified_at)}
      </div>
    </div>
  );
}

// Lightweight relative time — no external dep.
export function fmtRelative(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    const now = Date.now();
    const diffSec = Math.round((now - d.getTime()) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay === 1) return "Yesterday";
    if (diffDay < 7) return `${diffDay}d ago`;
    const diffWeek = Math.round(diffDay / 7);
    if (diffWeek < 5) return `${diffWeek}w ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return String(v);
  }
}
