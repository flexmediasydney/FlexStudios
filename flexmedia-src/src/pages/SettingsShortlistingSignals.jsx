/**
 * SettingsShortlistingSignals — Read-only mirror of the hardcoded signal library.
 *
 * The 26 Stage 1 vision signals live in the TS schema:
 *   supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts
 *     - UNIVERSAL_SIGNAL_KEYS  (the canonical key list)
 *     - SIGNAL_TO_DIMENSION    (which axis each signal rolls into)
 *     - SIGNAL_SCORES_SCHEMA   (per-signal scoring rubric the LLM reads)
 *
 * This page renders the `shortlisting_signal_weights` table, which migration 431
 * keeps in sync with the schema. To add/rename/remove a signal you must edit
 * the TS schema AND write a follow-up migration that mirrors the change here.
 *
 * Per-signal scoring weights are tunable per tier on the Tiers tab, NOT here.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Gauge, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

const DIMENSIONS = ["compositional", "aesthetic", "technical", "lighting", "workflow"];

const DIMENSION_TONE = {
  compositional:
    "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  aesthetic:
    "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300",
  technical:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  lighting:
    "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  workflow:
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

export default function SettingsShortlistingSignals() {
  const [dimensionFilter, setDimensionFilter] = useState("all");

  const signalsQuery = useQuery({
    queryKey: ["shortlisting_signal_weights_all"],
    queryFn: () =>
      api.entities.ShortlistingSignalWeight.list("signal_key", 500),
  });

  const allRows = signalsQuery.data || [];

  const filtered = useMemo(() => {
    if (dimensionFilter === "all") return allRows;
    return allRows.filter((r) => r.dimension === dimensionFilter);
  }, [allRows, dimensionFilter]);

  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 lg:p-8 max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Gauge className="h-6 w-6 text-primary" />
            Signal Library
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {allRows.length} signal{allRows.length === 1 ? "" : "s"} emitted by Stage 1 vision scoring.
          </p>
        </div>

        {/* Read-only disclaimer */}
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Read-only — these signals are hardcoded</AlertTitle>
          <AlertDescription className="text-xs space-y-1.5 mt-1">
            <p>
              The signal list, dimension assignments, and scoring rubrics live
              in the Stage 1 vision schema:
              {" "}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts
              </code>
              . This page is a read-only mirror. To add, rename, or remove a
              signal you must edit the TS schema AND write a follow-up
              migration to keep this table in sync.
            </p>
            <p>
              Per-signal scoring <strong>weights</strong> are tuned per tier on
              the <strong>Tiers</strong> tab — not here. The 4-axis dimension
              blend (technical / lighting / composition / aesthetic) is also
              on the Tiers tab. Workflow signals are emitted but do not roll
              up into <code className="text-[11px]">combined_score</code>.
            </p>
          </AlertDescription>
        </Alert>

        {/* Filter row */}
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Dimension
                </Label>
                <Select
                  value={dimensionFilter}
                  onValueChange={setDimensionFilter}
                >
                  <SelectTrigger className="h-9 w-[200px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All dimensions</SelectItem>
                    {DIMENSIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Signals list */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Signals</CardTitle>
            <CardDescription className="text-xs">
              {filtered.length} match{filtered.length === 1 ? "" : "es"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {signalsQuery.isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : signalsQuery.error ? (
              <div className="p-4 text-xs text-red-600">
                Failed to load: {signalsQuery.error.message}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-xs text-muted-foreground italic text-center">
                No signals match the current filter.
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((row) => {
                  const tone =
                    DIMENSION_TONE[row.dimension] ||
                    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
                  return (
                    <li
                      key={row.id}
                      className="px-4 py-3 hover:bg-muted/30 text-xs"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[12px] font-medium">
                            {row.signal_key}
                          </span>
                          <Badge
                            variant="secondary"
                            className={cn("text-[10px]", tone)}
                          >
                            {row.dimension}
                          </Badge>
                        </div>
                        {row.description && (
                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            {row.description}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </PermissionGuard>
  );
}
