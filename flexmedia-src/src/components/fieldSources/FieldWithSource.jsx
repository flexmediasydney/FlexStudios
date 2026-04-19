// ─────────────────────────────────────────────────────────────────────────────
// FieldWithSource — PLACEHOLDER STUB
//
// This file exists so the CRM integration code (PersonDetails, OrgDetails,
// ProspectDetails, Agent/AgencySlideout, PulseIntelligencePanel, HierarchyTableView)
// compiles in isolation before merge. Agent 3 owns the canonical
// implementation and will overwrite this file at merge time.
//
// The stub honours the component contract described in the wave spec:
//   <FieldWithSource
//     entityType="contact" | "organization" | "agent" | "agency" | "prospect"
//     entityId={uuid}
//     fieldName="mobile" | "email" | "phone" | "full_name" | "job_title"
//                  | "website" | "address" | "profile_image" | "linkedin_url"
//                  | "logo_url"
//     label="Mobile"
//     editable={true}
//     fallbackValue={legacyValue}   (shown with Legacy chip if resolver null)
//     size="sm" | "md" | "lg"
//     inline={false}
//     onValueChange={(v) => {}}
//   />
//
// Runtime behaviour while agent 3's component isn't yet merged:
//   - Resolves through safr_resolve_field RPC when available; else falls back
//     to fallbackValue. No editing, no history drawer, no chip colours.
//   - Records no observations on save — edit mode is a no-op until the real
//     component ships. This keeps integrations from accidentally blocking
//     users if the stub reaches production.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/api/supabaseClient";
import { cn } from "@/lib/utils";
import { Pencil } from "lucide-react";

const SIZE_CLASS = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-lg",
};

export default function FieldWithSource({
  entityType,
  entityId,
  fieldName,
  label,
  editable = false,
  fallbackValue = null,
  size = "sm",
  inline = false,
  onValueChange,
  placeholder,
}) {
  const [resolved, setResolved] = useState(null);
  const [source, setSource] = useState(null);
  const [status, setStatus] = useState("loading");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    if (!entityType || !entityId || !fieldName) { setStatus("idle"); return; }
    try {
      const { data, error } = await supabase.rpc("safr_resolve_field", {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_field_name: fieldName,
      });
      if (error) { setStatus("error"); return; }
      const row = Array.isArray(data) ? data[0] : data;
      setResolved(row?.value ?? null);
      setSource(row?.source ?? null);
      setStatus("ready");
    } catch { setStatus("error"); }
  }, [entityType, entityId, fieldName]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const display = resolved ?? fallbackValue ?? null;
  const isLegacy = resolved == null && fallbackValue != null;

  const save = async () => {
    setEditing(false);
    const val = (draft || "").trim();
    if (!val || val === (display ?? "")) return;
    try {
      await supabase.rpc("safr_record_field_observation", {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_field_name: fieldName,
        p_value: val,
        p_source: "user_manual",
        p_confidence: 100,
        p_metadata: { via: "field_with_source" },
      });
      await supabase.rpc("safr_lock_field_value", {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_field_name: fieldName,
        p_value: val,
        p_source: "user_manual",
      }).catch(() => {});
      await load();
      onValueChange?.(val);
    } catch { /* stub: swallow — real component surfaces a toast */ }
  };

  if (editing && editable) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setEditing(false); setDraft(display ?? ""); }
        }}
        className={cn(
          "rounded border border-input bg-background px-2 py-0.5 outline-none",
          "focus:ring-2 focus:ring-primary/25 focus:border-primary",
          SIZE_CLASS[size] || SIZE_CLASS.sm,
          inline ? "inline-block w-auto min-w-[120px]" : "w-full"
        )}
        placeholder={placeholder}
      />
    );
  }

  const onClick = () => {
    if (!editable) return;
    setDraft(display ?? "");
    setEditing(true);
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 group",
        editable && "cursor-pointer hover:text-primary"
      )}
      onClick={onClick}
      title={source ? `Source: ${source}` : undefined}
    >
      {display ? (
        <span className={cn(SIZE_CLASS[size] || SIZE_CLASS.sm, "truncate")}>{display}</span>
      ) : (
        <span className={cn(SIZE_CLASS[size] || SIZE_CLASS.sm, "text-muted-foreground/60 italic")}>
          {editable ? (placeholder || `Add ${label?.toLowerCase?.() || "value"}…`) : "—"}
        </span>
      )}
      {isLegacy && (
        <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 shrink-0">
          Legacy
        </span>
      )}
      {editable && (
        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
      )}
    </span>
  );
}
