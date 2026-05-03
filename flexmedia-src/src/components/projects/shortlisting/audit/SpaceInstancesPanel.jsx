/**
 * SpaceInstancesPanel — W11.8 Audit subtab
 *
 * Operator-facing panel for the four space-instance audit affordances:
 * list / rename / merge / split. Lives above ShortlistingAuditLog inside
 * Project Details > Shortlisting > Audit.
 *
 * Backed by mig 455 RPCs:
 *   - list_space_instances(p_round_id, p_include_merged?)
 *   - rename_space_instance(p_instance_id, p_new_label)
 *   - merge_space_instances(p_keep_id, p_drop_id)
 *   - split_space_instances(p_source_id, p_group_ids_to_split, p_new_label?)
 *
 * Instances are grouped by space_type, sorted within space_type by
 * instance_index ASC. Low-confidence rows (cluster_confidence < 0.7) carry a
 * yellow "uncertain" badge. Soft-deleted (operator_merged_into) rows are
 * hidden by default; operator can toggle "Show merged" to reveal them as
 * read-only audit trail entries.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  Pencil,
  Split,
  GitMerge,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const LOW_CONFIDENCE_THRESHOLD = 0.7;

function fmtConfidence(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(2);
}

function spaceTypeLabel(s) {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").toLowerCase();
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Rename dialog                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

function RenameDialog({ open, onOpenChange, instance, onSubmit }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  // Initialise input when the dialog opens for a fresh instance.
  useMemo(() => {
    if (open) setLabel(instance?.display_label || "");
  }, [open, instance?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const trimmed = label.trim();
    if (!trimmed || !instance) return;
    setBusy(true);
    try {
      await onSubmit(instance.id, trimmed);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="rename-instance-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename space instance</DialogTitle>
          <DialogDescription>
            Updates the display label for operators and downstream UI. Marks
            the row as operator-renamed in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-instance-label">Display label</Label>
          <Input
            id="rename-instance-label"
            data-testid="rename-instance-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            data-testid="rename-instance-submit"
            onClick={submit}
            disabled={busy || !label.trim()}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Merge dialog                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

function MergeDialog({ open, onOpenChange, source, siblings, onSubmit }) {
  const [keepId, setKeepId] = useState("");
  const [busy, setBusy] = useState(false);

  useMemo(() => {
    if (open) {
      // Default to the lowest-index sibling (the "primary").
      const primary = siblings?.[0];
      setKeepId(primary?.id || "");
    }
  }, [open, source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!source || !keepId) return;
    setBusy(true);
    try {
      await onSubmit(keepId, source.id);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="merge-instance-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge into another instance</DialogTitle>
          <DialogDescription>
            Re-points all composition groups from "{source?.display_label}"
            into the chosen sibling, then soft-deletes this row. The audit
            trail is preserved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Merge into</Label>
          <Select value={keepId} onValueChange={setKeepId} disabled={busy}>
            <SelectTrigger data-testid="merge-instance-select">
              <SelectValue placeholder="Pick a sibling instance" />
            </SelectTrigger>
            <SelectContent>
              {(siblings || []).map((sib) => (
                <SelectItem key={sib.id} value={sib.id}>
                  {sib.display_label} (#{sib.instance_index})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            data-testid="merge-instance-submit"
            onClick={submit}
            disabled={busy || !keepId}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Split dialog                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

function SplitDialog({ open, onOpenChange, source, groups, onSubmit }) {
  const [selected, setSelected] = useState(() => new Set());
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);

  useMemo(() => {
    if (open) {
      setSelected(new Set());
      setNewLabel("");
    }
  }, [open, source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!source || selected.size === 0) return;
    setBusy(true);
    try {
      await onSubmit(source.id, Array.from(selected), newLabel.trim() || null);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="split-instance-dialog"
        className="sm:max-w-2xl max-h-[80vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Split instance</DialogTitle>
          <DialogDescription>
            Pick the composition groups to move out of "
            {source?.display_label}" — they'll form a new instance. Useful
            when the engine clustered two physical rooms into one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="split-instance-new-label">
              New instance label (optional)
            </Label>
            <Input
              id="split-instance-new-label"
              data-testid="split-instance-new-label"
              placeholder={`Default: "${spaceTypeLabel(source?.space_type)}" + auto index`}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Groups to move out ({selected.size} selected)</Label>
            <div
              data-testid="split-instance-group-list"
              className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto p-2 border rounded"
            >
              {(groups || []).map((g) => {
                const checked = selected.has(g.id);
                return (
                  <label
                    key={g.id}
                    data-testid={`split-instance-group-${g.id}`}
                    className={cn(
                      "flex flex-col gap-1 p-1 border rounded cursor-pointer text-[10px]",
                      checked && "border-emerald-500 ring-1 ring-emerald-500/40",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(g.id)}
                        disabled={busy}
                      />
                      <span className="truncate" title={g.delivery_reference_stem || g.best_bracket_stem || g.id}>
                        {g.delivery_reference_stem || g.best_bracket_stem || g.id.slice(0, 8)}
                      </span>
                    </div>
                    {g.dropbox_preview_path ? (
                      <DroneThumbnail
                        dropboxPath={g.dropbox_preview_path}
                        mode="thumb"
                        alt={g.delivery_reference_stem || "group"}
                        aspectRatio="aspect-[3/2]"
                      />
                    ) : (
                      <div className="aspect-[3/2] bg-muted rounded" />
                    )}
                  </label>
                );
              })}
              {(!groups || groups.length === 0) && (
                <div className="col-span-full text-center text-xs text-muted-foreground py-4">
                  No groups yet — try refreshing.
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            data-testid="split-instance-submit"
            onClick={submit}
            disabled={busy || selected.size === 0}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Split
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Per-instance card                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

function InstanceCard({
  instance,
  siblings,
  onRename,
  onSplit,
  onMerge,
}) {
  const lowConfidence =
    typeof instance.cluster_confidence === "number" &&
    instance.cluster_confidence < LOW_CONFIDENCE_THRESHOLD;
  const merged = !!instance.operator_merged_into;
  const colors = Array.isArray(instance.dominant_colors)
    ? instance.dominant_colors
    : [];
  const features = Array.isArray(instance.distinctive_features)
    ? instance.distinctive_features
    : [];
  const summaryBits = [
    `${instance.member_group_count ?? 0} composition groups`,
    ...(colors.length ? [colors.join(", ")] : []),
    ...(features.length ? [features.join(", ")] : []),
  ];

  return (
    <Card
      data-testid={`space-instance-card-${instance.id}`}
      className={cn("border", merged && "opacity-60 border-dashed")}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="w-32 shrink-0">
            {instance.representative_dropbox_path ? (
              <DroneThumbnail
                dropboxPath={instance.representative_dropbox_path}
                mode="thumb"
                alt={instance.display_label || "space instance"}
                aspectRatio="aspect-[3/2]"
              />
            ) : (
              <div className="aspect-[3/2] bg-muted rounded text-[10px] flex items-center justify-center text-muted-foreground">
                no preview
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4
                data-testid={`space-instance-label-${instance.id}`}
                className="text-sm font-semibold truncate"
              >
                {instance.display_label || "(unlabelled)"}
              </h4>
              <Badge variant="outline" className="text-[9px]">
                #{instance.instance_index}
              </Badge>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                confidence {fmtConfidence(instance.cluster_confidence)}
              </span>
              {lowConfidence && (
                <Badge
                  data-testid={`low-confidence-badge-${instance.id}`}
                  className="bg-yellow-100 text-yellow-800 border-yellow-300 text-[9px] flex items-center gap-1"
                >
                  <AlertTriangle className="h-3 w-3" />
                  uncertain
                </Badge>
              )}
              {instance.operator_renamed && (
                <Badge variant="outline" className="text-[9px]">
                  renamed
                </Badge>
              )}
              {instance.operator_split_from && (
                <Badge variant="outline" className="text-[9px]">
                  split
                </Badge>
              )}
              {merged && (
                <Badge variant="outline" className="text-[9px] border-red-300 text-red-700">
                  merged → other
                </Badge>
              )}
            </div>
            {summaryBits.length > 0 && (
              <p className="text-[11px] text-muted-foreground leading-snug">
                {summaryBits.join(" · ")}
              </p>
            )}
            {!merged && (
              <div className="flex items-center gap-1.5 pt-0.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => onRename(instance)}
                  data-testid={`rename-instance-btn-${instance.id}`}
                >
                  <Pencil className="h-3 w-3 mr-1" />
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => onSplit(instance)}
                  data-testid={`split-instance-btn-${instance.id}`}
                >
                  <Split className="h-3 w-3 mr-1" />
                  Split groups
                </Button>
                {instance.instance_index > 1 && siblings.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => onMerge(instance, siblings)}
                    data-testid={`merge-instance-btn-${instance.id}`}
                  >
                    <GitMerge className="h-3 w-3 mr-1" />
                    Merge into…
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Top-level panel                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

export default function SpaceInstancesPanel({ roundId }) {
  const queryClient = useQueryClient();
  const [showMerged, setShowMerged] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [mergeTarget, setMergeTarget] = useState(null);
  const [mergeSiblings, setMergeSiblings] = useState([]);
  const [splitTarget, setSplitTarget] = useState(null);

  const instancesQuery = useQuery({
    queryKey: ["space_instances", roundId, showMerged],
    queryFn: async () => {
      if (!roundId) return [];
      const data = await api.rpc("list_space_instances", {
        p_round_id: roundId,
        p_include_merged: showMerged,
      });
      return Array.isArray(data) ? data : [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  // For the split dialog: composition_groups for the source instance.
  // We lazy-load via the shape-d table when the dialog opens.
  const splitGroupsQuery = useQuery({
    queryKey: ["space_instance_split_groups", splitTarget?.id],
    queryFn: async () => {
      if (!splitTarget) return [];
      const ids = Array.isArray(splitTarget.member_group_ids)
        ? splitTarget.member_group_ids
        : [];
      if (ids.length === 0) return [];
      const rows = await api.entities.CompositionGroup.filter(
        { id: { $in: ids } },
        null,
        ids.length,
      );
      return rows || [];
    },
    enabled: Boolean(splitTarget?.id),
    staleTime: 5_000,
  });

  const instances = instancesQuery.data || [];

  // Group by space_type → array of instances (sorted by instance_index ASC).
  const grouped = useMemo(() => {
    const map = new Map();
    for (const i of instances) {
      const key = i.space_type || "(unknown)";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(i);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => (a.instance_index || 0) - (b.instance_index || 0));
    }
    // Sort space_types alphabetically.
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [instances]);

  const refresh = () => {
    instancesQuery.refetch();
  };

  const submitRename = async (instanceId, newLabel) => {
    try {
      await api.rpc("rename_space_instance", {
        p_instance_id: instanceId,
        p_new_label: newLabel,
      });
      toast.success(`Renamed to "${newLabel}"`);
      refresh();
    } catch (e) {
      toast.error(`Rename failed: ${e?.message || e}`);
      throw e;
    }
  };

  const submitMerge = async (keepId, dropId) => {
    try {
      await api.rpc("merge_space_instances", {
        p_keep_id: keepId,
        p_drop_id: dropId,
      });
      toast.success("Merged");
      refresh();
    } catch (e) {
      toast.error(`Merge failed: ${e?.message || e}`);
      throw e;
    }
  };

  const submitSplit = async (sourceId, groupIds, newLabel) => {
    try {
      await api.rpc("split_space_instances", {
        p_source_id: sourceId,
        p_group_ids_to_split: groupIds,
        p_new_label: newLabel,
      });
      toast.success(`Split off ${groupIds.length} group(s)`);
      refresh();
    } catch (e) {
      toast.error(`Split failed: ${e?.message || e}`);
      throw e;
    }
  };

  if (!roundId) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Select a round to view detected space instances.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="space-instances-panel">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
            Space Instances
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Operator audit: rename / split / merge engine-detected room
            clusters.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Checkbox
              data-testid="space-instances-show-merged"
              checked={showMerged}
              onCheckedChange={(v) => setShowMerged(Boolean(v))}
            />
            Show merged
          </label>
          <Button
            data-testid="space-instances-refresh"
            size="sm"
            variant="outline"
            className="h-8"
            onClick={refresh}
            disabled={instancesQuery.isFetching}
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5 mr-1",
                instancesQuery.isFetching && "animate-spin",
              )}
            />
            Refresh
          </Button>
        </div>
      </div>

      {instancesQuery.isLoading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-24 bg-muted rounded" />
          <div className="h-24 bg-muted rounded" />
        </div>
      ) : instancesQuery.isError ? (
        <Card>
          <CardContent className="p-4 text-xs text-red-700">
            Failed to load space instances: {instancesQuery.error?.message || "unknown error"}
          </CardContent>
        </Card>
      ) : instances.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No space instances detected for this round yet.
          </CardContent>
        </Card>
      ) : (
        grouped.map(([spaceType, list]) => {
          const liveSiblings = list.filter((i) => !i.operator_merged_into);
          return (
            <section
              key={spaceType}
              data-testid={`space-instance-group-${spaceType}`}
              className="space-y-1.5"
            >
              <header className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                <span className="font-semibold">{spaceTypeLabel(spaceType)}</span>
                <span>
                  ({liveSiblings.length} instance{liveSiblings.length === 1 ? "" : "s"} detected)
                </span>
              </header>
              <div className="space-y-1.5">
                {list.map((i) => (
                  <InstanceCard
                    key={i.id}
                    instance={i}
                    siblings={liveSiblings.filter((s) => s.id !== i.id)}
                    onRename={(inst) => setRenameTarget(inst)}
                    onSplit={(inst) => setSplitTarget(inst)}
                    onMerge={(inst, sibs) => {
                      setMergeTarget(inst);
                      setMergeSiblings(sibs);
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      <RenameDialog
        open={!!renameTarget}
        onOpenChange={(v) => {
          if (!v) setRenameTarget(null);
        }}
        instance={renameTarget}
        onSubmit={submitRename}
      />
      <MergeDialog
        open={!!mergeTarget}
        onOpenChange={(v) => {
          if (!v) {
            setMergeTarget(null);
            setMergeSiblings([]);
          }
        }}
        source={mergeTarget}
        siblings={mergeSiblings}
        onSubmit={submitMerge}
      />
      <SplitDialog
        open={!!splitTarget}
        onOpenChange={(v) => {
          if (!v) setSplitTarget(null);
        }}
        source={splitTarget}
        groups={splitGroupsQuery.data || []}
        onSubmit={submitSplit}
      />
    </div>
  );
}
