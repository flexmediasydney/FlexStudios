/**
 * SettingsRejectionReasonsDashboard — W11.6 master_admin admin page.
 *
 * Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md
 * URL: /SettingsRejectionReasonsDashboard
 * Permission: master_admin only.
 *
 * Surfaces the override + Shape-D-output substrate that W11.5 (mig 408/409)
 * and W11.7 ship into. Six widgets, single RPC round-trip:
 *
 *   1. Human override heatmap   → top 20 raw_label values from
 *                                 raw_attribute_observations
 *                                 WHERE source_type='human_override'
 *   2. Stage 4 self-corrections → counts + samples from
 *                                 shortlisting_stage4_overrides
 *   3. Voice tier distribution  → property_tier counts on
 *                                 shortlisting_master_listings
 *   4. Master listing metrics   → avg word_count + reading_grade_level on
 *                                 shortlisting_master_listings
 *   5. Registry coverage        → % of observed_objects entries with
 *                                 proposed_canonical_id resolved
 *   6. Cost-per-stage           → 7-day cost averages from engine_run_audit
 *
 * Why one RPC for all six:
 *   Each widget shares the same time window (default 30d, picker 7/30/90).
 *   Pulling six separate queries in parallel works, but a single
 *   `pulse_or_engine_admin_kpis_for_rejection_dashboard(p_days int)` call
 *   keeps the dashboard's state model trivial (one useQuery, one loading
 *   flag, one error path) and dramatically reduces dashboard latency on
 *   poor-network admin sessions.
 *
 * Style mirrors PulseMissedOpportunityCommandCenter:
 *   slate-tinted cards, tabular-nums for counts, defensive zero-state on
 *   every widget, single RefreshCw button at the page header that
 *   invalidates the RPC query.
 *
 * Defensive auth gate:
 *   In addition to RouteGuard's master_admin check (App.jsx layer), this
 *   page renders an inline lockout card if usePermissions reports a
 *   non-master_admin role — same pattern as PMOC, double-check that the
 *   page can never render the override heatmap to a non-master_admin who
 *   somehow bypassed RouteGuard.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { RefreshCw, Shield, AlertCircle, Activity } from "lucide-react";

import HumanOverrideHeatmap from "@/components/settings/rejection/HumanOverrideHeatmap";
import Stage4SelfCorrectionPanel from "@/components/settings/rejection/Stage4SelfCorrectionPanel";
import VoiceTierDistribution from "@/components/settings/rejection/VoiceTierDistribution";
import MasterListingMetrics from "@/components/settings/rejection/MasterListingMetrics";
import RegistryCoverageWidget from "@/components/settings/rejection/RegistryCoverageWidget";
import CostAttributionWidget from "@/components/settings/rejection/CostAttributionWidget";

const DAY_WINDOW_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

/**
 * Pure helper: clamp the day-window picker value. Exported for tests.
 * Accepts unknown user input from URL param / select state and returns
 * a guaranteed-valid day count from the picker's allowed set.
 */
export function clampDayWindow(value) {
  const n = Number(value);
  const allowed = DAY_WINDOW_OPTIONS.map((o) => o.value);
  if (!Number.isFinite(n)) return 30;
  return allowed.includes(n) ? n : 30;
}

export default function SettingsRejectionReasonsDashboard() {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions();
  const [daysBack, setDaysBack] = useState(30);

  const dashboardQuery = useQuery({
    queryKey: ["w11-6-rejection-dashboard-kpis", daysBack],
    queryFn: () =>
      api.rpc("pulse_or_engine_admin_kpis_for_rejection_dashboard", {
        p_days: daysBack,
      }),
    enabled: isMasterAdmin,
    staleTime: 60_000,
    keepPreviousData: true,
  });

  const data = dashboardQuery.data || {};
  const isLoading = dashboardQuery.isLoading;
  const isFetching = dashboardQuery.isFetching;
  const error = dashboardQuery.error;

  // ── Defensive lockout (RouteGuard is primary) ──────────────────────────────
  if (!isMasterAdmin) {
    return (
      <div className="p-6 max-w-md mx-auto">
        <Card>
          <CardContent className="p-6 text-center space-y-2">
            <Shield className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">master_admin only</p>
            <p className="text-xs text-muted-foreground">
              The Rejection Reasons Dashboard surfaces production override
              patterns + Gemini cost attribution.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-3 md:p-4 space-y-3" data-testid="rejection-dashboard-root">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-lg md:text-xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Rejection Reasons Dashboard
          </h1>
          <p className="text-xs text-muted-foreground">
            Override patterns, Stage 4 self-corrections, voice-tier drift,
            registry coverage and cost attribution · master_admin only
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Window
            </Label>
            <Select
              value={String(daysBack)}
              onValueChange={(v) => setDaysBack(clampDayWindow(v))}
            >
              <SelectTrigger className="h-8 text-xs w-36 mt-0.5" data-testid="window-picker">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_WINDOW_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="self-end"
            onClick={() => {
              queryClient.invalidateQueries({
                queryKey: ["w11-6-rejection-dashboard-kpis"],
              });
            }}
            data-testid="refresh-button"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error ? (
        <Card className="border-red-300 bg-red-50 dark:bg-red-950/30">
          <CardContent className="p-3 text-xs flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-700 dark:text-red-300">
                Failed to load dashboard data
              </p>
              <p className="text-red-700/80 dark:text-red-300/80 mt-0.5">
                {error?.message || String(error)}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Top row: human overrides + Stage 4 corrections ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <HumanOverrideHeatmap
          data={data?.human_override_heatmap}
          loading={isLoading}
          daysBack={daysBack}
        />
        <Stage4SelfCorrectionPanel
          data={data?.stage4_self_corrections}
          loading={isLoading}
          daysBack={daysBack}
        />
      </div>

      {/* ── Middle row: voice tier + master listing metrics ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <VoiceTierDistribution
          data={data?.voice_tier_distribution}
          loading={isLoading}
          daysBack={daysBack}
        />
        <MasterListingMetrics
          data={data?.master_listing_metrics}
          loading={isLoading}
          daysBack={daysBack}
        />
      </div>

      {/* ── Bottom row: canonical coverage + cost attribution ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <RegistryCoverageWidget
          data={data?.canonical_registry_coverage}
          loading={isLoading}
          daysBack={daysBack}
        />
        <CostAttributionWidget
          data={data?.cost_per_stage}
          loading={isLoading}
        />
      </div>

      {/* ── Footer note ─────────────────────────────────────────────────── */}
      <p className="text-[10px] text-muted-foreground text-center pt-2">
        Computed at {data?.computed_at ? new Date(data.computed_at).toLocaleString() : "—"} ·
        RPC: pulse_or_engine_admin_kpis_for_rejection_dashboard({daysBack})
      </p>
    </div>
  );
}
