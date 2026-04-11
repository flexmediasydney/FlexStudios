/**
 * TaskEffortBadge - Compact inline est. vs actual effort indicator for task rows.
 * Shows: actual logged / estimated, with a colored progress bar.
 */
import { cn } from "@/lib/utils";

function formatMins(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

export default function TaskEffortBadge({ estimatedMinutes = 0, actualSeconds = 0, compact = false }) {
  const estimatedSeconds = estimatedMinutes * 60;
  const hasEstimate = estimatedSeconds > 0;
  const hasActual = actualSeconds > 0;

  if (!hasEstimate && !hasActual) return null;

  const pct = hasEstimate ? Math.min(Math.round((actualSeconds / estimatedSeconds) * 100), 999) : null;
  const over = pct !== null && pct > 100;

  const barColor = over ? "bg-orange-500" : pct >= 80 ? "bg-amber-500" : "bg-green-500";
  const textColor = over ? "text-orange-600" : "text-muted-foreground";

  if (compact) {
    return (
      <div className="flex items-center gap-1" title={`Logged: ${formatMins(actualSeconds)} / Est: ${formatMins(estimatedSeconds)}`}>
        <span className={cn("text-[10px] font-medium", hasActual ? textColor : "text-muted-foreground/60")}>
          {hasActual
            ? <>{formatMins(actualSeconds)}{hasEstimate && <span className="text-muted-foreground/60">/{formatMins(estimatedSeconds)}</span>}</>
            : hasEstimate
              ? <>~{formatMins(estimatedSeconds)}</>
              : null
          }
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Effort</span>
        <span className={cn("font-medium tabular-nums", textColor)}>
          {formatMins(actualSeconds)}
          {hasEstimate && <span className="text-muted-foreground"> / {formatMins(estimatedSeconds)}</span>}
          {pct !== null && <span className={cn("ml-1 font-bold tabular-nums", over ? "text-orange-600" : "text-green-600")}>{pct}%</span>}
        </span>
      </div>
      {hasEstimate && (
        <div className="w-full bg-gray-100 rounded-full h-1.5">
          <div
            className={cn("h-1.5 rounded-full transition-all duration-300", barColor)}
            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}