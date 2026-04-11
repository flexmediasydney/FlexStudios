import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Contact Health Score — computes a 0-100 score for a contact based on:
 *   - Recency of last contact (40 pts)
 *   - Project count (30 pts)
 *   - Revenue generated (30 pts)
 *
 * Props:
 *   agent          — the agent object
 *   projectCount   — number of projects for this agent
 *   totalRevenue   — total revenue from this agent's projects
 *   size           — "sm" | "md" | "lg" (visual size)
 *   showLabel      — whether to show "Health" label
 */

function computeHealthScore(agent, projectCount = 0, totalRevenue = 0) {
  // Guard against null/undefined/NaN inputs
  projectCount = Number(projectCount) || 0;
  totalRevenue = Number(totalRevenue) || 0;

  let recencyScore = 0;
  let projectScore = 0;
  let revenueScore = 0;
  const breakdown = {};

  if (!agent) return { score: 0, recencyScore: 0, projectScore: 0, revenueScore: 0, breakdown: { recency: "N/A", projects: "0 projects", revenue: "$0" }, grade: "Critical" };

  // Recency score (40 pts)
  // Use agent's contact_frequency_days if set, otherwise default to 90 days
  const freq = agent.contact_frequency_days != null ? agent.contact_frequency_days : 90;
  const lastContact = agent.last_contacted_at;
  if (lastContact) {
    const daysSince = Math.max(0, (Date.now() - new Date(lastContact).getTime()) / (1000 * 60 * 60 * 24));
    // Scale thresholds relative to the contact frequency
    if (daysSince <= freq * 0.1) recencyScore = 40;
    else if (daysSince <= freq * 0.2) recencyScore = 35;
    else if (daysSince <= freq * 0.5) recencyScore = 28;
    else if (daysSince <= freq) recencyScore = 20;
    else if (daysSince <= freq * 1.5) recencyScore = 12;
    else if (daysSince <= freq * 2) recencyScore = 5;
    else recencyScore = 0;
    breakdown.recency = `${Math.round(daysSince)}d ago`;
  } else {
    recencyScore = 0;
    breakdown.recency = "Never";
  }

  // Project score (30 pts)
  if (projectCount >= 10) projectScore = 30;
  else if (projectCount >= 5) projectScore = 25;
  else if (projectCount >= 3) projectScore = 20;
  else if (projectCount >= 2) projectScore = 15;
  else if (projectCount >= 1) projectScore = 10;
  else projectScore = 0;
  breakdown.projects = `${projectCount} project${projectCount !== 1 ? "s" : ""}`;

  // Revenue score (30 pts)
  if (totalRevenue >= 10000) revenueScore = 30;
  else if (totalRevenue >= 5000) revenueScore = 25;
  else if (totalRevenue >= 2000) revenueScore = 20;
  else if (totalRevenue >= 1000) revenueScore = 15;
  else if (totalRevenue >= 500) revenueScore = 10;
  else if (totalRevenue > 0) revenueScore = 5;
  else revenueScore = 0;
  breakdown.revenue = `$${totalRevenue.toLocaleString()}`;

  const total = recencyScore + projectScore + revenueScore;

  return {
    score: total,
    recencyScore,
    projectScore,
    revenueScore,
    breakdown,
    grade: total >= 80 ? "Excellent" : total >= 60 ? "Good" : total >= 40 ? "Fair" : total >= 20 ? "Poor" : "Critical",
  };
}

function getScoreColor(score) {
  if (score >= 80) return { bg: "bg-green-100", text: "text-green-700", ring: "ring-green-300", fill: "text-green-500" };
  if (score >= 60) return { bg: "bg-blue-100", text: "text-blue-700", ring: "ring-blue-300", fill: "text-blue-500" };
  if (score >= 40) return { bg: "bg-amber-100", text: "text-amber-700", ring: "ring-amber-300", fill: "text-amber-500" };
  if (score >= 20) return { bg: "bg-orange-100", text: "text-orange-700", ring: "ring-orange-300", fill: "text-orange-500" };
  return { bg: "bg-red-100", text: "text-red-700", ring: "ring-red-300", fill: "text-red-500" };
}

export { computeHealthScore };

export default function ContactHealthScore({ agent, projectCount = 0, totalRevenue = 0, size = "sm", showLabel = false }) {
  const health = useMemo(
    () => computeHealthScore(agent, projectCount, totalRevenue),
    [agent, projectCount, totalRevenue]
  );

  const colors = getScoreColor(health.score);

  const sizeClasses = {
    sm: "w-7 h-7 text-[10px]",
    md: "w-9 h-9 text-xs",
    lg: "w-12 h-12 text-sm",
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "rounded-full flex items-center justify-center font-bold ring-2 tabular-nums",
                colors.bg,
                colors.text,
                colors.ring,
                sizeClasses[size]
              )}
            >
              {health.score}
            </div>
            {showLabel && (
              <span className={cn("text-[10px] font-medium", colors.text)}>
                {health.grade}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56">
          <div className="space-y-1.5">
            <p className="font-semibold text-xs">
              Contact Health: {health.score}/100 ({health.grade})
            </p>
            <div className="space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Recency</span>
                <span>{health.recencyScore}/40 ({health.breakdown.recency})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Projects</span>
                <span>{health.projectScore}/30 ({health.breakdown.projects})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Revenue</span>
                <span>{health.revenueScore}/30 ({health.breakdown.revenue})</span>
              </div>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
