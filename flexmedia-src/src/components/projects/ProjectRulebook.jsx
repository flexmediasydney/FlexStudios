import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, Package, DollarSign, Settings, Clock, RefreshCw } from "lucide-react";

export default function ProjectRulebook() {
  const rules = [
    {
      id: 1,
      title: "Eight Lifecycle Stages",
      description: "Projects flow through: To Be Scheduled → Scheduled → Onsite → Uploaded → Submitted → In Progress → Partially Delivered → Delivered",
      icon: Package,
      color: "bg-blue-100 text-blue-700"
    },
    {
      id: 2,
      title: "Non-Linear Stage Navigation",
      description: "Projects can be moved to any stage directly — no requirement for sequential progression. Backwards moves and skip-forwards are allowed and logged",
      icon: Settings,
      color: "bg-purple-100 text-purple-700"
    },
    {
      id: 3,
      title: "Single Package Limit",
      description: "Only 1 package can exist in a project at any time. Must remove existing package before adding a new one",
      icon: Package,
      color: "bg-indigo-100 text-indigo-700"
    },
    {
      id: 4,
      title: "Package Quantity Lock",
      description: "Packages always have qty = 1 and cannot be changed. To book multiple, add products individually as standalone line items",
      icon: Settings,
      color: "bg-pink-100 text-pink-700"
    },
    {
      id: 5,
      title: "Product Quantity Constraints",
      description: "Product quantities must respect min_quantity (floor) and max_quantity (ceiling). Both UI and backend enforce these bounds",
      icon: AlertCircle,
      color: "bg-amber-100 text-amber-700"
    },
    {
      id: 6,
      title: "Price Matrix Engine",
      description: "Pricing is automatically calculated from the price matrix. Agent-level matrix overrides agency matrix, which overrides master pricing",
      icon: DollarSign,
      color: "bg-green-100 text-green-700"
    },
    {
      id: 7,
      title: "Price Lock at Creation",
      description: "When a project is created or pricing is saved, prices lock in permanently. Subsequent matrix changes do NOT affect existing projects",
      icon: DollarSign,
      color: "bg-emerald-100 text-emerald-700"
    },
    {
      id: 8,
      title: "Double Confirmation Before Save",
      description: "Any pricing or item change must be verified with the backend. A confirmation dialog shows the final matrix-adjusted total before committing",
      icon: AlertCircle,
      color: "bg-orange-100 text-orange-700"
    },
    {
      id: 9,
      title: "Task Auto-Generation from Templates",
      description: "Products and packages define task templates per tier. When booked, tasks are auto-created with auto-assignment based on project staff roles",
      icon: Package,
      color: "bg-cyan-100 text-cyan-700"
    },
    {
      id: 11,
      title: "Production Role Fallback to Project Owner",
      description: "If image editor, video editor, videographer, or photographer roles are unassigned, auto-generated tasks for those roles revert to the project owner",
      icon: AlertCircle,
      color: "bg-red-100 text-red-700"
    },
    {
      id: 12,
      title: "Project Owner is Mandatory",
      description: "Every project must have a project_owner_id assigned. This field is required at creation and used as the fallback assignee for production role tasks when specific roles are unassigned",
      icon: AlertCircle,
      color: "bg-red-100 text-red-700"
    },
    {
      id: 13,
      title: "Package Task Inheritance from Products",
      description: "When a package is booked, tasks are auto-generated from both the package's own templates AND from each product's templates that the package contains. This ensures all tasks needed for the full workflow are created",
      icon: Package,
      color: "bg-indigo-100 text-indigo-700"
    },
    {
      id: 10,
      title: "Nested Product Qty Modification",
      description: "Standalone products can have qty changed post-creation. Package-included products also support qty changes above their included minimum",
      icon: Settings,
      color: "bg-teal-100 text-teal-700"
    },
    {
      id: 14,
      title: "Task Dependencies & Blocking",
      description: "Tasks can depend on other tasks via depends_on_task_ids. When dependencies are incomplete, the task is marked blocked (is_blocked=true) and cannot be completed. Blocked tasks display a lock icon and show which dependencies are incomplete",
      icon: Package,
      color: "bg-red-100 text-red-700"
    },
    {
      id: 15,
      title: "Circular Dependency Prevention",
      description: "Before a task dependency is added, the system validates there are no circular chains. Attempts to create cycles are rejected with a clear error message. Validation uses depth-first search to detect all cycle types",
      icon: AlertCircle,
      color: "bg-orange-100 text-orange-700"
    },
    {
      id: 16,
      title: "Reverse Dependency Visualization",
      description: "Tasks display which downstream tasks depend on them via a 'Blocks:' section. This helps users understand the criticality of each task in the workflow chain",
      icon: Package,
      color: "bg-indigo-100 text-indigo-700"
    },
    {
      id: 17,
      title: "Template-Based Task Dependencies",
      description: "Product and package task templates can define dependency chains via depends_on_indices (array indices of sibling tasks). These are automatically wired when tasks are auto-generated, creating multi-step workflows",
      icon: Settings,
      color: "bg-purple-100 text-purple-700"
    },
    {
      id: 18,
      title: "Global Active Timers Indicator",
      description: "A persistent, animated indicator in the bottom-right corner of the app displays active running timers across ALL projects. Clicking reveals which tasks have running timers",
      icon: Clock,
      color: "bg-red-100 text-red-700"
    },
    {
      id: 19,
      title: "Project-Level Active Timers Banner",
      description: "Each project detail page displays a prominent red-bordered banner when tasks have running timers. Shows which users have active timers and prevents missed active tracking on the current project",
      icon: AlertCircle,
      color: "bg-red-100 text-red-700"
    },
    {
      id: 20,
      title: "30-Minute Inactivity Auto-Pause",
      description: "TaskTimeLogger monitors page activity. After 30 minutes of no interaction (clicks, inputs), the timer automatically pauses with a confirmation dialog. Timer never silently runs unattended",
      icon: Clock,
      color: "bg-orange-100 text-orange-700"
    },
    {
      id: 21,
      title: "Revision-Triggered Auto-Stage Transition",
      description: "When a project has ANY unclosed revision (status pending/in_progress), the project automatically enters 'in_revision' stage and caches its previous_status. When ALL revisions are closed (completed/rejected), the project auto-reverts to the cached previous_status",
      icon: RefreshCw,
      color: "bg-violet-100 text-violet-700"
    },
    {
      id: 22,
      title: "Two Revision Request Kinds",
      description: "Revisions are categorised as either 'revision' (minor adjustments) or 'change_request' (scope changes). This is visually distinct: violet badges for revisions, rose badges for change requests. Kind filtering is available on the revisions list view",
      icon: RefreshCw,
      color: "bg-rose-100 text-rose-700"
    },
    {
      id: 23,
      title: "Revision Template-Based Task Generation",
      description: "RevisionTemplates define task workflows by request_kind and revision_type. When a template is applied, tasks are auto-generated with auto-assignment, deadline triggers (triggered on shoot/upload/submission/dependencies-cleared events), and inter-task dependencies wired automatically",
      icon: Package,
      color: "bg-indigo-100 text-indigo-700"
    },
    {
      id: 24,
      title: "Revision Pricing Impact Tracking",
      description: "Revisions can declare pricing changes: products added/removed, quantity adjustments, and estimated cost delta. Impact is tracked but not applied until the revision is marked completed or manually applied. Applied status is logged with timestamp for audit",
      icon: DollarSign,
      color: "bg-emerald-100 text-emerald-700"
    }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-2">Project Rules</h2>
        <p className="text-muted-foreground">
          Guidelines that govern how projects manage packages, products, and pricing
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rules.map((rule) => {
          const Icon = rule.icon;
          return (
            <Card key={rule.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${rule.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{rule.title}</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{rule.description}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="bg-muted/50 border-muted">
        <CardHeader>
          <CardTitle className="text-base">Complete Workflow Rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <h4 className="font-medium mb-1">Stage Transitions & Activity Tracking</h4>
            <p className="text-muted-foreground">
              Projects can transition to any stage at any time. Every transition is logged in ProjectActivity with the old/new state, changed user, and timestamp. The StagePipeline component visualises stage durations — elapsed time for completed stages, live timer for current stage.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Product & Package Selection</h4>
            <p className="text-muted-foreground">
              Add standalone products freely (respect min/max bounds). Only 1 package can be active — remove it before switching. Packages include nested products with pre-set quantities that can be adjusted upward (below min = use package default, above = charged per-unit rates).
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Pricing Calculation & Locking</h4>
            <p className="text-muted-foreground">
              The calculateProjectPricing backend function verifies all items, applies the agent/agency/master pricing hierarchy, and returns the total. A confirmation dialog shows the verified amount. Only after user confirmation is the price locked into the project, with a price_matrix_snapshot for audit.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Quantity & Item Changes Post-Creation</h4>
            <p className="text-muted-foreground">
              Standalone products can have qty modified anytime (within bounds). Nested products in packages can be qty'd up (but not below included qty). Any change re-runs pricing through the matrix engine. Changes are unsaved locally until user confirms — real-time updates from other users don't overwrite pending edits.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Task Auto-Generation & Dependencies</h4>
            <p className="text-muted-foreground">
              When products/packages are added, their templates auto-create tasks. Tasks auto-assign to the matching project staff role (photographer, editor, etc.). Task templates define dependencies — tasks with unmet dependencies are marked as blocked until their upstream tasks complete.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Task Blocking & Circular Dependency Safety</h4>
            <p className="text-muted-foreground">
              Tasks with incomplete dependencies are marked blocked (is_blocked=true) and display a lock icon. Blocked tasks cannot be completed. The UI shows a dependency counter (e.g. "2/3 complete") and lists each incomplete upstream task. The system validates all dependency additions to prevent circular chains — any cycle is rejected before it can be created. Task rows also show reverse dependencies (which tasks this task blocks) to help users understand workflow criticality.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Filtering & Multi-Select on Projects List</h4>
            <p className="text-muted-foreground">
              The Projects dashboard supports filtering by products, packages, agents, agencies, and teams. Multiple filters are cumulative (AND logic). Sorting options: Last Updated, Task Deadline, Next Activity, Date Created. Active filters are displayed as chips with quick reset.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Role-Based Access</h4>
            <p className="text-muted-foreground">
              Two roles exist: master_admin (full access) and employee (operational access). Pricing visibility is controlled by role. Staff role assignments on projects are used for workflow management and notification targeting.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Timer Defense Mechanisms</h4>
            <p className="text-muted-foreground">
              Multiple layers protect against accidental long-running timers: (1) Global indicator in app corner shows all active timers across projects, (2) Project-level banner on project details lists active timers, (3) 30-minute auto-pause stops forgotten timers with user confirmation. Timer activity resets the inactivity clock — continuous use prevents auto-pause.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-1">Revision & Change Request Workflows</h4>
            <p className="text-muted-foreground">
              Projects can enter 'in_revision' stage when unclosed revisions exist, automatically caching the previous stage. Revisions are categorised by kind (revision vs change_request) and type (images, drones, floorplan, video). Templates define task workflows with deadline automation (triggered on project events). Pricing impacts are tracked and can be applied when revisions are completed, automatically updating project products and recalculating prices.
            </p>
          </div>
          </CardContent>
          </Card>
          </div>
          );
          }