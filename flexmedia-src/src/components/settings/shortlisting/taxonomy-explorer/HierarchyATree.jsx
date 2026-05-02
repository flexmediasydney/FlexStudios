/**
 * HierarchyATree — collapsible 5-level tree for object_registry.
 *
 * Receives the flat node array from taxonomy_a_tree() and groups it into a
 * nested structure keyed by:
 *   level_0_class → level_1_functional → level_2_material →
 *   level_3_specific → level_4_detail
 *
 * Each branch shows:
 *   - distinct child count (how many canonical_ids fall under it)
 *   - sum of market_frequency (total observations)
 *
 * Sort modes:
 *   - alpha: alphabetical per level
 *   - frequency: hot-to-cold by sum of market_frequency
 */

import React, { useMemo, useState, useEffect } from "react";
import { ChevronRight, ChevronDown, Dot } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const LEVELS = [
  "level_0_class",
  "level_1_functional",
  "level_2_material",
  "level_3_specific",
  "level_4_detail",
];

export default function HierarchyATree({
  nodes,
  selected,
  onSelect,
  sortMode = "alpha",
  expandAll = false,
}) {
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  return (
    <div className="text-xs" data-testid="taxonomy-a-tree">
      {tree.length === 0 ? (
        <div className="text-muted-foreground p-3">
          object_registry is empty.
        </div>
      ) : (
        sortBranches(tree, sortMode).map((branch) => (
          <Branch
            key={`L0:${branch.key}`}
            branch={branch}
            depth={0}
            selected={selected}
            onSelect={onSelect}
            sortMode={sortMode}
            expandAll={expandAll}
          />
        ))
      )}
    </div>
  );
}

// ─── Tree builder ─────────────────────────────────────────────────────────────

function buildTree(nodes) {
  // Each level returns an array of { key, label, freq, count, leaf?, children }.
  const root = new Map();

  for (const n of nodes) {
    let cursor = root;
    let path = [];
    for (let li = 0; li < LEVELS.length; li++) {
      const lvl = LEVELS[li];
      const v = n[lvl];
      if (!v) break;
      path.push(v);
      const k = v;
      if (!cursor.has(k)) {
        cursor.set(k, {
          key: k,
          label: v,
          path: [...path],
          children: new Map(),
          leaves: [],
          freq: 0,
        });
      }
      const branch = cursor.get(k);
      branch.freq += Number(n.market_frequency || 0);

      const isLast = li === LEVELS.length - 1 || !n[LEVELS[li + 1]];
      if (isLast) {
        branch.leaves.push(n);
      }
      cursor = branch.children;
    }
  }

  return mapToArray(root);
}

function mapToArray(map) {
  return Array.from(map.values()).map((b) => ({
    ...b,
    children: mapToArray(b.children),
  }));
}

function sortBranches(list, mode) {
  const out = [...list];
  if (mode === "frequency") {
    out.sort((a, b) => b.freq - a.freq || a.label.localeCompare(b.label));
  } else {
    out.sort((a, b) => a.label.localeCompare(b.label));
  }
  return out;
}

// ─── Branch row ───────────────────────────────────────────────────────────────

function Branch({ branch, depth, selected, onSelect, sortMode, expandAll }) {
  const hasChildren = branch.children.length > 0 || branch.leaves.length > 0;
  const [open, setOpen] = useState(depth < 1 || expandAll);

  // Re-open everything if a search filter is active (expandAll true → expand)
  useEffect(() => {
    if (expandAll) setOpen(true);
  }, [expandAll]);

  // Distinct canonical-id count under this branch
  const descendantCount = countLeaves(branch);
  const directChildren = sortBranches(branch.children, sortMode);

  return (
    <div className="leading-tight">
      <div
        className="flex items-center gap-1 py-0.5 hover:bg-accent/40 rounded cursor-pointer"
        style={{ paddingLeft: `${depth * 12}px` }}
        onClick={() => setOpen((o) => !o)}
        data-testid={`taxonomy-a-branch-${branch.path.join("-")}`}
      >
        <span className="w-3 h-3 inline-flex items-center justify-center">
          {hasChildren ? (
            open ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )
          ) : (
            <Dot className="h-3 w-3 text-muted-foreground" />
          )}
        </span>
        <span className="font-mono text-xs flex-1 truncate">
          {branch.label}
        </span>
        <Badge variant="outline" className="h-4 px-1 text-[10px]">
          {descendantCount}
        </Badge>
        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
          {branch.freq}
        </Badge>
      </div>

      {open && (
        <>
          {directChildren.map((c) => (
            <Branch
              key={`${depth}:${branch.key}:${c.key}`}
              branch={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              sortMode={sortMode}
              expandAll={expandAll}
            />
          ))}
          {branch.leaves.map((leaf) => (
            <LeafRow
              key={`leaf:${leaf.canonical_id}`}
              leaf={leaf}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ─── Leaf row (canonical_id) ──────────────────────────────────────────────────

function LeafRow({ leaf, depth, selected, onSelect }) {
  const isSelected = selected === leaf.canonical_id;
  return (
    <div
      className={`flex items-center gap-1 py-0.5 rounded cursor-pointer ${
        isSelected
          ? "bg-emerald-50 dark:bg-emerald-950/30 ring-1 ring-emerald-200"
          : "hover:bg-accent/40"
      }`}
      style={{ paddingLeft: `${depth * 12 + 16}px` }}
      onClick={() => onSelect(leaf.canonical_id)}
      data-testid={`taxonomy-a-leaf-${leaf.canonical_id}`}
    >
      <span className="font-mono text-[11px] flex-1 truncate">
        {leaf.canonical_id}
      </span>
      <Badge variant="secondary" className="h-4 px-1 text-[10px]">
        {leaf.market_frequency || 0}
      </Badge>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countLeaves(branch) {
  let n = branch.leaves.length;
  for (const c of branch.children) n += countLeaves(c);
  return n;
}
