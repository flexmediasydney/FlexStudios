/**
 * PulseListingVisionAggregateCard — W15b.8
 *
 * Top-of-tab summary card for a single pulse_listing_vision_extracts row.
 *
 * Surfaces:
 *   - Status pill (pending / running / succeeded(=fresh) / partial / failed /
 *     manually_overridden)
 *   - Photo breakdown counts (photo_breakdown JSONB)
 *   - Video breakdown summary (video_breakdown JSONB)
 *   - Competitor info (competitor JSONB)
 *   - Cost + vendor + extracted_at timestamp
 *   - Action buttons (master_admin only):
 *       Refresh   → invokes pulse-listing-vision-extract with force_refresh=true
 *       Manually classify → opens ManualClassifyDialog (master_admin override)
 *       Open in command center → links to PulseMissedOpportunityCommandCenter
 *
 * Defensive: when extract is null/undefined the card returns null so callers can
 * render an "empty" affordance instead.
 */
import React, { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Image as ImageIcon,
  Video,
  Clapperboard,
  Wand2,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  PencilLine,
  Banknote,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_LABEL = {
  pending: "Pending",
  running: "Running",
  succeeded: "Fresh",
  partial: "Partial",
  failed: "Failed",
  manually_overridden: "Manually overridden",
};

const STATUS_TONE = {
  pending: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-200",
  running: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300",
  succeeded: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300",
  partial: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300",
  failed: "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-300",
  manually_overridden: "bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-950/50 dark:text-purple-300",
};

const STATUS_ICON = {
  pending: Loader2,
  running: Loader2,
  succeeded: CheckCircle2,
  partial: AlertTriangle,
  failed: XCircle,
  manually_overridden: PencilLine,
};

function StatusPill({ status }) {
  const Icon = STATUS_ICON[status] || CheckCircle2;
  const spinning = status === "pending" || status === "running";
  return (
    <span
      data-testid="vision-status-pill"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        STATUS_TONE[status] || STATUS_TONE.pending
      )}
    >
      <Icon className={cn("h-3 w-3", spinning && "animate-spin")} />
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function fmtMoney(n) {
  if (n == null || isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v < 0.01 && v > 0) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PulseListingVisionAggregateCard({
  extract,
  classificationCount = 0,
  totalImagesOnListing = 0,
  isMasterAdmin = false,
  refreshing = false,
  onRefresh,
  onManualClassify,
  listingId,
}) {
  // The contract: this card only renders when extract is present. Callers
  // handle the null case with a separate empty-state CTA.
  if (!extract) return null;

  const status = extract.status || "pending";
  const photo = extract.photo_breakdown || {};
  const video = extract.video_breakdown || null;
  const competitor = extract.competitor || {};

  // Photo breakdown chips — only render counts > 0 to keep the strip compact.
  const photoChips = useMemo(() => {
    const items = [
      { key: "day_count", label: "day", count: photo.day_count },
      { key: "dusk_count", label: "dusk", count: photo.dusk_count },
      { key: "drone_count", label: "drone", count: photo.drone_count },
      { key: "floorplan_count", label: "floorplan", count: photo.floorplan_count },
      { key: "detail_count", label: "detail", count: photo.detail_count },
      { key: "video_thumbnail_count", label: "video thumb", count: photo.video_thumbnail_count },
      { key: "agent_headshot_count", label: "agent", count: photo.agent_headshot_count },
    ];
    return items.filter((it) => Number(it.count) > 0);
  }, [photo]);

  // Detected package = a derived signal: dusk + drone + floorplan + video presence
  // → "Day Video + N dusk add-ons" type label. Compute lightly here so the
  // card surfaces a one-line "what package did the competitor deliver" hint
  // without a separate roundtrip.
  const detectedPackage = useMemo(() => {
    const parts = [];
    if (video?.present) parts.push(video.dusk_segments_count > 0 ? "Dusk Video" : "Day Video");
    if (Number(photo.dusk_count) > 0) parts.push(`+ ${photo.dusk_count} dusk`);
    if (Number(photo.drone_count) > 0) parts.push(`+ ${photo.drone_count} drone`);
    if (Number(photo.floorplan_count) > 0) parts.push(`+ floorplan`);
    if (parts.length === 0 && Number(photo.day_count) > 0) parts.push(`Day photos × ${photo.day_count}`);
    return parts.join(" ");
  }, [photo, video]);

  const totalImages = Number(photo.total_images ?? 0);
  const fullCoverage = totalImagesOnListing > 0 && classificationCount >= totalImagesOnListing;

  const commandCenterUrl = createPageUrl(
    `PulseMissedOpportunityCommandCenter?listing=${listingId || extract.listing_id || ""}`
  );

  return (
    <Card data-testid="vision-aggregate-card" className="border-border/60">
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <div className="text-sm font-semibold">Vision Analysis</div>
          <StatusPill status={status} />
          <Badge variant="outline" className="text-[10px]">
            Vision {extract.schema_version || "v1.0"}
          </Badge>
          {totalImages > 0 && (
            <Badge variant="outline" className="text-[10px]" data-testid="coverage-badge">
              {classificationCount}/{totalImages} ext.
              {fullCoverage ? " · full" : ""}
            </Badge>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {fmtDate(extract.extracted_at)}
          </span>
        </div>

        {/* Failure reason */}
        {status === "failed" && extract.failed_reason && (
          <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800/50 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            <div className="font-semibold uppercase tracking-wide text-[10px] mb-0.5">Failed</div>
            {extract.failed_reason}
          </div>
        )}

        {/* Loading hint */}
        {(status === "pending" || status === "running") && (
          <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800/50 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            Vision extraction in progress — counts will refresh when complete.
          </div>
        )}

        {/* Cost + vendor */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Banknote className="h-3.5 w-3.5" />
            <span>Cost: <span className="font-semibold tabular-nums text-foreground">{fmtMoney(extract.total_cost_usd)}</span></span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span>Vendor: <span className="font-mono text-foreground">{extract.model_version || extract.vendor || "—"}</span></span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span>Tokens: <span className="tabular-nums text-foreground">{(extract.total_input_tokens || 0) + (extract.total_output_tokens || 0)}</span></span>
          </div>
        </div>

        {/* Photo breakdown */}
        {photoChips.length > 0 && (
          <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1" data-testid="photo-breakdown">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <ImageIcon className="h-3 w-3" /> Photos
            </div>
            <div className="flex flex-wrap gap-1.5">
              {photoChips.map((chip) => (
                <Badge
                  key={chip.key}
                  variant="outline"
                  className="text-[10px] h-5 border-slate-300 text-slate-700 dark:text-slate-300"
                >
                  <span className="font-semibold tabular-nums mr-1">{chip.count}</span>
                  {chip.label}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Video breakdown */}
        {video && (video.present || video.frames_extracted > 0) && (
          <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1" data-testid="video-breakdown">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Video className="h-3 w-3" /> Video
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-foreground/90">
              <Badge variant="outline" className="text-[10px] h-5">
                present
              </Badge>
              {video.total_duration_s ? (
                <Badge variant="outline" className="text-[10px] h-5 tabular-nums">
                  {`${Math.floor(video.total_duration_s / 60)}:${String(Math.round(video.total_duration_s % 60)).padStart(2, "0")}`}
                </Badge>
              ) : null}
              {Number(video.day_segments_count) > 0 && (
                <Badge variant="outline" className="text-[10px] h-5">{video.day_segments_count} day seg</Badge>
              )}
              {Number(video.dusk_segments_count) > 0 ? (
                <Badge variant="outline" className="text-[10px] h-5">{video.dusk_segments_count} dusk seg</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] h-5 border-amber-300 text-amber-700 dark:text-amber-300">
                  NO dusk footage
                </Badge>
              )}
              {Number(video.drone_segments_count) > 0 && (
                <Badge variant="outline" className="text-[10px] h-5">{video.drone_segments_count} drone seg</Badge>
              )}
              {video.agent_in_frame ? (
                <Badge variant="outline" className="text-[10px] h-5 border-blue-300 text-blue-700 dark:text-blue-300">agent in frame</Badge>
              ) : null}
              {video.car_in_frame ? (
                <Badge variant="outline" className="text-[10px] h-5">car visible</Badge>
              ) : null}
              {video.narrator_inferred ? (
                <Badge variant="outline" className="text-[10px] h-5">narrator</Badge>
              ) : null}
            </div>
          </div>
        )}

        {/* Competitor */}
        {(competitor.photographer_credit || competitor.dominant_brand_inferred || competitor.agency_logo || competitor.watermark_visible) && (
          <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1" data-testid="competitor-breakdown">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Clapperboard className="h-3 w-3" /> Competitor
            </div>
            <div className="text-[11px] text-foreground/90 flex flex-wrap items-center gap-1.5">
              {competitor.photographer_credit && (
                <span className="font-medium">{competitor.photographer_credit}</span>
              )}
              {competitor.dominant_brand_inferred && (
                <>
                  <span className="text-muted-foreground">@</span>
                  <span className="font-medium">{competitor.dominant_brand_inferred}</span>
                </>
              )}
              {competitor.watermark_visible && (
                <Badge variant="outline" className="text-[10px] h-5">watermark</Badge>
              )}
              {competitor.agency_logo && (
                <Badge variant="outline" className="text-[10px] h-5">agency logo</Badge>
              )}
            </div>
          </div>
        )}

        {/* Detected package */}
        {detectedPackage && (
          <div className="text-xs">
            <span className="text-muted-foreground">Detected package:</span>{" "}
            <span className="font-semibold">{detectedPackage}</span>
          </div>
        )}

        {/* Manual override metadata */}
        {status === "manually_overridden" && extract.manual_override_reason && (
          <div className="rounded-md border border-purple-200 bg-purple-50 dark:bg-purple-950/20 dark:border-purple-800/50 px-3 py-2 text-xs text-purple-700 dark:text-purple-300">
            <div className="font-semibold uppercase tracking-wide text-[10px] mb-0.5">Manually overridden</div>
            {extract.manual_override_reason}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isMasterAdmin && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={refreshing || status === "running" || status === "pending"}
                onClick={onRefresh}
                data-testid="refresh-vision-btn"
                className="h-7 text-[11px]"
              >
                {refreshing ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onManualClassify}
                data-testid="manual-classify-btn"
                className="h-7 text-[11px]"
              >
                <Wand2 className="h-3 w-3 mr-1" />
                Manually classify
              </Button>
            </>
          )}
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] ml-auto"
            data-testid="open-command-center-btn"
          >
            <a href={commandCenterUrl}>
              <ExternalLink className="h-3 w-3 mr-1" />
              Open in command center
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
