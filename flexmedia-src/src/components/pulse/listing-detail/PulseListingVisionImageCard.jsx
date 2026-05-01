/**
 * PulseListingVisionImageCard — W15b.8
 *
 * Per-image card on the Vision Analysis tab. Mirrors the shortlisting
 * ShortlistingCard "Why?" expander pattern but adapted for external listings:
 *
 *   - Thumbnail: external CDN (REA/Domain) image, NOT Dropbox. We use a plain
 *     <img> with lazy loading + an error fallback (DroneThumbnail is wired
 *     to the Dropbox proxy, so it doesn't apply here).
 *   - Image type badge (is_day / is_dusk / is_drone / is_floorplan / etc).
 *   - "Why?" expander shows:
 *       * Stage 1 reasoning prose (composition_classifications.analysis)
 *       * Architecture & Style (style_archetype + era_hint + material_palette)
 *       * Package signals (external_specific.package_signals)
 *       * Competitor branding (external_specific.competitor_branding)
 *   - Click thumbnail → onOpenLightbox(idx) (parent owns the lightbox).
 */
import React, { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Sun,
  Sunset,
  Plane,
  FileImage,
  Camera,
  Video,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Image type → icon + label + tone ──────────────────────────────────────────

const IMAGE_TYPE_META = {
  is_day: { label: "day", Icon: Sun, tone: "border-yellow-300 text-yellow-700 dark:text-yellow-300" },
  is_dusk: { label: "dusk", Icon: Sunset, tone: "border-orange-300 text-orange-700 dark:text-orange-300" },
  is_drone: { label: "drone", Icon: Plane, tone: "border-sky-300 text-sky-700 dark:text-sky-300" },
  is_floorplan: { label: "floorplan", Icon: FileImage, tone: "border-purple-300 text-purple-700 dark:text-purple-300" },
  is_video_thumbnail: { label: "video thumb", Icon: Video, tone: "border-blue-300 text-blue-700 dark:text-blue-300" },
  is_video_frame: { label: "video frame", Icon: Video, tone: "border-blue-300 text-blue-700 dark:text-blue-300" },
  is_agent_headshot: { label: "agent", Icon: Camera, tone: "border-pink-300 text-pink-700 dark:text-pink-300" },
  is_facade_hero: { label: "facade hero", Icon: ImageIcon, tone: "border-emerald-300 text-emerald-700 dark:text-emerald-300" },
  is_detail_shot: { label: "detail", Icon: ImageIcon, tone: "border-stone-300 text-stone-700 dark:text-stone-300" },
  is_test_shot: { label: "test", Icon: ImageIcon, tone: "border-slate-300 text-slate-700 dark:text-slate-300" },
  is_bts: { label: "BTS", Icon: ImageIcon, tone: "border-slate-300 text-slate-700 dark:text-slate-300" },
  is_other: { label: "other", Icon: HelpCircle, tone: "border-slate-300 text-slate-500 dark:text-slate-400" },
};

function ImageTypeBadge({ imageType }) {
  if (!imageType) return null;
  const meta = IMAGE_TYPE_META[imageType] || {
    label: imageType.replace(/^is_/, "").replace(/_/g, " "),
    Icon: HelpCircle,
    tone: "border-slate-300 text-slate-600",
  };
  const Icon = meta.Icon;
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] h-5 px-1.5 inline-flex items-center gap-1 backdrop-blur-sm bg-background/85",
        meta.tone
      )}
      data-testid="image-type-badge"
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

export default function PulseListingVisionImageCard({
  classification,
  index,
  onOpenLightbox,
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const cls = classification || {};

  const imgSrc =
    cls.source_image_url ||
    cls.dropbox_preview_path || // best-effort fallback
    null;

  const imageType = cls.image_type || null;
  const analysis = cls.analysis || cls.reasoning || null;

  const ext = cls.external_specific || {};
  const packageSignals = Array.isArray(ext.package_signals) ? ext.package_signals : [];
  const competitorBranding = ext.competitor_branding || {};

  const styleArchetype = cls.style_archetype || ext.style_archetype || null;
  const eraHint = cls.era_hint || ext.era_hint || null;
  const materialPalette = Array.isArray(cls.material_palette_summary)
    ? cls.material_palette_summary
    : Array.isArray(ext.material_palette)
      ? ext.material_palette
      : [];

  const filename = cls.filename || cls.source_image_url || "—";
  // Truncate filenames so cards stay tidy on tablet.
  const shortName = (() => {
    const s = String(filename);
    if (s.length <= 32) return s;
    // For URLs, keep the last segment.
    try {
      const url = new URL(s);
      const seg = url.pathname.split("/").filter(Boolean).pop() || s;
      if (seg.length <= 32) return seg;
      return `…${seg.slice(-30)}`;
    } catch {
      return `${s.slice(0, 14)}…${s.slice(-14)}`;
    }
  })();

  const handleClickThumb = () => {
    if (typeof onOpenLightbox === "function") onOpenLightbox(index, classification);
  };

  return (
    <Card
      data-testid="vision-image-card"
      data-image-type={imageType || "unknown"}
      className="border-border/60 overflow-hidden flex flex-col"
    >
      {/* Thumbnail */}
      <div
        className="relative w-full aspect-[3/2] bg-muted cursor-pointer group"
        role="button"
        tabIndex={0}
        onClick={handleClickThumb}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClickThumb();
          }
        }}
      >
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={shortName}
            loading="lazy"
            className="w-full h-full object-cover transition-transform group-hover:scale-[1.01]"
            onError={(e) => {
              // Fallback to placeholder on broken URL
              e.currentTarget.style.display = "none";
              e.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden");
            }}
          />
        ) : null}
        <div
          data-fallback
          className={cn(
            "absolute inset-0 flex items-center justify-center text-muted-foreground",
            imgSrc ? "hidden" : ""
          )}
        >
          <ImageIcon className="h-8 w-8" />
        </div>

        {/* Top-left badge stack */}
        <div className="absolute top-1.5 left-1.5 flex flex-col items-start gap-1">
          <ImageTypeBadge imageType={imageType} />
        </div>
      </div>

      {/* Body */}
      <div className="p-2.5 flex-1 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="font-mono text-[10px] truncate text-muted-foreground" title={filename}>
            {shortName}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px] gap-0.5"
            onClick={(e) => {
              e.stopPropagation();
              setWhyOpen((v) => !v);
            }}
            data-testid="why-toggle"
            aria-expanded={whyOpen}
          >
            Why?
            {whyOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>

        {/* Quick-view: package signals row (always visible at-a-glance, even
            when "Why?" is collapsed — they're the key product-mix tells). */}
        {packageSignals.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="package-signals">
            {packageSignals.map((sig) => (
              <Badge
                key={sig}
                variant="outline"
                className="text-[9px] h-4 px-1.5 border-emerald-300 text-emerald-700 dark:text-emerald-300"
              >
                + {String(sig).replace(/_/g, " ")}
              </Badge>
            ))}
          </div>
        )}

        {/* "Why?" expander — full content surface */}
        {whyOpen && (
          <div
            className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-2 text-[11px]"
            data-testid="why-content"
          >
            {/* Stage 1 reasoning */}
            {analysis ? (
              <div>
                <div className="font-semibold text-foreground text-[10px] uppercase tracking-wide mb-0.5">
                  Stage 1 reasoning
                </div>
                <p className="text-foreground/90 leading-snug whitespace-pre-wrap">
                  {analysis}
                </p>
              </div>
            ) : (
              <div className="text-muted-foreground italic text-[10px]">
                No Stage 1 reasoning available.
              </div>
            )}

            {/* Architecture & Style */}
            {(styleArchetype || eraHint || materialPalette.length > 0) && (
              <div data-testid="architecture-style">
                <div className="font-semibold text-foreground text-[10px] uppercase tracking-wide mb-0.5">
                  Architecture & Style
                </div>
                <div className="flex flex-wrap gap-1">
                  {styleArchetype ? (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-slate-300 text-slate-700 dark:text-slate-300">
                      {styleArchetype}
                    </Badge>
                  ) : null}
                  {eraHint ? (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-slate-300 text-slate-600 dark:text-slate-400">
                      {eraHint}
                    </Badge>
                  ) : null}
                  {materialPalette.map((m) => (
                    <Badge
                      key={`mat-${m}`}
                      variant="outline"
                      className="text-[9px] h-4 px-1.5 border-stone-300 text-stone-600 dark:text-stone-400"
                    >
                      {m}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Competitor branding */}
            {(competitorBranding.watermark ||
              competitorBranding.photographer_credit ||
              competitorBranding.agency_logo) && (
              <div data-testid="competitor-branding">
                <div className="font-semibold text-foreground text-[10px] uppercase tracking-wide mb-0.5">
                  Competitor branding
                </div>
                <div className="flex flex-wrap gap-1">
                  {competitorBranding.watermark ? (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-purple-300 text-purple-700 dark:text-purple-300">
                      watermark: {String(competitorBranding.watermark).slice(0, 30)}
                    </Badge>
                  ) : null}
                  {competitorBranding.photographer_credit ? (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-purple-300 text-purple-700 dark:text-purple-300">
                      photographer: {competitorBranding.photographer_credit}
                    </Badge>
                  ) : null}
                  {competitorBranding.agency_logo ? (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-purple-300 text-purple-700 dark:text-purple-300">
                      agency: {String(competitorBranding.agency_logo).slice(0, 30)}
                    </Badge>
                  ) : null}
                </div>
              </div>
            )}

            {/* Confidence + override flag */}
            {(cls.requires_human_review === true || cls.confidence != null) && (
              <div className="flex items-center gap-1.5 text-[10px]">
                {cls.confidence != null && (
                  <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                    confidence {Number(cls.confidence).toFixed(2)}
                  </Badge>
                )}
                {cls.requires_human_review === true && (
                  <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-300 text-amber-700 dark:text-amber-300">
                    needs review
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
