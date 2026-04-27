/**
 * SettingsPackageTierMapping.jsx — Wave 7 P1-6 (W7.7) admin UI for the
 * package_engine_tier_mapping table.
 *
 * Master_admin only. Lists every (package_id, tier_choice) row joined with
 * packages.name + shortlisting_tiers.tier_code. Each row's engine_tier is
 * editable via a dropdown of S/P/A. Save UPDATEs the mapping.
 *
 * Joseph confirmed Gold→S/P + Flex→A/A; rest were seeded as best-guess
 * editable. This UI is where admins fix the seeds.
 */

import { useMemo, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  Loader2,
  Save,
  Layers,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return String(iso);
  }
}

export default function SettingsPackageTierMapping() {
  const queryClient = useQueryClient();
  const [savingRowKey, setSavingRowKey] = useState(null);

  // Load: package_engine_tier_mapping joined with packages.name + tiers
  const tableQuery = useQuery({
    queryKey: ["package_engine_tier_mapping_full"],
    queryFn: async () => {
      const [{ data: mapping, error: mapErr }, { data: pkgs, error: pkgErr }, { data: tiers, error: tierErr }] =
        await Promise.all([
          supabase
            .from("package_engine_tier_mapping")
            .select("package_id, tier_choice, engine_tier_id, notes, updated_at"),
          supabase
            .from("packages")
            .select("id, name, is_active")
            .eq("is_active", true)
            .order("name"),
          supabase
            .from("shortlisting_tiers")
            .select("id, tier_code, display_name, score_anchor")
            .eq("is_active", true)
            .order("display_order"),
        ]);
      if (mapErr) throw new Error(`mapping load: ${mapErr.message}`);
      if (pkgErr) throw new Error(`packages load: ${pkgErr.message}`);
      if (tierErr) throw new Error(`tiers load: ${tierErr.message}`);
      return {
        mapping: mapping || [],
        packages: pkgs || [],
        tiers: tiers || [],
      };
    },
    staleTime: 30 * 1000,
  });

  // Local editable state — keyed by `${package_id}|${tier_choice}`
  const [drafts, setDrafts] = useState({});

  const rows = useMemo(() => {
    if (!tableQuery.data) return [];
    const { mapping, packages, tiers } = tableQuery.data;
    const pkgById = new Map(packages.map((p) => [p.id, p]));
    const tierById = new Map(tiers.map((t) => [t.id, t]));
    // Compose by (package, tier_choice) — every package should have both
    // 'standard' and 'premium' rows from the seed; if any are missing, surface
    // them as "missing" rows the admin can backfill.
    const result = [];
    for (const pkg of packages) {
      for (const tc of ["standard", "premium"]) {
        const m = mapping.find(
          (row) => row.package_id === pkg.id && row.tier_choice === tc
        );
        result.push({
          rowKey: `${pkg.id}|${tc}`,
          package_id: pkg.id,
          package_name: pkg.name,
          tier_choice: tc,
          engine_tier_id: m?.engine_tier_id || null,
          engine_tier_code: m?.engine_tier_id ? tierById.get(m.engine_tier_id)?.tier_code || "?" : null,
          notes: m?.notes || null,
          updated_at: m?.updated_at || null,
          missing: !m,
        });
      }
    }
    return result;
  }, [tableQuery.data]);

  const tiersList = tableQuery.data?.tiers || [];

  const saveMutation = useMutation({
    mutationFn: async ({ package_id, tier_choice, engine_tier_id, notes }) => {
      let updatedBy = null;
      try {
        const me = await api.auth.me();
        updatedBy = me?.id || null;
      } catch {
        /* best-effort */
      }
      // UPSERT — handles both edits and missing-row backfill in one path.
      const { error } = await supabase
        .from("package_engine_tier_mapping")
        .upsert(
          {
            package_id,
            tier_choice,
            engine_tier_id,
            notes: notes || null,
            updated_at: new Date().toISOString(),
            ...(updatedBy ? { updated_by: updatedBy } : {}),
          },
          { onConflict: "package_id,tier_choice" }
        );
      if (error) throw new Error(error.message);
    },
    onMutate: ({ package_id, tier_choice }) => {
      setSavingRowKey(`${package_id}|${tier_choice}`);
    },
    onSettled: () => setSavingRowKey(null),
    onSuccess: ({ package_id, tier_choice }) => {
      // Clear local draft for this row.
      setDrafts((d) => {
        const out = { ...d };
        delete out[`${package_id}|${tier_choice}`];
        return out;
      });
      queryClient.invalidateQueries({
        queryKey: ["package_engine_tier_mapping_full"],
      });
      toast.success("Mapping saved.");
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  const handleDraftChange = (rowKey, field, value) => {
    setDrafts((d) => ({
      ...d,
      [rowKey]: { ...(d[rowKey] || {}), [field]: value },
    }));
  };

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold">Package → Engine Tier Mapping</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Each (Package, Pricing Tier) combination maps to one engine tier
            (S/P/A). The engine tier drives Stream B scoring anchors and
            quality bars; the customer's pricing tier (standard/premium) is
            captured at booking and joined here at round bootstrap.
          </p>
        </div>

        <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-amber-900 dark:text-amber-200 space-y-1">
              <div className="font-semibold">Joseph-confirmed seeds:</div>
              <div>
                Gold Package → Standard=S, Premium=P. Flex Package → both=A.
                Other packages were seeded as best guesses on 2026-04-27 — edit
                the rows here to match the actual quality bar you expect for
                each combination.
              </div>
            </div>
          </CardContent>
        </Card>

        {tableQuery.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : tiersList.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No shortlisting_tiers rows found. Migration 339 should have
              seeded S/P/A — check that the migration ran.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4 text-primary" />
                Mappings
              </CardTitle>
              <CardDescription className="text-xs">
                {rows.length} row{rows.length === 1 ? "" : "s"} —{" "}
                {rows.filter((r) => r.missing).length} missing
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left pb-2 pr-3">Package</th>
                      <th className="text-left pb-2 pr-3">Pricing Tier</th>
                      <th className="text-left pb-2 pr-3">Engine Tier</th>
                      <th className="text-left pb-2 pr-3">Notes</th>
                      <th className="text-left pb-2 pr-3">Updated</th>
                      <th className="text-right pb-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const draft = drafts[row.rowKey] || {};
                      const editedTierId =
                        draft.engine_tier_id !== undefined
                          ? draft.engine_tier_id
                          : row.engine_tier_id;
                      const editedNotes =
                        draft.notes !== undefined ? draft.notes : row.notes || "";
                      const dirty =
                        editedTierId !== row.engine_tier_id ||
                        (editedNotes || "") !== (row.notes || "");
                      const saving = savingRowKey === row.rowKey;
                      return (
                        <tr
                          key={row.rowKey}
                          className="border-b last:border-b-0 hover:bg-muted/30"
                        >
                          <td className="py-2 pr-3 font-medium">
                            {row.package_name}
                            {row.missing && (
                              <Badge
                                variant="outline"
                                className="ml-2 text-[10px] bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300"
                              >
                                missing
                              </Badge>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {row.tier_choice}
                          </td>
                          <td className="py-2 pr-3">
                            <Select
                              value={editedTierId || ""}
                              onValueChange={(v) =>
                                handleDraftChange(row.rowKey, "engine_tier_id", v)
                              }
                            >
                              <SelectTrigger className="h-8 w-32 text-xs">
                                <SelectValue placeholder="—" />
                              </SelectTrigger>
                              <SelectContent>
                                {tiersList.map((t) => (
                                  <SelectItem
                                    key={t.id}
                                    value={t.id}
                                    className="text-xs"
                                  >
                                    {t.tier_code} — {t.display_name} (
                                    {t.score_anchor})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="py-2 pr-3">
                            <Input
                              value={editedNotes}
                              onChange={(e) =>
                                handleDraftChange(
                                  row.rowKey,
                                  "notes",
                                  e.target.value
                                )
                              }
                              placeholder="—"
                              className="h-8 text-xs"
                            />
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground tabular-nums">
                            {fmtTime(row.updated_at)}
                          </td>
                          <td className="py-2 text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!dirty || saving || !editedTierId}
                              onClick={() =>
                                saveMutation.mutate({
                                  package_id: row.package_id,
                                  tier_choice: row.tier_choice,
                                  engine_tier_id: editedTierId,
                                  notes: editedNotes,
                                })
                              }
                              className="h-7 px-2 gap-1"
                            >
                              {saving ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Save className="h-3 w-3" />
                              )}
                              <span className="text-xs">Save</span>
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PermissionGuard>
  );
}
