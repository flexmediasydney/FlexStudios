/**
 * SettingsTierConfigs.jsx — Wave 8 (W8.3) admin UI for shortlisting_tier_configs.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §6.
 *
 * Per-tier card showing:
 *   - Active version + dimension weights breakdown (4 numeric inputs +
 *     sum indicator that turns red if not 1.0)
 *   - Hard-reject thresholds (toggle: use global ↔ override)
 *   - Notes textarea (optional rationale)
 *   - Buttons: "Edit draft" → opens Modal; "View history" → side panel
 *
 * Edit draft modal:
 *   - Pre-fills with current active values
 *   - Sliders/numeric inputs for the 4 dimensions
 *   - Numeric input grid for the 22 signals (default 1.0; rare to edit)
 *   - Hard-reject thresholds editable per-tier or NULL=inherit
 *   - Notes required
 *   - "Save draft" → POSTs to update-tier-config (action: 'save_draft')
 *
 * After save, an inline preview box appears under the tier card:
 *   - Shows the draft's diff vs active in summary
 *   - "Preview impact" → POSTs to simulate-tier-config → renders diff table
 *   - "Activate" → POSTs to update-tier-config (action: 'activate')
 *   - "Discard" → POSTs to update-tier-config (action: 'discard')
 *
 * Permission gating:
 *   - master_admin: all actions including activate
 *   - admin: save draft, simulate, discard — activate button hidden
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { PermissionGuard, usePermissions } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Loader2,
  Save,
  Sliders,
  Check,
  X,
  History,
  TestTube2,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

// ── Constants ───────────────────────────────────────────────────────────────
const DIMENSION_KEYS = ["technical", "lighting", "composition", "aesthetic"];
const DEFAULT_DIMENSION_WEIGHTS = {
  technical: 0.25,
  lighting: 0.30,
  composition: 0.25,
  aesthetic: 0.20,
};

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return String(iso);
  }
}

function sumDimensionWeights(weights) {
  return DIMENSION_KEYS.reduce((acc, k) => acc + Number(weights[k] ?? 0), 0);
}

// ── Tier Card ───────────────────────────────────────────────────────────────
function TierCard({ tier, activeConfig, draftConfig, onEdit, onSimulate, onActivate, onDiscard, isMasterAdmin, simulating, activating, discarding }) {
  const dimensionWeights = activeConfig?.dimension_weights ?? DEFAULT_DIMENSION_WEIGHTS;
  const hardRejectThresholds = activeConfig?.hard_reject_thresholds;
  const sigCount = activeConfig?.signal_weights ? Object.keys(activeConfig.signal_weights).length : 0;

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Sliders className="h-5 w-5 text-primary" />
            Tier {tier.tier_code} — {tier.display_name}
            <Badge variant="outline" className="ml-2 text-xs">
              anchor {tier.score_anchor}
            </Badge>
          </span>
          {activeConfig && (
            <Badge variant="secondary">v{activeConfig.version}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {activeConfig
            ? `Active version ${activeConfig.version} (activated ${fmtTime(activeConfig.activated_at)})`
            : "No active config — engine falls back to defaults"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Dimension weights */}
        <div>
          <div className="text-sm font-medium mb-2">Dimension weights</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {DIMENSION_KEYS.map((k) => (
              <div key={k} className="flex justify-between border rounded px-3 py-1.5">
                <span className="text-muted-foreground capitalize">{k}</span>
                <span className="font-mono">
                  {Number(dimensionWeights[k] ?? 0).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Sum:{" "}
            <span className="font-mono">
              {sumDimensionWeights(dimensionWeights).toFixed(3)}
            </span>
          </div>
        </div>

        {/* Signal weights summary */}
        <div className="text-sm">
          <span className="text-muted-foreground">Signal weights:</span>{" "}
          <span className="font-mono">{sigCount} signals</span>
          {sigCount > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              (uniform = 1.0 across the table at v1)
            </span>
          )}
        </div>

        {/* Hard-reject thresholds */}
        <div className="text-sm">
          <span className="text-muted-foreground">Hard-reject thresholds:</span>{" "}
          {hardRejectThresholds ? (
            <span className="font-mono">
              technical {hardRejectThresholds.technical ?? "—"}, lighting{" "}
              {hardRejectThresholds.lighting ?? "—"}
            </span>
          ) : (
            <span className="italic text-muted-foreground">
              using engine_settings global
            </span>
          )}
        </div>

        {activeConfig?.notes && (
          <div className="text-xs text-muted-foreground border-l-2 pl-2 italic">
            "{activeConfig.notes}"
          </div>
        )}

        {/* Draft preview (when a draft exists for this tier) */}
        {draftConfig && (
          <div className="border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 rounded p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-700" />
                <span className="text-sm font-medium">
                  Draft v{draftConfig.version}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  unactivated
                </Badge>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {fmtTime(draftConfig.created_at)}
              </div>
            </div>
            <div className="text-xs space-y-0.5">
              {DIMENSION_KEYS.map((k) => {
                const oldV = Number(activeConfig?.dimension_weights?.[k] ?? 0);
                const newV = Number(draftConfig.dimension_weights[k] ?? 0);
                const delta = newV - oldV;
                if (Math.abs(delta) < 0.001) return null;
                return (
                  <div key={k} className="font-mono">
                    {k}: {oldV.toFixed(2)} → {newV.toFixed(2)} (
                    <span className={delta > 0 ? "text-green-700" : "text-red-700"}>
                      {delta > 0 ? "+" : ""}
                      {delta.toFixed(2)}
                    </span>
                    )
                  </div>
                );
              })}
            </div>
            {draftConfig.notes && (
              <div className="text-xs italic border-l-2 border-amber-400 pl-2">
                "{draftConfig.notes}"
              </div>
            )}
            <div className="flex gap-2 pt-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSimulate(draftConfig)}
                disabled={simulating}
              >
                {simulating ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <TestTube2 className="h-3 w-3 mr-1" />
                )}
                Preview impact
              </Button>
              {isMasterAdmin && (
                <Button
                  size="sm"
                  onClick={() => onActivate(draftConfig)}
                  disabled={activating}
                >
                  {activating ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3 mr-1" />
                  )}
                  Activate
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDiscard(draftConfig)}
                disabled={discarding}
              >
                {discarding ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <X className="h-3 w-3 mr-1" />
                )}
                Discard
              </Button>
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button size="sm" variant="default" onClick={() => onEdit(tier, activeConfig)}>
            <Sliders className="h-3 w-3 mr-1" />
            {draftConfig ? "Edit draft further" : "Edit draft"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Edit Draft Modal ─────────────────────────────────────────────────────────
function EditDraftModal({ open, onOpenChange, tier, activeConfig, onSave, saving }) {
  const [draft, setDraft] = useState({
    technical: 0.25,
    lighting: 0.30,
    composition: 0.25,
    aesthetic: 0.20,
    notes: "",
    overrideHardReject: false,
    technicalReject: 4.0,
    lightingReject: 4.0,
    signalWeightsJson: "{}",
  });

  // Reset when modal re-opens.
  useEffect(() => {
    if (open && activeConfig) {
      const dw = activeConfig.dimension_weights ?? DEFAULT_DIMENSION_WEIGHTS;
      const hr = activeConfig.hard_reject_thresholds;
      setDraft({
        technical: Number(dw.technical ?? 0.25),
        lighting: Number(dw.lighting ?? 0.30),
        composition: Number(dw.composition ?? 0.25),
        aesthetic: Number(dw.aesthetic ?? 0.20),
        notes: "",
        overrideHardReject: hr != null,
        technicalReject: hr?.technical ?? 4.0,
        lightingReject: hr?.lighting ?? 4.0,
        signalWeightsJson: JSON.stringify(
          activeConfig.signal_weights ?? {},
          null,
          2,
        ),
      });
    }
  }, [open, activeConfig]);

  const sum = sumDimensionWeights(draft);
  const sumOk = Math.abs(sum - 1) <= 0.001;
  const notesOk = draft.notes.trim().length > 0;

  const handleSave = () => {
    let parsedSignals = {};
    try {
      parsedSignals = JSON.parse(draft.signalWeightsJson || "{}");
    } catch (err) {
      toast.error(`signal_weights JSON parse failed: ${err.message}`);
      return;
    }

    const payload = {
      action: "save_draft",
      tier_id: tier.id,
      draft: {
        dimension_weights: {
          technical: Number(draft.technical),
          lighting: Number(draft.lighting),
          composition: Number(draft.composition),
          aesthetic: Number(draft.aesthetic),
        },
        signal_weights: parsedSignals,
        hard_reject_thresholds: draft.overrideHardReject
          ? {
              technical: Number(draft.technicalReject),
              lighting: Number(draft.lightingReject),
            }
          : null,
        notes: draft.notes.trim(),
      },
    };
    onSave(payload);
  };

  if (!tier) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Edit draft — Tier {tier.tier_code} ({tier.display_name})
          </DialogTitle>
          <DialogDescription>
            Drafts are saved with is_active=FALSE. Use "Preview impact" before
            activating to see how the change affects recent locked rounds.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium mb-2 block">
              Dimension weights (must sum to 1.0)
            </Label>
            <div className="grid grid-cols-2 gap-3">
              {DIMENSION_KEYS.map((k) => (
                <div key={k}>
                  <Label className="text-xs text-muted-foreground capitalize">
                    {k}
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={draft[k]}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [k]: e.target.value }))
                    }
                    className="font-mono"
                  />
                </div>
              ))}
            </div>
            <div className={`text-xs mt-1 ${sumOk ? "text-green-700" : "text-red-700 font-semibold"}`}>
              Sum: <span className="font-mono">{sum.toFixed(3)}</span>{" "}
              {sumOk ? "✓" : "(must equal 1.000 ± 0.001)"}
            </div>
          </div>

          <div>
            <Label className="text-sm font-medium mb-1 block">
              Hard-reject thresholds
            </Label>
            <div className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                id="override_reject"
                checked={draft.overrideHardReject}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, overrideHardReject: e.target.checked }))
                }
              />
              <label htmlFor="override_reject" className="cursor-pointer">
                Override engine_settings global for this tier
              </label>
            </div>
            {draft.overrideHardReject && (
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <Label className="text-xs text-muted-foreground">
                    technical floor
                  </Label>
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    max="10"
                    value={draft.technicalReject}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, technicalReject: e.target.value }))
                    }
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    lighting floor
                  </Label>
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    max="10"
                    value={draft.lightingReject}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, lightingReject: e.target.value }))
                    }
                    className="font-mono"
                  />
                </div>
              </div>
            )}
          </div>

          <details>
            <summary className="text-sm font-medium cursor-pointer">
              Signal weights (advanced)
            </summary>
            <div className="mt-2">
              <Label className="text-xs text-muted-foreground mb-1 block">
                JSON map of signal_key → weight. Default uniform 1.0 at v1.
              </Label>
              <Textarea
                value={draft.signalWeightsJson}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, signalWeightsJson: e.target.value }))
                }
                rows={6}
                className="font-mono text-xs"
              />
            </div>
          </details>

          <div>
            <Label className="text-sm font-medium mb-1 block">
              Notes (required — explain why this change)
            </Label>
            <Textarea
              value={draft.notes}
              onChange={(e) =>
                setDraft((d) => ({ ...d, notes: e.target.value }))
              }
              placeholder='e.g. "Mosman calibration: lifestyle shots underperformed; bumping aesthetic +0.05"'
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!sumOk || !notesOk || saving}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Impact Diff Modal ────────────────────────────────────────────────────────
function ImpactDiffModal({ open, onOpenChange, simulationResult, onActivate, isMasterAdmin, activating }) {
  if (!simulationResult) return null;

  const filtered = simulationResult.rounds || [];
  const changedRounds = filtered.filter((r) => r.changed_count > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Re-simulation diff — Tier {simulationResult.tier_code} draft v
            {simulationResult.draft_version}
          </DialogTitle>
          <DialogDescription>
            Replayed {simulationResult.rounds_replayed} locked rounds under the
            draft weights. Compares simulated winners against the actual locked
            shortlist.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 text-center my-3">
          <div className="border rounded p-3">
            <div className="text-2xl font-bold">{simulationResult.total_slots}</div>
            <div className="text-xs text-muted-foreground">Total slots</div>
          </div>
          <div className="border rounded p-3 bg-green-50 dark:bg-green-950/20">
            <div className="text-2xl font-bold text-green-700 dark:text-green-400">
              {simulationResult.unchanged_count}
            </div>
            <div className="text-xs text-muted-foreground">Unchanged</div>
          </div>
          <div className="border rounded p-3 bg-amber-50 dark:bg-amber-950/20">
            <div className="text-2xl font-bold text-amber-700 dark:text-amber-400">
              {simulationResult.changed_count}
            </div>
            <div className="text-xs text-muted-foreground">Changed</div>
          </div>
        </div>

        {changedRounds.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-4">
            No slot winners changed — the draft would produce the same shortlist
            as the active config across all replayed rounds.
          </div>
        ) : (
          <div className="space-y-3">
            {changedRounds.map((round) => (
              <div key={round.round_id} className="border rounded p-3">
                <div className="text-sm font-medium mb-1">
                  Round {round.round_number} — {round.project_address ?? "(no address)"}
                  <span className="ml-2 text-xs text-muted-foreground">
                    locked {fmtTime(round.locked_at)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mb-2">
                  {round.changed_count} of {round.changed_count + round.unchanged_count} slots changed
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1">Slot</th>
                      <th className="py-1">Old winner</th>
                      <th className="py-1 text-right">old score</th>
                      <th className="py-1">New winner</th>
                      <th className="py-1 text-right">new score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {round.diffs
                      .filter((d) => d.changed)
                      .map((d) => (
                        <tr key={d.slot_id} className="border-b">
                          <td className="py-1 font-mono">{d.slot_id}</td>
                          <td className="py-1 font-mono">
                            {d.winner_old_stem ?? "—"}
                          </td>
                          <td className="py-1 text-right font-mono">
                            {d.winner_old_combined_score?.toFixed(2) ?? "—"}
                          </td>
                          <td className="py-1 font-mono">
                            {d.winner_new_stem ?? "—"}
                          </td>
                          <td className="py-1 text-right font-mono">
                            {d.winner_new_combined_score?.toFixed(2) ?? "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {isMasterAdmin && (
            <Button onClick={onActivate} disabled={activating}>
              {activating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-2" />
              )}
              Activate this draft
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsTierConfigs() {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions();

  const [editingTier, setEditingTier] = useState(null);
  const [editingActiveConfig, setEditingActiveConfig] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [simulationResult, setSimulationResult] = useState(null);
  const [showImpactModal, setShowImpactModal] = useState(false);
  const [pendingActivateDraft, setPendingActivateDraft] = useState(null);

  // Load: tiers + tier_configs
  const tiersQuery = useQuery({
    queryKey: ["shortlisting_tier_configs_full"],
    queryFn: async () => {
      const [{ data: tiers, error: tiersErr }, { data: configs, error: configsErr }] = await Promise.all([
        supabase
          .from("shortlisting_tiers")
          .select("id, tier_code, display_name, score_anchor, is_active, display_order")
          .eq("is_active", true)
          .order("display_order"),
        supabase
          .from("shortlisting_tier_configs")
          .select(
            "id, tier_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, activated_at, deactivated_at, created_by, notes, created_at, updated_at",
          )
          .order("version", { ascending: false }),
      ]);
      if (tiersErr) throw new Error(`tiers load: ${tiersErr.message}`);
      if (configsErr) throw new Error(`configs load: ${configsErr.message}`);
      return { tiers: tiers || [], configs: configs || [] };
    },
    staleTime: 30 * 1000,
  });

  const { activeByTier, draftByTier } = useMemo(() => {
    if (!tiersQuery.data) return { activeByTier: new Map(), draftByTier: new Map() };
    const a = new Map();
    const d = new Map();
    for (const c of tiersQuery.data.configs) {
      if (c.is_active) {
        a.set(c.tier_id, c);
      } else if (!d.has(c.tier_id)) {
        // Most-recent draft only (configs ordered by version DESC)
        d.set(c.tier_id, c);
      }
    }
    return { activeByTier: a, draftByTier: d };
  }, [tiersQuery.data]);

  // Save draft via update-tier-config edge fn
  const saveDraftMutation = useMutation({
    mutationFn: async (payload) => {
      const result = await api.functions.invoke("update-tier-config", payload);
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_tier_configs_full"] });
      toast.success("Draft saved.");
      setShowEditModal(false);
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  // Activate draft via update-tier-config edge fn
  const activateMutation = useMutation({
    mutationFn: async (draftId) => {
      const result = await api.functions.invoke("update-tier-config", {
        action: "activate",
        draft_id: draftId,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_tier_configs_full"] });
      toast.success("Draft activated. Engine will read the new config on the next round.");
      setShowImpactModal(false);
      setPendingActivateDraft(null);
    },
    onError: (err) => {
      const msg = err?.message || String(err);
      if (msg.includes("concurrent_activation")) {
        toast.error("Another admin just activated. Refreshing…");
        queryClient.invalidateQueries({ queryKey: ["shortlisting_tier_configs_full"] });
      } else {
        toast.error(`Activate failed: ${msg}`);
      }
    },
  });

  // Discard draft via update-tier-config edge fn
  const discardMutation = useMutation({
    mutationFn: async (draftId) => {
      const result = await api.functions.invoke("update-tier-config", {
        action: "discard",
        draft_id: draftId,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_tier_configs_full"] });
      toast.success("Draft discarded.");
    },
    onError: (err) => toast.error(`Discard failed: ${err?.message || err}`),
  });

  // Simulate via simulate-tier-config edge fn
  const simulateMutation = useMutation({
    mutationFn: async (draftConfig) => {
      const result = await api.functions.invoke("simulate-tier-config", {
        draft_tier_config_id: draftConfig.id,
        tier_id: draftConfig.tier_id,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      setSimulationResult(data);
      setShowImpactModal(true);
      setPendingActivateDraft(null);
    },
    onError: (err) => toast.error(`Simulate failed: ${err?.message || err}`),
  });

  const handleEdit = (tier, activeConfig) => {
    setEditingTier(tier);
    setEditingActiveConfig(activeConfig);
    setShowEditModal(true);
  };

  const handleSimulate = (draftConfig) => {
    setPendingActivateDraft(draftConfig);
    simulateMutation.mutate(draftConfig);
  };

  const handleActivateFromCard = (draftConfig) => {
    activateMutation.mutate(draftConfig.id);
  };

  const handleActivateFromImpact = () => {
    if (pendingActivateDraft) {
      activateMutation.mutate(pendingActivateDraft.id);
    }
  };

  const handleDiscard = (draftConfig) => {
    discardMutation.mutate(draftConfig.id);
  };

  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold">Engine Tier Configs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Per-tier dimension weights, signal weights, and hard-reject thresholds
            for the shortlisting engine. Drafts are saved unactivated; use
            "Preview impact" to see how a change affects recent locked rounds
            before activating.
          </p>
        </div>

        <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-amber-900 dark:text-amber-200 space-y-1">
              <div className="font-semibold">Live runtime configuration.</div>
              <div>
                Activated changes take effect on the NEXT round bootstrap. Existing
                locked rounds keep their original combined_score; replay them with
                "Preview impact" before activating.
              </div>
              {!isMasterAdmin && (
                <div>
                  Admin-only mode: you can save drafts and run simulations.
                  Activation requires master_admin.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {tiersQuery.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : tiersQuery.error ? (
          <div className="text-sm text-destructive">
            Failed to load tier configs: {tiersQuery.error.message}
          </div>
        ) : tiersQuery.data?.tiers.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No active tiers found. Migration 339 should have seeded S/P/A — if
              this is empty, contact engineering.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {tiersQuery.data.tiers.map((tier) => (
              <TierCard
                key={tier.id}
                tier={tier}
                activeConfig={activeByTier.get(tier.id) ?? null}
                draftConfig={draftByTier.get(tier.id) ?? null}
                onEdit={handleEdit}
                onSimulate={handleSimulate}
                onActivate={handleActivateFromCard}
                onDiscard={handleDiscard}
                isMasterAdmin={isMasterAdmin}
                simulating={simulateMutation.isPending}
                activating={activateMutation.isPending}
                discarding={discardMutation.isPending}
              />
            ))}
          </div>
        )}

        <EditDraftModal
          open={showEditModal}
          onOpenChange={setShowEditModal}
          tier={editingTier}
          activeConfig={editingActiveConfig}
          onSave={(payload) => saveDraftMutation.mutate(payload)}
          saving={saveDraftMutation.isPending}
        />

        <ImpactDiffModal
          open={showImpactModal}
          onOpenChange={setShowImpactModal}
          simulationResult={simulationResult}
          onActivate={handleActivateFromImpact}
          isMasterAdmin={isMasterAdmin}
          activating={activateMutation.isPending}
        />
      </div>
    </PermissionGuard>
  );
}
