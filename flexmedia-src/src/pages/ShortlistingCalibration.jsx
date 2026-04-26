/**
 * ShortlistingCalibration — Wave 6 Phase 8 SHORTLIST
 *
 * master_admin only. Displays quarterly accuracy benchmark history,
 * triggers new benchmark runs against the holdout set, and lets admins
 * mark/unmark locked rounds as part of the holdout set.
 *
 * Reads:
 *   - shortlisting_benchmark_results (latest + history)
 *   - shortlisting_rounds (status='locked' with optional is_benchmark filter)
 *
 * Writes:
 *   - shortlisting_rounds.is_benchmark via api.entities.ShortlistingRound.update
 *   - shortlisting_benchmark_results indirectly via the benchmark-runner
 *     edge function
 *
 * Cost note: each benchmark run is one Sonnet call per round (~$0.03/round).
 * Default limit is 50 → ~$1.50 per run. Warned in the dialog.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  CheckCircle2,
  DollarSign,
  Gauge,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const BASELINE = 0.78;
const POLL_INTERVAL_MS = 30_000;

function fmtPct(n) {
  if (n == null || !isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}
function fmtAbsTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "PPP p");
  } catch {
    return "—";
  }
}

// ── Hero result card ────────────────────────────────────────────────────────
function HeroResult({ latest, isLoading }) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="h-32 bg-muted/40 rounded animate-pulse" />
        </CardContent>
      </Card>
    );
  }
  if (!latest) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="h-4 w-4" />
            Latest benchmark
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground italic py-4">
            No benchmark runs yet. Mark some rounds as benchmark below, then click
            "Run benchmark now" to produce the first measurement.
          </div>
        </CardContent>
      </Card>
    );
  }

  const matchRate = Number(latest.match_rate || 0);
  const improvement = Number(latest.improvement_vs_baseline || 0);
  const isImproving = improvement > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Target className="h-4 w-4" />
          Latest benchmark
          <Badge variant="outline" className="text-[10px]">
            {latest.trigger || "manual"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Match rate
            </p>
            <p className="text-3xl font-semibold tabular-nums mt-0.5">
              {fmtPct(matchRate)}
            </p>
            <p
              className={cn(
                "text-xs mt-1 tabular-nums flex items-center gap-1",
                isImproving ? "text-emerald-600" : "text-amber-600",
              )}
            >
              {isImproving ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {improvement >= 0 ? "+" : ""}
              {(improvement * 100).toFixed(2)}pp vs baseline ({fmtPct(BASELINE)})
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Sample size
            </p>
            <p className="text-2xl font-semibold tabular-nums mt-0.5">
              {latest.sample_size}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {latest.total_matches} / {latest.total_slots} slots matched
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Engine
            </p>
            <p className="text-base font-semibold mt-0.5 font-mono">
              {latest.engine_version || "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
              {latest.model_versions?.pass2 || latest.model_versions?.pass1 || "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Ran at
            </p>
            <p className="text-base font-medium mt-0.5">
              {fmtTime(latest.ran_at)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {fmtAbsTime(latest.ran_at)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Trend chart ─────────────────────────────────────────────────────────────
function TrendChart({ history, isLoading }) {
  const data = useMemo(() => {
    return (history || [])
      .slice()
      .reverse()
      .map((r) => ({
        x: r.ran_at,
        label: r.ran_at ? format(new Date(r.ran_at), "MMM d") : "—",
        match_rate: Number(r.match_rate || 0),
        baseline: BASELINE,
      }));
  }, [history]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Match rate over time
          <span className="text-muted-foreground font-normal text-xs">
            ({history?.length || 0} runs)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-64 bg-muted/40 rounded animate-pulse" />
        ) : data.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-12 text-center">
            No benchmark history yet.
          </div>
        ) : (
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted-foreground))" opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  stroke="hsl(var(--muted-foreground))"
                />
                <Tooltip
                  formatter={(v, name) =>
                    name === "match_rate"
                      ? [fmtPct(v), "Match rate"]
                      : [fmtPct(v), "Baseline"]
                  }
                  contentStyle={{
                    backgroundColor: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                    fontSize: "12px",
                  }}
                />
                <ReferenceLine
                  y={BASELINE}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="4 4"
                  label={{ value: `baseline ${fmtPct(BASELINE)}`, fontSize: 10, position: "right" }}
                />
                <Line
                  type="monotone"
                  dataKey="match_rate"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Per-slot heatmap (simple ranked list) ───────────────────────────────────
function PerSlotBreakdown({ latest, isLoading }) {
  const rows = useMemo(() => {
    const obj = latest?.per_slot_match_rates || {};
    return Object.entries(obj)
      .map(([slot, rate]) => ({ slot, rate: Number(rate || 0) }))
      .sort((a, b) => b.rate - a.rate);
  }, [latest]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Gauge className="h-4 w-4" />
          Per-slot match rate (latest run)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-32 bg-muted/40 rounded animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            No per-slot data — run a benchmark to populate.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.slot} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-muted-foreground min-w-[140px] truncate" title={r.slot}>
                  {r.slot}
                </span>
                <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded",
                      r.rate >= 0.9
                        ? "bg-emerald-500"
                        : r.rate >= 0.7
                        ? "bg-blue-500"
                        : r.rate >= 0.5
                        ? "bg-amber-500"
                        : "bg-red-500",
                    )}
                    style={{ width: `${Math.max(2, Math.min(100, r.rate * 100))}%` }}
                  />
                </div>
                <span className="font-mono tabular-nums w-12 text-right">
                  {fmtPct(r.rate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Per-package breakdown ──────────────────────────────────────────────────
function PerPackageBreakdown({ latest, isLoading }) {
  const rows = useMemo(() => {
    const obj = latest?.per_package_match_rates || {};
    return Object.entries(obj)
      .map(([pkg, rate]) => ({ pkg, rate: Number(rate || 0) }))
      .sort((a, b) => b.rate - a.rate);
  }, [latest]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Target className="h-4 w-4" />
          Per-package breakdown (latest run)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-24 bg-muted/40 rounded animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            No per-package data — run a benchmark to populate.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.pkg} className="flex items-center gap-2 text-xs">
                <span className="font-medium min-w-[140px] truncate">
                  {r.pkg}
                </span>
                <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full rounded bg-primary"
                    style={{ width: `${Math.max(2, Math.min(100, r.rate * 100))}%` }}
                  />
                </div>
                <span className="font-mono tabular-nums w-12 text-right">
                  {fmtPct(r.rate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Holdout set management ─────────────────────────────────────────────────
function HoldoutManagement({
  rounds,
  isLoading,
  toggleBenchmark,
  togglingId,
}) {
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState("benchmark"); // "benchmark" | "all"

  const filtered = useMemo(() => {
    if (!Array.isArray(rounds)) return [];
    return rounds
      .filter((r) => {
        if (filterMode === "benchmark" && !r.is_benchmark) return false;
        if (search.trim()) {
          const s = search.trim().toLowerCase();
          const haystack = [
            r.id,
            r.project_id,
            r.package_type,
            r.round_number ? String(r.round_number) : null,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(s)) return false;
        }
        return true;
      })
      .slice(0, 200);
  }, [rounds, filterMode, search]);

  const totalBenchmark = useMemo(
    () => (rounds || []).filter((r) => r.is_benchmark).length,
    [rounds],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Holdout set
          <span className="text-muted-foreground font-normal">
            ({totalBenchmark} marked)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search round id / project / package…"
              className="pl-7 h-9 text-xs"
            />
          </div>
          <Select value={filterMode} onValueChange={setFilterMode}>
            <SelectTrigger className="h-9 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="benchmark">Benchmark only</SelectItem>
              <SelectItem value="all">All locked rounds</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-10 rounded bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            {filterMode === "benchmark"
              ? "No rounds marked as benchmark yet. Switch to 'All locked rounds' to mark some."
              : "No locked rounds with confirmed shortlists found."}
          </div>
        ) : (
          <ul className="divide-y rounded border max-h-[500px] overflow-y-auto">
            {filtered.map((r) => {
              const confirmedCount = Array.isArray(r.confirmed_shortlist_group_ids)
                ? r.confirmed_shortlist_group_ids.length
                : 0;
              const eligible = confirmedCount > 0;
              const isToggling = togglingId === r.id;
              return (
                <li key={r.id} className="px-3 py-2 flex items-center gap-3 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        #{r.round_number}
                      </Badge>
                      {r.package_type && (
                        <Badge variant="secondary" className="text-[10px]">
                          {r.package_type}
                        </Badge>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {String(r.id).slice(0, 8)}…
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground tabular-nums">
                        {confirmedCount} confirmed
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      locked {fmtTime(r.locked_at)}
                    </div>
                  </div>
                  {!eligible && (
                    <span className="text-[10px] text-amber-600">
                      no confirmed groups
                    </span>
                  )}
                  <Switch
                    checked={!!r.is_benchmark}
                    disabled={!eligible || isToggling}
                    onCheckedChange={(v) => toggleBenchmark({ row: r, next: v })}
                    aria-label={r.is_benchmark ? "Remove from benchmark" : "Add to benchmark"}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function ShortlistingCalibration() {
  const queryClient = useQueryClient();
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [runLimit, setRunLimit] = useState(50);
  const [isRunning, setIsRunning] = useState(false);
  const [togglingId, setTogglingId] = useState(null);

  // Latest + history of benchmark results
  const benchmarksQuery = useQuery({
    queryKey: ["shortlisting_benchmark_results"],
    queryFn: () =>
      api.entities.ShortlistingBenchmarkResult.list("-ran_at", 50),
    staleTime: 15 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const latest = useMemo(() => {
    const arr = benchmarksQuery.data || [];
    return arr.length > 0 ? arr[0] : null;
  }, [benchmarksQuery.data]);

  // Locked rounds with confirmed shortlists
  const roundsQuery = useQuery({
    queryKey: ["shortlisting_calibration_rounds"],
    queryFn: () =>
      api.entities.ShortlistingRound.filter({ status: "locked" }, "-locked_at", 500),
    staleTime: 30 * 1000,
  });

  // Toggle is_benchmark mutation
  const toggleMutation = useMutation({
    mutationFn: async ({ row, next }) => {
      setTogglingId(row.id);
      try {
        return await api.entities.ShortlistingRound.update(row.id, {
          is_benchmark: !!next,
        });
      } finally {
        setTogglingId(null);
      }
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_calibration_rounds"],
      });
      toast.success(
        vars.next ? "Round added to benchmark set." : "Round removed from benchmark set.",
      );
    },
    onError: (err) => toast.error(`Toggle failed: ${err.message}`),
  });

  // Run benchmark
  const runBenchmark = useCallback(async () => {
    setIsRunning(true);
    try {
      // api.functions.invoke returns { data } where data is the edge fn body.
      const { data } = await api.functions.invoke(
        "shortlisting-benchmark-runner",
        { trigger: "manual", limit: Number(runLimit) || 50 },
      );
      if (!data?.ok) {
        throw new Error(
          data?.error || "Benchmark runner returned a non-success response",
        );
      }
      const sample = data.sample_size ?? 0;
      const matchPct = (Number(data.match_rate || 0) * 100).toFixed(1);
      toast.success(`Benchmark complete — ${matchPct}% on ${sample} rounds`);
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_benchmark_results"],
      });
    } catch (err) {
      toast.error(`Benchmark failed: ${err?.message || "unknown error"}`);
    } finally {
      setIsRunning(false);
      setConfirmRunOpen(false);
    }
  }, [runLimit, queryClient]);

  const eligibleCount = useMemo(() => {
    return (roundsQuery.data || []).filter(
      (r) =>
        r.is_benchmark &&
        Array.isArray(r.confirmed_shortlist_group_ids) &&
        r.confirmed_shortlist_group_ids.length > 0,
    ).length;
  }, [roundsQuery.data]);
  const estimatedCost = useMemo(() => {
    const n = Math.min(Number(runLimit) || 50, eligibleCount);
    return Math.max(0, n * 0.03);
  }, [runLimit, eligibleCount]);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Target className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold leading-none">
                Calibration & Benchmark
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Quarterly accuracy benchmark vs confirmed shortlists ·
                baseline {fmtPct(BASELINE)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queryClient.invalidateQueries({
                  queryKey: ["shortlisting_benchmark_results"],
                });
                queryClient.invalidateQueries({
                  queryKey: ["shortlisting_calibration_rounds"],
                });
              }}
              className="text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Refresh
            </Button>
            <Button
              onClick={() => setConfirmRunOpen(true)}
              disabled={isRunning || eligibleCount === 0}
              size="sm"
              className="text-xs"
            >
              {isRunning ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Run benchmark now
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Hero result */}
        <HeroResult latest={latest} isLoading={benchmarksQuery.isLoading} />

        {/* Trend + per-slot side by side on wide */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TrendChart history={benchmarksQuery.data} isLoading={benchmarksQuery.isLoading} />
          <PerSlotBreakdown latest={latest} isLoading={benchmarksQuery.isLoading} />
        </div>

        {/* Per-package + holdout management */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PerPackageBreakdown latest={latest} isLoading={benchmarksQuery.isLoading} />
          <HoldoutManagement
            rounds={roundsQuery.data}
            isLoading={roundsQuery.isLoading}
            toggleBenchmark={(args) => toggleMutation.mutate(args)}
            togglingId={togglingId}
          />
        </div>

        {/* Run dialog */}
        <Dialog open={confirmRunOpen} onOpenChange={setConfirmRunOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Run benchmark now?</DialogTitle>
              <DialogDescription>
                The benchmark re-runs Pass 2 in blind mode against every round
                in the holdout set. Each round costs ~$0.03 in Sonnet API calls.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Round limit</label>
                <Input
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  value={runLimit}
                  onChange={(e) =>
                    setRunLimit(parseInt(e.target.value, 10) || 50)
                  }
                  className="h-9 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  Will run on up to{" "}
                  <span className="font-medium tabular-nums">
                    {Math.min(Number(runLimit) || 50, eligibleCount)}
                  </span>{" "}
                  eligible holdout rounds. Estimated cost{" "}
                  <span className="font-medium tabular-nums">
                    ${estimatedCost.toFixed(2)}
                  </span>{" "}
                  USD.
                </p>
              </div>
              {eligibleCount === 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-2 text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-2">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
                  <span>
                    No eligible rounds in the holdout set. Mark some locked
                    rounds as benchmark first.
                  </span>
                </div>
              )}
              <div className="rounded border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground flex items-start gap-2">
                <DollarSign className="h-3.5 w-3.5 mt-0.5" />
                <span>
                  Cost is approximate — actual usage depends on classification
                  count per round.
                </span>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmRunOpen(false)}
                disabled={isRunning}
              >
                Cancel
              </Button>
              <Button
                onClick={runBenchmark}
                disabled={isRunning || eligibleCount === 0}
              >
                {isRunning ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Running…
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 mr-1.5" />
                    Run benchmark
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PermissionGuard>
  );
}
