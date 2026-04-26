/**
 * ProjectFilesTab — Drone Phase 1 PR7b
 *
 * Files tab for ProjectDetails. Renders the per-project Dropbox folder tree
 * (9 folder kinds), per-folder file list on click, master_admin override
 * panel, and a master_admin/admin Re-sync button.
 *
 * Backend (already deployed):
 *   - api.rpc('get_project_folder_stats', { p_project_id })
 *   - api.functions.invoke('getProjectFolderFiles', { project_id, folder_kind })
 *   - api.functions.invoke('setProjectFolderOverride', { project_id, folder_kind, new_path })
 *   - api.functions.invoke('dropbox-reconcile')
 *
 * The real-time activity log is intentionally NOT included here — that's
 * shipping in PR7c (lead session). A placeholder slot is reserved at the
 * bottom of the layout.
 */

import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  RefreshCw,
  FolderOpen,
  Folder,
  File as FileIcon,
  AlertCircle,
  Loader2,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";
import ProjectFilesActivityLog from "./ProjectFilesActivityLog";

// ── Folder taxonomy (mirrors supabase/functions/_shared/projectFolders.ts) ──
//
// Wave 6 W6-T2-FE fix (QC iter 3): the legacy drone folder kinds (`raw_drones`,
// `enrichment_drone_renders_*`, `final_delivery_drones`) were dropped from
// project_folders by mig 247 + mig 291. The Files tab clicking those kinds
// was throwing 500s because getProjectFolderFiles couldn't resolve the path.
// Removed them from the taxonomy below and added the new `drones_*` tree
// (drone restructure 2026-04, see _shared/projectFolders.ts NEW_PROJECT_FOLDER_KINDS).
const ALL_FOLDER_KINDS = [
  "raw_photos",
  "raw_videos",
  "enrichment_orthomosaics",
  "enrichment_sfm_meshes",
  "audit",
  // Drone restructure 2026-04
  "drones_raws_shortlist_proposed",
  "drones_raws_shortlist_proposed_previews",
  "drones_raws_final_shortlist",
  "drones_raws_rejected",
  "drones_raws_others",
  "drones_editors_edited_post_production",
  "drones_editors_ai_proposed_enriched",
  "drones_editors_final_enriched",
  "drones_finals",
];

const LABELS = {
  raw_photos: "Photos",
  raw_videos: "Videos",
  enrichment_orthomosaics: "Orthomosaics",
  enrichment_sfm_meshes: "SfM Meshes",
  audit: "Audit Log",
  drones_raws_shortlist_proposed: "Raws — Shortlist Proposed",
  drones_raws_shortlist_proposed_previews: "Raws — Shortlist Previews",
  drones_raws_final_shortlist: "Raws — Final Shortlist",
  drones_raws_rejected: "Raws — Rejected",
  drones_raws_others: "Raws — Others",
  drones_editors_edited_post_production: "Editors — Edited Post-Production",
  drones_editors_ai_proposed_enriched: "Editors — AI Proposed Enriched",
  drones_editors_final_enriched: "Editors — Final Enriched",
  drones_finals: "Finals",
};

// Group definition: parent display name → { folderKinds[] }
const GROUPS = [
  {
    key: "01_RAW_WORKING",
    label: "01_RAW_WORKING",
    kinds: ["raw_photos", "raw_videos"],
  },
  {
    key: "06_ENRICHMENT",
    label: "06_ENRICHMENT",
    kinds: ["enrichment_orthomosaics", "enrichment_sfm_meshes"],
  },
  {
    key: "Drones/Raws",
    label: "Drones — Raws",
    kinds: [
      "drones_raws_shortlist_proposed",
      "drones_raws_shortlist_proposed_previews",
      "drones_raws_final_shortlist",
      "drones_raws_rejected",
      "drones_raws_others",
    ],
  },
  {
    key: "Drones/Editors",
    label: "Drones — Editors",
    kinds: [
      "drones_editors_edited_post_production",
      "drones_editors_ai_proposed_enriched",
      "drones_editors_final_enriched",
    ],
  },
  {
    key: "Drones/Finals",
    label: "Drones — Finals",
    kinds: ["drones_finals"],
  },
  {
    key: "_AUDIT",
    label: "_AUDIT",
    kinds: ["audit"],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(Number(bytes))) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelative(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

function formatAbsolute(iso) {
  if (!iso) return "";
  try {
    return format(new Date(iso), "d MMM yyyy, h:mm a");
  } catch {
    return "";
  }
}

// Defensive accessor: backend returns FileEntry as either
//   { id, name, path, size, modified }              (current _shared lib)
//   { name, path_lower, size, client_modified, server_modified, ... } (spec)
function fileModified(f) {
  return f?.modified || f?.client_modified || f?.server_modified || null;
}
function filePath(f) {
  return f?.path || f?.path_display || f?.path_lower || "";
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ProjectFilesTab({ project }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin, isAdminOrAbove } = usePermissions();

  const [selectedKind, setSelectedKind] = useState(null);
  // Per-folder file cache: { [folder_kind]: { files, fetchedAt } }
  const [fileCache, setFileCache] = useState({});
  const [filesLoading, setFilesLoading] = useState({});
  const [filesError, setFilesError] = useState({});

  const [showResyncDialog, setShowResyncDialog] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  // Override panel state
  const [overrideKind, setOverrideKind] = useState("");
  const [overridePath, setOverridePath] = useState("");
  const [overrideSaving, setOverrideSaving] = useState(false);

  // ── Folder stats RPC ─────────────────────────────────────────────────────
  const statsQuery = useQuery({
    queryKey: ["projectFolderStats", project?.id],
    queryFn: async () => {
      const rows = await api.rpc("get_project_folder_stats", {
        p_project_id: project.id,
      });
      // Index by folder_kind for O(1) lookup
      const byKind = {};
      for (const row of rows || []) {
        byKind[row.folder_kind] = row;
      }
      return byKind;
    },
    enabled: !!project?.id,
    staleTime: 30 * 1000,
  });

  const refreshStats = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["projectFolderStats", project?.id],
    });
  }, [queryClient, project?.id]);

  // ── On-click file fetch (with per-folder cache) ──────────────────────────
  const handleSelectKind = useCallback(
    async (kind) => {
      setSelectedKind(kind);
      if (fileCache[kind]) return; // already cached

      setFilesLoading((prev) => ({ ...prev, [kind]: true }));
      setFilesError((prev) => ({ ...prev, [kind]: null }));

      try {
        // QC4 follow-up: api.functions.invoke wraps response as { data: <body> }
        // (see api/supabaseClient.js:565). Reading `data.success` directly was
        // always undefined → every successful 200 response threw "Failed to
        // load files". Bug was masked pre-Wave-7 because the legacy folder
        // taxonomy threw 500s on the server, so users assumed backend failure.
        const result = await api.functions.invoke("getProjectFolderFiles", {
          project_id: project.id,
          folder_kind: kind,
        });
        const data = result?.data;
        if (!data?.success) {
          throw new Error(data?.error || "Failed to load files");
        }
        setFileCache((prev) => ({
          ...prev,
          [kind]: { files: data.files || [], fetchedAt: Date.now() },
        }));
      } catch (err) {
        const msg = err?.message || "Failed to load files";
        setFilesError((prev) => ({ ...prev, [kind]: msg }));
      } finally {
        setFilesLoading((prev) => ({ ...prev, [kind]: false }));
      }
    },
    [fileCache, project?.id],
  );

  const refreshSelectedFolder = useCallback(async () => {
    if (!selectedKind) return;
    setFileCache((prev) => {
      const next = { ...prev };
      delete next[selectedKind];
      return next;
    });
    await handleSelectKind(selectedKind);
  }, [selectedKind, handleSelectKind]);

  // ── Re-sync (master_admin/admin) ─────────────────────────────────────────
  const handleResyncConfirm = async () => {
    setResyncing(true);
    try {
      const result = await api.functions.invoke("dropbox-reconcile", {});
      const data = result?.data;
      if (!data?.success) {
        throw new Error(data?.error || "Re-sync failed");
      }
      toast.success(
        `Re-sync complete${
          typeof data.events_emitted === "number"
            ? ` — ${data.events_emitted} events`
            : ""
        }`,
      );
      setShowResyncDialog(false);
      refreshStats();
      // Bust file caches — paths/contents may have moved
      setFileCache({});
    } catch (err) {
      toast.error(err?.message || "Re-sync failed");
    } finally {
      setResyncing(false);
    }
  };

  // ── Override panel save (master_admin only) ──────────────────────────────
  const handleOverrideSave = async () => {
    if (!overrideKind) {
      toast.error("Select a folder kind");
      return;
    }
    if (!overridePath || !overridePath.startsWith("/")) {
      toast.error("Path must be absolute (start with /)");
      return;
    }
    setOverrideSaving(true);
    try {
      const result = await api.functions.invoke("setProjectFolderOverride", {
        project_id: project.id,
        folder_kind: overrideKind,
        new_path: overridePath.trim(),
      });
      const data = result?.data;
      if (!data?.success) {
        throw new Error(data?.error || "Override failed");
      }
      toast.success(`Override applied for ${LABELS[overrideKind]}`);
      setOverrideKind("");
      setOverridePath("");
      refreshStats();
      // Bust cache for that kind so next click reads from new path
      setFileCache((prev) => {
        const next = { ...prev };
        delete next[overrideKind];
        return next;
      });
    } catch (err) {
      toast.error(err?.message || "Override failed");
    } finally {
      setOverrideSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (!project?.id) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No project loaded.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Files</h2>
          {project.dropbox_root_path ? (
            <p className="text-xs text-muted-foreground font-mono mt-0.5 break-all">
              {project.dropbox_root_path}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-0.5">
              No Dropbox root path set
            </p>
          )}
        </div>
        {isAdminOrAbove && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowResyncDialog(true)}
            disabled={resyncing}
          >
            {resyncing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Re-sync
          </Button>
        )}
      </div>

      {/* Stats error banner */}
      {statsQuery.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            <p className="font-medium">Failed to load folder stats</p>
            <p className="text-xs mt-0.5">
              {statsQuery.error.message || "Unknown error"}
            </p>
          </div>
        </div>
      )}

      {/* Tree + file list */}
      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] divide-y lg:divide-y-0 lg:divide-x">
            {/* Folder tree */}
            <div className="p-3 lg:max-h-[560px] overflow-y-auto">
              {statsQuery.isLoading ? (
                <FolderTreeSkeleton />
              ) : (
                <FolderTree
                  statsByKind={statsQuery.data || {}}
                  selectedKind={selectedKind}
                  onSelect={handleSelectKind}
                />
              )}
            </div>

            {/* File list */}
            <div className="p-3 lg:max-h-[560px] overflow-y-auto">
              <FileList
                kind={selectedKind}
                loading={selectedKind ? filesLoading[selectedKind] : false}
                error={selectedKind ? filesError[selectedKind] : null}
                files={selectedKind ? fileCache[selectedKind]?.files : null}
                onRefresh={refreshSelectedFolder}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Admin override panel — master_admin only */}
      {isMasterAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Admin Folder Override
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Repoints a folder kind to a different Dropbox path.{" "}
              <span className="font-medium">
                Existing files at the old path are NOT moved
              </span>
              — this is a pointer change.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-[220px_1fr_auto] gap-2 items-end">
              <div className="space-y-1">
                <label
                  htmlFor="override-kind"
                  className="text-xs font-medium"
                >
                  Folder
                </label>
                <Select
                  value={overrideKind}
                  onValueChange={setOverrideKind}
                  disabled={overrideSaving}
                >
                  <SelectTrigger id="override-kind">
                    <SelectValue placeholder="Select folder kind" />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_FOLDER_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="override-path"
                  className="text-xs font-medium"
                >
                  New Dropbox path (must start with /)
                </label>
                <Input
                  id="override-path"
                  value={overridePath}
                  onChange={(e) => setOverridePath(e.target.value)}
                  placeholder="/Flex Media Team Folder/Projects/abc_address/01_RAW_WORKING/photos"
                  disabled={overrideSaving}
                  className="font-mono text-xs"
                />
              </div>
              <Button
                onClick={handleOverrideSave}
                disabled={
                  overrideSaving ||
                  !overrideKind ||
                  !overridePath.startsWith("/")
                }
              >
                {overrideSaving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Activity log (PR7c) */}
      <ProjectFilesActivityLog projectId={project?.id} />

      {/* Re-sync confirm dialog */}
      <Dialog open={showResyncDialog} onOpenChange={setShowResyncDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-sync Dropbox?</DialogTitle>
            <DialogDescription>
              Triggers <code className="text-xs">dropbox-reconcile</code>: a
              full delta scan of <code className="text-xs">/Flex Media Team Folder/Projects</code>.
              Any file events the webhook missed will be back-filled across all
              projects (not just this one). Safe to run — this runs nightly via
              cron.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResyncDialog(false)}
              disabled={resyncing}
            >
              Cancel
            </Button>
            <Button onClick={handleResyncConfirm} disabled={resyncing}>
              {resyncing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Re-sync now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── FolderTree ─────────────────────────────────────────────────────────────

function FolderTree({ statsByKind, selectedKind, onSelect }) {
  return (
    <div className="space-y-3 text-sm">
      {GROUPS.map((group) => (
        <div key={group.key}>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-1">
            <Folder className="h-3.5 w-3.5" />
            {group.label}
          </div>
          <div className="space-y-0.5">
            {group.kinds.map((kind) => {
              const stat = statsByKind[kind];
              const count = stat?.net_file_count ?? 0;
              const lastEvent = stat?.last_event_at;
              const isSelected = selectedKind === kind;
              return (
                <button
                  key={kind}
                  onClick={() => onSelect(kind)}
                  className={cn(
                    "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted",
                  )}
                  title={
                    lastEvent
                      ? `Last activity: ${formatAbsolute(lastEvent)}`
                      : "No activity recorded"
                  }
                >
                  {isSelected ? (
                    <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                  )}
                  <span className="flex-1 truncate">{LABELS[kind]}</span>
                  <span
                    className={cn(
                      "text-xs font-medium tabular-nums",
                      isSelected
                        ? "text-primary-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    ({count})
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function FolderTreeSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {GROUPS.map((g) => (
        <div key={g.key} className="space-y-1.5">
          <div className="h-3 bg-muted rounded w-1/3" />
          {g.kinds.map((k) => (
            <div key={k} className="h-7 bg-muted/60 rounded" />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── FileList ───────────────────────────────────────────────────────────────

function FileList({ kind, loading, error, files, onRefresh }) {
  if (!kind) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-12 text-muted-foreground">
        <Folder className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">Select a folder to view files</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{LABELS[kind]}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="h-7 text-xs"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {loading && !files ? (
        <FileListSkeleton />
      ) : error ? (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            <p className="font-medium">Failed to load files</p>
            <p className="text-xs mt-0.5">{error}</p>
          </div>
        </div>
      ) : !files || files.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">
          No files in this folder.
        </div>
      ) : (
        <FileTable files={files} />
      )}
    </div>
  );
}

function FileTable({ files }) {
  const sorted = useMemo(() => {
    return [...files].sort((a, b) => {
      const ma = fileModified(a);
      const mb = fileModified(b);
      if (!ma && !mb) return (a.name || "").localeCompare(b.name || "");
      if (!ma) return 1;
      if (!mb) return -1;
      return new Date(mb).getTime() - new Date(ma).getTime();
    });
  }, [files]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs font-medium text-muted-foreground">
            <th className="px-2 py-1.5">Name</th>
            <th className="px-2 py-1.5 w-24 text-right">Size</th>
            <th className="px-2 py-1.5 w-32">Modified</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f, i) => {
            const path = filePath(f);
            const modified = fileModified(f);
            return (
              <tr
                key={f.id || path || `${f.name}-${i}`}
                className="border-b last:border-0 hover:bg-muted/40"
              >
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span
                      className="truncate"
                      title={path || f.name || ""}
                    >
                      {f.name || path || "unnamed"}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {formatBytes(f.size)}
                </td>
                <td
                  className="px-2 py-1.5 text-muted-foreground"
                  title={formatAbsolute(modified)}
                >
                  {formatRelative(modified)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileListSkeleton() {
  return (
    <div className="space-y-1.5 animate-pulse">
      <div className="h-6 bg-muted/60 rounded" />
      <div className="h-6 bg-muted/60 rounded" />
      <div className="h-6 bg-muted/60 rounded" />
      <div className="h-6 bg-muted/60 rounded" />
    </div>
  );
}
