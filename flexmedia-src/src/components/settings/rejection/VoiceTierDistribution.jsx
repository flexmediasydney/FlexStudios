/**
 * VoiceTierDistribution — W11.6 widget C.
 *
 * Renders the distribution of `property_tier` on shortlisting_master_listings
 * over the selected time window. Stacked bar (single-row stack — each tier
 * gets a proportional segment).
 *
 * Why this widget exists:
 *   W11.7.7/W11.7.8 introduced the voice tier modulation: each
 *   master_listing has a `property_tier` (premium / standard / approachable).
 *   If the engine is mass-producing 'approachable' copy on Tier S projects
 *   (or vice versa), that's a tier-coercion bug worth catching before it
 *   ships to a customer.
 *
 * RPC payload shape:
 *   data.total — int, count of master_listings rows
 *   data.by_tier[] — array of { tier, count }
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";

const TIER_TONE = {
  premium:      "bg-violet-500 dark:bg-violet-600",
  standard:     "bg-blue-500 dark:bg-blue-600",
  approachable: "bg-emerald-500 dark:bg-emerald-600",
  unspecified:  "bg-slate-400 dark:bg-slate-600",
};

/**
 * Pure helper: pick a tone class for a tier label. Exported for tests.
 */
export function tierTone(tier) {
  if (!tier) return TIER_TONE.unspecified;
  const key = String(tier).toLowerCase();
  return TIER_TONE[key] || TIER_TONE.unspecified;
}

/**
 * Pure helper: turn the raw by_tier array into bar segments with widths.
 * Returns a stable order (premium, standard, approachable, then any others).
 * Exported for tests so the bar-segment math can be asserted independently.
 */
export function buildTierSegments(byTier, total) {
  const safeTotal = Math.max(1, Number(total) || 0);
  if (!Array.isArray(byTier) || byTier.length === 0) return [];
  const PREFERRED_ORDER = ["premium", "standard", "approachable"];
  const sorted = [...byTier].sort((a, b) => {
    const ai = PREFERRED_ORDER.indexOf(String(a?.tier || "").toLowerCase());
    const bi = PREFERRED_ORDER.indexOf(String(b?.tier || "").toLowerCase());
    if (ai === -1 && bi === -1) return Number(b?.count || 0) - Number(a?.count || 0);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return sorted.map((row) => {
    const count = Number(row?.count) || 0;
    return {
      tier: String(row?.tier || "unspecified"),
      count,
      pct: (count / safeTotal) * 100,
    };
  });
}

export default function VoiceTierDistribution({ data, loading, daysBack }) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Mic className="h-4 w-4" />
            Voice tier distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  const total = Number(data?.total) || 0;
  const segments = buildTierSegments(data?.by_tier, total);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Mic className="h-4 w-4" />
            Voice tier distribution
          </span>
          <Badge variant="outline" className="text-[10px]">
            {total} listings · last {daysBack || 30}d
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-2">
        {segments.length === 0 ? (
          <div className="text-xs text-muted-foreground py-3" data-testid="voice-empty">
            No master_listings in this window.
          </div>
        ) : (
          <>
            <div className="flex h-6 rounded-md overflow-hidden bg-muted">
              {segments.map((seg) => (
                <div
                  key={seg.tier}
                  className={cn("h-full transition-all", tierTone(seg.tier))}
                  style={{ width: `${seg.pct}%` }}
                  title={`${seg.tier}: ${seg.count} (${seg.pct.toFixed(1)}%)`}
                  data-testid="voice-segment"
                  data-tier={seg.tier}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2 mt-1">
              {segments.map((seg) => (
                <div key={`legend-${seg.tier}`} className="flex items-center gap-1 text-[11px]">
                  <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", tierTone(seg.tier))} />
                  <span className="font-mono">{seg.tier}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {seg.count} ({seg.pct.toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
