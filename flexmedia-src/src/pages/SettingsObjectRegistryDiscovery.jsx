/**
 * SettingsObjectRegistryDiscovery — W11.6.11 / W12 admin UI for the discovery queue.
 *
 * Spec: docs/design-specs/W12-object-attribute-registry.md §"Discovery queue UI"
 *
 * URL:        /SettingsObjectRegistryDiscovery
 * Permission: master_admin only (rights to read AND mutate; this is the
 *             owner-curated taxonomy surface).
 *
 * Layout:
 *   1. Filters bar          — project, status, source, search (URL-persisted)
 *   2. Counts header chips  — pending / promoted / rejected / deferred
 *   3. List of cards        — each row: thumbnails + nearest canonicals + actions
 *   4. Pagination footer
 *
 * Style mirrors CalibrationDashboard.jsx: slate-tinted cards, tabular-nums,
 * compact type. No animation.
 *
 * Both data sources flow through the canonical-discovery-queue edge fn.
 * Mutations (promote/reject/defer) go through canonical-discovery-promote.
 *
 * Empty state:
 *   When the queue is empty (which is the expected state pre-W11.6.6 ship),
 *   the page renders a copy explaining that Stage 4 will surface candidates
 *   when Gemini suggests new slot taxonomy entries.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Image as ImageIcon,
  ArrowRight,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { cn } from "@/lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function fmtSim(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(3);
}

/** Normalise free text into a snake_case canonical_label suggestion. */
function suggestCanonicalLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

// ─── Query hooks ────────────────────────────────────────────────────────────

function useDiscoveryQueue({ project_id, status, source, search, page, limit }) {
  return useQuery({
    queryKey: ["w12_discovery_queue", project_id, status, source, search, page, limit],
    queryFn: async () => {
      const result = await api.functions.invoke("canonical-discovery-queue", {
        project_id: project_id || null,
        status,
        source,
        search: search || null,
        page,
        limit,
      });
      if (result?.error) {
        throw new Error(result.error.message || result.error.body?.error || "fetch failed");
      }
      return result?.data ?? result;
    },
    staleTime: 30_000,
    keepPreviousData: true,
  });
}

function useProjectsList() {
  return useQuery({
    queryKey: ["w12_projects_dropdown"],
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("projects")
        .select("id, title, property_address, property_tier")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 5 * 60_000,
  });
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CountsRow({ counts }) {
  if (!counts) return null;
  const items = [
    { key: "pending", label: "Pending", icon: Clock, color: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
    { key: "promoted", label: "Promoted", icon: CheckCircle2, color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" },
    { key: "rejected", label: "Rejected", icon: XCircle, color: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300" },
    { key: "deferred", label: "Deferred", icon: Clock, color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {items.map(({ key, label, icon: Icon, color }) => (
        <div key={key} className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium", color)}>
          <Icon className="h-3.5 w-3.5" />
          <span>{label}</span>
          <span className="font-mono tabular-nums">{counts[key] ?? 0}</span>
        </div>
      ))}
    </div>
  );
}

function FiltersBar({ filters, projects, onFilterChange }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="project" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Project
            </Label>
            <Select
              value={filters.project_id || "all"}
              onValueChange={(v) => onFilterChange({ project_id: v === "all" ? "" : v })}
            >
              <SelectTrigger id="project" className="h-8 text-xs mt-1">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {(projects || []).map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.title || p.property_address || p.id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="status" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Status
            </Label>
            <Select
              value={filters.status || "pending"}
              onValueChange={(v) => onFilterChange({ status: v, page: 0 })}
            >
              <SelectTrigger id="status" className="h-8 text-xs mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending" className="text-xs">Pending</SelectItem>
                <SelectItem value="promoted" className="text-xs">Promoted</SelectItem>
                <SelectItem value="rejected" className="text-xs">Rejected</SelectItem>
                <SelectItem value="deferred" className="text-xs">Deferred</SelectItem>
                <SelectItem value="all" className="text-xs">All</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="source" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Source
            </Label>
            <Select
              value={filters.source || "all"}
              onValueChange={(v) => onFilterChange({ source: v, page: 0 })}
            >
              <SelectTrigger id="source" className="h-8 text-xs mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All sources</SelectItem>
                <SelectItem value="slot_suggestion" className="text-xs">Slot suggestions</SelectItem>
                <SelectItem value="object_candidate" className="text-xs">Object candidates</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="search" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Search
            </Label>
            <div className="relative mt-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                id="search"
                placeholder="proposed_slot_id / reasoning…"
                value={filters.search || ""}
                onChange={(e) => onFilterChange({ search: e.target.value, page: 0 })}
                className="h-8 text-xs pl-7"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }) {
  if (status === "promoted") {
    return (
      <Badge className="text-[10px] h-5 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        Promoted
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge className="text-[10px] h-5 bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-300">
        Rejected
      </Badge>
    );
  }
  if (status === "deferred") {
    return (
      <Badge className="text-[10px] h-5 bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
        Deferred
      </Badge>
    );
  }
  return (
    <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      Pending
    </Badge>
  );
}

function ThumbnailRow({ thumbnails }) {
  if (!thumbnails || thumbnails.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5" />
        <span>No candidate stems matched composition_groups</span>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
      {thumbnails.slice(0, 4).map((t) => (
        <div key={t.stem} className="relative">
          {t.dropbox_preview_path ? (
            <DroneThumbnail
              dropboxPath={t.dropbox_preview_path}
              mode="thumb"
              alt={t.stem}
              aspectRatio="aspect-[4/3]"
              className="rounded border border-slate-200 dark:border-slate-700"
            />
          ) : (
            <div className="aspect-[4/3] rounded border border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center bg-slate-50 dark:bg-slate-900/30">
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
          <div className="text-[9px] text-muted-foreground truncate mt-0.5" title={t.stem}>
            {t.stem}
          </div>
        </div>
      ))}
    </div>
  );
}

function NearestCanonicalsList({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        No close canonical matches
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {rows.slice(0, 3).map((m, i) => (
        <li key={`${m.id}_${i}`} className="flex items-center gap-2 text-[11px]">
          <span className="w-3.5 text-muted-foreground tabular-nums text-right">
            {i + 1}
          </span>
          <span className="font-mono">{m.canonical_id}</span>
          <span className="text-muted-foreground truncate">— {m.display_name}</span>
          <span className="ml-auto font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
            {fmtSim(m.similarity)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PromoteDialog({ open, onOpenChange, row, onSubmit, busy }) {
  const [canonicalLabel, setCanonicalLabel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [level0, setLevel0] = useState("");
  const [level1, setLevel1] = useState("");

  useEffect(() => {
    if (row) {
      setCanonicalLabel(suggestCanonicalLabel(row.proposed_label));
      setDisplayName(row.proposed_display_name || row.proposed_label);
      setDescription(row.reasoning || "");
      setAliases("");
      setLevel0("");
      setLevel1("");
    }
  }, [row]);

  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            Promote to canonical {row.source_type === "slot_suggestion" ? "slot" : "object"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label htmlFor="canonical_label" className="text-[10px] uppercase tracking-wide">
              canonical_label <span className="text-red-500">*</span>
            </Label>
            <Input
              id="canonical_label"
              value={canonicalLabel}
              onChange={(e) => setCanonicalLabel(e.target.value)}
              placeholder="kitchen_island"
              className="font-mono text-xs h-8 mt-1"
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              snake_case lowercase. Validated against /^[a-z0-9_]+$/.
            </p>
          </div>
          <div>
            <Label htmlFor="display_name" className="text-[10px] uppercase tracking-wide">
              display_name
            </Label>
            <Input
              id="display_name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="text-xs h-8 mt-1"
            />
          </div>
          <div>
            <Label htmlFor="description" className="text-[10px] uppercase tracking-wide">
              description
            </Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="text-xs mt-1 min-h-[60px]"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="level_0" className="text-[10px] uppercase tracking-wide">
                level_0_class
              </Label>
              <Input
                id="level_0"
                value={level0}
                onChange={(e) => setLevel0(e.target.value)}
                placeholder="kitchen | bathroom | …"
                className="text-xs h-8 mt-1 font-mono"
              />
            </div>
            <div>
              <Label htmlFor="level_1" className="text-[10px] uppercase tracking-wide">
                level_1_functional
              </Label>
              <Input
                id="level_1"
                value={level1}
                onChange={(e) => setLevel1(e.target.value)}
                placeholder="benchtop | tap | …"
                className="text-xs h-8 mt-1 font-mono"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="aliases" className="text-[10px] uppercase tracking-wide">
              aliases (comma-separated)
            </Label>
            <Input
              id="aliases"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="caesarstone island, stone benchtop"
              className="text-xs h-8 mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onSubmit({
                canonical_label: canonicalLabel.trim(),
                display_name: displayName.trim(),
                description: description.trim() || null,
                level_0_class: level0.trim() || null,
                level_1_functional: level1.trim() || null,
                aliases: aliases
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean),
              })
            }
            disabled={busy || !canonicalLabel.trim()}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            )}
            Promote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ open, onOpenChange, row, onSubmit, busy }) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!row) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-600" />
            Reject candidate
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Marks the proposal as rejected. The reason is stored on the source row for audit.
          </p>
          <Label htmlFor="reject_reason" className="text-[10px] uppercase tracking-wide">
            reason
          </Label>
          <Textarea
            id="reject_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. duplicates kitchen_island; not distinct enough"
            className="text-xs"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onSubmit({ reason: reason.trim() })}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiscoveryCard({ row, onPromote, onReject, onDefer, busy }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const isPending = row.status === "pending";

  return (
    <Card data-testid="discovery-card" data-source={row.source_type} data-status={row.status}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge
                className={cn(
                  "text-[9px] h-4 px-1",
                  row.source_type === "slot_suggestion"
                    ? "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                    : "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
                )}
              >
                {row.source_type === "slot_suggestion" ? "SLOT" : "OBJECT"}
              </Badge>
              <span className="font-mono">{row.proposed_label}</span>
            </CardTitle>
            <CardDescription className="text-[11px] mt-0.5">
              Observed {row.observed_count}× · {fmtTime(row.created_at)}
              {row.project_id ? ` · project ${row.project_id.slice(0, 8)}` : ""}
              {row.round_id ? ` · round ${row.round_id.slice(0, 8)}` : ""}
            </CardDescription>
          </div>
          <StatusBadge status={row.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        {row.thumbnails && row.thumbnails.length > 0 && (
          <ThumbnailRow thumbnails={row.thumbnails} />
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="border rounded p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Top-3 nearest canonicals
            </div>
            <NearestCanonicalsList rows={row.nearest_canonicals} />
          </div>
          <div className="border rounded p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Operator history
            </div>
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {row.operator_history?.promoted_at && (
                <li>
                  <span className="text-emerald-700 dark:text-emerald-400">Promoted</span>{" "}
                  {fmtTime(row.operator_history.promoted_at)}
                  {row.operator_history.promoted_into_id ? (
                    <span className="font-mono ml-1">
                      → {String(row.operator_history.promoted_into_id).slice(0, 8)}
                    </span>
                  ) : null}
                </li>
              )}
              {row.operator_history?.rejected_at && (
                <li>
                  <span className="text-red-700 dark:text-red-400">Rejected</span>{" "}
                  {fmtTime(row.operator_history.rejected_at)}
                </li>
              )}
              {row.operator_history?.deferred_until && (
                <li>
                  <span>Deferred</span> until{" "}
                  {new Date(row.operator_history.deferred_until).toLocaleDateString()}
                </li>
              )}
              {!row.operator_history?.promoted_at &&
                !row.operator_history?.rejected_at &&
                !row.operator_history?.deferred_until && (
                  <li className="italic">Never reviewed</li>
                )}
            </ul>
          </div>
        </div>

        {row.reasoning && (
          <div>
            <button
              type="button"
              onClick={() => setShowReasoning((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              {showReasoning ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Stage 4 reasoning
            </button>
            {showReasoning && (
              <div className="mt-1 px-2 py-1.5 rounded border-l-2 border-blue-500 bg-blue-50/40 dark:bg-blue-950/20 text-[11px] italic text-foreground/80">
                {row.reasoning}
              </div>
            )}
          </div>
        )}

        {isPending && (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onPromote(row)}
              disabled={busy}
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Promote
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onReject(row)}
              disabled={busy}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              Reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onDefer(row)}
              disabled={busy}
            >
              <Clock className="h-3.5 w-3.5 mr-1" />
              Defer 7d
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PaginationFooter({ page, hasMore, total, limit, onPageChange }) {
  return (
    <div className="flex items-center justify-between pt-2">
      <div className="text-xs text-muted-foreground tabular-nums">
        {total != null
          ? `Page ${page + 1} · showing ${page * limit + 1}-${Math.min(total, (page + 1) * limit)} of ${total}`
          : `Page ${page + 1}`}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
        >
          <ChevronLeft className="h-3.5 w-3.5 mr-1" />
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={!hasMore}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Button>
      </div>
    </div>
  );
}

function EmptyState({ filters }) {
  return (
    <Card>
      <CardContent className="p-6 text-center text-sm text-muted-foreground">
        <div className="mx-auto w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="font-medium text-foreground">No proposals to review yet</p>
        <p className="mt-1 max-w-md mx-auto text-xs">
          Stage 4 will surface them here when Gemini suggests new slot taxonomy entries.
          The canonical-rollup batch surfaces object candidates from Stage 1's free-text
          key_elements.
        </p>
        {(filters.search || filters.status !== "pending" || filters.source !== "all") && (
          <p className="mt-2 text-[11px]">
            (Filter is non-default — try clearing search or switching status to "all".)
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function SettingsObjectRegistryDiscovery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(Number(searchParams.get("page") || 0));
  const [promoteRow, setPromoteRow] = useState(null);
  const [rejectRow, setRejectRow] = useState(null);

  const filters = {
    project_id: searchParams.get("project_id") || "",
    status: searchParams.get("status") || "pending",
    source: searchParams.get("source") || "all",
    search: searchParams.get("search") || "",
  };
  const limit = Number(searchParams.get("limit") || 25);

  // URL persistence: any filter change writes back to the URL.
  const updateFilters = (patch) => {
    const next = new URLSearchParams(searchParams);
    let nextPage = page;
    Object.entries(patch).forEach(([k, v]) => {
      if (k === "page") {
        nextPage = Number(v);
        if (Number(v)) next.set("page", String(v));
        else next.delete("page");
      } else if (v == null || v === "") {
        next.delete(k);
      } else {
        next.set(k, String(v));
      }
    });
    setSearchParams(next, { replace: true });
    setPage(nextPage);
  };

  const queryClient = useQueryClient();
  const queueQuery = useDiscoveryQueue({ ...filters, page, limit });
  const projectsQuery = useProjectsList();

  const promoteMutation = useMutation({
    mutationFn: async ({ event_id, ...args }) => {
      const result = await api.functions.invoke("canonical-discovery-promote", {
        event_id,
        action: "promote",
        target_table: "object_registry",
        ...args,
      });
      if (result?.error) {
        throw new Error(result.error.message || result.error.body?.error || "promote failed");
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      if (data?.idempotent) {
        toast.message(`Already exists — ${data?.canonical_label}; source marked promoted`);
      } else {
        toast.success(`Promoted as ${data?.canonical_label}`);
      }
      setPromoteRow(null);
      queryClient.invalidateQueries({ queryKey: ["w12_discovery_queue"] });
    },
    onError: (err) => toast.error(`Promote failed: ${err?.message || err}`),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ event_id, reason }) => {
      const result = await api.functions.invoke("canonical-discovery-promote", {
        event_id,
        action: "reject",
        reason,
      });
      if (result?.error) {
        throw new Error(result.error.message || result.error.body?.error || "reject failed");
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      toast.success("Rejected");
      setRejectRow(null);
      queryClient.invalidateQueries({ queryKey: ["w12_discovery_queue"] });
    },
    onError: (err) => toast.error(`Reject failed: ${err?.message || err}`),
  });

  const deferMutation = useMutation({
    mutationFn: async ({ event_id, defer_days }) => {
      const result = await api.functions.invoke("canonical-discovery-promote", {
        event_id,
        action: "defer",
        defer_days,
      });
      if (result?.error) {
        throw new Error(result.error.message || result.error.body?.error || "defer failed");
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      toast.success("Deferred 7 days");
      queryClient.invalidateQueries({ queryKey: ["w12_discovery_queue"] });
    },
    onError: (err) => toast.error(`Defer failed: ${err?.message || err}`),
  });

  const data = queueQuery.data;
  const rows = data?.rows ?? [];
  const counts = data?.counts;
  const totalRows = data?.total;
  const hasMore = !!data?.has_more;

  const busy = promoteMutation.isPending || rejectMutation.isPending || deferMutation.isPending;

  const onPromote = (row) => setPromoteRow(row);
  const onReject = (row) => setRejectRow(row);
  const onDefer = (row) => deferMutation.mutate({ event_id: row.id, defer_days: 7 });

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-3 max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-600" />
              Object registry — Discovery queue
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Wave 12 / W11.6.11 — review Gemini's slot suggestions and the canonical-rollup
              batch's object candidates. Promote into <code className="text-[11px] bg-slate-100 dark:bg-slate-800 px-1 rounded">object_registry</code>,
              reject, or defer. Decisions feed back into Stage 1's prompt grounding via
              the canonical feature registry block.
            </p>
          </div>
          {counts && <CountsRow counts={counts} />}
        </div>

        <FiltersBar filters={filters} projects={projectsQuery.data} onFilterChange={updateFilters} />

        {queueQuery.isLoading && !data ? (
          <Skeleton className="h-32 w-full" />
        ) : queueQuery.isError ? (
          <Card className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20">
            <CardContent className="p-3 text-xs text-red-700 dark:text-red-400">
              Failed to load: {String(queueQuery.error?.message || queueQuery.error)}
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <EmptyState filters={filters} />
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <DiscoveryCard
                key={row.id}
                row={row}
                onPromote={onPromote}
                onReject={onReject}
                onDefer={onDefer}
                busy={busy}
              />
            ))}
            <PaginationFooter
              page={page}
              hasMore={hasMore}
              total={totalRows}
              limit={limit}
              onPageChange={(p) => updateFilters({ page: p })}
            />
          </div>
        )}

        <PromoteDialog
          open={!!promoteRow}
          onOpenChange={(o) => !o && setPromoteRow(null)}
          row={promoteRow}
          busy={promoteMutation.isPending}
          onSubmit={(args) => promoteMutation.mutate({ event_id: promoteRow.id, ...args })}
        />

        <RejectDialog
          open={!!rejectRow}
          onOpenChange={(o) => !o && setRejectRow(null)}
          row={rejectRow}
          busy={rejectMutation.isPending}
          onSubmit={({ reason }) => rejectMutation.mutate({ event_id: rejectRow.id, reason })}
        />

        <Card className="border-blue-200 dark:border-blue-900 bg-blue-50/30 dark:bg-blue-950/10">
          <CardContent className="p-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Spec:</span>{" "}
            See <code>docs/design-specs/W12-object-attribute-registry.md</code> for the
            schema, similarity thresholds (0.92 / 0.75), and the closed-loop ethos. Slot
            suggestions are emitted by Stage 4 (W11.6.6); object candidates are produced
            by the canonical-rollup batch over Stage 1 outputs.
          </CardContent>
        </Card>
      </div>
    </PermissionGuard>
  );
}
