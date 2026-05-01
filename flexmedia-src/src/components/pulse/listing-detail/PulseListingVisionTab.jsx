/**
 * PulseListingVisionTab — W15b.8
 *
 * Vision Analysis tab content for the per-listing detail page.
 *
 * Data sources:
 *   - pulse_listing_vision_extracts row by listing_id (one per schema_version)
 *   - composition_classifications WHERE pulse_listing_id = ?
 *
 * Behaviour:
 *   - When NO extract row exists → empty state with "Run now" button (master_admin
 *     only). The button POSTs to the W15b.1 edge fn.
 *   - When extract.status='pending' or 'running' → loading skeleton.
 *   - When extract.status='failed' → red error card + retry button (master_admin).
 *   - When extract has rows → aggregate card + per-image grid.
 *
 * Build-time defensiveness: W15b.1 + .2 may not have shipped to production
 * when this lands; queries fail gracefully (table missing → 404 PostgREST →
 * shows the empty state).
 */
import React, { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/components/auth/PermissionGuard";
import PulseListingVisionAggregateCard from "./PulseListingVisionAggregateCard";
import PulseListingVisionImageCard from "./PulseListingVisionImageCard";
import ManualClassifyDialog from "./ManualClassifyDialog";
import ExternalListingLightbox from "./ExternalListingLightbox";
import { parseMediaItems } from "@/components/pulse/utils/listingHelpers";

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useVisionExtract(listingId) {
  return useQuery({
    enabled: Boolean(listingId),
    queryKey: ["pulse-listing-vision-extract", listingId],
    queryFn: async () => {
      // Direct supabase call — the table may not be registered as an entity
      // and we want to preserve the schema_version filter.
      const { data, error } = await supabase
        .from("pulse_listing_vision_extracts")
        .select("*")
        .eq("listing_id", listingId)
        .order("created_at", { ascending: false })
        .limit(1);
      // Tolerate the table-doesn't-exist case (W15b.2 not yet deployed) by
      // returning null instead of bubbling. Real errors still throw.
      if (error) {
        const code = error?.code || "";
        const msg = error?.message || "";
        if (code === "PGRST205" || /relation .* does not exist/i.test(msg)) {
          return null;
        }
        throw new Error(msg || "Failed to load vision extract.");
      }
      return data?.[0] || null;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

function useVisionClassifications(listingId) {
  return useQuery({
    enabled: Boolean(listingId),
    queryKey: ["pulse-listing-vision-classifications", listingId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("composition_classifications")
        .select(
          [
            "id",
            "filename",
            "image_type",
            "source_image_url",
            "source_video_frame_index",
            "analysis",
            "confidence",
            "requires_human_review",
            "style_archetype",
            "era_hint",
            "material_palette_summary",
            "external_specific",
            "observed_objects",
            "observed_attributes",
            "schema_version",
            "created_at",
          ].join(",")
        )
        .eq("pulse_listing_id", listingId)
        .eq("source_type", "external_listing")
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) {
        const msg = error?.message || "";
        if (/column .* does not exist/i.test(msg) || error?.code === "PGRST204") {
          // Linking columns from migration 400 not deployed yet
          return [];
        }
        throw new Error(msg || "Failed to load classifications.");
      }
      return data || [];
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

// ── Empty / loading / error states ───────────────────────────────────────────

function EmptyState({ canRun, onRun, running }) {
  return (
    <Card data-testid="vision-empty-state" className="border-dashed">
      <CardContent className="p-6 text-center space-y-3">
        <div className="flex justify-center">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-1">Vision analysis hasn't been run yet</h3>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            When this listing is enriched, Gemini will classify each image (day / dusk /
            drone / floorplan) and detect competitor branding to infer the package the
            agent delivered.
          </p>
        </div>
        {canRun && (
          <Button size="sm" onClick={onRun} disabled={running} data-testid="run-now-btn">
            {running ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3 mr-1" />
            )}
            Run now
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3" data-testid="vision-loading-skeleton">
      <Card><CardContent className="p-4 space-y-2 animate-pulse">
        <div className="h-3 bg-muted rounded w-1/3" />
        <div className="h-3 bg-muted rounded w-1/2" />
        <div className="h-2 bg-muted rounded w-1/4" />
      </CardContent></Card>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="overflow-hidden">
            <div className="aspect-[3/2] bg-muted animate-pulse" />
            <div className="p-2.5 space-y-2">
              <div className="h-2 bg-muted rounded w-3/4 animate-pulse" />
              <div className="h-2 bg-muted rounded w-1/2 animate-pulse" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, canRetry, onRetry, retrying }) {
  return (
    <Card className="border-red-200 bg-red-50/30 dark:bg-red-950/10 dark:border-red-800/40" data-testid="vision-error-state">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">Vision extraction failed</h3>
            {message && <p className="text-xs text-red-700/80 dark:text-red-300/80 mt-1">{message}</p>}
          </div>
        </div>
        {canRetry && (
          <div>
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} data-testid="retry-vision-btn">
              {retrying ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Retry
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function PulseListingVisionTab({ listing }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions();
  const listingId = listing?.id || null;

  const extractQuery = useVisionExtract(listingId);
  const classificationsQuery = useVisionClassifications(listingId);

  const [refreshing, setRefreshing] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState(null);

  const extract = extractQuery.data || null;
  const classifications = classificationsQuery.data || [];

  // Total images on the listing — used for the coverage badge "12/14 ext."
  const totalImagesOnListing = useMemo(() => {
    const m = parseMediaItems(listing);
    return (m.photos?.length || 0) + (m.floorplans?.length || 0);
  }, [listing]);

  // Lightbox: project classifications into the shape DroneLightbox expects.
  const lightboxImages = useMemo(() => {
    return classifications
      .filter((c) => c.source_image_url)
      .map((c, i) => ({
        id: c.id,
        src: c.source_image_url,
        thumb: c.source_image_url,
        path: c.source_image_url,
        observed_objects: c.observed_objects || null,
        title: c.filename || `image ${i + 1}`,
      }));
  }, [classifications]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    if (!listingId) return;
    setRefreshing(true);
    try {
      const resp = await api.functions.invoke("pulse-listing-vision-extract", {
        listing_id: listingId,
        force_refresh: true,
        triggered_by: "operator_manual",
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) throw new Error(result?.error || "Refresh failed.");
      toast.success("Vision extraction kicked off — refresh shortly.");
      // Invalidate so the next poll surfaces the running state.
      queryClient.invalidateQueries({ queryKey: ["pulse-listing-vision-extract", listingId] });
      queryClient.invalidateQueries({ queryKey: ["pulse-listing-vision-classifications", listingId] });
    } catch (err) {
      toast.error(`Refresh failed: ${err?.message || "unknown error"}`);
    } finally {
      setRefreshing(false);
    }
  }, [listingId, queryClient]);

  const handleManualSaved = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["pulse-listing-vision-extract", listingId] });
  }, [listingId, queryClient]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!listingId) {
    return (
      <Card><CardContent className="p-4 text-sm text-muted-foreground">No listing selected.</CardContent></Card>
    );
  }

  if (extractQuery.isLoading) {
    return <LoadingSkeleton />;
  }

  if (extractQuery.isError) {
    return (
      <ErrorState
        message={extractQuery.error?.message}
        canRetry={isMasterAdmin}
        onRetry={() => extractQuery.refetch()}
      />
    );
  }

  // No extract row → empty state.
  if (!extract) {
    return (
      <EmptyState
        canRun={isMasterAdmin}
        onRun={handleRefresh}
        running={refreshing}
      />
    );
  }

  const isFailed = extract.status === "failed";
  const isPendingOrRunning = extract.status === "pending" || extract.status === "running";

  return (
    <div className="space-y-3" data-testid="vision-analysis-tab">
      <PulseListingVisionAggregateCard
        extract={extract}
        classificationCount={classifications.length}
        totalImagesOnListing={totalImagesOnListing}
        isMasterAdmin={isMasterAdmin}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        onManualClassify={() => setManualOpen(true)}
        listingId={listingId}
      />

      {isFailed && (
        <ErrorState
          message={extract.failed_reason}
          canRetry={isMasterAdmin}
          onRetry={handleRefresh}
          retrying={refreshing}
        />
      )}

      {isPendingOrRunning ? (
        <LoadingSkeleton />
      ) : classifications.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground" data-testid="empty-classifications">
            No per-image classifications surfaced for this extract yet.
          </CardContent>
        </Card>
      ) : (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
          data-testid="vision-image-grid"
        >
          {classifications.map((cls, idx) => (
            <PulseListingVisionImageCard
              key={cls.id || idx}
              classification={cls}
              index={idx}
              onOpenLightbox={(i) => setLightboxIdx(i)}
            />
          ))}
        </div>
      )}

      {/* Lightbox: lazy-mount only when an image is clicked. */}
      {lightboxIdx != null && lightboxImages.length > 0 && (
        <ExternalListingLightbox
          images={lightboxImages}
          index={lightboxIdx}
          onIndexChange={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}

      {/* Manual classify dialog */}
      <ManualClassifyDialog
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        extract={extract}
        listingId={listingId}
        onSaved={handleManualSaved}
      />
    </div>
  );
}
