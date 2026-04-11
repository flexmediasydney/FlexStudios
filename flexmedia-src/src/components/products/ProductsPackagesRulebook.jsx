import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  BookOpen, Package, Box, Layers, ToggleLeft, Info, ChevronDown, ChevronRight,
  Search, Zap, CheckCircle2, AlertTriangle, Lock, ArrowRight, Clock,
  Camera, History, Tag, DollarSign, ShieldAlert, Trash2, Eye, GitBranch
} from "lucide-react";

const sections = [
  {
    id: "structure",
    title: "Product Structure",
    icon: Box,
    color: "text-blue-600",
    bg: "bg-blue-50",
    border: "border-blue-200",
    headerBg: "bg-blue-50/60",
    summary: "Products are the atomic service units. Each has two tiers and two pricing types.",
    rules: [
      {
        type: "info",
        icon: Layers,
        label: "Two Tiers: Standard & Premium",
        desc: "Every product has two independent pricing tiers — Standard and Premium. Each tier has its own base price, unit price, and time estimates (on-site, admin, editor). The tier is selected at project creation time."
      },
      {
        type: "info",
        icon: DollarSign,
        label: "Fixed vs Per-Unit Pricing",
        desc: "Products can be Fixed (one flat price regardless of quantity) or Per-Unit (a base price + a unit price multiplied by quantity beyond 1). The minimum quantity is configurable per product."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Minimum Quantity",
        desc: "Each product can define a minimum quantity that cannot be reduced below. This ensures the quantity field in project booking always starts at the minimum and can only go up."
      },
      {
        type: "info",
        icon: Tag,
        label: "Core vs Add-on Type",
        desc: "Products are classified as either 'Core' (primary services e.g. Photography) or 'Add-on' (upsells e.g. Twilight Edit). This classification is for display and filtering purposes only — it does not affect pricing calculation."
      },
      {
        type: "info",
        icon: Layers,
        label: "Category",
        desc: "Each product belongs to a category: Photography, Video, Drone, Editing, Virtual Staging, or Other. Categories group products for display and filtering in the booking UI."
      },
      {
        type: "info",
        icon: Clock,
        label: "Time Estimates",
        desc: "Each tier stores on-site time, on-site time increment (per unit), admin time, and editor time in minutes. These are used for scheduling and internal time planning — they don't affect pricing."
      },
      {
        type: "rule",
        icon: Info,
        label: "Dusk Only Flag",
        desc: "A product can be marked as 'Dusk Only', indicating it is only available at dusk shoots. This is a display flag for bookings — it does not restrict or change pricing."
      }
    ]
  },
  {
    id: "packages",
    title: "Package Structure",
    icon: Package,
    color: "text-purple-600",
    bg: "bg-purple-50",
    border: "border-purple-200",
    headerBg: "bg-purple-50/60",
    summary: "Packages bundle products together at a flat price per tier.",
    rules: [
      {
        type: "info",
        icon: Package,
        label: "Package = Bundle of Products",
        desc: "A package is a curated collection of products sold together. It stores references to each included product with a default quantity. The package has its own flat pricing independent of the individual product prices."
      },
      {
        type: "info",
        icon: DollarSign,
        label: "Flat Price per Tier",
        desc: "Packages use a single flat price per tier (Standard Price and Premium Price). There is no per-unit pricing for packages — the package price covers all included products as a bundle."
      },
      {
        type: "rule",
        icon: Clock,
        label: "Time Estimates on Packages",
        desc: "Packages also store scheduling time, admin time, and editor time per tier. These represent the combined effort for the full bundle and are used for internal scheduling."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Products Must Exist",
        desc: "A package references products by ID. If a product referenced by a package is deleted or deactivated, that product entry remains in the package definition but the product won't be active in bookings. Review and update packages whenever products are removed."
      },
      {
        type: "rule",
        icon: Layers,
        label: "Package-Level & Product-Level Task Templates",
        desc: "Packages can define their own task templates (Standard and Premium tiers). When a package is booked on a project, tasks are auto-generated from BOTH the package's templates AND the templates of each product the package contains. This ensures all workflow steps are covered."
      }
    ]
  },
  {
    id: "active",
    title: "Active / Inactive Status",
    icon: ToggleLeft,
    color: "text-green-600",
    bg: "bg-green-50",
    border: "border-green-200",
    headerBg: "bg-green-50/60",
    summary: "Deactivated products/packages are hidden from bookings but data is preserved.",
    rules: [
      {
        type: "rule",
        icon: Eye,
        label: "Soft Visibility Toggle",
        desc: "Setting is_active = false hides a product or package from project booking and from price matrix calculations. The record is NOT deleted — all historical data and audit logs are preserved."
      },
      {
        type: "constraint",
        icon: ShieldAlert,
        label: "Inactive Products Excluded from Pricing Engine",
        desc: "The calculateProjectPricing backend function filters out inactive products (is_active = false) before computing totals. Inactive items are silently skipped and never contribute to project pricing."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Re-activation is Non-Destructive",
        desc: "Re-activating a product or package restores it to all booking UIs and pricing calculations. No data is lost — the full pricing history, audit log, and price matrix overrides remain intact."
      },
      {
        type: "info",
        icon: Info,
        label: "Price Matrix Behaviour",
        desc: "Inactive products and packages are automatically hidden from the Price Matrix editor. Any previously configured overrides are preserved in the database and restored if the item is re-activated."
      }
    ]
  },
  {
    id: "pricing_master",
    title: "Master Pricing",
    icon: DollarSign,
    color: "text-amber-600",
    bg: "bg-amber-50",
    border: "border-amber-200",
    headerBg: "bg-amber-50/60",
    summary: "Master prices are the default source of truth. Price matrices build on top of them.",
    rules: [
      {
        type: "rule",
        icon: ArrowRight,
        label: "Master as the Baseline",
        desc: "The Standard and Premium prices set on each product and package here are the system-wide default prices. Every agency and agent without a custom price matrix uses these values directly."
      },
      {
        type: "constraint",
        icon: Lock,
        label: "Price Changes Are Forward-Only",
        desc: "Changing a master price only affects future project bookings. Any existing project that has already been created with locked-in pricing is unaffected — prices are frozen at project creation time."
      },
      {
        type: "rule",
        icon: Zap,
        label: "Price Matrix Drift Detection",
        desc: "If you change a master price after a Price Matrix override was set against it, the Price Matrix editor will display a drift indicator ('was $X') to alert admins that the master has moved since the override was established."
      },
      {
        type: "info",
        icon: CheckCircle2,
        label: "Blanket Discounts Applied to Master",
        desc: "When an agency or agent uses blanket discount pricing, the discount % is applied to these master prices at calculation time. The discounted values are never stored — they are computed live from master prices each time."
      }
    ]
  },
  {
    id: "notifications_tasks",
    title: "Notifications & Task Templates",
    icon: Zap,
    color: "text-indigo-600",
    bg: "bg-indigo-50",
    border: "border-indigo-200",
    headerBg: "bg-indigo-50/60",
    summary: "Products can trigger email notifications and auto-generate tasks when booked.",
    rules: [
      {
        type: "rule",
        icon: Info,
        label: "Notification Emails",
        desc: "Each product can specify a list of email addresses to notify when that product is included in a booking. This is useful for alerting specific team members (e.g. a drone operator) when their service is booked."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Task Templates",
        desc: "Products can define a list of task templates that are automatically created as project tasks when the product is booked. Each template includes a title, description, and whether to auto-assign. This automates the workflow setup for each booking."
      },
      {
        type: "info",
        icon: Layers,
        label: "Photographer Checklist",
        desc: "Products support a photographer checklist — a list of checklist items displayed to the photographer during the shoot. These are informational only and do not create tasks."
      }
    ]
  },
  {
    id: "delete",
    title: "Deleting Products & Packages",
    icon: Trash2,
    color: "text-red-600",
    bg: "bg-red-50",
    border: "border-red-200",
    headerBg: "bg-red-50/60",
    summary: "Deletion is permanent. Use deactivation instead for safety.",
    rules: [
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Deletion is Permanent",
        desc: "Deleting a product or package permanently removes it from the database. This action cannot be undone. All associated price matrix overrides for that item become orphaned but remain in the database (no longer displayed)."
      },
      {
        type: "constraint",
        icon: Lock,
        label: "Impact on Existing Projects",
        desc: "Deleting a product does NOT modify historical project records — those projects retain their locked-in pricing snapshot. However, the deleted product will no longer appear or be selectable in new bookings."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Prefer Deactivation Over Deletion",
        desc: "The recommended approach is to set is_active = false (deactivate) rather than permanently deleting. This preserves all audit history, keeps price matrix overrides intact, and allows re-activation later."
      },
      {
        type: "audit",
        icon: History,
        label: "Delete is Audited",
        desc: "Every deletion triggers an audit log entry recording who deleted it, when, and the full previous state of the record for traceability."
      }
    ]
  },
  {
    id: "audit_snapshots",
    title: "Activity Log & Snapshots",
    icon: History,
    color: "text-slate-600",
    bg: "bg-slate-50",
    border: "border-slate-200",
    headerBg: "bg-slate-50/60",
    summary: "Every change is logged. Monthly snapshots capture the full catalogue state.",
    rules: [
      {
        type: "audit",
        icon: CheckCircle2,
        label: "Activity Log",
        desc: "Every create, update, and delete action on a product or package is logged with: who made the change, when, a human-readable summary, and a field-by-field diff showing old → new values."
      },
      {
        type: "audit",
        icon: Camera,
        label: "Monthly Auto-Snapshots",
        desc: "On the 1st of each month, a full snapshot of all Product records is automatically saved to ProductSnapshot, and all Package records to PackageSnapshot. These snapshots capture the complete state of the catalogue at that point in time."
      },
      {
        type: "audit",
        icon: Zap,
        label: "Manual Snapshots",
        desc: "Admins can trigger a manual snapshot at any time from the Snapshots tab. Manual snapshots are labelled with the date and the name of the user who triggered them."
      },
      {
        type: "info",
        icon: Info,
        label: "Snapshots Are Read-Only",
        desc: "Snapshot records cannot be edited or deleted. They serve purely as a historical archive of the catalogue state at specific points in time."
      }
    ]
  },
  {
    id: "revisions_integration",
    title: "Revisions — Template-Based Task Generation",
    icon: GitBranch,
    color: "text-indigo-600",
    bg: "bg-indigo-50",
    border: "border-indigo-200",
    headerBg: "bg-indigo-50/60",
    summary: "Revision templates define workflows that auto-generate tasks with dependencies and deadline triggers.",
    rules: [
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Revision Templates by Kind & Type",
        desc: "RevisionTemplates are filtered by request_kind (revision/change_request) and revision_type (images/drones/floorplan/video). Only applicable templates appear when creating a revision of a specific kind/type."
      },
      {
        type: "rule",
        icon: Package,
        label: "Task Templates in Revision Templates",
        desc: "Each RevisionTemplate contains task_templates array. Each template specifies: title, description, task_type (onsite/back_office), auto_assign_role, estimated_minutes, and deadline triggers (timer_trigger, deadline_type, preset/hours_after_trigger)."
      },
      {
        type: "rule",
        icon: Zap,
        label: "Deadline Trigger Types",
        desc: "Revision task templates support four trigger types: none (manual deadline), project_onsite (shoot date), project_uploaded (content upload), project_submitted (submission), dependencies_cleared (all dependencies complete). Timer automatically calculates due_date when trigger event occurs."
      },
      {
        type: "info",
        icon: Info,
        label: "Deadline Presets with Timezone",
        desc: "For triggered deadlines, templates support preset options (e.g. 'tomorrow_night', 'next_business_night') or custom hours_after_trigger. Presets use timezone-aware calculation (Australia/Sydney) with business day logic."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Task Dependencies in Templates",
        desc: "Task templates can declare depends_on_indices (array of sibling task indices). These are automatically wired when tasks are auto-generated, creating multi-step revision workflows automatically."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Auto-Assignment from Project Roles",
        desc: "Task templates specify auto_assign_role. When generated, the system resolves the matching project staff (photographer, editor, etc.) and assigns tasks automatically. Falls back to project_owner if the designated role is unassigned."
      }
    ]
  },
  {
    id: "rbac",
    title: "Access Control",
    icon: ShieldAlert,
    color: "text-orange-600",
    bg: "bg-orange-50",
    border: "border-orange-200",
    headerBg: "bg-orange-50/60",
    summary: "Only admins and staff can manage products and packages.",
    rules: [
      {
        type: "constraint",
        icon: Lock,
        label: "Admin & Staff Access Only",
        desc: "The Products & Packages settings page is restricted to users with the 'master_admin' or 'employee' role."
      },
      {
        type: "constraint",
        icon: Lock,
        label: "Master Admin Can Delete",
        desc: "Permanent deletion requires appropriate permissions. The double-confirmation delete dialog requires an explicit confirmation before any record is removed."
      }
    ]
  }
];

const typeConfig = {
  info:       { label: "Info",        className: "bg-blue-100 text-blue-700 border-blue-200" },
  rule:       { label: "Rule",        className: "bg-green-100 text-green-700 border-green-200" },
  constraint: { label: "Constraint",  className: "bg-red-100 text-red-700 border-red-200" },
  audit:      { label: "Audit",       className: "bg-teal-100 text-teal-700 border-teal-200" },
};

function RuleSection({ section, defaultOpen = false, searchQuery = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = section.icon;

  const filteredRules = section.rules.filter(rule =>
    !searchQuery ||
    rule.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rule.desc.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const shouldShow = !searchQuery || filteredRules.length > 0;
  if (!shouldShow) return null;

  const isOpen = open || (searchQuery && filteredRules.length > 0);

  return (
    <Card className={`border ${section.border} overflow-hidden`}>
      <button
        className={`w-full text-left px-5 py-4 flex items-center justify-between gap-3 hover:bg-muted/20 transition-colors ${section.headerBg}`}
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg ${section.bg} flex items-center justify-center flex-shrink-0`}>
            <Icon className={`h-4.5 w-4.5 ${section.color}`} />
          </div>
          <div className="text-left">
            <div className="font-semibold text-sm">{section.title}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{section.summary}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge variant="outline" className="text-xs hidden sm:flex">
            {filteredRules.length} rule{filteredRules.length !== 1 ? "s" : ""}
          </Badge>
          {isOpen
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />
          }
        </div>
      </button>

      {isOpen && (
        <CardContent className="p-0">
          <div className="border-t divide-y">
            {filteredRules.map((rule, idx) => {
              const cfg = typeConfig[rule.type] || typeConfig.info;
              const RuleIcon = rule.icon;
              return (
                <div key={idx} className="flex items-start gap-4 p-4 hover:bg-muted/10 transition-colors">
                  <div className={`w-8 h-8 rounded-lg ${section.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                    <RuleIcon className={`h-4 w-4 ${section.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold text-sm">{rule.label}</span>
                      <Badge variant="outline" className={`text-xs ${cfg.className}`}>
                        {cfg.label}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{rule.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default function ProductsPackagesRulebook() {
  const [searchQuery, setSearchQuery] = useState("");
  const totalRules = sections.reduce((sum, s) => sum + s.rules.length, 0);

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-xl">
        <BookOpen className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-primary">Products & Packages Rulebook</h3>
            <Badge variant="outline" className="text-xs">{sections.length} sections · {totalRules} rules</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Complete reference for how products and packages are structured, priced, audited, and managed.
          </p>
        </div>
      </div>

      {/* Quick Reference */}
      <Card className="border-2 border-dashed">
        <CardHeader className="pb-2 pt-4 px-5">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            Quick Reference
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
              <div className="font-semibold text-blue-800 mb-1 flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" /> Pricing
              </div>
              <div className="text-blue-700 space-y-0.5">
                <div>Fixed or Per-Unit</div>
                <div>Standard & Premium tiers</div>
                <div>Master = baseline</div>
              </div>
            </div>
            <div className="p-3 bg-green-50 rounded-lg border border-green-100">
              <div className="font-semibold text-green-800 mb-1 flex items-center gap-1.5">
                <ToggleLeft className="h-3.5 w-3.5" /> Visibility
              </div>
              <div className="text-green-700 space-y-0.5">
                <div>Active = visible in bookings</div>
                <div>Inactive = hidden, not deleted</div>
                <div>Re-activate any time</div>
              </div>
            </div>
            <div className="p-3 bg-red-50 rounded-lg border border-red-100">
              <div className="font-semibold text-red-800 mb-1 flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" /> Changes
              </div>
              <div className="text-red-700 space-y-0.5">
                <div>Forward-only pricing</div>
                <div>All changes audited</div>
                <div>Monthly snapshots auto-saved</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search rules..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Sections */}
      <div className="space-y-3">
        {sections.map((section, idx) => (
          <RuleSection
            key={section.id}
            section={section}
            defaultOpen={idx === 0}
            searchQuery={searchQuery}
          />
        ))}
      </div>
    </div>
  );
}