// ─────────────────────────────────────────────────────────────────────────────
// backfillUtils — record legacy CRM column values as SAFR observations so the
// source-aware resolver stops returning null for them. Used when a detail page
// detects any field rendering with the "Legacy" chip (agent 3's component
// flags this via a data attribute / prop on FieldWithSource).
//
// The RPC name mirrors agent 1's migration contract:
//     safr_record_field_observation(
//       p_entity_type text,
//       p_entity_id uuid,
//       p_field_name text,
//       p_value text,
//       p_source text,      -- 'crm_manual' when backfilling from the CRM mirror
//       p_confidence int,   -- 100 — value has been human-curated in the CRM
//       p_metadata jsonb    -- optional; we pass {reason:'crm_backfill'}
//     )
//
// Every page wires this via a "Backfill from CRM to SAFR" button that the
// page only shows when at least one field resolves to null (the FieldWithSource
// component surfaces that fallback state through its `fallbackValue`).
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "@/api/supabaseClient";
import { toast } from "sonner";

/**
 * Record manual CRM observations for a list of fields on one entity.
 *
 * @param {('contact'|'organization'|'agent'|'agency'|'prospect')} entityType
 * @param {string} entityId  — uuid of the entity
 * @param {object} entityObj — the raw CRM row with the mirror columns
 * @param {string[]} fieldList — field names to backfill. Values come from entityObj[field].
 * @returns {Promise<{recorded: number, skipped: number, failed: number}>}
 */
export async function backfillEntityFields(entityType, entityId, entityObj, fieldList) {
  if (!entityType || !entityId || !entityObj || !Array.isArray(fieldList) || fieldList.length === 0) {
    return { recorded: 0, skipped: 0, failed: 0 };
  }
  let recorded = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const field of fieldList) {
    const raw = entityObj[field];
    const val = raw == null ? "" : String(raw).trim();
    if (!val) { skipped += 1; continue; }

    try {
      const { error } = await supabase.rpc("safr_record_field_observation", {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_field_name: field,
        p_value: val,
        p_source: "crm_manual",
        p_confidence: 100,
        p_metadata: { reason: "crm_backfill" },
      });
      if (error) { failed += 1; errors.push(`${field}: ${error.message}`); }
      else { recorded += 1; }
    } catch (err) {
      failed += 1;
      errors.push(`${field}: ${err?.message || String(err)}`);
    }
  }

  if (recorded > 0) toast.success(`Backfilled ${recorded} field${recorded === 1 ? "" : "s"} to SAFR`);
  if (failed > 0) toast.error(`${failed} field${failed === 1 ? "" : "s"} failed to backfill`);
  return { recorded, skipped, failed, errors };
}

/**
 * Default field lists by entity type. Pages can override, but these match the
 * SAFR-tracked fields enumerated in the migration contract.
 */
export const DEFAULT_FIELDS = {
  contact: ["full_name", "email", "mobile", "phone", "job_title", "linkedin_url", "profile_image"],
  agent:   ["full_name", "email", "mobile", "phone", "job_title", "linkedin_url", "profile_image"],
  organization: ["name", "email", "phone", "website", "address", "logo_url"],
  agency:  ["name", "email", "phone", "website", "address", "logo_url"],
  prospect: ["full_name", "email", "mobile", "phone", "job_title"],
};
