/**
 * HierarchyDiagram — Wave 11.6.23.
 *
 * Static top-down tree of the engine's data layers, rendered with plain
 * SVG inside a tailwind container. Each node shows the layer name, an
 * icon, and the live count from the architecture-KPIs RPC. Click a node
 * to open a Sheet with details.
 *
 * Why SVG-not-reactflow: the tree is static (six fixed layers, three
 * branches), the spec said either react-flow OR mermaid was acceptable,
 * and skipping that dependency saves ~50KB gzipped on the umbrella
 * chunk. We keep the chunk small by also dynamic-importing html2canvas
 * for the export-PNG button, so the initial settings load doesn't pay
 * for either dependency.
 *
 * Pure helpers exported for unit tests:
 *   - buildNodes(data) → array of { id, label, count, x, y, icon, ... }
 *   - buildEdges(nodes) → array of { from, to, label }
 *   - countToText(n) → grouped-thousands text e.g. 1247 → "1,247 rows"
 */
import React, { useRef, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Briefcase,
  Box,
  Workflow,
  ListChecks,
  Image as ImageIcon,
  Database,
  Camera,
  Download,
} from "lucide-react";

// Pure helpers ───────────────────────────────────────────────────────────

export function countToText(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) {
    return "0 rows";
  }
  return `${new Intl.NumberFormat("en-US").format(Math.trunc(Number(n)))} rows`;
}

/**
 * Build the layout. The diagram is six rows arranged vertically.
 * Coordinates are in an 800×460 viewbox.
 */
export function buildNodes(data = {}) {
  const safe = data || {};
  return [
    {
      id: "project",
      label: "Project",
      count: safe.project_count ?? 0,
      sublabel: "projects",
      x: 400,
      y: 30,
      iconKey: "briefcase",
      colour: "fill-slate-100 dark:fill-slate-800 stroke-slate-400",
    },
    {
      id: "products",
      label: "Products",
      count: safe.products_count ?? 0,
      sublabel: "active product catalog",
      x: 400,
      y: 100,
      iconKey: "box",
      colour: "fill-blue-50 dark:fill-blue-900/40 stroke-blue-400",
    },
    {
      id: "engine_roles",
      label: "Engine roles",
      count: Object.keys(safe.engine_role_distribution || {}).length,
      sublabel: "distinct values",
      x: 400,
      y: 170,
      iconKey: "workflow",
      colour: "fill-indigo-50 dark:fill-indigo-900/40 stroke-indigo-400",
    },
    {
      id: "slots",
      label: "Slots",
      count: safe.slot_count_active ?? 0,
      sublabel: "active",
      x: 400,
      y: 240,
      iconKey: "listchecks",
      colour: "fill-purple-50 dark:fill-purple-900/40 stroke-purple-400",
    },
    {
      id: "compositions",
      label: "Compositions",
      count: safe.composition_count ?? 0,
      sublabel: "classifications",
      x: 220,
      y: 330,
      iconKey: "image",
      colour: "fill-emerald-50 dark:fill-emerald-900/40 stroke-emerald-400",
    },
    {
      id: "rounds",
      label: "Rounds",
      count: safe.round_count_30d ?? 0,
      sublabel: `last ${safe.window_days ?? 30} days`,
      x: 580,
      y: 330,
      iconKey: "camera",
      colour: "fill-amber-50 dark:fill-amber-900/40 stroke-amber-400",
    },
    {
      id: "object_registry",
      label: "Object Registry",
      count: safe.object_registry_size ?? 0,
      sublabel: "canonical objects",
      x: 220,
      y: 420,
      iconKey: "database",
      colour: "fill-rose-50 dark:fill-rose-900/40 stroke-rose-400",
    },
  ];
}

export function buildEdges() {
  // Static — the topology is fixed. Returning labelled directed edges.
  return [
    { from: "project", to: "products", label: "contains" },
    { from: "products", to: "engine_roles", label: "resolves to" },
    { from: "engine_roles", to: "slots", label: "filters into" },
    { from: "slots", to: "compositions", label: "selects" },
    { from: "slots", to: "rounds", label: "evaluated per" },
    { from: "compositions", to: "object_registry", label: "rolls up to" },
  ];
}

const ICON_FOR = {
  briefcase: Briefcase,
  box: Box,
  workflow: Workflow,
  listchecks: ListChecks,
  image: ImageIcon,
  camera: Camera,
  database: Database,
};

const NODE_DETAIL = {
  project: {
    title: "Projects",
    body: "The top of the hierarchy. Each project rolls up its packages and products into the engine_roles its rounds use.",
  },
  products: {
    title: "Products",
    body: "Catalog rows. Each product is annotated with an engine_role (photo_day_shortlist, video_day_shortlist, drone_shortlist, …).",
  },
  engine_roles: {
    title: "Engine roles",
    body: "Distinct engine_role values currently set on active products. Slots filter their eligibility by overlap with this set.",
  },
  slots: {
    title: "Slots",
    body: "Active rows in shortlisting_slot_definitions. Each slot is filtered into rounds based on engine_roles, eligible_room_types, eligible_space_types, eligible_zone_focuses (W11.6.13). selection_mode (W11.6.22) controls whether AI decides or curated positions are used.",
  },
  compositions: {
    title: "Compositions",
    body: "Rows in composition_classifications. Each row corresponds to one image classified by the engine — room_type, space_type, zone_focus, image_type, signal_scores (26 keys), observed_objects[].",
  },
  rounds: {
    title: "Rounds",
    body: "shortlisting_rounds in the rolling 30-day window. Each round runs the slot-fill algorithm and emits slot_assigned events used by the coverage matrix below.",
  },
  object_registry: {
    title: "Object Registry",
    body: "Canonical objects (191 entries today). Each composition's observed_objects[] reference these canonical_ids. 5-level hierarchy + market_frequency + signal_room_type + aliases + attribute_values.",
  },
};

export default function HierarchyDiagram({ data, loading }) {
  const svgRef = useRef(null);
  const [openNode, setOpenNode] = useState(null);
  const [exporting, setExporting] = useState(false);

  const nodes = buildNodes(data || {});
  const edges = buildEdges();
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const handleExport = useCallback(async () => {
    if (!svgRef.current) return;
    setExporting(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(svgRef.current, {
        backgroundColor: "#ffffff",
        scale: 2,
      });
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `architecture-diagram-${new Date()
        .toISOString()
        .slice(0, 10)}.png`;
      a.click();
    } catch (e) {
      // Fail silently — the import is optional surface area.
      console.warn("html2canvas export failed", e);
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <Card data-testid="hierarchy-diagram">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Hierarchy diagram</h3>
            <p className="text-xs text-muted-foreground">
              Click a node for details. {loading ? "Loading…" : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting}
            data-testid="hierarchy-export-png"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {exporting ? "Exporting…" : "Export PNG"}
          </Button>
        </div>

        <div
          ref={svgRef}
          className="relative w-full bg-white dark:bg-slate-950 rounded border border-border"
          style={{ minHeight: 360 }}
          data-testid="hierarchy-svg-wrapper"
        >
          <svg
            viewBox="0 0 800 470"
            preserveAspectRatio="xMidYMid meet"
            className="w-full h-auto"
            data-testid="hierarchy-svg"
            role="img"
            aria-label="Engine data hierarchy"
          >
            <defs>
              <marker
                id="arrowhead"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            </defs>

            {/* edges */}
            <g className="text-slate-400 dark:text-slate-500" stroke="currentColor" strokeWidth="1.5">
              {edges.map((e) => {
                const a = nodeById[e.from];
                const b = nodeById[e.to];
                if (!a || !b) return null;
                // Vertical or angled edge — straight line, drop short of node.
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const length = Math.sqrt(dx * dx + dy * dy);
                const padTop = 28;
                const padBottom = 28;
                const x1 = a.x + (dx * padTop) / length;
                const y1 = a.y + (dy * padTop) / length;
                const x2 = b.x - (dx * padBottom) / length;
                const y2 = b.y - (dy * padBottom) / length;
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;
                return (
                  <g key={`${e.from}-${e.to}`} data-testid={`edge-${e.from}-${e.to}`}>
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      markerEnd="url(#arrowhead)"
                    />
                    <text
                      x={midX + 6}
                      y={midY}
                      className="fill-slate-500 dark:fill-slate-400 text-[10px] select-none"
                      stroke="none"
                    >
                      {e.label}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* nodes */}
            {nodes.map((n) => (
              <g
                key={n.id}
                onClick={() => setOpenNode(n.id)}
                style={{ cursor: "pointer" }}
                className="hover:opacity-80 transition-opacity"
                data-testid={`node-${n.id}`}
              >
                <rect
                  x={n.x - 90}
                  y={n.y - 24}
                  width={180}
                  height={50}
                  rx={6}
                  ry={6}
                  className={n.colour}
                  strokeWidth="1.5"
                />
                <text
                  x={n.x}
                  y={n.y - 6}
                  textAnchor="middle"
                  className="fill-foreground text-[12px] font-semibold select-none"
                  stroke="none"
                >
                  {n.label}
                </text>
                <text
                  x={n.x}
                  y={n.y + 12}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px] select-none"
                  stroke="none"
                  data-testid={`node-${n.id}-count`}
                >
                  {countToText(n.count)} · {n.sublabel}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </CardContent>

      <Sheet open={!!openNode} onOpenChange={(open) => !open && setOpenNode(null)}>
        <SheetContent
          side="right"
          className="w-[420px]"
          data-testid="hierarchy-node-drawer"
        >
          {openNode && (
            <SheetHeader>
              <SheetTitle>{NODE_DETAIL[openNode]?.title || openNode}</SheetTitle>
              <SheetDescription>
                {NODE_DETAIL[openNode]?.body}
              </SheetDescription>
            </SheetHeader>
          )}
          {openNode && (
            <div className="mt-4 text-xs space-y-2">
              <div className="rounded border border-border p-2">
                <div className="text-muted-foreground">Live count</div>
                <div
                  className="font-mono text-lg"
                  data-testid={`drawer-count-${openNode}`}
                >
                  {countToText(nodeById[openNode]?.count ?? 0)}
                </div>
              </div>
              {openNode === "engine_roles" && data?.engine_role_distribution && (
                <div className="rounded border border-border p-2">
                  <div className="text-muted-foreground mb-1">Distribution</div>
                  <ul className="space-y-0.5">
                    {Object.entries(data.engine_role_distribution).map(
                      ([role, n]) => (
                        <li
                          key={role}
                          className="flex items-center justify-between font-mono"
                        >
                          <span>{role}</span>
                          <span className="font-semibold">{n}</span>
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}
              {openNode === "slots" && data?.slot_count_by_phase && (
                <div className="rounded border border-border p-2">
                  <div className="text-muted-foreground mb-1">By phase</div>
                  <ul className="space-y-0.5">
                    {Object.entries(data.slot_count_by_phase).map(([p, n]) => (
                      <li
                        key={p}
                        className="flex items-center justify-between font-mono"
                      >
                        <span>phase {p}</span>
                        <span className="font-semibold">{n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {openNode === "compositions" &&
                Array.isArray(data?.room_type_distribution) && (
                  <div className="rounded border border-border p-2">
                    <div className="text-muted-foreground mb-1">
                      Top room types
                    </div>
                    <ul className="space-y-0.5">
                      {data.room_type_distribution.slice(0, 8).map((r) => (
                        <li
                          key={r.room_type}
                          className="flex items-center justify-between font-mono"
                        >
                          <span>{r.room_type}</span>
                          <span className="font-semibold">{r.n}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

// Re-export for tests.
export { ICON_FOR, NODE_DETAIL };
