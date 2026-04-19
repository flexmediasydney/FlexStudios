/**
 * FieldSourceChip.jsx — tiny color-coded provenance badge for SAFR.
 *
 * Used inside FieldWithSource and anywhere else that needs to show where a
 * field value came from (Data Consistency page, Intelligence panels, etc.).
 *
 * Props:
 *   source       — required string key from SOURCE_COLORS (unknown keys render grey)
 *   observed_at  — optional ISO timestamp; tooltip shows "last seen N ago"
 *   confidence   — optional 0..1 score; shown in tooltip as percentage
 *   size         — "xs" | "sm" | "md" (default "sm")
 *   label        — optional override for the visible chip label
 *   className    — tailwind passthrough
 */
import React from "react";
import { formatDistanceToNow } from "date-fns";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const SOURCE_COLORS = {
  manual:             { bg: "bg-emerald-100", text: "text-emerald-800", border: "border-emerald-200", label: "Manual",       darkBg: "dark:bg-emerald-950/40", darkText: "dark:text-emerald-300" },
  rea_scrape:         { bg: "bg-blue-100",    text: "text-blue-800",    border: "border-blue-200",    label: "REA scrape",   darkBg: "dark:bg-blue-950/40",    darkText: "dark:text-blue-300" },
  rea_listing_detail: { bg: "bg-indigo-100",  text: "text-indigo-800",  border: "border-indigo-200",  label: "REA listing",  darkBg: "dark:bg-indigo-950/40",  darkText: "dark:text-indigo-300" },
  email_sync:         { bg: "bg-amber-100",   text: "text-amber-800",   border: "border-amber-200",   label: "Email sync",   darkBg: "dark:bg-amber-950/40",   darkText: "dark:text-amber-300" },
  domain_scrape:      { bg: "bg-violet-100",  text: "text-violet-800",  border: "border-violet-200",  label: "Domain scrape",darkBg: "dark:bg-violet-950/40",  darkText: "dark:text-violet-300" },
  import_csv:         { bg: "bg-slate-100",   text: "text-slate-800",   border: "border-slate-200",   label: "CSV import",   darkBg: "dark:bg-slate-800/60",   darkText: "dark:text-slate-300" },
  enrichment_clearbit:{ bg: "bg-cyan-100",    text: "text-cyan-800",    border: "border-cyan-200",    label: "Clearbit",     darkBg: "dark:bg-cyan-950/40",    darkText: "dark:text-cyan-300" },
  tonomo_webhook:     { bg: "bg-pink-100",    text: "text-pink-800",    border: "border-pink-200",    label: "Tonomo",       darkBg: "dark:bg-pink-950/40",    darkText: "dark:text-pink-300" },
  legacy:             { bg: "bg-neutral-100", text: "text-neutral-700", border: "border-neutral-200", label: "Legacy",       darkBg: "dark:bg-neutral-800/60", darkText: "dark:text-neutral-300" },
  unknown:            { bg: "bg-slate-100",   text: "text-slate-700",   border: "border-slate-200",   label: "Unknown",      darkBg: "dark:bg-slate-800/60",   darkText: "dark:text-slate-300" },
};

const SIZE_CLASSES = {
  xs: "text-[10px] px-1.5 py-0 h-4 leading-none",
  sm: "text-[11px] px-2 py-0.5 h-5 leading-none",
  md: "text-xs px-2.5 py-1 h-6 leading-none",
};

function formatRel(iso) {
  if (!iso) return null;
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return null;
  }
}

export default function FieldSourceChip({
  source,
  observed_at,
  confidence,
  size = "sm",
  label: labelOverride,
  className = "",
}) {
  const cfg = SOURCE_COLORS[source] || SOURCE_COLORS.unknown;
  const displayLabel = labelOverride || cfg.label || source;
  const rel = formatRel(observed_at);
  const confidencePct = typeof confidence === "number"
    ? Math.max(0, Math.min(100, Math.round(confidence * 100)))
    : null;

  const chip = (
    <span
      className={cn(
        "inline-flex items-center rounded-md border font-medium whitespace-nowrap",
        cfg.bg, cfg.text, cfg.border, cfg.darkBg, cfg.darkText,
        SIZE_CLASSES[size] || SIZE_CLASSES.sm,
        className,
      )}
      data-slot="field-source-chip"
      data-source={source}
    >
      <span aria-hidden className="mr-1 opacity-70">&#x25CE;</span>
      <span className="truncate max-w-[120px]">{displayLabel}</span>
    </span>
  );

  if (!rel && confidencePct == null) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="font-semibold">{displayLabel}</div>
          {rel && (
            <div className="text-muted-foreground">
              last seen {rel}
            </div>
          )}
          {confidencePct != null && (
            <div className="text-muted-foreground">
              confidence {confidencePct}%
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
