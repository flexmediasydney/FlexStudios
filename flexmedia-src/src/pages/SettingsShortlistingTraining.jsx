/**
 * SettingsShortlistingTraining — Wave 6 Phase 8 SHORTLIST
 *
 * master_admin only. Curator UI for shortlisting_training_examples — the
 * confirmed-shortlist signal that feeds the few-shot library used by
 * future engine versions.
 *
 * Reads:
 *   - get_training_examples_summary RPC (mig 295) for filtered list
 *
 * Writes (per-row):
 *   - shortlisting_training_examples.training_grade (admin-confirmed)
 *   - shortlisting_training_examples.excluded (admin-rejected as bad signal)
 *
 * Notes:
 *   - We DO NOT version training examples — they're a derived artefact.
 *     Curator marks are simple in-place updates.
 *   - Variant count comes from the editor delivery watcher (Phase 8 B4).
 *     A composition with variant_count >= 2 is a stronger training signal
 *     because the editor produced multiple deliverables of the same comp.
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Award,
  Ban,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const PACKAGE_TYPES = [
  { value: "all", label: "All packages" },
  { value: "Gold", label: "Gold" },
  { value: "Day to Dusk", label: "Day to Dusk" },
  { value: "Premium", label: "Premium" },
];

const TIERS = [
  { value: "all", label: "All tiers" },
  { value: "standard", label: "Standard" },
  { value: "premium", label: "Premium" },
];

const OVERRIDE_FILTERS = [
  { value: "any", label: "Any" },
  { value: "true", label: "Was override" },
  { value: "false", label: "AI-as-proposed" },
];

const GRADE_FILTERS = [
  { value: "any", label: "Any grade" },
  { value: "true", label: "Curated only" },
  { value: "false", label: "Uncurated only" },
];

function fmtPct(n) {
  if (n == null || !isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtScore(n) {
  if (n == null || !isFinite(Number(n))) return "—";
  return Number(n).toFixed(2);
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return String(iso);
  }
}

// ── Detail drawer ───────────────────────────────────────────────────────────
function TrainingExampleDrawer({ example, open, onOpenChange, onMark, onExclude }) {
  if (!example) return null;
  const variantBoost = (Number(example.variant_count) - 1) * 0.2;
  const overrideBoost = example.was_override ? 0.3 : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">
            {example.delivery_reference_stem}
          </SheetTitle>
          <SheetDescription>
            {example.slot_id} · {example.package_type} · {example.project_tier}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">AI proposed score</div>
              <div className="font-bold tabular-nums">{fmtScore(example.ai_proposed_score)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Human-confirmed score</div>
              <div className="font-bold tabular-nums">{fmtScore(example.human_confirmed_score)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Variant count</div>
              <div className="font-bold tabular-nums">{example.variant_count}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Was override</div>
              <div className="font-bold">
                {example.was_override ? (
                  <Badge variant="default">override</Badge>
                ) : (
                  <Badge variant="outline">AI-confirmed</Badge>
                )}
              </div>
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">Weight breakdown</CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-1">
              <div>Base: <span className="tabular-nums">1.000</span></div>
              <div>Variant boost (+0.2 × {Math.max(0, Number(example.variant_count) - 1)}): <span className="tabular-nums">+{variantBoost.toFixed(2)}</span></div>
              <div>Override boost: <span className="tabular-nums">+{overrideBoost.toFixed(2)}</span></div>
              <div className="border-t pt-1 mt-1 font-bold">Total weight: <span className="tabular-nums">{fmtScore(example.weight)}</span></div>
            </CardContent>
          </Card>

          <div>
            <div className="text-xs text-muted-foreground mb-1">Created</div>
            <div className="text-sm">
              {fmtTime(example.created_at)}
              <span className="text-muted-foreground ml-2 text-xs">
                ({formatDistanceToNow(new Date(example.created_at), { addSuffix: true })})
              </span>
            </div>
          </div>

          <div className="flex gap-2 pt-3 border-t">
            <Button
              variant={example.training_grade ? "secondary" : "default"}
              onClick={() => onMark(example, !example.training_grade)}
              className="flex-1"
            >
              <Award className="h-4 w-4 mr-2" />
              {example.training_grade ? "Unmark training-grade" : "Mark training-grade"}
            </Button>
            <Button
              variant={example.excluded ? "secondary" : "destructive"}
              onClick={() => onExclude(example, !example.excluded)}
              className="flex-1"
            >
              <Ban className="h-4 w-4 mr-2" />
              {example.excluded ? "Restore" : "Exclude"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function SettingsShortlistingTraining() {
  const queryClient = useQueryClient();

  // Filters
  const [minVariantCount, setMinVariantCount] = useState(1);
  const [packageType, setPackageType] = useState("all");
  const [tier, setTier] = useState("all");
  const [overrideFilter, setOverrideFilter] = useState("any");
  const [gradeFilter, setGradeFilter] = useState("any");
  const [searchStem, setSearchStem] = useState("");
  const [activeRow, setActiveRow] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Fetch via RPC — gives us a clean filtered slice without truncation surprises.
  const wasOverrideParam =
    overrideFilter === "any" ? null : overrideFilter === "true";

  const examplesQuery = useQuery({
    queryKey: [
      "training_examples_summary",
      minVariantCount,
      wasOverrideParam,
    ],
    queryFn: async () => {
      const rows = await api.rpc("get_training_examples_summary", {
        p_limit: 500,
        p_min_variant_count: minVariantCount,
        p_was_override: wasOverrideParam,
      });
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 30 * 1000,
  });

  // Apply remaining filters client-side (RPC handles the heavy ones).
  const filtered = useMemo(() => {
    const all = examplesQuery.data || [];
    return all.filter((row) => {
      if (packageType !== "all" && row.package_type !== packageType) return false;
      if (tier !== "all" && row.project_tier !== tier) return false;
      if (gradeFilter !== "any") {
        const want = gradeFilter === "true";
        if (Boolean(row.training_grade) !== want) return false;
      }
      if (
        searchStem &&
        !String(row.delivery_reference_stem || "")
          .toLowerCase()
          .includes(searchStem.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [examplesQuery.data, packageType, tier, gradeFilter, searchStem]);

  // Mutations: training_grade and excluded toggles
  const markMutation = useMutation({
    mutationFn: async ({ example, value }) => {
      await api.entities.ShortlistingTrainingExample.update(example.id, {
        training_grade: value,
      });
    },
    onSuccess: (_, vars) => {
      toast.success(
        vars.value ? "Marked as training-grade" : "Unmarked",
      );
      queryClient.invalidateQueries({ queryKey: ["training_examples_summary"] });
    },
    onError: (err) => toast.error(`Failed: ${err.message || err}`),
  });

  const excludeMutation = useMutation({
    mutationFn: async ({ example, value }) => {
      await api.entities.ShortlistingTrainingExample.update(example.id, {
        excluded: value,
      });
    },
    onSuccess: (_, vars) => {
      toast.success(vars.value ? "Excluded from training set" : "Restored");
      queryClient.invalidateQueries({ queryKey: ["training_examples_summary"] });
    },
    onError: (err) => toast.error(`Failed: ${err.message || err}`),
  });

  const summary = useMemo(() => {
    const all = examplesQuery.data || [];
    return {
      total: all.length,
      curated: all.filter((r) => r.training_grade).length,
      excluded: all.filter((r) => r.excluded).length,
      multiVariant: all.filter((r) => Number(r.variant_count) >= 2).length,
      overrides: all.filter((r) => r.was_override).length,
    };
  }, [examplesQuery.data]);

  return (
    <PermissionGuard requireRole={["master_admin"]}>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Training Examples</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Confirmed shortlist selections feeding the few-shot library. Variant count
              comes from the editor delivery watcher; weight = 1.0 + 0.2×(variants-1) + 0.3×override.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => examplesQuery.refetch()}
            disabled={examplesQuery.isFetching}
          >
            <RefreshCw className={cn("h-4 w-4 mr-2", examplesQuery.isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card>
            <CardContent className="py-3 px-4">
              <div className="text-2xl font-bold tabular-nums">{summary.total}</div>
              <div className="text-xs text-muted-foreground">Total examples</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <div className="text-2xl font-bold tabular-nums text-amber-600">
                {summary.curated}
              </div>
              <div className="text-xs text-muted-foreground">Curated</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <div className="text-2xl font-bold tabular-nums">{summary.multiVariant}</div>
              <div className="text-xs text-muted-foreground">Multi-variant (≥2)</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <div className="text-2xl font-bold tabular-nums">{summary.overrides}</div>
              <div className="text-xs text-muted-foreground">Human overrides</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <div className="text-2xl font-bold tabular-nums text-red-600">{summary.excluded}</div>
              <div className="text-xs text-muted-foreground">Excluded</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Min variant count: {minVariantCount}
                </label>
                <Slider
                  value={[minVariantCount]}
                  onValueChange={([v]) => setMinVariantCount(v)}
                  min={1}
                  max={5}
                  step={1}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Package</label>
                <Select value={packageType} onValueChange={setPackageType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PACKAGE_TYPES.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Tier</label>
                <Select value={tier} onValueChange={setTier}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Override</label>
                <Select value={overrideFilter} onValueChange={setOverrideFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OVERRIDE_FILTERS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Curated</label>
                <Select value={gradeFilter} onValueChange={setGradeFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADE_FILTERS.map((g) => (
                      <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-3">
                <label className="text-xs text-muted-foreground mb-1 block">Search stem</label>
                <div className="relative">
                  <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="e.g. KELV4091"
                    className="pl-7 font-mono text-sm"
                    value={searchStem}
                    onChange={(e) => setSearchStem(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Database className="h-4 w-4" />
              Examples ({filtered.length} shown)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {examplesQuery.isLoading ? (
              <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-sm text-muted-foreground italic py-12 text-center">
                {(examplesQuery.data || []).length === 0
                  ? "No training examples yet. Lock a shortlist to start populating."
                  : "No matches for the current filters."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Stem</th>
                      <th className="text-left py-2 px-3 font-medium">Slot</th>
                      <th className="text-left py-2 px-3 font-medium">Package</th>
                      <th className="text-left py-2 px-3 font-medium">Tier</th>
                      <th className="text-right py-2 px-3 font-medium">Variants</th>
                      <th className="text-right py-2 px-3 font-medium">Weight</th>
                      <th className="text-right py-2 px-3 font-medium">AI / Human</th>
                      <th className="text-center py-2 px-3 font-medium">Override</th>
                      <th className="text-center py-2 px-3 font-medium">Status</th>
                      <th className="text-right py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr
                        key={row.id}
                        className={cn(
                          "border-b hover:bg-muted/30 cursor-pointer transition-colors",
                          row.excluded && "opacity-50",
                          row.training_grade && "bg-amber-50/40 dark:bg-amber-950/10",
                        )}
                        onClick={() => {
                          setActiveRow(row);
                          setDrawerOpen(true);
                        }}
                      >
                        <td className="py-2 px-3 font-mono text-xs">{row.delivery_reference_stem}</td>
                        <td className="py-2 px-3 text-xs">{row.slot_id}</td>
                        <td className="py-2 px-3 text-xs">{row.package_type}</td>
                        <td className="py-2 px-3 text-xs">{row.project_tier}</td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {Number(row.variant_count) >= 2 ? (
                            <Badge variant="secondary">{row.variant_count}</Badge>
                          ) : (
                            row.variant_count
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-bold tabular-nums">
                          {fmtScore(row.weight)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-xs">
                          {fmtScore(row.ai_proposed_score)} / {fmtScore(row.human_confirmed_score)}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {row.was_override ? (
                            <Badge variant="default" className="text-[10px]">override</Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {row.training_grade && (
                            <Star className="h-3 w-3 text-amber-500 inline-block" />
                          )}
                          {row.excluded && (
                            <Ban className="h-3 w-3 text-red-500 inline-block ml-1" />
                          )}
                          {!row.training_grade && !row.excluded && (
                            <span className="text-muted-foreground text-xs">raw</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <Switch
                            checked={!!row.training_grade}
                            disabled={markMutation.isPending}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={(v) =>
                              markMutation.mutate({ example: row, value: v })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <TrainingExampleDrawer
          example={activeRow}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onMark={(ex, v) => markMutation.mutate({ example: ex, value: v })}
          onExclude={(ex, v) => excludeMutation.mutate({ example: ex, value: v })}
        />
      </div>
    </PermissionGuard>
  );
}
