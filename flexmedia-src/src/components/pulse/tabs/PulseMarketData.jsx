/**
 * PulseMarketData — Market intelligence tab for Industry Pulse.
 * Sections: Summary stats, Top listing agents, Price distribution,
 *           Suburb heatmap table.
 */
import React, { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Home, DollarSign, Clock, TrendingUp, MapPin, Users, ArrowUpDown, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { isActiveListing, parsePriceText } from "@/components/pulse/utils/listingHelpers";

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
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
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

function StatCard({ label, value, icon: Icon, color, subLabel }) {
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
          {subLabel ? (
            <p className="text-[9px] text-muted-foreground/70 mt-0.5 tabular-nums">{subLabel}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryStats({ pulseListings }) {
  const stats = useMemo(() => {
    // `isActiveListing` covers for_sale + for_rent + under_contract — all
    // "on market" states. Previously only for_sale was counted so
    // under_contract listings silently dropped out of market totals.
    const onMarket = pulseListings.filter((l) => isActiveListing(l));
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalListings = onMarket.length;

    // Price sample: prefer numeric `asking_price`; fall back to parsing
    // `price_text` ("Offers above $1.2M", "$850,000", etc.). Skip rentals —
    // weekly rent is not a property value. This grows the sample from ~32%
    // to ~70% of for_sale listings and de-biases the average (numeric-only
    // advertisers skew toward expensive properties).
    const priceable = onMarket.filter((l) => l.listing_type !== "for_rent");
    const withPrice = priceable
      .map((l) => ({
        ...l,
        _effectivePrice:
          l.asking_price && l.asking_price > 0
            ? l.asking_price
            : parsePriceText(l.price_text),
      }))
      .filter((l) => l._effectivePrice > 0);
    const avgPrice =
      withPrice.length > 0
        ? Math.round(
            withPrice.reduce((s, l) => s + l._effectivePrice, 0) / withPrice.length
          )
        : 0;
    const priceSampleSize = withPrice.length;
    const priceSampleTotal = priceable.length;

    const withDom = pulseListings.filter((l) => l.days_on_market > 0);
    const avgDom =
      withDom.length > 0
        ? Math.round(withDom.reduce((s, l) => s + l.days_on_market, 0) / withDom.length)
        : 0;

    const newThisMonth = pulseListings.filter(
      (l) => l.listed_date && new Date(l.listed_date) >= startOfMonth
    ).length;

    return { totalListings, avgPrice, avgDom, newThisMonth, priceSampleSize, priceSampleTotal };
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
        subLabel={`n = ${stats.priceSampleSize.toLocaleString()} of ${stats.priceSampleTotal.toLocaleString()}`}
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
  const { data, sampleSize, sampleTotal } = useMemo(() => {
    // On-market listings (for_sale + under_contract) with a price. Rentals
    // excluded — weekly rent is not a property value. Previously limited to
    // numeric `asking_price` only (~32% of for_sale); now falls back to
    // parsing `price_text` which lifts the sample to ~70%.
    const priceable = pulseListings.filter(
      (l) => isActiveListing(l) && l.listing_type !== "for_rent"
    );
    const withPrice = priceable
      .map((l) => ({
        _effectivePrice:
          l.asking_price && l.asking_price > 0
            ? l.asking_price
            : parsePriceText(l.price_text),
      }))
      .filter((l) => l._effectivePrice > 0);
    return {
      data: PRICE_BRACKETS.map((bracket) => ({
        label: bracket.label,
        count: withPrice.filter(
          (l) => l._effectivePrice >= bracket.min && l._effectivePrice < bracket.max
        ).length,
      })),
      sampleSize: withPrice.length,
      sampleTotal: priceable.length,
    };
  }, [pulseListings]);

  const hasData = data.some((d) => d.count > 0);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-green-500" />
          Price Distribution
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          For-sale listings by price bracket
          {" · "}
          <span className="tabular-nums">n = {sampleSize.toLocaleString()} of {sampleTotal.toLocaleString()}</span>
        </p>
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

function HeatmapSortIcon({ col, sort }) {
  if (sort.col !== col)
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 ml-0.5 inline" />;
  return sort.dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-primary ml-0.5 inline" />
  ) : (
    <ChevronDown className="h-3 w-3 text-primary ml-0.5 inline" />
  );
}

function SuburbHeatmapTable({ pulseListings }) {
  const [sort, setSort] = useState({ col: "count", dir: "desc" });

  function toggleSort(col) {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "desc" }
    );
  }

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

    const mapped = Object.entries(suburbMap)
      .map(([suburb, s]) => ({
        suburb,
        count: s.count,
        avgPrice: s.priceCount > 0 ? Math.round(s.priceSum / s.priceCount) : 0,
        avgDom: s.domCount > 0 ? Math.round(s.domSum / s.domCount) : 0,
      }));

    // Sort
    const mul = sort.dir === "asc" ? 1 : -1;
    mapped.sort((a, b) => {
      if (sort.col === "suburb") {
        return mul * a.suburb.localeCompare(b.suburb);
      }
      return mul * ((a[sort.col] || 0) - (b[sort.col] || 0));
    });

    return mapped.slice(0, 20);
  }, [pulseListings, sort]);

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
                  <th
                    className="text-left py-2 pr-3 text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort("suburb")}
                  >
                    Suburb <HeatmapSortIcon col="suburb" sort={sort} />
                  </th>
                  <th
                    className="text-right py-2 pr-3 text-[10px] font-medium text-muted-foreground w-16 cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort("count")}
                  >
                    Listings <HeatmapSortIcon col="count" sort={sort} />
                  </th>
                  <th
                    className="text-right py-2 pr-3 text-[10px] font-medium text-muted-foreground w-20 hidden sm:table-cell cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort("avgPrice")}
                  >
                    Avg Price <HeatmapSortIcon col="avgPrice" sort={sort} />
                  </th>
                  <th
                    className="text-right py-2 text-[10px] font-medium text-muted-foreground w-14 hidden sm:table-cell cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort("avgDom")}
                  >
                    Avg DOM <HeatmapSortIcon col="avgDom" sort={sort} />
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

// ── Filter constants ─────────────────────────────────────────────────────────

const TIME_RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const PROPERTY_TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "house", label: "House" },
  { value: "apartment", label: "Apartment" },
  { value: "townhouse", label: "Townhouse" },
];

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
  const [timeRange, setTimeRange] = useState("all");
  const [propertyType, setPropertyType] = useState("all");

  // Filter listings by time range and property type
  const filteredListings = useMemo(() => {
    let list = pulseListings;

    // Time range filter
    if (timeRange !== "all") {
      const days = Number(timeRange);
      const cutoff = new Date(Date.now() - days * 86400000);
      list = list.filter((l) => {
        const d = l.listed_date || l.created_at;
        return d && new Date(d) >= cutoff;
      });
    }

    // Property type filter
    if (propertyType !== "all") {
      list = list.filter(
        (l) => (l.property_type || "").toLowerCase() === propertyType
      );
    }

    return list;
  }, [pulseListings, timeRange, propertyType]);

  return (
    <div className="space-y-6">
      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Time range */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mr-1">
            Time:
          </span>
          {TIME_RANGE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={timeRange === opt.value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setTimeRange(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        <span className="text-muted-foreground text-xs mx-1">|</span>

        {/* Property type */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mr-1">
            Property:
          </span>
          {PROPERTY_TYPE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={propertyType === opt.value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setPropertyType(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        {/* Filtered count */}
        <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
          {filteredListings.length.toLocaleString()} listings
        </span>
      </div>

      {/* Section 1: Summary stats */}
      <SummaryStats pulseListings={filteredListings} />

      {/* Section 2 + 3: Agents table + Price distribution side-by-side on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopListingAgentsTable pulseListings={filteredListings} crmAgents={crmAgents} />
        <PriceDistributionChart pulseListings={filteredListings} />
      </div>

      {/* Section 4: Suburb heatmap */}
      <SuburbHeatmapTable pulseListings={filteredListings} />
    </div>
  );
}
