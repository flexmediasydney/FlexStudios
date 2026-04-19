/**
 * safrHooks.js — react-query hooks + mutations for SAFR RPCs.
 *
 * Centralises the resolver call, the six mutation wrappers, and field-level
 * validation so every SAFR consumer behaves identically.
 *
 * RPCs called:
 *   resolve_entity_field(entity_type, entity_id, field_name)
 *   record_field_observation(entity_type, entity_id, field_name, value, source, ...)
 *   promote_entity_field(source_id, user_id)
 *   lock_entity_field(entity_type, entity_id, field_name, value_normalized, user_id)
 *   unlock_entity_field(entity_type, entity_id, field_name, user_id)
 *   restore_field_auto_resolution(entity_type, entity_id, field_name, user_id)
 *   dismiss_field_source(source_id, user_id, reason)
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";

// ── Field metadata ────────────────────────────────────────────────────────

/**
 * Multi-value fields render as chip lists; single-value fields render as one value.
 * Keep in sync with the backend field definitions (migration 179).
 */
export const MULTI_VALUE_FIELDS = new Set(["email", "phone", "mobile_numbers"]);

export function isMultiValueField(fieldName) {
  return MULTI_VALUE_FIELDS.has(fieldName);
}

// ── Validation ────────────────────────────────────────────────────────────

export function validateFieldValue(fieldName, rawValue) {
  const v = String(rawValue ?? "").trim();
  if (!v) return { ok: false, error: "Value is required" };

  if (fieldName === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return { ok: false, error: "Invalid email address" };
    }
    return { ok: true, value: v.toLowerCase() };
  }
  if (fieldName === "mobile" || fieldName === "phone") {
    // Normalise: strip everything except digits and leading +
    const digits = v.replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length < 6) {
      return { ok: false, error: "Phone number too short" };
    }
    return { ok: true, value: digits };
  }
  if (fieldName === "website" || fieldName === "linkedin_url" || fieldName === "logo_url" || fieldName === "profile_image") {
    try {
      const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
      new URL(withScheme);
      return { ok: true, value: withScheme };
    } catch {
      return { ok: false, error: "Invalid URL" };
    }
  }
  return { ok: true, value: v };
}

// ── Query: resolve one field ──────────────────────────────────────────────

export function useFieldResolution(entityType, entityId, fieldName, options = {}) {
  const enabled = Boolean(entityType && entityId && fieldName) && options.enabled !== false;

  return useQuery({
    queryKey: ["safr", entityType, entityId, fieldName],
    queryFn: async () => {
      const data = await api.rpc("resolve_entity_field", {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_field_name: fieldName,
      });
      return data || null;
    },
    enabled,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// ── Invalidation helper ───────────────────────────────────────────────────

export function safrQueryKey(entityType, entityId, fieldName) {
  return ["safr", entityType, entityId, fieldName];
}

// ── Mutations ─────────────────────────────────────────────────────────────

export function useSafrMutations(entityType, entityId, fieldName) {
  const qc = useQueryClient();
  const { data: user } = useCurrentUser();
  const userId = user?.id || null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: safrQueryKey(entityType, entityId, fieldName) });
    // Also nudge the full entity queries so read-through paths on detail pages refetch
    qc.invalidateQueries({ queryKey: [entityType, entityId] });
  };

  const recordObservation = useMutation({
    mutationFn: async ({ value, source = "manual", sourceRefType = null, sourceRefId = null, confidence = 1.0, observedAt = null }) => {
      return api.rpc("record_field_observation", {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_field_name: fieldName,
        p_value: value,
        p_source: source,
        p_source_ref_type: sourceRefType,
        p_source_ref_id: sourceRefId,
        p_confidence: confidence,
        p_observed_at: observedAt,
      });
    },
    onSuccess: invalidate,
  });

  const promote = useMutation({
    mutationFn: async ({ sourceId }) => api.rpc("promote_entity_field", { p_source_id: sourceId, p_user_id: userId }),
    onSuccess: invalidate,
  });

  const lock = useMutation({
    mutationFn: async ({ valueNormalized }) => api.rpc("lock_entity_field", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_field_name: fieldName,
      p_value_normalized: valueNormalized,
      p_user_id: userId,
    }),
    onSuccess: invalidate,
  });

  const unlock = useMutation({
    mutationFn: async () => api.rpc("unlock_entity_field", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_field_name: fieldName,
      p_user_id: userId,
    }),
    onSuccess: invalidate,
  });

  const restoreAuto = useMutation({
    mutationFn: async () => api.rpc("restore_field_auto_resolution", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_field_name: fieldName,
      p_user_id: userId,
    }),
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: async ({ sourceId, reason = null }) => api.rpc("dismiss_field_source", {
      p_source_id: sourceId,
      p_user_id: userId,
      p_reason: reason,
    }),
    onSuccess: invalidate,
  });

  return {
    recordObservation,
    promote,
    lock,
    unlock,
    restoreAuto,
    dismiss,
    userId,
  };
}
