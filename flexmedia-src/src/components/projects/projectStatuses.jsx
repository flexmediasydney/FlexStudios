// Single source of truth for project statuses

export const PROJECT_STAGES = [
  { value: "pending_review", label: "Pending Review", color: "bg-amber-50 dark:bg-amber-950/30", textColor: "text-amber-700 dark:text-amber-400", borderColor: "border-amber-300 dark:border-amber-800" },
  { value: "to_be_scheduled", label: "To Be Scheduled", color: "bg-slate-100 dark:bg-slate-900/40", textColor: "text-slate-700 dark:text-slate-300", borderColor: "border-slate-200 dark:border-slate-700" },
  { value: "scheduled",       label: "Scheduled",       color: "bg-blue-100 dark:bg-blue-950/30",  textColor: "text-blue-700 dark:text-blue-400",  borderColor: "border-blue-200 dark:border-blue-800" },
  { value: "onsite",          label: "Onsite",          color: "bg-yellow-100 dark:bg-yellow-950/30",textColor: "text-yellow-700 dark:text-yellow-400",borderColor: "border-yellow-200 dark:border-yellow-800" },
  { value: "uploaded",        label: "Uploaded",        color: "bg-orange-100 dark:bg-orange-950/30",textColor: "text-orange-700 dark:text-orange-400",borderColor: "border-orange-200 dark:border-orange-800" },
  { value: "in_progress",     label: "Stills in Progress", color: "bg-violet-100 dark:bg-violet-950/30",textColor: "text-violet-700 dark:text-violet-400",borderColor: "border-violet-200 dark:border-violet-800" },
  { value: "in_production",    label: "Video in Progress", color: "bg-cyan-100 dark:bg-cyan-950/30",  textColor: "text-cyan-700 dark:text-cyan-400",  borderColor: "border-cyan-200 dark:border-cyan-800" },
  { value: "in_revision",     label: "In Revision",     color: "bg-amber-100 dark:bg-amber-950/30",textColor: "text-amber-700 dark:text-amber-400",borderColor: "border-amber-200 dark:border-amber-800" },
  { value: "delivered",       label: "Delivered",       color: "bg-emerald-100 dark:bg-emerald-950/30",textColor: "text-emerald-700 dark:text-emerald-400",borderColor: "border-emerald-200 dark:border-emerald-800" }
];

export const PROJECT_OUTCOMES = [
  { value: "open", label: "Open" },
  { value: "won",  label: "Won" },
  { value: "lost", label: "Lost" }
];

export const PROJECT_PAYMENT_STATUSES = [
  { value: "unpaid", label: "Unpaid" },
  { value: "paid",   label: "Paid" }
];

export const stageLabel = (value) => PROJECT_STAGES.find(s => s.value === value)?.label || value;
export const stageConfig = (value) => PROJECT_STAGES.find(s => s.value === value) || PROJECT_STAGES[0];