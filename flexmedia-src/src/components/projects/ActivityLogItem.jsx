import { fmtDate, fixTimestamp } from "@/components/utils/dateUtils";
import {
  Plus, Trash2, CheckCircle, ArrowRight, User, Package, Box, Tag,
  Calendar, DollarSign, Activity, MessageSquare, ArrowUpDown,
  ListPlus, ListChecks, FileX, Trophy, CreditCard, UserCheck,
  FileText, RefreshCw, XOctagon, MailCheck, Zap, Cog, Bot,
  ClipboardList, AlertTriangle, StickyNote, Timer, Archive, UserCog, Home
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const ACTION_CONFIG = {
  create:         { label: "Created",        color: "bg-emerald-500", textColor: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800", icon: Plus,           iconBg: "bg-emerald-100 dark:bg-emerald-900/40" },
  update:         { label: "Updated",        color: "bg-blue-500",    textColor: "text-blue-700 dark:text-blue-300",    bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800",       icon: RefreshCw,      iconBg: "bg-blue-100 dark:bg-blue-900/40" },
  delete:         { label: "Deleted",        color: "bg-red-500",     textColor: "text-red-700 dark:text-red-300",     bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",         icon: Trash2,         iconBg: "bg-red-100 dark:bg-red-900/40" },
  status_change:  { label: "Status changed", color: "bg-purple-500",  textColor: "text-purple-700 dark:text-purple-300",  bg: "bg-purple-50 border-purple-200 dark:bg-purple-950/30 dark:border-purple-800",   icon: ArrowUpDown,    iconBg: "bg-purple-100 dark:bg-purple-900/40" },
  task_added:     { label: "Task added",     color: "bg-indigo-500",  textColor: "text-indigo-700 dark:text-indigo-300",  bg: "bg-indigo-50 border-indigo-200 dark:bg-indigo-950/30 dark:border-indigo-800",   icon: ListPlus,       iconBg: "bg-indigo-100 dark:bg-indigo-900/40" },
  task_completed: { label: "Task done",      color: "bg-teal-500",    textColor: "text-teal-700 dark:text-teal-300",    bg: "bg-teal-50 border-teal-200 dark:bg-teal-950/30 dark:border-teal-800",       icon: ListChecks,     iconBg: "bg-teal-100 dark:bg-teal-900/40" },
  task_deleted:        { label: "Task deleted",      color: "bg-red-400",     textColor: "text-red-700 dark:text-red-300",     bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",         icon: FileX,          iconBg: "bg-red-100 dark:bg-red-900/40" },
  outcome_changed:     { label: "Outcome changed",   color: "bg-pink-500",    textColor: "text-pink-700 dark:text-pink-300",    bg: "bg-pink-50 border-pink-200 dark:bg-pink-950/30 dark:border-pink-800",       icon: Trophy,         iconBg: "bg-pink-100 dark:bg-pink-900/40" },
  payment_changed:     { label: "Payment changed",   color: "bg-green-500",   textColor: "text-green-700 dark:text-green-300",   bg: "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800",     icon: CreditCard,     iconBg: "bg-green-100 dark:bg-green-900/40" },
  agent_changed:       { label: "Agent changed",     color: "bg-sky-500",     textColor: "text-sky-700 dark:text-sky-300",     bg: "bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800",         icon: UserCheck,      iconBg: "bg-sky-100 dark:bg-sky-900/40" },
  request_created:     { label: "Request created",   color: "bg-violet-500",  textColor: "text-violet-700 dark:text-violet-300",  bg: "bg-violet-50 border-violet-200 dark:bg-violet-950/30 dark:border-violet-800",   icon: FileText,       iconBg: "bg-violet-100 dark:bg-violet-900/40" },
  request_updated:     { label: "Request updated",   color: "bg-blue-400",    textColor: "text-blue-700 dark:text-blue-300",    bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800",       icon: RefreshCw,      iconBg: "bg-blue-100 dark:bg-blue-900/40" },
  request_cancelled:   { label: "Request cancelled", color: "bg-orange-500",  textColor: "text-orange-700 dark:text-orange-300",  bg: "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800",   icon: XOctagon,       iconBg: "bg-orange-100 dark:bg-orange-900/40" },
  request_completed:   { label: "Request completed", color: "bg-teal-500",    textColor: "text-teal-700 dark:text-teal-300",    bg: "bg-teal-50 border-teal-200 dark:bg-teal-950/30 dark:border-teal-800",       icon: MailCheck,      iconBg: "bg-teal-100 dark:bg-teal-900/40" },
  note_added:          { label: "Note added",        color: "bg-amber-500",   textColor: "text-amber-700 dark:text-amber-300",   bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800",     icon: StickyNote,     iconBg: "bg-amber-100 dark:bg-amber-900/40" },
  // Tonomo system actions
  tonomo_booking_created:  { label: "Booking received",    color: "bg-violet-500",  textColor: "text-violet-700 dark:text-violet-300",  bg: "bg-violet-50 border-violet-200 dark:bg-violet-950/30 dark:border-violet-800",  icon: Zap,            iconBg: "bg-violet-100 dark:bg-violet-900/40" },
  tonomo_booking_updated:  { label: "Booking updated",     color: "bg-violet-400",  textColor: "text-violet-700 dark:text-violet-300",  bg: "bg-violet-50 border-violet-200 dark:bg-violet-950/30 dark:border-violet-800",  icon: Zap,            iconBg: "bg-violet-100 dark:bg-violet-900/40" },
  tonomo_rescheduled:      { label: "Rescheduled",         color: "bg-amber-500",   textColor: "text-amber-700 dark:text-amber-300",   bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800",    icon: Calendar,       iconBg: "bg-amber-100 dark:bg-amber-900/40" },
  tonomo_changed:          { label: "Booking changed",     color: "bg-orange-500",  textColor: "text-orange-700 dark:text-orange-300",  bg: "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800",  icon: RefreshCw,      iconBg: "bg-orange-100 dark:bg-orange-900/40" },
  tonomo_cancelled:        { label: "Cancellation",        color: "bg-red-500",     textColor: "text-red-700 dark:text-red-300",     bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",        icon: XOctagon,       iconBg: "bg-red-100 dark:bg-red-900/40" },
  tonomo_delivered:        { label: "Delivered",           color: "bg-teal-500",    textColor: "text-teal-700 dark:text-teal-300",    bg: "bg-teal-50 border-teal-200 dark:bg-teal-950/30 dark:border-teal-800",      icon: CheckCircle,    iconBg: "bg-teal-100 dark:bg-teal-900/40" },
  // System automation actions
  system_roles_applied:    { label: "Roles auto-assigned", color: "bg-cyan-500",    textColor: "text-cyan-700 dark:text-cyan-300",    bg: "bg-cyan-50 border-cyan-200 dark:bg-cyan-950/30 dark:border-cyan-800",      icon: UserCheck,      iconBg: "bg-cyan-100 dark:bg-cyan-900/40" },
  system_tasks_generated:  { label: "Tasks generated",     color: "bg-indigo-500",  textColor: "text-indigo-700 dark:text-indigo-300",  bg: "bg-indigo-50 border-indigo-200 dark:bg-indigo-950/30 dark:border-indigo-800",  icon: ClipboardList,  iconBg: "bg-indigo-100 dark:bg-indigo-900/40" },
  system_tasks_failed:     { label: "Tasks failed",        color: "bg-red-400",     textColor: "text-red-700 dark:text-red-300",     bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",        icon: AlertTriangle,  iconBg: "bg-red-100 dark:bg-red-900/40" },
  automation_rule_fired:   { label: "Automation",          color: "bg-purple-500",  textColor: "text-purple-700 dark:text-purple-300",  bg: "bg-purple-50 border-purple-200 dark:bg-purple-950/30 dark:border-purple-800",  icon: Bot,            iconBg: "bg-purple-100 dark:bg-purple-900/40" },
  // Task-level system changes
  task_auto_completed:     { label: "Task auto-completed", color: "bg-teal-500",    textColor: "text-teal-700 dark:text-teal-300",    bg: "bg-teal-50 border-teal-200 dark:bg-teal-950/30 dark:border-teal-800",      icon: CheckCircle,    iconBg: "bg-teal-100 dark:bg-teal-900/40" },
  task_effort_auto_logged: { label: "Effort auto-logged",  color: "bg-amber-500",   textColor: "text-amber-700 dark:text-amber-300",   bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800",    icon: Timer,          iconBg: "bg-amber-100 dark:bg-amber-900/40" },
  task_owner_changed:      { label: "Task owner changed",  color: "bg-sky-500",     textColor: "text-sky-700 dark:text-sky-300",     bg: "bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800",        icon: UserCog,        iconBg: "bg-sky-100 dark:bg-sky-900/40" },
  task_due_date_changed:   { label: "Due dates recalculated", color: "bg-blue-500", textColor: "text-blue-700 dark:text-blue-300",    bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800",      icon: Calendar,       iconBg: "bg-blue-100 dark:bg-blue-900/40" },
  task_auto_archived:      { label: "Tasks auto-archived", color: "bg-slate-500",   textColor: "text-slate-700 dark:text-slate-300",   bg: "bg-slate-50 border-slate-200 dark:bg-slate-800/60 dark:border-slate-700",    icon: Archive,        iconBg: "bg-slate-100 dark:bg-slate-800/60" },
  // Property re-engagement signals
  pulse_relisting_detected: { label: "Re-listing detected", color: "bg-emerald-500", textColor: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800", icon: Home,         iconBg: "bg-emerald-100 dark:bg-emerald-900/40" },
};

// Fields to completely ignore in delta display
const IGNORED_FIELDS = new Set([
  "updated_date", "created_date", "is_sample", "created_by", "id",
  "price_matrix_snapshot", "last_status_change"
]);

// Field display labels
const FIELD_LABELS = {
  status: "Status",
  outcome: "Outcome",
  payment_status: "Payment",
  pricing_tier: "Pricing tier",
  priority: "Priority",
  title: "Title",
  property_address: "Address",
  shoot_date: "Shoot date",
  shoot_time: "Shoot time",
  delivery_date: "Delivery date",
  delivery_link: "Delivery link",
  notes: "Notes",
  price: "Price",
  calculated_price: "Calculated price",
  products: "Products",
  packages: "Packages",
  agent_id: "Agent",
  client_name: "Client",
  property_type: "Property type",
};

function formatValue(field, value) {
  if (!value && value !== 0) return null;
  if (field === "price" || field === "calculated_price") {
    const num = parseFloat(value);
    return isNaN(num) ? value : `$${num.toFixed(2)}`;
  }
  if (field === "shoot_date" || field === "delivery_date") {
    return fmtDate(value, 'MMM d, yyyy');
  }
  return String(value).length > 60 ? String(value).slice(0, 60) + "…" : String(value);
}

function parseProductDelta(oldVal, newVal) {
  try {
    const oldArr = typeof oldVal === "string" ? JSON.parse(oldVal || "[]") : (oldVal || []);
    const newArr = typeof newVal === "string" ? JSON.parse(newVal || "[]") : (newVal || []);
    const idKey = "product_id";
    const nameKey = "product_name";

    const added = newArr.filter(n => !oldArr.find(o => o[idKey] === n[idKey]));
    const removed = oldArr.filter(o => !newArr.find(n => n[idKey] === o[idKey]));
    const qtyChanged = newArr.filter(n => {
      const old = oldArr.find(o => o[idKey] === n[idKey]);
      return old && old.quantity !== n.quantity;
    }).map(n => ({ ...n, oldQty: oldArr.find(o => o[idKey] === n[idKey])?.quantity }));

    return { added, removed, qtyChanged, nameKey };
  } catch { return null; }
}

function parsePackageDelta(oldVal, newVal) {
  try {
    const oldArr = typeof oldVal === "string" ? JSON.parse(oldVal || "[]") : (oldVal || []);
    const newArr = typeof newVal === "string" ? JSON.parse(newVal || "[]") : (newVal || []);
    const idKey = "package_id";
    const nameKey = "package_name";

    const added = newArr.filter(n => !oldArr.find(o => o[idKey] === n[idKey]));
    const removed = oldArr.filter(o => !newArr.find(n => n[idKey] === o[idKey]));
    const qtyChanged = newArr.filter(n => {
      const old = oldArr.find(o => o[idKey] === n[idKey]);
      return old && old.quantity !== n.quantity;
    }).map(n => ({ ...n, oldQty: oldArr.find(o => o[idKey] === n[idKey])?.quantity }));

    return { added, removed, qtyChanged, nameKey };
  } catch { return null; }
}

function DeltaChip({ label, oldVal, newVal, type = "change" }) {
  if (type === "added") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs font-medium border border-emerald-200 dark:border-emerald-800">
      <Plus className="h-2.5 w-2.5" /> {label}
    </span>
  );
  if (type === "removed") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 text-xs font-medium border border-red-200 dark:border-red-800 line-through opacity-70">
      {label}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground line-through">{oldVal}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium text-foreground">{newVal}</span>
    </span>
  );
}

function renderDeltaRows(changedFields) {
  const rows = [];

  for (const change of changedFields) {
    if (IGNORED_FIELDS.has(change.field)) continue;

    const label = FIELD_LABELS[change.field] || (change.field || '').replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    if (change.field === "products") {
      const delta = parseProductDelta(change.old_value, change.new_value);
      if (!delta) continue;
      const { added, removed, qtyChanged, nameKey } = delta;
      if (added.length === 0 && removed.length === 0 && qtyChanged.length === 0) continue;

      rows.push(
        <div key={change.field} className="flex flex-wrap items-start gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground mr-1 mt-0.5">Products:</span>
          {added.map((p, i) => <DeltaChip key={`a${i}`} label={p[nameKey] || "Unknown"} type="added" />)}
          {removed.map((p, i) => <DeltaChip key={`r${i}`} label={p[nameKey] || "Unknown"} type="removed" />)}
          {qtyChanged.map((p, i) => (
            <span key={`q${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 text-xs font-medium border border-blue-200 dark:border-blue-800">
              {p[nameKey]}: <span className="line-through opacity-60">{p.oldQty}</span><ArrowRight className="h-2.5 w-2.5" />{p.quantity}
            </span>
          ))}
        </div>
      );
      continue;
    }

    if (change.field === "packages") {
      const delta = parsePackageDelta(change.old_value, change.new_value);
      if (!delta) continue;
      const { added, removed, qtyChanged, nameKey } = delta;
      if (added.length === 0 && removed.length === 0 && qtyChanged.length === 0) continue;

      rows.push(
        <div key={change.field} className="flex flex-wrap items-start gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground mr-1 mt-0.5">Packages:</span>
          {added.map((p, i) => <DeltaChip key={`a${i}`} label={p[nameKey] || "Unknown"} type="added" />)}
          {removed.map((p, i) => <DeltaChip key={`r${i}`} label={p[nameKey] || "Unknown"} type="removed" />)}
          {qtyChanged.map((p, i) => (
            <span key={`q${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 text-xs font-medium border border-blue-200 dark:border-blue-800">
              {p[nameKey]}: <span className="line-through opacity-60">{p.oldQty}</span><ArrowRight className="h-2.5 w-2.5" />{p.quantity}
            </span>
          ))}
        </div>
      );
      continue;
    }

    // Skip fields whose values look like raw JSON
    const isJson = (v) => v && (v.trim().startsWith("{") || v.trim().startsWith("["));
    if (isJson(change.old_value) || isJson(change.new_value)) continue;

    const oldFmt = formatValue(change.field, change.old_value);
    const newFmt = formatValue(change.field, change.new_value);
    if (!oldFmt && !newFmt) continue;

    rows.push(
      <div key={change.field} className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-muted-foreground min-w-[80px]">{label}:</span>
        <DeltaChip oldVal={oldFmt} newVal={newFmt} type="change" />
      </div>
    );
  }

  return rows;
}

export default function ActivityLogItem({ activity }) {
  const config = ACTION_CONFIG[activity.action] || ACTION_CONFIG.update;
  const deltaRows = activity.changed_fields?.length > 0 ? renderDeltaRows(activity.changed_fields) : [];
  const hasDeltas = deltaRows.length > 0;

  // For creates/deletes, show a simple summary line
  const isSimple = activity.action === "create" || activity.action === "delete" || !hasDeltas;

  const IconComponent = config.icon || Activity;

  return (
    <div className="flex gap-3 group">
      {/* Timeline icon */}
      <div className="flex flex-col items-center flex-shrink-0">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${config.iconBg || 'bg-muted'}`}>
          <IconComponent className={`h-3.5 w-3.5 ${config.textColor}`} />
        </div>
        <div className="w-px flex-1 bg-border mt-1" />
      </div>

      {/* Content */}
      <div className="pb-5 flex-1 min-w-0">
         <div className="flex items-center gap-2 mb-1 flex-wrap">
           {/* Actor badge — clearly distinguishes human vs system */}
           <span className="flex items-center gap-1">
             {activity.actor_type === 'tonomo' && (
               <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 border border-violet-200 dark:border-violet-800">
                 ⚡ Tonomo
               </span>
             )}
             {activity.actor_type === 'system' && (
               <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                 ⚙ System
               </span>
             )}
             {activity.actor_type === 'automation' && (
               <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                 🤖 Automation
                 {activity.automation_rule_name && (
                   <span className="font-normal opacity-80">· {activity.automation_rule_name}</span>
                 )}
               </span>
             )}
             {(!activity.actor_type || activity.actor_type === 'human') && (
               <span className="text-xs font-semibold text-foreground">
                 {activity.user_name || 'Unknown'}
               </span>
             )}
           </span>
           <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${config.bg} ${config.textColor} border`}>
             {config.label}
           </span>
           {/* Show Tonomo order ID as a subtle reference */}
           {activity.tonomo_order_id && (
             <span className="text-xs text-muted-foreground font-mono opacity-60">
               #{activity.tonomo_order_id.slice(0, 8)}
             </span>
           )}
           <span className="text-xs text-muted-foreground ml-auto" title={activity.created_date ? new Date(fixTimestamp(activity.created_date)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : ""}>
              {activity.created_date ? new Date(fixTimestamp(activity.created_date)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : ""}
            </span>
         </div>

        {isSimple ? (
          <p className="text-xs text-muted-foreground">{activity.description || config.label}</p>
        ) : (
          <div className="space-y-1.5 mt-1.5 pl-1 border-l-2 border-muted ml-1">
            {deltaRows.map((row, i) => (
              <div key={i} className="pl-2">{row}</div>
            ))}
          </div>
        )}

        {/* Show metadata for system/tonomo actions */}
        {activity.actor_type === 'tonomo' && activity.metadata && (() => {
          try {
            const meta = typeof activity.metadata === 'string'
              ? JSON.parse(activity.metadata)
              : activity.metadata;
            const gaps = [...(meta.mapping_gaps || []), ...(meta.product_gaps || [])];
            const confidence = meta.mapping_confidence;
            return (
              <div className="mt-1.5 space-y-1">
                {confidence && confidence !== 'full' && (
                  <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border ${
                    confidence === 'partial'
                      ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800'
                      : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800'
                  }`}>
                    Mapping confidence: {confidence}
                  </span>
                )}
                {gaps.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Unresolved: {gaps.join(', ')}
                  </p>
                )}
              </div>
            );
          } catch { return null; }
        })()}
        </div>
    </div>
  );
}