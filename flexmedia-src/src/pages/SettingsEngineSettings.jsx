/**
 * SettingsEngineSettings.jsx — Wave 7 P1-6 (W7.7) admin UI for engine_settings.
 *
 * Master_admin only. Lists rows from `engine_settings` (key, value, description,
 * updated_at, updated_by). Each row's JSON value is editable in a textarea;
 * Save validates JSON.parse + UPDATE the row. Delete is intentionally NOT
 * exposed — these rows are seeded by migrations and shouldn't be deleted in
 * production.
 *
 * Adding new rows is also out of scope here; new keys land via migrations
 * (each migration that introduces a setting INSERTs the row with sensible
 * defaults).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
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
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Loader2, Save, Sparkles } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return String(iso);
  }
}

// ── Per-row card ────────────────────────────────────────────────────────────
function EngineSettingCard({ row, onSave, savingKey }) {
  const initialJson = useMemo(() => {
    try {
      return JSON.stringify(row.value ?? {}, null, 2);
    } catch {
      return "{}";
    }
  }, [row.value]);

  const [draft, setDraft] = useState(initialJson);
  const [parseError, setParseError] = useState(null);

  // Reset draft when the row changes (e.g. after save).
  useEffect(() => {
    setDraft(initialJson);
    setParseError(null);
  }, [initialJson]);

  const dirty = draft.trim() !== initialJson.trim();
  const saving = savingKey === row.key;

  const handleSave = () => {
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setParseError(err?.message || "Invalid JSON");
      return;
    }
    setParseError(null);
    onSave({ key: row.key, value: parsed });
  };

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-mono text-sm">{row.key}</span>
        </CardTitle>
        {row.description && (
          <CardDescription className="text-xs">{row.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            JSON value
          </label>
          <Textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setParseError(null);
            }}
            rows={8}
            className={cn(
              "font-mono text-xs leading-relaxed",
              parseError && "border-destructive"
            )}
          />
          {parseError && (
            <div className="text-[11px] text-destructive mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> {parseError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap pt-2">
          <div className="text-[11px] text-muted-foreground">
            Last updated {fmtTime(row.updated_at)}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(initialJson);
                setParseError(null);
              }}
              disabled={!dirty || saving}
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function SettingsEngineSettings() {
  const queryClient = useQueryClient();
  const [savingKey, setSavingKey] = useState(null);

  // engine_settings PK is `key` (text), not `id` — use the supabase client
  // directly rather than the id-keyed entity proxy.
  const settingsQuery = useQuery({
    queryKey: ["engine_settings_all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("engine_settings")
        .select("key, value, description, updated_at, updated_by")
        .order("key");
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 30 * 1000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, value }) => {
      let updatedBy = null;
      try {
        const me = await api.auth.me();
        updatedBy = me?.id || null;
      } catch {
        /* best-effort */
      }
      const { data, error } = await supabase
        .from("engine_settings")
        .update({
          value,
          updated_at: new Date().toISOString(),
          updated_by: updatedBy,
        })
        .eq("key", key)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    onMutate: ({ key }) => setSavingKey(key),
    onSettled: () => setSavingKey(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["engine_settings_all"] });
      toast.success("Engine setting saved.");
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold">Engine Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Universal configuration rows for the shortlisting engine. Each row's
            JSON value is read by the relevant edge function on each
            invocation; saved changes take effect on the next pass call.
          </p>
        </div>

        <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-amber-900 dark:text-amber-200 space-y-1">
              <div className="font-semibold">Live runtime — handle with care.</div>
              <div>
                Bad values can break the engine (e.g. setting hard reject
                thresholds &gt; 10 will reject every composition). Test with a
                staging round before changing production thresholds.
              </div>
              <div>
                New keys are added via migrations, not this UI. Contact
                engineering if you need a new setting row.
              </div>
            </div>
          </CardContent>
        </Card>

        {settingsQuery.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : settingsQuery.data?.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No engine settings rows yet. Migrations should have seeded at
              least one row — if this is empty, check that migration 339 ran
              successfully.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {settingsQuery.data.map((row) => (
              <EngineSettingCard
                key={row.key}
                row={row}
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
