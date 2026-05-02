/**
 * ArchitectureTab — Wave 11.6.23.
 *
 * 20th tab inside the Shortlisting Command Center. Provides visual
 * transparency into the engine's data layer rollups:
 *   1. Hierarchy diagram (project → products → engine_roles → slots →
 *      compositions → object_registry) with live counts per layer.
 *   2. Slot coverage matrix (last 30 rounds × 12 active slots) with
 *      green/amber/red/grey fill states.
 *   3. Slot suggestions — surfaces W12.7 reactive suggestions (link out
 *      to /SettingsAISuggestions for approve/reject) plus heuristic
 *      suggestions computed server-side (split / deletion_candidate /
 *      new_slot_needed).
 *
 * One RPC, one round-trip: shortlisting_architecture_kpis(p_days)
 * returns the whole blob. Same pattern as W11.6.21 OverviewTab.
 *
 * Lazily imports html2canvas only when the user clicks "Export as PNG"
 * so the dependency stays out of the initial chunk.
 *
 * Read-only: no DDL, no DML, no engine triggers fire from this tab.
 */
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle, Network } from "lucide-react";
import HierarchyDiagram from "./HierarchyDiagram";
import SlotCoverageMatrix from "./SlotCoverageMatrix";
import HeuristicSuggestions from "./HeuristicSuggestions";

const POLL_INTERVAL_MS = 60_000;

export default function ArchitectureTab() {
  const qc = useQueryClient();
  const [days] = useState(30);

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["shortlisting-architecture-kpis", days],
    queryFn: async () => {
      const result = await api.rpc("shortlisting_architecture_kpis", {
        p_days: days,
      });
      return result?.data ?? result ?? {};
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 30_000,
  });

  return (
    <div className="space-y-3" data-testid="architecture-tab">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Network className="h-4 w-4 text-blue-600" />
            Architecture & Data Explorer
          </h2>
          <p className="text-xs text-muted-foreground">
            Visual transparency into the engine's data layers — live row
            counts, slot coverage matrix (last {days} days), and
            heuristic slot-shape suggestions.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            qc.invalidateQueries({
              queryKey: ["shortlisting-architecture-kpis"],
            });
            refetch();
          }}
          disabled={isFetching}
          data-testid="architecture-refresh"
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
                <p className="font-semibold">Architecture KPI fetch failed</p>
                <p className="text-muted-foreground">
                  {error?.message || "RPC call returned no data."} Showing
                  zero-state.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Panel 1: Hierarchy diagram ─────────────────────────────────── */}
      <HierarchyDiagram data={data} loading={isLoading} />

      {/* ── Panel 2: Slot coverage matrix ──────────────────────────────── */}
      <SlotCoverageMatrix data={data} loading={isLoading} />

      {/* ── Panel 3: Suggestions (W12.7 link + heuristics) ─────────────── */}
      <HeuristicSuggestions data={data} loading={isLoading} />
    </div>
  );
}
