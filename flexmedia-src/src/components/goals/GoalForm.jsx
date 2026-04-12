import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { GOAL_STAGES, GOAL_CATEGORIES, GOAL_QUARTERS } from "@/components/goals/goalStatuses";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Target, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { refetchEntityList } from "@/components/hooks/useEntityData";

// ── Helpers ────────────────────────────────────────────────────────────────────

const INITIAL_FORM = {
  title: "",
  title_desc: "",
  goal_category: "",
  goal_business_area: "",
  goal_target_quarter: "",
  goal_priority: 3,
  goal_vision: "",
  project_owner_id: "",
  parent_goal_id: "",
  status: "goal_not_started",
};

function FieldError({ error }) {
  if (!error) return null;
  return (
    <p className="text-xs text-destructive mt-1 flex items-center gap-1" role="alert">
      <AlertCircle className="h-3 w-3 flex-shrink-0" />
      {error}
    </p>
  );
}

const PRIORITY_LABELS = {
  1: "Low",
  2: "Below Average",
  3: "Normal",
  4: "High",
  5: "Critical",
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function GoalForm({ goal, open, onClose, onSave }) {
  const { isManagerOrAbove } = usePermissions();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});

  // Populate form when opening in edit mode or reset when creating
  useEffect(() => {
    if (!open) return;
    if (goal) {
      setFormData({
        title: goal.title || "",
        title_desc: goal.title_desc || "",
        goal_category: goal.goal_category || "",
        goal_business_area: goal.goal_business_area || "",
        goal_target_quarter: goal.goal_target_quarter || "",
        goal_priority: goal.goal_priority ?? 3,
        goal_vision: goal.goal_vision || "",
        project_owner_id: goal.project_owner_id || "",
        parent_goal_id: goal.parent_goal_id || "",
        status: goal.status || "goal_not_started",
      });
    } else {
      setFormData(INITIAL_FORM);
    }
    setErrors({});
  }, [goal, open]);

  // Load users for owner select
  const { data: users = [], isLoading: loadingUsers } = useQuery({
    queryKey: ["users-for-goal-form"],
    queryFn: () => api.entities.User.list("full_name"),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  // Load existing goals for parent select
  const { data: existingGoals = [], isLoading: loadingGoals } = useQuery({
    queryKey: ["goals-for-parent-select"],
    queryFn: () => api.entities.Project.filter({ source: "goal" }),
    enabled: open,
    staleTime: 2 * 60 * 1000,
  });

  // Filter out the current goal from parent options (can't be its own parent)
  const parentOptions = existingGoals.filter((g) => g.id !== goal?.id);

  // ── Field change ────────────────────────────────────────────────────────────

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error on change
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  // ── Validation ──────────────────────────────────────────────────────────────

  const validate = () => {
    const errs = {};
    if (!formData.title?.trim()) {
      errs.title = "Title is required";
    } else if (formData.title.trim().length > 200) {
      errs.title = "Title must be 200 characters or fewer";
    }
    if (formData.title_desc && formData.title_desc.length > 1000) {
      errs.title_desc = "Description must be 1000 characters or fewer";
    }
    if (formData.goal_vision && formData.goal_vision.length > 2000) {
      errs.goal_vision = "Vision must be 2000 characters or fewer";
    }
    const priority = Number(formData.goal_priority);
    if (priority < 1 || priority > 5 || !Number.isInteger(priority)) {
      errs.goal_priority = "Priority must be between 1 and 5";
    }
    return errs;
  };

  // ── Save mutation ───────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const payload = {
        ...data,
        goal_priority: Number(data.goal_priority),
        // Coerce empty strings to null for FK fields
        project_owner_id: data.project_owner_id || null,
        parent_goal_id: data.parent_goal_id || null,
        goal_category: data.goal_category || null,
        goal_target_quarter: data.goal_target_quarter || null,
      };

      if (goal?.id) {
        return api.entities.Project.update(goal.id, payload);
      } else {
        return api.entities.Project.create({
          ...payload,
          source: "goal",
          status: payload.status || "goal_not_started",
        });
      }
    },
    onSuccess: () => {
      toast.success(goal ? "Goal updated" : "Goal created");
      // Invalidate React Query caches
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      queryClient.invalidateQueries({ queryKey: ["goals-for-parent-select"] });
      // Bust the useEntityData module-level cache
      refetchEntityList("Project");
      onSave?.();
      onClose();
    },
    onError: (err) => {
      console.error("[GoalForm] save error:", err);
      toast.error(err?.message || "Failed to save goal. Please try again.");
    },
  });

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!isManagerOrAbove) {
      toast.error("You need manager or above permissions to create goals");
      return;
    }

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    saveMutation.mutate(formData);
  };

  // ── Permission gate ─────────────────────────────────────────────────────────

  const canEdit = isManagerOrAbove;
  const isEditMode = !!goal?.id;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            {isEditMode ? "Edit Goal" : "New Goal"}
          </DialogTitle>
          {!canEdit && (
            <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mt-1">
              View only — manager or above permissions required to save
            </p>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-1">

          {/* Title */}
          <div>
            <Label htmlFor="goal-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="goal-title"
              value={formData.title}
              onChange={(e) => handleChange("title", e.target.value)}
              placeholder="e.g., Grow revenue by 30% this year"
              maxLength={200}
              disabled={!canEdit || saveMutation.isPending}
              className={errors.title ? "border-destructive" : ""}
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "goal-title-error" : undefined}
            />
            <FieldError error={errors.title} />
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="goal-title-desc">Description</Label>
            <Textarea
              id="goal-title-desc"
              value={formData.title_desc}
              onChange={(e) => handleChange("title_desc", e.target.value)}
              placeholder="Brief description of what this goal entails"
              rows={2}
              maxLength={1000}
              disabled={!canEdit || saveMutation.isPending}
              className={errors.title_desc ? "border-destructive" : ""}
            />
            {formData.title_desc?.length > 900 && (
              <p className="text-[11px] text-muted-foreground mt-0.5 text-right">
                {formData.title_desc.length}/1000
              </p>
            )}
            <FieldError error={errors.title_desc} />
          </div>

          {/* Category + Business Area */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="goal-category">Category</Label>
              <Select
                value={formData.goal_category}
                onValueChange={(v) => handleChange("goal_category", v)}
                disabled={!canEdit || saveMutation.isPending}
              >
                <SelectTrigger id="goal-category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— None —</SelectItem>
                  {GOAL_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="goal-business-area">Business Area</Label>
              <Input
                id="goal-business-area"
                value={formData.goal_business_area}
                onChange={(e) => handleChange("goal_business_area", e.target.value)}
                placeholder="e.g., Sales, Marketing"
                maxLength={100}
                disabled={!canEdit || saveMutation.isPending}
              />
            </div>
          </div>

          {/* Target Quarter + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="goal-quarter">Target Quarter</Label>
              <Select
                value={formData.goal_target_quarter}
                onValueChange={(v) => handleChange("goal_target_quarter", v)}
                disabled={!canEdit || saveMutation.isPending}
              >
                <SelectTrigger id="goal-quarter">
                  <SelectValue placeholder="Select quarter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— None —</SelectItem>
                  {GOAL_QUARTERS.map((q) => (
                    <SelectItem key={q} value={q}>
                      {q}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="goal-priority">
                Priority{" "}
                <span className="text-muted-foreground font-normal">
                  ({PRIORITY_LABELS[formData.goal_priority] || formData.goal_priority})
                </span>
              </Label>
              <Select
                value={String(formData.goal_priority)}
                onValueChange={(v) => handleChange("goal_priority", Number(v))}
                disabled={!canEdit || saveMutation.isPending}
              >
                <SelectTrigger id="goal-priority" className={errors.goal_priority ? "border-destructive" : ""}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} — {PRIORITY_LABELS[n]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError error={errors.goal_priority} />
            </div>
          </div>

          {/* Status */}
          <div>
            <Label htmlFor="goal-status">Status</Label>
            <Select
              value={formData.status}
              onValueChange={(v) => handleChange("status", v)}
              disabled={!canEdit || saveMutation.isPending}
            >
              <SelectTrigger id="goal-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GOAL_STAGES.map((stage) => (
                  <SelectItem key={stage.value} value={stage.value}>
                    {stage.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Owner */}
          <div>
            <Label htmlFor="goal-owner">Goal Owner</Label>
            <Select
              value={formData.project_owner_id}
              onValueChange={(v) => handleChange("project_owner_id", v)}
              disabled={!canEdit || saveMutation.isPending || loadingUsers}
            >
              <SelectTrigger id="goal-owner">
                {loadingUsers ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading users…
                  </span>
                ) : (
                  <SelectValue placeholder="Assign an owner" />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">— Unassigned —</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.full_name || u.email || u.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Parent Goal */}
          <div>
            <Label htmlFor="goal-parent">
              Parent Goal{" "}
              <span className="text-muted-foreground font-normal text-xs">(optional)</span>
            </Label>
            <Select
              value={formData.parent_goal_id}
              onValueChange={(v) => handleChange("parent_goal_id", v)}
              disabled={!canEdit || saveMutation.isPending || loadingGoals}
            >
              <SelectTrigger id="goal-parent">
                {loadingGoals ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading goals…
                  </span>
                ) : (
                  <SelectValue placeholder="Link to a parent goal" />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">— No parent —</SelectItem>
                {parentOptions.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.title || g.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Vision */}
          <div>
            <Label htmlFor="goal-vision">Vision Statement</Label>
            <Textarea
              id="goal-vision"
              value={formData.goal_vision}
              onChange={(e) => handleChange("goal_vision", e.target.value)}
              placeholder="Describe the long-term vision or outcome this goal contributes to…"
              rows={3}
              maxLength={2000}
              disabled={!canEdit || saveMutation.isPending}
              className={errors.goal_vision ? "border-destructive" : ""}
            />
            {formData.goal_vision?.length > 1800 && (
              <p className="text-[11px] text-muted-foreground mt-0.5 text-right">
                {formData.goal_vision.length}/2000
              </p>
            )}
            <FieldError error={errors.goal_vision} />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canEdit || saveMutation.isPending}
              className="min-w-[90px]"
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Saving…
                </>
              ) : isEditMode ? (
                "Save Changes"
              ) : (
                "Create Goal"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
