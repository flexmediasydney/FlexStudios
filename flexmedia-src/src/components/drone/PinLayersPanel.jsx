/**
 * PinLayersPanel — Drone Wave 5 Phase 2 Stream S4
 *
 * Left-side Layers panel for the Pin Editor. Lists all pin layers grouped by
 * type ("Detected POIs (AI)", "World-anchored", "Pixel-anchored"), per-item
 * visibility toggle, plus the "Add POI" / "Add text" tool buttons.
 *
 * Pre-extracted from PinEditor.jsx as a no-behavior-change refactor before
 * the Wave 5 P2 fix wave (architect Section H, Joseph #6) — PinEditor.jsx is
 * 2500+ lines and the pin-fix diff would be unreviewable inline.
 *
 * Props:
 *   layerGroups        : { [groupKey]: { label, items[] } } pre-computed in PinEditor
 *   foldedGroups       : Set<string> — group keys that are currently collapsed
 *   onToggleFold       : (groupKey) => void — flip fold state
 *   selectedItemId     : string | null
 *   onSelectItem       : (itemId) => void
 *   hiddenIds          : Set<string>
 *   onToggleVisibility : (itemId) => void
 *   onUnsuppress       : (itemId) => void — F35: restore a suppressed pin
 *   tool               : current tool ('select' | 'pan' | 'add_pin' | 'add_text')
 *   onSetTool          : (tool) => void
 *   shotsCount         : number — disables Add buttons when 0
 *   poseAvailable      : boolean — drives Add POI tooltip
 *   TOOLS              : tool constant map (passed in to avoid duplicating)
 */

import { Button } from "@/components/ui/button";
import {
  Eye,
  EyeOff,
  Globe,
  Image as ImageIconLucide,
  Pin as PinIcon,
  Plus,
  Type as TextIcon,
  ChevronDown,
  ChevronRight,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function PinLayersPanel({
  layerGroups,
  foldedGroups,
  onToggleFold,
  selectedItemId,
  onSelectItem,
  hiddenIds,
  onToggleVisibility,
  onUnsuppress,
  tool,
  onSetTool,
  shotsCount = 0,
  poseAvailable = true,
  TOOLS,
}) {
  return (
    <aside className="w-60 border-r border-border bg-background overflow-y-auto shrink-0 p-3 text-sm">
      <div className="font-semibold text-xs uppercase text-muted-foreground mb-2">
        Layers
      </div>
      {Object.entries(layerGroups).map(([key, group]) => {
        const folded = foldedGroups.has(key);
        return (
          <div key={key} className="mb-3">
            <button
              type="button"
              onClick={() => onToggleFold(key)}
              className="flex items-center gap-1 w-full text-left text-xs font-medium text-foreground/80 hover:text-foreground"
            >
              {folded ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {key === "world" ? (
                <Globe className="h-3 w-3" />
              ) : key === "detected" ? (
                <PinIcon className="h-3 w-3" />
              ) : (
                <ImageIconLucide className="h-3 w-3" />
              )}
              {group.label}
              <span className="text-muted-foreground ml-auto">
                {group.items.length}
              </span>
            </button>
            {!folded && group.items.length === 0 && (
              <p className="pl-5 text-[11px] text-muted-foreground italic mt-1">
                {key === "world"
                  ? "Property + theme POIs (GPS-anchored)"
                  : key === "detected"
                    ? "AI-detected nearby places (read-only)"
                    : "Text, ribbons, address overlays (per-shot)"}
              </p>
            )}
            {!folded && (
              <ul className="mt-1 space-y-0.5 pl-2">
                {group.items.map((it) => {
                  const isHidden = hiddenIds.has(it.id);
                  const isSelected = it.id === selectedItemId;
                  // F35: suppressed pins get rendered grey/strikethrough so
                  // operators can still see them and restore via the
                  // "Restore" affordance. Without this, suppression was a
                  // one-way trapdoor — you could never get the pin back
                  // until the next drone-pois refresh.
                  const isSuppressed =
                    it.lifecycle === "suppressed" || it._suppress === true;
                  return (
                    <li
                      key={it.id}
                      className={cn(
                        "flex items-center gap-1 rounded px-1.5 py-1 text-xs cursor-pointer",
                        isSelected
                          ? "bg-blue-100 dark:bg-blue-950 text-blue-900 dark:text-blue-200"
                          : "hover:bg-muted",
                        isSuppressed &&
                          "opacity-50 [&_.layer-label]:line-through",
                      )}
                      onClick={() => onSelectItem(it.id)}
                    >
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: it.color || "#888" }}
                      />
                      <span className="layer-label truncate flex-1">
                        {it.label || it.kindLabel || "Item"}
                      </span>
                      {/* F35: Restore button on suppressed pins. Click flips
                          _suppress=false locally; on Save we send an
                          un_suppress action to the server. */}
                      {isSuppressed && it.dbId && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onUnsuppress?.(it.id);
                          }}
                          className="opacity-60 hover:opacity-100 shrink-0"
                          title="Restore from suppression"
                          aria-label={`Restore ${it.label || it.kindLabel || "layer"}`}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleVisibility(it.id);
                        }}
                        className="opacity-50 hover:opacity-100 shrink-0"
                        title={isHidden ? "Show" : "Hide"}
                        aria-label={`${isHidden ? "Show" : "Hide"} ${
                          it.label || it.kindLabel || "layer"
                        }`}
                      >
                        {isHidden ? (
                          <EyeOff className="h-3 w-3" />
                        ) : (
                          <Eye className="h-3 w-3" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      <div className="border-t border-border pt-3 mt-2 space-y-1">
        <Button
          size="sm"
          variant={tool === TOOLS.ADD_PIN ? "secondary" : "ghost"}
          className="w-full justify-start gap-1 text-xs"
          onClick={() => onSetTool(TOOLS.ADD_PIN)}
          disabled={shotsCount === 0}
          title={
            shotsCount === 0
              ? "No shots in this shoot — add shots first."
              : poseAvailable
                ? "Click on canvas to drop a world-anchored pin (GPS)"
                : "SfM unavailable — pin will be pixel-anchored to this shot"
          }
        >
          <Plus className="h-3 w-3" /> Add POI pin
        </Button>
        <Button
          size="sm"
          variant={tool === TOOLS.ADD_TEXT ? "secondary" : "ghost"}
          className="w-full justify-start gap-1 text-xs"
          onClick={() => onSetTool(TOOLS.ADD_TEXT)}
          disabled={shotsCount === 0}
          title={
            shotsCount === 0
              ? "No shots in this shoot — add shots first."
              : "Click on canvas to drop a pixel-anchored text label on this shot"
          }
        >
          <TextIcon className="h-3 w-3" /> Add text
        </Button>
        <p className="text-[10px] text-muted-foreground pl-1 leading-tight pt-1">
          <span className="font-medium">World</span> pins move with GPS
          across all shots.
          <br />
          <span className="font-medium">Pixel</span> labels stay on a
          single shot.
        </p>
      </div>
    </aside>
  );
}
