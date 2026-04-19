/**
 * FieldWithSource.jsx — the primary SAFR-aware field renderer.
 *
 * Reads one field for one entity via resolve_entity_field, shows the resolved
 * value + provenance chip + lock/conflict indicators, and offers inline
 * Edit / Lock / Dismiss / View history / View alternates actions.
 *
 * Shape from resolve_entity_field:
 *   {
 *     value, display, source, confidence, observed_at, promoted_at,
 *     locked, locked_by_user_id,
 *     alternates: [{ id, value, display, source, confidence, times_seen,
 *                    last_seen_at, dismissed }],
 *     conflict, policy
 *   }
 *   (multi-value: `values` array replaces `value`)
 *
 * If the resolver returns null AND `fallbackValue` is provided, render the
 * fallback with a "Legacy" chip + a "Backfill now" action (admin only).
 *
 * Props:
 *   entityType, entityId, fieldName  — required identifiers
 *   label                            — display label (optional for inline mode)
 *   editable                         — default true
 *   onValueChange                    — optional callback after successful save
 *   renderValue                      — optional custom renderer(value) → ReactNode
 *   size                             — "sm" | "md" | "lg"
 *   inline                           — if true, no label block
 *   fallbackValue                    — legacy value to render when resolver is empty
 *   fallbackUpdatedAt                — optional ISO timestamp for fallback
 *                                      (used as observed_at when backfilling)
 */

import React, { useState, useMemo } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MoreHorizontal, Lock, LockOpen, Pencil, History, Layers, Check, X, Plus,
  AlertTriangle, ArrowUpCircle, Trash2, RotateCcw,
} from "lucide-react";
import {
  useFieldResolution, useSafrMutations, isMultiValueField,
  validateFieldValue, safrQueryKey,
} from "./safrHooks";
import FieldSourceChip from "./FieldSourceChip";
import FieldSourceHistory from "./FieldSourceHistory";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { cn } from "@/lib/utils";

// ── Size config ───────────────────────────────────────────────────────────

const SIZE_CONFIG = {
  sm: { value: "text-sm", label: "text-[10px]", chip: "sm", menuIcon: "h-3.5 w-3.5", menuBtn: "h-6 w-6" },
  md: { value: "text-base", label: "text-xs", chip: "sm", menuIcon: "h-4 w-4", menuBtn: "h-7 w-7" },
  lg: { value: "text-lg font-medium", label: "text-xs", chip: "md", menuIcon: "h-4 w-4", menuBtn: "h-8 w-8" },
};

const NUMERIC_FIELDS = new Set(["mobile", "phone", "mobile_numbers"]);

// ── Sub-components ────────────────────────────────────────────────────────

function LockIndicator({ locked, onToggle, disabled }) {
  const Icon = locked ? Lock : LockOpen;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            disabled={disabled}
            className={cn(
              "inline-flex items-center justify-center rounded p-0.5 transition-colors",
              locked
                ? "text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-950/30"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {locked ? "Locked — click to unlock" : "Not locked — click to lock"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ConflictIndicator({ alternates }) {
  const topAlt = alternates?.find(a => !a.dismissed);
  if (!topAlt) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center justify-center text-amber-500 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-xs">
          <div className="font-semibold mb-0.5">Conflicting value</div>
          <div className="text-muted-foreground">
            Another source says <span className="font-mono">{String(topAlt.display ?? topAlt.value)}</span>
            {topAlt.source ? ` (${topAlt.source})` : ""}.
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function InlineEditor({ value, fieldName, size, onCancel, onSave, saving }) {
  const [v, setV] = useState(value ?? "");
  const [err, setErr] = useState(null);
  const handleSave = () => {
    const result = validateFieldValue(fieldName, v);
    if (!result.ok) { setErr(result.error); return; }
    onSave(result.value);
  };
  return (
    <div className="flex items-center gap-1.5 w-full">
      <Input
        autoFocus
        value={v}
        onChange={(e) => { setV(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") onCancel();
        }}
        className={cn("h-7", size === "lg" && "h-8 text-base")}
        placeholder={`Enter ${fieldName}`}
      />
      <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={handleSave} disabled={saving}>
        <Check className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={onCancel} disabled={saving}>
        <X className="h-4 w-4" />
      </Button>
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </div>
  );
}

function AlternatesList({ alternates, onPromote, onDismiss, pending }) {
  const visible = (alternates || []).filter(a => !a.dismissed);
  if (visible.length === 0) {
    return <div className="text-xs text-muted-foreground italic px-2 py-1.5">No alternate values.</div>;
  }
  return (
    <div className="space-y-1 py-1">
      {visible.map((alt) => (
        <div key={alt.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/40">
          <FieldSourceChip source={alt.source} size="xs" confidence={alt.confidence} observed_at={alt.last_seen_at} />
          <span className="text-xs truncate flex-1">{String(alt.display ?? alt.value)}</span>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">×{alt.times_seen || 1}</span>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]"
            onClick={() => onPromote(alt)} disabled={pending}>
            <ArrowUpCircle className="h-3 w-3 mr-0.5" />
            Use
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-red-600 dark:text-red-400"
            onClick={() => onDismiss(alt)} disabled={pending}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}

// ── Single-value row ─────────────────────────────────────────────────────

function SingleValueRow({
  resolved, fieldName, entityType, entityId, label, editable, size, renderValue,
  onValueChange, onOpenHistory, isAdmin,
}) {
  const [editing, setEditing] = useState(false);
  const [showAlternates, setShowAlternates] = useState(false);
  const { recordObservation, lock, unlock, promote, dismiss } = useSafrMutations(entityType, entityId, fieldName);
  const qc = useQueryClient();

  const sizeCfg = SIZE_CONFIG[size] || SIZE_CONFIG.md;

  const value = resolved?.value ?? null;
  const display = resolved?.display ?? value;
  const source = resolved?.source;
  const locked = Boolean(resolved?.locked);
  const alternates = resolved?.alternates || [];
  const conflict = Boolean(resolved?.conflict) || alternates.some(a => !a.dismissed);
  const observedAt = resolved?.observed_at;
  const topSourceId = resolved?.source_id ?? resolved?.id ?? null;

  const handleSaveEdit = async (newValue) => {
    try {
      await recordObservation.mutateAsync({ value: newValue, source: "manual", confidence: 1.0 });
      await lock.mutateAsync({ valueNormalized: newValue });
      toast.success("Saved");
      setEditing(false);
      onValueChange?.(newValue);
    } catch (e) {
      toast.error(e?.message || "Save failed");
    }
  };

  const handleToggleLock = async () => {
    try {
      if (locked) {
        await unlock.mutateAsync();
        toast.success("Field unlocked");
      } else {
        await lock.mutateAsync({ valueNormalized: value });
        toast.success("Field locked");
      }
    } catch (e) { toast.error(e?.message || "Operation failed"); }
  };

  const handlePromote = async (alt) => {
    try {
      await promote.mutateAsync({ sourceId: alt.id });
      toast.success("Promoted");
      setShowAlternates(false);
      qc.invalidateQueries({ queryKey: safrQueryKey(entityType, entityId, fieldName) });
    } catch (e) { toast.error(e?.message || "Promote failed"); }
  };

  const handleDismiss = async (alt) => {
    try {
      await dismiss.mutateAsync({ sourceId: alt.id, reason: null });
      toast.success("Dismissed");
      qc.invalidateQueries({ queryKey: safrQueryKey(entityType, entityId, fieldName) });
    } catch (e) { toast.error(e?.message || "Dismiss failed"); }
  };

  const handleDismissCurrent = async () => {
    if (!topSourceId) {
      toast.error("Cannot dismiss current value (no source id).");
      return;
    }
    if (!window.confirm("Dismiss this value? The resolver will re-run and may pick another source.")) return;
    try {
      await dismiss.mutateAsync({ sourceId: topSourceId, reason: "user dismissed current" });
      toast.success("Value dismissed");
    } catch (e) { toast.error(e?.message || "Dismiss failed"); }
  };

  const isNumeric = NUMERIC_FIELDS.has(fieldName);

  if (editing) {
    return (
      <InlineEditor
        value={value || ""}
        fieldName={fieldName}
        size={size}
        onCancel={() => setEditing(false)}
        onSave={handleSaveEdit}
        saving={recordObservation.isPending || lock.isPending}
      />
    );
  }

  // Not set fallback (no value)
  if (value == null || value === "") {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="italic text-sm">Not set</span>
        {editable && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3 mr-1" />
            Add
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn(sizeCfg.value, "font-medium break-all", isNumeric && "tabular-nums")}>
          {renderValue ? renderValue(value) : String(display)}
        </span>
        {source && <FieldSourceChip source={source} observed_at={observedAt} confidence={resolved?.confidence} size={sizeCfg.chip} />}
        <LockIndicator locked={locked} onToggle={handleToggleLock} disabled={lock.isPending || unlock.isPending} />
        {conflict && <ConflictIndicator alternates={alternates} />}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn("inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground", sizeCfg.menuBtn)}
            >
              <MoreHorizontal className={sizeCfg.menuIcon} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{label || fieldName}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setShowAlternates(v => !v)}>
              <Layers className="h-3.5 w-3.5 mr-2" />
              {showAlternates ? "Hide alternates" : `View alternates (${alternates.filter(a => !a.dismissed).length})`}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenHistory()}>
              <History className="h-3.5 w-3.5 mr-2" />
              View history
            </DropdownMenuItem>
            {editable && (
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                Edit
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {locked ? (
              <DropdownMenuItem onSelect={handleToggleLock}>
                <LockOpen className="h-3.5 w-3.5 mr-2" />
                Unlock (restore auto)
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={handleToggleLock}>
                <Lock className="h-3.5 w-3.5 mr-2" />
                Lock this value
              </DropdownMenuItem>
            )}
            {alternates.filter(a => !a.dismissed).length > 0 && (
              <DropdownMenuItem onSelect={handleDismissCurrent} className="text-red-600 dark:text-red-400">
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Dismiss this value
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Timestamp small line */}
      {observedAt && (
        <div className="text-[10px] text-muted-foreground">
          {relTime(observedAt)}
          {resolved?.policy && <span className="ml-2 opacity-70">policy: {resolved.policy}</span>}
        </div>
      )}

      {/* Inline alternates panel */}
      {showAlternates && (
        <div className="rounded-md border bg-muted/30 mt-1">
          <AlternatesList
            alternates={alternates}
            onPromote={handlePromote}
            onDismiss={handleDismiss}
            pending={promote.isPending || dismiss.isPending}
          />
        </div>
      )}
    </div>
  );
}

// ── Multi-value row ──────────────────────────────────────────────────────

function MultiValueRow({
  resolved, fieldName, entityType, entityId, label, editable, size, onValueChange, onOpenHistory,
}) {
  const [adding, setAdding] = useState(false);
  const [newVal, setNewVal] = useState("");
  const [addErr, setAddErr] = useState(null);
  const { recordObservation, promote, dismiss, lock, unlock } = useSafrMutations(entityType, entityId, fieldName);
  const qc = useQueryClient();

  const values = resolved?.values || [];

  const handleAdd = async () => {
    const result = validateFieldValue(fieldName, newVal);
    if (!result.ok) { setAddErr(result.error); return; }
    try {
      await recordObservation.mutateAsync({ value: result.value, source: "manual", confidence: 1.0 });
      toast.success("Added");
      setAdding(false); setNewVal(""); setAddErr(null);
      onValueChange?.(result.value);
    } catch (e) { toast.error(e?.message || "Add failed"); }
  };

  const handleDismiss = async (v) => {
    if (!v.id) { toast.error("No source id"); return; }
    try {
      await dismiss.mutateAsync({ sourceId: v.id, reason: null });
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: safrQueryKey(entityType, entityId, fieldName) });
    } catch (e) { toast.error(e?.message || "Remove failed"); }
  };

  const handleToggleLockValue = async (v) => {
    try {
      if (v.locked) { await unlock.mutateAsync(); toast.success("Unlocked"); }
      else { await lock.mutateAsync({ valueNormalized: v.value }); toast.success("Locked"); }
    } catch (e) { toast.error(e?.message || "Operation failed"); }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {values.length === 0 && (
          <span className="italic text-sm text-muted-foreground">Not set</span>
        )}
        {values.map((v) => (
          <div
            key={v.id || v.value}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs"
          >
            <span className="font-medium truncate max-w-[180px]">{String(v.display ?? v.value)}</span>
            <FieldSourceChip source={v.source} observed_at={v.last_seen_at || v.observed_at} size="xs" />
            {v.locked && <Lock className="h-3 w-3 text-purple-600 dark:text-purple-400" />}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="text-muted-foreground hover:text-foreground">
                  <MoreHorizontal className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => handleToggleLockValue(v)}>
                  {v.locked ? <><LockOpen className="h-3.5 w-3.5 mr-2" />Unlock</> : <><Lock className="h-3.5 w-3.5 mr-2" />Lock</>}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpenHistory()}>
                  <History className="h-3.5 w-3.5 mr-2" />
                  View history
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => handleDismiss(v)}
                  className="text-red-600 dark:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={newVal}
            onChange={(e) => { setNewVal(e.target.value); setAddErr(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
              if (e.key === "Escape") { setAdding(false); setNewVal(""); setAddErr(null); }
            }}
            className="h-7 max-w-xs"
            placeholder={`Add ${fieldName}`}
          />
          <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={handleAdd}>
            <Check className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => { setAdding(false); setNewVal(""); setAddErr(null); }}>
            <X className="h-4 w-4" />
          </Button>
          {addErr && <span className="text-[10px] text-red-600">{addErr}</span>}
        </div>
      ) : (
        editable && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3 mr-1" />
            Add {label ? label.toLowerCase() : fieldName}
          </Button>
        )
      )}
    </div>
  );
}

// ── Fallback (legacy) row ────────────────────────────────────────────────

function LegacyRow({ fallbackValue, fallbackUpdatedAt, fieldName, entityType, entityId, editable, renderValue, onValueChange, size, isAdmin }) {
  const [editing, setEditing] = useState(false);
  const { recordObservation, lock } = useSafrMutations(entityType, entityId, fieldName);
  const sizeCfg = SIZE_CONFIG[size] || SIZE_CONFIG.md;

  const handleBackfill = async () => {
    try {
      await recordObservation.mutateAsync({
        value: fallbackValue,
        source: "manual",
        confidence: 0.6,
        observedAt: fallbackUpdatedAt || null,
      });
      toast.success("Backfilled");
      onValueChange?.(fallbackValue);
    } catch (e) { toast.error(e?.message || "Backfill failed"); }
  };

  const handleSave = async (v) => {
    try {
      await recordObservation.mutateAsync({ value: v, source: "manual", confidence: 1.0 });
      await lock.mutateAsync({ valueNormalized: v });
      toast.success("Saved");
      setEditing(false);
      onValueChange?.(v);
    } catch (e) { toast.error(e?.message || "Save failed"); }
  };

  if (editing) {
    return (
      <InlineEditor
        value={fallbackValue || ""}
        fieldName={fieldName}
        size={size}
        onCancel={() => setEditing(false)}
        onSave={handleSave}
        saving={recordObservation.isPending}
      />
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={cn(sizeCfg.value, "font-medium break-all")}>
        {renderValue ? renderValue(fallbackValue) : String(fallbackValue)}
      </span>
      <FieldSourceChip source="legacy" size={sizeCfg.chip} />
      {editable && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(true)}>
          <Pencil className="h-3 w-3 mr-1" />
          Edit
        </Button>
      )}
      {isAdmin && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={handleBackfill}
          disabled={recordObservation.isPending}>
          <RotateCcw className="h-3 w-3 mr-1" />
          Backfill now
        </Button>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function relTime(ts) {
  if (!ts) return null;
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); }
  catch { return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────

export default function FieldWithSource({
  entityType,
  entityId,
  fieldName,
  label,
  editable = true,
  onValueChange,
  renderValue,
  size = "md",
  inline = false,
  fallbackValue = null,
  fallbackUpdatedAt = null,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { isAdminOrAbove } = usePermissions();
  const { data: resolved, isLoading, error } = useFieldResolution(entityType, entityId, fieldName);

  const sizeCfg = SIZE_CONFIG[size] || SIZE_CONFIG.md;
  const multi = isMultiValueField(fieldName);

  const isEmpty = useMemo(() => {
    if (!resolved) return true;
    if (multi) return !resolved.values || resolved.values.length === 0;
    return resolved.value == null || resolved.value === "";
  }, [resolved, multi]);

  const hasFallback = fallbackValue != null && fallbackValue !== "";
  const showLegacy = isEmpty && hasFallback && !isLoading;

  const body = (() => {
    if (isLoading) return <Skeleton className="h-5 w-40" />;
    if (error) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>{error.message || "Failed to load"}</span>
        </div>
      );
    }
    if (showLegacy) {
      return (
        <LegacyRow
          fallbackValue={fallbackValue}
          fallbackUpdatedAt={fallbackUpdatedAt}
          fieldName={fieldName}
          entityType={entityType}
          entityId={entityId}
          editable={editable}
          renderValue={renderValue}
          onValueChange={onValueChange}
          size={size}
          isAdmin={isAdminOrAbove}
        />
      );
    }
    if (multi) {
      return (
        <MultiValueRow
          resolved={resolved}
          fieldName={fieldName}
          entityType={entityType}
          entityId={entityId}
          label={label}
          editable={editable}
          size={size}
          onValueChange={onValueChange}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      );
    }
    return (
      <SingleValueRow
        resolved={resolved}
        fieldName={fieldName}
        entityType={entityType}
        entityId={entityId}
        label={label}
        editable={editable}
        size={size}
        renderValue={renderValue}
        onValueChange={onValueChange}
        onOpenHistory={() => setHistoryOpen(true)}
        isAdmin={isAdminOrAbove}
      />
    );
  })();

  return (
    <div className={cn("safr-field", inline && "inline-flex items-center gap-2")}>
      {!inline && label && (
        <div className={cn("text-muted-foreground uppercase tracking-wide font-medium mb-0.5", sizeCfg.label)}>
          {label}
        </div>
      )}
      {body}

      <FieldSourceHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        entityType={entityType}
        entityId={entityId}
        fieldName={fieldName}
        label={label}
      />
    </div>
  );
}
