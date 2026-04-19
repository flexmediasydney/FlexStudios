import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  BookOpen, Building, User, Percent, GitBranch, ShieldAlert,
  Clock, Layers, ToggleLeft, Info, ChevronDown, ChevronRight,
  Search, Zap, CheckCircle2, AlertTriangle, Lock, ArrowRight, TrendingUp, AlertCircle, RefreshCw, DollarSign,
  Crown, Sparkles,
} from "lucide-react";

const sections = [
  {
    id: "hierarchy",
    title: "Entity Hierarchy",
    icon: GitBranch,
    color: "text-blue-600",
    bg: "bg-blue-50",
    border: "border-blue-200",
    headerBg: "bg-blue-50/60",
    summary: "Agent → Agency → Default. Most specific wins.",
    rules: [
      {
        type: "info",
        icon: Building,
        label: "Agency Level",
        desc: "A price matrix for an agency applies to ALL agents belonging to that agency, unless the agent has their own matrix."
      },
      {
        type: "info",
        icon: User,
        label: "Agent Level",
        desc: "Agent-level matrices take priority over agency-level matrices. If an agent has their own matrix, it is used exclusively — the agency matrix is ignored."
      },
      {
        type: "priority",
        icon: ArrowRight,
        label: "Priority Order",
        desc: "Agent Matrix → Agency Matrix → Default (Master) Pricing. The most specific setting always wins. If no matrix exists for the agent or their agency, master pricing applies."
      }
    ]
  },
  {
    id: "modes",
    title: "Pricing Modes",
    icon: Layers,
    color: "text-purple-600",
    bg: "bg-purple-50",
    border: "border-purple-200",
    headerBg: "bg-purple-50/60",
    summary: "Three modes: Default, Blanket Discount, or Per-Item Overrides.",
    rules: [
      {
        type: "default",
        icon: CheckCircle2,
        label: "Default Pricing (Use Default = ON)",
        desc: "The entity uses the master prices defined on each Product and Package. No discounts or overrides of any kind apply. This is the simplest mode."
      },
      {
        type: "blanket",
        icon: Percent,
        label: "Blanket Discount (Use Default = OFF, Blanket = ON)",
        desc: "A single percentage discount applied uniformly to all products and/or packages. Product and package discount rates are independent. Per-item overrides are disabled while blanket is active."
      },
      {
        type: "custom",
        icon: ToggleLeft,
        label: "Per-Item Overrides (Use Default = OFF, Blanket = OFF)",
        desc: "Each product or package can have its own custom price. Only items with 'Override' toggled ON use custom prices — all others fall back to master pricing."
      }
    ]
  },
  {
    id: "blanket",
    title: "Blanket Discount Rules",
    icon: Percent,
    color: "text-amber-600",
    bg: "bg-amber-50",
    border: "border-amber-200",
    headerBg: "bg-amber-50/60",
    summary: "Product % and Package % are independent, always applied to master prices.",
    rules: [
      {
        type: "rule",
        icon: Zap,
        label: "Two Independent Rates",
        desc: "Product discount % and Package discount % are separate fields. You can give 10% off products and 5% off packages simultaneously, or any combination."
      },
      {
        type: "rule",
        icon: Info,
        label: "Applied to Master Prices",
        desc: "Discounts are calculated from the master product/package prices at booking time, not from previously set override values."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Overrides Disabled While Active",
        desc: "Enabling blanket discount disables all per-item overrides. Toggling blanket off restores access to item-level overrides — existing override data is preserved and not lost."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Valid Range: 0–100%",
        desc: "Discount percentages are clamped to 0–100 on blur. Entering values outside this range auto-corrects on focus loss."
      }
    ]
  },
  {
    id: "overrides",
    title: "Per-Item Override Rules",
    icon: ToggleLeft,
    color: "text-green-600",
    bg: "bg-green-50",
    border: "border-green-200",
    headerBg: "bg-green-50/60",
    summary: "Each product/package can be independently overridden. Pre-filled from master.",
    rules: [
      {
        type: "rule",
        icon: Zap,
        label: "Pre-Filled from Master on Enable",
        desc: "When you toggle ON the override for a product or package, all price fields are automatically pre-populated with the current master prices as a starting point."
      },
      {
        type: "rule",
        icon: Info,
        label: "Four Fields per Product",
        desc: "Products support four override fields: Standard Base Price, Standard Unit Price, Premium Base Price, and Premium Unit Price. Each is independent."
      },
      {
        type: "rule",
        icon: Info,
        label: "Two Fields per Package",
        desc: "Packages use flat pricing: Standard Price and Premium Price. No unit-based pricing applies to packages."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Independent per Item",
        desc: "Each product/package toggle is independent. You can override only specific products while letting all others fall back to master pricing."
      }
    ]
  },
  {
    id: "catalogue",
    title: "Catalogue Changes & Inheritance",
    icon: Layers,
    color: "text-orange-600",
    bg: "bg-orange-50",
    border: "border-orange-200",
    headerBg: "bg-orange-50/60",
    summary: "New products/packages auto-inherit pricing based on the active mode.",
    rules: [
      {
        type: "rule",
        icon: Zap,
        label: "Automatic Detection",
        desc: "When a new product or package is added to the master catalogue, every price matrix editor automatically detects it via real-time subscription. A banner and orange 'New' badge highlight the newly added items so admins are immediately aware."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Default Mode — Seamless Inheritance",
        desc: "If the matrix is in Default Pricing mode (Use Default = ON), new products and packages are automatically included at master prices. No action is required — the matrix stays fully in sync with the catalogue."
      },
      {
        type: "rule",
        icon: Percent,
        label: "Blanket Discount Mode — Auto-Included",
        desc: "If the matrix uses a blanket discount, new products and packages are automatically covered by the existing discount percentage. No override entries are needed — the blanket % applies to all master prices including newly added items."
      },
      {
        type: "rule",
        icon: ToggleLeft,
        label: "Per-Item Override Mode — Inherit Master Prices",
        desc: "If the matrix is in per-item override mode, new items appear in the editor pre-populated with the master product/package prices as their starting values. Override is OFF by default, so they fall back to master pricing. Admins can choose to enable an override and adjust prices independently."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "No Automatic Save on Catalogue Change",
        desc: "Detecting a new catalogue item does NOT auto-save the matrix. The new item is shown locally and inherits the correct values for review. An admin must explicitly save if they want to persist any override for the new item."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Deleted Products/Packages",
        desc: "If a product or package is removed (deactivated) from the catalogue, it disappears from the price matrix editor immediately. Any previously stored override data for that item is preserved in the database but is no longer shown or applied."
      }
    ]
  },
  {
    id: "integrity",
    title: "Data Integrity & RBAC",
    icon: ShieldAlert,
    color: "text-indigo-600",
    bg: "bg-indigo-50",
    border: "border-indigo-200",
    headerBg: "bg-indigo-50/60",
    summary: "Edit access restricted to admins. Names auto-sync. Prices validated before save.",
    rules: [
      {
        type: "constraint",
        icon: Lock,
        label: "Admin-Only Editing",
        desc: "Only users with the 'admin' or 'master_admin' role can modify price matrices. Non-admin users see a 'Read Only' badge and all inputs are disabled."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Cached Name Auto-Sync",
        desc: "When saving, the system automatically updates cached product_name and package_name fields in the matrix to match the current master names. This ensures display consistency even if a product or package is renamed after the matrix was created."
      },
      {
        type: "rule",
        icon: Zap,
        label: "Server-Side Price Validation",
        desc: "All numeric pricing values are validated and clamped before saving, both client-side and server-side. Negative prices are floored to 0. Discount percentages are clamped to 0–100. This prevents data corruption from any client-side bypass."
      },
      {
        type: "rule",
        icon: Info,
        label: "Master Price Drift Indicator",
        desc: "When an override is enabled, the master price at that moment is captured as a snapshot. If the master price later changes, a 'was $X' drift indicator appears next to the current master price, alerting admins that the master has moved since the override was set."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Soft Delete Guard",
        desc: "The calculateProjectPricing engine filters out inactive products and packages (is_active = false) before computing prices. Deactivated items are silently skipped so they never contribute to project totals."
      }
    ]
  },
  {
    id: "revisions_lifecycle",
    title: "Revisions — Complete Lifecycle",
    icon: RefreshCw,
    color: "text-violet-600",
    bg: "bg-violet-50",
    border: "border-violet-200",
    headerBg: "bg-violet-50/60",
    summary: "Six-state workflow: identified → in_progress → completed → delivered or stuck/cancelled.",
    rules: [
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Six Status States",
        desc: "Revisions have six states: identified (initial), in_progress (work started), completed (all tasks done), delivered (client notified), stuck (paused), cancelled (soft-deleted). Each state has specific allowed transitions and behaviours."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Minimum One Task Required",
        desc: "A revision cannot be created without at least one associated task. The system rejects creation if zero tasks exist. Users must provide either template-generated or manually-added tasks before saving."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Completion Requires All Tasks Done",
        desc: "A revision can only transition to 'completed' if all non-deleted tasks have is_completed=true. The system prevents early completion and displays an error listing incomplete tasks."
      },
      {
        type: "rule",
        icon: Clock,
        label: "Stuck State — Pause & Resume",
        desc: "When marked 'stuck', all running timers on the revision's tasks are paused (is_locked=true prevents effort logging). The previous_status field stores the pre-stuck state. Clicking 'Resolve Stuck' returns to previous_status and unlocks timers via handleRevisionStuckStatus backend function."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Cancellation Atomically Cleans Up",
        desc: "Cancelling a revision atomically soft-deletes all tasks (is_deleted=true), stops running timers, and logs the cancellation. Deleted tasks are hidden from lists but preserved for audit. handleRevisionCancellation backend function ensures atomic execution."
      },
      {
        type: "info",
        icon: Info,
        label: "Delivered vs Completed",
        desc: "Completed means all tasks are done. Delivered means the revision has been completed AND communicated to the client. Revisions can remain in completed state before transitioning to delivered."
      }
    ]
  },
  {
    id: "save",
    title: "Save & Audit Behaviour",
    icon: Clock,
    color: "text-slate-600",
    bg: "bg-slate-50",
    border: "border-slate-200",
    headerBg: "bg-slate-50/60",
    summary: "Unsaved changes are tracked locally. Every save is audited.",
    rules: [
      {
        type: "info",
        icon: Info,
        label: "Unsaved Changes Indicator",
        desc: "The Save and Reset buttons only appear when there are pending local changes. The header badge shows the current saved state — not unsaved edits."
      },
      {
        type: "info",
        icon: Clock,
        label: "Reset Button",
        desc: "Clicking Reset discards all unsaved local changes and reverts the editor to the last saved state from the database. This cannot be undone."
      },
      {
        type: "audit",
        icon: CheckCircle2,
        label: "Audit Log",
        desc: "Every save is recorded in the Activity Log tab with: who changed it, when, and a field-by-field diff showing old → new values."
      },
      {
        type: "audit",
        icon: CheckCircle2,
        label: "Monthly Auto-Snapshots",
        desc: "On the 1st of each month, a full snapshot of all price matrix records is automatically saved. Manual snapshots can be triggered anytime from the Snapshots tab."
      }
    ]
  },
  {
    id: "project",
    title: "Pricing at Project Creation",
    icon: ShieldAlert,
    color: "text-red-600",
    bg: "bg-red-50",
    border: "border-red-200",
    headerBg: "bg-red-50/60",
    summary: "Prices lock in at booking. Matrix changes don't affect existing projects.",
    rules: [
      {
        type: "constraint",
        icon: Lock,
        label: "Prices Lock at Booking",
        desc: "When a project is created, pricing is calculated and locked into the project record. Subsequent changes to the price matrix do NOT retroactively affect any existing projects."
      },
      {
        type: "constraint",
        icon: Lock,
        label: "Matrix Snapshot Stored on Project",
        desc: "A snapshot of the price matrix settings at project creation time is stored directly on the project record for full audit transparency."
      },
      {
        type: "info",
        icon: ArrowRight,
        label: "Resolution Order at Booking",
        desc: "When creating a project, the system checks: agent matrix → agency matrix → master pricing, in that order. The first match found is applied and locked in."
      }
    ]
  },
  {
    id: "revisions_pricing",
    title: "Revisions — Pricing Impact & Application",
    icon: RefreshCw,
    color: "text-indigo-600",
    bg: "bg-indigo-50",
    border: "border-indigo-200",
    headerBg: "bg-indigo-50/60",
    summary: "Revision pricing impacts are tracked and applied on completion, triggering project recalculation.",
    rules: [
      {
        type: "rule",
        icon: DollarSign,
        label: "Pricing Impact Declaration",
        desc: "When creating or editing a revision, admins can declare pricing_impact: products_added (array), products_removed (array), quantity_changes (array with product_id/old/new qty), and estimated_price_delta (the expected cost change). Impact is tracked but not applied until the revision is completed or delivered."
      },
      {
        type: "rule",
        icon: Zap,
        label: "Automatic Application on Completion",
        desc: "When a revision is marked 'completed' or 'delivered', any declared pricing_impact is automatically applied: products added/removed from the project, quantities adjusted, and the project pricing is recalculated through calculateProjectPricing. Applied status and timestamp are logged."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Manual 'Apply Now' Option",
        desc: "Admins can manually apply a revision's pricing impact before completion via an 'Apply Now' button. This triggers the same application logic and logs the action to ProjectActivity."
      },
      {
        type: "rule",
        icon: Info,
        label: "Pricing Engine Re-Runs on Application",
        desc: "After pricing impact is applied, the full calculateProjectPricing backend function is invoked to re-calculate the project total using the agent/agency/master matrix rules. The updated price_matrix_snapshot and calculated_price are persisted to the project."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Pricing Not Applied If Revision Rejected",
        desc: "If a revision is marked 'rejected' or 'cancelled' instead of completed, its pricing_impact is discarded and never applied. The project pricing remains at its previous state."
      }
    ]
  },
  {
    id: "projects_qty",
    title: "Projects — Quantity & Item Rules",
    icon: TrendingUp,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    headerBg: "bg-emerald-50/60",
    summary: "Product qtys can change post-creation. Packages are always qty 1. Pricing re-runs through the matrix engine.",
    rules: [
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Product Quantities Can Be Modified After Creation",
        desc: "Standalone products on an existing project can have their quantity changed at any time. The pricing table provides inline controls to increment or decrement quantity, subject to the product's min/max limits."
      },
      {
        type: "constraint",
        icon: Lock,
        label: "Package Quantity is Always 1",
        desc: "Packages cannot have their quantity changed. A package is always booked as a single unit (qty = 1). The qty field for packages is locked and not editable. To book multiple instances, add the package-included products individually as standalone products."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Minimum Quantity Cannot Be Breached",
        desc: "Product quantities cannot go below the minimum quantity defined in the Products & Packages engine (product.min_quantity). The UI controls and backend both enforce this floor."
      },
      {
        type: "constraint",
        icon: AlertTriangle,
        label: "Maximum Quantity Respected If Set",
        desc: "If a product has a max_quantity defined, product quantities cannot exceed that value. Both the UI stepper control and the backend calculateProjectPricing function clamp quantities to this ceiling."
      },
      {
        type: "rule",
        icon: Zap,
        label: "Pricing Re-runs Through Matrix Engine on Any Change",
        desc: "Any time a product quantity changes, the full calculateProjectPricing backend function runs, applying the correct agent/agency matrix rules (blanket discounts, per-item overrides, or master pricing). Line-level and total prices update in real time before saving."
      },
      {
        type: "rule",
        icon: CheckCircle2,
        label: "Double Confirmation Required Before Saving",
        desc: "After modifying quantities, a confirmation dialog displays the new matrix-adjusted total before any changes are committed to the database. This prevents accidental pricing updates."
      },
      {
        type: "info",
        icon: ArrowRight,
        label: "Prices Propagate Everywhere on Save",
        desc: "When quantity changes are saved, calculated_price and price are both updated on the project record. All views — Kanban cards, list table, project details — read from these fields and reflect the updated value immediately."
      }
    ]
  }
];

const typeConfig = {
  info:       { label: "Info",       className: "bg-blue-100 text-blue-700 border-blue-200" },
  rule:       { label: "Rule",       className: "bg-green-100 text-green-700 border-green-200" },
  constraint: { label: "Constraint", className: "bg-red-100 text-red-700 border-red-200" },
  priority:   { label: "Priority",   className: "bg-purple-100 text-purple-700 border-purple-200" },
  default:    { label: "Mode",       className: "bg-slate-100 text-slate-700 border-slate-200" },
  blanket:    { label: "Mode",       className: "bg-amber-100 text-amber-700 border-amber-200" },
  custom:     { label: "Mode",       className: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  audit:      { label: "Audit",      className: "bg-teal-100 text-teal-700 border-teal-200" }
};

function RuleSection({ section, defaultOpen = false, searchQuery = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = section.icon;

  const filteredRules = section.rules.filter(rule =>
    !searchQuery ||
    rule.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
    rule.desc.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Auto-expand sections that have matching rules during search
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

export default function PriceMatrixRulebook() {
  const [searchQuery, setSearchQuery] = useState("");

  const totalRules = sections.reduce((sum, s) => sum + s.rules.length, 0);

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-xl">
        <BookOpen className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-primary">Price Matrix Rulebook</h3>
            <Badge variant="outline" className="text-xs">{sections.length} sections · {totalRules} rules</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Complete reference for how pricing is structured, resolved, and applied across agencies and agents.
          </p>
        </div>
      </div>

      {/* Quick Reference Summary */}
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
                <GitBranch className="h-3.5 w-3.5" /> Priority
              </div>
              <div className="text-blue-700 space-y-0.5">
                <div>1. Agent Matrix</div>
                <div>2. Agency Matrix</div>
                <div>3. Master Default</div>
              </div>
            </div>
            <div className="p-3 bg-purple-50 rounded-lg border border-purple-100">
              <div className="font-semibold text-purple-800 mb-1 flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" /> Modes
              </div>
              <div className="text-purple-700 space-y-0.5">
                <div>Default → master prices</div>
                <div>Blanket → % off all</div>
                <div>Custom → per item</div>
              </div>
            </div>
            <div className="p-3 bg-red-50 rounded-lg border border-red-100">
              <div className="font-semibold text-red-800 mb-1 flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" /> Booking
              </div>
              <div className="text-red-700 space-y-0.5">
                <div>Prices lock at creation</div>
                <div>Matrix changes don't</div>
                <div>affect old projects</div>
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

      {/* Implementation Notes */}
      <Card className="border-dashed">
        <CardContent className="pt-5 pb-4">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-medium text-sm mb-2">Implementation Notes</h4>
              <ul className="text-xs text-muted-foreground space-y-1.5">
                 <li>• All price matrix records include built-in fields: <code className="bg-muted px-1 rounded">id</code>, <code className="bg-muted px-1 rounded">created_date</code>, <code className="bg-muted px-1 rounded">updated_date</code>, <code className="bg-muted px-1 rounded">created_by</code></li>
                 <li>• <code className="bg-muted px-1 rounded">entity_name</code> is cached on the matrix record for fast display without additional lookups</li>
                 <li>• Real-time subscriptions on PriceMatrix ensure the page auto-updates when another user makes changes simultaneously</li>
                 <li>• <code className="bg-muted px-1 rounded">last_modified_by</code> and <code className="bg-muted px-1 rounded">last_modified_at</code> are updated on every save</li>
                 <li>• Blanket discounts are applied at calculation time in <code className="bg-muted px-1 rounded">calculateProjectPricing</code> — not stored as pre-computed values</li>
                 <li>• Unsaved local edits are protected from being overwritten by real-time updates from other users</li>
                 <li>• Editing is restricted to <code className="bg-muted px-1 rounded">admin</code> and <code className="bg-muted px-1 rounded">master_admin</code> roles — all others see read-only mode</li>
                 <li>• Cached product/package names are re-synced to master names on every save to prevent stale display data</li>
                 <li>• Master price drift indicators (<TrendingUp className="inline h-3 w-3" /> "was $X") appear when a master price has changed since an override was set</li>
                 <li>• <code className="bg-muted px-1 rounded">calculateProjectPricing</code> filters inactive products/packages (soft delete) before computing project totals</li>
               </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}