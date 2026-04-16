/**
 * PulseMarketData — Market intelligence tab for Industry Pulse.
 * Sections: Summary stats, Top listing agents, Price distribution,
 *           Suburb heatmap table.
 */
import React, { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Home, DollarSign, Clock, TrendingUp, MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  return v >= 1000000
    ? `$${(v / 1000000).toFixed(1)}M`
    : v >= 1000
    ? `$${Math.round(v / 1000)}K`
    : `$${v}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

// ── Tooltip styling ───────────────────────────────────────────────────────────

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  borderColor: "hsl(var(--border))",
  borderRadius: "0.5rem",
  fontSize: "11px",
  color: "hsl(var(--foreground))",
};

const axisStyle = {
  tick: { fill: "hsl(var(--muted-foreground))", fontSize: 10 },
};

// ── Price brackets ────────────────────────────────────────────────────────────

const PRICE_BRACKETS = [
  { label: "$0–500K", min: 0, max: 500_000 },
  { label: "$500K–1M", min: 500_000, max: 1_000_000 },
  { label: "$1–2M", min: 1_000_000, max: 2_000_000 },
  { label: "$2–5M", min: 2_000_000, max: 5_000_000 },
  { label: "$5M+", min: 5_000_000, max: Infinity },
];

const BRACKET_COLORS = ["#64748b", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899"];

// ── Section 1: Summary Stats ──────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardContent className="p-3 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted/60 shrink-0">
          <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>
            {value}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryStats({ pulseListings }) {
  const stats = useMemo(() => {
    const forSale = pulseListings.filter((l) => l.listing_type === "for_sale");
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalListings = forSale.length;

    const withPrice = forSale.filter((l) => l.asking_price > 0);
    const avgPrice =
      withPrice.length > 0
        ? Math.round(withPrice.reduce((s, l) => s + l.asking_price, 0) / withPrice.length)
        : 0;

    const withDom = pulseListings.filter((l) => l.days_on_market > 0);
    const avgDom =
      withDom.length > 0
        ? Math.round(withDom.reduce((s, l) => s + l.days_on_market, 0) / withDom.length)
        : 0;

    const newThisMonth = pulseListings.filter(
      (l) => l.listed_date && new Date(l.listed_date) >= startOfMonth
    ).length;

    return { totalListings, avgPrice, avgDom, newThisMonth };
  }, [pulseListings]);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        label="Total For-Sale Listings"
        value={stats.totalListings.toLocaleString()}
        icon={Home}
        color="text-blue-500"
      />
      <StatCard
        label="Avg Asking Price"
        value={fmtPrice(stats.avgPrice)}
        icon={DollarSign}
        color="text-green-500"
      />
      <StatCard
        label="Avg Days on Market"
        value={stats.avgDom > 0 ? `${stats.avgDom}d` : "—"}
        icon={Clock}
        color="text-amber-500"
      />
      <StatCard
        label="New This Month"
        value={stats.newThisMonth.toLocaleString()}
        icon={TrendingUp}
        color="text-purple-500"
      />
    </div>
  );
}

// ── Section 2: Top Listing Agents ─────────────────────────────────────────────

function TopListingAgentsTable({ pulseListings, crmAgents }) {
  const rows = useMemo(() => {
    const forSale = pulseListings.filter((l) => l.listing_type === "for_sale");

    // Build a set of normalised CRM agent names for quick lookup
    const crmNameSet = new Set(
      (crmAgents || []).map((a) => (a.name || "").toLowerCase().trim())
    );

    const countMap = {};
    const agencyMap = {};

    forSale.forEach((l) => {
      const name = l.agent_name;
      if (!name) return;
      countMap[name] = (countMap[name] || 0) + 1;
      if (!agencyMap[name] && l.agency_name) agencyMap[name] = l.agency_name;
    });

    return Object.entries(countMap)
      .map(([name, count]) => ({
        name,
        agency: agencyMap[name] || "—",
        count,
        isCrmClient: crmNameSet.has(name.toLowerCase().trim()),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }, [pulseListings, crmAgents]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-blue-500" />
          Top Listing Agents (For Sale)
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Top 15 by listing count</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No listing agent data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-2 pr-3 text-[10px] font-medium text-muted-foreground w-6">#</th>
                  <th className="text-left py-2 pr-3 text-[10px] font-medium text-muted-foreground">Agent</th>
                  <th className="text-left py-2 pr-3 text-[10px] font-medium text-muted-foreground hidden sm:table-cell">Agency</th>
                  <th className="text-right py-2 pr-3 text-[10px] font-medium text-muted-foreground w-12">Listings</th>
                  <th className="text-center py-2 text-[10px] font-medium text-muted-foreground w-16">CRM</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.name}
                    className="border-b border-border/20 hover:bg-muted/20 transition-colors"
                  >
                    <td className="py-1.5 pr-3 text-muted-foreground/60 tabular-nums">{row.rank}</td>
                    <td className="py-1.5 pr-3 font-medium truncate max-w-[120px]">{row.name}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground truncate max-w-[140px] hidden sm:table-cell">
                      {row.agency}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{row.count}</td>
                    <td className="py-1.5 text-center">
                      {row.isCrmClient ? (
                        <Badge className="text-[8px] px-1.5 py-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">
                          Client
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[8px] px-1.5 py-0 text-muted-foreground">
                          —
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Section 3: Price Distribution ────────────────────────────────────────────

function PriceDistributionChart({ pulseListings }) {
  const data = useMemo(() => {
    const forSale = pulseListings.filter(
      (l) => l.listing_type === "for_sale" && l.asking_price > 0
    );
    return PRICE_BRACKETS.map((bracket) => ({
      label: bracket.label,
      count: forSale.filter(
        (l) => l.asking_price >= bracket.min && l.asking_price < bracket.max
      ).length,
    }));
  }, [pulseListings]);

  const hasData = data.some((d) => d.count > 0);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-green-500" />
          Price Distribution
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">For-sale listings by price bracket</p>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        {!hasData ? (
          <div className="h-[200px] flex items-center justify-center">
            <p className="text-xs text-muted-foreground/50">No price data available</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" {...axisStyle} tickLine={false} axisLine={false} />
              <YAxis {...axisStyle} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={{ fill: "hsl(var(--muted)/0.25)" }}
                formatter={(v) => [v, "Listings"]}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56}>
                {data.map((entry, i) => (
                  <Cell key={entry.label} fill={BRACKET_COLORS[i % BRACKET_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── Section 4: Suburb Heatmap Table ───────────────────────────────────────────

function SuburbHeatmapTable({ pulseListings }) {
  const rows = useMemo(() => {
    const suburbMap = {};

    pulseListings.forEach((l) => {
      if (!l.suburb) return;
      if (!suburbMap[l.suburb]) {
        suburbMap[l.suburb] = { count: 0, priceSum: 0, priceCount: 0, domSum: 0, domCount: 0 };
      }
      const s = suburbMap[l.suburb];
      s.count++;
      if (l.asking_price > 0) { s.priceSum += l.asking_price; s.priceCount++; }
      if (l.days_on_market > 0) { s.domSum += l.days_on_market; s.domCount++; }
    });

    return Object.entries(suburbMap)
      .map(([suburb, s]) => ({
        suburb,
        count: s.count,
        avgPrice: s.priceCount > 0 ? Math.round(s.priceSum / s.priceCount) : 0,
        avgDom: s.domCount > 0 ? Math.round(s.domSum / s.domCount) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }, [pulseListings]);

  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  // Intensity helper for heatmap colouring
  function intensityClass(count) {
    const pct = count / maxCount;
    if (pct >= 0.75) return "bg-blue-500/20 text-blue-700 dark:text-blue-300";
    if (pct >= 0.5) return "bg-blue-400/15 text-blue-600 dark:text-blue-400";
    if (pct >= 0.25) return "bg-blue-300/10 text-blue-500 dark:text-blue-500";
    return "";
  }

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-rose-500" />
          Suburb Market Heatmap
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Top 20 suburbs by listing count — all types</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No suburb data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-2 pr-3 text-[10px] font-medium text-muted-foreground">Suburb</th>
                  <th className="text-right py-2 pr-3 text-[10px] font-medium text-muted-foreground w-16">Listings</th>
                  <th className="text-right py-2 pr-3 text-[10px] font-medium text-muted-foreground w-20 hidden sm:table-cell">
                    Avg Price
                  </th>
                  <th className="text-right py-2 text-[10px] font-medium text-muted-foreground w-14 hidden sm:table-cell">
                    Avg DOM
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.suburb}
                    className={cn(
                      "border-b border-border/20 hover:bg-muted/20 transition-colors",
                      intensityClass(row.count)
                    )}
                  >
                    <td className="py-1.5 pr-3 font-medium">{row.suburb}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{row.count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                      {fmtPrice(row.avgPrice)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                      {row.avgDom > 0 ? `${row.avgDom}d` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function PulseMarketData({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  pulseEvents = [],
  pulseSignals = [],
  crmAgents = [],
  projects = [],
  pulseMappings = [],
  pulseTimeline = [],
  stats = {},
  search = "",
}) {
  return (
    <div className="space-y-6">
      {/* Section 1: Summary stats */}
      <SummaryStats pulseListings={pulseListings} />

      {/* Section 2 + 3: Agents table + Price distribution side-by-side on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopListingAgentsTable pulseListings={pulseListings} crmAgents={crmAgents} />
        <PriceDistributionChart pulseListings={pulseListings} />
      </div>

      {/* Section 4: Suburb heatmap */}
      <SuburbHeatmapTable pulseListings={pulseListings} />
    </div>
  );
}
