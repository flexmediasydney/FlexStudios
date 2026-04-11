import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { isTransientError } from "@/lib/networkResilience";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { validateField, trimFormData, LIMITS } from "@/components/hooks/useFormValidation";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Plus, UserPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useEntityAccess } from '@/components/auth/useEntityAccess';

const INITIAL_STATE = {
  name: "",
  email: "",
  phone: "",
  agency_id: "",
  team_id: "",
  tags: [],
};

/**
 * QuickAddContactPanel - Pipedrive-style slide-in panel for fast contact creation.
 * Features:
 *  - Minimal required fields (Name, Org)
 *  - Duplicate detection by email/phone
 *  - "Save & add another" for batch entry
 *  - Organisation autocomplete
 */
export default function QuickAddContactPanel({ open, onOpenChange, agencies = [], preselectedAgencyId }) {
  const { canEdit, canView } = useEntityAccess('agents');
  const [formData, setFormData] = useState(INITIAL_STATE);
  const [errors, setErrors] = useState({});
  const [duplicateWarning, setDuplicateWarning] = useState(null);

  const { data: allAgents = [] } = useEntityList(open ? "Agent" : null, "name", 5000);
  const { data: loadedAgencies = [] } = useEntityList(open && agencies.length === 0 ? "Agency" : null, "name");
  const { data: teams = [] } = useEntityList(open ? "Team" : null, "name");

  const orgs = agencies.length > 0 ? agencies : loadedAgencies;
  const availableTeams = teams.filter(t => t.agency_id === formData.agency_id);

  useEffect(() => {
    if (open) {
      setFormData({ ...INITIAL_STATE, agency_id: preselectedAgencyId || "" });
      setErrors({});
      setDuplicateWarning(null);
    }
  }, [open, preselectedAgencyId]);

  // Duplicate detection
  useEffect(() => {
    if (!open) return;
    const email = formData.email?.trim().toLowerCase();
    const phone = formData.phone?.trim().replace(/\s/g, "");

    if (!email && !phone) {
      setDuplicateWarning(null);
      return;
    }

    const dupes = allAgents.filter(a => {
      if (email && a.email?.toLowerCase() === email) return true;
      if (phone && phone.length >= 6 && a.phone?.replace(/\s/g, "").includes(phone)) return true;
      return false;
    });

    if (dupes.length > 0) {
      setDuplicateWarning(
        `Possible duplicate: ${dupes.map(d => d.name).join(", ")} (${dupes.length === 1 ? "matches" : "match"} ${email ? "email" : "phone"})`
      );
    } else {
      setDuplicateWarning(null);
    }
  }, [formData.email, formData.phone, allAgents, open]);

  const saveMutation = useMutation({
    retry: (failureCount, error) => failureCount < 2 && isTransientError(error),
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 4000),
    mutationFn: async ({ data, addAnother }) => {
      if (!data.name?.trim()) throw new Error("Name is required");
      if (!data.agency_id) throw new Error("Organisation is required");

      const agency = orgs.find(a => a.id === data.agency_id);
      if (!agency) throw new Error("Selected organisation not found");
      const team = data.team_id ? teams.find(t => t.id === data.team_id) : null;

      const payload = {
        name: data.name.trim(),
        email: data.email?.trim() || "",
        phone: data.phone?.trim() || "",
        tags: data.tags || [],
        current_agency_id: data.agency_id,
        current_agency_name: agency.name,
        current_team_id: data.team_id || "",
        current_team_name: team?.name || "",
      };

      const user = await api.auth.me();
      const result = await api.entities.Agent.create(payload);

      await api.entities.AuditLog.create({
        entity_type: "agent",
        entity_id: result.id,
        entity_name: data.name,
        action: "create",
        changed_fields: Object.keys(payload).map(key => ({
          field: key, old_value: "", new_value: payload[key] || ""
        })),
        previous_state: {},
        new_state: result,
        user_name: user.full_name,
        user_email: user.email,
      });

      return { result, addAnother };
    },
    onSuccess: ({ addAnother }) => {
      // Invalidate Agent cache so the new contact appears in staff selectors and search fields
      refetchEntityList("Agent");
      refetchEntityList("Agency");
      refetchEntityList("AuditLog");
      toast.success("Contact created");
      if (addAnother) {
        // Reset form but keep the org
        setFormData(prev => ({
          ...INITIAL_STATE,
          agency_id: prev.agency_id,
          team_id: prev.team_id,
        }));
        setErrors({});
        setDuplicateWarning(null);
      } else {
        onOpenChange(false);
      }
    },
    onError: (error) => {
      console.error("Create contact error:", error);
      const hint = isTransientError(error) ? ' — check your connection and try again' : '';
      toast.error((error.message || "Failed to create contact") + hint);
    },
  });

  const handleChange = (field, value) => {
    const trimmed = typeof value === "string" ? value.slice(0, LIMITS[field] ?? 255) : value;
    setFormData(prev => ({ ...prev, [field]: trimmed }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: validateField(field, trimmed) }));
    }
  };

  const handleSubmit = (addAnother = false) => {
    const trimmed = trimFormData(formData);
    const newErrors = {
      name: validateField("name", trimmed.name),
      email: trimmed.email ? validateField("email", trimmed.email) : "",
      phone: trimmed.phone ? validateField("phone", trimmed.phone) : "",
    };
    setErrors(newErrors);
    if (Object.values(newErrors).some(Boolean)) return;
    if (!trimmed.agency_id) { toast.error("Please select an organisation"); return; }
    saveMutation.mutate({ data: trimmed, addAnother });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/20">
          <SheetTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <UserPlus className="h-4 w-4 text-primary" />
            </div>
            Quick Add Contact
            {canView && !canEdit && <span className="text-[10px] font-normal text-muted-foreground border rounded px-1.5 py-0.5 ml-2">View only</span>}
          </SheetTitle>
          <SheetDescription>
            Add a new person to your CRM. Required fields are marked with *.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Duplicate warning */}
          {duplicateWarning && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs" role="alert">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              <p>{duplicateWarning}</p>
            </div>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              autoFocus
              value={formData.name}
              onChange={e => handleChange("name", e.target.value)}
              maxLength={LIMITS.name}
              className={cn("h-9", errors.name && "border-destructive")}
              placeholder="Full name"
              onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }}
            />
            {errors.name && <p className="text-xs text-destructive" role="alert">{errors.name}</p>}
          </div>

          {/* Organisation */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              Organisation <span className="text-destructive">*</span>
            </Label>
            <Select
              value={formData.agency_id}
              onValueChange={val => setFormData(prev => ({ ...prev, agency_id: val, team_id: "" }))}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select organisation" />
              </SelectTrigger>
              <SelectContent>
                {orgs.map(a => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Team (optional) */}
          {formData.agency_id && availableTeams.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Team</Label>
              <Select
                value={formData.team_id}
                onValueChange={val => setFormData(prev => ({ ...prev, team_id: val === "__none__" ? "" : val }))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="No team" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No team</SelectItem>
                  {availableTeams.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Email + Phone side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Email</Label>
              <Input
                type="email"
                value={formData.email}
                onChange={e => handleChange("email", e.target.value)}
                maxLength={LIMITS.email}
                className={cn("h-9", errors.email && "border-destructive")}
                placeholder="email@example.com"
              />
              {errors.email && <p className="text-xs text-destructive" role="alert">{errors.email}</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Phone</Label>
              <Input
                type="tel"
                value={formData.phone}
                onChange={e => handleChange("phone", e.target.value)}
                maxLength={LIMITS.phone}
                className={cn("h-9", errors.phone && "border-destructive")}
                placeholder="0412 345 678"
              />
              {errors.phone && <p className="text-xs text-destructive" role="alert">{errors.phone}</p>}
            </div>
          </div>

          {/* Tags */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Tags</Label>
            <Input
              value={Array.isArray(formData.tags) ? formData.tags.join(", ") : ""}
              onChange={e => {
                const tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
                setFormData(prev => ({ ...prev, tags }));
              }}
              placeholder="VIP, Referral, High volume"
              className="h-9"
            />
            {Array.isArray(formData.tags) && formData.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {formData.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-4 bg-muted/10 flex items-center gap-2">
          <Button
            onClick={() => handleSubmit(false)}
            disabled={saveMutation.isPending || !formData.name?.trim() || !formData.agency_id || !canEdit}
            className="flex-1"
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />
                Saving...
              </>
            ) : (
              "Save Contact"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => handleSubmit(true)}
            disabled={saveMutation.isPending || !formData.name?.trim() || !formData.agency_id || !canEdit}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Save & Add Another
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
