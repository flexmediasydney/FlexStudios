import { useCallback } from "react";
import { GOAL_STAGES, goalStageConfig } from "@/components/goals/goalStatuses";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

/**
 * GoalStatusPipeline
 *
 * Horizontal pill-based status pipeline for the 5 goal stages.
 * Current stage is highlighted with its theme color.
 * Past stages show green with a check mark.
 * Future stages are muted.
 *
 * Special stages (On Hold, Cancelled) can be reached from any stage —
 * they are treated as non-linear and never rendered as "past completed"
 * just because they appear earlier in the list.
 *
 * Props:
 *   currentStatus  – string (one of GOAL_STAGES values)
 *   onStatusChange – (newStatus: string) => void
 *   canEdit        – boolean
 */

// Stages that can be reached from any point in the lifecycle
const NON_LINEAR_STAGES = new Set(["goal_on_hold", "goal_cancelled"]);

// Linear progression (the main path)
const LINEAR_ORDER = ["goal_not_started", "goal_active", "goal_completed"];

function getLinearIndex(statusValue) {
  return LINEAR_ORDER.indexOf(statusValue);
}

export default function GoalStatusPipeline({ currentStatus, onStatusChange, canEdit }) {
  const currentConfig = goalStageConfig(currentStatus);
  const currentLinearIdx = getLinearIndex(currentStatus);

  const handleClick = useCallback(
    (stageValue) => {
      if (!canEdit) return;
      if (stageValue === currentStatus) return;
      onStatusChange(stageValue);
    },
    [canEdit, currentStatus, onStatusChange]
  );

  return (
    <div
      className="flex items-center gap-0 overflow-x-auto"
      role="list"
      aria-label="Goal status pipeline"
    >
      {GOAL_STAGES.map((stage, index) => {
        const isCurrent = stage.value === currentStatus;
        const isNonLinear = NON_LINEAR_STAGES.has(stage.value);

        // A stage is "completed" only if it sits before the current stage
        // in the linear progression AND neither stage is non-linear
        const stageLinearIdx = getLinearIndex(stage.value);
        const isCompleted =
          !isNonLinear &&
          !NON_LINEAR_STAGES.has(currentStatus) &&
          stageLinearIdx !== -1 &&
          currentLinearIdx !== -1 &&
          stageLinearIdx < currentLinearIdx;

        const isFuture = !isCurrent && !isCompleted;

        const isFirst = index === 0;
        const isLast = index === GOAL_STAGES.length - 1;

        // Chevron clip-path so the pills connect visually
        const clipPath = isFirst
          ? "polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)"
          : isLast
          ? "polygon(9px 0, 100% 0, 100% 100%, 9px 100%, 0 50%)"
          : "polygon(9px 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 9px 100%, 0 50%)";

        // Colour classes
        let bgClass;
        let textClass;

        if (isCurrent) {
          // Use the stage's own theme colour for the active stage
          bgClass = stage.color + " " + (stage.darkColor || "");
          textClass = stage.textColor + " " + (stage.darkText || "");
        } else if (isCompleted) {
          bgClass = "bg-emerald-500 dark:bg-emerald-600";
          textClass = "text-white";
        } else {
          // Future / non-current non-linear stages
          bgClass = "bg-muted";
          textClass = "text-muted-foreground";
        }

        const hoverClass =
          canEdit && !isCurrent
            ? isCurrent
              ? ""
              : isCompleted
              ? "hover:bg-emerald-600 dark:hover:bg-emerald-700 hover:text-white"
              : "hover:bg-accent hover:text-accent-foreground"
            : "";

        const ringClass =
          isCurrent
            ? `ring-2 ring-offset-1 ring-offset-background ring-current/30`
            : "";

        return (
          <button
            key={stage.value}
            role="listitem"
            onClick={() => handleClick(stage.value)}
            disabled={!canEdit || isCurrent}
            aria-label={`${stage.label}${isCurrent ? " (current)" : isCompleted ? " (completed)" : ""}`}
            aria-current={isCurrent ? "step" : undefined}
            title={
              !canEdit && !isCurrent
                ? "You need edit permissions to change the goal status"
                : stage.label
            }
            style={{
              clipPath,
              marginLeft: index === 0 ? 0 : "-2px",
            }}
            className={cn(
              // Layout
              "relative flex flex-col items-center justify-center transition-all duration-150 select-none",
              "outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary",
              isFirst ? "pl-3 pr-5 py-2.5 min-w-[96px]" : isLast ? "pl-5 pr-3 py-2.5 min-w-[96px]" : "px-5 py-2.5 min-w-[96px]",
              // Colours
              bgClass,
              textClass,
              hoverClass,
              ringClass,
              // Interaction
              canEdit && !isCurrent
                ? "cursor-pointer active:scale-95"
                : isCurrent
                ? "cursor-default"
                : "cursor-not-allowed opacity-80"
            )}
          >
            {/* Completed check icon */}
            {isCompleted && (
              <span className="absolute top-1 left-2 leading-none">
                <Check className="h-3 w-3 text-white/90" strokeWidth={3} aria-hidden="true" />
              </span>
            )}

            {/* Active pulse dot */}
            {isCurrent && (
              <span className="absolute top-1 left-2 flex h-2 w-2" aria-hidden="true">
                <span
                  className={cn(
                    "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                    stage.textColor
                  )}
                />
                <span
                  className={cn(
                    "relative inline-flex rounded-full h-2 w-2",
                    stage.textColor
                  )}
                />
              </span>
            )}

            {/* Stage label */}
            <span className="text-[11px] font-semibold leading-tight tracking-wide text-center whitespace-nowrap">
              {stage.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * GoalStatusBadge — lightweight inline badge showing the current goal stage.
 * Useful in table rows, cards, and list items where the full pipeline is overkill.
 *
 * Props: { status }
 */
export function GoalStatusBadge({ status }) {
  const config = goalStageConfig(status);
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
        config.color,
        config.textColor,
        config.borderColor,
        config.darkColor,
        config.darkText
      )}
    >
      {config.label}
    </span>
  );
}
