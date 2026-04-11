import React, { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { toast } from "sonner";
import { wallClockToUTC } from "@/components/lib/deadlinePresets";
import { Badge } from "@/components/ui/badge";
import RevisionPricingImpact from "./RevisionPricingImpact";
import RevisionAttachments from "./RevisionAttachments";
import { writeFeedEvent } from "@/components/notifications/createNotification";
import { useCurrentUser } from "@/components/auth/PermissionGuard";

export default function EditRevisionDialog({ open, onClose, revision, project }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({});
  const { data: currentUser } = useCurrentUser();
  const [pricingImpact, setPricingImpact] = useState({});
  const [attachments, setAttachments] = useState([]);

  const { data: allProducts = [] } = useEntityList("Product", "name", 500);

  useEffect(() => {
    if (revision && open) {
      setForm({
        title: revision.title || "",
        description: revision.description || "",
        priority: revision.priority || "normal",
        due_date: revision.due_date || null,
        notes: revision.notes || "",
      });
      setPricingImpact(revision.pricing_impact || { has_impact: false, products_added: [], products_removed: [], quantity_changes: [] });
      setAttachments(revision.attachments || []);
    }
  }, [revision, open]);

  const updateMutation = useMutation({
    mutationFn: (data) => api.entities.ProjectRevision.update(revision.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-revisions'] });
      queryClient.invalidateQueries({ queryKey: ['ProjectRevision'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      refetchEntityList("ProjectRevision");
      toast.success("Request updated");
      const projectName = project?.title || project?.property_address || 'Project';
      writeFeedEvent({
        eventType: 'revision_updated', category: 'revision', severity: 'info',
        actorId: currentUser?.id, actorName: currentUser?.full_name,
        title: `Revision #${revision?.revision_number} updated`,
        description: `"${form.title || revision?.title}" on ${projectName}`,
        projectId: project?.id, projectName,
        entityType: 'revision', entityId: revision?.id,
      }).catch(() => {});
      onClose();
    },
    onError: (e) => toast.error(e.message || "Failed to update request"),
  });

  const handleSubmit = () => {
    if (!form.title?.trim()) {
      toast.error("Request title is required");
      return;
    }
    updateMutation.mutate({
      ...form,
      attachments,
      pricing_impact: pricingImpact?.has_impact ? { ...pricingImpact } : null,
    });
  };

  if (!revision) return null;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !updateMutation.isPending) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Request — {revision.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Read-Only Request Kind & Type */}
          {revision && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium block mb-1.5">Request Kind</label>
                <Badge className="w-full justify-center" variant="outline">
                  {revision.request_kind === 'change_request' ? 'Change Request' : 'Revision'}
                </Badge>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5">Media Type</label>
                <Badge className="w-full justify-center" variant="outline">
                  {revision.revision_type === 'images' ? '📷 Images' : revision.revision_type === 'drones' ? '🚁 Drones' : revision.revision_type === 'floorplan' ? '📐 Floorplan' : '🎬 Video'}
                </Badge>
              </div>
            </div>
          )}

          {/* Title */}
          <div>
            <label className="text-xs font-medium block mb-1.5">Title <span className="text-destructive">*</span></label>
            <Input
              value={form.title || ""}
              onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className={!form.title?.trim() ? "border-red-200 bg-red-50/20" : ""}
              disabled={updateMutation.isPending}
            />
            {!form.title?.trim() && <p className="text-xs text-destructive mt-0.5">Title is required</p>}
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium block mb-1.5">Details {!form.description?.trim() && <span className="text-xs text-amber-600">(recommended)</span>}</label>
            <Textarea
              placeholder="Describe what changes are needed..."
              value={form.description || ""}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3}
              className={!form.description?.trim() ? "border-amber-200 bg-amber-50/20" : ""}
              disabled={updateMutation.isPending}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Priority */}
            <div>
              <label className="text-xs font-medium block mb-1.5">Priority</label>
              <Select value={form.priority || "normal"} onValueChange={v => setForm(p => ({ ...p, priority: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Due Date */}
            <div>
              <label className="text-xs font-medium block mb-1.5">Due Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left h-9 text-sm">
                    <CalendarIcon className="h-4 w-4 mr-2 text-muted-foreground" />
                    {form.due_date
                      ? new Date(form.due_date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
                      : "Optional"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={form.due_date ? new Date(form.due_date) : undefined}
                    onSelect={date => {
                      if (!date) { setForm(p => ({ ...p, due_date: null })); return; }
                      const utc = wallClockToUTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 0, "Australia/Sydney");
                      setForm(p => ({ ...p, due_date: utc.toISOString() }));
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium block mb-1.5">Internal Notes</label>
            <Textarea
              placeholder="Any internal notes..."
              value={form.notes || ""}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              rows={2}
              disabled={updateMutation.isPending}
            />
          </div>

          {/* Attachments */}
          <RevisionAttachments
            attachments={attachments}
            onChange={setAttachments}
          />

          {/* Pricing Impact — only editable if not already applied */}
          {!revision.pricing_impact?.applied && (
            <RevisionPricingImpact
              pricingImpact={pricingImpact}
              onChange={setPricingImpact}
              project={project}
              allProducts={allProducts}
            />
          )}
          {revision.pricing_impact?.applied && (
            <p className="text-xs text-muted-foreground italic border rounded-lg p-3 bg-muted/30">
              Pricing impact has already been applied to the project and cannot be edited.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={updateMutation.isPending}>Cancel</Button>
          <Button 
            disabled={!form.title?.trim() || updateMutation.isPending} 
            onClick={handleSubmit}
            title={!form.title?.trim() ? "A title is required to save changes" : ""}
          >
            {updateMutation.isPending ? (
              <>
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current mr-2" />
                Saving...
              </>
            ) : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}