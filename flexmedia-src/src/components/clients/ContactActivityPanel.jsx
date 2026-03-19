import { useState, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  X, Phone, Mail, Video, Pencil, Coffee, Camera, DollarSign,
  Calendar, MessageSquare, FileText, ArrowRight, Clock
} from "lucide-react";
import { formatDistanceToNow, format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

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

/**
 * ContactActivityPanel — shows a combined timeline of interactions, projects, and emails
 * for a given agent. Designed to slide in from the side or render inline.
 *
 * Props:
 *   agent     — the agent object { id, name }
 *   onClose   — callback to dismiss
 */
export default function ContactActivityPanel({ agent, onClose }) {
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

  // Merge into a unified timeline
  const timeline = useMemo(() => {
    const items = [];

    // Add interactions
    interactions.forEach((i) => {
      items.push({
        type: "interaction",
        id: `i-${i.id}`,
        date: i.date_time || i.created_date,
        data: i,
      });
    });

    // Add projects
    projects.forEach((p) => {
      items.push({
        type: "project",
        id: `p-${p.id}`,
        date: p.created_date,
        data: p,
      });
    });

    // Sort descending
    items.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    // Apply filter
    if (filter === "interactions") return items.filter((i) => i.type === "interaction");
    if (filter === "projects") return items.filter((i) => i.type === "project");
    return items;
  }, [interactions, projects, filter]);

  const isLoading = interactionsLoading || projectsLoading;

  if (!agent) return null;

  return (
    <Card className="flex flex-col h-full border-l shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{agent.name}</h3>
          <p className="text-[11px] text-muted-foreground">Activity Timeline</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 px-4 py-2 border-b">
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

      {/* Timeline */}
      <ScrollArea className="flex-1 px-4 py-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array(4)
              .fill(0)
              .map((_, i) => (
                <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
              ))}
          </div>
        ) : timeline.length === 0 ? (
          <div className="text-center py-8">
            <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No activity yet</p>
          </div>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />

            <div className="space-y-1">
              {timeline.map((item, idx) => (
                <TimelineEntry key={item.id} item={item} isLast={idx === timeline.length - 1} />
              ))}
            </div>
          </div>
        )}
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
