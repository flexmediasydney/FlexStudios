import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateField, trimFormData, LIMITS } from "@/components/hooks/useFormValidation";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { api } from "@/api/supabaseClient";
import { Loader2 } from "lucide-react";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="text-xs text-destructive mt-1">{error}</p>;
}

export default function ClientForm({ client, open, onClose, onSave }) {
  const [formData, setFormData] = useState({
    agent_name: "",
    agent_email: "",
    agent_phone: "",
    team_name: "",
    agency_name: "",
    agency_address: "",
    notes: ""
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const handleChange = (field, value) => {
    const trimmed = typeof value === "string" ? value.slice(0, LIMITS[field.replace("agent_", "")] ?? LIMITS.short ?? 255) : value;
    setFormData(prev => ({ ...prev, [field]: trimmed }));
    setErrors(prev => ({ ...prev, [field]: validateField(field, trimmed) }));
  };

  useEffect(() => {
    if (client) {
      setFormData(client);
    } else {
      setFormData({
        agent_name: "",
        agent_email: "",
        agent_phone: "",
        team_name: "",
        agency_name: "",
        agency_address: "",
        notes: ""
      });
    }
  }, [client, open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = trimFormData(formData);
    const newErrors = {
      agent_name: validateField("agent_name", trimmed.agent_name),
      agent_email: validateField("agent_email", trimmed.agent_email),
      agent_phone: validateField("agent_phone", trimmed.agent_phone),
      agency_name: validateField("agency_name", trimmed.agency_name),
    };
    setErrors(newErrors);
    if (Object.values(newErrors).some(Boolean)) return;

    setSaving(true);
    if (client?.id) {
      await api.entities.Client.update(client.id, trimmed);
    } else {
      await api.entities.Client.create(trimmed);
    }
    setSaving(false);
    onSave();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{client ? "Edit Client" : "New Client"}</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-4 p-4 bg-muted/50 rounded-lg">
            <h3 className="font-semibold text-sm">Agent Information *</h3>
            <div>
              <Label htmlFor="agent_name">Agent Name *</Label>
              <Input
                id="agent_name"
                value={formData.agent_name}
                onChange={(e) => handleChange("agent_name", e.target.value)}
                placeholder="John Smith"
                maxLength={LIMITS.name}
                className={errors.agent_name ? "border-destructive" : ""}
                required
              />
              <FieldError error={errors.agent_name} />
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="agent_email">Agent Email</Label>
                <Input
                  id="agent_email"
                  type="email"
                  value={formData.agent_email}
                  onChange={(e) => handleChange("agent_email", e.target.value)}
                  placeholder="agent@email.com"
                  maxLength={LIMITS.email}
                  className={errors.agent_email ? "border-destructive" : ""}
                />
                <FieldError error={errors.agent_email} />
              </div>
              
              <div>
                <Label htmlFor="agent_phone">Agent Phone</Label>
                <Input
                  id="agent_phone"
                  value={formData.agent_phone}
                  onChange={(e) => handleChange("agent_phone", e.target.value)}
                  placeholder="(555) 123-4567"
                  maxLength={LIMITS.phone}
                  className={errors.agent_phone ? "border-destructive" : ""}
                />
                <FieldError error={errors.agent_phone} />
              </div>
            </div>
          </div>

          <div>
            <Label htmlFor="team_name">Team Name (Optional)</Label>
            <Input
              id="team_name"
              value={formData.team_name}
              onChange={(e) => setFormData(prev => ({ ...prev, team_name: e.target.value }))}
              placeholder="e.g., Downtown Team, Luxury Division"
            />
          </div>

          <div className="space-y-4 p-4 bg-muted/50 rounded-lg">
            <h3 className="font-semibold text-sm">Agency Information *</h3>
            <div>
              <Label htmlFor="agency_name">Agency Name *</Label>
              <Input
                id="agency_name"
                value={formData.agency_name}
                onChange={(e) => handleChange("agency_name", e.target.value)}
                placeholder="Real Estate Agency Name"
                maxLength={LIMITS.name}
                className={errors.agency_name ? "border-destructive" : ""}
                required
              />
              <FieldError error={errors.agency_name} />
            </div>
            
            <div>
              <Label htmlFor="agency_address">Agency Address</Label>
              <Input
                id="agency_address"
                value={formData.agency_address}
                onChange={(e) => handleChange("agency_address", e.target.value)}
                placeholder="123 Main St, City, State"
                maxLength={LIMITS.address}
              />
            </div>
          </div>
          
          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => handleChange("notes", e.target.value)}
              placeholder="Additional notes about this client"
              maxLength={LIMITS.notes}
              rows={3}
            />
            <p className="text-xs text-muted-foreground mt-1 text-right">{(formData.notes || "").length}/{LIMITS.notes}</p>
          </div>
          
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {client ? "Update Client" : "Add Client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}