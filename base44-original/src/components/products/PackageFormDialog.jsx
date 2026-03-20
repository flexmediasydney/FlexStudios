import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Plus, X, Trash2, Copy, Link as LinkIcon, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS, TASK_TYPE_LABELS } from "@/components/projects/TaskManagement.jsx";

const EMPTY_TIER = { package_price: 0, scheduling_time: 0, admin_time: 0, editor_time: 0 };
const INITIAL_FORM = {
  name: "",
  description: "",
  products: [],
  project_type_ids: [],
  standard_tier: { ...EMPTY_TIER },
  premium_tier: { ...EMPTY_TIER },
  standard_task_templates: [],
  premium_task_templates: [],
  is_active: true
};

export default function PackageFormDialog({ open, onClose, package: packageData, onSave, presetTypeId, availableProducts, products, projectTypes }) {
  const [formData, setFormData] = useState(() =>
    packageData
      ? {
          ...INITIAL_FORM,
          ...packageData,
          standard_task_templates: packageData.standard_task_templates || [],
          premium_task_templates: packageData.premium_task_templates || [],
          project_type_ids: packageData.project_type_ids || [],
        }
      : {
          ...INITIAL_FORM,
          project_type_ids: presetTypeId ? [presetTypeId] : [],
        }
  );
  const [pendingTypeChange, setPendingTypeChange] = useState(null);
  const { data: productCategories = [] } = useEntityList("ProductCategory");

  const addTaskTemplate = (tier) => {
    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData((prev) => ({
      ...prev,
      [key]: [
        ...(prev[key] || []),
        {
          title: "",
          description: "",
          task_type: "back_office",
          auto_assign_role: "none",
          estimated_minutes: 0,
          depends_on_indices: [],
          timer_trigger: "none",
          deadline_type: "custom",
          deadline_preset: null,
          deadline_hours_after_trigger: 0,
        },
      ],
    }));
  };

  const updateTaskTemplate = (tier, index, field, value) => {
    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData((prev) => {
      const updated = (prev[key] || []).map((task, i) => {
        if (i !== index) return task;
        const newTask = { ...task, [field]: value };
        if (field === "timer_trigger" && value === "none") {
          newTask.deadline_hours_after_trigger = 0;
        }
        return newTask;
      });
      return { ...prev, [key]: updated };
    });
  };

  const removeTaskTemplate = (tier, index) => {
    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData((prev) => ({
      ...prev,
      [key]: (prev[key] || []).filter((_, i) => i !== index),
    }));
  };

  const copyTasksToOtherTier = (fromTier) => {
    const fromKey = fromTier === "standard" ? "standard_task_templates" : "premium_task_templates";
    const toKey = fromTier === "standard" ? "premium_task_templates" : "standard_task_templates";
    const toLabel = fromTier === "standard" ? "Premium" : "Standard";
    setFormData((prev) => ({
      ...prev,
      [toKey]: JSON.parse(JSON.stringify(prev[fromKey] || [])),
    }));
    toast.success(`Tasks copied to ${toLabel} tier`);
  };

  const handleSubmit = () => {
    if (!formData.name?.trim()) {
      toast.error("Package name is required.");
      return;
    }
    if (formData.products.length === 0) {
      toast.error("Add at least one product");
      return;
    }

    // Validate project types exist
    if (formData.project_type_ids && formData.project_type_ids.length > 0) {
      const invalidTypes = formData.project_type_ids.filter(
        (typeId) => !projectTypes.find((t) => t.id === typeId && t.is_active !== false)
      );
      if (invalidTypes.length > 0) {
        toast.error("One or more selected project types no longer exist. Please update your selection.");
        return;
      }
    }

    onSave(formData);
  };

  const updateTier = (tier, field, value) => {
    setFormData((prev) => ({
      ...prev,
      [tier]: {
        ...prev[tier],
        [field]: Number(value) || 0,
      },
    }));
  };

  const handleProjectTypeChange = (typeId) => {
    const isSelected = (formData.project_type_ids || []).includes(typeId);

    if (packageData && isSelected) {
      // Deselecting on existing package requires confirmation
      const typeName = projectTypes.find((t) => t.id === typeId)?.name;
      setPendingTypeChange({ action: "deselect", typeId, typeName });
    } else {
      // Selecting new type or deselecting on new package - validate products
      const newTypeIds = isSelected ? [] : [typeId];
      const validProducts = newTypeIds.length === 0
        ? formData.products
        : formData.products.filter((item) => {
            const prod = products.find((p) => p.id === item.product_id);
            const prodTypes = prod?.project_type_ids || [];
            return prodTypes.length === 0 || prodTypes.includes(newTypeIds[0]);
          });

      if (validProducts.length < formData.products.length) {
        toast.warning(`Removed ${formData.products.length - validProducts.length} product(s) that don't match the new type`);
      }
      setFormData((prev) => ({ ...prev, project_type_ids: newTypeIds, products: validProducts }));
    }
  };

  const handleAddProduct = (productId) => {
    const alreadyAdded = formData.products.find((fp) => fp.product_id === productId);
    if (alreadyAdded) {
      toast.error("Product already added");
      return;
    }

    const product = availableProducts.find((p) => p.id === productId);
    if (!product) {
      toast.error("This product is not available for this package type");
      return;
    }

    setFormData((prev) => ({
      ...prev,
      products: [
        ...prev.products,
        {
          product_id: product.id,
          product_name: product.name,
          quantity: product.min_quantity || 1,
          pricing_type: product.pricing_type,
          min_quantity: product.min_quantity || 1,
        },
      ],
    }));
  };

  const handleRemoveProduct = (index) => {
    setFormData((prev) => ({ ...prev, products: prev.products.filter((_, i) => i !== index) }));
  };

  const handleUpdateQuantity = (index, quantity) => {
    setFormData((prev) => ({
      ...prev,
      products: prev.products.map((p, i) => {
        if (i !== index) return p;
        const min = p.min_quantity || 1;
        const max = p.max_quantity;
        let value = Number(quantity) || min;
        value = Math.max(min, value);
        if (max) value = Math.min(max, value);
        return { ...p, quantity: value };
      }),
    }));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="pb-4">
            <DialogTitle className="text-2xl">{packageData ? "Edit Package" : "Create New Package"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
            {/* Project Type Selection */}
            {projectTypes.filter((t) => t.is_active !== false).length > 0 && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Project Type</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Leave empty for all types, or select one</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {projectTypes.filter((t) => t.is_active !== false).map((type) => {
                    const isSelected = (formData.project_type_ids || []).includes(type.id);
                    return (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => handleProjectTypeChange(type.id)}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-md hover:shadow-lg border-2 ${
                          isSelected ? "opacity-100 cursor-pointer" : "opacity-40 cursor-pointer hover:opacity-60"
                        }`}
                        style={{
                          backgroundColor: isSelected ? (type.color || "#3b82f6") : "transparent",
                          color: isSelected ? "white" : (type.color || "#3b82f6"),
                          borderColor: type.color || "#3b82f6",
                        }}
                      >
                        {type.name}
                        {isSelected && <span className="ml-2">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Package Details */}
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Package Details</h3>
              </div>

              <div>
                <Label htmlFor="name" className="text-xs font-medium text-muted-foreground">
                  Package Name *
                </Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Complete Real Estate Package"
                  className="mt-2"
                />
              </div>

              <div>
                <Label htmlFor="description" className="text-xs font-medium text-muted-foreground">
                  Description
                </Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Describe what's included in this package"
                  rows={2}
                  className="mt-2"
                />
              </div>
            </div>

            {/* Products */}
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Products Included</h3>
              </div>

              {(() => {
                const packageTypeId = (formData.project_type_ids || [])[0];
                if (!packageTypeId || formData.products.length === 0) return null;
                const incompatibleProducts = formData.products.filter((item) => {
                  const prod = products.find((p) => p.id === item.product_id);
                  const prodTypes = prod?.project_type_ids || [];
                  return prodTypes.length > 0 && !prodTypes.includes(packageTypeId);
                });
                if (incompatibleProducts.length === 0) return null;
                return (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                    <p className="font-medium">⚠️ {incompatibleProducts.length} product(s) don't match this package type</p>
                    <p className="text-amber-700 mt-1">{incompatibleProducts.map((p) => p.product_name).join(", ")}</p>
                  </div>
                );
              })()}

              <div className="space-y-2">
                {formData.products.length === 0 ? (
                  <div className="p-6 text-center border-2 border-dashed rounded-lg">
                    <p className="text-sm text-muted-foreground">No products added yet</p>
                  </div>
                ) : (
                  formData.products.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2 p-3 border rounded-lg bg-muted/30">
                      <div className="flex-1">
                        <p className="text-sm font-medium">{item.product_name}</p>
                        {item.pricing_type === "per_unit" && (
                          <p className="text-xs text-muted-foreground">Quantity-based pricing</p>
                        )}
                      </div>
                      {item.pricing_type === "per_unit" ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={item.min_quantity || 1}
                            max={item.max_quantity || undefined}
                            value={item.quantity}
                            onChange={(e) => handleUpdateQuantity(idx, e.target.value)}
                            className="w-16 text-sm"
                          />
                          <span className="text-xs text-muted-foreground">qty</span>
                        </div>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Fixed
                        </Badge>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleRemoveProduct(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>

              <Select onValueChange={handleAddProduct}>
                <SelectTrigger>
                  <SelectValue placeholder={availableProducts.length === 0 ? "No products available for this type" : "Add product..."} />
                </SelectTrigger>
                <SelectContent>
                  {availableProducts.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground text-center">No products available</div>
                  ) : (
                    availableProducts.map((product) => (
                      <SelectItem key={product.id} value={product.id}>
                        {product.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Tier Pricing */}
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Tier Pricing</h3>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {["standard_tier", "premium_tier"].map((tierKey) => (
                  <Card key={tierKey}>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        {tierKey === "standard_tier" ? "Standard" : "Premium"}
                        <Badge variant="secondary" className="text-xs">
                          {tierKey === "standard_tier" ? "STD" : "PRE"}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs text-muted-foreground">Package Price ($)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={formData[tierKey].package_price}
                            onChange={(e) => updateTier(tierKey, "package_price", e.target.value)}
                            className="text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Scheduling Time (min)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={formData[tierKey].scheduling_time}
                            onChange={(e) => updateTier(tierKey, "scheduling_time", e.target.value)}
                            className="text-sm"
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {/* Task Templates */}
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Task Templates</h3>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {["standard", "premium"].map((tier) => {
                  const key = `${tier}_task_templates`;
                  const tasks = formData[key] || [];
                  const isStandard = tier === "standard";
                  const accentColor = isStandard ? "bg-blue-50 border-blue-200" : "bg-amber-50 border-amber-200";
                  const badgeColor = isStandard ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700";
                  const otherKey = isStandard ? "premium_task_templates" : "standard_task_templates";

                  return (
                    <div key={tier} className="border rounded-lg p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${isStandard ? "bg-blue-500" : "bg-amber-500"}`} />
                          <span className="text-sm font-semibold">{isStandard ? "Standard" : "Premium"}</span>
                          {tasks.length > 0 && <Badge variant="secondary" className="text-xs">{tasks.length}</Badge>}
                        </div>
                        {tasks.length > 0 && (
                          <button
                            type="button"
                            onClick={() => copyTasksToOtherTier(tier)}
                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                          >
                            <Copy className="h-3 w-3" /> Copy to {isStandard ? "Premium" : "Standard"}
                          </button>
                        )}
                      </div>
                      {tasks.map((task, index) => (
                        <div key={index} className={`p-3 border rounded-lg space-y-2 ${accentColor}`}>
                          <div className="flex justify-between items-center">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor}`}>
                              Task {index + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeTaskTemplate(tier, index)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <Input
                            value={task.title}
                            onChange={(e) => updateTaskTemplate(tier, index, "title", e.target.value)}
                            placeholder="Task title"
                            className="text-sm bg-white"
                          />
                          <Textarea
                            value={task.description}
                            onChange={(e) => updateTaskTemplate(tier, index, "description", e.target.value)}
                            placeholder="Description (optional)"
                            rows={2}
                            className="text-sm bg-white"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Task Type</Label>
                              <Select
                                value={task.task_type || "back_office"}
                                onValueChange={(v) => updateTaskTemplate(tier, index, "task_type", v)}
                              >
                                <SelectTrigger className="h-7 text-xs bg-white">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(TASK_TYPE_LABELS).map(([val, label]) => (
                                    <SelectItem key={val} value={val} className="text-xs">
                                      {label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Auto-assign role</Label>
                              <Select
                                value={task.auto_assign_role || "none"}
                                onValueChange={(v) => updateTaskTemplate(tier, index, "auto_assign_role", v)}
                              >
                                <SelectTrigger className="h-7 text-xs bg-white">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(ROLE_LABELS).map(([val, label]) => (
                                    <SelectItem key={val} value={val} className="text-xs">
                                      {label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Estimated time (min)</Label>
                            <Input
                              type="number"
                              min="0"
                              value={task.estimated_minutes || 0}
                              onChange={(e) => updateTaskTemplate(tier, index, "estimated_minutes", Number(e.target.value) || 0)}
                              placeholder="0"
                              className="h-7 text-sm bg-white"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Timer Trigger</Label>
                            <Select
                              value={task.timer_trigger || "none"}
                              onValueChange={(v) => updateTaskTemplate(tier, index, "timer_trigger", v)}
                            >
                              <SelectTrigger className="h-7 text-xs bg-white">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none" className="text-xs">
                                  No auto-deadline
                                </SelectItem>
                                <SelectItem value="project_onsite" className="text-xs">
                                  Project set to Onsite
                                </SelectItem>
                                <SelectItem value="project_uploaded" className="text-xs">
                                  Project set to Uploaded
                                </SelectItem>
                                <SelectItem value="project_submitted" className="text-xs">
                                  Project set to Submitted
                                </SelectItem>
                                <SelectItem value="dependencies_cleared" className="text-xs">
                                  Dependencies Cleared
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {task.timer_trigger && task.timer_trigger !== "none" && (
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Deadline Type</Label>
                              <Select
                                value={task.deadline_type || "custom"}
                                onValueChange={(v) => {
                                  if (v === "preset") {
                                    updateTaskTemplate(tier, index, "deadline_type", "preset");
                                    updateTaskTemplate(tier, index, "deadline_preset", "tonight");
                                    updateTaskTemplate(tier, index, "deadline_hours_after_trigger", 0);
                                  } else {
                                    updateTaskTemplate(tier, index, "deadline_type", "custom");
                                    updateTaskTemplate(tier, index, "deadline_hours_after_trigger", 24);
                                    updateTaskTemplate(tier, index, "deadline_preset", null);
                                  }
                                }}
                              >
                                <SelectTrigger className="h-7 text-xs bg-white">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="custom" className="text-xs">
                                    Custom (X hours)
                                  </SelectItem>
                                  <SelectItem value="preset" className="text-xs">
                                    Preset Options
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          {task.timer_trigger && task.timer_trigger !== "none" && (task.deadline_type === "custom" || !task.deadline_type) && (
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Hours after trigger</Label>
                              <Input
                                type="number"
                                min="0"
                                step="0.5"
                                value={task.deadline_hours_after_trigger || 24}
                                onChange={(e) => updateTaskTemplate(tier, index, "deadline_hours_after_trigger", Number(e.target.value))}
                                placeholder="e.g., 24"
                                className="h-7 text-sm bg-white"
                              />
                            </div>
                          )}
                          {tasks.length > 1 && (
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1 block">
                                <LinkIcon className="h-3 w-3" /> Depends on
                              </Label>
                              <div className="space-y-1">
                                {tasks.map((sibling, sibIdx) => {
                                  if (sibIdx === index) return null;
                                  const deps = task.depends_on_indices || [];
                                  return (
                                    <label key={sibIdx} className="flex items-center gap-1.5 text-xs cursor-pointer">
                                      <Checkbox
                                        checked={deps.includes(sibIdx)}
                                        onCheckedChange={(checked) =>
                                          updateTaskTemplate(
                                            tier,
                                            index,
                                            "depends_on_indices",
                                            checked ? [...deps, sibIdx] : deps.filter((i) => i !== sibIdx)
                                          )
                                        }
                                      />
                                      <span>{sibling.title || `Task ${sibIdx + 1}`}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addTaskTemplate(tier)}
                        className="w-full text-xs text-muted-foreground border-2 border-dashed rounded-lg p-2 hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-1"
                      >
                        <Plus className="h-3 w-3" /> Add Task
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Status */}
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border">
              <input
                type="checkbox"
                id="active"
                checked={formData.is_active}
                onChange={(e) => setFormData((prev) => ({ ...prev, is_active: e.target.checked }))}
                className="w-4 h-4"
              />
              <Label htmlFor="active" className="flex-1 cursor-pointer flex items-center gap-2">
                <span>Package is Active</span>
                {formData.is_active && <Badge variant="default" className="text-xs">Active</Badge>}
              </Label>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 pt-6 border-t">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit}>{packageData ? "Update Package" : "Create Package"}</Button>
            </div>
          </div>

          {pendingTypeChange && (
            <AlertDialog open={true} onOpenChange={(open) => !open && setPendingTypeChange(null)}>
              <AlertDialogContent className="max-w-md">
                <div className="flex gap-3">
                  <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <AlertDialogTitle>Confirm Core Change</AlertDialogTitle>
                    <AlertDialogDescription className="mt-3">
                      Changing project type eligibility is a <span className="font-semibold text-foreground">core change</span> that affects:
                      <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
                        <li>Existing projects using this package</li>
                        <li>Price matrices and custom pricing</li>
                        <li>Agency-specific configurations</li>
                      </ul>
                      <p className="mt-3 font-medium">This action cannot be easily reversed.</p>
                    </AlertDialogDescription>
                  </div>
                </div>
                <div className="flex gap-3 justify-end mt-6">
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setFormData((prev) => ({
                        ...prev,
                        project_type_ids: [],
                      }));
                      setPendingTypeChange(null);
                      toast.info("Project type removed. Impact analysis recommended.");
                    }}
                    className="bg-destructive hover:bg-destructive/90"
                  >
                    Confirm Removal
                  </AlertDialogAction>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}