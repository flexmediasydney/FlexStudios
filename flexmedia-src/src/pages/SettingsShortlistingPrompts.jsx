/**
 * SettingsShortlistingPrompts — master_admin-only editor for the engine's
 * tunable prompt scaffolding.
 *
 * Currently exposes one pass kind, versioned in `shortlisting_prompt_versions`:
 *
 *   pass0_reject  — full Haiku user-message text for the hard-reject call.
 *                   Replaces HARD_REJECT_PROMPT verbatim when active.
 *
 * Note: pass1_system + pass2_system used to live here too, but pass1/pass2
 * were sunset in W11.7.10 (Shape D is the only engine now). The Stage 1 /
 * Stage 4 prompts are now assembled in code from blocks under
 * supabase/functions/_shared/visionPrompts/ and are not DB-tunable.
 *
 * Versioning: on save, INSERT new row at version+1 + is_active=true, then
 * UPDATE the prior active row to is_active=false. Roll back the insert if
 * deactivation fails.
 *
 * Safety: if DB has no active row OR the query errors, runtime falls back to
 * the hardcoded source. So a saved prompt that breaks the engine can be
 * reverted by toggling is_active off; the next call sees no DB row and uses
 * whatever's committed in code.
 */

import { useMemo, useState, useEffect } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  History,
  Loader2,
  Save,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const PASS_KINDS = [
  {
    key: "pass0_reject",
    label: "Pass 0 — Hard reject",
    model: "claude-haiku-4-5",
    description:
      "Full Haiku user-message text used when scanning each composition for hard rejects (motion blur, lens cap, agent headshot, etc). The whole text below is sent verbatim alongside the image.",
    accent: "border-red-200 dark:border-red-900",
    iconTone: "text-red-600",
  },
];

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return String(iso);
  }
}

// ── Per-pass card ───────────────────────────────────────────────────────────
function PromptCard({ passConfig, allVersions, onSave, savingKey }) {
  const versions = useMemo(
    () =>
      [...(allVersions || [])].sort(
        (a, b) => Number(b.version || 0) - Number(a.version || 0),
      ),
    [allVersions],
  );
  const active = versions.find((v) => v.is_active) || null;
  const [draft, setDraft] = useState(active?.prompt_text || "");
  const [notes, setNotes] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // Reset draft to active when active changes (e.g. after save)
  const lastActiveId = active?.id || null;
  useEffect(() => {
    setDraft(active?.prompt_text || "");
    setNotes("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastActiveId]);

  const dirty = draft.trim() !== (active?.prompt_text || "").trim();
  const saving = savingKey === passConfig.key;

  return (
    <Card className={cn("border", passConfig.accent)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className={cn("h-4 w-4", passConfig.iconTone)} />
          {passConfig.label}
          {active && (
            <Badge variant="outline" className="text-[10px] ml-2">
              v{active.version}
            </Badge>
          )}
          {!active && (
            <Badge
              variant="outline"
              className="text-[10px] ml-2 bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300"
            >
              Code fallback
            </Badge>
          )}
          <span className="ml-auto text-[11px] font-normal text-muted-foreground font-mono">
            {passConfig.model}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">{passConfig.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Prompt text</label>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            className="font-mono text-xs leading-relaxed"
            placeholder={
              active
                ? "—"
                : "No DB row. Engine falls back to hardcoded source. Type to seed v1."
            }
          />
          <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
            {draft.length.toLocaleString()} chars
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Version note (optional)
          </label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. tightened reasoning-first wording, see Goldmine 5"
            className="text-xs"
          />
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap pt-2">
          <div className="text-[11px] text-muted-foreground">
            {active ? (
              <>
                Last saved {fmtTime(active.updated_at)}
                {active.notes && (
                  <span className="ml-2 italic">— "{active.notes}"</span>
                )}
              </>
            ) : (
              "No saved version yet."
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft(active?.prompt_text || "")}
              disabled={!dirty || saving}
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onSave({
                  passKind: passConfig.key,
                  prompt_text: draft,
                  notes: notes.trim() || null,
                  currentActive: active,
                })
              }
              disabled={!dirty || saving || draft.trim().length === 0}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save new version
            </Button>
          </div>
        </div>

        {versions.length > 1 && (
          <div className="border-t pt-3">
            <button
              type="button"
              className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {historyOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <History className="h-3 w-3" />
              Version history ({versions.length})
            </button>
            {historyOpen && (
              <div className="mt-2 space-y-2 max-h-80 overflow-y-auto">
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className={cn(
                      "rounded border p-2 text-xs",
                      v.is_active && "border-primary bg-primary/5",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-mono">
                        v{v.version}
                        {v.is_active && (
                          <Badge variant="default" className="ml-2 text-[9px]">
                            active
                          </Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {fmtTime(v.updated_at)}
                      </span>
                    </div>
                    {v.notes && (
                      <div className="text-[11px] italic text-muted-foreground mb-1">
                        "{v.notes}"
                      </div>
                    )}
                    <pre className="whitespace-pre-wrap font-mono text-[10px] leading-snug max-h-24 overflow-y-auto bg-muted/50 p-2 rounded">
                      {v.prompt_text}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function SettingsShortlistingPrompts() {
  const queryClient = useQueryClient();
  const [savingKey, setSavingKey] = useState(null);

  const versionsQuery = useQuery({
    queryKey: ["shortlisting_prompt_versions_all"],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingPromptVersion.list(
        "-version",
        500,
      );
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 30 * 1000,
  });

  const versionsByKind = useMemo(() => {
    const map = new Map();
    for (const v of versionsQuery.data || []) {
      const arr = map.get(v.pass_kind) || [];
      arr.push(v);
      map.set(v.pass_kind, arr);
    }
    return map;
  }, [versionsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async ({ passKind, prompt_text, notes, currentActive }) => {
      const nextVersion = (currentActive?.version || 0) + 1;

      let createdById = null;
      try {
        const me = await api.auth.me();
        createdById = me?.id || null;
      } catch {
        /* best-effort */
      }

      const newRow = await api.entities.ShortlistingPromptVersion.create({
        pass_kind: passKind,
        prompt_text,
        version: nextVersion,
        is_active: true,
        notes,
        created_by: createdById,
      });

      if (currentActive?.id) {
        try {
          await api.entities.ShortlistingPromptVersion.update(currentActive.id, {
            is_active: false,
          });
        } catch (err) {
          // Roll back the insert to leave the DB in a consistent state.
          try {
            await api.entities.ShortlistingPromptVersion.delete(newRow.id);
          } catch {
            /* best-effort */
          }
          throw new Error(`Failed to deactivate previous version: ${err.message}`);
        }
      }
      return newRow;
    },
    onMutate: ({ passKind }) => setSavingKey(passKind),
    onSettled: () => setSavingKey(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_prompt_versions_all"] });
      toast.success("New prompt version saved.");
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold">Prompt Editor</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tune the engine's prompt scaffolding without a code deploy. Each
            save creates a new immutable version; the previous version is
            deactivated but preserved in history.
          </p>
        </div>

        <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-amber-900 dark:text-amber-200 space-y-1">
              <div className="font-semibold">Live runtime — handle with care.</div>
              <div>
                Saved versions are read by the engine on the next pass call. To
                revert to the hardcoded source at any time, toggle the active
                version off (no replacement needed) — the runtime falls back to
                the version committed in code.
              </div>
              <div>
                The user_prefix for Pass 1 / Pass 2 is auto-built (Stream B,
                taxonomies, JSON schema) and not editable here. Only the system
                message is overridable.
              </div>
            </div>
          </CardContent>
        </Card>

        {versionsQuery.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {PASS_KINDS.map((pc) => (
              <PromptCard
                key={pc.key}
                passConfig={pc}
                allVersions={versionsByKind.get(pc.key) || []}
                onSave={(payload) => saveMutation.mutate(payload)}
                savingKey={savingKey}
              />
            ))}
          </div>
        )}
      </div>
    </PermissionGuard>
  );
}
