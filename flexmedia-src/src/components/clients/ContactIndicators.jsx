import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Clock, CalendarCheck, AlertTriangle } from "lucide-react";
import { formatDistanceToNow, format, isPast, differenceInDays } from "date-fns";
import { cn } from "@/lib/utils";

/**
 * LastContactIndicator — shows when the contact was last reached, with color coding.
 *
 * Color logic:
 *   <= 7 days  — green
 *   <= 30 days — blue
 *   <= 60 days — amber
 *   > 60 days  — red
 *   never      — gray (muted)
 */
export function LastContactIndicator({ agent, size = "sm" }) {
  const lastContact = agent.last_contacted_at || agent.last_contact_date;

  const { label, colorClass, iconColor, daysAgo } = useMemo(() => {
    if (!lastContact) {
      return {
        label: "Never",
        colorClass: "text-muted-foreground",
        iconColor: "text-muted-foreground/60",
        daysAgo: null,
      };
    }

    const d = differenceInDays(new Date(), new Date(lastContact));
    let color, icon;

    if (d <= 7) {
      color = "text-green-700";
      icon = "text-green-500";
    } else if (d <= 30) {
      color = "text-blue-700";
      icon = "text-blue-500";
    } else if (d <= 60) {
      color = "text-amber-700";
      icon = "text-amber-500";
    } else {
      color = "text-red-700";
      icon = "text-red-500";
    }

    return {
      label: formatDistanceToNow(new Date(lastContact), { addSuffix: true }),
      colorClass: color,
      iconColor: icon,
      daysAgo: d,
    };
  }, [lastContact]);

  const sizeClasses = size === "xs" ? "text-[9px]" : "text-[10px]";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1", colorClass, sizeClasses)}>
            <Clock className={cn("flex-shrink-0", iconColor, size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3")} />
            <span className="truncate">{daysAgo !== null ? `${daysAgo}d` : "Never"}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p className="font-medium">Last Contact</p>
          <p className="text-muted-foreground">
            {lastContact
              ? `${format(new Date(lastContact), "MMM d, yyyy")} (${label})`
              : "No contact recorded"}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * NextFollowUpIndicator — shows the next follow-up date with color coding.
 *
 * Color logic:
 *   overdue    — red (pulsing dot)
 *   due today  — amber
 *   upcoming   — green
 *   not set    — hidden
 */
export function NextFollowUpIndicator({ agent, size = "sm" }) {
  const followUp = agent.next_follow_up_date;

  const { label, colorClass, bgClass, isOverdue, daysUntil } = useMemo(() => {
    if (!followUp) return { label: null, colorClass: "", bgClass: "", isOverdue: false, daysUntil: null };

    const d = new Date(followUp);
    const now = new Date();
    const days = differenceInDays(d, now);
    const overdue = isPast(d);

    if (overdue) {
      return {
        label: `${Math.abs(days)}d overdue`,
        colorClass: "text-red-700",
        bgClass: "bg-red-50 border-red-200",
        isOverdue: true,
        daysUntil: days,
      };
    }

    if (days === 0) {
      return {
        label: "Due today",
        colorClass: "text-amber-700",
        bgClass: "bg-amber-50 border-amber-200",
        isOverdue: false,
        daysUntil: 0,
      };
    }

    if (days <= 3) {
      return {
        label: `In ${days}d`,
        colorClass: "text-amber-600",
        bgClass: "bg-amber-50 border-amber-100",
        isOverdue: false,
        daysUntil: days,
      };
    }

    return {
      label: `In ${days}d`,
      colorClass: "text-green-700",
      bgClass: "bg-green-50 border-green-100",
      isOverdue: false,
      daysUntil: days,
    };
  }, [followUp]);

  if (!followUp || !label) return null;

  const sizeClasses = size === "xs" ? "text-[9px] px-1 py-0" : "text-[10px] px-1.5 py-0.5";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border font-medium",
              colorClass,
              bgClass,
              sizeClasses
            )}
          >
            {isOverdue ? (
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
              </span>
            ) : (
              <CalendarCheck className={cn("flex-shrink-0", size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3")} />
            )}
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p className="font-medium">Next Follow-up</p>
          <p className="text-muted-foreground">
            {format(new Date(followUp), "MMM d, yyyy 'at' h:mm a")}
          </p>
          {isOverdue && (
            <p className="text-red-600 font-medium mt-1">
              <AlertTriangle className="h-3 w-3 inline mr-1" />
              Overdue - follow up needed
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
