/**
 * EditorialPolicyEditor — Mig 465 surface for editing the GLOBAL editorial
 * policy that drives every project's shortlist when no per-package recipe
 * is configured.
 *
 * The editor reads/writes `shortlisting_engine_policy.id = 1` (the
 * singleton row created by mig 465).  Stage 4 reads this row at run time
 * to render its EDITORIAL DIRECTIVE block — so changes here take effect
 * on the very next round (no deploy needed).
 *
 * Permissions: master_admin only (RLS enforced).  Other roles see a
 * read-only banner.
 *
 * Versioning: when the operator saves, the prior policy is appended to
 * `shortlisting_engine_policy.history[]` (capped at 20 entries).  A
 * "Restore previous" dropdown lets them roll back without leaving the
 * editor.
 *
 * Lives ABOVE the legacy RecipeMatrixTab content so operators see the
 * global fallback first; per-package recipe overrides remain available
 * below for niche packages.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase, api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertCircle,
  Database,
  History,
  Save,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

const POLICY_KEYS = [
  "editorial_principles",
  "tie_breaks",
  "quality_floor",
  "common_residential_rooms",
  "dusk_subjects",
];

function commaListToArray(str) {
  return (str || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function arrayToCommaList(arr) {
  return Array.isArray(arr) ? arr.join(", ") : "";
}

export default function EditorialPolicyEditor() {
  const queryClient = useQueryClient();

  const policyQuery = useQuery({
    queryKey: ["shortlisting_engine_policy"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_engine_policy")
        .select("id, policy, history, updated_at, updated_by, notes")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const persisted = policyQuery.data?.policy || null;

  // Local edit state — initialised from the persisted policy once loaded.
  const [editorialPrinciples, setEditorialPrinciples] = useState("");
  const [tieBreaks, setTieBreaks] = useState("");
  const [qualityFloor, setQualityFloor] = useState("5.5");
  const [commonRooms, setCommonRooms] = useState("");
  const [duskSubjects, setDuskSubjects] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!persisted) return;
    setEditorialPrinciples(persisted.editorial_principles || "");
    setTieBreaks(persisted.tie_breaks || "");
    setQualityFloor(
      typeof persisted.quality_floor === "number"
        ? String(persisted.quality_floor)
        : "5.5",
    );
    setCommonRooms(arrayToCommaList(persisted.common_residential_rooms));
    setDuskSubjects(arrayToCommaList(persisted.dusk_subjects));
    setNotes("");
  }, [persisted]);

  const isDirty = useMemo(() => {
    if (!persisted) return false;
    if (
      (persisted.editorial_principles || "") !== editorialPrinciples ||
      (persisted.tie_breaks || "") !== tieBreaks ||
      String(persisted.quality_floor ?? "5.5") !== qualityFloor ||
      arrayToCommaList(persisted.common_residential_rooms) !== commonRooms ||
      arrayToCommaList(persisted.dusk_subjects) !== duskSubjects
    ) {
      return true;
    }
    return false;
  }, [
    persisted,
    editorialPrinciples,
    tieBreaks,
    qualityFloor,
    commonRooms,
    duskSubjects,
  ]);

  const validate = () => {
    const errs = [];
    if (!editorialPrinciples.trim())
      errs.push("Editorial principles cannot be empty.");
    if (!tieBreaks.trim()) errs.push("Tie-break rules cannot be empty.");
    const floor = Number(qualityFloor);
    if (!Number.isFinite(floor) || floor < 0 || floor > 10) {
      errs.push("Quality floor must be a number between 0 and 10.");
    }
    return errs;
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const errs = validate();
      if (errs.length > 0) {
        throw new Error(errs.join(" "));
      }
      const userId = (await supabase.auth.getUser())?.data?.user?.id || null;

      const newPolicy = {
        editorial_principles: editorialPrinciples.trim(),
        tie_breaks: tieBreaks.trim(),
        quality_floor: Math.max(0, Math.min(10, Number(qualityFloor))),
        common_residential_rooms: commaListToArray(commonRooms),
        dusk_subjects: commaListToArray(duskSubjects),
      };

      // Append the prior policy to history (cap 20).
      const priorHistory = Array.isArray(policyQuery.data?.history)
        ? policyQuery.data.history
        : [];
      const newHistoryEntry = {
        policy: persisted,
        changed_by: userId,
        changed_at: new Date().toISOString(),
        notes: notes.trim() || null,
      };
      const trimmedHistory = [newHistoryEntry, ...priorHistory].slice(0, 20);

      const { error } = await supabase
        .from("shortlisting_engine_policy")
        .update({
          policy: newPolicy,
          history: trimmedHistory,
          updated_by: userId,
          notes: notes.trim() || null,
        })
        .eq("id", 1);
      if (error) throw error;
      return newPolicy;
    },
    onSuccess: () => {
      toast.success(
        "Editorial policy saved. Effective on every Stage 4 run from now.",
      );
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_engine_policy"],
      });
    },
    onError: (err) => {
      toast.error(`Save failed: ${err?.message || String(err)}`);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (entry) => {
      const userId = (await supabase.auth.getUser())?.data?.user?.id || null;
      const { error } = await supabase
        .from("shortlisting_engine_policy")
        .update({
          policy: entry.policy,
          updated_by: userId,
          notes: `Restored from history (${entry.changed_at})`,
        })
        .eq("id", 1);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Restored — Stage 4 will use the restored policy on the next run.");
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_engine_policy"],
      });
    },
    onError: (err) => {
      toast.error(`Restore failed: ${err?.message || String(err)}`);
    },
  });

  const validationErrors = isDirty ? validate() : [];
  const lastUpdated = policyQuery.data?.updated_at
    ? new Date(policyQuery.data.updated_at).toLocaleString()
    : null;

  if (policyQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading editorial policy…
        </CardContent>
      </Card>
    );
  }

  if (policyQuery.isError) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-700 dark:text-rose-300">
          Failed to load editorial policy: {policyQuery.error?.message || "unknown error"}.
          Stage 4 will fall back to the in-code DEFAULT_POLICY until this row
          is readable.
        </CardContent>
      </Card>
    );
  }

  if (!policyQuery.data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-700 dark:text-rose-300">
          The shortlisting_engine_policy singleton row is missing. Re-apply
          migration 465 to seed it.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="editorial-policy-editor">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            Editorial policy — global fallback
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <Database className="w-3 h-3" />
              Singleton row id=1
            </Badge>
            {lastUpdated ? (
              <span className="text-xs text-muted-foreground">
                Updated {lastUpdated}
              </span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-100 flex items-start gap-2">
          <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1 leading-relaxed">
            <div className="font-medium">How this works</div>
            <div>
              The shortlisting engine reads this policy on every Stage 4 run.
              It pairs the package's deliverable quotas (e.g.{" "}
              <code>25 sales_images + 4 dusk_images</code>) with the editorial
              principles below to pick the shortlist.{" "}
              <strong>No per-package recipe is required</strong> — packages
              that don't have a per-package override automatically use this
              policy as the global fallback.
            </div>
            <div>
              Edits take effect immediately on the next Stage 4 run. The prior
              version is preserved in the history list at the bottom of this
              card so you can roll back.
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="editorial-principles" className="flex items-center gap-2">
            Editorial principles
            <PolicyHelp
              text={
                "Free-form markdown read by Stage 4 (Gemini 2.5 Pro). " +
                "Treat this as the brief you'd hand a senior photo editor: " +
                "what's the property comprehension goal, what hero rooms matter, " +
                "what counts as a strong shot vs a weak one. The model treats " +
                "these as defaults and overrides them with reasoning when the " +
                "property is unusual (apartment, heritage cottage, etc.)."
              }
            />
          </Label>
          <Textarea
            id="editorial-principles"
            data-testid="editorial-principles-input"
            value={editorialPrinciples}
            onChange={(e) => setEditorialPrinciples(e.target.value)}
            className="min-h-[180px] font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tie-breaks" className="flex items-center gap-2">
            Tie-break rules
            <PolicyHelp
              text={
                "Ranked rules the model applies when two candidates score " +
                "identically on quality. Numbered list works best — Gemini " +
                "is good at reading numbered priority orderings."
              }
            />
          </Label>
          <Textarea
            id="tie-breaks"
            data-testid="tie-breaks-input"
            value={tieBreaks}
            onChange={(e) => setTieBreaks(e.target.value)}
            className="min-h-[100px] font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label htmlFor="quality-floor" className="flex items-center gap-2">
              Quality floor
              <PolicyHelp
                text={
                  "Minimum signal score (0-10) for a candidate to even be " +
                  "considered. Picks below this floor must be paired with a " +
                  "coverage warning. Default 5.5 — raise to 6.5 for premium-" +
                  "only operations, lower to 4.5 for budget-tier projects."
                }
              />
            </Label>
            <Input
              id="quality-floor"
              data-testid="quality-floor-input"
              type="number"
              step="0.1"
              min="0"
              max="10"
              value={qualityFloor}
              onChange={(e) => setQualityFloor(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="common-rooms" className="flex items-center gap-2">
              Common AU rooms (comma-separated)
              <PolicyHelp
                text={
                  "Room types treated as 'standard for AU residential listings'. " +
                  "When the engine omits one despite a candidate existing, the " +
                  "swimlane shows a coverage warning. Hint to operators, never blocks."
                }
              />
            </Label>
            <Input
              id="common-rooms"
              data-testid="common-rooms-input"
              value={commonRooms}
              onChange={(e) => setCommonRooms(e.target.value)}
              placeholder="kitchen, master_bedroom, living, dining, exterior_front, bathroom_main"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dusk-subjects" className="flex items-center gap-2">
              Dusk subjects (comma-separated)
              <PolicyHelp
                text={
                  "Subject types the engine prefers when filling the dusk_images " +
                  "bucket. Dusk interiors require explicit editorial justification."
                }
              />
            </Label>
            <Input
              id="dusk-subjects"
              data-testid="dusk-subjects-input"
              value={duskSubjects}
              onChange={(e) => setDuskSubjects(e.target.value)}
              placeholder="exterior_facade, pool_dusk, garden_dusk, streetscape_dusk"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="save-notes" className="flex items-center gap-2">
            Notes for this revision (optional)
          </Label>
          <Input
            id="save-notes"
            data-testid="save-notes-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why are you changing this? — appended to the history entry"
          />
        </div>

        {validationErrors.length > 0 ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/30 p-2 text-xs text-rose-900 dark:text-rose-100 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <div>{validationErrors.join(" ")}</div>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs text-muted-foreground">
            {isDirty
              ? "Unsaved changes."
              : "All changes saved."}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!persisted) return;
                setEditorialPrinciples(persisted.editorial_principles || "");
                setTieBreaks(persisted.tie_breaks || "");
                setQualityFloor(String(persisted.quality_floor ?? "5.5"));
                setCommonRooms(arrayToCommaList(persisted.common_residential_rooms));
                setDuskSubjects(arrayToCommaList(persisted.dusk_subjects));
                setNotes("");
              }}
              disabled={!isDirty || saveMutation.isPending}
              data-testid="discard-button"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={
                !isDirty ||
                saveMutation.isPending ||
                validationErrors.length > 0
              }
              data-testid="save-button"
            >
              <Save className="w-3.5 h-3.5 mr-1" />
              {saveMutation.isPending ? "Saving…" : "Save policy"}
            </Button>
          </div>
        </div>

        <Separator />

        <PolicyHistoryList
          history={Array.isArray(policyQuery.data.history) ? policyQuery.data.history : []}
          onRestore={(entry) => restoreMutation.mutate(entry)}
          isRestoring={restoreMutation.isPending}
        />
      </CardContent>
    </Card>
  );
}

function PolicyHelp({ text }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground cursor-help text-xs underline decoration-dotted">
            ?
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-xs leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PolicyHistoryList({ history, onRestore, isRestoring }) {
  const [open, setOpen] = useState(false);
  if (!history.length) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <History className="w-3.5 h-3.5" />
        No prior revisions yet.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5"
        onClick={() => setOpen((v) => !v)}
        data-testid="history-toggle"
      >
        <History className="w-3.5 h-3.5" />
        History ({history.length})
        <span className="text-muted-foreground">— click to {open ? "hide" : "show"}</span>
      </button>
      {open ? (
        <ul className="space-y-1.5 text-xs" data-testid="history-list">
          {history.map((entry, idx) => {
            const when = entry.changed_at
              ? new Date(entry.changed_at).toLocaleString()
              : "(unknown time)";
            const note = entry.notes || "(no note)";
            const principlesPreview = entry.policy?.editorial_principles
              ? entry.policy.editorial_principles.slice(0, 100) +
                (entry.policy.editorial_principles.length > 100 ? "…" : "")
              : "(empty)";
            return (
              <li
                key={idx}
                className="rounded-md border bg-muted/20 p-2 flex items-start justify-between gap-2"
              >
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{when}</span>
                    <span className="text-muted-foreground truncate">— {note}</span>
                  </div>
                  <div className="text-muted-foreground line-clamp-1 font-mono text-[10px]">
                    {principlesPreview}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRestore(entry)}
                  disabled={isRestoring}
                  data-testid={`restore-button-${idx}`}
                >
                  <RotateCcw className="w-3 h-3 mr-1" />
                  Restore
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
