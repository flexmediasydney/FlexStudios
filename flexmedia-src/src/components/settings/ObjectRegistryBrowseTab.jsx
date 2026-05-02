/**
 * ObjectRegistryBrowseTab — W12.B browse view of the canonical object_registry.
 *
 * Lists rows from `object_registry` with the 5-level hierarchy, market_frequency,
 * room-type signal, and aliases. Operators can filter by level_0_class, search
 * by display_name/canonical_id, sort by market_frequency DESC, and click a row
 * to expand inline showing recent raw_attribute_observations linked to that
 * canonical (via normalised_to_object_id).
 *
 * Read-only — mutations live in the discovery-queue tab.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Database,
  AlertCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const PAGE_LIMIT = 100;

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function HierarchyChain({ row }) {
  const levels = [
    row.level_0_class,
    row.level_1_functional,
    row.level_2_material,
    row.level_3_specific,
    row.level_4_detail,
  ].filter(Boolean);
  if (levels.length === 0) {
    return <span className="text-muted-foreground italic text-[11px]">—</span>;
  }
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {levels.map((l, i) => (
        <span key={`${l}_${i}`} className="text-[11px] font-mono">
          {l}
          {i < levels.length - 1 && (
            <span className="text-muted-foreground mx-0.5">/</span>
          )}
        </span>
      ))}
    </div>
  );
}

function ObservationRow({ obs }) {
  return (
    <div className="px-3 py-1.5 border-l-2 border-slate-200 dark:border-slate-700 text-[11px] flex items-baseline gap-2">
      <span className="font-mono text-foreground/80 truncate flex-1">
        {obs.raw_label}
      </span>
      <Badge className="text-[9px] h-4 px-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
        {obs.source_type}
      </Badge>
      {typeof obs.similarity_score === "number" && (
        <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
          {Number(obs.similarity_score).toFixed(3)}
        </span>
      )}
      <span className="text-muted-foreground tabular-nums">
        {fmtTime(obs.normalised_at || obs.created_at)}
      </span>
    </div>
  );
}

function ExpandedDetail({ canonicalRowId }) {
  const obsQuery = useQuery({
    queryKey: ["w12b_browse_observations", canonicalRowId],
    queryFn: async () => {
      // We use the api.entities pluraliser so the smoke test guards against
      // table-name drift. Pluraliser: RawAttributeObservation → raw_attribute_observations.
      const rows = await api.entities.RawAttributeObservation.filter(
        { normalised_to_object_id: canonicalRowId },
        "-created_at",
        20,
      );
      return rows;
    },
    enabled: !!canonicalRowId,
    staleTime: 30_000,
  });

  if (obsQuery.isLoading) {
    return (
      <div className="px-4 py-2">
        <Skeleton className="h-4 w-full mb-1" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (obsQuery.isError) {
    return (
      <div className="px-4 py-2 text-[11px] text-red-600 dark:text-red-400 flex items-center gap-1">
        <AlertCircle className="h-3 w-3" />
        Failed to load observations: {String(obsQuery.error?.message || "")}
      </div>
    );
  }
  const rows = obsQuery.data || [];
  if (rows.length === 0) {
    return (
      <div className="px-4 py-2 text-[11px] text-muted-foreground italic">
        No raw_attribute_observations linked to this canonical yet.
      </div>
    );
  }
  return (
    <div className="px-4 py-2 space-y-1 bg-slate-50/50 dark:bg-slate-900/30">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        Recent raw_attribute_observations ({rows.length})
      </div>
      {rows.map((obs) => (
        <ObservationRow key={obs.id} obs={obs} />
      ))}
    </div>
  );
}

export default function ObjectRegistryBrowseTab() {
  const [filters, setFilters] = useState({
    level_0_class: "",
    search: "",
    sort: "market_frequency_desc",
  });
  const [expandedRowId, setExpandedRowId] = useState(null);

  const browseQuery = useQuery({
    queryKey: ["w12b_browse", filters.level_0_class, filters.sort],
    queryFn: async () => {
      const filterObj = { status: "canonical", is_active: true };
      if (filters.level_0_class) filterObj.level_0_class = filters.level_0_class;
      const sortBy =
        filters.sort === "market_frequency_desc" ? "-market_frequency"
        : filters.sort === "display_name_asc" ? "display_name"
        : filters.sort === "first_observed_desc" ? "-first_observed_at"
        : "-market_frequency";
      const rows = await api.entities.ObjectRegistry.filter(
        filterObj,
        sortBy,
        PAGE_LIMIT,
      );
      return rows;
    },
    staleTime: 60_000,
  });

  const allRows = browseQuery.data || [];
  // Client-side text search across canonical_id / display_name / aliases.
  const filteredRows = useMemo(() => {
    const q = (filters.search || "").trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => {
      if (r.canonical_id?.toLowerCase().includes(q)) return true;
      if (r.display_name?.toLowerCase().includes(q)) return true;
      if (Array.isArray(r.aliases)) {
        return r.aliases.some((a) => a?.toLowerCase().includes(q));
      }
      return false;
    });
  }, [allRows, filters.search]);

  // Available level_0_class values for the filter dropdown.
  const level0Values = useMemo(() => {
    const set = new Set();
    for (const r of allRows) {
      if (r.level_0_class) set.add(r.level_0_class);
    }
    return Array.from(set).sort();
  }, [allRows]);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-blue-600" />
            Browse canonicals
          </CardTitle>
          <CardDescription className="text-[11px]">
            Active rows from <code className="text-[10px]">object_registry</code>.
            Click a row to see recent raw observations.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <Label htmlFor="level_0_filter" className="text-[10px] uppercase tracking-wide text-muted-foreground">
                level_0_class
              </Label>
              <Select
                value={filters.level_0_class || "all"}
                onValueChange={(v) => setFilters((f) => ({ ...f, level_0_class: v === "all" ? "" : v }))}
              >
                <SelectTrigger id="level_0_filter" className="h-8 text-xs mt-1">
                  <SelectValue placeholder="All classes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All classes</SelectItem>
                  {level0Values.map((v) => (
                    <SelectItem key={v} value={v} className="text-xs font-mono">
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="sort_by" className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Sort
              </Label>
              <Select
                value={filters.sort}
                onValueChange={(v) => setFilters((f) => ({ ...f, sort: v }))}
              >
                <SelectTrigger id="sort_by" className="h-8 text-xs mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="market_frequency_desc" className="text-xs">market_frequency DESC</SelectItem>
                  <SelectItem value="display_name_asc" className="text-xs">display_name A-Z</SelectItem>
                  <SelectItem value="first_observed_desc" className="text-xs">most recent first</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="browse_search" className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Search
              </Label>
              <div className="relative mt-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id="browse_search"
                  placeholder="display_name / canonical_id / alias…"
                  value={filters.search}
                  onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                  className="h-8 text-xs pl-7"
                  data-testid="browse-search-input"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {browseQuery.isLoading && !browseQuery.data ? (
        <Skeleton className="h-32 w-full" />
      ) : browseQuery.isError ? (
        <Card className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20">
          <CardContent className="p-3 text-xs text-red-700 dark:text-red-400">
            Failed to load: {String(browseQuery.error?.message || browseQuery.error)}
          </CardContent>
        </Card>
      ) : filteredRows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <Database className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium text-foreground">No canonicals match the current filters</p>
            <p className="mt-1 text-xs">
              Try clearing the search or switching level_0_class to "All classes".
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table data-testid="browse-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6"></TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">canonical_id</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">display_name</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">hierarchy</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide tabular-nums text-right">freq</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">signal_room_type</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">aliases</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const isExpanded = expandedRowId === row.id;
                  return (
                    <>
                      <TableRow
                        key={row.id}
                        data-testid="browse-row"
                        data-row-id={row.id}
                        className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                        onClick={() => setExpandedRowId(isExpanded ? null : row.id)}
                      >
                        <TableCell className="py-2">
                          <Button variant="ghost" size="sm" className="h-5 w-5 p-0">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell className="font-mono text-[11px] py-2">
                          {row.canonical_id}
                        </TableCell>
                        <TableCell className="text-xs py-2">{row.display_name}</TableCell>
                        <TableCell className="py-2">
                          <HierarchyChain row={row} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs py-2">
                          {row.market_frequency || 0}
                        </TableCell>
                        <TableCell className="text-[11px] py-2">
                          {row.signal_room_type ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono">{row.signal_room_type}</span>
                              {typeof row.signal_confidence === "number" && (
                                <span className="text-muted-foreground tabular-nums">
                                  {Number(row.signal_confidence).toFixed(2)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground italic">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-[11px] py-2 max-w-[200px]">
                          {Array.isArray(row.aliases) && row.aliases.length > 0 ? (
                            <div className="flex flex-wrap gap-0.5">
                              {row.aliases.slice(0, 3).map((a, i) => (
                                <Badge key={`${row.id}_a_${i}`} className="text-[9px] h-4 px-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 truncate max-w-[100px]">
                                  {a}
                                </Badge>
                              ))}
                              {row.aliases.length > 3 && (
                                <Badge className="text-[9px] h-4 px-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                                  +{row.aliases.length - 3}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground italic">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow data-testid="browse-row-expanded">
                          <TableCell colSpan={7} className="p-0">
                            <ExpandedDetail canonicalRowId={row.id} />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {filteredRows.length > 0 && (
        <div className="text-[11px] text-muted-foreground tabular-nums px-1">
          {filteredRows.length} of {allRows.length} loaded · capped at {PAGE_LIMIT}
        </div>
      )}
    </div>
  );
}
