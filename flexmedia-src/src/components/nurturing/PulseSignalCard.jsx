import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import {
  Calendar, ArrowRight, Trophy, TrendingUp, Star,
  MoreHorizontal, Eye, CheckCircle2, XCircle, Pencil,
  Zap, Globe, Building2, User, Newspaper, Search as SearchIcon,
} from "lucide-react";

// ── Level config ─────────────────────────────────────────────────────────────

const LEVEL_CONFIG = {
  industry:     { label: "Industry",     color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300", border: "border-l-purple-500", icon: Globe },
  organisation: { label: "Organisation", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",       border: "border-l-blue-500",   icon: Building2 },
  person:       { label: "Person",       color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",     border: "border-l-green-500",  icon: User },
};

// ── Category config ──────────────────────────────────────────────────────────

const CATEGORY_CONFIG = {
  event:     { label: "Event",     icon: Calendar },
  movement:  { label: "Movement",  icon: ArrowRight },
  milestone: { label: "Milestone", icon: Trophy },
  market:    { label: "Market",    icon: TrendingUp },
  custom:    { label: "Custom",    icon: Star },
};

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  new:          { label: "New",          color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  acknowledged: { label: "Acknowledged", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  actioned:     { label: "Actioned",     color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  dismissed:    { label: "Dismissed",    color: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" },
};

// ── Source type config ───────────────────────────────────────────────────────

const SOURCE_CONFIG = {
  observed:     { label: "Observed",     icon: Eye },
  social_media: { label: "Social Media", icon: Globe },
  news:         { label: "News",         icon: Newspaper },
  manual:       { label: "Manual",       icon: Pencil },
};

export default function PulseSignalCard({
  signal,
  agents = [],
  agencies = [],
  onAction,
  onAcknowledge,
  onDismiss,
}) {
  const level    = (signal.level || "industry").toLowerCase();
  const category = (signal.category || "custom").toLowerCase();
  const status   = (signal.status || "new").toLowerCase();
  const source   = (signal.source_type || "manual").toLowerCase();

  const levelCfg    = LEVEL_CONFIG[level]    || LEVEL_CONFIG.industry;
  const categoryCfg = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.custom;
  const statusCfg   = STATUS_CONFIG[status]  || STATUS_CONFIG.new;
  const sourceCfg   = SOURCE_CONFIG[source]  || SOURCE_CONFIG.manual;

  const CategoryIcon = categoryCfg.icon;
  const SourceIcon   = sourceCfg.icon;

  // ── Resolve linked contacts ────────────────────────────────────────────────
  const linkedContacts = useMemo(() => {
    const contacts = [];
    const agentIds  = signal.linked_agent_ids  || [];
    const agencyIds = signal.linked_agency_ids || [];

    agentIds.forEach((id) => {
      const agent = agents.find((a) => a.id === id);
      if (agent) contacts.push({ id, name: agent.name, type: "agent" });
    });
    agencyIds.forEach((id) => {
      const agency = agencies.find((a) => a.id === id);
      if (agency) contacts.push({ id, name: agency.name, type: "agency" });
    });

    return contacts;
  }, [signal.linked_agent_ids, signal.linked_agency_ids, agents, agencies]);

  // ── Format dates ───────────────────────────────────────────────────────────
  const eventDateStr = useMemo(() => {
    if (!signal.event_date) return null;
    try {
      return format(new Date(signal.event_date), "d MMM yyyy");
    } catch {
      return null;
    }
  }, [signal.event_date]);

  const relativeTime = useMemo(() => {
    if (!signal.created_date && !signal.created_at) return null;
    try {
      return formatDistanceToNow(new Date(signal.created_date || signal.created_at), { addSuffix: true });
    } catch {
      return null;
    }
  }, [signal.created_date, signal.created_at]);

  return (
    <Card
      className={cn(
        "border-l-4 transition-colors hover:bg-accent/30",
        levelCfg.border,
        status === "dismissed" && "opacity-60"
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Category icon */}
          <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <CategoryIcon className="h-4 w-4 text-muted-foreground" />
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            {/* Top row: badges */}
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <Badge variant="secondary" className={cn("text-[10px] font-medium px-1.5 py-0", levelCfg.color)}>
                {levelCfg.label}
              </Badge>
              <Badge variant="secondary" className="text-[10px] font-medium px-1.5 py-0">
                {categoryCfg.label}
              </Badge>
              <Badge variant="secondary" className={cn("text-[10px] font-medium px-1.5 py-0", statusCfg.color)}>
                {statusCfg.label}
              </Badge>
              <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 gap-0.5">
                <SourceIcon className="h-2.5 w-2.5" />
                {sourceCfg.label}
              </Badge>
            </div>

            {/* Title */}
            <h3 className="text-sm font-semibold leading-tight mb-0.5">{signal.title}</h3>

            {/* Description */}
            {signal.description && (
              <p className="text-xs text-muted-foreground leading-relaxed mb-1.5">
                {signal.description}
              </p>
            )}

            {/* Suggested action */}
            {signal.suggested_action && (
              <p className="text-xs italic text-primary/80 mb-1.5 flex items-center gap-1">
                <Zap className="h-3 w-3 flex-shrink-0" />
                {signal.suggested_action}
              </p>
            )}

            {/* Event date */}
            {eventDateStr && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground mb-1.5">
                <Calendar className="h-3 w-3" />
                {eventDateStr}
              </div>
            )}

            {/* Linked contacts */}
            {linkedContacts.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {linkedContacts.map((c) => (
                  <Badge
                    key={c.id}
                    variant="outline"
                    className="text-[10px] font-normal px-1.5 py-0 gap-0.5"
                  >
                    {c.type === "agent" ? (
                      <User className="h-2.5 w-2.5" />
                    ) : (
                      <Building2 className="h-2.5 w-2.5" />
                    )}
                    {c.name}
                  </Badge>
                ))}
              </div>
            )}

            {/* Footer: created by + relative time */}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
              {signal.created_by_name && <span>{signal.created_by_name}</span>}
              {signal.created_by_name && relativeTime && <span>-</span>}
              {relativeTime && <span>{relativeTime}</span>}
            </div>
          </div>

          {/* Right side: action button + menu */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {signal.is_actionable && status !== "actioned" && status !== "dismissed" && (
              <Button
                size="sm"
                className="gap-1 h-7 text-xs"
                onClick={() => onAction?.(signal)}
              >
                <Zap className="h-3 w-3" />
                Action This
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {status !== "acknowledged" && status !== "actioned" && (
                  <DropdownMenuItem onClick={() => onAcknowledge?.(signal)} className="gap-2 text-xs">
                    <Eye className="h-3.5 w-3.5" />
                    Acknowledge
                  </DropdownMenuItem>
                )}
                {status !== "actioned" && (
                  <DropdownMenuItem onClick={() => onAction?.(signal)} className="gap-2 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Mark Actioned
                  </DropdownMenuItem>
                )}
                {status !== "dismissed" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onDismiss?.(signal)} className="gap-2 text-xs text-muted-foreground">
                      <XCircle className="h-3.5 w-3.5" />
                      Dismiss
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
