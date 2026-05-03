/**
 * HelpDrawer — slide-out reference for the recipe model.
 *
 * Triggered by the `?` icon next to the help banner. Contains the longer
 * conceptual docs that don't fit in the inline tooltip system.
 *
 * Authored as plain readable copy; intentionally not split into
 * Markdown — operators read this once or twice and the static JSX
 * keeps everything in-bundle and themed.
 */
import React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function HelpDrawer({ open, onOpenChange }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col"
        data-testid="recipe-help-drawer"
      >
        <SheetHeader>
          <SheetTitle>Recipe model — deep reference</SheetTitle>
          <SheetDescription>
            Concepts, scope chain, and engine behaviour. Hover any
            highlighted term inside the matrix for the short version.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4 pr-4">
          <div className="space-y-5 text-sm leading-relaxed">
            <section>
              <h3 className="font-semibold mb-1.5">Scope: image shortlisting only</h3>
              <p className="text-muted-foreground">
                The Recipe Matrix authors per-position constraints for the{" "}
                <strong>image shortlisting</strong> engine only. The engine
                roles in scope are:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground mt-2">
                <li><code>photo_day_shortlist</code> — Sales / day images</li>
                <li><code>photo_dusk_shortlist</code> — Dusk images</li>
                <li><code>drone_shortlist</code> — Aerial / drone shots</li>
              </ul>
              <p className="text-muted-foreground mt-2">
                Products like video (<code>video_day_shortlist</code> /{" "}
                <code>video_dusk_shortlist</code>), floor plans (
                <code>floorplan_qa</code>), and agent portraits (
                <code>agent_portraits</code>) use separate engines and won't
                appear in the matrix tabs or count toward the cell target.
                Author those deliverables elsewhere.
              </p>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">What is a position?</h3>
              <p className="text-muted-foreground">
                A <em>position</em> is a single slot in a finished gallery —
                one row in <code>gallery_positions</code>. It carries a
                constraint tuple (room, shot scale, compression, …) plus a
                phase (mandatory / conditional / optional) and a selection
                mode (AI decides / curated). The engine fills positions in
                phase priority order until the package count is reached.
              </p>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">Recipes vs templates</h3>
              <p className="text-muted-foreground">
                A <strong>recipe</strong> is the set of positions for one
                (project type × package × price tier × product) cell. A{" "}
                <strong>template</strong> is a reusable constraint bundle —
                think "Kitchen hero, wide, compressed". Templates live in
                the Advanced expander; recipes live in the matrix.
              </p>
              <p className="text-muted-foreground mt-2">
                Inserting a template into a position copies the constraint
                tuple. After insertion the position is independent — editing
                the template later does <em>not</em> rewrite existing
                positions.
              </p>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">Scope chain & inheritance</h3>
              <p className="text-muted-foreground">
                Positions inherit through a 4-step chain (broadest → narrowest):
              </p>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground mt-2">
                <li><strong>Tier defaults</strong> — applies to every package at this price tier (<code>scope_type=price_tier</code>)</li>
                <li><strong>Project-type overlay</strong> — narrows to one project type (<code>scope_type=project_type</code>)</li>
                <li><strong>Cell</strong> — package × price tier (<code>scope_type=package_x_price_tier</code>)</li>
              </ol>
              <p className="text-muted-foreground mt-2">
                A row override at a narrower scope <em>replaces</em> the
                inherited row by <code>position_index</code>. Inheritance
                merges, never additive: the resolver builds the full list
                top-down.
              </p>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">Engine modes</h3>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                <li>
                  <strong>Recipe strict</strong> — engine fills only what the
                  recipe asks for. Empty positions stay empty.
                </li>
                <li>
                  <strong>Recipe + AI backfill</strong> — engine fills the
                  recipe; any unfilled positions are topped up with the
                  next-best uncommitted shot.
                </li>
                <li>
                  <strong>Full AI</strong> — engine ignores the recipe and
                  picks freely up to <code>package_count_target</code>.
                  Useful for AI-only packages.
                </li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">Engine grade vs price tier</h3>
              <p className="text-muted-foreground">
                <strong>Price tier</strong> (Standard / Premium) determines
                what the recipe targets and IS the matrix column axis.
                Each (package × price tier) cell is its own recipe.
              </p>
              <p className="text-muted-foreground mt-2">
                <strong>Engine grade</strong> (Volume / Refined / Editorial)
                is derived per-round from the property's shoot quality and
                steers the Stage 4 voice anchor only — it does <em>not</em>{" "}
                affect slot allocation. Recipes apply equally regardless of
                grade. Grade does NOT appear in the matrix.
              </p>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">Authored / target dual-number</h3>
              <p className="text-muted-foreground">
                Each cell shows{" "}
                <strong className="tabular-nums">X authored / Y target</strong>:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground mt-2">
                <li>
                  <strong>X (authored)</strong> = positions you've
                  explicitly defined in this cell's scope (rows in{" "}
                  <code>gallery_positions</code>).
                </li>
                <li>
                  <strong>Y (target)</strong> = images the package
                  contractually delivers for this price tier. Read from
                  <code> packages.standard_tier.image_count</code> /{" "}
                  <code>premium_tier.image_count</code> when present.
                </li>
                <li>
                  <strong>Sum-of-products fallback</strong>: if the tier
                  jsonb doesn't carry an <code>image_count</code>, the UI
                  sums the package's <code>products[].quantity</code>{" "}
                  entries — using each product's tier-specific{" "}
                  <code>image_count</code> when available. The cell tooltip
                  shows the breakdown:{" "}
                  <em>"Target: 5 (Sales) + 3 (Drone) + 1 (Floor Plans) = 9"</em>.
                </li>
                <li>
                  Cell colour: <span className="text-emerald-700">green</span>{" "}
                  when 0 &lt; X ≤ Y, <span className="text-amber-700">amber</span>{" "}
                  when X &gt; Y (over-target warning), slate when X = 0.
                </li>
                <li>
                  Over-target authoring drops lowest-priority positions
                  (optional first, then conditional) to fit the package
                  target.
                </li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">Tolerance band</h3>
              <p className="text-muted-foreground">
                Each cell carries a <code>±N</code> tolerance band on top of
                the package target. The engine treats anything in{" "}
                <code>[target − below, target + above]</code> as acceptable.
                Out-of-band counts surface as health warnings on the round
                dashboard.
              </p>
            </section>

            <section>
              <h3 className="font-semibold mb-1.5">When to use NULL constraints</h3>
              <p className="text-muted-foreground">
                Leave a constraint blank when you trust the engine to pick.
                Setting every axis turns a position into a near-deterministic
                target — useful for hero shots, brittle for the long tail.
                A good rule of thumb: set 2–3 axes for hero positions, 0–1
                for filler.
              </p>
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
