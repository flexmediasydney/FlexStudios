/**
 * ShortlistingCoverageMap — Wave 6 Phase 6 SHORTLIST
 *                          + W11.6.1-hotfix BUG #2 (Shape D plumbing)
 *                          + W11.6.1-followup (engine-roles eligibility)
 *
 * Visual coverage map for a round.
 *
 * For each eligible slot definition (filtered by the project's resolved
 * engine_roles — see eligibility derivation below), show:
 *   - filled / unfilled (color-coded)
 *   - winner thumbnail (if filled)
 *   - alternatives count (legacy pass2 only — Shape D doesn't surface alts
 *     in shortlisting_overrides; the swimlane's altsBySlotId carries the
 *     per-slot rank-2/3 alternatives separately)
 *   - gap severity if unfilled
 * Mandatory slots highlighted; gaps in red.
 * Coverage % at top.
 *
 * Data source — Shape D plumbing fix (W11.6.1-hotfix):
 *   PRIMARY:   shortlisting_overrides rows where human_action IN
 *              ('ai_proposed','approved_as_proposed','swapped',
 *               'added_from_rejects')
 *              The Shape D engine writes one override row per slot decision
 *              with human_action='ai_proposed'. Operators upgrade to
 *              'approved_as_proposed' / 'swapped' / 'added_from_rejects'
 *              from the swimlane. We resolve the active slot+group from:
 *                slot_id  = human_selected_slot_id ?? ai_proposed_slot_id
 *                group_id = human_selected_group_id ?? ai_proposed_group_id
 *              and record one winner per slot.
 *
 *   FALLBACK:  shortlisting_events rows where event_type IN
 *              ('pass2_slot_assigned','pass2_phase3_recommendation')
 *              Pre-Shape-D rounds (Wave 6 / pass-based engine) don't have
 *              shortlisting_overrides ai_proposed rows. We fall back to
 *              the legacy event-based reader so historical coverage maps
 *              still render. The legacy reader is also the source of the
 *              `alternativesCount` chip (rank=2,3 events).
 *
 *   Both readers map into the same slotState shape:
 *     Map<slot_id, { winner: { groupId }, alts: [{ groupId, payload }...] }>
 *   so the render path is unchanged.
 *
 * Slot eligibility — W11.6.1-followup:
 *   The legacy `s.package_types` filter referenced a column dropped from
 *   `shortlisting_slot_definitions` in mig 339 (Wave 7 P1-6 / W7.7). With
 *   that column gone, every slot's `package_types` is undefined and the
 *   filter silently dropped every slot. The Coverage tab now mirrors the
 *   backend eligibility resolver (`_shared/slotEligibility.ts`):
 *
 *     project (products[] + packages[].products[])
 *       ->  productsById -> distinct, active engine_role values
 *           (`projectEngineRoles`)
 *       ->  slot eligible iff slot.eligible_when_engine_roles overlaps
 *           projectEngineRoles
 *
 *   When the project hasn't been loaded yet (or has no resolvable engine
 *   roles), we fall through to ALL active slots — the swimlane will show
 *   the full taxonomy rather than crashing the tab. A misconfigured slot
 *   (is_active=true with empty eligible_when_engine_roles) is dropped just
 *   like the backend resolver.
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
  // W11.6.1-followup: load the project + product catalog so we can resolve
  // `projectEngineRoles` the same way the backend does (see
  // `_shared/slotEligibility.ts`). Slot eligibility for the Coverage view
  // is driven exclusively by `eligible_when_engine_roles` matching the
  // resolved roles — the legacy `package_types` substring filter was
  // retired with mig 339 and the column no longer exists on slot rows.
  const projectId = round?.project_id || null;

  const projectQuery = useQuery({
    queryKey: ["coverage_project", projectId],
    queryFn: async () => {
      if (!projectId) return null;
      const rows = await api.entities.Project.filter({ id: projectId }, null, 1);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  const productsQuery = useQuery({
    queryKey: ["coverage_products"],
    queryFn: async () => {
      const rows = await api.entities.Product.list("name", 1000);
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 5 * 60_000,
  });

  // Fetch all active slot definitions; we'll filter to this project's
  // resolved engine roles client-side (mirrors backend slotEligibility).
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

  // W11.6.1-hotfix BUG #2 — PRIMARY reader: Shape D writes slot decisions
  // to shortlisting_overrides with human_action='ai_proposed' (and operators
  // upgrade to approved_as_proposed/swapped/added_from_rejects in the
  // swimlane). The map row records ai_proposed_* + the post-action
  // human_selected_*; we resolve to whichever pair has the live values.
  const overridesQuery = useQuery({
    queryKey: ["shortlisting_overrides_coverage", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingOverride.filter(
        {
          round_id: roundId,
          human_action: {
            $in: [
              "ai_proposed",
              "approved_as_proposed",
              "swapped",
              "added_from_rejects",
            ],
          },
        },
        "created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  // W11.6.1-hotfix BUG #2 — FALLBACK reader: pre-Shape-D rounds had pass-2
  // events for slot assignment. We KEEP this reader so historical rounds
  // still render a coverage grid, AND so we can still surface the rank-2/3
  // `alternativesCount` chip (Shape D doesn't store alts on overrides).
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
  const overrides = overridesQuery.data || [];
  const groups = groupsQuery.data || [];

  const groupById = useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  // W11.6.1-hotfix BUG #2 — build slotState from BOTH sources.
  //   1. Shape D `shortlisting_overrides` rows are the PRIMARY source of
  //      truth on Shape D rounds. We resolve the live (slot_id, group_id)
  //      pair as `human_selected_* ?? ai_proposed_*` so swaps land on the
  //      operator's pick rather than the engine's original.
  //   2. Legacy `shortlisting_events` (pass2_*) is the FALLBACK source for
  //      pre-Shape-D rounds. We only fill from events when the override
  //      reader didn't already record a winner for that slot — overrides
  //      win when both readers see the same slot. Events also continue to
  //      feed the `alternativesCount` chip since Shape D doesn't surface
  //      rank-2/3 picks on shortlisting_overrides.
  const slotState = useMemo(() => {
    const m = new Map();

    // PASS 1 — Shape D overrides (primary on modern rounds)
    for (const ov of overrides) {
      const slotId = ov.human_selected_slot_id ?? ov.ai_proposed_slot_id;
      if (!slotId) continue;
      const groupId = ov.human_selected_group_id ?? ov.ai_proposed_group_id;
      if (!groupId) continue;
      if (!m.has(slotId)) m.set(slotId, { winner: null, alts: [] });
      // Most recent override wins (we ordered the query by created_at asc,
      // so just keep overwriting). Swap → human_selected_* takes over from
      // an earlier ai_proposed row for the same slot.
      m.get(slotId).winner = {
        groupId,
        payload: {
          source: "shortlisting_overrides",
          human_action: ov.human_action,
        },
      };
    }

    // PASS 2 — legacy events (fallback for pre-Shape-D rounds; also
    // populates alts for any round that has them).
    for (const ev of events) {
      const slotId = ev.payload?.slot_id;
      if (!slotId) continue;
      if (!m.has(slotId)) m.set(slotId, { winner: null, alts: [] });
      const entry = m.get(slotId);
      if (ev.event_type === "pass2_slot_assigned") {
        const rank = ev.payload?.rank;
        if (rank === 1) {
          // Only set the winner from a legacy event if the override reader
          // didn't already supply one. Override-source-of-truth wins on
          // hybrid rounds.
          if (!entry.winner) {
            entry.winner = { groupId: ev.group_id, payload: ev.payload };
          }
        } else {
          entry.alts.push({ groupId: ev.group_id, payload: ev.payload });
        }
      } else if (ev.event_type === "pass2_phase3_recommendation") {
        if (!entry.winner) {
          entry.winner = { groupId: ev.group_id, payload: ev.payload };
        }
      }
    }
    return m;
  }, [overrides, events]);

  // W11.6.1-followup: derive `projectEngineRoles` from the project's
  // package + à la carte products, mirroring `_shared/slotEligibility.ts`.
  //
  //   project.products[]  + project.packages[].products[]
  //     -> { product_id }[] -> products lookup -> distinct active engine_role values
  //
  // Inactive products are dropped (they're catalog residue and shouldn't
  // drive engine behaviour). Roles outside the known enum are dropped too
  // — the slot match will simply not resolve, the Coverage tab won't crash.
  const project = projectQuery.data || null;
  const products = productsQuery.data || [];
  const productsById = useMemo(() => {
    const m = new Map();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const projectEngineRoles = useMemo(() => {
    if (!project) return [];
    const roles = new Set();
    const collectFromEntries = (entries) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry || typeof entry.product_id !== "string") continue;
        const product = productsById.get(entry.product_id);
        if (!product) continue;
        if (product.is_active !== true) continue;
        if (!product.engine_role) continue;
        roles.add(product.engine_role);
      }
    };
    // À la carte products live on `projects.products`.
    collectFromEntries(project.products);
    // Package-bundled products live on `projects.packages[].products`.
    if (Array.isArray(project.packages)) {
      for (const pkg of project.packages) {
        collectFromEntries(pkg?.products);
      }
    }
    return Array.from(roles);
  }, [project, productsById]);

  // Filter slots to those whose `eligible_when_engine_roles` overlap the
  // project's resolved roles. A slot with `is_active=true` but an
  // empty/null `eligible_when_engine_roles` is misconfigured and dropped
  // (matches the backend resolver's defensive policy).
  //
  // If we couldn't resolve any project engine roles (project not loaded yet,
  // or genuinely no products with engine_role), fall through to ALL active
  // slots so the tab still renders the taxonomy rather than going blank.
  const eligibleSlots = useMemo(() => {
    if (projectEngineRoles.length === 0) {
      // No roles resolved — show every active slot that has any engine_role
      // declaration, so the tab still renders something useful while the
      // project loads (or, defensively, when the project has no shortlist
      // products configured).
      return slots.filter((s) =>
        Array.isArray(s.eligible_when_engine_roles) &&
        s.eligible_when_engine_roles.length > 0,
      );
    }
    const projectRoleSet = new Set(projectEngineRoles);
    return slots.filter((s) => {
      const engineRoles = Array.isArray(s.eligible_when_engine_roles)
        ? s.eligible_when_engine_roles
        : [];
      if (engineRoles.length === 0) return false;
      return engineRoles.some((r) => projectRoleSet.has(r));
    });
  }, [slots, projectEngineRoles]);

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

  if (
    slotsQuery.isLoading ||
    eventsQuery.isLoading ||
    overridesQuery.isLoading ||
    groupsQuery.isLoading ||
    // W11.6.1-followup: also wait for the project + products so we resolve
    // engine roles before filtering — avoids a flicker where the tab first
    // renders the "fall-through to all active slots" set and then narrows.
    projectQuery.isLoading ||
    productsQuery.isLoading
  ) {
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
                          aspectRatio="aspect-[3/2]"
                          alt={winnerGroup.delivery_reference_stem || slot.slot_id}
                        />
                      ) : (
                        <div className="aspect-[3/2] rounded bg-muted/50 flex items-center justify-center text-[10px] text-muted-foreground">
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
