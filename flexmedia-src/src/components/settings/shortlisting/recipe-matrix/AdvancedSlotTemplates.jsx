/**
 * AdvancedSlotTemplates — collapsible "rarely-touched levers" expander.
 *
 * Lives at the bottom of the Recipes tab. Default: closed. Inside, a
 * read-only list of the active slot_definitions plus a button that
 * lazy-mounts the legacy SettingsShortlistingSlots editor in a Sheet
 * for occasional template authoring. We don't keep the slots tab in
 * the IA anymore (the brief consolidated to a single 'recipes' tab),
 * but the editor itself remains useful for the rare template tweak.
 *
 * Lazy-loading the editor keeps the umbrella code-split chunks small —
 * the heavy slots editor only enters the bundle if the operator actually
 * opens the expander and clicks Edit.
 */
import React, { useState, Suspense, lazy } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  ChevronDown,
  ChevronRight,
  ListChecks,
  Pencil,
} from "lucide-react";
import { IconTip } from "./Tip";

const SettingsShortlistingSlots = lazy(() =>
  import("@/pages/SettingsShortlistingSlots"),
);

export default function AdvancedSlotTemplates({ slots = [] }) {
  const [open, setOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-6">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-between w-full rounded-md border border-border bg-muted/30 px-4 py-3 text-left hover:bg-muted/60 transition-colors"
          data-testid="advanced-slot-templates-trigger"
        >
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <ListChecks className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold">
              Advanced — Slot Templates
            </span>
            <Badge variant="secondary" className="ml-2">
              {slots.length} active
            </Badge>
            <IconTip
              text="Slot templates are reusable constraint bundles. Use 'Insert from template' inside a position editor to populate the constraints from a template in one click. You rarely need to edit these directly."
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              Active slot templates
              <IconTip
                text="Templates are derived from shortlisting_slot_definitions. The constraints column shows the eligibility-array bundles that get pre-filled when you 'Insert from template' inside a position."
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {slots.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No active slot templates.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-12 gap-2 text-xs font-medium border-b pb-1.5">
                  <div className="col-span-3">Slot ID</div>
                  <div className="col-span-3">Display name</div>
                  <div className="col-span-1">Phase</div>
                  <div className="col-span-1">Min</div>
                  <div className="col-span-1">Max</div>
                  <div className="col-span-3">Eligible room types</div>
                </div>
                {slots.map((s) => (
                  <div
                    key={s.slot_id}
                    className="grid grid-cols-12 gap-2 text-xs items-center"
                    data-testid={`template-row-${s.slot_id}`}
                  >
                    <div className="col-span-3 font-mono text-[11px]">
                      {s.slot_id}
                    </div>
                    <div className="col-span-3">{s.display_name}</div>
                    <div className="col-span-1">P{s.phase}</div>
                    <div className="col-span-1">{s.min_images}</div>
                    <div className="col-span-1">{s.max_images}</div>
                    <div className="col-span-3 truncate text-muted-foreground">
                      {(s.eligible_room_types || []).slice(0, 4).join(", ")}
                      {(s.eligible_room_types || []).length > 4 && " …"}
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="flex gap-2 pt-3 border-t">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditorOpen(true)}
                data-testid="open-template-editor"
              >
                <Pencil className="h-3 w-3 mr-1.5" />
                Edit / add templates
              </Button>
              <span className="text-xs text-muted-foreground self-center">
                Templates rarely change. Most recipe authoring happens in
                the matrix above.
              </span>
            </div>
          </CardContent>
        </Card>
      </CollapsibleContent>

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-3xl overflow-y-auto"
          data-testid="slot-template-editor-sheet"
        >
          <SheetHeader>
            <SheetTitle>Slot template editor</SheetTitle>
            <SheetDescription>
              Author and edit slot_definitions. Changes here surface as
              "Insert from template" options inside position editors.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <Suspense
              fallback={
                <div className="text-sm text-muted-foreground p-6">
                  Loading editor…
                </div>
              }
            >
              <SettingsShortlistingSlots />
            </Suspense>
          </div>
        </SheetContent>
      </Sheet>
    </Collapsible>
  );
}
