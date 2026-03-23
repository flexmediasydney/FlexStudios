import { useState, useEffect, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Link2, X, Check, RefreshCw, Clock, ChevronDown } from "lucide-react";
import { utcToSydneyInput, sydneyInputToUtc, fixTimestamp, fmtTimestampCustom, APP_TZ } from "@/components/utils/dateUtils";
import { toast } from "sonner";
import { ACTIVITY_TYPE_LIST, getActivityType, getEventSource, isEventEditable, canMarkDone, getEventExternalUrl, EVENT_SOURCE_CONFIG } from "./activityConfig";
import { ExternalLink } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { createNotificationsForUsers, writeFeedEvent } from "@/components/notifications/createNotification";

const EMPTY_FORM = {
  title: "",
  activity_type: "meeting",
  description: "",
  start_time: "",
  end_time: "",
  location: "",
  is_all_day: false,
  project_id: "",
  agent_id: "",
  agency_id: "",
  owner_user_id: "",
  email_message_ids: "[]",
  outcome_note: "",
  is_done: false,
  color: "",
  recurrence: "none",
  travel_time_minutes: "",
};

export default function EventDetailsDialog({
  event,
  open,
  onClose,
  onSave,
  // Optional pre-fill props — pass when opening from a contact/project page
  defaultProjectId,
  defaultAgentId,
  defaultAgencyId,
  defaultStart,
}) {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Bug fix: Move useCurrentUser to top of component so currentUserId is
  // available in handleSubmit (was defined after handleSubmit, causing undefined)
  const { data: currentUser } = useCurrentUser();
  const currentUserId = currentUser?.id;

  const { data: projects = [] } = useQuery({
    queryKey: ["projects-for-cal"],
    queryFn: () => api.entities.Project.list("-created_date", 200),
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["agents-for-cal"],
    queryFn: () => api.entities.Agent.list("name", 500),
  });

  const { data: agencies = [] } = useQuery({
    queryKey: ["agencies-for-cal"],
    queryFn: () => api.entities.Agency.list("name", 200),
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-for-cal"],
    queryFn: () => api.entities.User.list(),
  });

  const { data: emails = [] } = useQuery({
    queryKey: ["emails-for-cal", formData.project_id, formData.agent_id],
    queryFn: async () => {
      if (!formData.project_id && !formData.agent_id) return [];
      const filters = {};
      if (formData.project_id) filters.project_id = formData.project_id;
      return api.entities.EmailMessage.filter(filters, "-received_at", 50);
    },
    enabled: !!(formData.project_id || formData.agent_id),
  });

  useEffect(() => {
   if (!open) return;
   if (event) {
     setFormData({
       ...EMPTY_FORM,
       title: event.title || "",
       activity_type: event.activity_type || "meeting",
       description: event.description || "",
       start_time: utcToSydneyInput(event.start_time),
       end_time: event.end_time ? utcToSydneyInput(event.end_time) : "",
       location: event.location || "",
       is_all_day: event.is_all_day || false,
       project_id: event.project_id || "",
       agent_id: event.agent_id || "",
       agency_id: event.agency_id || "",
       owner_user_id: event.owner_user_id || "",
       email_message_ids: event.email_message_ids || "[]",
       outcome_note: event.outcome_note || "",
       is_done: event.is_done || false,
       color: event.color || "",
       recurrence: event.recurrence || "none",
       travel_time_minutes: event.travel_time_minutes || "",
     });
   } else {
     const start = defaultStart
       ? utcToSydneyInput(defaultStart)
       : utcToSydneyInput(new Date().toISOString());
     setFormData({
       ...EMPTY_FORM,
       start_time: start,
       project_id: defaultProjectId || "",
       agent_id: defaultAgentId || "",
       agency_id: defaultAgencyId || "",
     });
   }
  }, [event, open, defaultProjectId, defaultAgentId, defaultAgencyId, defaultStart]);

  const selectedEmailIds = useMemo(() => {
    try { return JSON.parse(formData.email_message_ids || "[]"); } catch { return []; }
  }, [formData.email_message_ids]);

  const toggleEmailLink = (emailId) => {
    const current = selectedEmailIds;
    const next = current.includes(emailId)
      ? current.filter(id => id !== emailId)
      : [...current, emailId];
    setFormData(f => ({ ...f, email_message_ids: JSON.stringify(next) }));
  };

  const set = (key, value) => setFormData(f => ({ ...f, [key]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Gap fix: Validate end_time >= start_time
    const start = sydneyInputToUtc(formData.start_time);
    const end = formData.end_time ? sydneyInputToUtc(formData.end_time) : null;
    if (end && end < start) {
      toast.error('End time must be after start time');
      return;
    }
    
    setSaving(true);
    try {
      const source = event?.event_source || 'flexmedia';
      const payload = {
         ...formData,
         start_time: start,
         end_time: end,
         project_id: formData.project_id || null,
         agent_id: formData.agent_id || null,
         agency_id: formData.agency_id || null,
         owner_user_id: formData.owner_user_id || null,
         color: formData.color || null,
         recurrence: formData.recurrence || "none",
         travel_time_minutes: formData.travel_time_minutes ? parseInt(formData.travel_time_minutes, 10) : null,
         event_source: source,
         // Set on create only — never overwrite on update
         ...(!event?.id && currentUserId ? { created_by_user_id: currentUserId } : {}),
       };

      let savedId = event?.id;
      try {
        if (event?.id) {
          await api.entities.CalendarEvent.update(event.id, payload);
        } else {
          const created = await api.entities.CalendarEvent.create(payload);
          savedId = created?.id;
        }
      } catch (saveErr) {
        // Bug fix: show error toast and keep dialog open on save failure
        toast.error('Failed to save event: ' + (saveErr?.message || 'Unknown error'));
        return;
      }

      // Push to Google Calendar if this is a native FlexStudios event
      // and the user has a connected calendar.
      if (source === 'flexmedia' && savedId) {
        try {
          await api.functions.invoke('writeCalendarEventToGoogle', {
            calendar_event_id: savedId,
          });
        } catch (err) {
          console.warn('writeCalendarEventToGoogle failed:', err?.message);
          toast.error('Failed to sync event to Google Calendar. The event was saved locally.');
        }
      }

      // Notify relevant staff about calendar event create/update
      try {
        const isUpdate = !!event?.id;
        const projectId = formData.project_id || null;
        if (projectId) {
          const proj = await api.entities.Project.get(projectId).catch(() => null);
          if (proj) {
            const staffIds = [proj.project_owner_id, proj.photographer_id, proj.onsite_staff_1_id, proj.onsite_staff_2_id].filter(Boolean);
            const projectName = proj.title || proj.property_address || 'Project';
            createNotificationsForUsers(staffIds, {
              type: 'shoot_date_changed',
              title: isUpdate ? `Calendar event updated: ${formData.title}` : `New calendar event: ${formData.title}`,
              message: `${formData.title} on ${projectName}`,
              projectId, projectName,
              entityType: 'calendar_event', entityId: savedId,
              ctaUrl: 'Calendar',
              sourceUserId: currentUserId,
              idempotencyKey: `cal_${isUpdate ? 'upd' : 'new'}:${savedId}:${Date.now()}`,
            }, currentUserId).catch(() => {});
            writeFeedEvent({
              eventType: isUpdate ? 'calendar_event_updated' : 'calendar_event_created',
              category: 'scheduling', severity: 'info',
              actorId: currentUserId, actorName: currentUser?.full_name,
              title: `${isUpdate ? 'Updated' : 'Created'} calendar event: ${formData.title}`,
              projectId, projectName,
              entityType: 'calendar_event', entityId: savedId,
            }).catch(() => {});
          }
        }
      } catch { /* non-critical */ }

      invalidateAll();
      onSave?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleMarkDone = async () => {
    if (!event?.id) return;
    setMarkingDone(true);
    try {
      await api.entities.CalendarEvent.update(event.id, {
        is_done: true,
        done_at: new Date().toISOString(),
        outcome_note: formData.outcome_note,
      });

      // Remove from Google Calendar if this is a FlexStudios event that was pushed
      if (event.google_event_id && getEventSource(event) === 'flexmedia') {
        try {
          await api.functions.invoke('deleteCalendarEventFromGoogle', {
            calendar_event_id: event.id,
          });
        } catch (err) {
          console.warn('deleteCalendarEventFromGoogle failed:', err?.message);
          toast.error('Failed to remove event from Google Calendar.');
        }
      }

      invalidateAll();
      onSave?.();
      onClose();
    } finally {
      setMarkingDone(false);
    }
  };

  const handleDelete = async () => {
    if (!event?.id || deleting || !confirm("Delete this activity?")) return;

    setDeleting(true);
    try {
      // Trigger Google Calendar delete before local delete.
      // Server-side function enforces: only flexmedia events, only the creator.
      try {
        await api.functions.invoke('deleteCalendarEventFromGoogle', {
          calendar_event_id: event.id,
        });
      } catch (err) {
        console.warn('deleteCalendarEventFromGoogle skipped:', err?.message);
        toast.error('Failed to remove event from Google Calendar. Deleting locally.');
      }

      await api.entities.CalendarEvent.delete(event.id);
      invalidateAll();
      onSave?.();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    // Bug fix: also invalidate "calendar-events-team" which is the actual query key
    // used by the Calendar page — without this, the calendar view never refreshes
    queryClient.invalidateQueries({ queryKey: ["calendar-events-team"] });
    queryClient.invalidateQueries({ queryKey: ["entity-activities"] });
  };

  const [rescheduling, setRescheduling] = useState(false);

  const handleReschedule = async (option) => {
    if (!event?.id) return;
    setRescheduling(true);
    try {
      // BUG FIX: use fixTimestamp to ensure timestamps parse as UTC, not local time
      const start = new Date(fixTimestamp(event.start_time));
      const end = event.end_time ? new Date(fixTimestamp(event.end_time)) : null;
      const durationMs = end ? end.getTime() - start.getTime() : 3600000;

      let newStart;
      switch (option) {
        case '+1h':
          newStart = new Date(start.getTime() + 3600000);
          break;
        case '+1d':
          newStart = new Date(start.getTime() + 86400000);
          break;
        case 'next_monday': {
          newStart = new Date(start);
          const day = newStart.getDay();
          const daysUntilMon = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
          newStart.setDate(newStart.getDate() + daysUntilMon);
          break;
        }
        case '+1w':
          newStart = new Date(start.getTime() + 7 * 86400000);
          break;
        default:
          return;
      }

      const newEnd = new Date(newStart.getTime() + durationMs);
      await api.entities.CalendarEvent.update(event.id, {
        start_time: newStart.toISOString(),
        end_time: newEnd.toISOString(),
      });

      // Sync to Google Calendar
      const source = event.event_source || 'flexmedia';
      if (source === 'flexmedia') {
        try {
          await api.functions.invoke('writeCalendarEventToGoogle', {
            calendar_event_id: event.id,
          });
        } catch (err) {
          console.warn('writeCalendarEventToGoogle (reschedule) failed:', err?.message);
        }
      }

      toast.success(`Rescheduled to ${newStart.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
      invalidateAll();
      onSave?.();
      onClose();
    } catch (err) {
      toast.error('Failed to reschedule: ' + (err?.message || 'Unknown error'));
    } finally {
      setRescheduling(false);
    }
  };

  const actType = getActivityType(formData.activity_type);
  const eventSource = getEventSource(event);
  // isEventEditable now checks BOTH source (must be flexmedia) AND ownership
  const editable = !event || isEventEditable(event, currentUserId);
  // canMarkDone: allowed for your own flexmedia events and all tonomo events
  const markDoneAllowed = !event || canMarkDone(event, currentUserId);
  const externalUrl = event ? getEventExternalUrl(event) : null;
  const sourceConfig = EVENT_SOURCE_CONFIG[eventSource];

  // Show a clear "not yours" message when a flexmedia event exists but belongs
  // to someone else — different from the "managed externally" message.
  const isOtherUserEvent = event?.id &&
    eventSource === 'flexmedia' &&
    event.created_by_user_id &&
    event.created_by_user_id !== currentUserId;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" onKeyDown={(e) => {
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (editable) {
            // Trigger native form validation via requestSubmit (unlike handleSubmit directly)
            const form = e.currentTarget.querySelector('form');
            if (form) form.requestSubmit();
          }
        }
      }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap justify-between">
            <span className="flex items-center gap-2">
              <actType.Icon className="h-5 w-5" style={{ color: actType.color }} />
              {event ? (editable ? `Edit ${actType.label}` : actType.label) : `New ${actType.label}`}
              {event?.is_done && <Badge className="bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">✓ Done</Badge>}
            </span>
            {editable && <kbd className="text-[10px] font-normal text-muted-foreground bg-muted px-2 py-1 rounded border">Ctrl+S to save</kbd>}
          </DialogTitle>
          <div className="text-xs text-muted-foreground">
            {event && !editable && sourceConfig?.tooltip}
          </div>
        </DialogHeader>

        <form onSubmit={editable ? handleSubmit : (e) => e.preventDefault()} className="space-y-4">
          {isOtherUserEvent && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
              <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                This activity belongs to another team member and cannot be edited here.
              </p>
            </div>
          )}
          {!editable && !isOtherUserEvent && sourceConfig?.tooltip && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{sourceConfig.tooltip}</p>
              {externalUrl && (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline flex-shrink-0"
                >
                  Open in Google Calendar
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {/* RSVP attendees — shown for Tonomo and Google events */}
          {!editable && event?.attendee_responses && (() => {
            try {
              const responses = JSON.parse(event.attendee_responses);
              const entries = Object.entries(responses);
              if (entries.length === 0) return null;
              const statusConfig = {
                accepted:    { label: 'Accepted',    cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' },
                declined:    { label: 'Declined',    cls: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400' },
                tentative:   { label: 'Tentative',   cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' },
                needsAction: { label: 'No response', cls: 'bg-muted text-muted-foreground' },
              };
              return (
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Attendees</p>
                  <div className="space-y-1.5">
                    {entries.map(([email, status]) => {
                      const cfg = statusConfig[status] || statusConfig.needsAction;
                      const name = event.attendees
                        ? (() => { try { const a = JSON.parse(event.attendees).find(a => a.email === email); return a?.name || email; } catch { return email; } })()
                        : email;
                      return (
                        <div key={email} className="flex items-center justify-between gap-2">
                          <span className="text-sm truncate">{name}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${cfg.cls}`}>
                            {cfg.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            } catch { return null; }
          })()}

          {/* Join Meeting button — shown when conference_link is available */}
          {event?.conference_link && (
            <a
              href={event.conference_link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-all hover:shadow-lg hover:scale-105 active:scale-95"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>
              </svg>
              Join Meeting
            </a>
          )}

          <fieldset disabled={!editable} className="space-y-4 border-0 p-0 m-0">
          {/* Activity type selector */}
          <div>
            <Label>Activity Type</Label>
            <div className="flex gap-2 flex-wrap mt-1">
              {ACTIVITY_TYPE_LIST.map(({ key, label, Icon, color, bgColor }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => set("activity_type", key)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all hover:scale-105 active:scale-95"
                  style={formData.activity_type === key
                    ? { backgroundColor: bgColor, borderColor: color, color, boxShadow: `0 0 0 2px ${color}20` }
                    : { backgroundColor: 'transparent', borderColor: 'var(--border)', color: 'var(--muted-foreground)' }
                  }
                  title={`Set activity type to ${label}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <Label htmlFor="title" className="flex items-center justify-between">
              <span>Title *</span>
              <span className="text-xs text-muted-foreground font-normal tabular-nums">{formData.title.length} / 200</span>
            </Label>
            <Input
              id="title"
              value={formData.title}
              onChange={e => set("title", e.target.value)}
              placeholder={`e.g., ${actType.label} with client`}
              required
              maxLength={200}
              autoFocus
            />
          </div>

          {/* Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="start_time">
                {formData.activity_type === 'deadline' ? 'Due Date *' : 'Start *'}
              </Label>
              <div className="text-xs text-muted-foreground mb-1">Australia/Sydney</div>
              <Input
                id="start_time"
                type={formData.is_all_day ? "date" : "datetime-local"}
                value={formData.start_time}
                onChange={e => set("start_time", e.target.value)}
                required
                title="All times in Australia/Sydney timezone"
              />
            </div>
            {formData.activity_type !== 'deadline' && (
              <div>
                <Label htmlFor="end_time">End</Label>
                <Input
                  id="end_time"
                  type={formData.is_all_day ? "date" : "datetime-local"}
                  value={formData.end_time}
                  onChange={e => set("end_time", e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="all-day"
              checked={formData.is_all_day}
              onCheckedChange={v => set("is_all_day", v)}
            />
            <Label htmlFor="all-day">All day</Label>
          </div>

          {/* Location */}
          <div>
            <Label htmlFor="location">Location</Label>
            <Input
              id="location"
              value={formData.location}
              onChange={e => set("location", e.target.value)}
              placeholder="Address or meeting link"
            />
          </div>

          {/* Travel time buffer */}
          {formData.location && (
            <div>
              <Label htmlFor="travel_time" className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                Travel Buffer (minutes)
              </Label>
              <Input
                id="travel_time"
                type="number"
                min="0"
                max="480"
                value={formData.travel_time_minutes}
                onChange={e => set("travel_time_minutes", e.target.value)}
                placeholder="e.g., 30"
                className="w-32"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">Estimated travel time to this location</p>
            </div>
          )}

          {/* Description */}
          <div>
            <Label htmlFor="description" className="flex items-center justify-between">
              <span>Notes</span>
              <span className="text-xs text-muted-foreground font-normal tabular-nums">{formData.description.length} / 500</span>
            </Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={e => set("description", e.target.value)}
              placeholder="Activity notes..."
              rows={2}
              maxLength={500}
            />
          </div>

          {/* Linkages */}
          <div className="border rounded-lg p-3 space-y-3">
            <p className="text-sm font-medium text-muted-foreground">Link to</p>

            {/* Project — Fix #7 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Project</Label>
                {formData.project_id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => window.location.href = createPageUrl('ProjectDetails') + '?id=' + formData.project_id}
                    title="View project"
                  >
                    <Link2 className="h-3 w-3 mr-1" />
                    View
                  </Button>
                )}
              </div>
              <Select value={formData.project_id || "none"} onValueChange={v => set("project_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select project (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {projects.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Person (Agent) */}
            <div>
              <Label>Person</Label>
              <Select value={formData.agent_id || "none"} onValueChange={v => set("agent_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select person (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No person</SelectItem>
                  {agents.map(a => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Organisation (Agency) */}
            <div>
              <Label>Organisation</Label>
              <Select value={formData.agency_id || "none"} onValueChange={v => set("agency_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select organisation (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No organisation</SelectItem>
                  {agencies.map(a => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Owner */}
            <div>
              <Label>Owner</Label>
              <Select value={formData.owner_user_id || "none"} onValueChange={v => set("owner_user_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Assign to user (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {users.map(u => (
                    <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Email linking — shown when emails are available for the linked project/person */}
          {emails.length > 0 && (
            <div className="border rounded-lg p-3">
              <p className="text-sm font-medium text-muted-foreground mb-2">Linked Emails</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {emails.map(email => (
                  <label
                    key={email.id}
                    className="flex items-start gap-2 cursor-pointer hover:bg-muted/50 rounded p-1"
                  >
                    <Checkbox
                      checked={selectedEmailIds.includes(email.id)}
                      onCheckedChange={() => toggleEmailLink(email.id)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{email.subject || "(no subject)"}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {/* BUG FIX: was appending 'Z' blindly — use fixTimestamp which handles all offset formats */}
                        {email.from_name || email.from} · {email.received_at ? fmtTimestampCustom(email.received_at, { day: '2-digit', month: '2-digit', year: '2-digit' }) : ""}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
              {selectedEmailIds.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">{selectedEmailIds.length} email{selectedEmailIds.length !== 1 ? 's' : ''} linked</p>
              )}
            </div>
          )}
          {/* Recurrence with end date */}
          <div>
            <Label>Repeat</Label>
            <Select value={formData.recurrence} onValueChange={v => set("recurrence", v)}>
              <SelectTrigger>
                <SelectValue placeholder="No repeat" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No repeat</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Set a recurrence end date to prevent infinite repeats</p>
          </div>
          </fieldset>

          {/* Outcome note — always editable even for Tonomo/Google events */}
          {(event?.id || formData.is_done) && (
            <div>
              <Label htmlFor="outcome_note" className="flex items-center justify-between">
                <span>Outcome / Result</span>
                <span className="text-xs text-muted-foreground font-normal tabular-nums">{formData.outcome_note.length} / 500</span>
              </Label>
              <Textarea
                id="outcome_note"
                value={formData.outcome_note}
                onChange={e => set("outcome_note", e.target.value)}
                placeholder="What was the result of this activity?"
                rows={2}
                maxLength={500}
              />
            </div>
          )}

          <DialogFooter className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-2">
              {event?.id && editable && (
                <Button type="button" variant="destructive" size="sm" onClick={handleDelete} disabled={deleting} className="hover:shadow-sm transition-shadow">
                  Delete
                </Button>
              )}
              {event?.id && !event.is_done && markDoneAllowed && (
                <Button type="button" variant="outline" size="sm" onClick={handleMarkDone} disabled={markingDone} className="hover:shadow-sm transition-shadow">
                  {markingDone ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                  Mark Done
                </Button>
              )}
              {event?.id && editable && !event.is_done && (
                <div className="relative group">
                  <Button type="button" variant="outline" size="sm" disabled={rescheduling} className="hover:shadow-sm transition-shadow">
                    {rescheduling ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Clock className="h-4 w-4 mr-1" />}
                    Reschedule
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block group-focus-within:block z-50">
                    <div className="bg-popover border rounded-lg shadow-lg py-1 min-w-[140px]">
                      {[
                        { key: '+1h', label: '+1 Hour' },
                        { key: '+1d', label: '+1 Day' },
                        { key: 'next_monday', label: 'Next Monday' },
                        { key: '+1w', label: '+1 Week' },
                      ].map(opt => (
                        <button
                          key={opt.key}
                          type="button"
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors"
                          onClick={() => handleReschedule(opt.key)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} className="hover:shadow-sm transition-shadow">
                {editable ? "Cancel" : "Close"}
              </Button>
              {editable && (
                <Button type="submit" disabled={saving} className="shadow-sm hover:shadow-md transition-all">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  {event ? "Save Changes" : "Create Activity"}
                </Button>
              )}
              {!editable && externalUrl && (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button type="button" variant="outline" className="hover:shadow-sm transition-shadow">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Edit in Google Calendar
                  </Button>
                </a>
              )}
            </div>
          </DialogFooter>

          </form>
      </DialogContent>
    </Dialog>
  );
}