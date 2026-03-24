import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { validateField, trimFormData, LIMITS } from "@/components/hooks/useFormValidation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Users } from "lucide-react";
import { toast } from "sonner";

const INITIAL_STATE = {
  name: "",
  agency_id: "",
  agency_name: "",
  phone: "",
  email: "",
  notes: ""
};

function FieldError({ error }) {
  if (!error) return null;
  return <p className="text-xs text-destructive mt-1">{error}</p>;
}

export default function TeamForm({ team, open, onClose, preselectedAgencyId }) {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState(INITIAL_STATE);
  const [errors, setErrors] = useState({});

  const { data: agencies = [], isLoading: agenciesLoading } = useQuery({
    queryKey: ["agencies"],
    queryFn: () => api.entities.Agency.list("name"),
    enabled: open
  });

  const { data: allAgents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.entities.Agent.list("name"),
    enabled: open && !!team
  });

  const teamAgents = allAgents.filter(a => a.current_team_id === team?.id);

  useEffect(() => {
    if (open) {
      if (team) {
        setFormData({
          ...INITIAL_STATE,
          name: team.name || "",
          agency_id: team.agency_id || "",
          agency_name: team.agency_name || "",
          phone: team.phone || "",
          email: team.email || "",
          notes: team.notes || "",
        });
      } else if (preselectedAgencyId) {
        const agency = agencies.find(a => a.id === preselectedAgencyId);
        setFormData({
          ...INITIAL_STATE,
          agency_id: preselectedAgencyId,
          agency_name: agency?.name || ""
        });
      } else {
        setFormData(INITIAL_STATE);
      }
    }
  }, [team, preselectedAgencyId, agencies, open]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (!data.name?.trim()) {
        throw new Error("Team name is required");
      }
      if (!data.agency_id) {
        throw new Error("Agency is required");
      }
      const agency = agencies.find(a => a.id === data.agency_id);
      if (!agency) {
        throw new Error("Selected agency not found");
      }
      const payload = { ...data, agency_name: agency.name };
      
      const user = await api.auth.me();
      let result;
      let auditAction;
      let changedFields = [];
      
      if (team) {
        Object.keys(payload).forEach(key => {
          if (payload[key] !== team[key]) {
            changedFields.push({
              field: key,
              old_value: team[key] || "",
              new_value: payload[key] || ""
            });
          }
        });
        result = await api.entities.Team.update(team.id, payload);
        auditAction = "update";

        // Cascade team name change to denormalized fields on agents
        // Fix: use allSettled so one agent failure doesn't abort the rest
        if (payload.name && payload.name !== team.name) {
          try {
            const teamAgents = await api.entities.Agent.filter({ current_team_id: team.id });
            const results = await Promise.allSettled(teamAgents.map(a =>
              api.entities.Agent.update(a.id, { current_team_name: payload.name })
            ));
            const failed = results.filter(r => r.status === 'rejected');
            if (failed.length > 0) {
              console.warn(`Team name cascade: ${failed.length}/${results.length} agent updates failed`);
            }
          } catch { /* non-fatal */ }
        }
      } else {
        result = await api.entities.Team.create(payload);
        auditAction = "create";
        changedFields = Object.keys(payload).map(key => ({
          field: key,
          old_value: "",
          new_value: payload[key] || ""
        }));
      }
      
      await api.entities.AuditLog.create({
        entity_type: "team",
        entity_id: result.id,
        entity_name: data.name,
        action: auditAction,
        changed_fields: changedFields,
        previous_state: team || {},
        new_state: result,
        user_name: user.full_name,
        user_email: user.email
      });
      
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
      refetchEntityList("Team");
      refetchEntityList("Agent");
      refetchEntityList("AuditLog");
      refetchEntityList("Project");
      toast.success(team ? "Team updated" : "Team created");
      setFormData(INITIAL_STATE);
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to save team");
    }
  });

  const handleChange = (field, value) => {
    const trimmed = typeof value === "string" ? value.slice(0, LIMITS[field] ?? LIMITS.short ?? 255) : value;
    setFormData(prev => ({ ...prev, [field]: trimmed }));
    setErrors(prev => ({ ...prev, [field]: validateField(field, trimmed) }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = trimFormData(formData);
    const newErrors = { name: validateField("name", trimmed.name), email: validateField("email", trimmed.email), phone: validateField("phone", trimmed.phone) };
    setErrors(newErrors);
    if (Object.values(newErrors).some(Boolean)) return;
    if (!trimmed.agency_id) { toast.error("Please select an agency"); return; }
    saveMutation.mutate(trimmed);
  };

  const handleClose = () => {
    if (!saveMutation.isPending) {
      setFormData(INITIAL_STATE);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{team ? "Edit Team" : "Add Team"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Agency *</Label>
              {agencies.length === 0 && !agenciesLoading && (
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1">
                  <Plus className="h-3 w-3" />
                  Create Agency
                </Button>
              )}
            </div>
            <Select
              value={formData.agency_id}
              onValueChange={(value) => setFormData({ ...formData, agency_id: value })}
              required
            >
              <SelectTrigger>
                <SelectValue placeholder={agenciesLoading ? "Loading..." : "Select agency"} />
              </SelectTrigger>
              <SelectContent>
                {agencies.length === 0 && !agenciesLoading ? (
                  <div className="p-2 text-sm text-muted-foreground">No agencies available</div>
                ) : (
                  agencies.map(agency => (
                    <SelectItem key={agency.id} value={agency.id}>
                      {agency.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Team Name *</Label>
            <Input
              value={formData.name}
              onChange={(e) => handleChange("name", e.target.value)}
              maxLength={LIMITS.name}
              className={errors.name ? "border-destructive" : ""}
              required
            />
            <FieldError error={errors.name} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Phone</Label>
              <Input
                type="tel"
                value={formData.phone}
                onChange={(e) => handleChange("phone", e.target.value)}
                maxLength={LIMITS.phone}
                className={errors.phone ? "border-destructive" : ""}
              />
              <FieldError error={errors.phone} />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => handleChange("email", e.target.value)}
                maxLength={LIMITS.email}
                className={errors.email ? "border-destructive" : ""}
              />
              <FieldError error={errors.email} />
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={formData.notes}
              onChange={(e) => handleChange("notes", e.target.value)}
              maxLength={LIMITS.notes}
              rows={3}
            />
            <p className="text-xs text-muted-foreground mt-1 text-right">{(formData.notes || "").length}/{LIMITS.notes}</p>
          </div>
          
          {team && (
            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Agents</span>
                  <Badge variant="secondary">{teamAgents.length}</Badge>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending || !formData.name?.trim() || !formData.agency_id}>
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}