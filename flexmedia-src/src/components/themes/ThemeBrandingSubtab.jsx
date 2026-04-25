/**
 * ThemeBrandingSubtab — Drone Phase 4 Stream J
 *
 * Branding subtab content for Agency (organisation) and Agent (person) detail
 * pages. Shows theme list + opens the ThemeEditor to create/edit/duplicate.
 *
 * Per IMPLEMENTATION_PLAN_V2.md §6.7 + §3.5:
 *   - Header: "Drone Theme" + [+ New theme]
 *   - Cards grid: each theme owned by this entity
 *   - Below: resolved-theme preview (calls getDroneTheme on a sample project)
 *
 * Permissions:
 *   - master_admin: full access on any owner
 *   - admin: full access on organisation owners; read-only on others (UI gate;
 *     setDroneTheme will also enforce server-side)
 *   - person owner: self-edit only when current_user IS the agent (matched by
 *     email or assigned_to_user_id; same logic as setDroneTheme)
 *   - everyone else: read-only
 *
 * Backend wiring:
 *   - api.entities.DroneTheme.filter({ owner_kind, owner_id }, '-updated_date')
 *   - api.entities.DroneTheme.update(themeId, { is_default, status })  (set-default + archive)
 *   - api.functions.invoke('getDroneTheme', { project_id })             (preview)
 *
 * Note on terminology: the plan uses "person/organisation" but FlexStudios DB
 * uses `agents`/`agencies`. The `drone_themes.owner_kind` enum keeps
 * 'person'/'organisation'; the resolver maps to the right table.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Loader2,
  Pencil,
  Copy,
  Star,
  Archive,
  AlertCircle,
  Palette,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { formatDistanceToNow } from "date-fns";
import ThemeEditor from "./ThemeEditor";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatRelative(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

// Highest-priority entry (= top of source_chain) for the inheritance summary.
function topSource(sourceChain) {
  if (!Array.isArray(sourceChain) || sourceChain.length === 0) return null;
  return sourceChain[0];
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ThemeBrandingSubtab({ ownerKind, ownerId, ownerName }) {
  const { isMasterAdmin, isAdminOrAbove, user } = usePermissions();
  const queryClient = useQueryClient();

  // Editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState(null);   // { id }       → edit existing
  const [duplicatingFrom, setDuplicatingFrom] = useState(null); // theme row → new from copy

  // ── Permission resolution ────────────────────────────────────────────────
  // Person-level self-edit: a v1 heuristic mirroring setDroneTheme's logic.
  // We rely on the user.email comparison only (the assigned_to_user_id link
  // isn't readily available client-side without extra fetches; the server
  // enforces the strict check anyway).
  const [selfPersonMatch, setSelfPersonMatch] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (ownerKind !== "person" || isMasterAdmin || !ownerId) {
      setSelfPersonMatch(false);
      return;
    }
    (async () => {
      try {
        const agent = await api.entities.Agent.get(ownerId);
        if (cancelled) return;
        const matches =
          (agent?.email && user?.email &&
            agent.email.toLowerCase() === user.email.toLowerCase()) ||
          agent?.assigned_to_user_id === user?.id;
        setSelfPersonMatch(!!matches);
      } catch {
        if (!cancelled) setSelfPersonMatch(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ownerKind, ownerId, isMasterAdmin, user?.email, user?.id]);

  const canEdit = useMemo(() => {
    if (isMasterAdmin) return true;
    if (ownerKind === "organisation" && isAdminOrAbove) return true;
    if (ownerKind === "person" && selfPersonMatch) return true;
    // ownerKind === "system" is master-admin-only — caller (e.g. AdminDroneThemes)
    // already gates the route, but we double-check here.
    return false;
  }, [isMasterAdmin, isAdminOrAbove, ownerKind, selfPersonMatch]);

  // System-level themes have a NULL owner_id by design — they're the global
  // fallback. So gate the queries on ownerKind alone, then conditionally
  // include owner_id only for non-system owners.
  const isSystemOwner = ownerKind === "system";

  // ── Themes for this owner ────────────────────────────────────────────────
  const themesQuery = useQuery({
    queryKey: ["drone_themes", ownerKind, ownerId],
    queryFn: async () => {
      const filter = isSystemOwner
        ? { owner_kind: "system" }
        : { owner_kind: ownerKind, owner_id: ownerId };
      const rows = await api.entities.DroneTheme.filter(filter, "-updated_at", 100);
      // Surface the most-recently-edited active theme first; archived last.
      return [...rows].sort((a, b) => {
        const aArchived = a.status === "archived";
        const bArchived = b.status === "archived";
        if (aArchived !== bArchived) return aArchived ? 1 : -1;
        if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      });
    },
    enabled: !!ownerKind && (isSystemOwner || !!ownerId),
    staleTime: 15 * 1000,
  });

  const themes = themesQuery.data || [];

  // ── Sample-project lookup for the resolved-theme preview ─────────────────
  // Pick the most-recent project owned by this entity. For organisation we
  // filter by agency_id; for person we use primary_contact_person_id (the
  // theme-resolution key) and fall back to agent_id if nothing matches.
  const sampleProjectQuery = useQuery({
    queryKey: ["theme_preview_sample_project", ownerKind, ownerId],
    queryFn: async () => {
      try {
        // No per-owner sample project for system themes — preview is N/A.
        if (isSystemOwner) return null;
        if (ownerKind === "organisation") {
          const rows = await api.entities.Project.filter(
            { agency_id: ownerId }, "-created_date", 1,
          );
          return rows?.[0] || null;
        }
        // person — try primary_contact_person_id first
        const byPrimary = await api.entities.Project.filter(
          { primary_contact_person_id: ownerId }, "-created_date", 1,
        );
        if (byPrimary?.[0]) return byPrimary[0];
        // fall back to agent_id
        const byAgent = await api.entities.Project.filter(
          { agent_id: ownerId }, "-created_date", 1,
        );
        return byAgent?.[0] || null;
      } catch {
        return null;
      }
    },
    enabled: !!ownerKind && !isSystemOwner && !!ownerId,
    staleTime: 60 * 1000,
  });

  const sampleProject = sampleProjectQuery.data;

  // Resolved-theme preview via getDroneTheme.
  const resolvedThemeQuery = useQuery({
    queryKey: ["resolved_drone_theme", sampleProject?.id],
    queryFn: async () => {
      if (!sampleProject?.id) return null;
      const result = await api.functions.invoke("getDroneTheme", {
        project_id: sampleProject.id,
      });
      return result?.data || null;
    },
    enabled: !!sampleProject?.id,
    staleTime: 60 * 1000,
  });

  const resolved = resolvedThemeQuery.data;

  // ── Mutations ────────────────────────────────────────────────────────────
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["drone_themes", ownerKind, ownerId] });
    if (sampleProject?.id) {
      queryClient.invalidateQueries({ queryKey: ["resolved_drone_theme", sampleProject.id] });
    }
  }, [queryClient, ownerKind, ownerId, sampleProject?.id]);

  const handleSetDefault = useCallback(async (theme) => {
    if (!canEdit) return;
    try {
      // Route through setDroneTheme so the server-side clearOtherDefaults
      // guard runs atomically (instead of the prior client-side loop, which
      // could leave the system in a half-state on partial failure). Also
      // ensures the revision row is written and audit lineage is preserved.
      const result = await api.functions.invoke("setDroneTheme", {
        theme_id: theme.id,
        owner_kind: theme.owner_kind,
        owner_id: theme.owner_id,
        name: theme.name,
        config: theme.config || {},
        is_default: true,
      });
      const data = result?.data;
      if (!data?.success) {
        throw new Error(data?.error || "Set-default failed");
      }
      toast.success(`"${theme.name}" set as default`);
      refresh();
    } catch (e) {
      toast.error(e?.message || "Failed to set default");
    }
  }, [canEdit, refresh]);

  const handleArchive = useCallback(async (theme) => {
    if (!canEdit) return;
    const next = theme.status === "archived" ? "active" : "archived";
    try {
      const patch = { status: next };
      // If archiving the default, also clear is_default — otherwise the
      // resolver continues picking it up.
      if (next === "archived" && theme.is_default) patch.is_default = false;
      await api.entities.DroneTheme.update(theme.id, patch);
      toast.success(next === "archived" ? "Theme archived" : "Theme restored");
      refresh();
    } catch (e) {
      toast.error(e?.message || "Failed to update theme");
    }
  }, [canEdit, refresh]);

  const handleDuplicate = useCallback((theme) => {
    if (!canEdit) return;
    setEditingTheme(null);
    setDuplicatingFrom({
      ...theme,
      name: `${theme.name} (copy)`,
      is_default: false,
    });
    setEditorOpen(true);
  }, [canEdit]);

  const handleEdit = useCallback((theme) => {
    setEditingTheme(theme);
    setDuplicatingFrom(null);
    setEditorOpen(true);
  }, []);

  const handleNew = useCallback(() => {
    setEditingTheme(null);
    setDuplicatingFrom(null);
    setEditorOpen(true);
  }, []);

  const handleSaved = useCallback(() => {
    setEditorOpen(false);
    setEditingTheme(null);
    setDuplicatingFrom(null);
    refresh();
  }, [refresh]);

  const handleCancel = useCallback(() => {
    setEditorOpen(false);
    setEditingTheme(null);
    setDuplicatingFrom(null);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  // When the editor is open, render it full-tab (Pipedrive-style takeover) so
  // the long form has room to breathe — much closer to the §6.4 spec layout
  // than a tiny modal would be.
  if (editorOpen) {
    return (
      <div className="p-4 lg:p-6 space-y-4 max-w-6xl">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={handleCancel}
            className="hover:text-foreground transition-colors"
          >
            Drone themes
          </button>
          <ChevronRight className="h-3 w-3" />
          <span className="font-medium text-foreground">
            {editingTheme ? "Edit theme" : duplicatingFrom ? "Duplicate theme" : "New theme"}
          </span>
        </div>
        <ThemeEditor
          themeId={editingTheme?.id}
          ownerKind={ownerKind}
          ownerId={ownerId}
          initialTheme={duplicatingFrom}
          canEdit={canEdit}
          onSaved={handleSaved}
          onCancel={handleCancel}
        />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Palette className="h-5 w-5 text-primary" />
            Drone Theme
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Customise drone render output for{" "}
            <span className="font-medium text-foreground">{ownerName}</span>.{" "}
            {ownerKind === "person"
              ? "Person-level themes override the organisation default."
              : ownerKind === "organisation"
                ? "Organisation-level themes override the FlexMedia default."
                : "System-level themes are the global FlexMedia fallback for every render."}
          </p>
        </div>
        {canEdit && (
          <Button onClick={handleNew} size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New theme
          </Button>
        )}
      </div>

      {!canEdit && (
        <div className="rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 flex items-start gap-2 text-xs">
          <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-amber-700 dark:text-amber-200">
            View only — your role doesn't permit editing {ownerKind === "system" ? "the FlexMedia system theme" : `themes for this ${ownerKind === "organisation" ? "organisation" : "person"}`}.
          </p>
        </div>
      )}

      {/* Themes list */}
      {themesQuery.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-4 space-y-2">
                <div className="h-4 bg-muted rounded w-2/3" />
                <div className="h-3 bg-muted/60 rounded w-1/3" />
                <div className="h-3 bg-muted/60 rounded w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : themesQuery.error ? (
        <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900/50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-800 dark:text-red-200">
                Failed to load themes
              </p>
              <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                {themesQuery.error.message || "Unknown error"}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : themes.length === 0 ? (
        <Card className="border-dashed bg-muted/20">
          <CardContent className="py-10 px-6 text-center space-y-3">
            <Palette className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium">No themes yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                {ownerKind === "system"
                  ? "Create the FlexMedia system theme — it's the global fallback for every render."
                  : `Create one to override the FlexMedia default for this ${ownerKind === "organisation" ? "organisation" : "person"}.`}
              </p>
            </div>
            {canEdit && (
              <Button onClick={handleNew} size="sm" variant="outline" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Create first theme
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              canEdit={canEdit}
              onEdit={() => handleEdit(theme)}
              onDuplicate={() => handleDuplicate(theme)}
              onSetDefault={() => handleSetDefault(theme)}
              onArchive={() => handleArchive(theme)}
            />
          ))}
        </div>
      )}

      {/* Resolved-theme preview — only meaningful for non-system owners
          (system has no upstream chain to resolve from). */}
      {!isSystemOwner && (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            Resolved theme preview
            {sampleProject && (
              <Badge variant="outline" className="text-[9px] font-normal">
                from project: {sampleProject.address || sampleProject.id?.slice(0, 8)}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 text-xs text-muted-foreground space-y-2">
          {sampleProjectQuery.isLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Looking up a sample project…
            </div>
          ) : !sampleProject ? (
            <p className="italic">
              No sample project found for this {ownerKind === "organisation" ? "organisation" : "person"} —
              the resolved theme preview activates once a project is linked.
            </p>
          ) : resolvedThemeQuery.isLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Resolving theme…
            </div>
          ) : resolvedThemeQuery.error ? (
            <p className="text-red-600 dark:text-red-400">
              Failed to resolve theme: {resolvedThemeQuery.error.message}
            </p>
          ) : !resolved?.success ? (
            <p className="italic">
              Create a theme to override the system default for this {ownerKind === "organisation" ? "organisation" : "person"}.
            </p>
          ) : (
            <ResolvedThemeSummary resolved={resolved} themes={themes} ownerKind={ownerKind} />
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function ThemeCard({ theme, canEdit, onEdit, onDuplicate, onSetDefault, onArchive }) {
  const isArchived = theme.status === "archived";
  const accent = theme.config?.poi_label?.fill || theme.config?.anchor_line?.color || "#888";
  const textAccent = theme.config?.poi_label?.text_color || "#000";

  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md",
        isArchived && "opacity-60",
      )}
    >
      <CardContent className="p-4 space-y-3">
        {/* Swatch + name row */}
        <div className="flex items-start gap-3">
          <div
            className="h-10 w-10 rounded-md shrink-0 border"
            style={{
              backgroundColor: typeof accent === "string" && accent.startsWith("#") ? accent : "#888",
            }}
            aria-hidden
          >
            <div
              className="h-full w-full rounded-md flex items-center justify-center text-[9px] font-bold"
              style={{ color: typeof textAccent === "string" && textAccent.startsWith("#") ? textAccent : "#000" }}
            >
              Aa
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-semibold truncate">{theme.name}</p>
              {theme.is_default && !isArchived && (
                <Badge className="text-[9px] bg-primary/10 text-primary hover:bg-primary/10 border-primary/20">
                  Default
                </Badge>
              )}
              {isArchived && (
                <Badge variant="outline" className="text-[9px] font-normal">
                  Archived
                </Badge>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              v{theme.version || 1} · edited {formatRelative(theme.updated_at)}
            </p>
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            className="h-7 text-xs gap-1"
          >
            <Pencil className="h-3 w-3" />
            {canEdit ? "Edit" : "View"}
          </Button>
          {canEdit && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={onDuplicate}
                className="h-7 text-xs gap-1"
              >
                <Copy className="h-3 w-3" />
                Duplicate
              </Button>
              {!theme.is_default && !isArchived && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onSetDefault}
                  className="h-7 text-xs gap-1"
                  title="Make this the default theme for this owner"
                >
                  <Star className="h-3 w-3" />
                  Set default
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={onArchive}
                className="h-7 text-xs gap-1"
              >
                <Archive className="h-3 w-3" />
                {isArchived ? "Restore" : "Archive"}
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ResolvedThemeSummary({ resolved, themes, ownerKind }) {
  const top = topSource(resolved.source_chain);
  const ownerLabel = ownerKind === "organisation" ? "organisation" : "person";
  const overridesActive = themes.some(t => t.is_default && t.status !== "archived");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-[10px] font-normal">
          {top?.owner_kind === "system"
            ? "Resolved from FlexMedia default"
            : `Resolved from ${top?.owner_kind} level`}
        </Badge>
        {top && (
          <span className="text-[10px] font-mono text-foreground">{top.theme_name}</span>
        )}
      </div>

      {/* Source chain breadcrumbs */}
      {resolved.source_chain?.length > 1 && (
        <div className="flex items-center gap-1 flex-wrap">
          {resolved.source_chain.map((s, idx) => (
            <span key={`${s.theme_id}-${idx}`} className="flex items-center gap-1">
              <Badge
                variant={idx === 0 ? "default" : "outline"}
                className="text-[9px] font-normal"
              >
                {s.owner_kind} · {s.theme_name}
              </Badge>
              {idx < resolved.source_chain.length - 1 && (
                <ChevronRight className="h-2.5 w-2.5 text-muted-foreground" />
              )}
            </span>
          ))}
        </div>
      )}

      {/* Inheritance diff summary */}
      {resolved.inheritance_diff && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 mt-2">
          {Object.entries(resolved.inheritance_diff).slice(0, 9).map(([key, src]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-1 px-2 py-1 rounded bg-muted/40 text-[10px]"
            >
              <span className="font-mono text-foreground truncate">{key}</span>
              <Badge
                variant="outline"
                className={cn(
                  "text-[9px] font-normal shrink-0",
                  src === "system" && "text-muted-foreground",
                  src === ownerKind && "text-primary border-primary/30",
                )}
              >
                {src}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {!overridesActive && (
        <p className="italic mt-1">
          No active default for this {ownerLabel} — render falls through to FlexMedia's system theme.
        </p>
      )}
    </div>
  );
}
