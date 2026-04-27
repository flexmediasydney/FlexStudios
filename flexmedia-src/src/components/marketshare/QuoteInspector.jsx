/**
 * QuoteInspector — step-by-step reasoning for a single listing's missed-
 * opportunity quote, rendered like an invoice/receipt. Think of it as the
 * "show your work" panel for the Market Share engine.
 *
 * Data: single RPC `pulse_get_listing_quote_detail(p_listing_id)` (migration
 * 164, parallel agent). Returns a jsonb with keys:
 *   listing, classification, tier_resolution, pricing, quality_flags,
 *   provenance.
 *
 * Props:
 *   listingId      — uuid of the pulse_listings row
 *   compact?       — if true, renders only Cards 1, 2, 4 (skips what-if /
 *                    provenance / flags). Used in slideouts.
 *   onOpenEntity?  — ({ type, id }) => void — used to drill into agency /
 *                    agent / project / matrix when links in the receipt are
 *                    clicked.
 *
 * Card layout:
 *   1  Evidence          — media summary, asking price, source link
 *   2  Classification    — decision-tree evaluation[] with fired/reason
 *   3  Tier resolution   — which cascade step set the tier
 *   4  Pricing receipt   — line-item money breakdown, total row
 *   5  Quality flags     — amber warning chips (rendered only if any true)
 *   6  What-if           — interactive slider + toggles + live recompute
 *   7  Provenance        — computed_at + engine_version + raw cascade JSON
 *
 * Style: matches PulseMarketShare.jsx patterns — shadcn Card + Badge,
 * lucide-react icons, tabular-nums for numeric columns, emerald/amber/red
 * per status. See the parent migration 159 for ground-truth classifier +
 * pricing defaults that the what-if simulator mirrors client-side.
 */
import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import {
  Camera, FileImage, Video, Plane, CheckCircle2, XCircle,
  AlertTriangle, ExternalLink, Info, ChevronDown, ChevronRight,
  Receipt, Layers, Beaker, Sparkles, Building2, MapPin, Home,
  Clock, ArrowRight, Cpu, Award,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useActivePackages } from "@/hooks/useActivePackages";

// ── Formatters ───────────────────────────────────────────────────────────

function fmtMoney(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${Math.round(n).toLocaleString()}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtMoneyExact(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function fmtPct(v) {
  if (v == null) return "—";
  return `${Number(v).toFixed(1)}%`;
}

function fmtRelative(d) {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  if (!isFinite(ms)) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-AU", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return "—"; }
}

// ── Classifier + default pricing (client-side mirror of migration 159) ───
// Used only by the What-if card to let the user play with inputs without a
// round-trip. Canonical authority lives in the SQL — keep these in sync.
//
// Wave 7 P1-11.b: the `fallbackName` fields are LAST-RESORT only. Display
// names come from the live `packages` table via useActivePackages() inside
// WhatIfCard, matched by the substring contained in the rule key. Per
// Joseph's architectural correction (2026-04-27): packages must NEVER be
// hardcoded as the authoritative source of names in the frontend.

const PACKAGE_DEFAULTS = {
  // [fallbackName, stdPrice, prmPrice, baseQty (photos included)]
  flex:    { fallbackName: "Flex Package",       std: 1650, prm: 2200, qty: 40 },
  dusk:    { fallbackName: "Dusk Video Package", std: 1320, prm: 1750, qty: 30 },
  day:     { fallbackName: "Day Video Package",  std:  990, prm: 1320, qty: 20 },
  gold:    { fallbackName: "Gold Package",       std:  660, prm:  880, qty: 15 },
  silver:  { fallbackName: "Silver Package",     std:  440, prm:  550, qty: 10 },
};

// Sales image overflow: above base qty you pay per extra photo
const OVERFLOW_UNIT = { standard: 25, premium: 50 };

function classifyLocal({ photos, floorplan, video, askingPrice }) {
  if (photos >= 30 && floorplan && video && (askingPrice || 0) > 8_000_000) return "flex";
  if (photos >= 26 && floorplan && video) return "dusk";
  if (photos >= 1 && floorplan && video) return "day";
  if (photos > 10 && floorplan) return "gold";
  if (photos <= 10 && floorplan) return "silver";
  return null;
}

function priceLocal({ pkgKey, tier, photos }) {
  if (!pkgKey) return { total: 0, base: 0, overflow: 0, overflowPhotos: 0 };
  const def = PACKAGE_DEFAULTS[pkgKey];
  const base = tier === "premium" ? def.prm : def.std;
  const overflowPhotos = Math.max(0, photos - def.qty);
  const unit = OVERFLOW_UNIT[tier] || OVERFLOW_UNIT.standard;
  const overflow = overflowPhotos * unit;
  return { total: base + overflow, base, overflow, overflowPhotos };
}

// ── Root component ───────────────────────────────────────────────────────

export default function QuoteInspector({ listingId, compact = false, onOpenEntity }) {
  const { data: detail, isLoading, error } = useQuery({
    queryKey: ["pulse_listing_quote_detail", listingId],
    queryFn: async () => {
      if (!listingId) return null;
      const { data, error: rpcErr } = await api._supabase.rpc(
        "pulse_get_listing_quote_detail",
        { p_listing_id: listingId }
      );
      if (rpcErr) throw rpcErr;
      return data || null;
    },
    enabled: !!listingId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (!listingId) {
    return (
      <Card className="p-6 text-center text-xs text-muted-foreground">
        No listing selected.
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Cpu className="h-3.5 w-3.5 animate-pulse" />
          Computing quote inspector…
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900/40">
        <div className="flex items-start gap-2 text-xs">
          <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-medium text-red-800 dark:text-red-300">
              Quote inspector unavailable
            </p>
            <p className="text-red-700/80 dark:text-red-400/80 mt-0.5 break-words">
              {String(error?.message || error)}
            </p>
            <p className="text-[10px] text-red-700/60 dark:text-red-400/60 mt-1">
              RPC: pulse_get_listing_quote_detail · migration 164 pending?
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card className="p-6 text-center text-xs text-muted-foreground">
        No quote data for this listing.
      </Card>
    );
  }

  const listing = detail.listing || {};
  const classification = detail.classification || {};
  const tierResolution = detail.tier_resolution || {};
  const pricing = detail.pricing || {};
  const qualityFlags = detail.quality_flags || {};
  const provenance = detail.provenance || {};

  return (
    <div className="space-y-3">
      <EvidenceCard listing={listing} />
      <ClassificationCard classification={classification} />
      {!compact && (
        <TierResolutionCard
          tierResolution={tierResolution}
          onOpenEntity={onOpenEntity}
        />
      )}
      <PricingReceiptCard pricing={pricing} onOpenEntity={onOpenEntity} />
      {!compact && <QualityFlagsCard flags={qualityFlags} />}
      {!compact && (
        <WhatIfCard
          listing={listing}
          classification={classification}
          tierResolution={tierResolution}
          actualPricing={pricing}
        />
      )}
      {!compact && <ProvenanceFooter provenance={provenance} />}
    </div>
  );
}

// ── Card 1 — Evidence ────────────────────────────────────────────────────

function EvidenceCard({ listing }) {
  const {
    address, suburb, source_url, photo_count, has_floorplan, has_video,
    asking_price_numeric, price_text, detail_enriched_at,
  } = listing;
  const hasDrone = !!has_video; // inferred per migration 159
  const priceLabel = asking_price_numeric
    ? fmtMoney(asking_price_numeric)
    : (price_text
        ? `Contact Agent — ${price_text}`
        : "Contact Agent — price unknown");

  return (
    <Card className="p-4 border-blue-200/60 dark:border-blue-900/40">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-blue-100 dark:bg-blue-950/40 flex items-center justify-center">
          <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Evidence</h3>
          <p className="text-[10px] text-muted-foreground">
            What the engine saw when it quoted this listing
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr,auto] gap-4">
        <div className="space-y-2 min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Home className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="truncate">{address || "Address unavailable"}</span>
          </div>
          {suburb && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {suburb}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <MediaStat
              icon={Camera}
              label="photos"
              value={photo_count ?? 0}
              present={(photo_count ?? 0) > 0}
            />
            <MediaStat
              icon={FileImage}
              label="floorplan"
              value={has_floorplan ? "✓" : "✗"}
              present={!!has_floorplan}
            />
            <MediaStat
              icon={Video}
              label="video"
              value={has_video ? "✓" : "✗"}
              present={!!has_video}
            />
            <MediaStat
              icon={Plane}
              label="drone"
              value={hasDrone ? "✓ (inferred)" : "✗"}
              present={hasDrone}
              muted={!has_video}
            />
          </div>
        </div>

        <div className="flex md:flex-col md:items-end justify-between md:justify-start gap-1 border-t md:border-t-0 md:border-l md:pl-4 pt-3 md:pt-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Asking price
          </span>
          <span className="text-lg font-bold tabular-nums">{priceLabel}</span>
          {price_text && asking_price_numeric && (
            <span className="text-[10px] text-muted-foreground truncate max-w-[160px]" title={price_text}>
              {price_text}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t text-[11px] text-muted-foreground">
        {detail_enriched_at && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Enriched {fmtRelative(detail_enriched_at)}
          </span>
        )}
        {source_url && (
          <a
            href={source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            Source listing
          </a>
        )}
      </div>
    </Card>
  );
}

function MediaStat({ icon: Icon, label, value, present, muted }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-xs rounded-md border px-2 py-1",
        present
          ? "bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/20 dark:border-emerald-900/40 dark:text-emerald-300"
          : "bg-muted/40 border-border text-muted-foreground",
        muted && "opacity-60"
      )}
    >
      <Icon className="h-3 w-3" />
      <span className="tabular-nums font-medium">{value}</span>
      <span className="text-[10px] opacity-80">{label}</span>
    </div>
  );
}

// ── Card 2 — Classification decision tree ────────────────────────────────

function ClassificationCard({ classification }) {
  const { resolved_package_id, resolved_package_name, evaluation } = classification;
  const rules = Array.isArray(evaluation) ? evaluation : [];

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-indigo-100 dark:bg-indigo-950/40 flex items-center justify-center">
          <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Classification decision tree</h3>
          <p className="text-[10px] text-muted-foreground">
            Rules evaluated top-down. First match wins.
          </p>
        </div>
        <div className="ml-auto">
          {resolved_package_name ? (
            <Badge className="bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900/40 text-[10px] font-semibold">
              {resolved_package_name}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              UNCLASSIFIABLE
            </Badge>
          )}
        </div>
      </div>

      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">
          No evaluation trace available.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, i) => (
            <RuleNode key={i} rule={rule} isFirst={i === 0} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RuleNode({ rule }) {
  const fired = !!rule.fired;
  const thresholds = rule.thresholds || {};
  const actual = rule.actual || {};
  // Build criterion rows from thresholds + actual. Labels are inferred from
  // the threshold key (photos/fp/video/asking). Missing actual → dash.
  const criteria = Object.keys(thresholds).map((k) => ({
    key: k,
    label: humanCriterionLabel(k),
    threshold: thresholds[k],
    actual: actual[k],
    pass: criterionPasses(k, thresholds[k], actual[k]),
  }));

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        fired
          ? "bg-amber-50 border-amber-300 dark:bg-amber-950/20 dark:border-amber-900/50"
          : "bg-muted/20 border-border"
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {fired ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 text-muted-foreground/50 flex-shrink-0" />
        )}
        <span className="text-sm font-semibold">
          {rule.rule || "Rule"}
        </span>
        {fired && (
          <Badge className="bg-amber-500 text-white border-amber-600 text-[9px] font-bold tracking-wider">
            MATCH
          </Badge>
        )}
        {!fired && rule.reason && (
          <span className="text-[11px] text-muted-foreground italic truncate">
            {rule.reason}
          </span>
        )}
      </div>

      {criteria.length > 0 && (
        <div className="mt-2 pl-6 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {criteria.map((c) => (
            <div key={c.key} className="flex items-center gap-1.5 text-[11px]">
              {c.pass ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-600 flex-shrink-0" />
              ) : (
                <XCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
              )}
              <span className="text-muted-foreground">{c.label}:</span>
              <span className="font-medium tabular-nums">
                need {humanValue(c.threshold)}
              </span>
              <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/60" />
              <span className={cn("tabular-nums font-medium", c.pass ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                {humanValue(c.actual)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function humanCriterionLabel(key) {
  switch (key) {
    case "photos": return "photos";
    case "fp":
    case "has_fp":
    case "floorplan": return "floorplan";
    case "video":
    case "has_video": return "video";
    case "asking":
    case "asking_price":
    case "value": return "asking price";
    default: return key;
  }
}

function humanValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v === "number") {
    if (v >= 100_000) return fmtMoney(v);
    return String(v);
  }
  if (typeof v === "object") {
    // e.g. { min: 30 } or { gte: 30 } or { gt: 8000000 }
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const k = keys[0];
      const val = v[k];
      const prefix = k === "min" || k === "gte" ? "≥" : k === "gt" ? ">" : k === "lte" ? "≤" : k === "lt" ? "<" : `${k} `;
      if (typeof val === "number" && val >= 100_000) return `${prefix}${fmtMoney(val)}`;
      return `${prefix}${val}`;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function criterionPasses(key, threshold, actual) {
  if (actual === null || actual === undefined) return false;
  if (typeof threshold === "boolean") return threshold === !!actual;
  if (typeof threshold === "number") return Number(actual) >= threshold;
  if (typeof threshold === "object" && threshold !== null) {
    if ("min" in threshold) return Number(actual) >= threshold.min;
    if ("gte" in threshold) return Number(actual) >= threshold.gte;
    if ("gt" in threshold) return Number(actual) > threshold.gt;
    if ("lte" in threshold) return Number(actual) <= threshold.lte;
    if ("lt" in threshold) return Number(actual) < threshold.lt;
  }
  return false;
}

// ── Card 3 — Tier resolution ─────────────────────────────────────────────

// Tier-source enum values emitted by pulse_compute_listing_quote. The engine
// cascades through these in order and writes the *first* that hits into
// pulse_listing_missed_opportunity.tier_source. See migration 164 + the
// compute function for the full ladder.
//
// The old keys (matrix_explicit / matrix_default / proximity / default) were
// renamed in the engine but not here — that's why 8/158 Victoria Rd's
// `proximity_radial_5km` was rendering as a muted "unknown" card before this
// fix. Keep both old + new for safety.
const TIER_SOURCE_META = {
  // T2 — Agency/agent matrix owns the tier
  matrix_agency:            { label: "T2 · Agency matrix",        color: "emerald", desc: "Agency has a price_matrices row with default_tier set" },
  matrix_agent:             { label: "T2 · Agent matrix",         color: "emerald", desc: "Agent has a price_matrices row with default_tier set" },
  // Legacy names — kept so historical rows still render cleanly
  matrix_explicit:          { label: "T1 · Matrix explicit",      color: "emerald", desc: "Agency/agent matrix set this tier outright" },
  matrix_default:           { label: "T2 · Matrix default",       color: "emerald", desc: "Matrix configured to use its default tier" },

  // T3a — Same property has a prior project
  proximity_same_property:  { label: "T3a · Same property",       color: "blue",    desc: "We've done a project on this exact property before" },
  // T3b — Same suburb has a prior project
  proximity_same_suburb:    { label: "T3b · Same suburb",         color: "blue",    desc: "Most recent project in the same suburb" },
  // T3c — Radial rings (2, 5, 10, 20, 50 km)
  proximity_radial_2km:     { label: "T3c · ≤ 2km",               color: "blue",    desc: "Nearest CRM project within 2km ring" },
  proximity_radial_5km:     { label: "T3c · ≤ 5km",               color: "blue",    desc: "Nearest CRM project within 5km ring" },
  proximity_radial_10km:    { label: "T3c · ≤ 10km",              color: "blue",    desc: "Nearest CRM project within 10km ring" },
  proximity_radial_20km:    { label: "T3c · ≤ 20km",              color: "blue",    desc: "Nearest CRM project within 20km ring" },
  proximity_radial_50km:    { label: "T3c · ≤ 50km",              color: "blue",    desc: "Nearest CRM project within 50km ring" },
  // Legacy names
  proximity:                { label: "T3 · Nearest project",      color: "blue",    desc: "Inherited from a linked project within ring radius" },
  proximity_suburb_any_pkg: { label: "T3 · Proximity (any pkg)",  color: "blue",    desc: "Nearest project regardless of package match" },

  // T4 — Global fallback
  default_std:              { label: "T4 · Standard default",     color: "amber",   desc: "No matrix, no nearby project — defaulted to standard" },
  default:                  { label: "T4 · Standard default",     color: "amber",   desc: "No projects nearby — defaulted to standard tier" },
};

function TierResolutionCard({ tierResolution, onOpenEntity }) {
  const { resolved_tier, tier_source, evidence } = tierResolution;
  const meta = TIER_SOURCE_META[tier_source] || { label: tier_source || "unknown", color: "muted", desc: "" };
  const ev = evidence || {};

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-purple-100 dark:bg-purple-950/40 flex items-center justify-center">
          <Award className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Tier resolution</h3>
          <p className="text-[10px] text-muted-foreground">
            4-step cascade: matrix explicit → matrix default → proximity → standard
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge className={cn(
            "text-[10px] font-semibold uppercase",
            resolved_tier === "premium" && "bg-purple-100 text-purple-800 border-purple-200",
            resolved_tier === "standard" && "bg-slate-100 text-slate-800 border-slate-200",
          )}>
            {resolved_tier || "—"}
          </Badge>
        </div>
      </div>

      <div
        className={cn(
          "rounded-lg border p-3",
          meta.color === "emerald" && "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-900/40",
          meta.color === "blue" && "bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-900/40",
          meta.color === "amber" && "bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/40",
          meta.color === "muted" && "bg-muted/30 border-border",
        )}
      >
        <div className="flex items-center gap-2 mb-1">
          <Badge className={cn(
            "text-[10px]",
            meta.color === "emerald" && "bg-emerald-600 text-white border-emerald-700",
            meta.color === "blue" && "bg-blue-600 text-white border-blue-700",
            meta.color === "amber" && "bg-amber-600 text-white border-amber-700",
            meta.color === "muted" && "bg-muted text-muted-foreground",
          )}>
            {meta.label}
          </Badge>
          {meta.desc && (
            <span className="text-[11px] text-muted-foreground">{meta.desc}</span>
          )}
        </div>

        <TierEvidence
          tierSource={tier_source}
          evidence={ev}
          onOpenEntity={onOpenEntity}
        />
      </div>
    </Card>
  );
}

function TierEvidence({ tierSource, evidence, onOpenEntity }) {
  // Matrix branch — either T2 agency/agent matrix OR legacy matrix_* names.
  // Evidence shape (from pulse_get_listing_quote_detail):
  //   { matrix_id, entity_type, entity_id, entity_name, default_tier, use_default_pricing, snapshot_date }
  if (tierSource && tierSource.startsWith("matrix_")) {
    const entityType = evidence.entity_type || (tierSource === "matrix_agent" ? "agent" : "agency");
    return (
      <div className="space-y-1 mt-2">
        {evidence.entity_name && (
          <div className="flex items-center gap-1.5 text-xs">
            <Building2 className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">{evidence.entity_name}</span>
            {evidence.entity_id && onOpenEntity && (
              <button
                onClick={() => onOpenEntity({ type: entityType, id: evidence.entity_id })}
                className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
              >
                open <ExternalLink className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}
        {evidence.default_tier && (
          <div className="text-[11px] text-muted-foreground">
            default_tier = <span className="font-mono bg-background/60 px-1 rounded capitalize">{evidence.default_tier}</span>
          </div>
        )}
        {evidence.use_default_pricing != null && (
          <div className="text-[11px] text-muted-foreground">
            use_default_pricing = <span className="font-mono bg-background/60 px-1 rounded">{String(evidence.use_default_pricing)}</span>
          </div>
        )}
        {evidence.snapshot_date && (
          <div className="text-[10px] text-muted-foreground">
            matrix snapshot {fmtDate(evidence.snapshot_date)}
          </div>
        )}
      </div>
    );
  }

  // Proximity branch — covers same_property, same_suburb, radial_Nkm.
  // Evidence shape: { project_id, project_address, project_pricing_tier, distance_km, package_id_match }
  if (tierSource && tierSource.startsWith("proximity_")) {
    return (
      <div className="space-y-1 mt-2">
        {evidence.project_address && (
          <div className="flex items-center gap-1.5 text-xs">
            <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="font-medium truncate">{evidence.project_address}</span>
            {evidence.project_id && onOpenEntity && (
              <button
                onClick={() => onOpenEntity({ type: "project", id: evidence.project_id })}
                className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5 flex-shrink-0"
              >
                open <ExternalLink className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}
        {evidence.project_pricing_tier && (
          <div className="text-[11px] text-muted-foreground">
            anchor tier: <span className="font-medium text-foreground capitalize">{evidence.project_pricing_tier}</span>
          </div>
        )}
        {evidence.distance_km != null && (
          <div className="text-[11px] text-muted-foreground">
            {Number(evidence.distance_km).toFixed(2)} km away
          </div>
        )}
        {evidence.package_id_match != null && (
          <div className="text-[11px] text-muted-foreground">
            same package classification:{" "}
            <span className={cn("font-medium", evidence.package_id_match ? "text-emerald-600" : "text-muted-foreground")}>
              {evidence.package_id_match ? "yes" : "no"}
            </span>
          </div>
        )}
      </div>
    );
  }

  if (tierSource === "default_std" || tierSource === "default") {
    return (
      <div className="flex items-start gap-2 mt-2 text-[11px] text-amber-800 dark:text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
        <span>
          {evidence.reason || `No projects within ${evidence.max_ring_km || 50}km of this listing — defaulted to standard tier.`}
        </span>
      </div>
    );
  }

  return (
    <div className="text-[11px] text-muted-foreground mt-2 font-mono">
      {Object.keys(evidence || {}).length === 0 ? "No evidence recorded." : JSON.stringify(evidence)}
    </div>
  );
}

// ── Card 4 — Pricing receipt ─────────────────────────────────────────────

const PRICING_METHOD_LABEL = {
  agency_matrix: "Agency matrix",
  agent_matrix: "Agent matrix",
  proximity_suburb: "Proximity · same suburb",
  proximity_suburb_any_pkg: "Proximity · same suburb · any pkg",
  proximity_any: "Proximity · nearest match",
  default_package_price: "Default package price",
  default: "Default package price",
};

function PricingReceiptCard({ pricing, onOpenEntity }) {
  const {
    pricing_method,
    package_base_price,
    overflow_photos,
    overflow_charge,
    discount_applied_pct,
    sales_img_base_used,
    sales_img_unit_used,
    math_lines,
    source,
  } = pricing;
  const lines = Array.isArray(math_lines) ? math_lines : [];
  const total = lines.find((l) => l.total);
  const methodLabel = PRICING_METHOD_LABEL[pricing_method] || pricing_method || "—";
  const src = source || {};

  return (
    <Card className="p-4 border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-white to-emerald-50/40 dark:from-card dark:to-emerald-950/10">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
          <Receipt className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Pricing receipt</h3>
          <p className="text-[10px] text-muted-foreground">
            How we arrived at this quote
          </p>
        </div>
        <Badge className="ml-auto bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/40 text-[10px]">
          {methodLabel}
        </Badge>
      </div>

      {/* Source block */}
      {(src.label || src.name) && (
        <div className="rounded-md border bg-muted/30 p-2 mb-3 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Source
            </span>
            <span className="font-medium truncate">{src.label || src.name}</span>
            {src.type && src.id && onOpenEntity && (
              <button
                onClick={() => onOpenEntity({ type: src.type, id: src.id })}
                className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
              >
                open <ExternalLink className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
          {src.detail && (
            <p className="text-[11px] text-muted-foreground mt-1">{src.detail}</p>
          )}
          {discount_applied_pct > 0 && (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">
              Blanket discount applied: −{fmtPct(discount_applied_pct)}
            </p>
          )}
        </div>
      )}

      {/* Receipt table */}
      {lines.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center font-mono">
          No line items — listing may be UNCLASSIFIABLE.
        </p>
      ) : (
        <div className="font-mono">
          <table className="w-full text-xs">
            <tbody>
              {lines.map((line, i) => {
                const isTotal = !!line.total;
                const amount = Number(line.amount || 0);
                const isDiscount = amount < 0;
                return (
                  <tr
                    key={i}
                    className={cn(
                      "border-b border-dashed border-border/60 last:border-b-0",
                      isTotal && "border-t-[3px] border-t-foreground border-dashed border-b-0 font-bold",
                    )}
                  >
                    <td className={cn(
                      "py-1.5",
                      isTotal && "pt-2 text-sm",
                    )}>
                      {line.label || "—"}
                    </td>
                    <td className={cn(
                      "py-1.5 text-right tabular-nums",
                      isTotal && "pt-2 text-base",
                      isDiscount && !isTotal && "text-emerald-700 dark:text-emerald-400",
                    )}>
                      {fmtMoneyExact(amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pricing micro-stats */}
      {(overflow_photos > 0 || sales_img_base_used) && (
        <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t text-[10px] text-muted-foreground">
          {package_base_price != null && (
            <span>Base pkg: <span className="font-medium tabular-nums text-foreground">{fmtMoneyExact(package_base_price)}</span></span>
          )}
          {overflow_photos > 0 && (
            <span>Overflow: <span className="font-medium tabular-nums text-foreground">{overflow_photos} × {fmtMoneyExact(sales_img_unit_used || 0)} = {fmtMoneyExact(overflow_charge || 0)}</span></span>
          )}
          {sales_img_base_used != null && (
            <span>Sales img base used: <span className="font-medium tabular-nums text-foreground">{fmtMoneyExact(sales_img_base_used)}</span></span>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Card 5 — Quality flags ───────────────────────────────────────────────

function QualityFlagsCard({ flags }) {
  const items = [];
  if (flags.address_hidden) items.push({
    key: "addr",
    label: "Address 'available on request' — cross-referencing limited",
  });
  if (flags.data_gap_flag) items.push({
    key: "gap",
    label: "No projects within 50km — wider regional expansion needed",
  });
  if (flags.photos_capped_at_34) items.push({
    key: "cap",
    label: "REA caps at 34 photos — true count may be higher",
  });
  if (flags.quote_status === "pending_enrichment") items.push({
    key: "pend",
    label: "Listing not yet enriched — quote is a placeholder using images[] fallback",
  });

  if (items.length === 0) return null;

  return (
    <Card className="p-4 border-amber-200/60 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/10">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Quality flags
        </h3>
      </div>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li
            key={it.key}
            className="flex items-start gap-2 text-xs text-amber-900/90 dark:text-amber-200/90"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 mt-1.5 flex-shrink-0" />
            <span>{it.label}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Card 6 — What-if simulator ───────────────────────────────────────────

function WhatIfCard({ listing, classification, tierResolution, actualPricing }) {
  const [photos, setPhotos] = useState(listing.photo_count ?? 10);
  const [floorplan, setFloorplan] = useState(!!listing.has_floorplan);
  const [video, setVideo] = useState(!!listing.has_video);
  const [askingPriceStr, setAskingPriceStr] = useState(
    listing.asking_price_numeric ? String(listing.asking_price_numeric) : ""
  );
  const [tier, setTier] = useState(tierResolution.resolved_tier || "standard");

  // Wave 7 P1-11.b: live packages are the source of truth for display names.
  // We match the rule key (flex/dusk/day/gold/silver) against the live names
  // case-insensitively — first substring match wins. Falls back to the
  // hardcoded fallbackName if the live catalog doesn't carry that rule yet.
  const { names: livePackageNames } = useActivePackages();
  const pkgKeyToName = useMemo(() => {
    const out = {};
    for (const key of Object.keys(PACKAGE_DEFAULTS)) {
      const live = livePackageNames.find(
        (n) => String(n).toLowerCase().includes(key.toLowerCase()),
      );
      out[key] = live || PACKAGE_DEFAULTS[key].fallbackName;
    }
    return out;
  }, [livePackageNames]);

  const askingPrice = useMemo(() => {
    const n = Number(String(askingPriceStr).replace(/[^\d.]/g, ""));
    return isFinite(n) && n > 0 ? n : 0;
  }, [askingPriceStr]);

  const sim = useMemo(() => {
    const pkgKey = classifyLocal({ photos, floorplan, video, askingPrice });
    const price = priceLocal({ pkgKey, tier, photos });
    const def = pkgKey ? PACKAGE_DEFAULTS[pkgKey] : null;
    const displayName = pkgKey ? pkgKeyToName[pkgKey] : null;
    return {
      pkgKey,
      pkg: def ? { ...def, name: displayName } : null,
      ...price,
    };
  }, [photos, floorplan, video, askingPrice, tier, pkgKeyToName]);

  const actualTotal = Number(
    (actualPricing.math_lines || []).find((l) => l.total)?.amount || 0
  );
  const delta = sim.total - actualTotal;

  return (
    <Card className="p-4 border-fuchsia-200/60 dark:border-fuchsia-900/40 bg-gradient-to-br from-white to-fuchsia-50/30 dark:from-card dark:to-fuchsia-950/10">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-fuchsia-100 dark:bg-fuchsia-950/40 flex items-center justify-center">
          <Beaker className="h-4 w-4 text-fuchsia-600 dark:text-fuchsia-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">What-if simulator</h3>
          <p className="text-[10px] text-muted-foreground">
            Replay the engine locally with different inputs · defaults only, ignores matrix/proximity overrides
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Controls */}
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium">Photos</label>
              <span className="text-xs tabular-nums font-mono bg-muted px-1.5 py-0.5 rounded">
                {photos}
              </span>
            </div>
            <Slider
              min={5}
              max={50}
              step={1}
              value={[photos]}
              onValueChange={(v) => setPhotos(v[0])}
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={floorplan}
                onCheckedChange={(v) => setFloorplan(!!v)}
              />
              Floorplan
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={video}
                onCheckedChange={(v) => setVideo(!!v)}
              />
              Video
            </label>
          </div>

          <div>
            <label className="text-xs font-medium mb-1.5 block">Asking price</label>
            <Input
              type="text"
              inputMode="decimal"
              value={askingPriceStr}
              onChange={(e) => setAskingPriceStr(e.target.value)}
              placeholder="e.g. 8500000"
              className="h-8 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="text-xs font-medium mb-1.5 block">Tier</label>
            <div className="inline-flex rounded-md border bg-card p-0.5">
              {["standard", "premium"].map((t) => (
                <button
                  key={t}
                  onClick={() => setTier(t)}
                  className={cn(
                    "text-xs px-3 py-1 rounded transition-colors capitalize",
                    tier === t
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted"
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Output */}
        <div className="rounded-lg border bg-card p-3 flex flex-col">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
            Simulated quote
          </p>
          {sim.pkgKey ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">{fmtMoneyExact(sim.total)}</span>
                {delta !== 0 && actualTotal > 0 && (
                  <span
                    className={cn(
                      "text-xs font-mono tabular-nums px-1.5 py-0.5 rounded",
                      delta > 0
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                        : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                    )}
                  >
                    {delta > 0 ? "+" : ""}{fmtMoneyExact(delta)}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-fuchsia-500" />
                <span className="text-xs font-medium">{sim.pkg.name}</span>
                <span className="text-[10px] text-muted-foreground">· {tier}</span>
              </div>

              <dl className="mt-3 space-y-1 text-[11px] font-mono border-t pt-2">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Package base</dt>
                  <dd className="tabular-nums">{fmtMoneyExact(sim.base)}</dd>
                </div>
                {sim.overflow > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">
                      Overflow ({sim.overflowPhotos} × {fmtMoneyExact(OVERFLOW_UNIT[tier])})
                    </dt>
                    <dd className="tabular-nums">{fmtMoneyExact(sim.overflow)}</dd>
                  </div>
                )}
                <div className="flex justify-between pt-1 border-t border-dashed font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{fmtMoneyExact(sim.total)}</dd>
                </div>
              </dl>

              {actualTotal > 0 && delta !== 0 && (
                <p className="mt-auto pt-3 text-[11px] text-muted-foreground">
                  With {photos} photos{tier !== (tierResolution.resolved_tier || "standard") ? ` @ ${tier}` : ""} this would be{" "}
                  <span className="font-medium text-foreground">{fmtMoneyExact(sim.total)}</span>{" "}
                  (<span className={delta > 0 ? "text-emerald-700" : "text-red-600"}>
                    {delta > 0 ? "+" : ""}{fmtMoneyExact(delta)}
                  </span> vs actual)
                </p>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center py-6">
              <div>
                <XCircle className="h-6 w-6 text-muted-foreground/40 mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">
                  UNCLASSIFIABLE — needs a floorplan at minimum.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Card 7 — Provenance footer ───────────────────────────────────────────

function ProvenanceFooter({ provenance }) {
  const [expanded, setExpanded] = useState(false);
  const { computed_at, engine_version, raw_cascade_log } = provenance;

  return (
    <Card className="p-3 border-dashed">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Cpu className="h-3 w-3" />
        <span>
          Engine <span className="font-mono">{engine_version || "unknown"}</span>
        </span>
        <span>·</span>
        <span>Computed {fmtRelative(computed_at)}</span>
        <span className="ml-auto inline-flex items-center gap-0.5">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? "hide" : "view"} raw cascade log
        </span>
      </button>
      {expanded && (
        <pre className="mt-2 text-[10px] font-mono bg-muted/40 border rounded p-2 overflow-x-auto max-h-[300px]">
          {JSON.stringify(raw_cascade_log ?? {}, null, 2)}
        </pre>
      )}
    </Card>
  );
}
