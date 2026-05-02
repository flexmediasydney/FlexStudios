/**
 * ObjectRegistryNormalisationTab — W12.B read-only stats + maintenance.
 *
 * Computes from the raw_attribute_observations + object_registry_candidates
 * tables directly (read-only via RLS):
 *   • total raw observations clustered (have normalised_to_object_id)
 *   • auto-normalisation rate (similarity_score ≥ 0.92)
 *   • discovery queue depth (pending candidates)
 *   • top 20 candidates by observed_count
 *
 * Maintenance buttons:
 *   • "Backfill embeddings" → POST { action: 'backfill_embeddings' }
 *
 * The threshold (0.92) mirrors the canonical-rollup auto-normalise gate so the
 * stat reflects the engine's actual decision boundary.
 */

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Activity,
  Database,
  Clock,
  Sparkles,
  Loader2,
  TrendingUp,
} from "lucide-react";

export const AUTO_NORMALISE_THRESHOLD = 0.92;

function StatCard({ icon: Icon, label, value, hint, variant = "default" }) {
  const tint =
    variant === "good"
      ? "text-emerald-700 dark:text-emerald-400"
      : variant === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : "text-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-wide mb-1">
          {Icon && <Icon className="h-3 w-3" />}
          {label}
        </div>
        <div className={`text-2xl font-bold tabular-nums ${tint}`} data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}>
          {value}
        </div>
        {hint && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "0";
  return Number(n).toLocaleString();
}

export default function ObjectRegistryNormalisationTab() {
  const queryClient = useQueryClient();

  // Pull a sample of recent raw_attribute_observations to compute the
  // auto-normalise rate. RLS allows admin SELECT on the underlying table.
  const observationsQuery = useQuery({
    queryKey: ["w12b_stats", "observations"],
    queryFn: async () => {
      const rows = await api.entities.RawAttributeObservation.list(
        "-created_at",
        1000,
      );
      return rows;
    },
    staleTime: 60_000,
  });

  const candidatesQuery = useQuery({
    queryKey: ["w12b_stats", "candidates"],
    queryFn: async () => {
      const rows = await api.entities.ObjectRegistryCandidate.filter(
        { status: "pending" },
        "-observed_count",
        50,
      );
      return rows;
    },
    staleTime: 60_000,
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const result = await api.functions.invoke("object-registry-admin", {
        action: "backfill_embeddings",
        limit: 50,
        null_only: true,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || result.error.body?.error || "backfill failed",
        );
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      toast.success(
        `Embedded ${data?.embedded ?? 0}/${data?.attempted ?? 0} canonical row(s)`,
      );
      queryClient.invalidateQueries({ queryKey: ["w12b_browse"] });
      queryClient.invalidateQueries({ queryKey: ["w12b_stats"] });
    },
    onError: (err) => toast.error(`Backfill failed: ${err?.message || err}`),
  });

  const stats = useMemo(() => {
    const obs = observationsQuery.data || [];
    const total = obs.length;
    const clustered = obs.filter((o) => o.normalised_to_object_id != null).length;
    const auto = obs.filter(
      (o) =>
        o.normalised_to_object_id != null &&
        Number(o.similarity_score || 0) >= AUTO_NORMALISE_THRESHOLD,
    ).length;
    return {
      total,
      clustered,
      auto,
      clusterRate: total > 0 ? clustered / total : null,
      autoRate: clustered > 0 ? auto / clustered : null,
    };
  }, [observationsQuery.data]);

  const queueDepth = candidatesQuery.data?.length ?? 0;
  const topCandidates = (candidatesQuery.data || []).slice(0, 20);

  const isLoading = observationsQuery.isLoading || candidatesQuery.isLoading;
  const isError = observationsQuery.isError || candidatesQuery.isError;
  const isEmpty = !isLoading && stats.total === 0 && queueDepth === 0;

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600" />
            Normalisation health
          </CardTitle>
          <CardDescription className="text-[11px]">
            Read-only stats over the last <span className="font-medium">1,000</span> raw
            observations. Auto-normalisation gate: cosine ≥{" "}
            <span className="font-mono">{AUTO_NORMALISE_THRESHOLD}</span>.
          </CardDescription>
        </CardHeader>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : isError ? (
        <Card className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20">
          <CardContent className="p-3 text-xs text-red-700 dark:text-red-400">
            Failed to load stats:{" "}
            {String(
              observationsQuery.error?.message || candidatesQuery.error?.message || "unknown",
            )}
          </CardContent>
        </Card>
      ) : isEmpty ? (
        <Card data-testid="normalisation-empty-state">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <Database className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium text-foreground">No data yet</p>
            <p className="mt-1 text-xs">
              The canonical-rollup batch surfaces observations here once it
              processes the first round.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <StatCard
              icon={Database}
              label="Total raw obs"
              value={fmtInt(stats.total)}
              hint="last 1,000 rows"
            />
            <StatCard
              icon={TrendingUp}
              label="Clustered"
              value={fmtInt(stats.clustered)}
              hint={`${fmtPct(stats.clusterRate)} of total`}
            />
            <StatCard
              icon={Sparkles}
              label="Auto-normalise rate"
              value={fmtPct(stats.autoRate)}
              hint={`cosine ≥ ${AUTO_NORMALISE_THRESHOLD}`}
              variant={
                stats.autoRate != null && stats.autoRate >= 0.7
                  ? "good"
                  : stats.autoRate != null && stats.autoRate < 0.4
                    ? "warn"
                    : "default"
              }
            />
            <StatCard
              icon={Clock}
              label="Queue depth"
              value={fmtInt(queueDepth)}
              hint="pending candidates"
              variant={queueDepth > 30 ? "warn" : "default"}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                Top 20 candidates by observed_count
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              {topCandidates.length === 0 ? (
                <div className="px-4 py-3 text-xs text-muted-foreground italic">
                  No pending candidates.
                </div>
              ) : (
                <Table data-testid="top-candidates-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] uppercase tracking-wide w-8 tabular-nums">#</TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wide">proposed_canonical_label</TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wide">type</TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wide tabular-nums text-right">obs</TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wide">level_0_class</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topCandidates.map((c, i) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-[11px] tabular-nums text-muted-foreground py-2">
                          {i + 1}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] py-2">
                          {c.proposed_canonical_label}
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge className="text-[9px] h-4 px-1 bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                            {c.candidate_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs py-2">
                          {c.observed_count || 1}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground py-2">
                          {c.proposed_level_0_class || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-blue-600" />
            Maintenance
          </CardTitle>
          <CardDescription className="text-[11px]">
            Backfill <code>embedding_vector</code> on canonical rows where it's
            NULL (50 rows/batch). Required after seeding new rows by hand or
            after a registry import.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            data-testid="backfill-embeddings-button"
          >
            {backfillMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1" />
            )}
            Backfill embeddings (50/batch)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
