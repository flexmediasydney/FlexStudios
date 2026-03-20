// Single source of truth for project statuses

export const PROJECT_STAGES = [
  { value: "pending_review", label: "Pending Review", color: "bg-amber-50", textColor: "text-amber-700", borderColor: "border-amber-300" },
  { value: "to_be_scheduled", label: "To Be Scheduled", color: "bg-slate-100", textColor: "text-slate-700", borderColor: "border-slate-200" },
  { value: "scheduled",       label: "Scheduled",       color: "bg-blue-100",  textColor: "text-blue-700",  borderColor: "border-blue-200" },
  { value: "onsite",          label: "Onsite",          color: "bg-yellow-100",textColor: "text-yellow-700",borderColor: "border-yellow-200" },
  { value: "uploaded",        label: "Uploaded",        color: "bg-orange-100",textColor: "text-orange-700",borderColor: "border-orange-200" },
  { value: "submitted",       label: "Submitted",       color: "bg-purple-100",textColor: "text-purple-700",borderColor: "border-purple-200" },
  { value: "in_progress",     label: "In Progress",     color: "bg-violet-100",textColor: "text-violet-700",borderColor: "border-violet-200" },
  { value: "in_production",    label: "In Production",   color: "bg-cyan-100",  textColor: "text-cyan-700",  borderColor: "border-cyan-200" },
  { value: "ready_for_partial",label: "Ready for Partial",color: "bg-indigo-100",textColor: "text-indigo-700",borderColor: "border-indigo-200" },
  { value: "in_revision",     label: "In Revision",     color: "bg-amber-100",textColor: "text-amber-700",borderColor: "border-amber-200" },
  { value: "delivered",       label: "Delivered",       color: "bg-emerald-100",textColor: "text-emerald-700",borderColor: "border-emerald-200" }
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