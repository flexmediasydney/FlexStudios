/**
 * HierarchyBAxes — left column for the orthogonal classification axes.
 *
 * Renders one card per primary axis (image_type / space_type / zone_focus /
 * composition_type). Each card pulls its distribution from
 * taxonomy_b_axis_distribution(<axis>) and shows a compact bar list:
 *
 *   master_bedroom         [████████▒░] 248 · 31.4%
 *   kitchen_dining_living  [██████░░░░] 184 · 23.3%
 *   …
 *
 * Click a row to select { axis, value } — drives the right-column detail.
 *
 * Mig 441: `room_type` is demoted into a collapsible "Legacy axes" section
 * at the bottom. Closed by default. Same axis card renders inside; only
 * the framing changes.
 */

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartBar,
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

const STALE_MS = 60_000;
const BAR_WIDTH = 10;

export default function HierarchyBAxes({ axes, legacyAxes, selected, onSelect }) {
  const [legacyOpen, setLegacyOpen] = useState(false);

  return (
    <div className="space-y-3" data-testid="taxonomy-b-axes">
      {axes.map((a) => (
        <AxisCard
          key={a.key}
          axis={a}
          selected={selected}
          onSelect={onSelect}
        />
      ))}

      {Array.isArray(legacyAxes) && legacyAxes.length > 0 && (
        <Card className="border-dashed" data-testid="taxonomy-b-legacy-section">
          <CardHeader
            className="pb-2 cursor-pointer select-none"
            onClick={() => setLegacyOpen((v) => !v)}
            data-testid="taxonomy-b-legacy-toggle"
            data-open={legacyOpen ? "true" : "false"}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setLegacyOpen((v) => !v);
              }
            }}
          >
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {legacyOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <Archive className="h-3.5 w-3.5" />
                Legacy axes
                <span className="text-[10px] font-normal">
                  (kept for slot eligibility compat)
                </span>
              </span>
              <span className="text-[10px] font-normal text-muted-foreground">
                {legacyAxes.length} axis{legacyAxes.length === 1 ? "" : "es"}
              </span>
            </CardTitle>
          </CardHeader>
          {legacyOpen && (
            <CardContent
              className="space-y-3 pt-0"
              data-testid="taxonomy-b-legacy-content"
            >
<p className="text-[11px] text-muted-foreground italic leading-relaxed">
                <code className="text-[10px]">room_type</code> is the
                pre-W11.6.13 single-axis classification. New rows still emit
                it for backwards compat with{" "}
                <code className="text-[10px]">
                  slot_definitions.eligible_room_types[]
                </code>
                . Use <code className="text-[10px]">space_type</code> +{" "}
                <code className="text-[10px]">zone_focus</code> for new
                diagnostics.
              </p>
              <p className="text-[11px] text-muted-foreground italic leading-relaxed">
                <code className="text-[10px]">composition_type</code> was the
                single-axis composition classification before mig 451 (S1).
                Rows are now classified along two orthogonal axes:{" "}
                <code className="text-[10px]">vantage_position</code> (where
                the camera is) and{" "}
                <code className="text-[10px]">composition_geometry</code> (the
                geometric pattern of the frame). The legacy{" "}
                <code className="text-[10px]">composition_type</code> column
                stays populated for backwards compat and historical
                analytics.
              </p>
              {legacyAxes.map((a) => (
                <AxisCard
                  key={a.key}
                  axis={a}
                  selected={selected}
                  onSelect={onSelect}
                  legacy
                />
              ))}
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

function AxisCard({ axis, selected, onSelect, legacy = false }) {
  const q = useQuery({
    queryKey: ["taxonomy-b-axis-distribution", axis.key],
    queryFn: async () => {
      const data = await api.rpc("taxonomy_b_axis_distribution", {
        p_axis: axis.key,
      });
      return Array.isArray(data) ? data : [];
    },
    staleTime: STALE_MS,
  });

  const max = (q.data || []).reduce(
    (m, r) => Math.max(m, Number(r.n_compositions || 0)),
    0,
  );

  return (
    <Card
      data-testid={`taxonomy-b-axis-${axis.key}`}
      data-legacy={legacy ? "true" : "false"}
      className={legacy ? "bg-muted/20" : undefined}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <ChartBar className="h-3.5 w-3.5 text-blue-600" />
            {axis.label}
            <code className="text-[10px] text-muted-foreground">
              {axis.key}
            </code>
            {legacy && (
              <span className="text-[10px] text-muted-foreground italic">
                (legacy)
              </span>
            )}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {q.data ? `${q.data.length} values` : ""}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs space-y-1">
        {q.isLoading && <Skeleton className="h-20 w-full" />}
        {q.error && (
          <div className="flex items-start gap-1.5 text-amber-700">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
            <span>{q.error?.message || "RPC failed"}</span>
          </div>
        )}
        {!q.isLoading && !q.error && (q.data || []).length === 0 && (
          <div className="text-muted-foreground italic">
            No classifications carry this axis yet.
          </div>
        )}
        {!q.isLoading && !q.error && (q.data || []).length > 0 && (
          <div>
            {(q.data || []).map((r) => {
              const isSelected =
                selected?.axis === axis.key && selected?.value === r.value;
              const filled = Math.max(
                1,
                Math.round((Number(r.n_compositions) / max) * BAR_WIDTH),
              );
              const empty = BAR_WIDTH - filled;
              return (
                <div
                  key={`${axis.key}:${r.value}`}
                  className={`grid grid-cols-12 gap-1 items-center cursor-pointer rounded px-1 py-0.5 ${
                    isSelected
                      ? "bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-200"
                      : "hover:bg-accent/40"
                  }`}
                  onClick={() =>
                    onSelect({ axis: axis.key, value: r.value })
                  }
                  data-testid={`taxonomy-b-row-${axis.key}-${r.value}`}
                >
                  <div className="col-span-5 truncate font-mono text-[11px]">
                    {r.value}
                  </div>
                  <div className="col-span-3 font-mono text-[11px] text-muted-foreground">
                    {"█".repeat(filled)}
                    <span className="opacity-30">
                      {"░".repeat(Math.max(0, empty))}
                    </span>
                  </div>
                  <div className="col-span-2 text-right text-[11px] font-mono">
                    {r.n_compositions}
                  </div>
                  <div className="col-span-2 text-right text-[11px] text-muted-foreground">
                    {Number(r.pct).toFixed(1)}%
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
