/**
 * SettingsShortlistingOverrides — Wave 6 Phase 8 SHORTLIST
 *
 * master_admin only. Aggregated view of every drag/swap action humans
 * have made on AI shortlist proposals — segmented by slot, signal,
 * action type, and project tier.
 *
 * Reads via the get_override_analytics(p_since, p_package_type, p_project_tier)
 * RPC (mig 295). The RPC returns ranked rows per dimension with count + rate.
 *
 * Recalibration suggestions are generated client-side from the signal
 * dimension: any signal with rate > 0.30 surfaces as "Consider lowering
 * weight on signal X". This is informational only — actual weight
 * recalibration happens manually via the SettingsShortlistingSignals page.
 *
 * Mirrors the Phase 7 admin-config page conventions: PermissionGuard at the
 * top, TanStack Query for data, Card-based layout, Tailwind only.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  BarChart3,
  Loader2,
  RefreshCw,
  TrendingDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TIME_RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "365", label: "Last year" },
  { value: "all", label: "All time" },
];

const PACKAGE_TYPES = [
  { value: "all", label: "All packages" },
  { value: "Gold", label: "Gold" },
  { value: "Day to Dusk", label: "Day to Dusk" },
  { value: "Premium", label: "Premium" },
];

const PROJECT_TIERS = [
  { value: "all", label: "All tiers" },
  { value: "standard", label: "Standard" },
  { value: "premium", label: "Premium" },
];

// Override rate threshold above which a signal flags as a recalibration
// candidate. Conservatively set — too low and every signal looks suspect.
const RECAL_THRESHOLD = 0.3;

function fmtPct(n) {
  if (n == null || !isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function dimensionTitle(dim) {
  return (
    {
      slot: "Most-overridden slots",
      signal: "Most-overridden signals",
      action: "Action breakdown",
      tier: "Tier comparison",
    }[dim] || dim
  );
}

function dimensionDescription(dim) {
  return (
    {
      slot: "Slots where humans most often disagreed with the AI's pick or filling.",
      signal:
        "Signals primary_signal_overridden was set to. High rates suggest the signal weight or its scoring rubric needs revisiting.",
      action: "Distribution of human actions taken on AI proposals.",
      tier: "Override volume by project tier — premium tier typically has higher override rates.",
    }[dim] || ""
  );
}

function dimensionIcon(dim) {
  return (
    {
      slot: BarChart3,
      signal: TrendingDown,
      action: RefreshCw,
      tier: AlertCircle,
    }[dim] || BarChart3
  );
}

// ── Ranked list card ────────────────────────────────────────────────────────
function RankedListCard({ dim, rows, total, loading }) {
  const Icon = dimensionIcon(dim);
  const sorted = useMemo(
    () => [...(rows || [])].sort((a, b) => Number(b.count) - Number(a.count)),
    [rows],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4" />
          {dimensionTitle(dim)}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{dimensionDescription(dim)}</p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            No override data in this slice yet.
          </div>
        ) : (
          <ol className="space-y-2">
            {sorted.slice(0, 10).map((row, i) => {
              const rate = Number(row.rate || 0);
              const widthPct = Math.max(2, Math.round(rate * 100));
              return (
                <li key={`${row.bucket}-${i}`} className="text-xs">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono text-[11px] truncate" title={row.bucket}>
                      {row.bucket}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {row.count} · {fmtPct(rate)}
                    </span>
                  </div>
                  <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        dim === "signal" && rate >= RECAL_THRESHOLD
                          ? "bg-amber-500"
                          : "bg-primary",
                      )}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recalibration suggestions ───────────────────────────────────────────────
function RecalibrationSuggestions({ analytics }) {
  const suggestions = useMemo(() => {
    if (!analytics) return [];
    return (analytics.signal || [])
      .filter((row) => Number(row.rate || 0) >= RECAL_THRESHOLD)
      .sort((a, b) => Number(b.rate) - Number(a.rate))
      .map((row) => ({
        signal: row.bucket,
        rate: Number(row.rate),
        count: Number(row.count),
      }));
  }, [analytics]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingDown className="h-4 w-4" />
          Recalibration suggestions
          <Badge variant="outline" className="text-[10px]">
            informational
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Signals overridden in more than {fmtPct(RECAL_THRESHOLD)} of cases.
          Adjust weights manually via Settings · Shortlist · Signals.
        </p>
      </CardHeader>
      <CardContent>
        {suggestions.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-4 text-center">
            No signals exceed the {fmtPct(RECAL_THRESHOLD)} override rate threshold —
            engine is well-calibrated for the current slice.
          </div>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li
                key={s.signal}
                className="flex items-center justify-between gap-3 p-2 rounded border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs truncate">{s.signal}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {s.count} overrides · {fmtPct(s.rate)} of total
                  </div>
                </div>
                <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-300 shrink-0">
                  consider lowering weight
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function SettingsShortlistingOverrides() {
  const [range, setRange] = useState("90");
  const [packageType, setPackageType] = useState("all");
  const [tier, setTier] = useState("all");

  const sinceIso = useMemo(() => {
    if (range === "all") return null;
    const days = Number(range);
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }, [range]);

  const analyticsQuery = useQuery({
    queryKey: ["override_analytics", sinceIso, packageType, tier],
    queryFn: async () => {
      const params = {
        p_since: sinceIso,
        p_package_type: packageType === "all" ? null : packageType,
        p_project_tier: tier === "all" ? null : tier,
      };
      const rows = await api.rpc("get_override_analytics", params);
      // Bucket by dimension. RPC returns one row per (dimension, bucket).
      const byDim = { slot: [], signal: [], action: [], tier: [] };
      for (const row of rows || []) {
        const d = String(row.dimension || "").toLowerCase();
        if (byDim[d]) byDim[d].push(row);
      }
      return byDim;
    },
    staleTime: 60 * 1000,
  });

  const totalOverrides = useMemo(() => {
    const a = analyticsQuery.data?.action || [];
    return a.reduce((sum, r) => sum + Number(r.count || 0), 0);
  }, [analyticsQuery.data]);

  return (
    <PermissionGuard requireRole={["master_admin"]}>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Override Analytics</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Where humans disagree with AI shortlist proposals — segmented by slot,
              signal, action, and tier. Used to surface recalibration candidates.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={packageType} onValueChange={setPackageType}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PACKAGE_TYPES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_TIERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Summary card */}
        <Card>
          <CardContent className="py-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-primary/10 p-2">
                <BarChart3 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold tabular-nums">{totalOverrides}</div>
                <div className="text-xs text-muted-foreground">total overrides in slice</div>
              </div>
            </div>
            {analyticsQuery.isFetching && (
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                refreshing…
              </div>
            )}
          </CardContent>
        </Card>

        {/* 2x2 grid of ranked lists */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {["slot", "signal", "action", "tier"].map((dim) => (
            <RankedListCard
              key={dim}
              dim={dim}
              rows={analyticsQuery.data?.[dim] || []}
              total={totalOverrides}
              loading={analyticsQuery.isLoading}
            />
          ))}
        </div>

        {/* Recalibration suggestions */}
        <RecalibrationSuggestions analytics={analyticsQuery.data} />

        {analyticsQuery.error && (
          <Card className="border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900">
            <CardContent className="py-3 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Failed to load analytics: {String(analyticsQuery.error?.message || analyticsQuery.error)}
            </CardContent>
          </Card>
        )}
      </div>
    </PermissionGuard>
  );
}
