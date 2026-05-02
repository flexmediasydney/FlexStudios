/**
 * CalibrationSessionDetailTab — Wave 14
 *
 * Tab 2 of SettingsCalibrationSessions. For a single session, surfaces:
 *   - Stratification summary (cells × counts).
 *   - Editor shortlist progress (X / N submitted).
 *   - "Run AI Batch" button — invokes calibration-run-ai-batch which
 *     orchestrates the benchmark-runner with trigger='calibration'.
 *   - Disagreement diff table — agreement / disagree rows from
 *     calibration_decisions, grouped by project, with approve/reject per row.
 *   - Signal-impact ranking via rankSignalsByMarketImpact (joined against
 *     object_registry.market_frequency).
 *
 * Spec: docs/design-specs/W14-calibration-session.md §3 + §7 + §8.
 */

import { useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Activity,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";
import DisagreementRow from "@/components/settings/calibration/DisagreementRow";

export default function CalibrationSessionDetailTab({ sessionId }) {
  const qc = useQueryClient();

  const sessionQuery = useQuery({
    queryKey: ["calibration-session", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const rows = await api.entities.CalibrationSession.filter(
        { id: sessionId },
        null,
        1,
      );
      return rows[0] || null;
    },
  });

  const editorRowsQuery = useQuery({
    queryKey: ["calibration-editor-shortlists", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      return api.entities.CalibrationEditorShortlist.filter(
        { calibration_session_id: sessionId },
        null,
        500,
      );
    },
  });

  const decisionsQuery = useQuery({
    queryKey: ["calibration-decisions", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      return api.entities.CalibrationDecision.filter(
        { calibration_session_id: sessionId },
        null,
        2000,
      );
    },
  });

  const runBatch = useMutation({
    mutationFn: async () => {
      const result = await api.functions.invoke("calibration-run-ai-batch", {
        calibration_session_id: sessionId,
      });
      return result?.data ?? result;
    },
    onSuccess: (resp) => {
      const dispatched = resp?.rounds_dispatched ?? 0;
      toast.success(
        `AI batch dispatched (${dispatched} rounds). Decisions populate as the runner completes.`,
      );
      qc.invalidateQueries({ queryKey: ["calibration-session", sessionId] });
      qc.invalidateQueries({
        queryKey: ["calibration-editor-shortlists", sessionId],
      });
    },
    onError: (err) => {
      toast.error(`Run AI Batch failed: ${err?.message || String(err)}`);
    },
  });

  if (!sessionId) {
    return (
      <Card>
        <CardContent
          className="p-6 text-sm text-muted-foreground"
          data-testid="detail-no-session"
        >
          Pick a session from the Sessions tab to see its detail.
        </CardContent>
      </Card>
    );
  }

  if (sessionQuery.isLoading || editorRowsQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  const session = sessionQuery.data;
  if (!session) {
    return (
      <Card>
        <CardContent
          className="p-6 text-sm text-destructive"
          data-testid="detail-session-not-found"
        >
          Session {sessionId} not found.
        </CardContent>
      </Card>
    );
  }

  const editorRows = editorRowsQuery.data || [];
  const decisions = decisionsQuery.data || [];
  const submittedCount = editorRows.filter((r) => r.status === "submitted").length;
  const totalProjects = Array.isArray(session.selected_project_ids)
    ? session.selected_project_ids.length
    : editorRows.length;
  const aiCompleted = editorRows.filter(
    (r) => r.ai_run_completed_at != null,
  ).length;

  const matches = decisions.filter((d) => d.agreement === "match");
  const disagreements = decisions.filter((d) => d.agreement === "disagree");

  return (
    <div className="space-y-3" data-testid="detail-tab">
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2">
                {session.session_name || "Untitled session"}
                <Badge variant="outline" className="text-[10px]">
                  {session.status}
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs">
                Engine{" "}
                <span className="font-mono">
                  {session.engine_version || "—"}
                </span>{" "}
                · started{" "}
                {session.started_at
                  ? new Date(session.started_at).toLocaleString()
                  : "—"}
              </CardDescription>
            </div>
            <Button
              onClick={() => runBatch.mutate()}
              disabled={runBatch.isPending || submittedCount === 0}
              size="sm"
              data-testid="run-ai-batch-button"
              className="shrink-0"
              title={
                submittedCount === 0
                  ? "Submit at least one editor shortlist before running the AI batch"
                  : "Dispatch the benchmark-runner over each project's locked round"
              }
            >
              {runBatch.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Activity className="h-3.5 w-3.5 mr-1.5" />
              )}
              Run AI Batch
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-2 text-xs space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
            <Metric label="Projects" value={totalProjects} />
            <Metric
              label="Editor submitted"
              value={`${submittedCount}/${totalProjects}`}
              testId="metric-editor-submitted"
            />
            <Metric
              label="AI completed"
              value={`${aiCompleted}/${totalProjects}`}
              testId="metric-ai-completed"
            />
            <Metric
              label="Decisions"
              value={`${matches.length} match · ${disagreements.length} disagree`}
              testId="metric-decisions"
            />
          </div>
          <StratificationSummary config={session.stratification_config} />
        </CardContent>
      </Card>

      <SignalPriorityCard sessionId={sessionId} disagreements={disagreements} />

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            Disagreement diff
          </CardTitle>
          <CardDescription className="text-[11px]">
            Editor-vs-AI disagreement rows. Approve to confirm the AI's call;
            reject to keep the editor's pick as ground truth (used for tuning
            tier weights + populating few-shot examples).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {decisions.length === 0 ? (
            <div
              className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded"
              data-testid="empty-state-decisions"
            >
              No decisions yet. Run the AI batch after editors have submitted
              their shortlists — calibration_decisions rows will appear here
              automatically.
            </div>
          ) : (
            <div className="space-y-3">
              {disagreements.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-1.5 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Disagreements ({disagreements.length})
                  </h4>
                  <div
                    className="space-y-1.5"
                    data-testid="disagreement-rows"
                  >
                    {disagreements.map((row) => (
                      <DisagreementRow
                        key={row.id}
                        decision={row}
                        sessionId={sessionId}
                      />
                    ))}
                  </div>
                </div>
              )}
              {matches.length > 0 && (
                <details className="text-[11px]">
                  <summary
                    className="cursor-pointer text-muted-foreground hover:text-foreground flex items-center gap-1"
                    data-testid="match-rows-toggle"
                  >
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    Matches ({matches.length}) — show
                  </summary>
                  <div
                    className="space-y-1 mt-1.5 ml-3"
                    data-testid="match-rows"
                  >
                    {matches.slice(0, 50).map((row) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                        <span className="font-mono truncate">{row.slot_id}</span>
                        <span className="opacity-60 truncate">{row.stem || "—"}</span>
                      </div>
                    ))}
                    {matches.length > 50 && (
                      <div className="text-[10px] opacity-50">
                        + {matches.length - 50} more matches not shown.
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, testId }) {
  return (
    <div className="border rounded p-2" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function StratificationSummary({ config }) {
  if (!config || typeof config !== "object") return null;
  const cells = Array.isArray(config.cells) ? config.cells : [];
  if (cells.length === 0) return null;
  return (
    <div className="border-t pt-2 mt-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        Stratification cells
      </div>
      <div className="flex flex-wrap gap-1.5">
        {cells.map((c, i) => (
          <Badge
            key={`${c.cell_key || i}`}
            variant="outline"
            className="text-[10px] font-normal"
          >
            <span className="font-mono mr-1">{c.cell_key || `${c.tier || "?"}/${c.project_type || "?"}`}</span>
            <span className="tabular-nums">×{c.count ?? "?"}</span>
          </Badge>
        ))}
      </div>
    </div>
  );
}

function SignalPriorityCard({ sessionId, disagreements }) {
  // Pull market_frequency from object_registry to compute priority via the
  // pure helper (rankSignalsByMarketImpact). Fetched once per render of the
  // detail tab; lightweight (registry has ≤ 10k rows).
  const { data: registry } = useQuery({
    queryKey: ["object-registry", "for-calibration"],
    enabled: !!sessionId && disagreements.length > 0,
    queryFn: async () => {
      return api.entities.ObjectRegistry.list("-market_frequency", 1000);
    },
  });

  const ranking = useMemo(() => {
    if (!disagreements.length) return [];
    const freqByCanonical = new Map();
    for (const r of registry || []) {
      const id = r.canonical_id || r.id;
      if (id) freqByCanonical.set(String(id).toLowerCase(), r.market_frequency ?? null);
      if (r.canonical_display_name) {
        freqByCanonical.set(String(r.canonical_display_name).toLowerCase(), r.market_frequency ?? null);
      }
    }
    // Pure JS port of rankSignalsByMarketImpact (mirrors the Deno helper at
    // _shared/calibrationSessionMath.ts).
    const grouped = new Map();
    for (const d of disagreements) {
      const key = d.primary_signal_diff;
      if (!key) continue;
      const slot = grouped.get(key);
      const lookupKey = String(key).toLowerCase();
      const freq = freqByCanonical.has(lookupKey)
        ? freqByCanonical.get(lookupKey)
        : null;
      if (!slot) {
        grouped.set(key, {
          count: 1,
          market_frequency: freq,
          example_reasonings: d.editor_reasoning ? [d.editor_reasoning] : [],
        });
      } else {
        slot.count += 1;
        if (
          slot.market_frequency == null ||
          (freq != null && freq > slot.market_frequency)
        ) {
          slot.market_frequency = freq;
        }
        if (d.editor_reasoning && slot.example_reasonings.length < 3) {
          slot.example_reasonings.push(d.editor_reasoning);
        }
      }
    }
    const out = [];
    for (const [key, agg] of grouped.entries()) {
      const priority = agg.market_frequency != null ? agg.market_frequency * agg.count : 0;
      out.push({
        primary_signal_diff: key,
        count: agg.count,
        market_frequency: agg.market_frequency,
        priority_score: priority,
        example_reasonings: agg.example_reasonings,
      });
    }
    out.sort((a, b) => {
      if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
      if (b.count !== a.count) return b.count - a.count;
      return a.primary_signal_diff.localeCompare(b.primary_signal_diff);
    });
    return out;
  }, [registry, disagreements]);

  if (!disagreements.length || ranking.length === 0) return null;

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-blue-600" />
          Signal priority (market-frequency weighted)
        </CardTitle>
        <CardDescription className="text-[11px]">
          Touch these dimensions / signals first when tuning tier weights —
          each row is the editor's primary_signal_diff × count × the canonical
          object registry's market_frequency.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 text-xs">
        <div className="space-y-1.5" data-testid="signal-ranking">
          {ranking.slice(0, 10).map((r) => (
            <div
              key={r.primary_signal_diff}
              className="flex items-baseline gap-2 tabular-nums"
              data-testid={`signal-${r.primary_signal_diff}`}
            >
              <Badge variant="secondary" className="text-[10px] font-mono">
                {r.primary_signal_diff}
              </Badge>
              <span className="text-muted-foreground">×{r.count}</span>
              {r.market_frequency != null && (
                <span className="text-muted-foreground">
                  · freq {r.market_frequency}
                </span>
              )}
              <span className="ml-auto font-semibold">
                {r.priority_score.toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
