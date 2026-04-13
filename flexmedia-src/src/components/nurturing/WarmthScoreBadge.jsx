import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

const WARMTH_TIERS = [
  { max: 20, bg: "bg-blue-100",   text: "text-blue-700",   label: "Cold" },
  { max: 40, bg: "bg-sky-100",    text: "text-sky-700",    label: "Cool" },
  { max: 60, bg: "bg-amber-100",  text: "text-amber-700",  label: "Warm" },
  { max: 80, bg: "bg-orange-100", text: "text-orange-700", label: "Hot" },
  { max: 100, bg: "bg-red-100",   text: "text-red-700",    label: "On Fire" },
];

const SIZE_CLASSES = {
  sm: "h-6 min-w-[1.5rem] px-1 text-[10px] gap-0.5",
  md: "h-8 min-w-[2rem] px-1.5 text-xs gap-1",
  lg: "h-10 min-w-[2.5rem] px-2 text-sm gap-1",
};

const ICON_SIZE = {
  sm: "h-2.5 w-2.5",
  md: "h-3 w-3",
  lg: "h-3.5 w-3.5",
};

const TREND_CONFIG = {
  improving: { Icon: TrendingUp, color: "text-green-600" },
  stable:    { Icon: Minus,       color: "text-muted-foreground" },
  declining: { Icon: TrendingDown, color: "text-red-600" },
};

/**
 * WarmthScoreBadge - compact circular warmth score indicator (0-100).
 *
 * Props:
 *   score  — number 0-100
 *   trend  — 'improving' | 'stable' | 'declining'
 *   size   — 'sm' | 'md' | 'lg' (default 'md')
 */
export default function WarmthScoreBadge({ score, trend, size = "md" }) {
  const safeScore = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const tier = WARMTH_TIERS.find(t => safeScore <= t.max) || WARMTH_TIERS[WARMTH_TIERS.length - 1];
  const trendCfg = trend ? TREND_CONFIG[trend] : null;

  const trendLabel = trend
    ? trend.charAt(0).toUpperCase() + trend.slice(1)
    : null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center justify-center rounded-full font-semibold leading-none select-none shrink-0",
              tier.bg,
              tier.text,
              SIZE_CLASSES[size]
            )}
          >
            <span>{safeScore}</span>
            {trendCfg && (
              <trendCfg.Icon
                className={cn(ICON_SIZE[size], trendCfg.color)}
                aria-hidden="true"
              />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <span>
            Warmth Score: {safeScore}/100 ({tier.label})
            {trendLabel ? ` - ${trendLabel}` : ""}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
