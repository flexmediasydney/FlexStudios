import { useState, useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/api/supabaseClient";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Plus, X, Trash2, Copy, Link as LinkIcon, GripVertical, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS, TASK_TYPE_LABELS } from "@/components/projects/TaskManagement.jsx";

const categories = [
  { value: "photography", label: "Photography" },
  { value: "video", label: "Video" },
  { value: "drone", label: "Drone" },
  { value: "editing", label: "Editing" },
  { value: "virtual_staging", label: "Virtual Staging" },
  { value: "other", label: "Other" }
];

const initialFormData = {
  name: "",
  description: "",
  product_type: "core",
  min_quantity: 1,
  max_quantity: null,
  pricing_type: "fixed",
  category: "photography",
  dusk_only: false,
  project_type_ids: [],
  standard_tier: {
    base_price: 0,
    unit_price: 0,
    onsite_time: 0,
    onsite_time_increment: 0,
    admin_time: 0,
    editor_time: 0
  },
  premium_tier: {
    base_price: 0,
    unit_price: 0,
    onsite_time: 0,
    onsite_time_increment: 0,
    admin_time: 0,
    editor_time: 0
  },
  task_templates: [],
  standard_task_templates: [],
  premium_task_templates: [],
  notes: "",
  is_active: true
};

export default function ProductFormDialog({ open, onClose, product, onSave, isSaving = false, presetTypeId }) {
   const [formData, setFormData] = useState(initialFormData);
   const [pendingTypeChange, setPendingTypeChange] = useState(null);
   const { data: projectTypes = [], isLoading: projectTypesLoading } = useEntityList("ProjectType", "order");
   const { data: productCategories = [], isLoading: categoriesLoading } = useEntityList("ProductCategory");

   // Reset form data when product changes or dialog opens
   useEffect(() => {
      if (open) {
         setFormData(
            product ? {
               ...initialFormData,
               ...product,
               standard_tier: product.standard_tier || initialFormData.standard_tier,
               premium_tier: product.premium_tier || initialFormData.premium_tier,
               task_templates: product.task_templates || [],
               standard_task_templates: product.standard_task_templates || [],
               premium_task_templates: product.premium_task_templates || [],
               project_type_ids: product.project_type_ids || [],
               min_quantity: product.min_quantity || 1,
               max_quantity: product.max_quantity || null,
            } : { 
               ...initialFormData,
               project_type_ids: presetTypeId ? [presetTypeId] : []
            }
         );
      }
   }, [open, product, presetTypeId]);

  const addTaskTemplate = (tier) => {
    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData(prev => {
      const tasks = prev[key] || [];
      return {
        ...prev,
        [key]: [...tasks, { 
          title: "", 
          description: "",
          task_type: "back_office",
          auto_assign_role: "none",
          estimated_minutes: 0,
          depends_on_indices: [],
          timer_trigger: "none",
          deadline_type: "custom",
          deadline_preset: null,
          deadline_hours_after_trigger: 0
        }]
      };
    });
  };

  const updateTaskTemplate = (tier, index, field, value) => {
    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData(prev => {
      const tasks = prev[key] || [];
      if (!tasks[index]) return prev; // Safety check
      
      const updated = tasks.map((task, i) => {
        if (i !== index) return task;
        const newTask = { ...task, [field]: value };
        // If timer_trigger is set to "none", clear the deadline hours
        if (field === "timer_trigger" && value === "none") {
          newTask.deadline_hours_after_trigger = 0;
          newTask.deadline_preset = null;
        }
        return newTask;
      });
      return { ...prev, [key]: updated };
    });
  };

  const removeTaskTemplate = (tier, index) => {
    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData(prev => {
      const tasks = prev[key] || [];
      if (index < 0 || index >= tasks.length) return prev;
      return {
        ...prev,
        [key]: tasks.filter((_, i) => i !== index)
      };
    });
  };

  const handleTaskReorder = (tier, result) => {
    const { source, destination } = result;
    if (!destination) return;
    if (source.index === destination.index) return;
    if (source.index < 0 || destination.index < 0) return;

    const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
    setFormData(prev => {
      const taskList = prev[key] || [];
      if (source.index >= taskList.length || destination.index >= taskList.length) return prev;

      const original = [...taskList];
      const tasks = [...original];
      const [moved] = tasks.splice(source.index, 1);
      tasks.splice(destination.index, 0, moved);

      // Build old-index → new-index map so task dependencies stay accurate after reorder
      const oldToNew = new Array(original.length).fill(-1);
      tasks.forEach((task, newIdx) => {
        const oldIdx = original.findIndex(t => t === task);
        if (oldIdx !== -1) oldToNew[oldIdx] = newIdx;
      });

      const remapped = tasks.map(task => ({
        ...task,
        depends_on_indices: (task?.depends_on_indices || [])
          .map(oldIdx => oldToNew[oldIdx])
          .filter(newIdx => newIdx !== -1 && newIdx !== undefined)
      }));

      return { ...prev, [key]: remapped };
    });
  };

  const copyTasksToOtherTier = (fromTier) => {
    const fromKey = fromTier === "standard" ? "standard_task_templates" : "premium_task_templates";
    const toKey = fromTier === "standard" ? "premium_task_templates" : "standard_task_templates";
    const toLabel = fromTier === "standard" ? "Premium" : "Standard";
    setFormData(prev => {
      const sourceTasks = prev[fromKey] || [];
      if (sourceTasks.length === 0) {
        toast.info(`No ${fromTier} tasks to copy`);
        return prev;
      }
      return {
        ...prev,
        [toKey]: JSON.parse(JSON.stringify(sourceTasks))
      };
    });
    toast.success(`Tasks copied to ${toLabel} tier`);
  };

  const handleSubmit = () => {
    if (!formData.name?.trim()) {
      toast.error("Service name is required.");
      return;
    }
    // Trim the name to prevent whitespace-padded names
    formData.name = formData.name.trim();
    formData.description = (formData.description || '').trim();

    // Validate min_quantity is a positive integer (HTML min is easily bypassed)
    const minQty = parseInt(formData.min_quantity, 10);
    if (isNaN(minQty) || minQty < 1) {
      toast.error("Minimum quantity must be at least 1.");
      return;
    }

    // Validate min/max quantity
    if (formData.min_quantity < 1) {
      toast.error("Minimum quantity must be at least 1.");
      return;
    }
    if (formData.max_quantity && formData.max_quantity < formData.min_quantity) {
      toast.error("Maximum quantity cannot be less than minimum quantity.");
      return;
    }

    // Validate pricing for per_unit products
    if (formData.pricing_type === "per_unit") {
      const stdTier = formData.standard_tier || {};
      const preTier = formData.premium_tier || {};
      const stdOk = (parseFloat(stdTier.unit_price) > 0) || (parseFloat(stdTier.base_price) > 0);
      const preOk = (parseFloat(preTier.unit_price) > 0) || (parseFloat(preTier.base_price) > 0);
      if (!stdOk) {
        toast.error("Per-unit products must have a Standard tier unit price or base price.");
        return;
      }
      if (!preOk) {
        toast.error("Per-unit products must have a Premium tier unit price or base price.");
        return;
      }
    }

    // Validate category exists if assigned — check against dynamic categories from DB
    if (formData.category && formData.category.trim()) {
      const categoryLower = formData.category.toLowerCase().trim();
      const matchesStaticFallback = ['photography', 'video', 'drone', 'editing', 'virtual_staging', 'other', 'drones', 'floorplan'].includes(categoryLower);
      const matchesDynamic = productCategories.some(c => c?.name?.toLowerCase().trim() === categoryLower && c.is_active !== false);
      if (!matchesStaticFallback && !matchesDynamic) {
        toast.error(`Category "${formData.category}" is no longer valid. Please select another category.`);
        return;
      }
    }

    // Validate project types exist
    if (formData.project_type_ids && formData.project_type_ids.length > 0) {
      const invalidTypes = formData.project_type_ids.filter(
        typeId => !projectTypes.find(t => t?.id === typeId && t.is_active !== false)
      );
      if (invalidTypes.length > 0) {
        toast.error("One or more selected project types no longer exist. Please update your selection.");
        return;
      }
    }

    // Validate circular dependencies in task templates
    const validateDependencies = (tasks) => {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const deps = task.depends_on_indices || [];
        if (deps.includes(i)) {
          toast.error(`Task "${task.title || `Task ${i+1}`}" cannot depend on itself.`);
          return false;
        }
        // Check for circular refs (simplified - only checks direct loops)
        for (const depIdx of deps) {
          const depTask = tasks[depIdx];
          if (depTask?.depends_on_indices?.includes(i)) {
            toast.error(`Circular dependency detected between tasks.`);
            return false;
          }
        }
      }
      return true;
    };

    if (formData.standard_task_templates?.length > 0) {
      if (!validateDependencies(formData.standard_task_templates)) return;
    }
    if (formData.premium_task_templates?.length > 0) {
      if (!validateDependencies(formData.premium_task_templates)) return;
    }

    onSave(formData);
  };

  const updateTier = (tier, field, value) => {
    setFormData(prev => {
      const currentTier = prev[tier] || {};
      const numValue = parseFloat(value);
      const finalValue = isNaN(numValue) ? 0 : Math.max(0, numValue);
      
      return {
        ...prev,
        [tier]: {
          ...currentTier,
          [field]: finalValue
        }
      };
    });
  };

  // Loading state while fetching data
  if (projectTypesLoading || categoriesLoading) {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl">
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="pb-4">
            <DialogTitle className="text-2xl">{product ? "Edit Service" : "Create New Service"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
           {/* Project Type & Category — Primary Filters */}
           {projectTypes.filter(t => t.is_active !== false).length > 0 && (
             <div className="space-y-4">
               <div>
                 <h3 className="text-sm font-semibold text-foreground">Project Type</h3>
                 <p className="text-xs text-muted-foreground mt-0.5">Leave empty for all types, or select one to assign a category</p>
               </div>
               
               <div className="flex flex-wrap gap-2">
                 {(projectTypes || []).filter(t => t?.is_active !== false).map(type => {
                 if (!type?.id) return null;
                 const isSelected = (formData.project_type_ids || []).includes(type.id);
                 return (
                 <button
                 key={type.id}
                 type="button"
                 onClick={() => {
                 if (product && isSelected) {
                 // Deselecting requires confirmation for existing products
                 setPendingTypeChange({ action: "deselect", typeId: type.id, typeName: type.name });
                 } else {
                 setFormData(prev => ({ 
                 ...prev, 
                 project_type_ids: isSelected ? [] : [type.id],
                 category: isSelected ? prev.category : ""
                 }));
                 }
                 }}
                 className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-md hover:shadow-lg border-2 ${
                 isSelected 
                 ? "opacity-100 cursor-pointer" 
                 : "opacity-40 cursor-pointer hover:opacity-60"
                 }`}
                 style={{
                 backgroundColor: isSelected ? (type.color || "#3b82f6") : "transparent",
                 color: isSelected ? "white" : (type.color || "#3b82f6"),
                 borderColor: type.color || "#3b82f6"
                 }}
                 >
                 {type.name}
                 {isSelected && <span className="ml-2">✓</span>}
                 </button>
                 );
                 })}
               </div>

               {/* Category Selection — Only when Project Type is selected */}
               {(formData.project_type_ids || []).length > 0 && formData.project_type_ids[0] && (
                 <div className="mt-6 pt-4 border-t">
                   <div>
                     <h3 className="text-sm font-semibold text-foreground">Category</h3>
                     <p className="text-xs text-muted-foreground mt-0.5">
                       Category for {projectTypes.find(t => t?.id === formData.project_type_ids[0])?.name || 'selected project type'}
                     </p>
                   </div>

                   <Select value={formData.category || ""} onValueChange={(v) => setFormData(prev => ({ ...prev, category: v }))}>
                     <SelectTrigger className="mt-3">
                       <SelectValue placeholder="Select a category" />
                     </SelectTrigger>
                     <SelectContent>
                       {productCategories
                         .filter(cat => cat && cat.is_active !== false && cat.project_type_id === formData.project_type_ids[0])
                         .map(cat => (
                           <SelectItem key={cat.id} value={cat.name}>
                             {cat.icon && <span className="mr-2">{cat.icon}</span>}
                             {cat.name}
                           </SelectItem>
                         ))}
                     </SelectContent>
                   </Select>
                 </div>
               )}
             </div>
           )}

           {/* Basic Information */}
           <div className="space-y-4">
             <div>
               <h3 className="text-sm font-semibold text-foreground">Service Details</h3>
             </div>

             <div>
               <Label htmlFor="name" className="text-xs font-medium text-muted-foreground">Service Name *</Label>
               <Input
                 id="name"
                 value={formData.name || ""}
                 onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                 placeholder="e.g. +1 Rental Image"
                 className="mt-2"
                 maxLength={120}
               />
             </div>

              <div>
                <Label htmlFor="description" className={`text-xs font-medium ${formData.is_active ? "text-muted-foreground" : "text-muted-foreground/50"}`}>Description</Label>
                <Textarea
                  id="description"
                  disabled={!formData.is_active}
                  value={formData.description || ""}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Describe this service"
                  rows={2}
                  maxLength={1000}
                  className={`mt-2 ${!formData.is_active ? "bg-muted/50 cursor-not-allowed" : ""}`}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="type" className={`text-xs font-medium ${formData.is_active ? "text-muted-foreground" : "text-muted-foreground/50"}`}>Service Type</Label>
                  <Select value={formData.product_type} onValueChange={(v) => formData.is_active && setFormData(prev => ({ ...prev, product_type: v }))}>
                    <SelectTrigger id="type" className={`mt-2 ${!formData.is_active ? "bg-muted/50 cursor-not-allowed" : ""}`} disabled={!formData.is_active}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="core">Core Service</SelectItem>
                      <SelectItem value="addon">Upsell/Add-on</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="pricing" className={`text-xs font-medium ${formData.is_active ? "text-muted-foreground" : "text-muted-foreground/50"}`}>Pricing Model</Label>
                  <Select value={formData.pricing_type} onValueChange={(v) => formData.is_active && setFormData(prev => ({ ...prev, pricing_type: v }))}>
                    <SelectTrigger id="pricing" className={`mt-2 ${!formData.is_active ? "bg-muted/50 cursor-not-allowed" : ""}`} disabled={!formData.is_active}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed Price</SelectItem>
                      <SelectItem value="per_unit">Per Unit (Quantity-Based)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
               <div>
                 <Label htmlFor="min" className="text-xs font-medium text-muted-foreground">Minimum Quantity</Label>
                 <Input
                   id="min"
                   type="number"
                   min="1"
                   value={formData.min_quantity ?? 1}
                   onChange={(e) => {
                     const val = parseInt(e.target.value, 10);
                     setFormData(prev => ({ ...prev, min_quantity: isNaN(val) || val < 1 ? 1 : Math.max(1, val) }));
                   }}
                   className="mt-2"
                 />
               </div>
                <div>
                  <Label htmlFor="max" className="text-xs font-medium text-muted-foreground">Maximum Quantity</Label>
                  <Input
                    id="max"
                    type="number"
                    min={formData.min_quantity ?? 1}
                    disabled={formData.pricing_type === "fixed"}
                    value={formData.max_quantity ?? ""}
                    onChange={(e) => {
                      const val = e.target.value ? parseInt(e.target.value, 10) : null;
                      const minQty = formData.min_quantity ?? 1;
                      setFormData(prev => ({ 
                        ...prev, 
                        max_quantity: val && !isNaN(val) && val >= minQty ? Math.max(minQty, val) : null 
                      }));
                    }}
                    placeholder="No limit"
                    className="mt-2"
                  />
                  {formData.pricing_type === "fixed" && (
                    <p className="text-xs text-muted-foreground mt-1">Only for per-unit pricing</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                <Switch
                  id="dusk"
                  checked={formData.dusk_only}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, dusk_only: checked }))}
                />
                <Label htmlFor="dusk" className="flex-1 cursor-pointer">Dusk Only Services</Label>
              </div>
            </div>

               {/* Pricing Tiers */}
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Pricing & Time Allocation</h3>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              {["standard_tier", "premium_tier"].map((tier) => (
                <Card key={tier} className="border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      {tier === "standard_tier" ? "Standard" : "Premium"}
                      <Badge variant="secondary" className="text-xs">{tier === "standard_tier" ? "STD" : "PRE"}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Pricing</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">Base Price</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            disabled={!formData.is_active}
                            value={formData[tier]?.base_price ?? 0}
                            onChange={(e) => formData.is_active && updateTier(tier, "base_price", e.target.value)}
                            placeholder="0.00"
                            className={`h-8 text-sm ${!formData.is_active ? "bg-muted/50 cursor-not-allowed" : ""}`}
                          />
                        </div>
                        <div>
                          <Label className={`text-xs ${formData.pricing_type === "per_unit" ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
                            Unit Price {formData.pricing_type === "per_unit" && <span className="text-destructive">*</span>}
                          </Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            disabled={!formData.is_active}
                            value={formData[tier]?.unit_price ?? 0}
                            onChange={(e) => formData.is_active && updateTier(tier, "unit_price", e.target.value)}
                            placeholder="0.00"
                            className={`h-8 text-sm ${formData.pricing_type === "per_unit" && !(formData[tier]?.unit_price) && !(formData[tier]?.base_price) ? "border-destructive" : ""} ${!formData.is_active ? "bg-muted/50 cursor-not-allowed" : ""}`}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Onsite Time</Label>
                      <p className="text-xs text-muted-foreground">Admin/editor estimated time is now set per task template below.</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">Onsite Base (min)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={formData[tier]?.onsite_time ?? 0}
                            onChange={(e) => updateTier(tier, "onsite_time", e.target.value)}
                            placeholder="0"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Per Unit Add (min)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={formData[tier]?.onsite_time_increment ?? 0}
                            onChange={(e) => updateTier(tier, "onsite_time_increment", e.target.value)}
                            placeholder="0"
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* Automation & Notifications */}
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Automations & Notifications</h3>
            </div>
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Task Templates</CardTitle>
                  <CardDescription>Auto-create tasks when this service is booked. Define separate tasks per tier.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid md:grid-cols-2 gap-4">
                    {useMemo(() => ["standard", "premium"].map((tier) => {
                      const key = tier === "standard" ? "standard_task_templates" : "premium_task_templates";
                      const tasks = formData[key] || [];
                      const isStandard = tier === "standard";
                      const accentColor = isStandard ? "bg-blue-50 border-blue-200" : "bg-amber-50 border-amber-200";
                      const badgeColor = isStandard ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700";
                      const otherLabel = isStandard ? "Premium" : "Standard";

                      return (
                        <div key={tier} className="border rounded-lg p-3 space-y-3">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full inline-block ${isStandard ? "bg-blue-500" : "bg-amber-500"}`}></span>
                            <span className="text-sm font-semibold">{isStandard ? "Standard" : "Premium"}</span>
                            {tasks.length > 0 && <Badge variant="secondary" className="text-xs h-4 px-1 ml-auto">{tasks.length}</Badge>}
                          </div>

                          {tasks.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-4 border-2 border-dashed rounded-lg text-muted-foreground gap-2">
                              <p className="text-xs">No {tier} task templates yet</p>
                              {(formData[isStandard ? "premium_task_templates" : "standard_task_templates"] || []).length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-xs gap-1"
                                  onClick={() => copyTasksToOtherTier(isStandard ? "premium" : "standard")}
                                >
                                  <Copy className="h-3 w-3" />
                                  Copy from {otherLabel}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <DragDropContext onDragEnd={(result) => handleTaskReorder(tier, result)}>
                              <Droppable droppableId={`tasks-${tier}`}>
                                {(provided, snapshot) => (
                                  <div
                                    {...provided.droppableProps}
                                    ref={provided.innerRef}
                                    className={`space-y-2 ${snapshot.isDraggingOver ? "bg-muted/30 rounded-lg p-2" : ""}`}
                                  >
                                    {tasks.map((task, index) => (
                                      <Draggable key={`${tier}-task-${index}`} draggableId={`task-${tier}-${index}`} index={index}>
                                        {(provided, snapshot) => (
                                          <div
                                            ref={provided.innerRef}
                                            {...provided.draggableProps}
                                            className={`p-3 border rounded-lg space-y-2 ${accentColor} ${snapshot.isDragging ? "shadow-lg opacity-75" : ""}`}
                                          >
                                            <div className="flex justify-between items-center gap-2">
                                              <div className="flex items-center gap-2 flex-1">
                                                <div {...provided.dragHandleProps} className="cursor-grab active:cursor-grabbing">
                                                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                                                </div>
                                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor}`}>
                                                  {isStandard ? "STD" : "PRE"} · Task {index + 1}
                                                </span>
                                              </div>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                                onClick={() => removeTaskTemplate(tier, index)}
                                              >
                                                <Trash2 className="h-3 w-3" />
                                              </Button>
                                            </div>
                                  <Input
                                   value={task?.title || ""}
                                   onChange={(e) => updateTaskTemplate(tier, index, "title", e.target.value)}
                                   placeholder="Task title"
                                   className="text-sm bg-card"
                                  />
                                  <Textarea
                                   value={task?.description || ""}
                                   onChange={(e) => updateTaskTemplate(tier, index, "description", e.target.value)}
                                   placeholder="Task description (optional)"
                                   rows={2}
                                   className="text-sm bg-card"
                                  />
                                  {/* Task Type */}
                                  <div>
                                   <Label className="text-xs text-muted-foreground mb-1 block">Task Type</Label>
                                   <Select
                                     value={task?.task_type || "back_office"}
                                     onValueChange={(v) => updateTaskTemplate(tier, index, "task_type", v)}
                                   >
                                     <SelectTrigger className="h-7 text-xs bg-card">
                                       <SelectValue />
                                     </SelectTrigger>
                                     <SelectContent>
                                       {Object.entries(TASK_TYPE_LABELS || {}).map(([val, label]) => (
                                         <SelectItem key={val} value={val} className="text-xs">{label}</SelectItem>
                                       ))}
                                     </SelectContent>
                                   </Select>
                                  </div>
                                  {/* Auto-assign role */}
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                     <Label className="text-xs text-muted-foreground mb-1 block">Auto-assign role</Label>
                                     <Select
                                       value={task?.auto_assign_role || "none"}
                                       onValueChange={(v) => updateTaskTemplate(tier, index, "auto_assign_role", v)}
                                     >
                                       <SelectTrigger className="h-7 text-xs bg-card">
                                         <SelectValue />
                                       </SelectTrigger>
                                       <SelectContent>
                                         {Object.entries(ROLE_LABELS || {}).map(([val, label]) => (
                                           <SelectItem key={val} value={val} className="text-xs">{label}</SelectItem>
                                         ))}
                                       </SelectContent>
                                     </Select>
                                    </div>
                                    <div>
                                      <Label className="text-xs text-muted-foreground mb-1 block">Estimated time (min)</Label>
                                      <Input
                                        type="number"
                                        min="0"
                                        value={task?.estimated_minutes ?? 0}
                                        onChange={(e) => {
                                          const val = parseFloat(e.target.value);
                                          updateTaskTemplate(tier, index, "estimated_minutes", isNaN(val) ? 0 : Math.max(0, val));
                                        }}
                                        placeholder="0"
                                        className="h-7 text-sm bg-card"
                                      />
                                    </div>
                                  </div>
                                   {/* Timer Trigger */}
                                  <div>
                                   <Label className="text-xs text-muted-foreground mb-1 block">When does deadline countdown start?</Label>
                                   <Select
                                     value={task?.timer_trigger || "none"}
                                     onValueChange={(v) => updateTaskTemplate(tier, index, "timer_trigger", v)}
                                   >
                                     <SelectTrigger className="h-7 text-xs bg-card">
                                       <SelectValue />
                                     </SelectTrigger>
                                     <SelectContent>
                                       <SelectItem value="none" className="text-xs">No auto-deadline</SelectItem>
                                       <SelectItem value="project_onsite" className="text-xs">Project set to Onsite</SelectItem>
                                       <SelectItem value="project_uploaded" className="text-xs">Project set to Uploaded</SelectItem>
                                       <SelectItem value="project_submitted" className="text-xs">Project set to Submitted</SelectItem>
                                       <SelectItem value="dependencies_cleared" className="text-xs">Dependencies Cleared</SelectItem>
                                     </SelectContent>
                                   </Select>
                                  </div>

                                  {/* Deadline Type Selection */}
                                  {task?.timer_trigger && task.timer_trigger !== "none" && (
                                   <div>
                                     <Label className="text-xs text-muted-foreground mb-1 block">Deadline preset or custom?</Label>
                                     <Select
                                       value={task?.deadline_type || "custom"}
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
                                       <SelectTrigger className="h-7 text-xs bg-card">
                                         <SelectValue />
                                       </SelectTrigger>
                                       <SelectContent>
                                         <SelectItem value="custom" className="text-xs">Custom (X hours)</SelectItem>
                                         <SelectItem value="preset" className="text-xs">Preset Options</SelectItem>
                                       </SelectContent>
                                     </Select>
                                   </div>
                                  )}

                                  {/* Custom Deadline (Hours) */}
                                  {task?.timer_trigger && task.timer_trigger !== "none" && (task.deadline_type === "custom" || !task.deadline_type) && (
                                   <div>
                                     <Label className="text-xs text-muted-foreground mb-1 block">Hours after trigger</Label>
                                     <Input
                                       type="number"
                                       min="0"
                                       step="0.5"
                                       value={task?.deadline_hours_after_trigger ?? 24}
                                       onChange={(e) => {
                                         const val = parseFloat(e.target.value);
                                         updateTaskTemplate(tier, index, "deadline_hours_after_trigger", isNaN(val) ? 24 : Math.max(0, val));
                                       }}
                                       placeholder="e.g., 24"
                                       className="h-7 text-sm bg-card"
                                     />
                                     <p className="text-xs text-muted-foreground mt-1">Due {task?.deadline_hours_after_trigger ?? 24} hours after trigger</p>
                                   </div>
                                  )}

                                  {/* Preset Deadline Options */}
                                  {task?.timer_trigger && task.timer_trigger !== "none" && task.deadline_type === "preset" && task.deadline_preset && (
                                   <div>
                                     <Label className="text-xs text-muted-foreground mb-1 block">Deadline</Label>
                                     <Select
                                       value={task?.deadline_preset || "tonight"}
                                       onValueChange={(v) => updateTaskTemplate(tier, index, "deadline_preset", v)}
                                     >
                                       <SelectTrigger className="h-7 text-xs bg-card">
                                         <SelectValue />
                                       </SelectTrigger>
                                       <SelectContent>
                                           <SelectItem value="tonight" className="text-xs">Tonight (11:59 PM)</SelectItem>
                                           <SelectItem value="tomorrow_night" className="text-xs">Tomorrow night (11:59 PM)</SelectItem>
                                           <SelectItem value="tomorrow_am" className="text-xs">Tomorrow AM (11:59 AM)</SelectItem>
                                           <SelectItem value="tomorrow_business_am" className="text-xs">Tomorrow business AM (11:59 AM)</SelectItem>
                                           <SelectItem value="in_2_nights" className="text-xs">In 2 nights (11:59 PM)</SelectItem>
                                           <SelectItem value="in_3_nights" className="text-xs">In 3 nights (11:59 PM)</SelectItem>
                                           <SelectItem value="in_4_nights" className="text-xs">In 4 nights (11:59 PM)</SelectItem>
                                           <SelectItem value="next_business_night" className="text-xs">Next business night (11:59 PM)</SelectItem>
                                           <SelectItem value="2_business_nights" className="text-xs">In 2 business nights (11:59 PM)</SelectItem>
                                           <SelectItem value="3_business_nights" className="text-xs">In 3 business nights (11:59 PM)</SelectItem>
                                         </SelectContent>
                                     </Select>
                                     <p className="text-xs text-muted-foreground mt-1">Deadline: {task?.deadline_preset || "tonight"}</p>
                                   </div>
                                  )}

                                  {/* Dependencies within same product+tier */}
                                  {tasks.length > 1 && (
                                    <div>
                                      <Label className="text-xs text-muted-foreground mb-1 flex items-center gap-1 block">
                                        <LinkIcon className="h-3 w-3" /> Depends on (must complete first)
                                      </Label>
                                      <div className="space-y-1">
                                        {tasks.map((sibling, sibIdx) => {
                                          if (sibIdx === index) return null;
                                          const depIndices = task.depends_on_indices || [];
                                          return (
                                            <label key={sibIdx} className="flex items-center gap-1.5 cursor-pointer text-xs">
                                              <Checkbox
                                              checked={depIndices?.includes(sibIdx) ?? false}
                                              onCheckedChange={(checked) => {
                                                // Prevent circular dependencies
                                                if (checked && sibling?.depends_on_indices?.includes(index)) {
                                                  toast.error("Cannot create circular dependency");
                                                  return;
                                                }
                                                const next = checked
                                                  ? [...(depIndices || []), sibIdx]
                                                  : (depIndices || []).filter(i => i !== sibIdx);
                                                updateTaskTemplate(tier, index, "depends_on_indices", next);
                                              }}
                                              />
                                              <span className="truncate">{sibling?.title || `Task ${sibIdx + 1}`}</span>
                                            </label>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                                         </div>
                                       )}
                                     </Draggable>
                                   ))}
                                   {provided.placeholder}
                                  </div>
                                  )}
                                  </Droppable>
                                  </DragDropContext>
                                  )}

                          <div className="flex gap-2">
                            <Button onClick={() => addTaskTemplate(tier)} variant="outline" size="sm" className="flex-1">
                              <Plus className="h-3 w-3 mr-1" />
                              Add Task
                            </Button>
                            {tasks.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs gap-1 text-muted-foreground"
                                onClick={() => copyTasksToOtherTier(tier)}
                              >
                                <Copy className="h-3 w-3" />
                                Copy to {otherLabel}
                              </Button>
                            )}
                          </div>
                        </div>
                        );
                        }), [formData.standard_task_templates, formData.premium_task_templates])}
                  </div>
                </CardContent>
              </Card>

            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
           <Label htmlFor="notes" className="text-xs font-medium text-muted-foreground">Internal Notes</Label>
           <Textarea
             id="notes"
             value={formData.notes || ""}
             onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
             placeholder="Add internal notes"
             rows={3}
             className="mt-2"
           />
          </div>

          {/* Status */}
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border">
            <Switch
              id="active"
              checked={formData.is_active}
              onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
            />
            <Label htmlFor="active" className="flex-1 cursor-pointer flex items-center gap-2">
              <span>Service is Active</span>
              {formData.is_active && <Badge variant="default" className="text-xs">Active</Badge>}
            </Label>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 pt-6 border-t mt-6">
              <Button variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={isSaving}>
                {isSaving ? "Saving..." : product ? "Update Service" : "Create Service"}
              </Button>
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
                        <li>Existing projects using this service</li>
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
                      setFormData(prev => ({ 
                        ...prev, 
                        project_type_ids: [],
                        category: ""
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