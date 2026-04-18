/**
 * PresetControls — tiny "Save preset" + "Presets ▾" pair (#51).
 *
 * `namespace` is the localStorage bucket ("events" / "signals" / "timeline").
 * `currentPreset` is the current filter payload (opaque — the caller owns the
 * schema). `onLoad(payload)` is called with the loaded payload so the caller
 * can re-hydrate its filter state.
 */
import React, { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Bookmark, ChevronDown, Trash2 } from "lucide-react";
import { filterPresets } from "@/components/pulse/utils/qolHelpers";

export default function PresetControls({
  namespace,
  currentPreset,
  onLoad,
  size = "sm",
}) {
  // Re-render bumper — presets live in localStorage, so state in this
  // component is really just "how many writes have happened this session".
  const [bump, setBump] = useState(0);

  const presets = filterPresets.list(namespace);
  const presetNames = Object.keys(presets).sort();

  const handleSave = useCallback(() => {
    // eslint-disable-next-line no-alert
    const name = window.prompt("Save filter preset as:", "");
    if (!name) return;
    const ok = filterPresets.save(namespace, name, currentPreset);
    if (ok) {
      toast.success(`Preset "${name}" saved`);
      setBump((b) => b + 1);
    } else {
      toast.error("Failed to save preset");
    }
  }, [namespace, currentPreset]);

  const handleLoad = useCallback(
    (name) => {
      const payload = filterPresets.load(namespace, name);
      if (payload == null) {
        toast.error(`Preset "${name}" not found`);
        return;
      }
      onLoad?.(payload);
      toast.success(`Preset "${name}" loaded`);
    },
    [namespace, onLoad]
  );

  const handleDelete = useCallback(
    (name) => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Delete preset "${name}"?`)) return;
      const ok = filterPresets.delete(namespace, name);
      if (ok) {
        toast.success(`Preset "${name}" deleted`);
        setBump((b) => b + 1);
      }
    },
    [namespace]
  );

  return (
    <div className="flex items-center gap-1" data-preset-bump={bump}>
      <Button
        variant="outline"
        size={size}
        className="h-7 text-[11px] gap-1"
        onClick={handleSave}
        title="Save current filters as a preset"
      >
        <Bookmark className="h-3 w-3" />
        Save preset
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={size}
            className="h-7 text-[11px] gap-1"
            title="Load a saved preset"
          >
            Presets
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
            Saved presets
          </DropdownMenuLabel>
          {presetNames.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              No saved presets yet
            </DropdownMenuItem>
          ) : (
            <>
              {presetNames.map((name) => (
                <DropdownMenuItem
                  key={name}
                  className="flex items-center justify-between gap-2 text-xs"
                  onSelect={(e) => {
                    e.preventDefault();
                    handleLoad(name);
                  }}
                >
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    className="text-muted-foreground/60 hover:text-red-500 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(name);
                    }}
                    title={`Delete preset "${name}"`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled className="text-[10px] text-muted-foreground">
                Click a preset to load it
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
