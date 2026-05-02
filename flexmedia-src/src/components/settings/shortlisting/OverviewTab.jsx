/**
 * OverviewTab — Shortlisting Command Center default landing tab.
 *
 * Wave 11.6.21. Surfaces engine-wide health KPIs in one strip via the
 * shortlisting_command_center_kpis(p_days) RPC (mig 413). Single useQuery
 * keeps the state model trivial — same pattern as W15b.9 and W11.6.
 *
 * Loading / empty / error states all degrade to readable zero-states so
 * fresh-deploy environments don't show error banners.
 */
import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle } from "lucide-react";
import KpiStrip from "./KpiStrip";

const POLL_INTERVAL_MS = 60_000;

export default function OverviewTab() {
  const qc = useQueryClient();

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["shortlisting-command-center-kpis", "cached"],
    queryFn: async () => {
      // QC-iter2 W6b (F-E-008): use the cached RPC backed by a 5-min
      // refresh materialised view (mig 424). The full p_days=7 aggregate
      // (~111ms / 8265 buffer hits) used to run on every poll; the cached
      // read is ~1-5ms. The MV is refreshed via pg_cron — data freshness
      // is bounded at 5 min, well under the OverviewTab's 60s poll cadence.
      const result = await api.rpc("shortlisting_command_center_kpis_cached");
      // api.rpc returns the raw value (single-row JSONB → object directly)
      return result?.data ?? result ?? {};
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 30_000,
  });

  return (
    <div className="space-y-3" data-testid="overview-tab">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Engine overview</h2>
          <p className="text-xs text-muted-foreground">
            Live KPIs across the shortlisting pipeline. 7-day rolling window for
            trend metrics. Auto-refreshes every 60s.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            qc.invalidateQueries({ queryKey: ["shortlisting-command-center-kpis"] });
            refetch();
          }}
          disabled={isFetching}
          data-testid="overview-refresh"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold">KPI fetch failed</p>
                <p className="text-muted-foreground">
                  {error?.message || "RPC call returned no data."} Showing zero-state.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <KpiStrip data={data} loading={isLoading} />

      <Card>
        <CardContent className="p-3 text-xs text-muted-foreground space-y-1.5">
          <p>
            <span className="font-semibold text-foreground">What this shows.</span>{" "}
            Today's spend and round count come from <code>engine_run_audit</code>{" "}
            and <code>shortlisting_rounds</code>. The override rate divides
            non-approved rows in <code>shortlisting_overrides</code> by slot
            decision events in <code>shortlisting_events</code>. V2 vision
            rollout reflects how many <code>pulse_listing_missed_opportunity</code>{" "}
            rows are quoted via the V2 cascade.
          </p>
          <p>
            <span className="font-semibold text-foreground">Need more detail?</span>{" "}
            Use the tabs above — Tier configs, Packages, Slots, Object Registry,
            AI Suggestions, Rejection Reasons, Calibration, Override Patterns,
            and Object Discovery — to drill in.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
