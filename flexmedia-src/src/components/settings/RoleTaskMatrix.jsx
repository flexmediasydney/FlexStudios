import { useState, useMemo } from "react";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { useEntityList } from "@/components/hooks/useEntityData";
import { useRoleMappings } from "@/components/hooks/useRoleMappings";
import { api } from "@/api/supabaseClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Users, Camera, Film, Plane, Palette, FileText, Layers,
  Clock, ChevronDown, ChevronRight, AlertTriangle,
  Timer, Link2, Package, Pencil, Check, X, Info
} from "lucide-react";
import { toast } from "sonner";

const ROLE_ICONS = {
  project_owner: Users,
  photographer: Camera,
  videographer: Film,
  image_editor: Palette,
  video_editor: Film,
  floorplan_editor: FileText,
  drone_editor: Plane,
};

const ROLE_COLORS = {
  project_owner: "bg-slate-100 text-slate-700 border-slate-200",
  photographer: "bg-blue-50 text-blue-700 border-blue-200",
  videographer: "bg-purple-50 text-purple-700 border-purple-200",
  image_editor: "bg-emerald-50 text-emerald-700 border-emerald-200",
  video_editor: "bg-violet-50 text-violet-700 border-violet-200",
  floorplan_editor: "bg-amber-50 text-amber-700 border-amber-200",
  drone_editor: "bg-cyan-50 text-cyan-700 border-cyan-200",
};

const ALL_CATEGORIES = [
  "photography", "video", "drone", "floorplan", "editing", "virtual_staging", "other"
];

const CATEGORY_LABELS = {
  photography: "Photography",
  video: "Video",
  drone: "Drone",
  floorplan: "Floorplan",
  editing: "Editing",
  virtual_staging: "Virtual Staging",
  other: "Other",
};

const TASK_TYPE_BADGE = {
  onsite: { label: "Onsite", className: "bg-orange-100 text-orange-700 border-orange-200" },
  back_office: { label: "Back Office", className: "bg-sky-100 text-sky-700 border-sky-200" },
};

const TRIGGER_LABELS = {
  none: null,
  project_onsite: "Shoot starts",
  project_uploaded: "Media uploaded",
  project_submitted: "Submitted",
  dependencies_cleared: "Dependencies done",
};

function TaskTemplatePill({ task, tier }) {
  const typeBadge = TASK_TYPE_BADGE[task.task_type] || TASK_TYPE_BADGE.back_office;
  const trigger = TRIGGER_LABELS[task.timer_trigger];

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-card text-xs hover:shadow-sm transition-shadow">
      <span className="font-medium text-foreground flex-1 min-w-0 truncate" title={task.title}>
        {task.title || "Untitled task"}
      </span>
      <Badge variant="outline" className={cn("text-[9px] px-1 py-0 shrink-0", typeBadge.className)}>
        {typeBadge.label}
      </Badge>
      {task.estimated_minutes > 0 && (
        <span className="text-[9px] text-muted-foreground shrink-0 flex items-center gap-0.5 tabular-nums">
          <Timer className="h-2.5 w-2.5" />{task.estimated_minutes}m
        </span>
      )}
      {trigger && (
        <span className="text-[9px] text-muted-foreground shrink-0 flex items-center gap-0.5">
          <Clock className="h-2.5 w-2.5" />{trigger}
        </span>
      )}
      {(task.depends_on_indices?.length > 0) && (
        <span className="text-[9px] text-muted-foreground shrink-0 flex items-center gap-0.5">
          <Link2 className="h-2.5 w-2.5" />{task.depends_on_indices.length} dep
        </span>
      )}
      <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0 bg-muted/50">
        {tier}
      </Badge>
    </div>
  );
}

function ProductBlock({ product, role, allPackages }) {
  const standardTasks = (product.standard_task_templates || []).filter(t => t.auto_assign_role === role);
  const premiumTasks = (product.premium_task_templates || []).filter(t => t.auto_assign_role === role);
  const totalTasks = standardTasks.length + premiumTasks.length;
  const containingPackages = allPackages.filter(pkg =>
    (pkg.products || []).some(pp => pp.product_id === product.id)
  );
  if (totalTasks === 0) return null;

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b">
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">{product.name}</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0">{product.category}</Badge>
        {!product.is_active && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 bg-red-50 text-red-600 border-red-200">Inactive</Badge>
        )}
        {containingPackages.length > 0 && (
          <span className="text-[9px] text-muted-foreground ml-auto flex items-center gap-0.5">
            <Package className="h-2.5 w-2.5" />
            in {containingPackages.map(p => p.name).join(", ")}
          </span>
        )}
      </div>
      <div className="p-2 space-y-1">
        {standardTasks.map((task, i) => <TaskTemplatePill key={`s-${i}`} task={task} tier="STD" />)}
        {premiumTasks.map((task, i) => <TaskTemplatePill key={`p-${i}`} task={task} tier="PRM" />)}
      </div>
    </div>
  );
}

function RoleEditor({ roleDef, entityRow, onSaved }) {
  const [draft, setDraft] = useState({
    label: roleDef.label,
    description: roleDef.description || "",
    categories: roleDef.categories ? [...roleDef.categories] : null,
    always_required: roleDef.always_required || false,
  });
  const [saving, setSaving] = useState(false);

  const toggleCategory = (cat) => {
    setDraft(prev => {
      const cats = prev.categories || [];
      const next = cats.includes(cat) ? cats.filter(c => c !== cat) : [...cats, cat];
      return { ...prev, categories: next.length === 0 ? [] : next };
    });
  };

  const toggleAlwaysRequired = () => {
    setDraft(prev => ({
      ...prev,
      always_required: !prev.always_required,
      categories: !prev.always_required ? null : (prev.categories || []),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        role: roleDef.role,
        label: draft.label,
        description: draft.description,
        categories: draft.always_required ? null : JSON.stringify(draft.categories || []),
        always_required: draft.always_required,
        is_active: true,
        order: roleDef.order ?? 0,
      };
      if (entityRow?.id) {
        await api.entities.RoleCategoryMapping.update(entityRow.id, payload);
      } else {
        await api.entities.RoleCategoryMapping.create(payload);
      }
      toast.success(`${draft.label} mapping saved`);
      onSaved();
    } catch (err) {
      toast.error(err?.message || "Failed to save mapping");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Label</label>
          <Input
            value={draft.label}
            onChange={e => setDraft(p => ({ ...p, label: e.target.value }))}
            className="h-8 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Description</label>
          <Input
            value={draft.description}
            onChange={e => setDraft(p => ({ ...p, description: e.target.value }))}
            className="h-8 text-sm"
            placeholder="When is this role required?"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <label className="text-xs font-medium text-muted-foreground">Trigger Categories</label>
          <button
            onClick={toggleAlwaysRequired}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors",
              draft.always_required
                ? "bg-slate-100 text-slate-700 border-slate-300"
                : "bg-background text-muted-foreground border-border hover:border-muted-foreground/50"
            )}
          >
            {draft.always_required ? "✓ Always required" : "Always required?"}
          </button>
        </div>
        {!draft.always_required && (
          <div className="flex flex-wrap gap-1.5">
            {ALL_CATEGORIES.map(cat => {
              const active = (draft.categories || []).includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full border transition-all",
                    active
                      ? "bg-primary text-primary-foreground border-primary font-medium"
                      : "bg-background text-muted-foreground border-border hover:border-primary/50"
                  )}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs gap-1">
          <Check className="h-3 w-3" />
          {saving ? "Saving..." : "Save Mapping"}
        </Button>
      </div>
    </div>
  );
}

function RoleSection({ roleDef, entityRow, products, packages, onSaved, canEdit }) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const Icon = ROLE_ICONS[roleDef.role] || Users;
  const colorClass = ROLE_COLORS[roleDef.role] || "bg-slate-100 text-slate-700 border-slate-200";

  const matchingProducts = roleDef.categories
    ? products.filter(p => p.is_active !== false && roleDef.categories.includes((p.category || '').toLowerCase()))
    : [];

  const allTasksForRole = products.flatMap(p => [
    ...(p.standard_task_templates || []).filter(t => t.auto_assign_role === roleDef.role),
    ...(p.premium_task_templates || []).filter(t => t.auto_assign_role === roleDef.role),
  ]);

  const productsWithTasks = products.filter(p => {
    const std = (p.standard_task_templates || []).some(t => t.auto_assign_role === roleDef.role);
    const prm = (p.premium_task_templates || []).some(t => t.auto_assign_role === roleDef.role);
    return std || prm;
  });

  const warnings = useMemo(() => {
    const w = [];
    if (!roleDef.categories) return w;
    const noTaskProducts = matchingProducts.filter(p => {
      const std = (p.standard_task_templates || []).some(t => t.auto_assign_role === roleDef.role);
      const prm = (p.premium_task_templates || []).some(t => t.auto_assign_role === roleDef.role);
      return !std && !prm;
    });
    if (noTaskProducts.length > 0) {
      w.push({ type: "missing_tasks", message: `${noTaskProducts.length} product(s) have no tasks for this role`, products: noTaskProducts.map(p => p.name) });
    }
    const orphanedProducts = products.filter(p => {
      if (!p.is_active) return false;
      if (roleDef.categories.includes((p.category || '').toLowerCase())) return false;
      return (p.standard_task_templates || []).some(t => t.auto_assign_role === roleDef.role) ||
             (p.premium_task_templates || []).some(t => t.auto_assign_role === roleDef.role);
    });
    if (orphanedProducts.length > 0) {
      w.push({ type: "category_mismatch", message: `${orphanedProducts.length} product(s) have tasks for this role but are in a different category`, products: orphanedProducts.map(p => `${p.name} (${p.category})`) });
    }
    return w;
  }, [products, roleDef, matchingProducts]);

  return (
    <Card className={cn("overflow-hidden", warnings.length > 0 && "ring-1 ring-amber-300")}>
      <div className="flex items-stretch">
        <button onClick={() => setExpanded(e => !e)} className="flex-1 text-left">
          <CardHeader className="py-3 px-4">
            <div className="flex items-center gap-3">
              {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border", colorClass)}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-sm">{roleDef.label}</CardTitle>
                  {roleDef.always_required || !roleDef.categories ? (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-slate-50">Always required</Badge>
                  ) : (
                    <div className="flex gap-1 flex-wrap">
                      {roleDef.categories.map(cat => (
                        <Badge key={cat} variant="outline" className="text-[9px] px-1.5 py-0">{CATEGORY_LABELS[cat] || cat}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{roleDef.description}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {warnings.length > 0 && (
                  <div className="flex items-center gap-1 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span className="text-[10px] font-semibold">{warnings.length}</span>
                  </div>
                )}
                <div className="text-right">
                  <div className="text-sm font-bold tabular-nums">{allTasksForRole.length}</div>
                  <div className="text-[9px] text-muted-foreground uppercase">tasks</div>
                </div>
              </div>
            </div>
          </CardHeader>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(v => !v); }}
          className={cn(
            "px-3 border-l flex items-center justify-center transition-colors",
            editing ? "bg-primary/10 text-primary" : "hover:bg-muted/50 text-muted-foreground"
          )}
          title="Edit role mapping"
          disabled={!canEdit}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>

      {editing && (
        <div className="px-4 pb-3 border-t bg-muted/10">
          <RoleEditor
            roleDef={roleDef}
            entityRow={entityRow}
            onSaved={() => { onSaved(); setEditing(false); }}
          />
        </div>
      )}

      {expanded && (
        <CardContent className="pt-0 px-4 pb-4">
          {warnings.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium text-amber-800">{w.message}</span>
                    <span className="text-amber-600 ml-1">— {w.products.join(", ")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {productsWithTasks.length > 0 ? (
            <div className="space-y-2">
              {productsWithTasks.map(product => (
                <ProductBlock key={product.id} product={product} role={roleDef.role} allPackages={packages} />
              ))}
            </div>
          ) : roleDef.categories ? (
            <div className="text-center py-4 text-xs text-muted-foreground">
              No task templates assigned to this role yet. Add tasks in the product editor and set "Auto-assign role" to "{roleDef.label}".
            </div>
          ) : (
            <div className="text-center py-4 text-xs text-muted-foreground">
              Project owner is auto-assigned — no task templates needed.
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function RoleTaskMatrix() {
  const { canEdit, canView } = useEntityAccess('role_matrix');
  const { data: products = [], loading: loadingProducts } = useEntityList("Product");
  const { data: packages = [], loading: loadingPackages } = useEntityList("Package");
  const { data: entityRows = [], loading: loadingMappings, refetch: refetchMappings } = useEntityList("RoleCategoryMapping", "order");
  const { mappings, usingFallback } = useRoleMappings();

  // Build a lookup from role → entity row (for passing to editor)
  const entityRowByRole = useMemo(() => {
    const map = {};
    entityRows.forEach(r => { map[r.role] = r; });
    return map;
  }, [entityRows]);

  const stats = useMemo(() => {
    const activeProducts = products.filter(p => p.is_active !== false);
    const totalStdTasks = activeProducts.reduce((s, p) => s + (p.standard_task_templates?.length || 0), 0);
    const totalPrmTasks = activeProducts.reduce((s, p) => s + (p.premium_task_templates?.length || 0), 0);
    const unassignedStd = activeProducts.reduce((s, p) =>
      s + (p.standard_task_templates || []).filter(t => !t.auto_assign_role || t.auto_assign_role === "none").length, 0);
    const unassignedPrm = activeProducts.reduce((s, p) =>
      s + (p.premium_task_templates || []).filter(t => !t.auto_assign_role || t.auto_assign_role === "none").length, 0);
    const categoryCounts = {};
    activeProducts.forEach(p => { categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1; });
    return {
      activeProducts: activeProducts.length,
      totalTasks: totalStdTasks + totalPrmTasks,
      standardTasks: totalStdTasks,
      premiumTasks: totalPrmTasks,
      unassigned: unassignedStd + unassignedPrm,
      categoryCounts,
      packages: packages.length,
    };
  }, [products, packages]);

  if (loadingProducts || loadingPackages || loadingMappings) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Loading task assignments...</div>;
  }

  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  return (
    <div className="space-y-6">
      {usingFallback && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600" />
          <div>
            <span className="font-semibold">Using hardcoded defaults</span> — Role mappings haven't been seeded yet.
            Run <code className="bg-amber-100 px-1 rounded">seedRoleCategoryMappings</code> from the backend functions dashboard to enable persistent editing.
          </div>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 rounded-lg border bg-card">
          <div className="text-lg font-bold tabular-nums">{stats.activeProducts}</div>
          <div className="text-[10px] text-muted-foreground uppercase">Active Products</div>
        </div>
        <div className="p-3 rounded-lg border bg-card">
          <div className="text-lg font-bold tabular-nums">{stats.totalTasks}</div>
          <div className="text-[10px] text-muted-foreground uppercase">Task Templates</div>
          <div className="text-[9px] text-muted-foreground mt-0.5">{stats.standardTasks} std / {stats.premiumTasks} prm</div>
        </div>
        <div className="p-3 rounded-lg border bg-card">
          <div className="text-lg font-bold tabular-nums">{stats.packages}</div>
          <div className="text-[10px] text-muted-foreground uppercase">Packages</div>
        </div>
        <div className={cn("p-3 rounded-lg border", stats.unassigned > 0 ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200")}>
          <div className={cn("text-lg font-bold tabular-nums", stats.unassigned > 0 ? "text-amber-700" : "text-emerald-700")}>{stats.unassigned}</div>
          <div className={cn("text-[10px] uppercase", stats.unassigned > 0 ? "text-amber-600" : "text-emerald-600")}>Unassigned Tasks</div>
        </div>
      </div>

      {/* Category breakdown */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(stats.categoryCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
          <Badge key={cat} variant="outline" className="text-xs gap-1.5 py-1 px-2">
            {CATEGORY_LABELS[cat] || cat}
            <span className="font-bold tabular-nums">{count}</span>
          </Badge>
        ))}
      </div>

      {/* Role sections */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Role → Product → Task Mapping <AccessBadge entityType="role_matrix" /></h3>
        <p className="text-xs text-muted-foreground -mt-2">Click the <Pencil className="inline h-3 w-3" /> icon to edit which product categories trigger each role.</p>
        {mappings.map(roleDef => (
          <RoleSection
            key={roleDef.role}
            roleDef={roleDef}
            entityRow={entityRowByRole[roleDef.role] || null}
            products={products}
            packages={packages}
            onSaved={refetchMappings}
            canEdit={canEdit}
          />
        ))}
      </div>
    </div>
  );
}