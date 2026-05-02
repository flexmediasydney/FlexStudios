/**
 * HierarchyBAxes — left column for the orthogonal classification axes.
 *
 * Renders one card per axis (image_type / room_type / space_type /
 * zone_focus / composition_type). Each card pulls its distribution from
 * taxonomy_b_axis_distribution(<axis>) and shows a compact bar list:
 *
 *   master_bedroom         [████████▒░] 248 · 31.4%
 *   kitchen_dining_living  [██████░░░░] 184 · 23.3%
 *   …
 *
 * Click a row to select { axis, value } — drives the right-column detail.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartBar, AlertCircle } from "lucide-react";

const STALE_MS = 60_000;
const BAR_WIDTH = 10;

export default function HierarchyBAxes({ axes, selected, onSelect }) {
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
    </div>
  );
}

function AxisCard({ axis, selected, onSelect }) {
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
    <Card data-testid={`taxonomy-b-axis-${axis.key}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <ChartBar className="h-3.5 w-3.5 text-blue-600" />
            {axis.label}
            <code className="text-[10px] text-muted-foreground">
              {axis.key}
            </code>
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
