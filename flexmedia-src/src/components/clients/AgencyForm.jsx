import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { validateField, trimFormData, LIMITS } from "@/components/hooks/useFormValidation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Users, Building2 } from "lucide-react";
import { toast } from "sonner";

const RELATIONSHIP_STATES = ['Prospecting', 'Active', 'Dormant', 'Do Not Contact'];

const INITIAL_STATE = {
  name: "",
  address: "",
  phone: "",
  email: "",
  notes: "",
  relationship_state: "Prospecting",
  onboarding_date: ""
};

function FieldError({ error }) {
  if (!error) return null;
  return <p className="text-xs text-destructive mt-1">{error}</p>;
}

export default function AgencyForm({ agency, open, onClose }) {
  const [formData, setFormData] = useState(INITIAL_STATE);
  const [errors, setErrors] = useState({});

  const { data: teams = [] } = useEntityList(open && agency ? "Team" : null, "name");
  const { data: agents = [] } = useEntityList(open && agency ? "Agent" : null, "name");

  const agencyTeams = teams.filter(t => t.agency_id === agency?.id);
  const agencyAgents = agents.filter(a => a.current_agency_id === agency?.id);

  useEffect(() => {
    if (open) {
      setFormData(agency || INITIAL_STATE);
    }
  }, [agency, open]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (!data.name?.trim()) {
        throw new Error("Agency name is required");
      }
      
      const user = await base44.auth.me();
      let result;
      let auditAction;
      let changedFields = [];
      
      if (agency) {
        // Track changes
        Object.keys(data).forEach(key => {
          if (data[key] !== agency[key]) {
            changedFields.push({
              field: key,
              old_value: agency[key] || "",
              new_value: data[key] || ""
            });
          }
        });
        result = await base44.entities.Agency.update(agency.id, data);
        auditAction = "update";
      } else {
        result = await base44.entities.Agency.create(data);
        auditAction = "create";
        changedFields = Object.keys(data).map(key => ({
          field: key,
          old_value: "",
          new_value: data[key] || ""
        }));
      }
      
      // Create audit log
      await base44.entities.AuditLog.create({
        entity_type: "agency",
        entity_id: result.id,
        entity_name: data.name,
        action: auditAction,
        changed_fields: changedFields,
        previous_state: agency || {},
        new_state: result,
        user_name: user.full_name,
        user_email: user.email
      });
      
      return result;
    },
    onSuccess: () => {
      refetchEntityList("Agency");
      refetchEntityList("AuditLog");
      toast.success(agency ? "Organisation updated" : "Organisation created");
      setFormData(INITIAL_STATE);
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to save organisation");
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
      <DialogContent className="max-w-md" onKeyDown={(e) => {
        if (e.key === 'Escape') handleClose();
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(e); }
      }}>
        <DialogHeader>
          <DialogTitle>{agency ? "Edit Organisation" : "Add Organisation"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Organisation Name *</Label>
            <Input
              value={formData.name}
              onChange={(e) => handleChange("name", e.target.value)}
              maxLength={LIMITS.name}
              className={errors.name ? "border-destructive" : ""}
              placeholder="e.g., Ray White Real Estate"
              required
              autoFocus
            />
            <FieldError error={errors.name} />
          </div>
          <div>
            <Label>Address</Label>
            <Input
              value={formData.address}
              onChange={(e) => handleChange("address", e.target.value)}
              maxLength={LIMITS.address}
              placeholder="e.g., 456 Business St, Melbourne VIC 3000"
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
                placeholder="e.g., 1300 123 456"
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
                placeholder="e.g., info@agency.com.au"
              />
              <FieldError error={errors.email} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Relationship State</Label>
              <Select
                value={formData.relationship_state || "Prospecting"}
                onValueChange={(value) => setFormData(prev => ({ ...prev, relationship_state: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {RELATIONSHIP_STATES.map(state => (
                    <SelectItem key={state} value={state}>{state}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Onboarding Date</Label>
              <Input
                type="date"
                value={formData.onboarding_date ? formData.onboarding_date.slice(0, 10) : ""}
                onChange={(e) => setFormData(prev => ({ ...prev, onboarding_date: e.target.value || "" }))}
              />
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

          {agency && (
            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Teams</span>
                  <Badge variant="secondary">{agencyTeams.length}</Badge>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Agents</span>
                  <Badge variant="secondary">{agencyAgents.length}</Badge>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending || !formData.name?.trim()} title="Ctrl+S to save">
              {saveMutation.isPending ? "Saving..." : (agency ? "Save Changes" : "Create Organisation")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}