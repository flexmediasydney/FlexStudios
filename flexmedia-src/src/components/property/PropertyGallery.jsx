/**
 * PropertyGallery — full thumbnail grid surfaced on PropertyDetails ABOVE the
 * tab rail so the user can scan every photo without stepping into the lightbox.
 *
 * Click any thumbnail → opens AttachmentLightbox pre-selected at that index.
 *
 * Props (one of `listings` or `photos` is required):
 *   listings    — array of listing rows; we aggregate photos via the canonical
 *                 `parseMediaItems` helper. This is the preferred path since it
 *                 keeps PropertyGallery wire-compatible with the rest of the
 *                 pulse surfaces without duplicating photo-shape logic.
 *   photos      — optional pre-aggregated array of { file_name, file_url,
 *                 file_type, _agency?, _date? }. Takes precedence when set.
 *   maxVisible  — perf cap; when photo count > this, we render first N + a
 *                 "View all (N)" button that opens the lightbox at index 0
 *                 (default 24)
 *
 * Edge cases:
 *   • no photos → muted "No photos yet" placeholder (never a bare card)
 *   • image load error → fade the tile to 30% so it doesn't hide the grid
 *
 * NOTE: this component intentionally renders only photos. Floorplans/videos
 * stay in the Media tab since they need different affordances (pan-zoom
 * floorplan, embedded video) and would crowd the header grid.
 */
import React, { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Images } from "lucide-react";
import { cn } from "@/lib/utils";
import AttachmentLightbox from "@/components/common/AttachmentLightbox";
import { parseMediaItems } from "@/components/pulse/utils/listingHelpers";

function fmtShortDate(d) {
  if (!d) return null;
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  } catch { return null; }
}

function aggregatePhotosFromListings(listings) {
  if (!Array.isArray(listings) || listings.length === 0) return [];
  const out = [];
  for (const l of listings) {
    const media = parseMediaItems(l);
    const listPhotos = media.photos.length > 0
      ? media.photos.map((p) => p.url)
      : (l.hero_image ? [l.hero_image] : []);
    listPhotos.forEach((url, i) => {
      if (!url) return;
      out.push({
        file_name: `${l.agency_name || "Listing"} — ${fmtShortDate(l.listed_date) || "—"} (${i + 1})`,
        file_url: url,
        file_type: "image/jpeg",
        _agency: l.agency_name,
        _date: l.listed_date,
      });
    });
  }
  return out;
}

export default function PropertyGallery({ listings, photos: photosProp, maxVisible = 24 }) {
  const [lightboxIndex, setLightboxIndex] = useState(null);

  const photos = useMemo(() => {
    if (Array.isArray(photosProp)) return photosProp;
    return aggregatePhotosFromListings(listings);
  }, [photosProp, listings]);

  const total = photos?.length || 0;
  const visible = total > maxVisible ? photos.slice(0, maxVisible) : photos || [];
  const hiddenCount = Math.max(0, total - visible.length);

  const openLightbox = (idx) => {
    try {
      setLightboxIndex(idx);
    } catch (err) {
      // Graceful fallback — lightbox setup failures shouldn't crash the page.
      // eslint-disable-next-line no-console
      console.warn("PropertyGallery: failed to open lightbox", err);
    }
  };

  if (total === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-8 text-center">
          <Images className="h-8 w-8 mx-auto mb-2 opacity-30 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No photos yet for this property.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Images className="h-4 w-4 text-blue-600" />
              Gallery
              <Badge variant="outline" className="text-[10px]">{total}</Badge>
            </CardTitle>
            {hiddenCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => openLightbox(0)}
              >
                View all ({total})
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
            {visible.map((p, i) => (
              <button
                key={`${p.file_url || "ph"}-${i}`}
                type="button"
                onClick={() => openLightbox(i)}
                className={cn(
                  "aspect-square overflow-hidden rounded bg-muted group relative",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  "transition-opacity hover:opacity-90",
                )}
                title={p.file_name || `Photo ${i + 1}`}
                aria-label={`Open photo ${i + 1} of ${total}`}
              >
                {p.file_url ? (
                  <img
                    src={p.file_url}
                    alt={p.file_name || `Photo ${i + 1}`}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.opacity = 0.3;
                    }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Images className="h-4 w-4 opacity-30" />
                  </div>
                )}
                {i === 0 && total > 1 && (
                  <span
                    className={cn(
                      "absolute bottom-1 left-1 rounded bg-black/70 text-white",
                      "text-[9px] leading-none px-1.5 py-0.5 tabular-nums backdrop-blur",
                    )}
                  >
                    1 / {total}
                  </span>
                )}
                {i === visible.length - 1 && hiddenCount > 0 && (
                  <span
                    className={cn(
                      "absolute inset-0 flex items-center justify-center",
                      "bg-black/55 text-white text-xs font-semibold backdrop-blur-sm",
                    )}
                  >
                    +{hiddenCount} more
                  </span>
                )}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {lightboxIndex !== null && (
        <AttachmentLightbox
          files={photos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
