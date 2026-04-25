/**
 * HelpTip — small "(i)" info icon that opens a tooltip with field-level help.
 *
 * Used inside <FieldRow label="…"> in ThemeEditor.jsx (and any future drone
 * theme editor surfaces). Drop it next to any label like:
 *
 *   <FieldRow label="Shape">
 *     <HelpTip fieldKey="anchor_line.shape" />
 *     ...
 *   </FieldRow>
 *
 * The dictionary lives in themeHelpText.js, keyed by the dot-path of the
 * theme config field (e.g. "boundary.line.style", "poi_selection.radius_m").
 * If a key is missing the component renders nothing — safe to sprinkle
 * liberally without crashing the editor when help text is still being
 * authored.
 *
 * Reuses the shadcn Tooltip primitive (which already has dark-on-light
 * styling fixed at the primitive level — see components/ui/tooltip.jsx).
 * The TooltipProvider is mounted globally in App.jsx, so we don't need to
 * wrap each instance.
 */

import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { THEME_HELP_TEXT } from "./themeHelpText";

export function HelpTip({ fieldKey, className, side = "right" }) {
  const help = THEME_HELP_TEXT[fieldKey];
  if (!help) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Help: ${help.title}`}
          className="inline-flex items-center justify-center align-middle"
          // Don't let an info-icon click toggle a Collapsible / submit a form
          onClick={(e) => e.stopPropagation()}
        >
          <Info
            className={cn(
              "h-3 w-3 text-muted-foreground hover:text-foreground transition-colors cursor-help ml-1",
              className,
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs space-y-1">
        <p className="font-semibold text-xs">{help.title}</p>
        <p className="text-xs leading-snug">{help.desc}</p>
        {help.example && (
          <p className="text-[10px] text-muted-foreground italic leading-snug">
            e.g. {help.example}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export default HelpTip;
