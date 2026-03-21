import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { validateField, trimFormData, LIMITS } from "@/components/hooks/useFormValidation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus } from "lucide-react";
import { toast } from "sonner";

const INITIAL_STATE = {
  name: "",
  title: "",
  agency_id: "",
  agency_name: "",
  team_id: "",
  team_name: "",
  phone: "",
  email: "",
  notes: "",
  contact_frequency_days: "",
  tags: []
};

function FieldError({ error }) {
  if (!error) return null;
  return <p className="text-xs text-destructive mt-1">{error}</p>;
}

export default function AgentForm({ agent, open, onClose, preselectedAgencyId, preselectedTeamId }) {
  const [formData, setFormData] = useState(INITIAL_STATE);
  const [errors, setErrors] = useState({});

  const { data: agencies = [], loading: agenciesLoading } = useEntityList(open ? "Agency" : null, "name");
  const { data: teams = [], loading: teamsLoading } = useEntityList(open ? "Team" : null, "name");

  const availableTeams = teams.filter(t => t.agency_id === formData.agency_id);

  useEffect(() => {
    if (open) {
      if (agent) {
        setFormData({
          ...INITIAL_STATE,
          ...agent,
          agency_id: agent.current_agency_id || "",
          team_id: agent.current_team_id || "",
          title: agent?.title || "",
          contact_frequency_days: agent?.contact_frequency_days || "",
          tags: agent?.tags || [],
        });
      } else {
        const agency = agencies.find(a => a.id === preselectedAgencyId);
        const team = teams.find(t => t.id === preselectedTeamId);
        setFormData({
          ...INITIAL_STATE,
          agency_id: preselectedAgencyId || "",
          agency_name: agency?.name || "",
          team_id: preselectedTeamId || "",
          team_name: team?.name || ""
        });
      }
    }
  }, [agent, preselectedAgencyId, preselectedTeamId, agencies, teams, open]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (!data.name?.trim()) {
        throw new Error("Agent name is required");
      }
      if (!data.agency_id) {
        throw new Error("Organisation is required");
      }
      const agency = agencies.find(a => a.id === data.agency_id);
      if (!agency) {
        throw new Error("Selected organisation not found");
      }
      const team = data.team_id ? teams.find(t => t.id === data.team_id) : null;
      const payload = {
        name: data.name,
        title: data.title || null,
        email: data.email,
        phone: data.phone,
        notes: data.notes,
        contact_frequency_days: data.contact_frequency_days ? parseInt(data.contact_frequency_days) : null,
        tags: data.tags || [],
        current_agency_id: data.agency_id,
        current_agency_name: agency.name,
        current_team_id: data.team_id || null,
        current_team_name: team?.name || null
      };
      
      const user = await api.auth.me();
      let result;
      let auditAction;
      let changedFields = [];
      
      if (agent) {
        Object.keys(payload).forEach(key => {
          if (payload[key] !== agent[key]) {
            changedFields.push({
              field: key,
              old_value: agent[key] || "",
              new_value: payload[key] || ""
            });
          }
        });
        result = await api.entities.Agent.update(agent.id, payload);
        auditAction = "update";
      } else {
        result = await api.entities.Agent.create(payload);
        auditAction = "create";
        changedFields = Object.keys(payload).map(key => ({
          field: key,
          old_value: "",
          new_value: payload[key] || ""
        }));
      }
      
      await api.entities.AuditLog.create({
        entity_type: "agent",
        entity_id: result.id,
        entity_name: data.name,
        action: auditAction,
        changed_fields: changedFields,
        previous_state: agent || {},
        new_state: result,
        user_name: user.full_name,
        user_email: user.email
      });
      
      return result;
    },
    onSuccess: () => {
      refetchEntityList("Agent");
      refetchEntityList("AuditLog");
      toast.success(agent ? "Person updated" : "Person created");
      setFormData(INITIAL_STATE);
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to save agent");
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
    if (!trimmed.agency_id) { toast.error("Please select an organisation"); return; }
    saveMutation.mutate(trimmed);
  };

  const handleAgencyChange = (agencyId) => {
    setFormData({ ...formData, agency_id: agencyId, team_id: "", team_name: "" });
  };

  const handleClose = () => {
    if (!saveMutation.isPending) {
      setFormData(INITIAL_STATE);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md" onKeyDown={(e) => {
        if (e.key === 'Escape') handleClose();
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(e); }
      }}>
        <DialogHeader>
          <DialogTitle>{agent ? "Edit Person" : "Add Person"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Organisation *</Label>
              {agencies.length === 0 && !agenciesLoading && (
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1">
                  <Plus className="h-3 w-3" />
                  Create Agency
                </Button>
              )}
            </div>
            <Select
              value={formData.agency_id}
              onValueChange={handleAgencyChange}
              required
            >
              <SelectTrigger>
                <SelectValue placeholder={agenciesLoading ? "Loading..." : "Select organisation"} />
              </SelectTrigger>
              <SelectContent>
                {agencies.length === 0 && !agenciesLoading ? (
                  <div className="p-2 text-sm text-muted-foreground">No organisations available</div>
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
            <div className="flex items-center justify-between mb-2">
              <Label>Team (Optional)</Label>
              {formData.agency_id && availableTeams.length === 0 && !teamsLoading && (
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1">
                  <Plus className="h-3 w-3" />
                  Create Team
                </Button>
              )}
            </div>
            <Select
              value={formData.team_id}
              onValueChange={(value) => setFormData({ ...formData, team_id: value === "__none__" ? "" : value })}
              disabled={!formData.agency_id}
            >
              <SelectTrigger>
                <SelectValue placeholder={teamsLoading ? "Loading..." : "Select team (optional)"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No team</SelectItem>
                {availableTeams.length === 0 && !teamsLoading && formData.agency_id ? (
                  <div className="p-2 text-sm text-muted-foreground">No teams in this organisation</div>
                ) : (
                  availableTeams.map(team => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Name *</Label>
            <Input
              value={formData.name}
              onChange={(e) => handleChange("name", e.target.value)}
              maxLength={LIMITS.name}
              className={errors.name ? "border-destructive" : ""}
              placeholder="e.g., John Smith"
              required
              autoFocus={!preselectedAgencyId}
            />
            <FieldError error={errors.name} />
          </div>
          <div>
            <Label>Title / Role</Label>
            <Input
              value={formData.title}
              onChange={(e) => handleChange("title", e.target.value)}
              maxLength={LIMITS.title}
              placeholder="e.g., Senior Sales Agent"
            />
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
                placeholder="e.g., 0412 345 678"
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
                placeholder="e.g., john@agency.com.au"
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
          <div>
            <Label className="text-xs text-muted-foreground">Contact every (days)</Label>
            <Input
              type="number"
              min={7}
              max={365}
              value={formData.contact_frequency_days}
              onChange={e => setFormData(prev => ({
                ...prev,
                contact_frequency_days: e.target.value ? parseInt(e.target.value) : ""
              }))}
              placeholder="e.g. 30 for monthly, 90 for quarterly"
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Tags (comma separated)</Label>
            <Input
              value={Array.isArray(formData.tags) ? formData.tags.join(", ") : ""}
              onChange={e => {
                const tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
                setFormData(prev => ({ ...prev, tags }));
              }}
              placeholder="e.g. VIP, Referral source, High volume"
              className="h-8 text-sm mt-1"
            />
            {Array.isArray(formData.tags) && formData.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {formData.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending || !formData.name?.trim() || !formData.agency_id} title="Ctrl+S to save">
              {saveMutation.isPending ? "Saving..." : (agent ? "Save Changes" : "Create Person")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}