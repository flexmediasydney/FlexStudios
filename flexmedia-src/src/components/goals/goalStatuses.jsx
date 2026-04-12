/**
 * Goal lifecycle statuses, categories, and helpers.
 * Mirrors the pattern in components/projects/projectStatuses.jsx.
 */

export const GOAL_STAGES = [
  {
    value: "goal_not_started",
    label: "Not Started",
    color: "bg-slate-100",
    textColor: "text-slate-700",
    borderColor: "border-slate-200",
    darkColor: "dark:bg-slate-800/40",
    darkText: "dark:text-slate-400",
    fill: "#94a3b8",
  },
  {
    value: "goal_active",
    label: "Active",
    color: "bg-blue-100",
    textColor: "text-blue-700",
    borderColor: "border-blue-200",
    darkColor: "dark:bg-blue-900/40",
    darkText: "dark:text-blue-400",
    fill: "#3b82f6",
  },
  {
    value: "goal_on_hold",
    label: "On Hold",
    color: "bg-amber-100",
    textColor: "text-amber-700",
    borderColor: "border-amber-200",
    darkColor: "dark:bg-amber-900/40",
    darkText: "dark:text-amber-400",
    fill: "#f59e0b",
  },
  {
    value: "goal_completed",
    label: "Completed",
    color: "bg-emerald-100",
    textColor: "text-emerald-700",
    borderColor: "border-emerald-200",
    darkColor: "dark:bg-emerald-900/40",
    darkText: "dark:text-emerald-400",
    fill: "#10b981",
  },
  {
    value: "goal_cancelled",
    label: "Cancelled",
    color: "bg-red-100",
    textColor: "text-red-700",
    borderColor: "border-red-200",
    darkColor: "dark:bg-red-900/40",
    darkText: "dark:text-red-400",
    fill: "#ef4444",
  },
];

export const GOAL_CATEGORIES = [
  "Business Development",
  "Operations",
  "Marketing & Branding",
  "Technology & Tools",
  "Learning & Development",
  "Client Experience",
];

export const GOAL_QUARTERS = (() => {
  const now = new Date();
  const year = now.getFullYear();
  const quarters = [];
  for (let y = year; y <= year + 1; y++) {
    for (let q = 1; q <= 4; q++) {
      quarters.push(`Q${q} ${y}`);
    }
  }
  return quarters;
})();

export const goalStageLabel = (value) =>
  GOAL_STAGES.find((s) => s.value === value)?.label || value;

export const goalStageConfig = (value) =>
  GOAL_STAGES.find((s) => s.value === value) || GOAL_STAGES[0];

export const isGoalStatus = (status) => status?.startsWith("goal_");

export const GOAL_STATUS_VALUES = GOAL_STAGES.map((s) => s.value);
