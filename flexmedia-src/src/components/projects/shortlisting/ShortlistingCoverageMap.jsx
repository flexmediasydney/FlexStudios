/**
 * ShortlistingCoverageMap — Wave 6 Phase 6 SHORTLIST
 *
 * Visual coverage map for a round.
 *
 * For each active slot definition (filtered by round.package_type), show:
 *   - filled / unfilled (color-coded)
 *   - winner thumbnail (if filled)
 *   - alternatives count (rank=2,3 events)
 *   - gap severity if unfilled
 * Mandatory slots highlighted; gaps in red.
 * Coverage % at top.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { cn } from "@/lib/utils";

const PHASE_LABEL = { 1: "Mandatory", 2: "Conditional", 3: "AI Free" };
const PHASE_TONE = {
  1: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  2: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  3: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
};

export default function ShortlistingCoverageMap({ roundId, round }) {
  // Fetch all active slot definitions; we'll filter to this round's package
  // client-side (matches the spec's permissive package_types semantics).
  const slotsQuery = useQuery({
    queryKey: ["shortlisting_slot_definitions_active"],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingSlotDefinition.filter(
        { is_active: true },
        "phase",
        500,
      );
      return rows || [];
    },
    staleTime: 60_000,
  });

  // Pass 2 winner events (rank=1) for the round.
  const eventsQuery = useQuery({
    queryKey: ["shortlisting_events_coverage", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingEvent.filter(
        {
          round_id: roundId,
          event_type: { $in: ["pass2_slot_assigned", "pass2_phase3_recommendation"] },
        },
        "created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const groupsQuery = useQuery({
    queryKey: ["composition_groups", roundId],
    queryFn: async () => {
      const rows = await api.entities.CompositionGroup.filter(
        { round_id: roundId },
        "group_index",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const slots = slotsQuery.data || [];
  const events = eventsQuery.data || [];
  const groups = groupsQuery.data || [];

  const groupById = useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  // Group events by slot_id; track winners (rank=1) + alternatives (rank>=2).
  const slotState = useMemo(() => {
    const m = new Map();
    for (const ev of events) {
      const slotId = ev.payload?.slot_id;
      if (!slotId) continue;
      if (!m.has(slotId)) m.set(slotId, { winner: null, alts: [] });
      const entry = m.get(slotId);
      if (ev.event_type === "pass2_slot_assigned") {
        const rank = ev.payload?.rank;
        if (rank === 1) {
          entry.winner = { groupId: ev.group_id, payload: ev.payload };
        } else {
          entry.alts.push({ groupId: ev.group_id, payload: ev.payload });
        }
      } else if (ev.event_type === "pass2_phase3_recommendation") {
        entry.winner = { groupId: ev.group_id, payload: ev.payload };
      }
    }
    return m;
  }, [events]);

  // Filter slots to this round's package (or treat empty as universal).
  const pkg = round?.package_type;
  const eligibleSlots = useMemo(() => {
    return slots.filter((s) => {
      const types = s.package_types || [];
      if (types.length === 0) return true;
      if (!pkg) return true;
      return types.includes(pkg);
    });
  }, [slots, pkg]);

  // Coverage stats: phase 1 + 2 only (phase 3 is AI free, not gap-able).
  const stats = useMemo(() => {
    const phase12 = eligibleSlots.filter((s) => s.phase === 1 || s.phase === 2);
    const filled = phase12.filter((s) => slotState.has(s.slot_id)).length;
    const total = phase12.length;
    const mandatory = eligibleSlots.filter((s) => s.phase === 1);
    const mandatoryFilled = mandatory.filter((s) => slotState.has(s.slot_id)).length;
    return {
      filled,
      total,
      pct: total > 0 ? Math.round((filled / total) * 100) : 0,
      mandatoryFilled,
      mandatoryTotal: mandatory.length,
    };
  }, [eligibleSlots, slotState]);

  if (slotsQuery.isLoading || eventsQuery.isLoading || groupsQuery.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-12 bg-muted rounded" />
        <div className="h-48 bg-muted rounded" />
      </div>
    );
  }

  if (eligibleSlots.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No slot definitions configured yet. The admin slot editor (Phase 7)
          will let you define the three-phase slot taxonomy. Until then, only
          AI free recommendations (phase 3) drive proposals — no coverage
          gaps to surface.
        </CardContent>
      </Card>
    );
  }

  // Group slots by phase
  const slotsByPhase = { 1: [], 2: [], 3: [] };
  for (const s of eligibleSlots) {
    if (slotsByPhase[s.phase]) slotsByPhase[s.phase].push(s);
  }

  return (
    <div className="space-y-3">
      {/* Coverage summary */}
      <Card>
        <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-xs text-muted-foreground">Coverage</div>
            <div className="text-sm font-medium">
              {stats.filled} / {stats.total} slots filled ({stats.pct}%)
            </div>
          </div>
          <div className="border-l h-8" />
          <div>
            <div className="text-xs text-muted-foreground">Mandatory</div>
            <div className="text-sm font-medium tabular-nums">
              {stats.mandatoryFilled} / {stats.mandatoryTotal}
            </div>
          </div>
          {stats.mandatoryFilled < stats.mandatoryTotal && (
            <Badge variant="outline" className="border-rose-400 text-rose-700 dark:text-rose-300">
              <AlertCircle className="h-3 w-3 mr-1" />
              {stats.mandatoryTotal - stats.mandatoryFilled} mandatory gap
              {stats.mandatoryTotal - stats.mandatoryFilled === 1 ? "" : "s"}
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Phases */}
      {[1, 2, 3].map((phase) => {
        const list = slotsByPhase[phase];
        if (!list || list.length === 0) return null;
        return (
          <Card key={phase}>
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Badge className={cn("text-[10px]", PHASE_TONE[phase])}>
                  Phase {phase}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {PHASE_LABEL[phase]}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {list.map((slot) => {
                  const state = slotState.get(slot.slot_id);
                  const filled = !!state?.winner;
                  const winnerGroup = filled
                    ? groupById.get(state.winner.groupId)
                    : null;
                  const isMandatory = slot.phase === 1;
                  const altsCount = state?.alts?.length || 0;
                  return (
                    <div
                      key={slot.slot_id}
                      className={cn(
                        "rounded-md border p-2 space-y-1",
                        filled
                          ? "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900"
                          : isMandatory
                            ? "border-rose-300 bg-rose-50/50 dark:bg-rose-950/20 dark:border-rose-900"
                            : "border-amber-200 bg-amber-50/30 dark:bg-amber-950/10 dark:border-amber-900",
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <div className="text-[11px] font-medium truncate" title={slot.display_name}>
                          {slot.display_name}
                        </div>
                        {filled ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                        ) : isMandatory ? (
                          <AlertCircle className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400 flex-shrink-0" />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                        )}
                      </div>
                      <div className="text-[9px] font-mono text-muted-foreground truncate">
                        {slot.slot_id}
                      </div>
                      {filled && winnerGroup ? (
                        <DroneThumbnail
                          dropboxPath={winnerGroup.dropbox_preview_path}
                          mode="thumb"
                          aspectRatio="aspect-[4/3]"
                          alt={winnerGroup.delivery_reference_stem || slot.slot_id}
                        />
                      ) : (
                        <div className="aspect-[4/3] rounded bg-muted/50 flex items-center justify-center text-[10px] text-muted-foreground">
                          {isMandatory ? "GAP — required" : "Not filled"}
                        </div>
                      )}
                      {altsCount > 0 && (
                        <div className="text-[9px] text-muted-foreground">
                          {altsCount} alt{altsCount === 1 ? "" : "s"}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
