/**
 * CalibrationStratificationTab — Wave 14
 *
 * Tab 3 of SettingsCalibrationSessions. Preview-and-create surface:
 *   - Pick days_back to scope candidate projects.
 *   - Engine groups them by tier × project_type × suburb_postcode and
 *     surfaces the candidate distribution.
 *   - Click "Save as new session" — creates a calibration_sessions row with
 *     selected_project_ids = the dedup'd top-N per cell (default 50).
 *
 * Stratification is computed in the browser against the projects table
 * (manageable: typical lookback returns ≤ 1k rows). Server-side cell
 * resolution would be cleaner but adds an edge fn for v1; the spec leaves
 * `calibration-session-create` as a separate edge fn that's not yet shipped.
 * v1 inserts the row directly via the entity client (RLS gates this to
 * master_admin per mig 407).
 *
 * Spec: docs/design-specs/W14-calibration-session.md §1 + §5.
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Layers,
  Plus,
  Loader2,
} from "lucide-react";

const DEFAULT_DAYS_BACK = 180;
const DEFAULT_TARGET_COUNT = 50;
const DEFAULT_PER_CELL_CAP = 6;

function cellKey(p) {
  const tier = p.pricing_tier || "unknown";
  const type = p.project_type || "unknown";
  const suburb = p.suburb || p.delivery_address_suburb || "—";
  return `${tier}/${type}/${suburb}`;
}

export default function CalibrationStratificationTab({ onSessionCreated }) {
  const qc = useQueryClient();
  const [daysBack, setDaysBack] = useState(DEFAULT_DAYS_BACK);
  const [target, setTarget] = useState(DEFAULT_TARGET_COUNT);
  const [perCellCap, setPerCellCap] = useState(DEFAULT_PER_CELL_CAP);
  const [sessionName, setSessionName] = useState(
    `Calibration ${new Date().toISOString().slice(0, 10)}`,
  );

  const candidateQuery = useQuery({
    queryKey: ["calibration-stratification-candidates", daysBack],
    queryFn: async () => {
      const cutoff = new Date(
        Date.now() - daysBack * 24 * 60 * 60 * 1000,
      ).toISOString();
      // Filter by completed_at or created_at >= cutoff. Limit 1000.
      const rows = await api.entities.Project.filter(
        { created_at: { $gte: cutoff } },
        "-created_at",
        1000,
      );
      return rows;
    },
  });

  const cellSummary = useMemo(() => {
    const rows = candidateQuery.data || [];
    const cells = new Map();
    for (const p of rows) {
      const key = cellKey(p);
      if (!cells.has(key)) {
        cells.set(key, {
          cell_key: key,
          tier: p.pricing_tier || "unknown",
          project_type: p.project_type || "unknown",
          suburb: p.suburb || p.delivery_address_suburb || "—",
          projects: [],
        });
      }
      cells.get(key).projects.push(p);
    }
    return Array.from(cells.values()).sort(
      (a, b) => b.projects.length - a.projects.length,
    );
  }, [candidateQuery.data]);

  const selectedProjects = useMemo(() => {
    // Greedy: take up to perCellCap from each cell in descending-popularity
    // order, until we hit the target count.
    const out = [];
    const seen = new Set();
    for (const cell of cellSummary) {
      const take = cell.projects.slice(0, perCellCap);
      for (const p of take) {
        if (seen.has(p.id)) continue;
        out.push({ id: p.id, cell_key: cell.cell_key });
        seen.add(p.id);
        if (out.length >= target) return out;
      }
    }
    return out;
  }, [cellSummary, target, perCellCap]);

  const cellCounts = useMemo(() => {
    const counts = new Map();
    for (const sel of selectedProjects) {
      counts.set(sel.cell_key, (counts.get(sel.cell_key) || 0) + 1);
    }
    return counts;
  }, [selectedProjects]);

  const create = useMutation({
    mutationFn: async () => {
      if (selectedProjects.length === 0) {
        throw new Error("No projects in selection — broaden days_back or per-cell cap.");
      }
      const stratification_config = {
        days_back: daysBack,
        target,
        per_cell_cap: perCellCap,
        cells: Array.from(cellCounts.entries()).map(([key, count]) => ({
          cell_key: key,
          count,
        })),
      };
      const inserted = await api.entities.CalibrationSession.create({
        session_name: sessionName.trim() || "Untitled session",
        status: "open",
        stratification_config,
        selected_project_ids: selectedProjects.map((s) => s.id),
        notes: `Generated from days_back=${daysBack}, target=${target}, per_cell_cap=${perCellCap}.`,
      });
      return inserted;
    },
    onSuccess: (row) => {
      toast.success(
        `Session created (${selectedProjects.length} projects). Open the Detail tab to continue.`,
      );
      qc.invalidateQueries({ queryKey: ["calibration-sessions"] });
      if (row?.id) onSessionCreated?.(row.id);
    },
    onError: (err) => {
      toast.error(`Create session failed: ${err?.message || String(err)}`);
    },
  });

  return (
    <div className="space-y-3" data-testid="stratification-tab">
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-3.5 w-3.5 text-violet-600" />
            Stratify candidate projects
          </CardTitle>
          <CardDescription className="text-[11px]">
            Tune the lookback window + per-cell cap; the engine builds a
            balanced selection across tier × project_type × suburb.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div>
              <Label className="text-[10px] uppercase">Session name</Label>
              <Input
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="Calibration 2026-04"
                data-testid="session-name-input"
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Days back</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={daysBack}
                onChange={(e) =>
                  setDaysBack(Math.max(1, Number(e.target.value) || DEFAULT_DAYS_BACK))
                }
                data-testid="days-back-input"
                className="h-8 text-xs tabular-nums"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Target N</Label>
              <Input
                type="number"
                min={1}
                max={500}
                value={target}
                onChange={(e) =>
                  setTarget(Math.max(1, Number(e.target.value) || DEFAULT_TARGET_COUNT))
                }
                data-testid="target-input"
                className="h-8 text-xs tabular-nums"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Per-cell cap</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={perCellCap}
                onChange={(e) =>
                  setPerCellCap(Math.max(1, Number(e.target.value) || DEFAULT_PER_CELL_CAP))
                }
                data-testid="per-cell-cap-input"
                className="h-8 text-xs tabular-nums"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-muted-foreground">
              {candidateQuery.isLoading ? (
                "Loading candidates…"
              ) : (
                <>
                  <span className="tabular-nums" data-testid="candidate-count">
                    {(candidateQuery.data || []).length}
                  </span>{" "}
                  candidates · <span className="tabular-nums" data-testid="cell-count">{cellSummary.length}</span>{" "}
                  cells · selecting{" "}
                  <span
                    className="tabular-nums font-semibold"
                    data-testid="selection-count"
                  >
                    {selectedProjects.length}
                  </span>{" "}
                  of {target}
                </>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => create.mutate()}
              disabled={create.isPending || selectedProjects.length === 0}
              data-testid="create-session-button"
            >
              {create.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save as new session
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Cell distribution</CardTitle>
          <CardDescription className="text-[11px]">
            Counts shown as <em>selected / available</em> per cell.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {candidateQuery.isLoading ? (
            <div className="space-y-1">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : cellSummary.length === 0 ? (
            <div
              className="text-xs text-muted-foreground py-4 text-center"
              data-testid="empty-state-cells"
            >
              No candidates in this lookback window. Increase days_back.
            </div>
          ) : (
            <div className="space-y-1" data-testid="cell-summary">
              {cellSummary.slice(0, 30).map((cell) => {
                const sel = cellCounts.get(cell.cell_key) || 0;
                return (
                  <div
                    key={cell.cell_key}
                    className="flex items-baseline gap-2 text-xs tabular-nums"
                    data-testid={`cell-${cell.cell_key}`}
                  >
                    <Badge
                      variant={sel > 0 ? "default" : "outline"}
                      className="text-[10px] font-mono"
                    >
                      {cell.cell_key}
                    </Badge>
                    <span className="text-muted-foreground">
                      <span className="font-semibold">{sel}</span>
                      /{cell.projects.length}
                    </span>
                  </div>
                );
              })}
              {cellSummary.length > 30 && (
                <div className="text-[10px] opacity-60 mt-1.5">
                  + {cellSummary.length - 30} more cells not shown.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
