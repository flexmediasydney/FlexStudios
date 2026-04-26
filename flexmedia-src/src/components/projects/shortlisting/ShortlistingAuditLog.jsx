/**
 * ShortlistingAuditLog — Wave 6 Phase 6 SHORTLIST
 *
 * Timeline view of shortlisting_events for a round. Most recent first.
 *
 * Per row: timestamp, event_type badge, actor (system/user/worker),
 *          payload summary (collapsible JSON details).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

const EVENT_TONE = {
  pass0_complete: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  pass1_complete: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  pass2_complete: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pass3_complete: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pass2_slot_assigned: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  pass2_phase3_recommendation: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  shortlist_locked: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  overrides_batch: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  round_started: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const ACTOR_TONE = {
  system: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  worker: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  user: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

function payloadSummary(event) {
  if (!event.payload || typeof event.payload !== "object") return null;
  const p = event.payload;
  switch (event.event_type) {
    case "pass2_complete":
      return `${p.shortlist_count ?? "?"} shortlisted · phase1=${p.phase1_filled ?? "?"} phase2=${p.phase2_filled ?? "?"} phase3=${p.phase3_added ?? "?"} · $${p.cost_usd ?? "?"}`;
    case "pass2_slot_assigned":
      return `${p.slot_id ?? "?"} · rank ${p.rank ?? "?"} · phase ${p.phase ?? "?"}`;
    case "pass2_phase3_recommendation":
      return `${p.stem ?? "?"} · ai-rec rank ${p.rank ?? "?"}`;
    case "shortlist_locked":
      return `approved=${p.moved_approved ?? "?"} rejected=${p.moved_rejected ?? "?"} skipped=${p.skipped ?? "?"}`;
    case "overrides_batch":
      return `${p.count ?? "?"} override${p.count === 1 ? "" : "s"}`;
    default:
      return null;
  }
}

export default function ShortlistingAuditLog({ roundId }) {
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const eventsQuery = useQuery({
    queryKey: ["shortlisting_events_audit", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingEvent.filter(
        { round_id: roundId },
        "-created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const events = eventsQuery.data || [];

  const toggle = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (eventsQuery.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-12 bg-muted rounded" />
        <div className="h-48 bg-muted rounded" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No events recorded for this round yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-1">
      {events.map((ev) => {
        const expanded = expandedIds.has(ev.id);
        const summary = payloadSummary(ev);
        const hasPayload =
          ev.payload && typeof ev.payload === "object" && Object.keys(ev.payload).length > 0;
        return (
          <Card key={ev.id} className="border bg-card">
            <CardContent className="p-2.5">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap pt-0.5">
                    {format(new Date(ev.created_at), "d MMM HH:mm:ss")}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      <Badge
                        className={cn(
                          "text-[9px] font-medium",
                          EVENT_TONE[ev.event_type] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
                        )}
                      >
                        {ev.event_type}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[9px]",
                          ACTOR_TONE[ev.actor_type] || ACTOR_TONE.system,
                        )}
                      >
                        {ev.actor_type}
                      </Badge>
                    </div>
                    {summary && (
                      <div className="text-[10px] text-muted-foreground">
                        {summary}
                      </div>
                    )}
                  </div>
                </div>
                {hasPayload && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1 text-[10px]"
                    onClick={() => toggle(ev.id)}
                  >
                    {expanded ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    {expanded ? "Hide" : "Details"}
                  </Button>
                )}
              </div>
              {expanded && (
                <pre className="mt-1.5 text-[9px] font-mono leading-snug bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(ev.payload, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
