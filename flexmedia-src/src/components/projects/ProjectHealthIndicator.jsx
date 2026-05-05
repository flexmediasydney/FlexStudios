import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  CheckCircle2, AlertTriangle, XCircle,
  TrendingUp, Clock, ShieldCheck
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const HEALTH_STATES = {
  on_track: {
    label: "On Track",
    color: "text-green-700 dark:text-green-300",
    bg: "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800",
    iconBg: "bg-green-100 dark:bg-green-900/40",
    icon: CheckCircle2,
    iconColor: "text-green-600 dark:text-green-400",
    dot: "bg-green-500",
  },
  at_risk: {
    label: "At Risk",
    color: "text-amber-700 dark:text-amber-300",
    bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800",
    iconBg: "bg-amber-100 dark:bg-amber-900/40",
    icon: AlertTriangle,
    iconColor: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  overdue: {
    label: "Overdue",
    color: "text-red-700 dark:text-red-300",
    bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",
    iconBg: "bg-red-100 dark:bg-red-900/40",
    icon: XCircle,
    iconColor: "text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
  completed: {
    label: "Completed",
    color: "text-blue-700 dark:text-blue-300",
    bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800",
    iconBg: "bg-blue-100 dark:bg-blue-900/40",
    icon: ShieldCheck,
    iconColor: "text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
  },
};

export default function ProjectHealthIndicator({ project, tasks = [] }) {
  const { health, reasons } = useMemo(() => {
    if (!project) return { health: "on_track", reasons: [] };

    const now = new Date();
    const reasonList = [];

    // If project is delivered or cancelled, it's completed
    if (project.status === "delivered" || project.status === "cancelled") {
      return { health: "completed", reasons: ["Project is delivered"] };
    }

    const activeTasks = tasks.filter(t => !t.is_deleted && !t.is_archived);
    const completedTasks = activeTasks.filter(t => t.is_completed);
    const taskPct = activeTasks.length > 0
      ? (completedTasks.length / activeTasks.length) * 100
      : 0;

    // Check delivery date
    const deliveryDate = project.delivery_date || project._delivery_date_raw;
    let daysUntilDelivery = null;
    if (deliveryDate) {
      const dd = new Date(deliveryDate);
      daysUntilDelivery = Math.ceil((dd - now) / (1000 * 60 * 60 * 24));
    }

    // OVERDUE: past delivery date and not delivered
    if (daysUntilDelivery !== null && daysUntilDelivery < 0) {
      reasonList.push(`${Math.abs(daysUntilDelivery)} day${Math.abs(daysUntilDelivery) !== 1 ? 's' : ''} past delivery date`);
    }

    // AT RISK: within 1 day of delivery but less than 80% complete
    if (daysUntilDelivery !== null && daysUntilDelivery >= 0 && daysUntilDelivery <= 1 && taskPct < 80) {
      reasonList.push("Delivery date imminent with low task completion");
    }

    // AT RISK: within 2 days and less than 50% tasks done
    if (daysUntilDelivery !== null && daysUntilDelivery >= 0 && daysUntilDelivery <= 2 && taskPct < 50) {
      reasonList.push("Delivery in 2 days but tasks behind schedule");
    }

    // AT RISK: no tasks completed and project is past scheduling
    const ACTIVE_STAGES = ["onsite", "uploaded", "in_progress", "in_production"];
    if (activeTasks.length > 0 && completedTasks.length === 0 && ACTIVE_STAGES.includes(project.status)) {
      reasonList.push("No tasks completed in active stage");
    }

    // Determine health status
    let health = "on_track";
    if (daysUntilDelivery !== null && daysUntilDelivery < 0 && taskPct < 100) {
      health = "overdue";
    } else if (reasonList.length > 0) {
      health = "at_risk";
    }

    if (health === "on_track" && activeTasks.length > 0) {
      reasonList.push(`${Math.round(taskPct)}% of tasks completed`);
    }

    return { health, reasons: reasonList };
  }, [project, tasks]);

  const config = HEALTH_STATES[health];
  const Icon = config.icon;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200 cursor-default hover:shadow-sm",
              config.bg, config.color
            )}
            role="status"
            aria-label={`Project health: ${config.label}`}
          >
            <span className={cn("h-2 w-2 rounded-full", config.dot)} aria-hidden="true" />
            <Icon className={cn("h-3.5 w-3.5", config.iconColor)} aria-hidden="true" />
            {config.label}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-semibold text-xs">Project Health: {config.label}</p>
            {reasons.map((r, i) => (
              <p key={i} className="text-xs opacity-90">- {r}</p>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
