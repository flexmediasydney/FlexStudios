/**
 * SettingsVendorComparison.jsx — Wave 11.8 admin UI for the multi-vendor
 * vision adapter.
 *
 * Master_admin only. Three sections:
 *
 *   1. Per-pass vendor + model configuration. Reads/writes the 9 engine_settings
 *      rows seeded by migration 350 (vision.unified_call.{vendor,model},
 *      vision.description_backfill.{vendor,model}, vision.pass0_hardreject.
 *      {vendor,model}, vision.shadow_run.{enabled,vendor,model}). Each row's
 *      JSONB value is a string literal (e.g. "anthropic" / "claude-opus-4-7"),
 *      surfaced as a Select dropdown with the curated vendor/model list.
 *
 *   2. Run retroactive comparison form. Operator enters a round_id, a list of
 *      (vendor, model, label) variants to compare, and a cost cap. Hitting
 *      "Estimate cost" calls vendor-retroactive-compare with dry_run=true to
 *      get a per-vendor pre-flight breakdown; "Run live comparison" fires the
 *      same fn with dry_run=false. Failures (cost cap exceeded, missing
 *      credentials) surface as toasts with the server's detail.
 *
 *   3. Results table — recent rows from vendor_comparison_results, sorted by
 *      generated_at desc. Each row links to the Dropbox markdown report when
 *      available.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

// ─── Vendor + model curated lists ───────────────────────────────────────────
//
// These mirror the rows in supabase/functions/_shared/visionAdapter/pricing.ts.
// When a new model lands on the backend, add it here too — the dropdowns are
// the operator's only path to selecting a model.

const VENDOR_CHOICES = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "google", label: "Google (Gemini)" },
];

const MODEL_CHOICES_BY_VENDOR = {
  anthropic: [
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4", label: "Claude Haiku 4" },
  ],
  google: [
    { value: "gemini-2.0-pro", label: "Gemini 2.0 Pro" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
};

// ─── Engine-settings keys this page edits ───────────────────────────────────

const PASS_KEYS = [
  {
    title: "Unified call (W11.7)",
    description:
      "Pass 1 + Pass 2 merged into a single batched vision call. Most production traffic flows through this pass.",
    vendor_key: "vision.unified_call.vendor",
    model_key: "vision.unified_call.model",
  },
  {
    title: "Description backfill",
    description:
      "Async per-image description re-scoring after the unified call. Lower-cost-per-image is preferred here.",
    vendor_key: "vision.description_backfill.vendor",
    model_key: "vision.description_backfill.model",
  },
  {
    title: "Pass 0 hard-reject",
    description:
      "Binary classifier that culls obvious rejects before Pass 1. Cheapest model wins; quality matters less for binary decisions.",
    vendor_key: "vision.pass0_hardreject.vendor",
    model_key: "vision.pass0_hardreject.model",
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return String(iso);
  }
}

function fmtUsd(n, dp = 4) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toFixed(dp)}`;
}

function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

// ─── Per-pass row: vendor + model dropdowns ─────────────────────────────────

function PassConfigRow({ title, description, vendor_key, model_key, settings, onSave }) {
  const vendorRow = settings.find((r) => r.key === vendor_key);
  const modelRow = settings.find((r) => r.key === model_key);

  const initialVendor =
    typeof vendorRow?.value === "string" ? vendorRow.value : vendorRow?.value ?? "anthropic";
  const initialModel =
    typeof modelRow?.value === "string" ? modelRow.value : modelRow?.value ?? "claude-opus-4-7";

  const [vendor, setVendor] = useState(initialVendor);
  const [model, setModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);

  const dirty = vendor !== initialVendor || model !== initialModel;
  const modelChoices = MODEL_CHOICES_BY_VENDOR[vendor] || [];

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ key: vendor_key, value: vendor });
      await onSave({ key: model_key, value: model });
      toast.success(`${title} saved.`);
    } catch (err) {
      toast.error(`Save failed: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Vendor</Label>
            <Select
              value={vendor}
              onValueChange={(v) => {
                setVendor(v);
                // Reset model to first choice for the new vendor.
                const next = MODEL_CHOICES_BY_VENDOR[v]?.[0]?.value || "";
                setModel(next);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {modelChoices.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Shadow run toggle ──────────────────────────────────────────────────────

function ShadowRunCard({ settings, onSave }) {
  const enabledRow = settings.find((r) => r.key === "vision.shadow_run.enabled");
  const vendorRow = settings.find((r) => r.key === "vision.shadow_run.vendor");
  const modelRow = settings.find((r) => r.key === "vision.shadow_run.model");

  const [enabled, setEnabled] = useState(enabledRow?.value === true);
  const [vendor, setVendor] = useState(vendorRow?.value || "google");
  const [model, setModel] = useState(modelRow?.value || "gemini-2.0-pro");
  const [saving, setSaving] = useState(false);

  const dirty =
    enabled !== (enabledRow?.value === true) ||
    vendor !== vendorRow?.value ||
    model !== modelRow?.value;

  const modelChoices = MODEL_CHOICES_BY_VENDOR[vendor] || [];

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ key: "vision.shadow_run.enabled", value: enabled });
      await onSave({ key: "vision.shadow_run.vendor", value: vendor });
      await onSave({ key: "vision.shadow_run.model", value: model });
      toast.success("Shadow run config saved.");
    } catch (err) {
      toast.error(`Save failed: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          Shadow run (parallel A/B)
        </CardTitle>
        <CardDescription className="text-xs">
          When enabled, every unified call ALSO fires a parallel shadow run against the configured
          vendor/model. Cost roughly doubles when this is on. Turn off after collecting enough A/B
          data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            id="shadow_run_enabled"
            className="h-4 w-4"
          />
          <Label htmlFor="shadow_run_enabled" className="text-sm">
            Enable shadow run
          </Label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Shadow vendor</Label>
            <Select
              value={vendor}
              onValueChange={(v) => {
                setVendor(v);
                const next = MODEL_CHOICES_BY_VENDOR[v]?.[0]?.value || "";
                setModel(next);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Shadow model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {modelChoices.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Retroactive comparison form ────────────────────────────────────────────

function RetroactiveCompareCard() {
  const [roundId, setRoundId] = useState("");
  const [costCap, setCostCap] = useState("5");
  const [maxGroups, setMaxGroups] = useState("");
  const [variants, setVariants] = useState([
    { vendor: "anthropic", model: "claude-opus-4-7", label: "anthropic-opus-baseline" },
    { vendor: "google", model: "gemini-2.0-pro", label: "google-pro-test" },
  ]);
  const [estimating, setEstimating] = useState(false);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const updateVariant = (i, patch) => {
    setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  };

  const addVariant = () => {
    setVariants((vs) => [
      ...vs,
      { vendor: "anthropic", model: "claude-sonnet-4-6", label: `variant-${vs.length + 1}` },
    ]);
  };

  const removeVariant = (i) => {
    setVariants((vs) => vs.filter((_, j) => j !== i));
  };

  const buildBody = (dryRun) => ({
    round_id: roundId.trim(),
    vendors_to_compare: variants.map((v) => ({
      vendor: v.vendor,
      model: v.model,
      label: v.label,
    })),
    pass_kinds: ["unified"],
    cost_cap_usd: Number(costCap),
    dry_run: dryRun,
    max_groups: maxGroups ? Number(maxGroups) : undefined,
  });

  const handleEstimate = async () => {
    setEstimating(true);
    setEstimate(null);
    try {
      const result = await api.functions.invoke(
        "vendor-retroactive-compare",
        buildBody(true),
      );
      setEstimate(result?.data || result);
      toast.success("Cost estimate computed.");
    } catch (err) {
      toast.error(`Estimate failed: ${err?.message || err}`);
    } finally {
      setEstimating(false);
    }
  };

  const handleRun = async () => {
    if (
      !confirm(
        `This will fire ${variants.length} vendor calls for every composition in the round. ` +
          "Are you sure?",
      )
    ) {
      return;
    }
    setRunning(true);
    setLastResult(null);
    try {
      const result = await api.functions.invoke(
        "vendor-retroactive-compare",
        buildBody(false),
      );
      setLastResult(result?.data || result);
      toast.success("Comparison complete.");
    } catch (err) {
      toast.error(`Run failed: ${err?.message || err}`);
    } finally {
      setRunning(false);
    }
  };

  const valid = roundId.trim().length > 0 && variants.length >= 1 && Number(costCap) > 0;

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4 text-primary" />
          Run retroactive comparison
        </CardTitle>
        <CardDescription className="text-xs">
          Re-runs an existing shortlisting round through one or more (vendor, model) variants and
          writes a row to <code>vendor_comparison_results</code> plus a markdown report to Dropbox at{" "}
          <code>Photos/_AUDIT/vendor_comparison_&lt;round_id&gt;.md</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <Label className="text-xs text-muted-foreground">Round ID</Label>
            <Input
              value={roundId}
              onChange={(e) => setRoundId(e.target.value)}
              placeholder="e.g. 3ed54b53-9184-402f-9907-d168ed1968a4"
              className="font-mono text-xs"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Cost cap (USD)</Label>
            <Input
              type="number"
              step="0.01"
              value={costCap}
              onChange={(e) => setCostCap(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">
            Max compositions (optional — leave blank for full round)
          </Label>
          <Input
            type="number"
            value={maxGroups}
            onChange={(e) => setMaxGroups(e.target.value)}
            placeholder="e.g. 5 (for a quick smoke test)"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Variants to compare</Label>
            <Button size="sm" variant="ghost" onClick={addVariant}>
              <Plus className="h-3 w-3 mr-1" /> Add variant
            </Button>
          </div>
          {variants.map((v, i) => {
            const modelChoices = MODEL_CHOICES_BY_VENDOR[v.vendor] || [];
            return (
              <div key={i} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end border rounded p-2">
                <div className="md:col-span-3">
                  <Label className="text-[10px] text-muted-foreground">Vendor</Label>
                  <Select
                    value={v.vendor}
                    onValueChange={(val) => {
                      const next = MODEL_CHOICES_BY_VENDOR[val]?.[0]?.value || "";
                      updateVariant(i, { vendor: val, model: next });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VENDOR_CHOICES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-4">
                  <Label className="text-[10px] text-muted-foreground">Model</Label>
                  <Select value={v.model} onValueChange={(val) => updateVariant(i, { model: val })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelChoices.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-4">
                  <Label className="text-[10px] text-muted-foreground">Label</Label>
                  <Input value={v.label} onChange={(e) => updateVariant(i, { label: e.target.value })} />
                </div>
                <div className="md:col-span-1 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeVariant(i)}
                    disabled={variants.length <= 1}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={handleEstimate} disabled={!valid || estimating || running}>
            {estimating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Estimate cost
          </Button>
          <Button size="sm" onClick={handleRun} disabled={!valid || running || estimating}>
            {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Run live comparison
          </Button>
        </div>

        {estimate && (
          <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900">
            <CardContent className="py-3 text-xs space-y-2">
              <div className="font-semibold">Pre-flight estimate</div>
              <div>
                Total estimated cost: <strong>{fmtUsd(estimate.total_estimated_usd)}</strong> ·
                cap <strong>{fmtUsd(estimate.cost_cap_usd)}</strong> · compositions:{" "}
                <strong>{estimate.total_compositions}</strong>
              </div>
              {Array.isArray(estimate.preflight) && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left">Variant</th>
                      <th className="text-right">Estimated USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estimate.preflight.map((p) => (
                      <tr key={p.label}>
                        <td>{p.label}</td>
                        <td className="text-right">{fmtUsd(p.estimated_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {lastResult && (
          <Card className="border-green-200 bg-green-50/50 dark:bg-green-950/20 dark:border-green-900">
            <CardContent className="py-3 text-xs space-y-2">
              <div className="font-semibold">Live run summary</div>
              <div>
                Comparison rows inserted: <strong>{lastResult.comparison_results_inserted}</strong>
              </div>
              {lastResult.dropbox_report_path && (
                <div className="font-mono break-all">
                  Markdown report: <code>{lastResult.dropbox_report_path}</code>
                </div>
              )}
              {Array.isArray(lastResult.summaries) && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left">Variant</th>
                      <th className="text-right">Compositions</th>
                      <th className="text-right">Failures</th>
                      <th className="text-right">Total USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastResult.summaries.map((s) => (
                      <tr key={s.label}>
                        <td>{s.label}</td>
                        <td className="text-right">{s.composition_count}</td>
                        <td className="text-right">{s.failure_count}</td>
                        <td className="text-right">{fmtUsd(s.total_cost_usd, 6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Recent comparisons table ────────────────────────────────────────────────

function RecentComparisonsCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["vendor_comparison_results"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vendor_comparison_results")
        .select(
          "id, round_id, primary_label, primary_vendor, primary_model, shadow_label, shadow_vendor, shadow_model, classification_agreement_rate, combined_score_correlation, observed_objects_overlap_rate, primary_cost_usd, shadow_cost_usd, dropbox_report_path, generated_at",
        )
        .order("generated_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 30_000,
  });

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="text-base">Recent comparisons</CardTitle>
        <CardDescription className="text-xs">
          Last 20 rows from <code>vendor_comparison_results</code>. Click the Dropbox path to open
          the full markdown report.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data || data.length === 0 ? (
          <div className="text-xs text-muted-foreground">No comparisons yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Generated</th>
                  <th className="text-left">Round</th>
                  <th className="text-left">Primary</th>
                  <th className="text-left">Shadow</th>
                  <th className="text-right">Room agree</th>
                  <th className="text-right">Score corr</th>
                  <th className="text-right">Obj overlap</th>
                  <th className="text-right">Primary $</th>
                  <th className="text-right">Shadow $</th>
                  <th className="text-left">Report</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-2">{fmtTime(r.generated_at)}</td>
                    <td className="font-mono text-[10px]" title={r.round_id}>
                      {String(r.round_id).slice(0, 8)}…
                    </td>
                    <td>
                      <Badge variant="secondary" className="text-[10px]">
                        {r.primary_label || `${r.primary_vendor}/${r.primary_model}`}
                      </Badge>
                    </td>
                    <td>
                      <Badge variant="secondary" className="text-[10px]">
                        {r.shadow_label || `${r.shadow_vendor}/${r.shadow_model}`}
                      </Badge>
                    </td>
                    <td className="text-right">{fmtPct(r.classification_agreement_rate)}</td>
                    <td className="text-right">{r.combined_score_correlation ?? "—"}</td>
                    <td className="text-right">{fmtPct(r.observed_objects_overlap_rate)}</td>
                    <td className="text-right">{fmtUsd(r.primary_cost_usd, 4)}</td>
                    <td className="text-right">{fmtUsd(r.shadow_cost_usd, 4)}</td>
                    <td>
                      {r.dropbox_report_path ? (
                        <span className="font-mono text-[10px] break-all flex items-center gap-1">
                          <ExternalLink className="h-3 w-3" />
                          {r.dropbox_report_path}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function SettingsVendorComparison() {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["engine_settings_vendor"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("engine_settings")
        .select("key, value, description, updated_at")
        .like("key", "vision.%")
        .order("key");
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 30_000,
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
      const { error } = await supabase
        .from("engine_settings")
        .update({
          value,
          updated_at: new Date().toISOString(),
          updated_by: updatedBy,
        })
        .eq("key", key);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["engine_settings_vendor"] });
    },
  });

  const settings = useMemo(() => settingsQuery.data || [], [settingsQuery.data]);

  const onSave = async ({ key, value }) => {
    return saveMutation.mutateAsync({ key, value });
  };

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold">Vendor Comparison</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Wave 11.8 — multi-vendor vision adapter (Anthropic + Google). Configure per-pass vendor
            + model, fire retroactive A/B comparisons against existing rounds, and drill into
            results.
          </p>
        </div>

        <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-amber-900 dark:text-amber-200 space-y-1">
              <div className="font-semibold">Live runtime — handle with care.</div>
              <div>
                Switching the unified-call vendor affects every new round immediately. Run a
                retroactive comparison FIRST, review the markdown report in{" "}
                <code>Photos/_AUDIT/</code>, then change the production vendor.
              </div>
              <div>
                Adding a new vendor or model requires a backend code change (one new file under{" "}
                <code>_shared/visionAdapter/adapters/</code>). Contact engineering.
              </div>
            </div>
          </CardContent>
        </Card>

        <div>
          <h2 className="text-lg font-semibold mb-3">Per-pass vendor + model</h2>
          {settingsQuery.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <div className="space-y-3">
              {PASS_KEYS.map((p) => (
                <PassConfigRow key={p.title} {...p} settings={settings} onSave={onSave} />
              ))}
              <ShadowRunCard settings={settings} onSave={onSave} />
            </div>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-3">A/B harness</h2>
          <RetroactiveCompareCard />
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-3">Recent comparisons</h2>
          <RecentComparisonsCard />
        </div>
      </div>
    </PermissionGuard>
  );
}
