/**
 * Tip — thin wrapper around the Radix Tooltip primitive.
 *
 * The Recipe Matrix is help-banner heavy by design (Joseph's brief: "tooltips
 * everywhere"), so we ship one `<Tip>` component instead of inlining the
 * Tooltip provider/trigger/content boilerplate at every callsite.
 *
 * Usage:
 *   <Tip text="Engine MUST fill this position…">
 *     <span className="underline decoration-dotted">Mandatory</span>
 *   </Tip>
 *
 * The `asChild` flag is forwarded to the trigger so consumers can wrap a
 * <span>, <button>, or full sub-tree without an extra wrapper element.
 */
import React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";

export default function Tip({
  text,
  children,
  side = "top",
  align = "center",
  delay = 120,
  asChild = true,
  className,
}) {
  return (
    <TooltipProvider delayDuration={delay}>
      <Tooltip>
        <TooltipTrigger asChild={asChild}>
          {children}
        </TooltipTrigger>
        <TooltipContent side={side} align={align} className={className}>
          <div className="max-w-xs text-[11px] leading-snug">{text}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * IconTip — lightweight `?` glyph that opens a tooltip. Drop next to a
 * label when there isn't natural inline copy to wrap.
 */
export function IconTip({ text, className, "data-testid": testId }) {
  return (
    <Tip text={text}>
      <span
        className={
          "inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-help " +
          (className || "")
        }
        data-testid={testId || "icon-tip"}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </span>
    </Tip>
  );
}
