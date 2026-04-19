/**
 * BackfillEntityButton.jsx — admin-only bulk-backfill chip.
 *
 * Renders only when the given entity has ZERO promoted rows in
 * entity_field_sources (i.e. the migration-179 backfill skipped it — possibly
 * because the row was created after the backfill job). Clicking emits one
 * `record_field_observation` per known field using the legacy column value as
 * `source='manual'` + `confidence=1.0`. The SAFR resolver then promotes them
 * on the next resolve cycle.
 *
 * Used in:
 *   · PersonDetails.jsx           (entityType="contact")
 *   · OrgDetails.jsx              (entityType="organization")
 *   · ProspectDetails.jsx         (entityType="prospect")
 *   · PulseAgentIntel slideout    (entityType="agent")
 *   · PulseAgencyIntel slideout   (entityType="agency")
 *   · PulseIntelligencePanel      (both)
 */

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";

// Field-name to entity-field-map (legacy → SAFR). Keep in sync with migration 178
// `safr_legacy_field_map`. Order matters for UI consistency only.
const FIELDS_BY_TYPE = {
  contact: ["full_name", "email", "phone", "mobile", "job_title", "linkedin_url", "profile_image"],
  organization: ["name", "phone", "email", "website", "address", "logo_url"],
  agent: ["full_name", "email", "mobile", "phone", "job_title", "profile_image"],
  agency: ["name", "phone", "email", "website", "address", "logo_url"],
  prospect: ["full_name", "email", "phone", "mobile", "job_title", "linkedin_url", "profile_image"],
};

// Map of SAFR field_name → candidate legacy columns on the entity. First
// non-null value wins. For multi-value fields (email) we also iterate
// array-shaped columns (all_emails).
const LEGACY_KEYS = {
  full_name: ["full_name", "name"],
  name: ["name"],
  email: ["email", "email_address"],
  mobile: ["mobile", "phone"],
  phone: ["phone", "business_phone"],
  job_title: ["job_title", "title"],
  profile_image: ["profile_image", "photo_url", "avatar_url"],
  linkedin_url: ["linkedin_url", "linkedin"],
  website: ["website", "website_url"],
  address: ["address", "address_street"],
  logo_url: ["logo_url"],
};

function pickLegacyValue(entity, fieldName) {
  const candidates = LEGACY_KEYS[fieldName] || [fieldName];
  for (const k of candidates) {
    if (entity && entity[k] != null && String(entity[k]).trim() !== "") {
      return String(entity[k]).trim();
    }
  }
  return null;
}

function pickExtraEmails(entity) {
  const raw = entity?.all_emails ?? entity?.alternate_emails ?? null;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => (typeof v === "string" ? v : v?.value)).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p.map((v) => (typeof v === "string" ? v : v?.value)).filter(Boolean);
    } catch { /* ignore */ }
  }
  return [];
}

export default function BackfillEntityButton({ entityType, entityId, entity }) {
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();
  const { isAdminOrAbove } = usePermissions();

  // Only runs when we have the pieces — admin + id + type
  const enabled = Boolean(isAdminOrAbove && entityType && entityId);

  // Check whether any promoted rows exist for this entity. We treat "zero"
  // as the gate. Cheap select head-count query.
  const { data: promotedCount, isLoading } = useQuery({
    queryKey: ["safr-promoted-count", entityType, entityId],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("entity_field_sources")
        .select("id", { count: "exact", head: true })
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("is_promoted", true);
      if (error) return 0;
      return count ?? 0;
    },
  });

  if (!enabled) return null;
  if (isLoading) return null;
  if ((promotedCount ?? 0) > 0) return null;

  const fields = FIELDS_BY_TYPE[entityType] || [];

  const handleBackfill = async () => {
    if (!entity) { toast.error("No entity data loaded"); return; }
    setPending(true);
    let emitted = 0;
    let failed = 0;
    const now = new Date().toISOString();
    const observedAt = entity.updated_date || entity.last_synced_at || now;
    try {
      for (const field of fields) {
        const val = pickLegacyValue(entity, field);
        if (!val) continue;
        try {
          await api.rpc("record_field_observation", {
            p_entity_type: entityType,
            p_entity_id: entityId,
            p_field_name: field,
            p_value: val,
            p_source: "manual",
            p_source_ref_type: "legacy_backfill",
            p_source_ref_id: null,
            p_confidence: 1.0,
            p_observed_at: observedAt,
          });
          emitted++;
        } catch (e) {
          failed++;
        }
      }
      // Multi-value emails — emit each extra email
      if (fields.includes("email")) {
        for (const e of pickExtraEmails(entity)) {
          try {
            await api.rpc("record_field_observation", {
              p_entity_type: entityType,
              p_entity_id: entityId,
              p_field_name: "email",
              p_value: e,
              p_source: "manual",
              p_source_ref_type: "legacy_backfill",
              p_source_ref_id: null,
              p_confidence: 0.9,
              p_observed_at: observedAt,
            });
            emitted++;
          } catch { failed++; }
        }
      }
      toast.success(`Backfilled ${emitted} field${emitted === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`);
      // Invalidate SAFR caches for this entity
      qc.invalidateQueries({ queryKey: ["safr", entityType, entityId] });
      qc.invalidateQueries({ queryKey: ["safr-promoted-count", entityType, entityId] });
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2 text-xs gap-1.5"
      onClick={handleBackfill}
      disabled={pending}
      title="Emit SAFR observations for every known field using the legacy column value"
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
      Backfill SAFR
    </Button>
  );
}
