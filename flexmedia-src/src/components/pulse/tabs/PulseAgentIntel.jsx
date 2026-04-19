/**
 * PulseAgentIntel — Agent Intelligence Tab
 *
 * Filtered / sorted / paginated agent table with:
 *   - Column filters (agency, suburb)
 *   - Global search (name, agency, email, mobile, suburb)
 *   - Click-row slideout panel (full dossier)
 *   - Add-to-CRM two-step flow with dedup check
 *
 * Architecture: REA-only. Single ID: rea_agent_id. Zero Domain references.
 */

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Users,
  Star,
  ExternalLink,
  Phone,
  Mail,
  MapPin,
  Award,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Building2,
  Globe,
  Hash,
  Briefcase,
  ChevronUp,
  ChevronDown,
  X,
  Activity,
  Download,
  Clock,
  Loader2,
  History,
  Copy,
  Sparkles,
  DollarSign,
  TrendingUp,
  LayoutGrid,
  Table2,
  Bookmark,
  BookmarkCheck,
  Save,
  Sliders,
  Zap,
  Eye,
} from "lucide-react";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import EntitySyncHistoryDialog from "@/components/pulse/EntitySyncHistoryDialog";
import AgentMarketShareSection from "@/components/marketshare/AgentMarketShareSection";
import EnrichmentBadge from "@/components/marketshare/EnrichmentBadge";
import {
  displayPrice as sharedDisplayPrice,
  isActiveListing,
  stalenessInfo,
  reaIdEquals,
  alternateContacts,
} from "@/components/pulse/utils/listingHelpers";
import {
  useAgentsRetentionBulk,
  fmtMissedDollars,
  retentionBand,
  retentionBandClass,
  readWatchlist,
  toggleWatchlistId,
  readSavedViews,
  addSavedView,
  deleteSavedView,
} from "@/components/pulse/utils/retentionBulk";
import FieldWithSource from "@/components/fieldSources/FieldWithSource";
import BackfillEntityButton from "@/components/fieldSources/BackfillEntityButton";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/* AU numeric date for CSV export (dd/mm/yyyy). */
function fmtDateAu(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/* Rating color ramp + tier label (#20). */
function ratingColorClass(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return "text-muted-foreground";
  if (n >= 4.5) return "text-emerald-600 dark:text-emerald-400";
  if (n >= 3.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}
function ratingStarFill(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return "text-muted-foreground/40";
  if (n >= 4.5) return "fill-emerald-500 text-emerald-500";
  if (n >= 3.5) return "fill-amber-400 text-amber-400";
  return "fill-red-500 text-red-500";
}
function ratingTier(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 4.8) return "Elite";
  if (n >= 4.5) return "Top Rated";
  if (n >= 4.0) return "Strong";
  return null;
}

function normAgencyKey(s) {
  return (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalize(s) {
  return (s || "").replace(/\D/g, "").trim().toLowerCase();
}

function fuzzyNameMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Check if first+last words overlap (handles "John Smith" vs "John A. Smith")
  const wa = na.split(" ");
  const wb = nb.split(" ");
  return wa[0] === wb[0] && wa[wa.length - 1] === wb[wb.length - 1];
}

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase().trim();
  // AG07: Empty job_title → null (skip badge entirely). Previously defaulted
  // to "Junior", flooding the UI with grey pills on un-enriched rows.
  if (!jt) return null;
  if (
    jt.includes("partner") ||
    jt.includes("director") ||
    jt.includes("managing") ||
    jt.includes("principal") ||
    jt.includes("licensee") ||
    jt.includes("owner") ||
    jt.includes("ceo")
  )
    return "Partner";
  if (jt.includes("senior") || jt.includes("manager") || jt.includes("head of"))
    return "Senior";
  if (jt.includes("associate")) return "Associate";
  return "Junior";
}

/* Relative time-ago for last_synced_at columns. */
function fmtAgo(d) {
  if (!d) return "—";
  const t = new Date(d).getTime();
  if (isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return `${d2}d ago`;
  const mo = Math.floor(d2 / 30);
  return `${mo}mo ago`;
}

/* CSV export helper — quote fields, build blob, trigger download.
 * Prefixes a UTF-8 BOM (\uFEFF) so Excel detects the encoding. */
function exportCsv(filename, header, rows) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  const csv = "\uFEFF" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Copy-to-clipboard helper — used by hover-copy icons + context menu. */
async function copyToClipboard(text, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(String(text));
    toast.success(`Copied${label ? ` ${label}` : ""}!`);
  } catch {
    toast.error("Copy failed");
  }
}

/* Small hover-only copy icon (#14). Parent row should have `group`. */
function CopyCellIcon({ value, label }) {
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyToClipboard(value, label);
      }}
      className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity inline-flex items-center justify-center h-4 w-4 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
      aria-label={`Copy ${label || "value"}`}
      title={`Copy ${label || "value"}`}
    >
      <Copy className="h-3 w-3" />
    </button>
  );
}

function PositionBadge({ position }) {
  // AG07: skip entirely when position is null (empty job_title).
  if (!position) return null;
  const cls =
    position === "Partner"
      ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
      : position === "Senior"
      ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800"
      : position === "Associate"
      ? "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-800"
      : "bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-950/30 dark:text-gray-400 dark:border-gray-800";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-medium leading-4",
        cls
      )}
    >
      {position}
    </span>
  );
}

function CrmStatusBadge({ inCrm }) {
  return inCrm ? (
    <span className="inline-flex items-center rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800 px-1.5 py-0 text-[9px] font-medium leading-4">
      In CRM
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800 px-1.5 py-0 text-[9px] font-medium leading-4">
      Prospect
    </span>
  );
}

function ReaBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800 px-1.5 py-0 text-[9px] font-semibold leading-4">
      REA
    </span>
  );
}

function AgentAvatar({ agent, size = 32 }) {
  const [imgError, setImgError] = React.useState(false);
  const [imgLoaded, setImgLoaded] = React.useState(false);
  const initials = (agent.full_name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();

  if (agent.profile_image && !imgError) {
    // #21 Avatar lazy-load — pulsing muted placeholder until onLoad fires.
    return (
      <div
        className={cn(
          "relative rounded-full overflow-hidden flex-shrink-0",
          !imgLoaded && "bg-muted animate-pulse",
        )}
        style={{ width: size, height: size }}
      >
        <img
          src={agent.profile_image}
          alt={agent.full_name}
          loading="lazy"
          decoding="async"
          className={cn(
            "rounded-full object-cover w-full h-full transition-opacity duration-200",
            imgLoaded ? "opacity-100" : "opacity-0",
          )}
          onError={() => setImgError(true)}
          onLoad={() => setImgLoaded(true)}
        />
      </div>
    );
  }
  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-muted-foreground font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.35 }}
    >
      {initials}
    </div>
  );
}

function StarRating({ rating, count }) {
  if (!rating) return <span className="text-muted-foreground">—</span>;
  const colorCls = ratingColorClass(rating);
  const starCls = ratingStarFill(rating);
  const tier = ratingTier(rating);
  return (
    <span className="inline-flex items-center gap-0.5 text-xs">
      <Star className={cn("h-3 w-3", starCls)} />
      <span className={cn("tabular-nums font-medium", colorCls)}>
        {Number(rating).toFixed(1)}
      </span>
      {count > 0 && (
        <span className="text-muted-foreground text-[10px]">({count})</span>
      )}
      {tier && <TierPill tier={tier} />}
    </span>
  );
}

/* #20 Rating tier pill — Elite / Top Rated / Strong. */
function TierPill({ tier }) {
  if (!tier) return null;
  const cls =
    tier === "Elite"
      ? "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-800"
      : tier === "Top Rated"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800"
      : "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800";
  return (
    <span
      className={cn(
        "ml-1 inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[9px] font-medium leading-4",
        cls,
      )}
      title={`Rating tier: ${tier}`}
    >
      {tier === "Elite" && <Sparkles className="h-2.5 w-2.5" />}
      {tier}
    </span>
  );
}

/* ── Retention chips (bulk RPC driven — see migration 174) ────────────────
 * Rendered on every card + every table row. Reads from the memoised Map
 * returned by useAgentsRetentionBulk so render cost is ~O(1) per row after
 * the initial page-wide RPC fires. Falls back to a dash placeholder when
 * the RPC hasn't resolved or when the agent has no listings in the window. */
function MissedOppChip({ value, size = "sm", loading }) {
  if (loading) {
    return (
      <span className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-dashed border-amber-200/60 text-amber-600/50 dark:border-amber-800/60 dark:text-amber-400/40 tabular-nums",
        size === "sm" ? "text-[9px] px-1.5 py-0 leading-4" : "text-[10px] px-2 py-0.5 leading-4",
      )}>
        <DollarSign className={cn(size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3", "animate-pulse")} />
        <span className="opacity-60">…</span>
      </span>
    );
  }
  const n = Number(value || 0);
  const zero = n <= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border tabular-nums",
        zero
          ? "border-muted text-muted-foreground bg-muted/30"
          : "border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:bg-amber-950/30",
        size === "sm" ? "text-[9px] px-1.5 py-0 leading-4" : "text-[10px] px-2 py-0.5 leading-4",
      )}
      title={zero ? "No missed opportunities in last 12 months" : `Missed opportunity over last 12 months: ${fmtMissedDollars(n)}`}
    >
      <DollarSign className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      <span>{fmtMissedDollars(n)}</span>
    </span>
  );
}

function RetentionChip({ pct, total, size = "sm", loading }) {
  if (loading) {
    return (
      <span className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-dashed border-border text-muted-foreground tabular-nums",
        size === "sm" ? "text-[9px] px-1.5 py-0 leading-4" : "text-[10px] px-2 py-0.5 leading-4",
      )}>
        <TrendingUp className={cn(size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3", "animate-pulse")} />
        <span className="opacity-60">…</span>
      </span>
    );
  }
  if (total == null || total === 0) {
    return (
      <span className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-muted text-muted-foreground bg-muted/30 tabular-nums",
        size === "sm" ? "text-[9px] px-1.5 py-0 leading-4" : "text-[10px] px-2 py-0.5 leading-4",
      )} title="No scored listings in last 12 months">
        <TrendingUp className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} />
        <span>no data</span>
      </span>
    );
  }
  const n = Number(pct || 0);
  const band = retentionBand(n);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border tabular-nums",
        retentionBandClass(band),
        size === "sm" ? "text-[9px] px-1.5 py-0 leading-4" : "text-[10px] px-2 py-0.5 leading-4",
      )}
      title={`Retention rate over last 12 months: ${n}% — ${total} listings (${band === "healthy" ? "healthy" : band === "mid" ? "mid" : "at risk"})`}
    >
      <TrendingUp className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      <span>{n.toFixed(0)}%</span>
    </span>
  );
}

/* WatchButton — toggles the entity id in the localStorage watchlist. Renders
 * a bookmark icon; filled when watched. Works for both agents and agencies. */
function WatchButton({ type, id, size = "sm", className }) {
  const [watched, setWatched] = React.useState(() => readWatchlist(type).has(String(id)));
  const onClick = (e) => {
    e.stopPropagation();
    const next = toggleWatchlistId(type, id);
    setWatched(next.has(String(id)));
    toast.success(next.has(String(id)) ? "Added to watchlist" : "Removed from watchlist");
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors",
        size === "sm" ? "h-6 w-6" : "h-7 w-7",
        watched
          ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
        className,
      )}
      aria-pressed={watched}
    >
      {watched ? <BookmarkCheck className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : <Bookmark className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />}
    </button>
  );
}

/* QuickActionRibbon — compact row of icon-buttons shown at the top of the
 * slideout header (Watch / Email / Call / CRM / Copy URL). Matches the other
 * pulse surfaces (DataFreshnessCard ribbon). */
function QuickActionRibbon({ entity, type, onWatch, watched, onOpenCrm, inCrm, url, label }) {
  const copyUrl = async () => {
    const u = url || (typeof window !== "undefined" ? window.location.href : "");
    try {
      await navigator.clipboard.writeText(u);
      toast.success("Link copied");
    } catch {
      toast.error("Copy failed");
    }
  };
  const phone = entity?.mobile || entity?.business_phone || entity?.phone || null;
  const email = entity?.email || null;
  return (
    <div className="flex items-center gap-1 px-1 py-1 rounded-lg bg-muted/30 border border-border">
      <button
        type="button"
        onClick={onWatch}
        title={watched ? "Remove from watchlist" : "Add to watchlist"}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
          watched
            ? "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
      >
        {watched ? <BookmarkCheck className="h-3 w-3" /> : <Bookmark className="h-3 w-3" />}
        {watched ? "Watching" : "Watch"}
      </button>
      {email ? (
        <a
          href={`mailto:${email}`}
          title={`Email ${label || ""}`.trim()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Mail className="h-3 w-3" />
          Email
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground/50 cursor-not-allowed">
          <Mail className="h-3 w-3" />
          Email
        </span>
      )}
      {phone ? (
        <a
          href={`tel:${phone}`}
          title={`Call ${phone}`}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Phone className="h-3 w-3" />
          Call
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground/50 cursor-not-allowed">
          <Phone className="h-3 w-3" />
          Call
        </span>
      )}
      {inCrm && onOpenCrm ? (
        <button
          type="button"
          onClick={onOpenCrm}
          title="Open in CRM"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          CRM
        </button>
      ) : null}
      <button
        type="button"
        onClick={copyUrl}
        title="Copy shareable link"
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Copy className="h-3 w-3" />
        Copy URL
      </button>
    </div>
  );
}

/* ── Sort indicator ──────────────────────────────────────────────────────── */

function SortIcon({ col, sort }) {
  if (sort.col !== col)
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 ml-0.5 inline" />;
  return sort.dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-primary ml-0.5 inline" />
  ) : (
    <ChevronDown className="h-3 w-3 text-primary ml-0.5 inline" />
  );
}

/* ── Mini listing table (inside slideout) ────────────────────────────────── */

function MiniListingTable({ listings, emptyMsg, onOpenListing }) {
  if (!listings.length)
    return <p className="text-xs text-muted-foreground py-2">{emptyMsg}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Address</th>
            <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Price</th>
            <th className="text-right py-1.5 font-medium text-muted-foreground">DOM</th>
          </tr>
        </thead>
        <tbody>
          {listings.slice(0, 10).map((l) => (
            <tr
              key={l.id}
              className={cn(
                "border-b border-border/40 hover:bg-muted/40 transition-colors",
                onOpenListing && "cursor-pointer"
              )}
              onClick={onOpenListing ? () => onOpenListing(l) : undefined}
            >
              <td className="py-1.5 pr-3 max-w-[220px] truncate text-foreground">
                {l.address || l.suburb || "—"}
              </td>
              {/* Use shared displayPrice — previously `asking_price || sold_price`
                  which showed the asking-price fallback on sold listings. */}
              <td className="py-1.5 pr-3 text-right tabular-nums">{sharedDisplayPrice(l).label}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {l.days_on_market > 0 ? `${l.days_on_market}d` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {listings.length > 10 && (
        <p className="text-[10px] text-muted-foreground pt-1">
          + {listings.length - 10} more
        </p>
      )}
    </div>
  );
}

/* ── Add to CRM Flow ─────────────────────────────────────────────────────── */

function AddToCrmDialog({ agent, crmAgents, crmAgencies, pulseMappings, onClose, onSuccess }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [agencyChoice, setAgencyChoice] = useState("create"); // "create" | existing agency id

  const existingByName = useMemo(
    () => crmAgents.filter((c) => fuzzyNameMatch(c.name, agent.full_name)),
    [crmAgents, agent.full_name]
  );

  const existingByPhone = useMemo(() => {
    const mob = normalize(agent.mobile);
    if (!mob) return [];
    return crmAgents.filter((c) => normalize(c.phone) === mob || normalize(c.mobile) === mob);
  }, [crmAgents, agent.mobile]);

  const existingAgency = useMemo(
    () =>
      crmAgencies.find(
        (c) => normAgencyKey(c.name) === normAgencyKey(agent.agency_name)
      ),
    [crmAgencies, agent.agency_name]
  );

  const hasDuplicate = existingByName.length > 0 || existingByPhone.length > 0;

  async function handleConfirm() {
    setSaving(true);
    try {
      // 1. Create or find agency
      let agencyId = existingAgency?.id;
      if (!agencyId && agent.agency_name) {
        const newAgency = await api.entities.Agency.create({
          name: agent.agency_name,
          rea_agency_id: agent.agency_rea_id,
        });
        agencyId = newAgency.id;
        await refetchEntityList("Agency");
      }

      // 2. Create CRM agent
      const newAgent = await api.entities.Agent.create({
        name: agent.full_name,
        phone: agent.mobile || agent.business_phone,
        email: agent.email,
        current_agency_id: agencyId,
        rea_agent_id: agent.rea_agent_id,
        title: agent.job_title,
        relationship_state: "prospect",
        source: "pulse",
      });

      // 3. Create mapping
      await api.entities.PulseCrmMapping.create({
        entity_type: "agent",
        pulse_entity_id: agent.id,
        crm_entity_id: newAgent.id,
        rea_id: agent.rea_agent_id,
        match_type: "manual",
        confidence: "confirmed",
      });

      // 4. Mark pulse agent as in_crm
      await api.entities.PulseAgent.update(agent.id, { is_in_crm: true });

      await refetchEntityList("PulseAgent");
      await refetchEntityList("PulseCrmMapping");

      toast.success(`${agent.full_name} added to CRM`);
      onSuccess();
    } catch (err) {
      console.error("Add to CRM failed:", err);
      toast.error("Failed to add agent to CRM. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            Add to CRM
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4 py-2">
            {/* Agent preview */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border border-border">
              <AgentAvatar agent={agent} size={40} />
              <div className="min-w-0">
                <p className="font-semibold text-sm leading-tight">{agent.full_name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {agent.agency_name}
                  {agent.agency_suburb ? ` · ${agent.agency_suburb}` : ""}
                </p>
                {agent.mobile && (
                  <p className="text-xs text-muted-foreground">{agent.mobile}</p>
                )}
              </div>
            </div>

            {/* Dedup warnings */}
            {hasDuplicate && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1">
                  <Award className="h-3.5 w-3.5" />
                  Possible duplicates found
                </p>
                {existingByName.map((c) => (
                  <p key={c.id} className="text-xs text-amber-700 dark:text-amber-300 pl-5">
                    Name match: <strong>{c.name}</strong>
                    {c.phone ? ` · ${c.phone}` : ""}
                  </p>
                ))}
                {existingByPhone
                  .filter((c) => !existingByName.find((n) => n.id === c.id))
                  .map((c) => (
                    <p key={c.id} className="text-xs text-amber-700 dark:text-amber-300 pl-5">
                      Phone match: <strong>{c.name}</strong> · {c.phone}
                    </p>
                  ))}
                <p className="text-[10px] text-amber-600 dark:text-amber-400 pl-5">
                  You can still proceed — this will create a new CRM record.
                </p>
              </div>
            )}

            {/* Agency status */}
            <div className="rounded-lg border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-foreground">Agency</p>
              {existingAgency ? (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  Will link to existing: <strong className="ml-1">{existingAgency.name}</strong>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  Will create new agency:{" "}
                  <strong className="ml-1">{agent.agency_name || "Unknown"}</strong>
                </p>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground">
              This will create a CRM Agent record and a Pulse mapping. The agent's
              REA ID will be stored for future intelligence syncing.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border border-border">
              <AgentAvatar agent={agent} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm leading-tight">{agent.full_name}</p>
                <p className="text-xs text-muted-foreground">{agent.agency_name}</p>
              </div>
              <ReaBadge />
            </div>

            <div className="rounded-lg border border-border divide-y divide-border text-xs">
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">REA Agent ID</span>
                <span className="font-mono text-[10px]">{agent.rea_agent_id || "—"}</span>
              </div>
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">Mobile</span>
                <span>{agent.mobile || "—"}</span>
              </div>
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span className="truncate max-w-[200px]">{agent.email || "—"}</span>
              </div>
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">Agency</span>
                <span>{existingAgency ? "Link existing" : "Create new"}</span>
              </div>
            </div>

            <p className="text-xs font-semibold text-foreground">Confirm creation?</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {step === 1 && (
            <Button size="sm" onClick={() => setStep(2)}>
              Continue
            </Button>
          )}
          {step === 2 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep(1)}
                disabled={saving}
              >
                Back
              </Button>
              <Button size="sm" onClick={handleConfirm} disabled={saving}>
                {saving ? "Creating…" : "Confirm & Add"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Agent Slideout ──────────────────────────────────────────────────────── */

export function AgentSlideout({
  agent,
  pulseAgencies = [],
  pulseAgents = [],
  pulseListings,
  pulseTimeline,
  crmAgents,
  crmAgencies,
  pulseMappings,
  onClose,
  onAddToCrm,
  onOpenEntity,
  hasHistory = false,
  onBack,
  onNavigate,
}) {
  const position = mapPosition(agent.job_title);
  // Tier 4: source-history drill
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);

  // Fetch per-agent timeline via the dossier RPC. The global `pulseTimeline`
  // prop is capped at the 500 most-recent events across the entire platform;
  // for any agent whose activity isn't in that tail (which is almost every
  // agent given our volume), the prop-filter rendered an empty list.
  // The RPC runs the same filter server-side + fans out to their listings'
  // events, matching what the PersonDetails Intelligence tab already does.
  const { data: agentDossier } = useQuery({
    queryKey: ["pulse_dossier_slideout", "agent", agent?.id],
    queryFn: async () => {
      if (!agent?.id) return null;
      const { data, error } = await api._supabase.rpc("pulse_get_dossier", {
        p_entity_type: "agent",
        p_entity_id: agent.id,
      });
      if (error) throw error;
      return data;
    },
    enabled: !!agent?.id,
    staleTime: 30_000,
  });
  const slideoutTimeline = useMemo(() => {
    if (agentDossier?.timeline?.length) return agentDossier.timeline;
    // Fallback: prop-filter (catches the rare hit in the 500-row window).
    return (pulseTimeline || []).filter(e =>
      reaIdEquals(e.rea_id, agent?.rea_agent_id) ||
      e.pulse_entity_id === agent?.id
    );
  }, [agentDossier, pulseTimeline, agent]);

  // Tier 3 drill-through: look up CRM mapping so the "In CRM" badge can link
  // straight to the CRM record (PersonDetails).
  const crmMapping = useMemo(() => {
    if (!agent?.is_in_crm || !pulseMappings) return null;
    return pulseMappings.find(
      (m) =>
        m.entity_type === "agent" &&
        (m.pulse_entity_id === agent.id ||
          (m.rea_id && agent.rea_agent_id && String(m.rea_id) === String(agent.rea_agent_id)))
    );
  }, [agent, pulseMappings]);

  const agentListings = useMemo(() => {
    // Prefer server-side dossier listings (filtered to this agent) over the
    // pulseListings prop. Post big-refactor pulseListings is empty at the
    // page level, so the dossier is the practical source.
    const source = (Array.isArray(agentDossier?.listings) && agentDossier.listings.length > 0)
      ? agentDossier.listings
      : pulseListings;
    const id = agent.rea_agent_id;
    if (!id) return { active: [], sold: [] };
    const all = (source || []).filter(
      (l) =>
        l.agent_rea_id === id ||
        (Array.isArray(l.agent_rea_ids) && l.agent_rea_ids.includes(id))
    );
    return {
      active: all.filter((l) => isActiveListing(l)),
      sold: all.filter((l) => l.listing_type === "sold"),
    };
  }, [agent.rea_agent_id, pulseListings, agentDossier]);

  // Cross-reference: find pulse agency record
  const linkedAgency = useMemo(() => {
    if (agent.agency_rea_id) {
      const byId = pulseAgencies.find((a) => a.rea_agency_id === agent.agency_rea_id);
      if (byId) return byId;
    }
    if (agent.agency_name) {
      return pulseAgencies.find(
        (a) => normAgencyKey(a.name) === normAgencyKey(agent.agency_name)
      );
    }
    return null;
  }, [agent.agency_rea_id, agent.agency_name, pulseAgencies]);

  const suburbs = useMemo(() => {
    try {
      const raw = agent.suburbs_active;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") return JSON.parse(raw);
      return [];
    } catch {
      return [];
    }
  }, [agent.suburbs_active]);

  const socials = useMemo(() => ({
    facebook: agent.social_facebook || null,
    instagram: agent.social_instagram || null,
    linkedin: agent.social_linkedin || null,
  }), [agent.social_facebook, agent.social_instagram, agent.social_linkedin]);

  /* #17 Keyboard nav when slideout is open.
   *   ← / →   prev/next within parent paginated list
   *   c       copy primary mobile
   *   e       mailto: primary email
   *   a       trigger Add-to-CRM dialog
   */
  useEffect(() => {
    function onKey(e) {
      // Ignore when user is typing in an input/textarea/contenteditable.
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") {
        if (onNavigate) { e.preventDefault(); onNavigate(-1); }
      } else if (e.key === "ArrowRight") {
        if (onNavigate) { e.preventDefault(); onNavigate(1); }
      } else if (e.key === "c" || e.key === "C") {
        if (agent.mobile) {
          e.preventDefault();
          copyToClipboard(agent.mobile, "mobile");
        }
      } else if (e.key === "e" || e.key === "E") {
        if (agent.email) {
          e.preventDefault();
          window.location.href = `mailto:${agent.email}`;
        }
      } else if (e.key === "a" || e.key === "A") {
        if (!agent.is_in_crm && onAddToCrm) {
          e.preventDefault();
          onAddToCrm(agent);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent, onNavigate, onAddToCrm]);

  /* Most-recent listing for the EnrichmentBadge header slot. Uses the
   * dossier's own listing list (server-side, pre-filtered to this agent).
   * Picks the row with the largest first_seen_at; falls back to the first
   * entry when dates are missing. Undefined when no listings. */
  const mostRecentListing = useMemo(() => {
    const list = (Array.isArray(agentDossier?.listings) ? agentDossier.listings : []);
    if (list.length === 0) return null;
    let best = list[0];
    let bestT = new Date(best.first_seen_at || 0).getTime();
    for (const l of list) {
      const t = new Date(l.first_seen_at || 0).getTime();
      if (t > bestT) { best = l; bestT = t; }
    }
    return best;
  }, [agentDossier]);

  const [watched, setWatched] = React.useState(() => readWatchlist("agent").has(String(agent?.id || "")));
  const handleWatch = () => {
    const next = toggleWatchlistId("agent", agent?.id);
    setWatched(next.has(String(agent?.id)));
    toast.success(next.has(String(agent?.id)) ? "Agent added to watchlist" : "Agent removed from watchlist");
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <SheetContent side="right" className="sm:max-w-3xl w-full p-0 overflow-y-auto">
        {/* ── Header ── */}
        <div className="sticky top-0 z-10 bg-background border-b border-border px-5 pt-5 pb-4 space-y-3">
          {/* Quick action ribbon — top slot above the name block. */}
          <QuickActionRibbon
            entity={agent}
            type="agent"
            onWatch={handleWatch}
            watched={watched}
            inCrm={!!agent?.is_in_crm}
            onOpenCrm={crmMapping?.crm_entity_id ? () => {
              window.location.href = createPageUrl("PersonDetails") + `?id=${crmMapping.crm_entity_id}`;
            } : null}
            label={agent?.full_name}
          />
          <div className="flex items-start gap-4">
            {hasHistory && onBack && (
              <button
                onClick={onBack}
                className="text-muted-foreground hover:text-foreground transition-colors p-1 -ml-1 rounded-md hover:bg-muted"
                title="Back"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <AgentAvatar agent={agent} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                <h2 className="text-base font-bold leading-tight">{agent.full_name}</h2>
                <PositionBadge position={position} />
                <ReaBadge />
                {/* Tier 3: when mapped, the In CRM badge links to the CRM page. */}
                {agent.is_in_crm && crmMapping?.crm_entity_id ? (
                  <Link
                    to={createPageUrl("PersonDetails") + `?id=${crmMapping.crm_entity_id}`}
                    replace={false}
                    className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800 px-1.5 py-0 text-[9px] font-medium leading-4 hover:underline"
                    title="Open CRM record"
                  >
                    In CRM
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                ) : (
                  <CrmStatusBadge inCrm={agent.is_in_crm} />
                )}
                {/* Enrichment state for their most-recent listing — one glance
                 * tells you whether the sold/active blocks below are working
                 * from a full enrichment pull or scrape-only snapshot. */}
                {mostRecentListing && (
                  <EnrichmentBadge listing={mostRecentListing} size="sm" />
                )}
              </div>
              {agent.job_title && (
                <p className="text-xs text-muted-foreground">{agent.job_title}</p>
              )}
            </div>
            {/* Close button is provided by <SheetContent>; we keep the right-hand
                slot empty so the built-in X has breathing room. */}
          </div>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ── Contact — SAFR-aware (source chip + lock + alternates + history) ── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Contact
              </h3>
              <BackfillEntityButton entityType="agent" entityId={agent.id} entity={agent} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 mb-0.5 flex items-center gap-1">
                  <Phone className="h-3 w-3" /> Mobile
                </span>
                <FieldWithSource
                  entityType="agent"
                  entityId={agent.id}
                  fieldName="mobile"
                  fallbackValue={agent.mobile}
                  size="sm"
                  inline
                />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 mb-0.5 flex items-center gap-1">
                  <Briefcase className="h-3 w-3" /> Job title
                </span>
                <FieldWithSource
                  entityType="agent"
                  entityId={agent.id}
                  fieldName="job_title"
                  fallbackValue={agent.job_title}
                  size="sm"
                  inline
                />
              </div>
              <div className="flex flex-col min-w-0 sm:col-span-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 mb-0.5 flex items-center gap-1">
                  <Mail className="h-3 w-3" /> Email
                </span>
                <FieldWithSource
                  entityType="agent"
                  entityId={agent.id}
                  fieldName="email"
                  fallbackValue={agent.email}
                  size="sm"
                  inline
                />
              </div>
              <div className="flex flex-col min-w-0 sm:col-span-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 mb-0.5 flex items-center gap-1">
                  <Hash className="h-3 w-3" /> Full name
                </span>
                <FieldWithSource
                  entityType="agent"
                  entityId={agent.id}
                  fieldName="full_name"
                  fallbackValue={agent.full_name}
                  size="sm"
                  inline
                />
              </div>
              {!agent.mobile && !agent.email && (
                <p className="text-xs text-muted-foreground sm:col-span-2">No contact info enriched yet</p>
              )}
            </div>
          </section>

          {/* ── Agency ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Agency
            </h3>
            {linkedAgency ? (
              <button
                onClick={() => onOpenEntity?.({ type: "agency", id: linkedAgency.id })}
                className="w-full flex flex-wrap items-center gap-3 text-sm text-left p-2 -m-2 rounded-md hover:bg-muted/50 transition-colors group"
                title="Open agency profile"
              >
                <div className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium group-hover:text-primary">
                    {agent.agency_name || linkedAgency.name || "—"}
                  </span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary" />
                </div>
                {agent.agency_suburb && (
                  <div className="flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">{agent.agency_suburb}</span>
                  </div>
                )}
                {linkedAgency.live_agent_count || linkedAgency.agent_count ? (
                  <span className="text-[10px] text-muted-foreground">
                    ({linkedAgency.live_agent_count || linkedAgency.agent_count} agents)
                  </span>
                ) : null}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <div className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium">{agent.agency_name || "—"}</span>
                </div>
                {agent.agency_suburb && (
                  <div className="flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">{agent.agency_suburb}</span>
                  </div>
                )}
                {agent.agency_rea_id && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Hash className="h-3 w-3" />
                    <span className="font-mono">{agent.agency_rea_id}</span>
                  </div>
                )}
                {agent.agency_name && !linkedAgency && (
                  <span className="text-[10px] text-muted-foreground/60">
                    Not yet synced — limited data
                  </span>
                )}
              </div>
            )}
          </section>

          {/* ── Stats ── */}
          {(() => {
            // AG02: 84% of agents have zero performance fields populated —
            // rendering a hollow grid of "—/—/—" is noise. Guard on any real
            // signal and fall back to a single-line status when nothing is
            // enriched yet.
            const hasAnyPerf = Boolean(
              agent.sales_as_lead ||
                agent.avg_sold_price ||
                agent.avg_days_on_market ||
                agent.rea_rating
            );

            // AG03: peer rank within agency_suburb by sales_as_lead desc.
            // Small-N floor: only compute when ≥5 agents exist in that suburb.
            // We use pulseAgents (the parent tab's current page) as the
            // candidate set — cheap, no extra fetch, consistent with the
            // filter-table context the user is already in.
            const peerRank = (() => {
              const suburb = agent.agency_suburb;
              if (!suburb) return null;
              const peers = pulseAgents.filter(
                (a) => a.agency_suburb === suburb,
              );
              if (peers.length < 5) return null;
              const sorted = [...peers].sort(
                (a, b) => (b.sales_as_lead ?? -1) - (a.sales_as_lead ?? -1),
              );
              const idx = sorted.findIndex((a) => a.id === agent.id);
              if (idx < 0) return null;
              const rank = idx + 1;
              const total = sorted.length;
              const pct = Math.max(1, Math.round((rank / total) * 100));
              return { rank, total, pct, suburb };
            })();

            if (!hasAnyPerf) {
              const activeCount = agent.total_listings_active ?? 0;
              return (
                <section className="space-y-2">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Performance
                  </h3>
                  <p className="text-xs text-muted-foreground italic">
                    Performance metrics pending enrichment — {activeCount} active listing{activeCount !== 1 ? "s" : ""} detected.
                  </p>
                  {peerRank && (
                    <p className="text-[10px] text-muted-foreground pt-1">
                      #{peerRank.rank} of {peerRank.total} in {peerRank.suburb} (sales as lead)
                    </p>
                  )}
                </section>
              );
            }
            return (
              <section className="space-y-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Performance
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-border p-3 text-center">
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {agent.sales_as_lead ?? "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Sales as Lead</p>
                  </div>
                  <div className="rounded-lg border border-border p-3 text-center">
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {fmtPrice(agent.avg_sold_price)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Median Sold</p>
                  </div>
                  <div className="rounded-lg border border-border p-3 text-center">
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {agent.avg_days_on_market > 0 ? `${agent.avg_days_on_market}d` : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Avg DOM</p>
                  </div>
                </div>
                {/* AG03: peer rank — small sub-label under the tile grid. */}
                {peerRank && (
                  <p className="text-[10px] text-muted-foreground pt-0.5 flex items-center gap-1.5">
                    <MapPin className="h-3 w-3" />
                    <span>
                      <span className="font-semibold text-foreground">Top {peerRank.pct}%</span>
                      {" "}in {peerRank.suburb}
                      <span className="opacity-70"> · #{peerRank.rank} of {peerRank.total}</span>
                    </span>
                  </p>
                )}
              </section>
            );
          })()}

          {/* ── Reviews ── */}
          {(agent.rea_rating || agent.rea_review_count > 0) && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Reviews
              </h3>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star
                      key={s}
                      className={cn(
                        "h-4 w-4",
                        s <= Math.round(agent.rea_rating || 0)
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/30"
                      )}
                    />
                  ))}
                </div>
                <span className="text-sm font-semibold">
                  {agent.rea_rating ? Number(agent.rea_rating).toFixed(1) : "—"}
                </span>
                {agent.rea_review_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {agent.rea_review_count} review{agent.rea_review_count !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </section>
          )}

          {/* ── Awards ── */}
          {agent.awards && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Awards
              </h3>
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 flex items-start gap-2">
                <Award className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300 whitespace-pre-line">{agent.awards}</p>
              </div>
            </section>
          )}

          {/* ── Specialty suburbs ── */}
          {suburbs.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Active Suburbs
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {suburbs.map((sub) => (
                  <Link
                    key={sub}
                    to={`/IndustryPulse?tab=agents&suburb=${encodeURIComponent(sub)}`}
                    onClick={() => onClose?.()}
                    title={`Filter agents by ${sub}`}
                  >
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-2 py-0.5 font-normal cursor-pointer hover:bg-primary/10 hover:text-primary transition-colors"
                    >
                      {sub}
                    </Badge>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* ── Social / Profile links ── */}
          {(socials.facebook || socials.instagram || socials.linkedin || agent.rea_profile_url) && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Links
              </h3>
              <div className="flex flex-wrap gap-2">
                {agent.rea_profile_url && (
                  <a
                    href={agent.rea_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    REA Profile
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {socials.facebook && (
                  <a
                    href={socials.facebook}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Facebook
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {socials.instagram && (
                  <a
                    href={socials.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-pink-600 dark:text-pink-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Instagram
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {socials.linkedin && (
                  <a
                    href={socials.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    LinkedIn
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </section>
          )}

          {/* ── Market Share + Retention (compact) ── */}
          {agent.rea_agent_id && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Market Share
              </h3>
              <AgentMarketShareSection
                compact
                agentReaId={agent.rea_agent_id}
                agentPulseId={agent.id}
                onOpenEntity={onOpenEntity}
              />
            </section>
          )}

          {/* ── Active Listings ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Active Listings ({agentListings.active.length})
            </h3>
            <MiniListingTable
              listings={agentListings.active}
              emptyMsg="No active listings found"
              onOpenListing={onOpenEntity ? (l) => onOpenEntity({ type: "listing", id: l.id }) : undefined}
            />
          </section>

          {/* ── Recently Sold ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Recently Sold ({agentListings.sold.length})
            </h3>
            <MiniListingTable
              listings={agentListings.sold}
              emptyMsg="No sold listings found"
              onOpenListing={onOpenEntity ? (l) => onOpenEntity({ type: "listing", id: l.id }) : undefined}
            />
          </section>

          {/* ── Timeline ── */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Timeline
            </h4>
            <PulseTimeline
              entries={slideoutTimeline}
              maxHeight="max-h-[300px]"
              emptyMessage="No timeline events for this agent"
              compact
            />
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="sticky bottom-0 bg-background border-t border-border px-5 py-3 flex items-center justify-between gap-3">
          {!agent.is_in_crm && (
            <Button size="sm" onClick={() => onAddToCrm(agent)} className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" />
              Add to CRM
            </Button>
          )}
          {!agent.rea_profile_url && agent.is_in_crm && (
            <span className="text-xs text-muted-foreground">Already in CRM</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* Tier 4: sync-run history for this agent */}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setSyncHistoryOpen(true)}
              title="See which sync runs touched this agent"
            >
              <History className="h-3.5 w-3.5" />
              Source history
            </Button>
            {agent.rea_profile_url && (
              <a
                href={agent.rea_profile_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ExternalLink className="h-3.5 w-3.5" />
                  View REA Profile
                </Button>
              </a>
            )}
          </div>
        </div>
      </SheetContent>
      {syncHistoryOpen && (
        <EntitySyncHistoryDialog
          entityType="agent"
          entityId={agent.id}
          entityLabel={agent.full_name}
          onClose={() => setSyncHistoryOpen(false)}
        />
      )}
    </Sheet>
  );
}

/* ── Main Component ──────────────────────────────────────────────────────── */

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const INTEGRITY_FILTERS = [
  { value: "all", label: "All quality" },
  { value: "high", label: "High (≥80)" },
  { value: "medium", label: "Medium (50–79)" },
  { value: "low", label: "Low (<50)" },
];

const MAPPING_FILTERS = [
  { value: "all", label: "All mapping" },
  { value: "mapped", label: "Mapped" },
  { value: "suggested", label: "Suggested" },
  { value: "unmapped", label: "Unmapped" },
];

const SORT_COLS = {
  sales_as_lead: (a) => a.sales_as_lead ?? -1,
  total_listings_active: (a) => a.total_listings_active ?? -1,
  avg_sold_price: (a) => a.avg_sold_price ?? -1,
  avg_days_on_market: (a) => a.avg_days_on_market ?? -1,
  rea_rating: (a) => a.rea_rating ?? -1,
  name: (a) => (a.full_name || "").toLowerCase(),
  agency: (a) => (a.agency_name || "").toLowerCase(),
  suburb: (a) => (a.agency_suburb || "").toLowerCase(),
  first_seen_at: (a) => (a.first_seen_at ? new Date(a.first_seen_at).getTime() : 0),
};

// UI-sort-key → DB column. PostgREST only understands real column names;
// our sort UI uses short human-ish keys that we translate here. Keys
// missing from this map fall back to sales_as_lead desc (a sensible default).
const SERVER_SORT_MAP = {
  sales_as_lead: "sales_as_lead",
  total_listings_active: "total_listings_active",
  avg_sold_price: "avg_sold_price",
  avg_days_on_market: "avg_days_on_market",
  rea_rating: "rea_rating",
  name: "full_name",
  agency: "agency_name",
  suburb: "agency_suburb",
  first_seen_at: "first_seen_at",
};

// CSV export cap (same rationale as PulseListings).
const CSV_EXPORT_CAP_AGENTS = 10000;

// localStorage — page-size choice + auto-refresh toggle persist per-tab.
const LS_PAGE_SIZE_KEY = "pulse_agents_page_size";
const LS_AUTO_REFRESH_KEY = "pulse_agents_auto_refresh";
const AUTO_REFRESH_INTERVAL_MS = 60_000;

function readStoredPageSize() {
  if (typeof window === "undefined") return 50;
  const raw = Number(window.localStorage.getItem(LS_PAGE_SIZE_KEY));
  return PAGE_SIZE_OPTIONS.includes(raw) ? raw : 50;
}
function readStoredAutoRefresh() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_AUTO_REFRESH_KEY) === "1";
}

export default function PulseAgentIntel({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  pulseTimeline = [],
  crmAgents = [],
  crmAgencies = [],
  pulseMappings = [],
  targetSuburbs = [],
  search = "",
  stats = {},
  addToCrmFromCommand,
  onClearAddToCrmFromCommand,
  onOpenEntity,
}) {
  // ── UI state ──────────────────────────────────────────────────────────────
  const [agentFilter, setAgentFilter] = useState("all"); // all | not_in_crm | in_crm
  const [integrityFilter, setIntegrityFilter] = useState("all"); // all | high | medium | low
  const [mappingFilter, setMappingFilter] = useState("all"); // all | mapped | suggested | unmapped
  // Region filter — Auditor-11 F1. "all" = no region constraint; otherwise we
  // filter agency_suburb ∈ (suburbs in the chosen region from pulse_target_suburbs).
  const [regionFilter, setRegionFilter] = useState("all");
  // Page size persists in localStorage so the user's choice survives reloads.
  const [pageSize, setPageSize] = useState(readStoredPageSize);
  const [agentSort, setAgentSort] = useState({ col: "sales_as_lead", dir: "desc" });

  // AG06: Tier 3 drill-through — pre-fill the suburb column filter from
  // ?suburb= when an Active Suburbs badge in an agent slideout (or future
  // deep-links) lands us on this tab. Mirrors the PulseListings pattern.
  const [searchParams, setSearchParams] = useSearchParams();
  const suburbParam = searchParams.get("suburb");
  const [agentColFilters, setAgentColFilters] = useState({ agency: "", suburb: suburbParam || "" });

  // View toggle (Table | Grid). Persisted in the URL so links are shareable.
  const agentsViewParam = searchParams.get("agents_view");
  const [view, setView] = useState(agentsViewParam === "grid" ? "grid" : "table");
  useEffect(() => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (view === "grid") np.set("agents_view", "grid");
      else np.delete("agents_view");
      return np;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Advanced filter panel — open/closed state + state values. These feed the
  // in-memory narrow after the server fetch (retention RPC and sales band
  // aren't server-indexable; activity / data-quality are applied server-side).
  const [advFiltersOpen, setAdvFiltersOpen] = useState(false);
  const [retentionBandFilter, setRetentionBandFilter] = useState("all"); // all | at_risk | mid | healthy
  const [missedThreshold, setMissedThreshold] = useState(0); // $ floor
  const [activityFilter, setActivityFilter] = useState("all"); // all | active | dormant
  const [salesBandFilter, setSalesBandFilter] = useState("all"); // all | low | mid | high
  const [dqTierFilter, setDqTierFilter] = useState("all"); // all | 90 | 70 | 50 | low
  // Saved views — localStorage. Name input lives in the panel.
  const [savedViews, setSavedViews] = useState(() => readSavedViews("agents"));
  const [newViewName, setNewViewName] = useState("");

  // Consume the URL param once seeded, so back/forward + refresh don't
  // re-seed the filter and the URL stays tidy.
  useEffect(() => {
    if (!suburbParam) return;
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      np.delete("suburb");
      return np;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suburbParam]);

  const [agentPage, setAgentPage] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [addToCrmCandidate, setAddToCrmCandidate] = useState(null);
  // Auto-refresh — opt-in, 60s. Same rationale as PulseListings.
  const [autoRefresh, setAutoRefresh] = useState(readStoredAutoRefresh);

  // #11 Bulk selection — Set of agent.id currently ticked in the table.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // #18 Quick-filter preset — one-at-a-time toggle. null = no preset.
  const [activePreset, setActivePreset] = useState(null);

  useEffect(() => {
    try { window.localStorage.setItem(LS_PAGE_SIZE_KEY, String(pageSize)); } catch { /* quota / SSR */ }
  }, [pageSize]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_AUTO_REFRESH_KEY, autoRefresh ? "1" : "0"); } catch { /* quota / SSR */ }
  }, [autoRefresh]);

  // AG04: distinct agency + suburb lists for the column-filter comboboxes.
  // Populated from the agents currently loaded in memory — the <datalist>
  // approach keeps zero JS weight vs. a full shadcn combobox; the browser
  // handles the dropdown + typeahead natively.
  const distinctAgencies = useMemo(
    () => [...new Set(pulseAgents.map((a) => a.agency_name).filter(Boolean))].sort(),
    [pulseAgents],
  );
  const distinctSuburbs = useMemo(
    () => [...new Set(pulseAgents.map((a) => a.agency_suburb).filter(Boolean))].sort(),
    [pulseAgents],
  );

  // ── Region filter derivations (Auditor-11 F1) ─────────────────────────────
  // Distinct regions for the dropdown + suburb list for the chosen region,
  // memoised off targetSuburbs (tiny list — ~150 rows — so this is ~free).
  const regions = useMemo(() => {
    const set = new Set();
    for (const s of targetSuburbs || []) {
      if (s?.region) set.add(s.region);
    }
    return Array.from(set).sort();
  }, [targetSuburbs]);
  const suburbsInRegion = useMemo(() => {
    if (regionFilter === "all") return null;
    return (targetSuburbs || [])
      .filter((s) => s?.region === regionFilter && s?.name)
      .map((s) => s.name);
  }, [targetSuburbs, regionFilter]);

  // ── Build mapping-status lookup keyed by pulse_agent_id ────────────────────
  const mappingByAgent = useMemo(() => {
    const m = new Map();
    for (const map of pulseMappings || []) {
      // entity_type 'agent' is the row key; falls back to pulse_id field if used
      const key = map.pulse_agent_id || map.pulse_entity_id || map.pulse_id;
      if (!key) continue;
      // Prefer "mapped" > "suggested" > anything else if multiple rows
      const cur = m.get(key);
      const conf = map.confidence || (map.crm_id ? "mapped" : null);
      if (!cur || (conf === "mapped" && cur !== "mapped")) m.set(key, conf);
    }
    return m;
  }, [pulseMappings]);

  // ── A3: CRM-entity-id lookup keyed by pulse_agent_id ──────────────────────
  // Used to wrap the row's "In CRM" badge in a <Link> to PersonDetails when we
  // can resolve a CRM id. Prefers mappings tagged `entity_type='agent'` so we
  // don't accidentally grab an agency mapping attached to the same pulse id.
  const crmIdByAgent = useMemo(() => {
    const m = new Map();
    for (const map of pulseMappings || []) {
      if (map.entity_type && map.entity_type !== "agent") continue;
      const key = map.pulse_agent_id || map.pulse_entity_id || map.pulse_id;
      const crmId = map.crm_entity_id || map.crm_id;
      if (!key || !crmId) continue;
      if (!m.has(key)) m.set(key, crmId);
    }
    return m;
  }, [pulseMappings]);

  // ── Auto-open Add-to-CRM dialog when triggered from CommandCenter ───────
  useEffect(() => {
    if (addToCrmFromCommand) {
      // Previously re-looked the agent up in the shared pulseAgents array;
      // post-refactor that array is empty at the page level. The Command
      // Center hands us the full agent row (from top_unmapped_agents RPC) so
      // we can pass it straight through.
      const agent = pulseAgents.find((a) => a.id === addToCrmFromCommand.id) || addToCrmFromCommand;
      if (agent) {
        setAddToCrmCandidate(agent);
      }
      // Clear the trigger so it doesn't re-fire on tab switch or re-render
      onClearAddToCrmFromCommand?.();
    }
    return () => {
      // Cleanup: ensure no stale trigger lingers if component unmounts mid-flow
    };
  }, [addToCrmFromCommand, pulseAgents, onClearAddToCrmFromCommand]);

  // ── Toggle sort ───────────────────────────────────────────────────────────
  const toggleSort = useCallback(
    (col) => {
      setAgentSort((prev) =>
        prev.col === col
          ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { col, dir: "desc" }
      );
      setAgentPage(0);
    },
    []
  );

  // ── Reset page on filter change (server-pagination refactor: all filters
  //    drive a new query, so the page index must reset or we'd page past).
  useEffect(() => {
    setAgentPage(0);
  }, [agentFilter, integrityFilter, mappingFilter, regionFilter, agentColFilters.agency, agentColFilters.suburb, search, agentSort.col, agentSort.dir, pageSize, activePreset, dqTierFilter, activityFilter, retentionBandFilter, salesBandFilter, missedThreshold]);

  // ── Server-side query builder ─────────────────────────────────────────────
  // Returns a PostgREST query with every server-applicable filter applied.
  // Mapping filter is the ONE filter that stays client-side — it depends on
  // pulseMappings which is a separate table fetch; joining would force a view.
  const buildQuery = useCallback((selectCols, withCount) => {
    let q = api._supabase
      .from("pulse_agents")
      .select(selectCols, withCount ? { count: "exact" } : undefined);

    // Status filter (in-CRM)
    if (agentFilter === "not_in_crm") q = q.eq("is_in_crm", false);
    else if (agentFilter === "in_crm") q = q.eq("is_in_crm", true);

    // Integrity score filter
    if (integrityFilter === "high") q = q.gte("data_integrity_score", 80);
    else if (integrityFilter === "medium") q = q.gte("data_integrity_score", 50).lt("data_integrity_score", 80);
    else if (integrityFilter === "low") q = q.lt("data_integrity_score", 50);

    // Data-quality tier (new, from advanced panel). Composes with integrityFilter.
    if (dqTierFilter === "90") q = q.gte("data_integrity_score", 90);
    else if (dqTierFilter === "70") q = q.gte("data_integrity_score", 70).lt("data_integrity_score", 90);
    else if (dqTierFilter === "50") q = q.gte("data_integrity_score", 50).lt("data_integrity_score", 70);
    else if (dqTierFilter === "low") q = q.lt("data_integrity_score", 50);

    // Activity filter — active = has active listings; dormant = zero.
    if (activityFilter === "active") q = q.gt("total_listings_active", 0);
    else if (activityFilter === "dormant") q = q.or("total_listings_active.eq.0,total_listings_active.is.null");

    // Column filters
    const agencyQ = (agentColFilters.agency || "").trim();
    if (agencyQ) {
      q = q.ilike("agency_name", `%${agencyQ.replace(/[%_]/g, "\\$&")}%`);
    }
    const suburbQ = (agentColFilters.suburb || "").trim();
    if (suburbQ) {
      q = q.ilike("agency_suburb", `%${suburbQ.replace(/[%_]/g, "\\$&")}%`);
    }

    // Region filter (Auditor-11 F1). Expanded into an `agency_suburb IN (...)`
    // clause. Guard against an empty list (would produce a PostgREST error
    // and also kill the page) by falling through to an impossible match.
    if (suburbsInRegion) {
      if (suburbsInRegion.length === 0) {
        q = q.eq("id", "00000000-0000-0000-0000-000000000000");
      } else {
        q = q.in("agency_suburb", suburbsInRegion);
      }
    }

    // B14: global search now uses the trigger-maintained `search_text` column
    // (primary + all alternates concatenated, lowercased) backed by a GIN
    // trigram index. One ilike substring match is both faster than the old
    // OR+JSONB-containment chain and automatically covers alternates.
    const globalQ = (search || "").trim();
    if (globalQ) {
      const s = globalQ.toLowerCase().replace(/[%_]/g, "\\$&");
      q = q.ilike("search_text", `%${s}%`);
    }

    // #18 Quick-filter preset — composed ON TOP of the other filters so a
    // chip acts as a one-click narrowing pass the user can still refine.
    let sortOverride = null;
    if (activePreset === "top20_not_in_crm") {
      q = q.gte("data_integrity_score", 80).eq("is_in_crm", false);
      sortOverride = { col: "sales_as_lead", dir: "desc" };
    } else if (activePreset === "awarded") {
      q = q.not("awards", "is", null);
    } else if (activePreset === "recently_added") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      q = q.gte("first_seen_at", sevenDaysAgo);
    } else if (activePreset === "high_rating") {
      q = q.gte("rea_rating", 4.5);
    }

    // Sort — translate UI sort-key to DB column, fall back to sales_as_lead.
    // Presets may override sort so the chip's intent is obvious ("Top 20" is
    // meaningless if sorted alphabetically).
    const sortCol = sortOverride
      ? sortOverride.col
      : (SERVER_SORT_MAP[agentSort.col] || "sales_as_lead");
    const sortDirAsc = sortOverride
      ? sortOverride.dir === "asc"
      : agentSort.dir === "asc";
    q = q.order(sortCol, { ascending: sortDirAsc, nullsFirst: false });

    // Preset hard-caps (e.g. "Top 20") applied via range at fetch-time below.
    return q;
  }, [agentFilter, integrityFilter, agentColFilters, search, agentSort, suburbsInRegion, activePreset, dqTierFilter, activityFilter]);

  // Page fetch
  const queryKey = useMemo(
    () => ["pulse-agents-page", {
      agentFilter, integrityFilter, regionFilter,
      agency: agentColFilters.agency, suburb: agentColFilters.suburb,
      search, sortCol: agentSort.col, sortDir: agentSort.dir,
      page: agentPage, pageSize, preset: activePreset,
      dqTierFilter, activityFilter,
    }],
    [agentFilter, integrityFilter, regionFilter, agentColFilters, search, agentSort, agentPage, pageSize, activePreset, dqTierFilter, activityFilter],
  );

  const { data: pageData, isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: async () => {
      const from = agentPage * pageSize;
      // #18 "Top 20" preset hard-caps result size to 20 regardless of page-size.
      const presetCap = activePreset === "top20_not_in_crm" ? 20 : null;
      // We overfetch by a modest factor when the mapping filter is engaged
      // so the client-side narrow has enough rows to populate a full page.
      // For non-mapping filters this is a plain single page.
      const overfetch = mappingFilter === "all" ? 0 : pageSize * 3;
      let to = from + pageSize - 1 + overfetch;
      if (presetCap != null) {
        to = Math.min(to, presetCap - 1);
        if (from >= presetCap) {
          return { rows: [], count: presetCap };
        }
      }
      const q = buildQuery("*", true).range(from, to);
      const { data: rows, count, error } = await q;
      if (error) throw error;
      const cappedCount = presetCap != null ? Math.min(count || 0, presetCap) : (count || 0);
      return { rows: rows || [], count: cappedCount };
    },
    keepPreviousData: true,
    staleTime: 30_000,
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  // Apply client-side narrowing filters (mapping status + sales band).
  // Retention band + missed $ are applied downstream once the bulk retention
  // RPC resolves (see retentionNarrowed below) so we keep the main `paginated`
  // snappy on first paint.
  const paginated = useMemo(() => {
    const rows = pageData?.rows || [];
    let out = rows;
    if (mappingFilter !== "all") {
      out = out.filter((a) => {
        const conf = mappingByAgent.get(a.id);
        if (mappingFilter === "mapped") return conf === "mapped" || a.is_in_crm;
        if (mappingFilter === "suggested") return conf === "suggested";
        if (mappingFilter === "unmapped") return !conf && !a.is_in_crm;
        return true;
      });
    }
    if (salesBandFilter !== "all") {
      out = out.filter((a) => {
        const s = Number(a.sales_as_lead || 0);
        if (salesBandFilter === "low") return s > 0 && s < 10;
        if (salesBandFilter === "mid") return s >= 10 && s < 30;
        if (salesBandFilter === "high") return s >= 30;
        return true;
      });
    }
    return out.slice(0, pageSize);
  }, [pageData, mappingFilter, mappingByAgent, pageSize, salesBandFilter]);

  // Bulk retention lookup for the CURRENT PAGE. One RPC per page render.
  // Keys are rea_agent_id strings — we filter out nulls in the hook itself.
  const visibleReaIds = useMemo(
    () => (paginated || []).map((a) => a.rea_agent_id).filter(Boolean),
    [paginated],
  );
  const { data: retentionMap, isFetching: retentionFetching } = useAgentsRetentionBulk(visibleReaIds);

  // Apply retention band + missed $ threshold filters using the resolved map.
  // These filters are purely cosmetic until retentionMap is non-empty — we
  // show ALL rows while the RPC is still in-flight, then narrow. No flicker
  // because chips render a "…" placeholder during the fetch.
  const retentionNarrowed = useMemo(() => {
    const hasRetentionFilter = retentionBandFilter !== "all" || (Number(missedThreshold) || 0) > 0;
    if (!hasRetentionFilter) return paginated;
    if (!retentionMap || retentionMap.size === 0) return paginated;
    return paginated.filter((a) => {
      const r = a.rea_agent_id ? retentionMap.get(String(a.rea_agent_id)) : null;
      const total = r?.total_listings || 0;
      const pct = Number(r?.retention_rate_pct || 0);
      const missed = Number(r?.missed_opportunity_value || 0);
      if ((Number(missedThreshold) || 0) > 0 && missed < Number(missedThreshold)) return false;
      if (retentionBandFilter !== "all") {
        if (total === 0) return false;
        const band = retentionBand(pct);
        if (band !== retentionBandFilter) return false;
      }
      return true;
    });
  }, [paginated, retentionMap, retentionBandFilter, missedThreshold]);

  const totalCount = pageData?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(agentPage, totalPages - 1);
  const showingStart = totalCount === 0 ? 0 : safePage * pageSize + 1;
  const showingEnd = Math.min(showingStart + (retentionNarrowed?.length || paginated.length) - 1, totalCount);

  // `filtered` is exposed to the CSV button; we reshape this to a lazy-ish
  // "server filtered count" so button disable logic still works.
  const filteredLength = totalCount;

  const [exporting, setExporting] = useState(false);
  // CSV export of currently-filtered set — fetches ENTIRE filtered set from
  // server (up to CSV_EXPORT_CAP_AGENTS), NOT just the current page.
  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const cap = Math.min(totalCount, CSV_EXPORT_CAP_AGENTS);
      if (totalCount > CSV_EXPORT_CAP_AGENTS) {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
          `Filter matches ${totalCount.toLocaleString()} agents. Only the first ${CSV_EXPORT_CAP_AGENTS.toLocaleString()} will export. Continue?`,
        );
        if (!ok) { setExporting(false); return; }
      }
      const all = [];
      for (let off = 0; off < cap; off += 1000) {
        const end = Math.min(off + 999, cap - 1);
        const { data: chunk, error } = await buildQuery("*", false).range(off, end);
        if (error) throw error;
        all.push(...(chunk || []));
        if (!chunk || chunk.length < 1000) break;
      }
      // Apply the mapping filter AFTER the fetch when active
      const filteredAll = mappingFilter === "all" ? all : all.filter((a) => {
        const conf = mappingByAgent.get(a.id);
        if (mappingFilter === "mapped") return conf === "mapped" || a.is_in_crm;
        if (mappingFilter === "suggested") return conf === "suggested";
        if (mappingFilter === "unmapped") return !conf && !a.is_in_crm;
        return true;
      });
      // #19 CSV export enhancements — additional columns, AU dd/mm/yyyy dates,
      // UTF-8 BOM (emitted by exportCsv) so Excel/Numbers reads UTF-8 cleanly.
      const header = [
        "full_name", "agency_name", "agency_suburb", "email", "mobile",
        "job_title", "data_integrity_score", "total_listings_active", "sales_as_lead",
        "avg_sold_price", "avg_days_on_market", "rea_rating", "is_in_crm",
        "rea_agent_id", "awards", "rea_profile_url", "suburbs_active",
        "years_experience", "first_seen_at", "social_linkedin", "last_synced_at",
      ];
      const shaped = filteredAll.map((r) => {
        let suburbsStr = "";
        try {
          const raw = r.suburbs_active;
          const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
          if (Array.isArray(list)) suburbsStr = list.join("; ");
        } catch { /* leave blank */ }
        return {
          ...r,
          suburbs_active: suburbsStr,
          first_seen_at: fmtDateAu(r.first_seen_at),
          last_synced_at: fmtDateAu(r.last_synced_at),
        };
      });
      exportCsv(`pulse_agents_${new Date().toISOString().slice(0, 10)}.csv`, header, shaped);
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`CSV export failed: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  }, [buildQuery, totalCount, mappingFilter, mappingByAgent]);

  function handleColFilterChange(col, val) {
    setAgentColFilters((prev) => ({ ...prev, [col]: val }));
    setAgentPage(0);
  }

  function handleFilterChange(f) {
    setAgentFilter(f);
    setAgentPage(0);
  }

  // #11 Bulk-select helpers — operate on the currently visible page.
  const visibleIds = useMemo(() => (retentionNarrowed || []).map((a) => a.id), [retentionNarrowed]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));
  const toggleSelectOne = useCallback((id, checked) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, [visibleIds, allVisibleSelected]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const selectedCount = selectedIds.size;

  // Clear stale selections that no longer correspond to a fetched row
  // (e.g. after switching filters). Keeps the sticky bar in sync.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    // Only remove IDs that are neither on the page nor previously kept
    // around; this is cheap because the set is small.
    const visible = new Set(visibleIds);
    let changed = false;
    const next = new Set();
    for (const id of selectedIds) {
      if (visible.has(id)) { next.add(id); }
      else { changed = true; }
    }
    // Preserve cross-page selections — but reset completely when the preset or filter changes.
    // We simplify: only prune on an *empty* page if the user has intentionally
    // cleared filters — otherwise keep the selection around.
    if (changed && visibleIds.length === 0) {
      setSelectedIds(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds]);

  // #11 Bulk actions.
  const selectedAgentsFromVisible = useMemo(
    () => (retentionNarrowed || []).filter((a) => selectedIds.has(a.id)),
    [retentionNarrowed, selectedIds],
  );

  const handleBulkAddToCrm = useCallback(() => {
    // Pick the first not-in-CRM agent from the selection to feed the
    // existing single-agent Add-to-CRM flow — the dialog handles creation
    // + dedup, and closing it pops the next candidate.
    const next = selectedAgentsFromVisible.find((a) => !a.is_in_crm);
    if (!next) {
      toast.info("All selected agents are already in CRM");
      return;
    }
    setAddToCrmCandidate(next);
  }, [selectedAgentsFromVisible]);

  const handleBulkExport = useCallback(() => {
    if (selectedAgentsFromVisible.length === 0) return;
    const header = [
      "full_name", "agency_name", "agency_suburb", "email", "mobile",
      "job_title", "data_integrity_score", "total_listings_active", "sales_as_lead",
      "avg_sold_price", "avg_days_on_market", "rea_rating", "is_in_crm",
      "rea_agent_id", "awards", "rea_profile_url", "suburbs_active",
      "years_experience", "first_seen_at", "social_linkedin", "last_synced_at",
    ];
    const shaped = selectedAgentsFromVisible.map((r) => {
      let suburbsStr = "";
      try {
        const raw = r.suburbs_active;
        const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
        if (Array.isArray(list)) suburbsStr = list.join("; ");
      } catch { /* */ }
      return {
        ...r,
        suburbs_active: suburbsStr,
        first_seen_at: fmtDateAu(r.first_seen_at),
        last_synced_at: fmtDateAu(r.last_synced_at),
      };
    });
    exportCsv(
      `pulse_agents_selected_${new Date().toISOString().slice(0, 10)}.csv`,
      header,
      shaped,
    );
  }, [selectedAgentsFromVisible]);

  // Final list the UI renders — after retention/missed$ narrowing.
  const renderRows = retentionNarrowed;

  // #17 Slideout navigation — map prev/next to neighbours in `renderRows`.
  const handleSlideoutNavigate = useCallback((dir) => {
    if (!selectedAgent || !renderRows?.length) return;
    const idx = renderRows.findIndex((a) => a.id === selectedAgent.id);
    if (idx < 0) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= renderRows.length) return;
    setSelectedAgent(renderRows[nextIdx]);
  }, [renderRows, selectedAgent]);

  // Save current filter state as a view (localStorage).
  const handleSaveView = () => {
    const name = (newViewName || "").trim();
    if (!name) { toast.error("Name your view first"); return; }
    const payload = {
      view,
      agentFilter, integrityFilter, mappingFilter, regionFilter,
      agentColFilters, agentSort, retentionBandFilter, missedThreshold,
      activityFilter, salesBandFilter, dqTierFilter, activePreset,
    };
    const next = addSavedView("agents", name, payload);
    setSavedViews(next);
    setNewViewName("");
    toast.success(`Saved view "${name}"`);
  };
  const handleLoadView = (payload) => {
    if (!payload) return;
    if (payload.view) setView(payload.view);
    if (payload.agentFilter != null) setAgentFilter(payload.agentFilter);
    if (payload.integrityFilter != null) setIntegrityFilter(payload.integrityFilter);
    if (payload.mappingFilter != null) setMappingFilter(payload.mappingFilter);
    if (payload.regionFilter != null) setRegionFilter(payload.regionFilter);
    if (payload.agentColFilters) setAgentColFilters(payload.agentColFilters);
    if (payload.agentSort) setAgentSort(payload.agentSort);
    if (payload.retentionBandFilter != null) setRetentionBandFilter(payload.retentionBandFilter);
    if (payload.missedThreshold != null) setMissedThreshold(payload.missedThreshold);
    if (payload.activityFilter != null) setActivityFilter(payload.activityFilter);
    if (payload.salesBandFilter != null) setSalesBandFilter(payload.salesBandFilter);
    if (payload.dqTierFilter != null) setDqTierFilter(payload.dqTierFilter);
    if (payload.activePreset !== undefined) setActivePreset(payload.activePreset);
    toast.success("View applied");
  };
  const handleDeleteView = (id) => {
    setSavedViews(deleteSavedView("agents", id));
  };

  // j/k keyboard navigation — jump to next/prev row without a slideout.
  // Only active when no modal/slideout is open and no input is focused.
  useEffect(() => {
    function onKey(e) {
      if (selectedAgent || addToCrmCandidate) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (!renderRows || renderRows.length === 0) return;
      e.preventDefault();
      const curId = window.__pulseAgentsKeyCursor || null;
      const curIdx = curId ? renderRows.findIndex((r) => r.id === curId) : -1;
      let nextIdx = curIdx < 0 ? 0 : (e.key === "j" ? curIdx + 1 : curIdx - 1);
      nextIdx = Math.max(0, Math.min(renderRows.length - 1, nextIdx));
      const target = renderRows[nextIdx];
      if (!target) return;
      window.__pulseAgentsKeyCursor = target.id;
      // Focus row if rendered — enter opens it
      const el = document.querySelector(`[data-pulse-agent-row="${target.id}"]`);
      if (el && typeof el.focus === "function") el.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renderRows, selectedAgent, addToCrmCandidate]);

  /* ── Render ── */
  return (
    <div className="space-y-3">
      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {[
          { key: "all",        label: "All Agents",  count: stats.totalAgents ?? 0 },
          { key: "not_in_crm", label: "Not in CRM",  count: stats.notInCrm ?? 0 },
          { key: "in_crm",     label: "In CRM",      count: stats.agentsInCrm ?? 0 },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => handleFilterChange(key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              agentFilter === key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
            )}
          >
            {label}
            <span
              className={cn(
                "tabular-nums rounded-full px-1.5 py-0 text-[9px] font-semibold",
                agentFilter === key
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {count.toLocaleString()}
            </span>
          </button>
        ))}

        {/* Integrity quality filter */}
        <select
          value={integrityFilter}
          onChange={(e) => { setIntegrityFilter(e.target.value); setAgentPage(0); }}
          className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
          title="Filter by data-integrity score"
        >
          {INTEGRITY_FILTERS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Mapping status filter */}
        <select
          value={mappingFilter}
          onChange={(e) => { setMappingFilter(e.target.value); setAgentPage(0); }}
          className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
          title="Filter by CRM-mapping status"
        >
          {MAPPING_FILTERS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Region filter (Auditor-11 F1) — expands to agency_suburb IN (...) */}
        {regions.length > 0 && (
          <select
            value={regionFilter}
            onChange={(e) => { setRegionFilter(e.target.value); setAgentPage(0); }}
            className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
            title="Filter by region — expands to all suburbs in that region"
          >
            <option value="all">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* View toggle — Table | Grid */}
          <div className="inline-flex items-center rounded-md border border-border bg-background overflow-hidden" role="group" aria-label="View mode">
            <button
              type="button"
              onClick={() => setView("table")}
              className={cn(
                "inline-flex items-center gap-1 px-2 h-7 text-[11px] font-medium transition-colors",
                view === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title="Table view"
            >
              <Table2 className="h-3 w-3" /> Table
            </button>
            <button
              type="button"
              onClick={() => setView("grid")}
              className={cn(
                "inline-flex items-center gap-1 px-2 h-7 text-[11px] font-medium transition-colors",
                view === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title="Grid view"
            >
              <LayoutGrid className="h-3 w-3" /> Grid
            </button>
          </div>

          {/* Advanced filter panel toggle */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => setAdvFiltersOpen((p) => !p)}
            title="Advanced filters"
          >
            <Sliders className="h-3 w-3" />
            Filters
            {(retentionBandFilter !== "all" || Number(missedThreshold) > 0 || activityFilter !== "all" || salesBandFilter !== "all" || dqTierFilter !== "all") && (
              <span className="inline-flex items-center h-4 min-w-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] tabular-nums">
                {[
                  retentionBandFilter !== "all" ? 1 : 0,
                  Number(missedThreshold) > 0 ? 1 : 0,
                  activityFilter !== "all" ? 1 : 0,
                  salesBandFilter !== "all" ? 1 : 0,
                  dqTierFilter !== "all" ? 1 : 0,
                ].reduce((a, b) => a + b, 0)}
              </span>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={handleExportCsv}
            disabled={filteredLength === 0 || exporting}
            title="Export filtered agents as CSV (server-side, up to 10k rows)"
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            CSV
          </Button>
          {/* Auto-refresh toggle — opt-in 60s. Agents data changes slowly. */}
          <label
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
            title="Auto-refresh every 60s"
          >
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              aria-label="Auto-refresh every 60s"
            />
            <span>Auto-refresh</span>
          </label>
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {isFetching ? (
              <Loader2 className="inline h-3 w-3 animate-spin" />
            ) : totalCount > 0 ? (
              `${showingStart.toLocaleString()}–${showingEnd.toLocaleString()} of ${totalCount.toLocaleString()}`
            ) : (
              "No results"
            )}
          </span>
        </div>
      </div>

      {/* ── #18 Quick-filter preset chips ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {[
          { key: "top20_not_in_crm", label: "Top 20 not in CRM" },
          { key: "awarded", label: "Awarded" },
          { key: "recently_added", label: "Recently added (<7d)" },
          { key: "high_rating", label: "High rating ≥4.5" },
        ].map((p) => {
          const active = activePreset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setActivePreset(active ? null : p.key)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground",
              )}
              title={active ? "Click to clear" : `Apply preset: ${p.label}`}
            >
              {p.label}
              {active && <X className="h-2.5 w-2.5" />}
            </button>
          );
        })}
      </div>

      {/* ── Advanced filter panel (collapsible) ── */}
      {advFiltersOpen && (
        <Card className="rounded-xl border border-border p-3 space-y-3 bg-muted/20">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sliders className="h-3.5 w-3.5 text-primary" />
              Advanced filters
            </div>
            <button
              type="button"
              onClick={() => {
                setRetentionBandFilter("all");
                setMissedThreshold(0);
                setActivityFilter("all");
                setSalesBandFilter("all");
                setDqTierFilter("all");
              }}
              className="text-[10px] text-primary hover:underline"
            >
              Reset advanced
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Retention band
              <select
                value={retentionBandFilter}
                onChange={(e) => setRetentionBandFilter(e.target.value)}
                className="h-7 text-xs normal-case tracking-normal rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All</option>
                <option value="at_risk">At risk (&lt;25%)</option>
                <option value="mid">Mid (25–75%)</option>
                <option value="healthy">Healthy (≥75%)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Missed $ ≥
              <input
                type="number"
                min="0"
                step="1000"
                value={missedThreshold || ""}
                onChange={(e) => setMissedThreshold(Number(e.target.value) || 0)}
                placeholder="0"
                className="h-7 text-xs normal-case tracking-normal rounded-md border bg-background px-2 tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Activity
              <select
                value={activityFilter}
                onChange={(e) => setActivityFilter(e.target.value)}
                className="h-7 text-xs normal-case tracking-normal rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All</option>
                <option value="active">Active (has listings)</option>
                <option value="dormant">Dormant (no active listings)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Sales volume
              <select
                value={salesBandFilter}
                onChange={(e) => setSalesBandFilter(e.target.value)}
                className="h-7 text-xs normal-case tracking-normal rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All</option>
                <option value="low">Low (1–9 sales as lead)</option>
                <option value="mid">Mid (10–29)</option>
                <option value="high">High (30+)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Data-quality tier
              <select
                value={dqTierFilter}
                onChange={(e) => setDqTierFilter(e.target.value)}
                className="h-7 text-xs normal-case tracking-normal rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All</option>
                <option value="90">90+</option>
                <option value="70">70–89</option>
                <option value="50">50–69</option>
                <option value="low">&lt;50</option>
              </select>
            </label>
          </div>
          {/* Saved views */}
          <div className="pt-2 border-t border-border/60 space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Save className="h-3 w-3" /> Saved views
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                placeholder="My view name…"
                className="h-7 flex-1 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleSaveView}>
                Save current
              </Button>
            </div>
            {savedViews.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {savedViews.map((v) => (
                  <span key={v.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background pl-2 pr-1 py-0.5 text-[10px]">
                    <button type="button" onClick={() => handleLoadView(v.payload)} className="hover:underline font-medium">
                      {v.name}
                    </button>
                    <button type="button" onClick={() => handleDeleteView(v.id)} className="rounded-full p-0.5 hover:bg-muted text-muted-foreground" aria-label={`Delete view ${v.name}`}>
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── AG05: Active-filter chips ── */}
      {(() => {
        const chips = [];
        if (search && search.trim()) {
          chips.push({ key: "search", label: "Search", value: search.trim(), onClear: null });
        }
        if (agentFilter !== "all") {
          const map = { not_in_crm: "Not in CRM", in_crm: "In CRM" };
          chips.push({
            key: "status",
            label: "Status",
            value: map[agentFilter] || agentFilter,
            onClear: () => setAgentFilter("all"),
          });
        }
        if (agentColFilters.agency && agentColFilters.agency.trim()) {
          chips.push({
            key: "agency",
            label: "Agency",
            value: agentColFilters.agency.trim(),
            onClear: () => handleColFilterChange("agency", ""),
          });
        }
        if (agentColFilters.suburb && agentColFilters.suburb.trim()) {
          chips.push({
            key: "suburb",
            label: "Suburb",
            value: agentColFilters.suburb.trim(),
            onClear: () => handleColFilterChange("suburb", ""),
          });
        }
        if (integrityFilter !== "all") {
          const lbl = INTEGRITY_FILTERS.find((f) => f.value === integrityFilter)?.label || integrityFilter;
          chips.push({
            key: "integrity",
            label: "Integrity",
            value: lbl,
            onClear: () => setIntegrityFilter("all"),
          });
        }
        if (mappingFilter !== "all") {
          const lbl = MAPPING_FILTERS.find((f) => f.value === mappingFilter)?.label || mappingFilter;
          chips.push({
            key: "mapping",
            label: "Mapping",
            value: lbl,
            onClear: () => setMappingFilter("all"),
          });
        }
        if (regionFilter !== "all") {
          chips.push({
            key: "region",
            label: "Region",
            value: regionFilter,
            onClear: () => setRegionFilter("all"),
          });
        }
        if (retentionBandFilter !== "all") {
          const lbl = retentionBandFilter === "at_risk" ? "At risk" : retentionBandFilter === "mid" ? "Mid" : "Healthy";
          chips.push({ key: "retention_band", label: "Retention", value: lbl, onClear: () => setRetentionBandFilter("all") });
        }
        if ((Number(missedThreshold) || 0) > 0) {
          chips.push({ key: "missed_thr", label: "Missed $", value: `≥ ${fmtMissedDollars(missedThreshold)}`, onClear: () => setMissedThreshold(0) });
        }
        if (activityFilter !== "all") {
          chips.push({ key: "activity", label: "Activity", value: activityFilter === "active" ? "Active" : "Dormant", onClear: () => setActivityFilter("all") });
        }
        if (salesBandFilter !== "all") {
          chips.push({ key: "sales_band", label: "Sales", value: salesBandFilter, onClear: () => setSalesBandFilter("all") });
        }
        if (dqTierFilter !== "all") {
          chips.push({ key: "dq_tier", label: "DQ", value: dqTierFilter === "low" ? "<50" : `${dqTierFilter}+`, onClear: () => setDqTierFilter("all") });
        }
        if (chips.length === 0) return null;
        const clearAll = () => {
          setAgentFilter("all");
          setIntegrityFilter("all");
          setMappingFilter("all");
          setRegionFilter("all");
          setAgentColFilters({ agency: "", suburb: "" });
          setRetentionBandFilter("all");
          setMissedThreshold(0);
          setActivityFilter("all");
          setSalesBandFilter("all");
          setDqTierFilter("all");
          setAgentPage(0);
        };
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <span
                key={c.key}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-[10px] text-foreground"
              >
                <span className="text-muted-foreground">{c.label}:</span>
                <span className="font-medium truncate max-w-[180px]">{c.value}</span>
                {c.onClear && (
                  <button
                    type="button"
                    onClick={c.onClear}
                    className="rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={`Clear ${c.label} filter`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ))}
            {chips.some((c) => c.onClear) && (
              <button
                type="button"
                onClick={clearAll}
                className="text-[10px] text-primary hover:underline px-1"
              >
                Clear all
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Grid view ── */}
      {view === "grid" && (
        <div>
          {isLoading && renderRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground/40 animate-spin" />
              Loading agents…
            </div>
          ) : renderRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
              No agents match your filters
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {renderRows.map((agent) => {
                  const isSelected = selectedIds.has(agent.id);
                  const ret = agent.rea_agent_id ? retentionMap?.get(String(agent.rea_agent_id)) : null;
                  const handleClick = () => {
                    if (onOpenEntity) onOpenEntity({ type: "agent", id: agent.id });
                    else setSelectedAgent(agent);
                  };
                  return (
                    <HoverCard key={agent.id} openDelay={400} closeDelay={120}>
                      <HoverCardTrigger asChild>
                        <Card
                          role="button"
                          tabIndex={0}
                          onClick={handleClick}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); } }}
                          className={cn(
                            "p-3 cursor-pointer hover:border-primary/40 transition-colors relative flex flex-col gap-2",
                            isSelected && "ring-2 ring-primary/40",
                          )}
                          aria-label={`Open ${agent.full_name || "agent"} details`}
                        >
                          <div className="absolute top-2 right-2 z-10" onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(v) => toggleSelectOne(agent.id, !!v)}
                              aria-label={`Select ${agent.full_name || "agent"}`}
                            />
                          </div>
                          <div className="flex items-start gap-3">
                            <AgentAvatar agent={agent} size={48} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1 flex-wrap mb-0.5">
                                <p className="text-sm font-semibold truncate">{agent.full_name || "—"}</p>
                                {agent.awards && <Award className="h-3 w-3 fill-amber-400 text-amber-500" title="Award recipient" />}
                              </div>
                              {agent.job_title && (
                                <p className="text-[11px] text-muted-foreground truncate">{agent.job_title}</p>
                              )}
                              <p className="text-[11px] text-muted-foreground truncate">
                                <Building2 className="inline h-3 w-3 mr-0.5 -mt-0.5" />
                                {agent.agency_name || "—"}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-wrap">
                            <CrmStatusBadge inCrm={agent.is_in_crm} />
                            <PositionBadge position={mapPosition(agent.job_title)} />
                            <MissedOppChip value={ret?.missed_opportunity_value} loading={!ret && retentionFetching} />
                            <RetentionChip pct={ret?.retention_rate_pct} total={ret?.total_listings} loading={!ret && retentionFetching} />
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/60">
                            <span title="Sales as lead (12m)">
                              <strong className="text-foreground tabular-nums">{agent.sales_as_lead ?? 0}</strong> sales
                            </span>
                            <span title="Average sold price">{fmtPrice(agent.avg_sold_price)}</span>
                            {agent.rea_rating > 0 && (
                              <span className="inline-flex items-center gap-0.5 tabular-nums">
                                <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                                {Number(agent.rea_rating).toFixed(1)}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-end gap-1 pt-1" onClick={(e) => e.stopPropagation()}>
                            <WatchButton type="agent" id={agent.id} size="sm" />
                            {!agent.is_in_crm && (
                              <button
                                type="button"
                                onClick={() => setAddToCrmCandidate(agent)}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
                                title="Add to CRM"
                              >
                                <UserPlus className="h-3 w-3" /> Add
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={handleClick}
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title="Open slideout"
                            >
                              <Eye className="h-3 w-3" /> Open
                            </button>
                          </div>
                        </Card>
                      </HoverCardTrigger>
                      <HoverCardContent align="start" className="w-72 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <AgentAvatar agent={agent} size={40} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">{agent.full_name}</p>
                            <p className="text-[11px] text-muted-foreground truncate">{agent.agency_name || "—"}</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="text-center rounded bg-muted/40 p-1.5">
                            <p className="text-sm font-bold tabular-nums">{agent.total_listings_active ?? 0}</p>
                            <p className="text-[9px] text-muted-foreground">Active</p>
                          </div>
                          <div className="text-center rounded bg-muted/40 p-1.5">
                            <p className="text-sm font-bold tabular-nums">{agent.sales_as_lead ?? 0}</p>
                            <p className="text-[9px] text-muted-foreground">Sales 12m</p>
                          </div>
                          <div className="text-center rounded bg-muted/40 p-1.5">
                            <p className="text-sm font-bold tabular-nums">{fmtPrice(agent.avg_sold_price)}</p>
                            <p className="text-[9px] text-muted-foreground">Avg sold</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                          <MissedOppChip value={ret?.missed_opportunity_value} loading={!ret && retentionFetching} />
                          <RetentionChip pct={ret?.retention_rate_pct} total={ret?.total_listings} loading={!ret && retentionFetching} />
                        </div>
                        {agent.agency_suburb && (
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-2.5 w-2.5" /> {agent.agency_suburb}
                          </p>
                        )}
                      </HoverCardContent>
                    </HoverCard>
                  );
                })}
              </div>
              {/* Grid pagination */}
              {totalCount > 0 && (
                <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                  <span>Page {safePage + 1} of {totalPages}</span>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setAgentPage((p) => Math.max(0, p - 1))}>
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setAgentPage((p) => Math.min(totalPages - 1, p + 1))}>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Table card ── */}
      {view === "table" && (
      <Card className="rounded-xl border-0 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            {/* ── thead ── */}
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {/* #11 Select-all-visible checkbox */}
                <th className="py-2.5 pl-3 pr-1 w-8">
                  <Checkbox
                    checked={allVisibleSelected ? true : (someVisibleSelected ? "indeterminate" : false)}
                    onCheckedChange={toggleSelectAllVisible}
                    aria-label="Select all visible agents"
                  />
                </th>
                {/* Photo */}
                <th className="py-2.5 pl-2 pr-2 w-10" />
                {/* Name */}
                <th
                  className="py-2.5 px-2 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("name")}
                >
                  Agent <SortIcon col="name" sort={agentSort} />
                </th>
                {/* Agency */}
                <th
                  className="py-2.5 px-2 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("agency")}
                >
                  Agency <SortIcon col="agency" sort={agentSort} />
                </th>
                {/* Email */}
                <th className="py-2.5 px-2 text-left font-medium text-muted-foreground hidden lg:table-cell whitespace-nowrap">
                  Email
                </th>
                {/* Mobile */}
                <th className="py-2.5 px-2 text-left font-medium text-muted-foreground hidden md:table-cell whitespace-nowrap">
                  Mobile
                </th>
                {/* Listings */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("total_listings_active")}
                >
                  Listings <SortIcon col="total_listings_active" sort={agentSort} />
                </th>
                {/* Sales */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("sales_as_lead")}
                >
                  Sales <SortIcon col="sales_as_lead" sort={agentSort} />
                </th>
                {/* Avg Price */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden sm:table-cell whitespace-nowrap"
                  onClick={() => toggleSort("avg_sold_price")}
                >
                  Avg Price <SortIcon col="avg_sold_price" sort={agentSort} />
                </th>
                {/* Days on Market */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden md:table-cell whitespace-nowrap"
                  onClick={() => toggleSort("avg_days_on_market")}
                >
                  DOM <SortIcon col="avg_days_on_market" sort={agentSort} />
                </th>
                {/* Rating */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden sm:table-cell whitespace-nowrap"
                  onClick={() => toggleSort("rea_rating")}
                >
                  Rating <SortIcon col="rea_rating" sort={agentSort} />
                </th>
                {/* Missed $ (bulk retention RPC) */}
                <th className="py-2.5 px-2 text-right font-medium text-muted-foreground hidden md:table-cell whitespace-nowrap" title="Missed opportunity over last 12 months">
                  Missed $
                </th>
                {/* Retention % */}
                <th className="py-2.5 px-2 text-right font-medium text-muted-foreground hidden lg:table-cell whitespace-nowrap" title="Retention rate over last 12 months">
                  Retention
                </th>
                {/* Captured */}
                <th className="py-2.5 px-2 text-right font-medium text-muted-foreground hidden xl:table-cell whitespace-nowrap" title="Listings converted to FlexStudios projects (12m)">
                  Captured
                </th>
                {/* Last synced */}
                <th className="py-2.5 px-2 text-right font-medium text-muted-foreground hidden xl:table-cell whitespace-nowrap">
                  Synced
                </th>
                {/* First seen (Added) — AG09: sortable column */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden xl:table-cell whitespace-nowrap"
                  onClick={() => toggleSort("first_seen_at")}
                  title="When this agent first appeared in Industry Pulse"
                >
                  Added <SortIcon col="first_seen_at" sort={agentSort} />
                </th>
                {/* CRM */}
                <th className="py-2.5 px-3 text-right font-medium text-muted-foreground whitespace-nowrap">
                  CRM
                </th>
              </tr>

              {/* ── Column filter row ── */}
              <tr className="border-b border-border bg-muted/20">
                <td colSpan={3} className="py-1 pl-3 pr-2">
                  {/* empty — checkbox + photo + name cols have no filter */}
                </td>
                {/* Agency filter — AG04: native combobox via datalist (distinct values from memory). */}
                <td className="py-1 px-2">
                  <input
                    type="text"
                    list="pulse-agent-agencies"
                    placeholder="Filter agency…"
                    value={agentColFilters.agency}
                    onChange={(e) => handleColFilterChange("agency", e.target.value)}
                    className="w-full min-w-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <datalist id="pulse-agent-agencies">
                    {distinctAgencies.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </td>
                {/* Email — no filter */}
                <td className="py-1 px-2 hidden lg:table-cell" />
                {/* Mobile — no filter */}
                <td className="py-1 px-2 hidden md:table-cell" />
                {/* Listings — no filter */}
                <td className="py-1 px-2" />
                {/* Sales — no filter */}
                <td className="py-1 px-2" />
                {/* Avg Price — no filter */}
                <td className="py-1 px-2 hidden sm:table-cell" />
                {/* DOM — no filter */}
                <td className="py-1 px-2 hidden md:table-cell" />
                {/* Rating — no filter */}
                <td className="py-1 px-2 hidden sm:table-cell" />
                {/* Missed $ — no filter */}
                <td className="py-1 px-2 hidden md:table-cell" />
                {/* Retention — no filter */}
                <td className="py-1 px-2 hidden lg:table-cell" />
                {/* Captured — no filter */}
                <td className="py-1 px-2 hidden xl:table-cell" />
                {/* Last-synced — no filter */}
                <td className="py-1 px-2 hidden xl:table-cell" />
                {/* Added (first_seen_at) — no filter */}
                <td className="py-1 px-2 hidden xl:table-cell" />
                {/* Suburb filter — AG04: native combobox via datalist. */}
                <td className="py-1 px-3">
                  <input
                    type="text"
                    list="pulse-agent-suburbs"
                    placeholder="Suburb…"
                    value={agentColFilters.suburb}
                    onChange={(e) => handleColFilterChange("suburb", e.target.value)}
                    className="w-full min-w-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <datalist id="pulse-agent-suburbs">
                    {distinctSuburbs.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </td>
              </tr>
            </thead>

            {/* ── tbody ── */}
            <tbody>
              {isLoading && renderRows.length === 0 && (
                <tr>
                  <td
                    colSpan={17}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground/40 animate-spin" />
                    Loading agents…
                  </td>
                </tr>
              )}
              {!isLoading && renderRows.length === 0 && (
                <tr>
                  <td
                    colSpan={17}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                    No agents match your filters
                  </td>
                </tr>
              )}

              {renderRows.map((agent) => {
                const position = mapPosition(agent.job_title);
                const isSelected = selectedIds.has(agent.id);
                // A1/URL-fallback: onOpenEntity is wired through sharedProps in
                // IndustryPulse.jsx, which also syncs the open entity into the
                // URL (`?pulse_id=…&entity_type=agent`). If a future caller
                // renders this tab standalone (tests, Storybook, ad-hoc host)
                // without that prop we fall back to the local slideout — no
                // URL sync, bookmark or back-button support. We warn in dev
                // so regressions surface immediately.
                const handleRowClick = () => {
                  if (onOpenEntity) {
                    onOpenEntity({ type: "agent", id: agent.id });
                  } else {
                    if (import.meta.env.DEV) {
                      // eslint-disable-next-line no-console
                      console.warn(
                        "[PulseAgentIntel] onOpenEntity prop missing; fallback slideout has no URL sync",
                      );
                    }
                    setSelectedAgent(agent);
                  }
                };
                return (
                  <ContextMenu key={agent.id}>
                    <ContextMenuTrigger asChild>
                      <tr
                        data-pulse-agent-row={agent.id}
                        className={cn(
                          "group border-b border-border/60 hover:bg-muted/40 cursor-pointer transition-colors focus:outline-none focus:bg-muted/60",
                          isSelected && "bg-primary/5",
                        )}
                        onClick={handleRowClick}
                        // A4: keyboard activation — treat the row as a button
                        // so Tab + Enter/Space opens the agent like clicking.
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleRowClick();
                          }
                        }}
                        aria-label={`Open ${agent.full_name || "agent"} details`}
                      >
                        {/* #11 row checkbox */}
                        <td className="py-2 pl-3 pr-1" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(v) => toggleSelectOne(agent.id, !!v)}
                            aria-label={`Select ${agent.full_name || "agent"}`}
                          />
                        </td>

                        {/* Photo */}
                        <td className="py-2 pl-2 pr-2">
                          <AgentAvatar agent={agent} size={32} />
                        </td>

                    {/* Name + badges */}
                    <td className="py-2 px-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="font-medium text-foreground truncate max-w-[160px]">
                            {agent.full_name || "—"}
                          </span>
                          {/* AG08: gold Award icon when agent has any award text
                              (only ~5.2% of agents — high-value outreach signal). */}
                          {agent.awards && (
                            <Award
                              className="h-3 w-3 flex-shrink-0 fill-amber-400 text-amber-500"
                              aria-label="Award recipient"
                              title={
                                String(agent.awards).length > 60
                                  ? `${String(agent.awards).slice(0, 60)}…`
                                  : String(agent.awards)
                              }
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                          <PositionBadge position={position} />
                          {agent.rea_agent_id && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground font-mono">
                              <Hash className="h-2.5 w-2.5" />
                              {String(agent.rea_agent_id).slice(0, 8)}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Agency + suburb — #15/#16 clickable to fill col filter */}
                    <td className="py-2 px-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        {agent.agency_name ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAgentColFilters((f) => ({ ...f, agency: agent.agency_name }));
                              setAgentPage(0);
                            }}
                            className="text-foreground truncate max-w-[160px] text-left hover:text-primary hover:underline underline-offset-2 decoration-dotted"
                            title={`Filter by agency: ${agent.agency_name}`}
                          >
                            {agent.agency_name}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {agent.agency_suburb && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAgentColFilters((f) => ({ ...f, suburb: agent.agency_suburb }));
                              setAgentPage(0);
                            }}
                            className="text-[10px] text-muted-foreground truncate max-w-[160px] text-left hover:text-primary hover:underline underline-offset-2 decoration-dotted"
                            title={`Filter by suburb: ${agent.agency_suburb}`}
                          >
                            {agent.agency_suburb}
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Email — hover-copy icon (#14) + +N badge when alt emails exist */}
                    <td className="py-2 px-2 hidden lg:table-cell">
                      {agent.email ? (
                        <div className="flex items-center gap-1">
                          <a
                            href={`mailto:${agent.email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-primary hover:underline truncate max-w-[160px] block"
                          >
                            {agent.email}
                          </a>
                          <CopyCellIcon value={agent.email} label="email" />
                          {(() => {
                            const alts = alternateContacts(agent, "email");
                            return alts.length > 0 ? (
                              <span
                                className="inline-flex items-center text-[9px] font-semibold px-1 py-0 rounded bg-muted text-muted-foreground shrink-0"
                                title={`${alts.length} other email${alts.length !== 1 ? "s" : ""} seen`}
                              >
                                +{alts.length}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Mobile — hover-copy icon (#14) + +N badge for alt mobiles */}
                    <td className="py-2 px-2 hidden md:table-cell">
                      {agent.mobile ? (
                        <div className="flex items-center gap-1">
                          <a
                            href={`tel:${agent.mobile}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-foreground hover:text-primary transition-colors whitespace-nowrap"
                          >
                            {agent.mobile}
                          </a>
                          <CopyCellIcon value={agent.mobile} label="mobile" />
                          {(() => {
                            const alts = alternateContacts(agent, "mobile");
                            return alts.length > 0 ? (
                              <span
                                className="inline-flex items-center text-[9px] font-semibold px-1 py-0 rounded bg-muted text-muted-foreground shrink-0"
                                title={`${alts.length} other mobile${alts.length !== 1 ? "s" : ""} seen`}
                              >
                                +{alts.length}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Listings */}
                    <td className="py-2 px-2 text-right tabular-nums">
                      <span className="font-medium">
                        {agent.total_listings_active ?? "—"}
                      </span>
                    </td>

                    {/* Sales */}
                    <td className="py-2 px-2 text-right tabular-nums">
                      <span className="font-medium">
                        {agent.sales_as_lead ?? "—"}
                      </span>
                    </td>

                    {/* Avg Price */}
                    <td className="py-2 px-2 text-right tabular-nums hidden sm:table-cell">
                      {fmtPrice(agent.avg_sold_price)}
                    </td>

                    {/* Days on Market */}
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                      {agent.avg_days_on_market > 0 ? `${agent.avg_days_on_market}d` : "—"}
                    </td>

                    {/* Rating */}
                    <td className="py-2 px-2 text-right hidden sm:table-cell">
                      <StarRating rating={agent.rea_rating} count={agent.rea_review_count} />
                    </td>

                    {/* Missed $ — from retentionMap */}
                    <td className="py-2 px-2 text-right hidden md:table-cell">
                      {(() => {
                        const r = agent.rea_agent_id ? retentionMap?.get(String(agent.rea_agent_id)) : null;
                        return <MissedOppChip value={r?.missed_opportunity_value} loading={!r && retentionFetching} />;
                      })()}
                    </td>

                    {/* Retention % */}
                    <td className="py-2 px-2 text-right hidden lg:table-cell">
                      {(() => {
                        const r = agent.rea_agent_id ? retentionMap?.get(String(agent.rea_agent_id)) : null;
                        return <RetentionChip pct={r?.retention_rate_pct} total={r?.total_listings} loading={!r && retentionFetching} />;
                      })()}
                    </td>

                    {/* Captured listings */}
                    <td className="py-2 px-2 text-right hidden xl:table-cell tabular-nums">
                      {(() => {
                        const r = agent.rea_agent_id ? retentionMap?.get(String(agent.rea_agent_id)) : null;
                        const n = r?.captured || 0;
                        return n > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{n}</span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        );
                      })()}
                    </td>

                    {/* Last synced — with stale badge when last_synced_at is >7d old */}
                    <td
                      className="py-2 px-2 text-right text-[10px] text-muted-foreground hidden xl:table-cell whitespace-nowrap"
                      title={agent.last_synced_at ? new Date(agent.last_synced_at).toLocaleString() : "Never synced"}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        {fmtAgo(agent.last_synced_at)}
                      </span>
                      {(() => {
                        const s = stalenessInfo(agent.last_synced_at);
                        return s.isStale ? (
                          <Badge variant="outline" className="text-[8px] px-1 ml-1 text-amber-700 border-amber-400/60">
                            {s.label}
                          </Badge>
                        ) : null;
                      })()}
                    </td>

                    {/* Added — first_seen_at (AG09) */}
                    <td
                      className="py-2 px-2 text-right text-[10px] text-muted-foreground hidden xl:table-cell whitespace-nowrap"
                      title={agent.first_seen_at ? new Date(agent.first_seen_at).toLocaleString() : "Unknown"}
                    >
                      {fmtAgo(agent.first_seen_at)}
                    </td>

                    {/* CRM status — A3: when the agent is mapped to a CRM
                        record, link the badge straight to PersonDetails so
                        you can jump without opening the slideout first. */}
                    <td className="py-2 px-3 text-right">
                      {(() => {
                        const linkedCrmId =
                          agent.linked_agent_id ||
                          (agent.is_in_crm ? crmIdByAgent.get(agent.id) : null);
                        if (agent.is_in_crm && linkedCrmId) {
                          return (
                            <Link
                              to={createPageUrl(`PersonDetails?id=${linkedCrmId}`)}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800 px-1.5 py-0 text-[9px] font-medium leading-4 hover:underline"
                              title="Open CRM record"
                            >
                              In CRM
                              <ExternalLink className="h-2.5 w-2.5" />
                            </Link>
                          );
                        }
                        return <CrmStatusBadge inCrm={agent.is_in_crm} />;
                      })()}
                    </td>
                      </tr>
                    </ContextMenuTrigger>
                    {/* #13 Right-click menu */}
                    <ContextMenuContent className="w-56">
                      <ContextMenuItem
                        disabled={!agent.mobile}
                        onSelect={() => copyToClipboard(agent.mobile, "phone")}
                      >
                        <Phone className="h-3.5 w-3.5 mr-2" />
                        Copy phone
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!agent.email}
                        onSelect={() => copyToClipboard(agent.email, "email")}
                      >
                        <Mail className="h-3.5 w-3.5 mr-2" />
                        Copy email
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!agent.rea_profile_url}
                        onSelect={() => {
                          if (agent.rea_profile_url) {
                            window.open(agent.rea_profile_url, "_blank", "noopener,noreferrer");
                          }
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-2" />
                        Open REA profile
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        disabled={!agent.agency_name}
                        onSelect={() => {
                          setAgentColFilters((f) => ({ ...f, agency: agent.agency_name || "" }));
                          setAgentPage(0);
                        }}
                      >
                        <Building2 className="h-3.5 w-3.5 mr-2" />
                        Filter by this agency
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!agent.agency_suburb}
                        onSelect={() => {
                          setAgentColFilters((f) => ({ ...f, suburb: agent.agency_suburb || "" }));
                          setAgentPage(0);
                        }}
                      >
                        <MapPin className="h-3.5 w-3.5 mr-2" />
                        Filter by this suburb
                      </ContextMenuItem>
                      {!agent.is_in_crm && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => setAddToCrmCandidate(agent)}>
                            <UserPlus className="h-3.5 w-3.5 mr-2" />
                            Add to CRM
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {totalCount > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20 gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Page {safePage + 1} of {totalPages}
              </span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setAgentPage(0); }}
                className="h-6 text-[11px] rounded border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
                title="Rows per page"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage === 0}
                onClick={() => setAgentPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage >= totalPages - 1}
                onClick={() => setAgentPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </Card>
      )}

      {/* ── Agent slideout ── */}
      {selectedAgent && (
        <AgentSlideout
          agent={selectedAgent}
          pulseAgents={pulseAgents}
          pulseAgencies={pulseAgencies}
          pulseListings={pulseListings}
          pulseTimeline={pulseTimeline}
          crmAgents={crmAgents}
          crmAgencies={crmAgencies}
          pulseMappings={pulseMappings}
          onClose={() => setSelectedAgent(null)}
          onAddToCrm={(agent) => {
            setSelectedAgent(null);
            setAddToCrmCandidate(agent);
          }}
          onNavigate={handleSlideoutNavigate}
        />
      )}

      {/* ── #11 Sticky bulk-action bar ── */}
      {selectedCount > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-border bg-background/95 backdrop-blur shadow-lg px-3 py-2">
          <span className="text-xs font-medium text-foreground px-2">
            {selectedCount} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs gap-1"
            onClick={handleBulkAddToCrm}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add to CRM
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => {
              for (const a of selectedAgentsFromVisible) toggleWatchlistId("agent", a.id);
              toast.success(`Toggled watch on ${selectedAgentsFromVisible.length} agent${selectedAgentsFromVisible.length !== 1 ? "s" : ""}`);
            }}
            title="Add/remove selected agents from watchlist"
          >
            <Bookmark className="h-3.5 w-3.5" />
            Watchlist
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={async () => {
              // Fire pulseDetailEnrich for the selected agents' listings via
              // the existing Edge Function. We collect each agent's active
              // listing rea_ids (from total_listings_active >0 rows loaded
              // in the page). The Edge Function queues them for enrichment.
              const reaIds = selectedAgentsFromVisible.map((a) => a.rea_agent_id).filter(Boolean);
              if (reaIds.length === 0) { toast.error("No rea_agent_ids on selected rows"); return; }
              try {
                const { error } = await api._supabase.functions.invoke("pulseDetailEnrich", {
                  body: { agent_rea_ids: reaIds, source: "pulse_agents_bulk" },
                });
                if (error) throw error;
                toast.success(`Queued enrichment for ${reaIds.length} agent${reaIds.length !== 1 ? "s" : ""}' listings`);
              } catch (err) {
                toast.error(`Enrichment queue failed: ${err?.message || err}`);
              }
            }}
            title="Queue pulseDetailEnrich for the selected agents' listings"
          >
            <Zap className="h-3.5 w-3.5" />
            Enrich
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={handleBulkExport}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
          <button
            type="button"
            onClick={clearSelection}
            className="ml-1 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Clear selection"
            title="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Add to CRM dialog ── */}
      {addToCrmCandidate && (
        <AddToCrmDialog
          agent={addToCrmCandidate}
          crmAgents={crmAgents}
          crmAgencies={crmAgencies}
          pulseMappings={pulseMappings}
          onClose={() => setAddToCrmCandidate(null)}
          onSuccess={() => setAddToCrmCandidate(null)}
        />
      )}
    </div>
  );
}
