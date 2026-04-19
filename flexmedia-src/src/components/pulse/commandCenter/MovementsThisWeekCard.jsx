// MovementsThisWeekCard — Industry Pulse Command Center widget.
//
// Stat line + top-5 chronological list of SAFR-detected movement signals:
//   agent_movement (agency change), contact_change (email/mobile/phone),
//   role_change (job_title change). Powered by pulse_get_movements_digest
//   (migration 182). Links each row to the underlying entity slideout; the
//   "View all" affordance navigates to the Signals tab filtered by
//   agent_movement so the operator can action the full backlog.
//
// Standalone by design: parallel Command Center refactors can import it
// without risking merge conflicts with the cockpit layout itself.
//
// NOTE: avoids any JSDoc "*/X" hazard (breaks esbuild — see
// scripts/check-deploy-safety.sh).
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  ArrowRightLeft,
  Briefcase,
  Building2,
  Mail,
  Phone,
  User,
  Users,
  ChevronRight,
  AlertTriangle,
  Inbox,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function truncate(s, n = 40) {
  if (!s) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// Map category → icon for the row avatar.
function categoryIcon(category) {
  switch (category) {
    case "agent_movement":  return Building2;
    case "contact_change":  return Mail;
    case "role_change":     return Briefcase;
    default:                return User;
  }
}

// Compose a human row headline from a digest entry. The trigger shape from
// migration 180 guarantees from_value / to_value / entity_name for most rows,
// but we tolerate partial data so stale / malformed rows still render.
function rowHeadline(row) {
  const name = row.entity_name || "Someone";
  if (row.category === "agent_movement") {
    const to = row.to_value || "a new agency";
    return `${name} moved to ${to}`;
  }
  if (row.category === "role_change") {
    const to = row.to_value || "a new role";
    return `${name} is now ${to}`;
  }
  if (row.category === "contact_change") {
    const field = row.field_name || "contact";
    const fieldLabel = field === "email" ? "email" : field === "mobile" ? "mobile" : field === "phone" ? "phone" : field;
    return `${name}'s ${fieldLabel} updated`;
  }
  return row.title || "Movement detected";
}

// ── Component ────────────────────────────────────────────────────────────────

export default function MovementsThisWeekCard({ onOpenEntity, className }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["pulse_get_movements_digest", 7],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_movements_digest", { p_days: 7 });
      if (error) throw error;
      return data || {};
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
  });

  const agentMoves     = Number(data?.agent_moves_count ?? 0);
  const contactChanges = Number(data?.contact_changes_count ?? 0);
  const roleChanges    = Number(data?.role_changes_count ?? 0);
  const recent         = Array.isArray(data?.recent) ? data.recent.slice(0, 5) : [];

  const total = agentMoves + contactChanges + roleChanges;

  const statLine = (
    <>
      <span className="font-semibold tabular-nums">{agentMoves}</span> agent move{agentMoves === 1 ? "" : "s"}
      <span className="mx-1 text-muted-foreground">·</span>
      <span className="font-semibold tabular-nums">{contactChanges}</span> contact update{contactChanges === 1 ? "" : "s"}
      <span className="mx-1 text-muted-foreground">·</span>
      <span className="font-semibold tabular-nums">{roleChanges}</span> role change{roleChanges === 1 ? "" : "s"}
      <span className="ml-1 text-muted-foreground"> — last 7 days</span>
    </>
  );

  return (
    <Card className={cn("rounded-xl border-0 shadow-sm", className)}>
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-indigo-500" />
              Movements this week
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal tabular-nums">
                {total}
              </Badge>
            </CardTitle>
            <p className="text-[10px] text-muted-foreground truncate">
              SAFR-detected movement signals across agents, contacts and roles
            </p>
          </div>
          <Link
            to="/IndustryPulse?tab=signals&category=agent_movement"
            className="text-[11px] text-primary hover:underline shrink-0 flex items-center gap-0.5"
            title="Open Signals tab filtered by agent_movement"
          >
            View all
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {/* Stat line */}
        <p className="text-[12px] mb-3">
          {isLoading ? <Skeleton className="h-[14px] w-[260px] inline-block align-middle" /> : statLine}
        </p>

        {/* Body: list of recent movements */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[40px] rounded-md" />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-[11px] text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Failed to load movements: {String(error?.message || error)}
          </div>
        ) : recent.length === 0 ? (
          <div className="py-6 text-center">
            <Inbox className="h-7 w-7 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-[12px] font-medium">No movements in the last 7 days</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              SAFR watches agency, contact and role fields — a change will surface here.
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {recent.map((row) => {
              const Icon = categoryIcon(row.category);
              const canOpen = !!(onOpenEntity && row.entity_type && row.entity_id);
              const click = () => {
                if (canOpen) onOpenEntity({ type: row.entity_type, id: row.entity_id });
              };
              return (
                <li key={row.signal_id}>
                  <button
                    type="button"
                    onClick={click}
                    disabled={!canOpen}
                    className={cn(
                      "w-full flex items-start gap-2 py-1.5 px-2 rounded-md text-left transition-colors",
                      canOpen ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
                    )}
                    title={canOpen ? `Open ${row.entity_type}` : undefined}
                  >
                    <div className="shrink-0 mt-0.5 h-6 w-6 rounded-full bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 border border-indigo-200/60 dark:border-indigo-900/40 flex items-center justify-center">
                      <Icon className="h-3 w-3 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] leading-tight">
                        <span className="font-medium">{truncate(rowHeadline(row), 70)}</span>
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {row.from_value ? `from ${truncate(row.from_value, 30)}` : "new value recorded"}
                        <span className="mx-1">·</span>
                        {fmtRelative(row.created_at)}
                      </p>
                    </div>
                    {canOpen && (
                      <ArrowRight className="h-3 w-3 text-muted-foreground/60 shrink-0 mt-1.5" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
