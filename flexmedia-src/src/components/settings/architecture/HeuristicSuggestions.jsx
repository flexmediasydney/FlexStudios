/**
 * HeuristicSuggestions — Wave 11.6.23.
 *
 * Two sub-sections:
 *  (a) W12.7 reactive suggestions count + link to the existing
 *      /SettingsAISuggestions admin page (we DO NOT re-implement
 *      approve/reject here — the spec says route to W12.7's tab).
 *  (b) Heuristic suggestions computed server-side by the architecture
 *      KPI RPC. Three rule types:
 *      - split            (slot averaged ≥2.5 fills/round, capacity ≥2)
 *      - deletion_candidate (slot empty in ≥80% of rounds)
 *      - new_slot_needed  (zone_focus observed without anchoring slot)
 *
 *      Each suggestion has an "Approve" button that links to the
 *      AI Suggestions tab — final approval still happens there per
 *      spec (this wave does NOT mutate slot definitions).
 *
 * Pure helpers exported for unit tests:
 *   - badgeClassFor(type) → tailwind classes for the type pill
 *   - suggestionLabel(type) → human-readable label
 */
import React from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, ExternalLink, Sparkles, Trash2, Plus } from "lucide-react";

// Pure helpers ─────────────────────────────────────────────────────────────

export function badgeClassFor(type) {
  switch (type) {
    case "split":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200";
    case "deletion_candidate":
      return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200";
    case "new_slot_needed":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200";
    default:
      return "bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-200";
  }
}

export function suggestionLabel(type) {
  switch (type) {
    case "split":
      return "Split slot";
    case "deletion_candidate":
      return "Deletion candidate";
    case "new_slot_needed":
      return "New slot needed";
    default:
      return type || "Suggestion";
  }
}

const ICON_FOR = {
  split: Sparkles,
  deletion_candidate: Trash2,
  new_slot_needed: Plus,
};

export default function HeuristicSuggestions({ data, loading }) {
  const reactiveCount = Number(data?.slot_suggestion_pending_count) || 0;
  const heuristics = Array.isArray(data?.heuristic_slot_suggestions)
    ? data.heuristic_slot_suggestions
    : [];

  return (
    <Card data-testid="heuristic-suggestions">
      <CardContent className="p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            Slot suggestions
          </h3>
          <p className="text-xs text-muted-foreground">
            {loading ? "Loading…" : ""}
            Approvals happen on the AI Suggestions tab — this panel surfaces
            insights only.
          </p>
        </div>

        {/* ── (a) W12.7 reactive suggestion count ──────────────────────── */}
        <div
          className="flex items-center justify-between rounded border border-border p-2 text-xs"
          data-testid="reactive-suggestion-link"
        >
          <div>
            <div className="font-semibold">W12.7 reactive suggestions</div>
            <div className="text-muted-foreground">
              {reactiveCount} pending review in shortlisting_slot_suggestions.
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link
              to="/SettingsShortlistingCommandCenter?tab=suggestions"
              data-testid="link-suggestions-tab"
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Open AI Suggestions
            </Link>
          </Button>
        </div>

        {/* ── (b) Heuristic suggestions computed server-side ──────────── */}
        <div data-testid="heuristic-list">
          {!loading && heuristics.length === 0 && (
            <div
              className="text-xs text-muted-foreground rounded border border-dashed border-border p-3 text-center"
              data-testid="heuristic-empty"
            >
              No heuristic suggestions surfaced from the last{" "}
              {data?.window_days ?? 30} days. The engine looks healthy.
            </div>
          )}

          {heuristics.length > 0 && (
            <ul className="space-y-1.5">
              {heuristics.map((s, i) => {
                const Icon = ICON_FOR[s.type] || Lightbulb;
                return (
                  <li
                    key={`${s.type}-${s.slot_id || s.zone_focus || i}`}
                    className="rounded border border-border p-2 text-xs flex items-start gap-2"
                    data-testid={`heuristic-${s.type}-${
                      s.slot_id || s.zone_focus || i
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge
                          variant="outline"
                          className={`${badgeClassFor(
                            s.type,
                          )} text-[10px] px-1.5 py-0 font-mono`}
                        >
                          {suggestionLabel(s.type)}
                        </Badge>
                        <span className="font-mono font-semibold truncate">
                          {s.slot_id || s.zone_focus || "—"}
                        </span>
                      </div>
                      <p className="text-muted-foreground leading-snug">
                        {s.rationale}
                      </p>
                    </div>
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="flex-shrink-0"
                      data-testid={`heuristic-approve-${
                        s.slot_id || s.zone_focus || i
                      }`}
                    >
                      <Link to="/SettingsShortlistingCommandCenter?tab=suggestions">
                        Approve
                      </Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
