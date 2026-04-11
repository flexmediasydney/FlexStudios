import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Check, Clock, MapPin, Link2, Mail, ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { getActivityType, ACTIVITY_TYPE_LIST, getEventSource, canMarkDone } from "./activityConfig";
import EventDetailsDialog from "./EventDetailsDialog";
import { useCurrentUser } from "@/components/auth/PermissionGuard";

export default function EntityActivitiesTab({ entityType, entityId, entityLabel }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [filterType, setFilterType] = useState("all");
  const [showDone, setShowDone] = useState(false);
  const queryClient = useQueryClient();

  const queryKey = ["entity-activities", entityType, entityId];
  const { data: currentUser } = useCurrentUser();
  const currentUserId = currentUser?.id;

  const { data: events = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!entityId) return [];
      const filterMap = {
        project: { project_id: entityId },
        agent:   { agent_id: entityId },
        agency:  { agency_id: entityId },
      };
      const all = await api.entities.CalendarEvent.list("-start_time", 200);
      const f = filterMap[entityType] || {};
      const [key, val] = Object.entries(f)[0] || [];
      return key ? all.filter(e => e[key] === val) : all;
    },
    enabled: !!entityId,
  });

  const filtered = useMemo(() => {
    return events.filter(e => {
      if (!showDone && e.is_done) return false;
      if (filterType !== "all" && e.activity_type !== filterType) return false;
      return true;
    });
  }, [events, filterType, showDone]);

  const upcoming = filtered.filter(e => !e.is_done);
  const done = filtered.filter(e => e.is_done);

  const handleOpen = (event = null) => {
    setEditingEvent(event);
    setDialogOpen(true);
  };

  const handleMarkDone = async (e, ev) => {
    e.stopPropagation();
    // Ownership check: only mark done if this user is allowed to
    if (!canMarkDone(ev, currentUserId)) return;
    await api.entities.CalendarEvent.update(ev.id, {
      is_done: true,
      done_at: new Date().toISOString(),
    });
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
  };

  const defaultProps = {
    project: { defaultProjectId: entityId },
    agent:   { defaultAgentId: entityId },
    agency:  { defaultAgencyId: entityId },
  }[entityType] || {};

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading activities...</div>;

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-3 border-b flex-wrap">
        <Button size="sm" onClick={() => handleOpen(null)}>
          <Plus className="h-4 w-4 mr-1" />
          Schedule Activity
        </Button>

        <div className="flex gap-1 flex-wrap">
          <button
            className={`px-2 py-1 text-xs rounded-full border transition-colors ${filterType === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground'}`}
            onClick={() => setFilterType("all")}
          >
            All
          </button>
          {ACTIVITY_TYPE_LIST.map(({ key, label, color }) => (
            <button
              key={key}
              className="px-2 py-1 text-xs rounded-full border transition-colors cursor-pointer"
              style={filterType === key
                ? { backgroundColor: color, color: 'white', borderColor: color }
                : { borderColor: '#e2e8f0', color: '#64748b' }}
              onClick={() => setFilterType(filterType === key ? "all" : key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={showDone} onCheckedChange={setShowDone} className="h-3.5 w-3.5" />
            Show completed
          </label>
        </div>
      </div>

      {/* Activity list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {upcoming.length === 0 && done.length === 0 && (
          <div className="text-center py-12 text-muted-foreground text-sm">
            <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
            No activities yet
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => handleOpen(null)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Schedule first activity
              </Button>
            </div>
          </div>
        )}

        {upcoming.map(ev => <ActivityRow key={ev.id} event={ev} onClick={() => handleOpen(ev)} onMarkDone={handleMarkDone} />)}

        {showDone && done.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground mb-2 font-medium">Completed ({done.length})</p>
            {done.map(ev => <ActivityRow key={ev.id} event={ev} onClick={() => handleOpen(ev)} done />)}
          </div>
        )}
      </div>

      <EventDetailsDialog
        event={editingEvent}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={() => {
          queryClient.invalidateQueries({ queryKey });
          queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
        }}
        {...defaultProps}
      />
    </div>
  );
}

function ActivityRow({ event, onClick, onMarkDone, done }) {
  const actType = getActivityType(event.activity_type);
  const startDate = event.start_time ? new Date(fixTimestamp(event.start_time)) : null;
  const isOverdue = !done && startDate && startDate < new Date();

  const linkedEmailIds = useMemo(() => {
    try { return JSON.parse(event.email_message_ids || "[]"); } catch { return []; }
  }, [event.email_message_ids]);

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/40 transition-colors ${done ? 'opacity-60' : ''} ${isOverdue ? 'border-red-200 bg-red-50/50' : ''}`}
      onClick={onClick}
    >
      {/* Type indicator */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ backgroundColor: actType.bgColor }}
      >
        <actType.Icon className="h-4 w-4" style={{ color: actType.color }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className={`text-sm font-medium truncate ${done ? 'line-through' : ''}`}>{event.title}</p>
          {isOverdue && <Badge className="bg-red-100 text-red-700 text-xs flex-shrink-0">Overdue</Badge>}
          {done && <Badge className="bg-green-100 text-green-700 text-xs flex-shrink-0">Done</Badge>}
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          {startDate && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {format(startDate, "d MMM, h:mm a")}
            </span>
          )}
          {event.location && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              <span className="truncate max-w-32">{event.location}</span>
            </span>
          )}
          {linkedEmailIds.length > 0 && (
            <span className="flex items-center gap-1">
              <Mail className="h-3 w-3" />
              {linkedEmailIds.length} email{linkedEmailIds.length !== 1 ? 's' : ''}
            </span>
          )}
          {event.project_id && event.activity_type !== 'other' && (
            <span className="flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              Project linked
            </span>
          )}
        </div>

        {event.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{event.description}</p>
        )}
        {done && event.outcome_note && (
          <p className="text-xs text-green-700 mt-1 line-clamp-1">✓ {event.outcome_note}</p>
        )}
      </div>

      {!done && (
        <Button
          size="sm"
          variant="ghost"
          className="flex-shrink-0 h-7 text-xs"
          onClick={e => onMarkDone(e, event)}
          title="Mark as done"
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          Done
        </Button>
      )}
    </div>
  );
}