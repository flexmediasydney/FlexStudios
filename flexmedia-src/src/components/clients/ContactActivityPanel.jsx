import { useState, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  X, Phone, Mail, Video, Pencil, Coffee, Camera, DollarSign,
  Calendar, MessageSquare, FileText, ArrowRight, Clock,
  ExternalLink, Building2, MapPin, Tag
} from "lucide-react";
import { formatDistanceToNow, format, differenceInDays } from "date-fns";
import { cn } from "@/lib/utils";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { TagList } from "@/components/clients/ContactTags";
import QuickLogInteraction from "@/components/clients/QuickLogInteraction";

const INTERACTION_ICONS = {
  "Phone Call": Phone,
  "Email Sent": Mail,
  "Email Received": Mail,
  "Meeting": Video,
  "Note Added": Pencil,
  "LinkedIn Message": Coffee,
  "Status Change": ArrowRight,
};

const INTERACTION_COLORS = {
  "Phone Call": "bg-green-100 text-green-700 border-green-200",
  "Email Sent": "bg-blue-100 text-blue-700 border-blue-200",
  "Email Received": "bg-blue-50 text-blue-600 border-blue-100",
  "Meeting": "bg-purple-100 text-purple-700 border-purple-200",
  "Note Added": "bg-amber-100 text-amber-700 border-amber-200",
  "LinkedIn Message": "bg-cyan-100 text-cyan-700 border-cyan-200",
  "Status Change": "bg-gray-100 text-gray-700 border-gray-200",
};

const SENTIMENT_DOT = {
  Positive: "bg-green-500",
  Neutral: "bg-gray-400",
  Negative: "bg-red-500",
};

const STATE_STYLES = {
  Active:          "bg-emerald-50 text-emerald-700 border-emerald-200",
  Prospecting:     "bg-blue-50 text-blue-700 border-blue-200",
  Dormant:         "bg-gray-50 text-gray-500 border-gray-200",
  "Do Not Contact":"bg-red-50 text-red-600 border-red-200",
};

/**
 * ContactActivityPanel - Pipedrive-style contact detail sidebar.
 * Three sections: Contact info card, Quick actions, Activity timeline.
 */
export default function ContactActivityPanel({ agent, onClose }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");

  const { data: interactions = [], loading: interactionsLoading } = useEntityList(
    agent ? "InteractionLog" : null,
    "-date_time",
    50,
    agent ? (item) => item.entity_id === agent.id && item.entity_type === "Agent" : null
  );

  const { data: projects = [], loading: projectsLoading } = useEntityList(
    agent ? "Project" : null,
    "-created_date",
    20,
    agent ? (item) => item.agent_id === agent.id : null
  );

  // Merge into unified timeline
  const timeline = useMemo(() => {
    const items = [];
    interactions.forEach((i) => {
      items.push({ type: "interaction", id: `i-${i.id}`, date: i.date_time || i.created_date, data: i });
    });
    projects.forEach((p) => {
      items.push({ type: "project", id: `p-${p.id}`, date: p.created_date, data: p });
    });
    items.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });
    if (filter === "interactions") return items.filter((i) => i.type === "interaction");
    if (filter === "projects") return items.filter((i) => i.type === "project");
    return items;
  }, [interactions, projects, filter]);

  // Compute summary
  const totalRevenue = useMemo(() =>
    projects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0),
    [projects]
  );

  const lastContactInfo = useMemo(() => {
    const lc = agent?.last_contacted_at;
    if (!lc) return { label: "Never contacted", color: "text-muted-foreground", isIdle: true };
    const days = differenceInDays(new Date(), new Date(lc));
    let color = "text-emerald-600";
    if (days > 60) color = "text-red-600";
    else if (days > 30) color = "text-amber-600";
    else if (days > 14) color = "text-blue-600";
    return {
      label: `${days === 0 ? "Today" : days === 1 ? "Yesterday" : formatDistanceToNow(new Date(lc), { addSuffix: true })}`,
      color,
      isIdle: days > 30,
    };
  }, [agent]);

  const isLoading = interactionsLoading || projectsLoading;
  const initials = (agent?.name || "?").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();

  if (!agent) return null;

  return (
    <Card className="flex flex-col h-full border-l shadow-lg bg-card">
      {/* ── Header with close button ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/20">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Contact Details</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {/* ── Contact info card ── */}
        <div className="px-4 py-4 border-b">
          <div className="flex items-start gap-3 mb-3">
            {/* Avatar */}
            <div className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold shrink-0",
              lastContactInfo.isIdle
                ? "bg-amber-100 text-amber-700 ring-2 ring-amber-200"
                : "bg-primary/10 text-primary"
            )}>
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold truncate">{agent.name}</h3>
              {agent.title && (
                <p className="text-xs text-muted-foreground truncate">{agent.title}</p>
              )}
              {agent.current_agency_name && (
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors mt-0.5"
                  onClick={() => navigate(createPageUrl("OrgDetails") + "?id=" + agent.current_agency_id)}
                >
                  <Building2 className="h-3 w-3" />
                  {agent.current_agency_name}
                </button>
              )}
            </div>
          </div>

          {/* Status + tags */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {agent.relationship_state && (
              <span className={cn(
                "text-[11px] font-medium px-2 py-0.5 rounded-full border",
                STATE_STYLES[agent.relationship_state] || "bg-muted"
              )}>
                {agent.relationship_state}
              </span>
            )}
            {Array.isArray(agent.tags) && agent.tags.length > 0 && (
              <TagList tags={agent.tags} max={3} size="xs" />
            )}
          </div>

          {/* Contact info rows */}
          <div className="space-y-1.5 mb-3">
            {agent.email && (
              <a href={`mailto:${agent.email}`} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors">
                <Mail className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <span className="truncate">{agent.email}</span>
              </a>
            )}
            {agent.phone && (
              <a href={`tel:${agent.phone}`} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-emerald-600 transition-colors">
                <Phone className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span>{agent.phone}</span>
              </a>
            )}
            <div className={cn("flex items-center gap-2 text-xs", lastContactInfo.color)}>
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span>Last contact: {lastContactInfo.label}</span>
              {lastContactInfo.isIdle && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              )}
            </div>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t">
            <div className="text-center">
              <p className="text-lg font-bold tabular-nums">{projects.length}</p>
              <p className="text-[10px] text-muted-foreground">Projects</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold tabular-nums">
                {totalRevenue >= 1000 ? `$${(totalRevenue / 1000).toFixed(1)}k` : `$${totalRevenue}`}
              </p>
              <p className="text-[10px] text-muted-foreground">Revenue</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold tabular-nums">{interactions.length}</p>
              <p className="text-[10px] text-muted-foreground">Activities</p>
            </div>
          </div>
        </div>

        {/* ── Quick actions ── */}
        <div className="px-4 py-3 border-b">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Quick Actions</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {agent.email && (
              <a href={`mailto:${agent.email}`}>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                  <Mail className="h-3 w-3 text-blue-500" />Email
                </Button>
              </a>
            )}
            {agent.phone && (
              <a href={`tel:${agent.phone}`}>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                  <Phone className="h-3 w-3 text-emerald-500" />Call
                </Button>
              </a>
            )}
            <QuickLogInteraction agent={agent} triggerSize="sm" />
            <Button
              variant="outline" size="sm" className="h-7 text-xs gap-1.5"
              onClick={() => navigate(createPageUrl("PersonDetails") + "?id=" + agent.id)}
            >
              <ExternalLink className="h-3 w-3" />Full Profile
            </Button>
          </div>
        </div>

        {/* ── Timeline ── */}
        <div className="px-4 py-3">
          {/* Filter tabs */}
          <div className="flex items-center gap-1 mb-3">
            {[
              { id: "all", label: "All" },
              { id: "interactions", label: "Interactions" },
              { id: "projects", label: "Projects" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors",
                  filter === f.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {f.label}
              </button>
            ))}
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {timeline.length}
            </Badge>
          </div>

          {/* Timeline content */}
          {isLoading ? (
            <div className="space-y-3">
              {Array(4).fill(0).map((_, i) => (
                <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
              ))}
            </div>
          ) : timeline.length === 0 ? (
            <div className="text-center py-8">
              <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No activity recorded yet</p>
            </div>
          ) : (
            <div className="relative">
              <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />
              <div className="space-y-1">
                {timeline.map((item) => (
                  <TimelineEntry key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}

function TimelineEntry({ item }) {
  if (item.type === "interaction") {
    const i = item.data;
    const Icon = INTERACTION_ICONS[i.interaction_type] || MessageSquare;
    const colorClass = INTERACTION_COLORS[i.interaction_type] || "bg-gray-100 text-gray-600 border-gray-200";

    return (
      <div className="relative flex gap-3 py-2 pl-1">
        <div className={cn("relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", colorClass)}>
          <Icon className="h-3 w-3" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium truncate">{i.summary || i.interaction_type}</span>
            {i.sentiment && i.sentiment !== "Neutral" && (
              <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", SENTIMENT_DOT[i.sentiment])} />
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {i.date_time ? formatDistanceToNow(new Date(i.date_time), { addSuffix: true }) : "Unknown"}
            {i.user_name ? ` by ${i.user_name}` : ""}
          </p>
        </div>
      </div>
    );
  }

  if (item.type === "project") {
    const p = item.data;
    return (
      <Link
        to={createPageUrl(`ProjectDetails?id=${p.id}`)}
        className="relative flex gap-3 py-2 pl-1 hover:bg-muted/50 rounded-md transition-colors"
      >
        <div className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-indigo-100 text-indigo-700 border-indigo-200">
          <Camera className="h-3 w-3" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-[11px] font-medium truncate">{p.title || "Untitled project"}</p>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{p.status?.replace(/_/g, " ")}</span>
            {p.price != null && <span>${p.price.toLocaleString()}</span>}
            <span>{p.created_date ? formatDistanceToNow(new Date(p.created_date), { addSuffix: true }) : ""}</span>
          </div>
        </div>
      </Link>
    );
  }

  return null;
}
