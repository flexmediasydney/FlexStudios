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
  LineChart, Line, Legend, PieChart, Pie,
} from "recharts";
import { Home, DollarSign, Clock, TrendingUp, MapPin, Users, ArrowUpDown, ChevronUp, ChevronDown, Activity, PieChart as PieChartIcon } from "lucide-react";
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
    // MK01: use UTC month boundary so AU users don't see the counter flicker
    // during the window between local midnight and 00:00 UTC on the 1st.
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

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

// ── ISO week helper ──────────────────────────────────────────────────────────
//
// Returns { key, label, start } for the ISO week containing `date`. Key is a
// sortable string like "2026-W15" (ISO-8601 Monday-start). Label is a short
// display form ("15 Apr"). `start` is the Date of the Monday 00:00 local.

function isoWeekInfo(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  // Shift to local Monday 00:00
  const day = d.getDay(); // 0..6, Sun..Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset);

  // ISO week number: Thursday of same week determines the ISO year
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstThursdayMonday = new Date(firstThursday);
  const ftDay = firstThursday.getDay();
  firstThursdayMonday.setDate(
    firstThursday.getDate() + (ftDay === 0 ? -6 : 1 - ftDay)
  );
  const weekNum =
    1 +
    Math.round(
      (monday.getTime() - firstThursdayMonday.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
  const key = `${thursday.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  const label = monday.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
  return { key, label, start: monday };
}

// ── Section 2: Top Listing Agents ─────────────────────────────────────────────

function TopListingAgentsTable({ pulseListings, crmAgents, pulseAgents, onOpenEntity }) {
  const rows = useMemo(() => {
    const forSale = pulseListings.filter((l) => l.listing_type === "for_sale");

    // Build a set of normalised CRM agent names for quick lookup
    const crmNameSet = new Set(
      (crmAgents || []).map((a) => (a.name || "").toLowerCase().trim())
    );

    // Normalise agent names before grouping — collapse "J Smith" / "John Smith"
    // / "JOHN SMITH" only when they actually match by lowercase+trim. We keep
    // the original display form from the first occurrence so the UI still
    // renders sensibly.
    const countMap = {};   // normKey → count
    const displayMap = {}; // normKey → canonical display name (first seen)
    const agencyMap = {};  // normKey → agency
    const reaIdMap = {};   // normKey → first seen agent_rea_id

    forSale.forEach((l) => {
      const rawName = l.agent_name;
      if (!rawName) return;
      const normKey = rawName.toLowerCase().trim();
      if (!normKey) return;
      countMap[normKey] = (countMap[normKey] || 0) + 1;
      if (!displayMap[normKey]) displayMap[normKey] = rawName.trim();
      if (!agencyMap[normKey] && l.agency_name) agencyMap[normKey] = l.agency_name;
      if (!reaIdMap[normKey] && l.agent_rea_id) reaIdMap[normKey] = l.agent_rea_id;
    });

    return Object.entries(countMap)
      .map(([normKey, count]) => {
        const reaId = reaIdMap[normKey] || null;
        const pulseAgent = reaId
          ? (pulseAgents || []).find((a) => a.rea_agent_id === reaId)
          : null;
        return {
          name: displayMap[normKey],
          agency: agencyMap[normKey] || "—",
          count,
          isCrmClient: crmNameSet.has(normKey),
          agentReaId: reaId,
          pulseAgentId: pulseAgent?.id || null,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }, [pulseListings, crmAgents, pulseAgents]);

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
                {rows.map((row) => {
                  const canOpen = !!(onOpenEntity && row.pulseAgentId);
                  return (
                  <tr
                    key={row.name}
                    onClick={
                      canOpen
                        ? () => onOpenEntity({ type: "agent", id: row.pulseAgentId })
                        : undefined
                    }
                    className={cn(
                      "border-b border-border/20 hover:bg-muted/20 transition-colors",
                      canOpen && "cursor-pointer"
                    )}
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
                  );
                })}
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
      // Apply same parsePriceText fallback as the main chart — prefer numeric
      // asking_price, fall back to parsing price_text. Skip rentals (weekly
      // rent is not a property value). Grows sample to ~70%.
      if (l.listing_type !== "for_rent") {
        const effectivePrice =
          l.asking_price && l.asking_price > 0
            ? l.asking_price
            : parsePriceText(l.price_text);
        if (effectivePrice > 0) { s.priceSum += effectivePrice; s.priceCount++; }
      }
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

// ── Section 5: Weekly Trend Chart ────────────────────────────────────────────

function WeeklyTrendChart({ pulseListings }) {
  const data = useMemo(() => {
    // Build last 13 ISO weeks, ending with the current week. Listings are
    // bucketed separately by listed_date (new) and sold_date (sold).
    const nowInfo = isoWeekInfo(new Date());
    if (!nowInfo) return [];

    // Generate 13 weeks back from now
    const weeks = [];
    for (let i = 12; i >= 0; i--) {
      const start = new Date(nowInfo.start);
      start.setDate(start.getDate() - i * 7);
      const info = isoWeekInfo(start);
      if (info) weeks.push({ ...info, new: 0, sold: 0 });
    }
    const byKey = Object.fromEntries(weeks.map((w) => [w.key, w]));
    const earliest = weeks[0]?.start;

    pulseListings.forEach((l) => {
      if (l.listed_date) {
        const info = isoWeekInfo(l.listed_date);
        if (info && earliest && info.start >= earliest && byKey[info.key]) {
          byKey[info.key].new += 1;
        }
      }
      if (l.sold_date) {
        const info = isoWeekInfo(l.sold_date);
        if (info && earliest && info.start >= earliest && byKey[info.key]) {
          byKey[info.key].sold += 1;
        }
      }
    });

    return weeks;
  }, [pulseListings]);

  const hasData = data.some((w) => w.new > 0 || w.sold > 0);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-500" />
          Weekly Trend — New vs Sold
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Last 13 weeks by ISO week</p>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        {!hasData ? (
          <div className="h-[200px] flex items-center justify-center">
            <p className="text-xs text-muted-foreground/50">No weekly trend data available</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 8, right: 16, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" {...axisStyle} tickLine={false} axisLine={false} />
              <YAxis {...axisStyle} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(label, payload) => {
                  const entry = payload && payload[0] && payload[0].payload;
                  return entry ? `Week of ${entry.label} (${entry.key})` : label;
                }}
                formatter={(v, name) => [v, name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
              <Line
                type="monotone"
                dataKey="new"
                name="New Listings"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="sold"
                name="Sold"
                stroke="#ef4444"
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── Section 6: Market Breakdown Donut ────────────────────────────────────────

// Colour-coded consistent with the listing-type badges used in PulseListings.
const BREAKDOWN_SLICES = [
  { key: "for_sale", label: "For Sale", color: "#10b981" },        // emerald-500
  { key: "for_rent", label: "For Rent", color: "#3b82f6" },        // blue-500
  { key: "under_contract", label: "Under Contract", color: "#f59e0b" }, // amber-500
  { key: "sold", label: "Sold", color: "#ef4444" },                // red-500
];

function MarketBreakdownDonut({ pulseListings }) {
  const { data, total } = useMemo(() => {
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const recent = pulseListings.filter((l) => {
      // Include if either listed_date or sold_date falls inside last 90 days,
      // else fall back to created_at. This matches the spirit of "last 90d"
      // without dropping listings that are currently on-market but were
      // listed earlier.
      const ref =
        l.sold_date || l.listed_date || l.created_at;
      return ref && new Date(ref) >= cutoff;
    });

    const counts = Object.fromEntries(BREAKDOWN_SLICES.map((s) => [s.key, 0]));
    recent.forEach((l) => {
      if (l.listing_type && counts.hasOwnProperty(l.listing_type)) {
        counts[l.listing_type] += 1;
      }
    });

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const data = BREAKDOWN_SLICES.map((s) => ({
      name: s.label,
      key: s.key,
      value: counts[s.key],
      color: s.color,
    }));
    return { data, total };
  }, [pulseListings]);

  const hasData = total > 0;

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <PieChartIcon className="h-4 w-4 text-fuchsia-500" />
          Market Breakdown
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          By listing type · last 90 days
          {hasData ? <> · <span className="tabular-nums">n = {total.toLocaleString()}</span></> : null}
        </p>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        {!hasData ? (
          <div className="h-[220px] flex items-center justify-center">
            <p className="text-xs text-muted-foreground/50">No breakdown data available</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v, name) => {
                  const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
                  return [`${v} (${pct}%)`, name];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={48}
                outerRadius={80}
                paddingAngle={2}
                stroke="hsl(var(--card))"
                strokeWidth={2}
              >
                {data.map((entry) => (
                  <Cell key={entry.key} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

// ── Filter constants ─────────────────────────────────────────────────────────

const TIME_RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

// MK06: property-type options are now computed dynamically from pulseListings
// (see `usePropertyTypeOptions` below) rather than hard-coded. Prod data has
// >15 distinct normalised types — house/apartment/townhouse alone dropped
// ~40% of listings out of the filter.

// Grouped fallback used when the distinct count ≥ 12. Values are matched
// against normalised (lowercase-trimmed) property_type values — covers both
// canonical REA values and common free-text drift.
const PROPERTY_TYPE_GROUPS = {
  residential: new Set([
    "house", "apartment", "townhouse", "unit", "studio", "villa",
    "duplex/semi-detached", "semi-detached", "terrace", "flat",
    "apartment / unit / flat", "unitblock", "retirement living",
  ]),
  land: new Set(["land", "rural", "residential land"]),
  commercial: new Set(["commercial", "commercial property", "business"]),
};

const GROUPED_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "group:residential", label: "Residential" },
  { value: "group:land", label: "Land" },
  { value: "group:commercial", label: "Commercial" },
];

// Label-case a normalised property type key for display.
// "residential land" → "Residential Land", "duplex/semi-detached" → "Duplex/Semi-Detached".
function toLabelCase(key) {
  return key
    .split(/([\s/-])/)
    .map((part) =>
      /^[\s/-]$/.test(part)
        ? part
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join("");
}

function usePropertyTypeOptions(pulseListings) {
  return useMemo(() => {
    const counts = {};
    for (const l of pulseListings) {
      const raw = l.property_type;
      if (!raw) continue;
      const norm = String(raw).toLowerCase().trim();
      if (!norm) continue;
      counts[norm] = (counts[norm] || 0) + 1;
    }

    const distinctAboveThreshold = Object.entries(counts)
      .filter(([, n]) => n >= 5)
      .sort((a, b) => b[1] - a[1]);

    // Fallback: too many distinct values → offer grouped dropdown instead.
    if (distinctAboveThreshold.length >= 12) {
      return { options: GROUPED_OPTIONS, grouped: true };
    }

    const options = [
      { value: "all", label: "All Types" },
      ...distinctAboveThreshold.map(([key, n]) => ({
        value: key,
        label: `${toLabelCase(key)} (${n.toLocaleString()})`,
      })),
    ];
    return { options, grouped: false };
  }, [pulseListings]);
}

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
  onOpenEntity,
}) {
  const [timeRange, setTimeRange] = useState("30");
  const [propertyType, setPropertyType] = useState("all");

  // MK06: dynamic options based on real prod data. Groups fallback kicks in
  // automatically if distinct count ≥ 12 (caps dropdown width + clutter).
  const { options: propertyTypeOptions } = usePropertyTypeOptions(pulseListings);

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

    // Property type filter — supports exact normalised match and
    // `group:<name>` aggregate values (residential / land / commercial).
    if (propertyType !== "all") {
      if (propertyType.startsWith("group:")) {
        const groupKey = propertyType.slice(6);
        const groupSet = PROPERTY_TYPE_GROUPS[groupKey];
        if (groupSet) {
          list = list.filter((l) =>
            groupSet.has((l.property_type || "").toLowerCase().trim())
          );
        }
      } else {
        list = list.filter(
          (l) => (l.property_type || "").toLowerCase().trim() === propertyType
        );
      }
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

        {/* Property type — dynamic options (MK06) */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mr-1">
            Property:
          </span>
          {propertyTypeOptions.map((opt) => (
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

      {/* Section 5 + 6: Weekly trend + Market breakdown donut */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WeeklyTrendChart pulseListings={filteredListings} />
        <MarketBreakdownDonut pulseListings={filteredListings} />
      </div>

      {/* Section 2 + 3: Agents table + Price distribution side-by-side on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopListingAgentsTable
          pulseListings={filteredListings}
          crmAgents={crmAgents}
          pulseAgents={pulseAgents}
          onOpenEntity={onOpenEntity}
        />
        <PriceDistributionChart pulseListings={filteredListings} />
      </div>

      {/* Section 4: Suburb heatmap */}
      <SuburbHeatmapTable pulseListings={filteredListings} />
    </div>
  );
}
