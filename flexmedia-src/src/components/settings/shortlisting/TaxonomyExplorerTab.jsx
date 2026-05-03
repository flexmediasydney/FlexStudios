/**
 * TaxonomyExplorerTab — Wave 11.6.26 (mig 439).
 *
 * New subtab inside the Shortlisting Command Center. Joseph asked for an
 * interactive visual surface that exposes both vocabularies the engine
 * relies on:
 *
 *   Hierarchy A — object_registry's 5-level hierarchy
 *     level_0_class → level_1_functional → level_2_material →
 *     level_3_specific → level_4_detail   (191 active rows)
 *
 *   Hierarchy B — composition_classifications orthogonal axes (mig 451)
 *     image_type · space_type · shot_scale · zone_focus · vantage_position
 *     · composition_geometry · perspective_compression · orientation
 *     (legacy: room_type, composition_type)
 *
 * Power-user diagnostic — dense, info-rich, scannable. Operators use this
 * to spot vocabulary issues fast (rare classes, dead values, slot-eligibility
 * gaps).
 *
 * Data: backed by 4 SECURITY DEFINER RPCs (mig 439). All long aggregations
 * happen server-side; react-query caches results for 60s minimum.
 *
 * IA: T2 wires this in via React.lazy from
 * SettingsShortlistingCommandCenter.jsx — this file is the default export
 * and stands alone.
 *
 * Co-located helpers (all 4 must exist or the build breaks):
 *   ./taxonomy-explorer/HierarchyATree.jsx    — collapsible 5-level tree
 *   ./taxonomy-explorer/HierarchyADetail.jsx  — A node detail panel
 *   ./taxonomy-explorer/HierarchyBAxes.jsx    — B axis distribution cards
 *   ./taxonomy-explorer/HierarchyBDetail.jsx  — B value detail panel
 */

import React, { useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Search,
  AlertCircle,
  TreePine,
  Layers3,
  ArrowDownAZ,
  Flame,
  RefreshCw,
} from "lucide-react";
import HierarchyATree from "./taxonomy-explorer/HierarchyATree.jsx";
import HierarchyADetail from "./taxonomy-explorer/HierarchyADetail.jsx";
import HierarchyBAxes from "./taxonomy-explorer/HierarchyBAxes.jsx";
import HierarchyBDetail from "./taxonomy-explorer/HierarchyBDetail.jsx";

const STALE_MS = 60_000; // brief cache as required

// Hierarchy B axes — keep as plain text constants (no closed enum;
// codebase discipline post v2.4 schema drop).
//
// Mig 441 (W11.6.27): demoted `room_type` into a collapsible Legacy section.
// `room_type` is the pre-W11.6.13 single-axis classification. New rows still
// emit it for backwards compat with `slot_definitions.eligible_room_types[]`,
// but the engine has moved to `space_type` + `zone_focus` as the primary
// orthogonal axes for new diagnostics.
//
// Mig 442 (C1) shipped 3 new orthogonal axes on composition_classifications:
// `shot_scale`, `perspective_compression`, `orientation`. Mig 448 extends the
// taxonomy_b_* RPC allow-lists to cover them. They have no slot-eligibility
// column on shortlisting_slot_definitions yet — the RPC returns an empty
// eligible_slots[] for those axes, by design.
//
// Mig 451 (S1 / W11.6.29 — 2026-05-02): decomposed `composition_type` into
// two orthogonal axes — `vantage_position` (where the camera is) and
// `composition_geometry` (the geometric pattern of the frame). The legacy
// `composition_type` axis is kept on composition_classifications for
// diagnostic visibility, but moves into the Legacy section here. Mig 452
// extends the taxonomy_b_* RPC allow-lists to cover the two new axes.
const B_AXES_PRIMARY = [
  { key: "image_type",              label: "Image type",
    description: "Day / night / drone / floorplan — top-level visual mode." },
  { key: "space_type",              label: "Space type",
    description: "What kind of space the frame depicts (kitchen, master_bedroom…)." },
  { key: "shot_scale",              label: "Shot scale",
    description: "How much of the scene is framed (wide -> vignette)." },
  { key: "zone_focus",              label: "Zone focus",
    description: "Which zone within the space is the focal subject." },
  { key: "vantage_position",        label: "Vantage position",
    description: "Where the camera is positioned: eye-level / corner / through-doorway / aerial / …" },
  { key: "composition_geometry",    label: "Composition geometry",
    description: "Geometric pattern of the frame: 1-point perspective / leading lines / symmetrical / …" },
  { key: "perspective_compression", label: "Perspective",
    description: "Depth rendering: expanded vs compressed (focal-feel, not lens FOV)." },
  { key: "orientation",             label: "Orientation",
    description: "Landscape / portrait / square (derived from EXIF)." },
];

const B_AXES_LEGACY = [
  { key: "room_type",        label: "Room type" },
  { key: "composition_type", label: "Composition type" },
];

export default function TaxonomyExplorerTab() {
  const [mode, setMode] = useState("a"); // 'a' | 'b'

  // Hierarchy A state
  const [aSelected, setASelected] = useState(null); // canonical_id | null
  const [aQuery, setAQuery] = useState("");
  const [aSortMode, setASortMode] = useState("alpha"); // 'alpha' | 'frequency'

  // Hierarchy B state
  const [bSelected, setBSelected] = useState(null); // { axis, value } | null

  const treeQuery = useQuery({
    queryKey: ["taxonomy-a-tree"],
    queryFn: async () => {
      const data = await api.rpc("taxonomy_a_tree");
      return data ?? { nodes: [], total_rows: 0 };
    },
    staleTime: STALE_MS,
    enabled: mode === "a",
  });

  const nodeDetailQuery = useQuery({
    queryKey: ["taxonomy-a-node-detail", aSelected],
    queryFn: async () => {
      const data = await api.rpc("taxonomy_a_node_detail", {
        p_canonical_id: aSelected,
      });
      return data ?? null;
    },
    staleTime: STALE_MS,
    enabled: mode === "a" && Boolean(aSelected),
  });

  const valueDetailQuery = useQuery({
    queryKey: [
      "taxonomy-b-value-detail",
      bSelected?.axis,
      bSelected?.value,
    ],
    queryFn: async () => {
      const data = await api.rpc("taxonomy_b_value_detail", {
        p_axis: bSelected.axis,
        p_value: bSelected.value,
      });
      return data ?? null;
    },
    staleTime: STALE_MS,
    enabled: mode === "b" && Boolean(bSelected),
  });

  const onModeChange = (next) => {
    setMode(next);
    setASelected(null);
    setBSelected(null);
  };

  return (
    <div className="space-y-3" data-testid="taxonomy-explorer-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <TreePine className="h-4 w-4 text-emerald-600" />
            Taxonomy Explorer
          </h2>
          <p className="text-xs text-muted-foreground max-w-2xl">
            Interactive surface over the two vocabularies the shortlisting
            engine relies on. Hierarchy A is the 5-level{" "}
            <code>object_registry</code> tree (191 active canonical objects).
            Hierarchy B is the 8 orthogonal classification axes on{" "}
            <code>composition_classifications</code> (image_type, space_type,
            shot_scale, zone_focus, vantage_position, composition_geometry,
            perspective_compression, orientation). Click any node or value
            to see counts, slot eligibility, and recent observations.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            treeQuery.refetch();
            if (aSelected) nodeDetailQuery.refetch();
            if (bSelected) valueDetailQuery.refetch();
          }}
          disabled={treeQuery.isFetching}
          data-testid="taxonomy-refresh"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1.5 ${
              treeQuery.isFetching ? "animate-spin" : ""
            }`}
          />
          Refresh
        </Button>
      </div>

      <Tabs value={mode} onValueChange={onModeChange}>
        <TabsList>
          <TabsTrigger value="a" data-testid="taxonomy-mode-a">
            <Layers3 className="h-3.5 w-3.5 mr-1.5" />
            Hierarchy A — Objects (object_registry)
          </TabsTrigger>
          <TabsTrigger value="b" data-testid="taxonomy-mode-b">
            <Layers3 className="h-3.5 w-3.5 mr-1.5" />
            Hierarchy B — Image classifications
          </TabsTrigger>
        </TabsList>

        <TabsContent value="a" className="mt-3">
          <HierarchyAView
            treeQuery={treeQuery}
            aSelected={aSelected}
            setASelected={setASelected}
            aQuery={aQuery}
            setAQuery={setAQuery}
            aSortMode={aSortMode}
            setASortMode={setASortMode}
            nodeDetailQuery={nodeDetailQuery}
          />
        </TabsContent>

        <TabsContent value="b" className="mt-3">
          <HierarchyBView
            bSelected={bSelected}
            setBSelected={setBSelected}
            valueDetailQuery={valueDetailQuery}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Hierarchy A view ─────────────────────────────────────────────────────────

function HierarchyAView({
  treeQuery,
  aSelected,
  setASelected,
  aQuery,
  setAQuery,
  aSortMode,
  setASortMode,
  nodeDetailQuery,
}) {
  const filteredNodes = useMemo(() => {
    const all = treeQuery.data?.nodes || [];
    if (!aQuery.trim()) return all;
    const q = aQuery.trim().toLowerCase();
    return all.filter((n) => {
      const fields = [
        n.canonical_id,
        n.display_name,
        n.level_0_class,
        n.level_1_functional,
        n.level_2_material,
        n.level_3_specific,
        n.level_4_detail,
        ...(n.aliases || []),
      ];
      return fields.some((f) => f && String(f).toLowerCase().includes(q));
    });
  }, [treeQuery.data, aQuery]);

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* Left column — tree */}
      <div className="col-span-12 lg:col-span-7">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Object hierarchy</span>
              <span className="text-xs font-normal text-muted-foreground">
                {treeQuery.data?.total_rows ?? "—"} canonical objects
              </span>
            </CardTitle>
            <CardDescription className="text-xs">
              Collapsible tree. Each node shows child count + total
              market_frequency below. Click any leaf to inspect.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
                <Input
                  className="pl-7 h-8 text-xs"
                  placeholder="Filter by name / canonical_id / alias…"
                  value={aQuery}
                  onChange={(e) => setAQuery(e.target.value)}
                  data-testid="taxonomy-a-search"
                />
              </div>
              <Button
                variant={aSortMode === "frequency" ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() =>
                  setASortMode(
                    aSortMode === "frequency" ? "alpha" : "frequency",
                  )
                }
                data-testid="taxonomy-a-sort-toggle"
              >
                {aSortMode === "frequency" ? (
                  <Flame className="h-3.5 w-3.5 mr-1" />
                ) : (
                  <ArrowDownAZ className="h-3.5 w-3.5 mr-1" />
                )}
                {aSortMode === "frequency" ? "Hot to cold" : "A → Z"}
              </Button>
            </div>

            {treeQuery.isLoading && (
              <Skeleton className="h-64 w-full" data-testid="taxonomy-a-skeleton" />
            )}
            {treeQuery.error && (
              <ErrorRow message={treeQuery.error?.message || "RPC failed"} />
            )}

            {!treeQuery.isLoading && !treeQuery.error && (
              <ScrollArea className="h-[460px] pr-2">
                <HierarchyATree
                  nodes={filteredNodes}
                  selected={aSelected}
                  onSelect={setASelected}
                  sortMode={aSortMode}
                  expandAll={Boolean(aQuery.trim())}
                />
                {filteredNodes.length === 0 && (
                  <div className="text-xs text-muted-foreground p-3">
                    No matches.
                  </div>
                )}
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Right column — node detail */}
      <div className="col-span-12 lg:col-span-5">
        <HierarchyADetail selected={aSelected} query={nodeDetailQuery} />
      </div>
    </div>
  );
}

// ─── Hierarchy B view ─────────────────────────────────────────────────────────

function HierarchyBView({ bSelected, setBSelected, valueDetailQuery }) {
  return (
    <div className="grid grid-cols-12 gap-3">
      <div className="col-span-12 lg:col-span-7">
        <HierarchyBAxes
          axes={B_AXES_PRIMARY}
          legacyAxes={B_AXES_LEGACY}
          selected={bSelected}
          onSelect={setBSelected}
        />
      </div>

      <div className="col-span-12 lg:col-span-5">
        <HierarchyBDetail selected={bSelected} query={valueDetailQuery} />
      </div>
    </div>
  );
}

// ─── Shared error row ─────────────────────────────────────────────────────────

function ErrorRow({ message }) {
  return (
    <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 p-2 border border-amber-200 rounded">
      <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <div>
        <p className="font-semibold">Fetch failed</p>
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
