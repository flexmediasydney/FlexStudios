/**
 * NotificationRoutingRulesAdmin — Wave 6 Phase 1.5 SHORTLIST
 *
 * Master_admin-only editor for `notification_routing_rules`. One row per
 * notification type known to the system (fetched from notificationService
 * via `action: 'list_types'`). Each row shows the active routing rule (or a
 * "Default (no rule)" badge when falling back to the in-code default_roles).
 *
 * Versioning contract (mirrors SettingsShortlistingSlots / Phase 7):
 *   On save → INSERT new row at version+1 with is_active=TRUE, then UPDATE
 *   the prior active row to is_active=FALSE. Never mutate in place — full
 *   audit trail preserved. Rolls back the insert if the deactivate fails.
 *
 * "Reset to default" — flips the current rule's is_active=FALSE without
 * inserting a replacement. Resolver then falls back to the code-level
 * NOTIFICATION_TYPES[type].default_roles.
 *
 * User picker is a lightweight Command-based combobox over the full users
 * list (server pre-loads users on mount; client-side filter on full_name +
 * email). No new design system pieces — Command + Popover already exist.
 */

import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Bell,
  Check,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Constants ───────────────────────────────────────────────────────────────

// Mirrors the `users.role` enum used across the app. Order matters: shown
// top-to-bottom in the multiselect with the most-privileged at the top.
const ROLE_OPTIONS = [
  { value: "master_admin", label: "Master Admin", tone: "bg-purple-100 text-purple-800" },
  { value: "admin", label: "Admin", tone: "bg-indigo-100 text-indigo-800" },
  { value: "manager", label: "Manager", tone: "bg-blue-100 text-blue-800" },
  { value: "employee", label: "Employee", tone: "bg-emerald-100 text-emerald-800" },
  { value: "contractor", label: "Contractor", tone: "bg-amber-100 text-amber-800" },
  // Project-aware roles — resolver maps these to per-project user IDs.
  { value: "project_owner", label: "Project Owner", tone: "bg-rose-100 text-rose-800" },
  { value: "photographer", label: "Photographer", tone: "bg-cyan-100 text-cyan-800" },
  { value: "image_editor", label: "Image Editor", tone: "bg-pink-100 text-pink-800" },
  { value: "video_editor", label: "Video Editor", tone: "bg-fuchsia-100 text-fuchsia-800" },
  { value: "videographer", label: "Videographer", tone: "bg-teal-100 text-teal-800" },
  { value: "assigned_users", label: "Assigned Users", tone: "bg-slate-100 text-slate-800" },
];

const ROLE_LABEL_MAP = Object.fromEntries(ROLE_OPTIONS.map((r) => [r.value, r]));

const CATEGORY_TONES = {
  scheduling: "bg-blue-50 text-blue-700 border-blue-200",
  project: "bg-emerald-50 text-emerald-700 border-emerald-200",
  task: "bg-amber-50 text-amber-700 border-amber-200",
  revision: "bg-orange-50 text-orange-700 border-orange-200",
  tonomo: "bg-violet-50 text-violet-700 border-violet-200",
  financial: "bg-rose-50 text-rose-700 border-rose-200",
  email: "bg-sky-50 text-sky-700 border-sky-200",
  workflow: "bg-cyan-50 text-cyan-700 border-cyan-200",
  system: "bg-slate-50 text-slate-700 border-slate-200",
};

const SEVERITY_TONES = {
  info: "bg-blue-50 text-blue-700 border-blue-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
  critical: "bg-red-50 text-red-800 border-red-200",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function fetchTypeRegistry() {
  // Calls notificationService action='list_types'. Returns
  //   { shortlist_ready_for_review: { category, severity, cta_label, default_roles }, ... }
  return api.functions
    .invoke("notificationService", { action: "list_types" })
    .then((res) => res?.types || res?.data?.types || {});
}

// ── User picker ─────────────────────────────────────────────────────────────
function UserMultiPicker({ value, onChange, users, loading }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = Array.isArray(value) ? value : [];

  const usersById = useMemo(() => {
    const m = new Map();
    for (const u of users || []) m.set(u.id, u);
    return m;
  }, [users]);

  const filtered = useMemo(() => {
    if (!query.trim()) return (users || []).slice(0, 50);
    const q = query.toLowerCase();
    return (users || [])
      .filter((u) => {
        const hay = `${u.full_name || ""} ${u.email || ""} ${u.role || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 50);
  }, [users, query]);

  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const u = usersById.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded bg-muted text-xs px-2 py-0.5"
              >
                <span>{u ? u.full_name || u.email : `(unknown ${id.slice(0, 8)})`}</span>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={loading}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add user
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-80" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by name or email…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>{loading ? "Loading users…" : "No users match."}</CommandEmpty>
              <CommandGroup>
                {filtered.map((u) => {
                  const isSel = selected.includes(u.id);
                  return (
                    <CommandItem
                      key={u.id}
                      value={`${u.full_name || ""} ${u.email || ""} ${u.id}`}
                      onSelect={() => toggle(u.id)}
                      className="cursor-pointer"
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5 mr-2",
                          isSel ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">
                          {u.full_name || u.email}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {u.email} · {u.role || "no role"}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Role multiselect ────────────────────────────────────────────────────────
function RoleMultiselect({ value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const toggle = (r) => {
    if (arr.includes(r)) onChange(arr.filter((x) => x !== r));
    else onChange([...arr, r]);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROLE_OPTIONS.map((r) => {
        const on = arr.includes(r.value);
        return (
          <button
            key={r.value}
            type="button"
            onClick={() => toggle(r.value)}
            className={cn(
              "text-[11px] rounded-md border px-2 py-1 transition-colors",
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted/40 border-border",
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Edit dialog ─────────────────────────────────────────────────────────────
function EditRuleDialog({
  open,
  onOpenChange,
  initialForm,
  notificationType,
  typeMeta,
  currentVersion,
  hasActiveRule,
  users,
  usersLoading,
  onSave,
  isSaving,
}) {
  const [form, setForm] = useState(initialForm);

  // Reset form when re-opening for a different type.
  useEffect(() => {
    setForm(initialForm);
  }, [initialForm]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const noRecipients =
    (form.recipient_roles || []).length === 0 &&
    (form.recipient_user_ids || []).length === 0;

  const handleSave = () => {
    if (noRecipients) {
      toast.error("Pick at least one role or one user — or use Reset to default.");
      return;
    }
    onSave(form);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            <span className="font-mono text-sm">{notificationType}</span>
          </DialogTitle>
          <DialogDescription>
            {hasActiveRule
              ? `Saving deactivates v${currentVersion} and creates v${currentVersion + 1}. Recipients of past notifications are unchanged — only future fires use the new rule.`
              : "Creating the first rule for this type. Version starts at 1."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {typeMeta && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  CATEGORY_TONES[typeMeta.category] || CATEGORY_TONES.system,
                )}
              >
                {typeMeta.category}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  SEVERITY_TONES[typeMeta.severity] || SEVERITY_TONES.info,
                )}
              >
                {typeMeta.severity}
              </Badge>
              {Array.isArray(typeMeta.default_roles) && typeMeta.default_roles.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  Code default: {typeMeta.default_roles.join(", ")}
                </span>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Recipient roles</Label>
            <p className="text-[10px] text-muted-foreground">
              All users with these roles get notified. <code>master_admin</code> implicitly includes <code>admin</code>.
            </p>
            <RoleMultiselect
              value={form.recipient_roles}
              onChange={(v) => update("recipient_roles", v)}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Specific users (always notified)</Label>
            <p className="text-[10px] text-muted-foreground">
              Added on top of role recipients. Useful for "always page Alice on this".
            </p>
            <UserMultiPicker
              value={form.recipient_user_ids}
              onChange={(v) => update("recipient_user_ids", v)}
              users={users}
              loading={usersLoading}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              value={form.notes || ""}
              onChange={(e) => update("notes", e.target.value)}
              placeholder="Why this routing? E.g. 'Alice handles every shortlist review until the new lead lands.'"
              rows={3}
              className="text-xs"
            />
          </div>

          <div className="flex items-center justify-between rounded border p-3">
            <div>
              <p className="text-xs font-medium">Active</p>
              <p className="text-[10px] text-muted-foreground">
                Disabling falls back to the code-level default roles for this type.
              </p>
            </div>
            <Switch
              checked={form.is_active !== false}
              onCheckedChange={(v) => update("is_active", v)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || noRecipients}>
            {isSaving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {hasActiveRule ? "Save new version" : "Create rule"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function NotificationRoutingRulesAdmin({ currentUserRole }) {
  const queryClient = useQueryClient();
  const [editorState, setEditorState] = useState({
    open: false,
    notificationType: null,
    initialForm: null,
    currentVersion: 0,
    hasActiveRule: false,
  });
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const isMasterAdmin = currentUserRole === "master_admin";

  // 1) NOTIFICATION_TYPES registry (from notificationService).
  const typesQuery = useQuery({
    queryKey: ["notification_type_registry"],
    queryFn: fetchTypeRegistry,
    staleTime: 5 * 60 * 1000,
    enabled: isMasterAdmin,
  });

  // 2) All routing rules (active + history).
  const rulesQuery = useQuery({
    queryKey: ["notification_routing_rules_all"],
    queryFn: () =>
      api.entities.NotificationRoutingRule.list("-created_at", 1000),
    enabled: isMasterAdmin,
  });

  // 3) Users — for the picker. Pre-load full list so the combobox is instant.
  const usersQuery = useQuery({
    queryKey: ["users-routing-picker"],
    queryFn: () => api.entities.User.list("full_name", 500),
    enabled: isMasterAdmin,
  });

  const allRules = rulesQuery.data || [];
  const activeRulesByType = useMemo(() => {
    const m = new Map();
    for (const r of allRules) {
      if (r.is_active === true) m.set(r.notification_type, r);
    }
    return m;
  }, [allRules]);

  const versionsByType = useMemo(() => {
    const m = new Map();
    for (const r of allRules) {
      if (!m.has(r.notification_type)) m.set(r.notification_type, []);
      m.get(r.notification_type).push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (b.version || 0) - (a.version || 0));
    }
    return m;
  }, [allRules]);

  const types = typesQuery.data || {};
  const typeKeys = Object.keys(types).sort();

  const categories = useMemo(() => {
    const set = new Set();
    for (const k of typeKeys) {
      const c = types[k]?.category;
      if (c) set.add(c);
    }
    return ["all", ...Array.from(set).sort()];
  }, [typeKeys, types]);

  const filteredTypes = useMemo(() => {
    return typeKeys.filter((k) => {
      const meta = types[k] || {};
      if (categoryFilter !== "all" && meta.category !== categoryFilter) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const hay = `${k} ${meta.category || ""} ${meta.severity || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [typeKeys, types, search, categoryFilter]);

  // ── Save mutation: insert new + deactivate old ──────────────────────────
  const saveMutation = useMutation({
    mutationFn: async ({ form, notificationType, currentRule }) => {
      const nextVersion = (currentRule?.version || 0) + 1;

      const newRow = await api.entities.NotificationRoutingRule.create({
        notification_type: notificationType,
        recipient_roles: form.recipient_roles || [],
        recipient_user_ids: form.recipient_user_ids || [],
        notes: form.notes?.trim() || null,
        is_active: form.is_active !== false,
        version: nextVersion,
      });

      if (currentRule?.id) {
        try {
          await api.entities.NotificationRoutingRule.update(currentRule.id, {
            is_active: false,
          });
        } catch (err) {
          // Roll back the inserted row to keep the table consistent.
          try {
            await api.entities.NotificationRoutingRule.delete(newRow.id);
          } catch {
            /* best-effort */
          }
          throw new Error(`Failed to deactivate previous version: ${err.message}`);
        }
      }
      return newRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_routing_rules_all"] });
      setEditorState({
        open: false,
        notificationType: null,
        initialForm: null,
        currentVersion: 0,
        hasActiveRule: false,
      });
      toast.success("Routing rule saved.");
    },
    onError: (err) => toast.error(`Save failed: ${err.message}`),
  });

  // ── Reset to default mutation: deactivate the active rule ───────────────
  const resetMutation = useMutation({
    mutationFn: async ({ currentRule }) => {
      if (!currentRule?.id) return null;
      return await api.entities.NotificationRoutingRule.update(currentRule.id, {
        is_active: false,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_routing_rules_all"] });
      toast.success("Reverted to code-level default.");
    },
    onError: (err) => toast.error(`Reset failed: ${err.message}`),
  });

  // ── Editor open helpers ─────────────────────────────────────────────────
  const openEditor = (notificationType) => {
    const currentRule = activeRulesByType.get(notificationType);
    setEditorState({
      open: true,
      notificationType,
      initialForm: {
        recipient_roles: Array.isArray(currentRule?.recipient_roles)
          ? [...currentRule.recipient_roles]
          : [],
        recipient_user_ids: Array.isArray(currentRule?.recipient_user_ids)
          ? [...currentRule.recipient_user_ids]
          : [],
        notes: currentRule?.notes || "",
        is_active: currentRule?.is_active !== false,
      },
      currentVersion: currentRule?.version || 0,
      hasActiveRule: !!currentRule,
    });
  };

  if (!isMasterAdmin) {
    return (
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="p-6 text-sm text-amber-800">
          Routing rule editing is restricted to master_admin. Other roles can view
          the list above to confirm who receives each notification type.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Notification Routing Rules
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            Configure who receives each notification type. Edits create a new
            version — prior versions are preserved.
          </p>
        </div>
      </div>

      {/* Filter row */}
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1 flex-1 min-w-[220px]">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Search
              </Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by type, category, severity…"
                  className="pl-8 h-9 text-xs"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Category
              </Label>
              <div className="flex flex-wrap gap-1">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryFilter(c)}
                    className={cn(
                      "text-[11px] rounded-md border px-2 py-1 capitalize transition-colors",
                      categoryFilter === c
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-muted/40 border-border",
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Notification types</CardTitle>
          <CardDescription className="text-xs">
            {filteredTypes.length} of {typeKeys.length} types · {activeRulesByType.size} configured
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {typesQuery.isLoading || rulesQuery.isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : typesQuery.error ? (
            <div className="p-4 text-xs text-red-600">
              Failed to load type registry: {typesQuery.error.message}
            </div>
          ) : filteredTypes.length === 0 ? (
            <div className="p-6 text-xs text-muted-foreground italic text-center">
              No notification types match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Category / Severity</th>
                    <th className="px-3 py-2 font-medium">Recipients</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium tabular-nums">v</th>
                    <th className="px-3 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {filteredTypes.map((typeKey) => {
                    const meta = types[typeKey] || {};
                    const rule = activeRulesByType.get(typeKey);
                    const hasRule = !!rule;
                    const versions = versionsByType.get(typeKey) || [];
                    const recipientRoles = rule
                      ? rule.recipient_roles || []
                      : meta.default_roles || [];
                    const recipientUserIds = rule ? rule.recipient_user_ids || [] : [];
                    return (
                      <tr key={typeKey} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono text-[11px] align-top">
                          {typeKey}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-col gap-1">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] w-fit",
                                CATEGORY_TONES[meta.category] || CATEGORY_TONES.system,
                              )}
                            >
                              {meta.category || "—"}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] w-fit",
                                SEVERITY_TONES[meta.severity] || SEVERITY_TONES.info,
                              )}
                            >
                              {meta.severity || "—"}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top max-w-[420px]">
                          <div className="flex flex-wrap gap-1">
                            {recipientRoles.map((r) => {
                              const info = ROLE_LABEL_MAP[r] || { label: r, tone: "" };
                              return (
                                <Badge
                                  key={r}
                                  variant="secondary"
                                  className={cn("text-[10px]", info.tone)}
                                >
                                  {info.label}
                                </Badge>
                              );
                            })}
                            {recipientUserIds.length > 0 && (
                              <Badge variant="outline" className="text-[10px]">
                                +{recipientUserIds.length} user
                                {recipientUserIds.length === 1 ? "" : "s"}
                              </Badge>
                            )}
                            {recipientRoles.length === 0 && recipientUserIds.length === 0 && (
                              <span className="text-[10px] text-muted-foreground italic">
                                No recipients (notifications dropped)
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          {hasRule ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-green-50 text-green-700 border-green-200"
                            >
                              Configured
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-slate-50 text-slate-600 border-slate-200"
                            >
                              Default (no rule)
                            </Badge>
                          )}
                        </td>
                        <td
                          className="px-3 py-2 tabular-nums align-top"
                          title={
                            versions.length > 1
                              ? `${versions.length} versions in history`
                              : ""
                          }
                        >
                          {hasRule ? rule.version : "—"}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => openEditor(typeKey)}
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                            {hasRule && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Reset routing for "${typeKey}" to the code-level default? The current rule (v${rule.version}) will be deactivated but kept in history.`,
                                    )
                                  ) {
                                    resetMutation.mutate({ currentRule: rule });
                                  }
                                }}
                                disabled={resetMutation.isPending}
                                title="Reset to code-level default_roles"
                              >
                                <RotateCcw className="h-3 w-3 mr-1" />
                                Reset
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {editorState.open && editorState.notificationType && (
        <EditRuleDialog
          open={editorState.open}
          onOpenChange={(o) => setEditorState((s) => ({ ...s, open: o }))}
          initialForm={editorState.initialForm}
          notificationType={editorState.notificationType}
          typeMeta={types[editorState.notificationType] || null}
          currentVersion={editorState.currentVersion}
          hasActiveRule={editorState.hasActiveRule}
          users={usersQuery.data || []}
          usersLoading={usersQuery.isLoading}
          onSave={(form) => {
            const currentRule = activeRulesByType.get(editorState.notificationType);
            saveMutation.mutate({
              form,
              notificationType: editorState.notificationType,
              currentRule,
            });
          }}
          isSaving={saveMutation.isPending}
        />
      )}
    </div>
  );
}
