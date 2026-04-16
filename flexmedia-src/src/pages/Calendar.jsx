import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "@/components/ui/tooltip";
import {
  ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon,
  Users, RefreshCw, Search, AlertTriangle, Clock, X,
  Camera, Coffee, Globe, Building2, MapPin, CheckSquare
} from "lucide-react";
import { cn } from "@/lib/utils";
import { expandRecurringEvent } from "@/components/calendar/CalendarEventUtils";
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  isSameMonth, isSameDay, isToday, differenceInMinutes, startOfDay
} from "date-fns";
import { fixTimestamp, getSydneyHourMinute, fmtSydneyTime, fmtTimestampCustom, APP_TZ } from "@/components/utils/dateUtils";
import { getActivityType, ACTIVITY_TYPE_LIST, getEventSource, EVENT_SOURCE_CONFIG } from "@/components/calendar/activityConfig";
import EventDetailsDialog from "@/components/calendar/EventDetailsDialog";
import CalendarIntegration from "@/components/calendar/CalendarIntegration";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { usePermissions } from '@/components/auth/PermissionGuard';

// ── Constants ─────────────────────────────────────────────────────────────────
const VIEWS = ['month', 'week', 'day'];
// Business hours (8am-9pm) get full height, off-hours are compressed
const BUSINESS_START = 8;  // 8am
const BUSINESS_END = 21;   // 9pm
const SLOT_HEIGHT_BUSINESS = 64; // px per business hour
const SLOT_HEIGHT_OFF = 20;      // px per off-hour (compressed)
const getSlotHeight = (hour) => (hour >= BUSINESS_START && hour < BUSINESS_END) ? SLOT_HEIGHT_BUSINESS : SLOT_HEIGHT_OFF;
const getSlotTop = (hour) => {
  let top = 0;
  for (let h = 0; h < hour; h++) top += getSlotHeight(h);
  return top;
};
const TOTAL_DAY_HEIGHT = (() => { let t = 0; for (let h = 0; h < 24; h++) t += getSlotHeight(h); return t; })();
// Convert total minutes-from-midnight to pixel position (variable-height aware)
function minutesToPx(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  return getSlotTop(hour) + (min / 60) * getSlotHeight(hour);
}

// Event type color coding: shoots=blue, meetings=green, personal=gray
const EVENT_TYPE_COLORS = {
  shoot:    { bg: '#3b82f6', light: '#eff6ff', text: '#1d4ed8', border: '#3b82f6' },
  meeting:  { bg: '#10b981', light: '#ecfdf5', text: '#065f46', border: '#10b981' },
  call:     { bg: '#10b981', light: '#ecfdf5', text: '#065f46', border: '#10b981' },
  personal: { bg: '#6b7280', light: '#f9fafb', text: '#374151', border: '#6b7280' },
  task:     { bg: '#8b5cf6', light: '#f5f3ff', text: '#6d28d9', border: '#8b5cf6' },
  deadline: { bg: '#ef4444', light: '#fef2f2', text: '#991b1b', border: '#ef4444' },
  email:    { bg: '#f59e0b', light: '#fffbeb', text: '#92400e', border: '#f59e0b' },
  lunch:    { bg: '#ec4899', light: '#fdf2f8', text: '#be185d', border: '#ec4899' },
  other:    { bg: '#6b7280', light: '#f9fafb', text: '#374151', border: '#6b7280' },
};

function getEventTypeColor(event) {
  if (!event) return EVENT_TYPE_COLORS.other;
  // Tonomo bookings / shoots
  if (event.event_source === 'tonomo' || event.tonomo_appointment_id || event.link_source === 'tonomo_webhook') {
    return EVENT_TYPE_COLORS.shoot;
  }
  // Activity type mapping
  const aType = event.activity_type;
  if (aType && EVENT_TYPE_COLORS[aType]) return EVENT_TYPE_COLORS[aType];
  // Fallback: if title contains shoot/photo keywords, treat as shoot
  const title = (event.title || '').toLowerCase();
  if (title.includes('shoot') || title.includes('photo') || title.includes('session') || title.includes('booking')) {
    return EVENT_TYPE_COLORS.shoot;
  }
  if (title.includes('meeting') || title.includes('call') || title.includes('standup') || title.includes('huddle')) {
    return EVENT_TYPE_COLORS.meeting;
  }
  if (title.includes('lunch') || title.includes('personal') || title.includes('break') || title.includes('gym')) {
    return EVENT_TYPE_COLORS.personal;
  }
  return EVENT_TYPE_COLORS.other;
}

const PERSON_COLORS = [
  { bg: '#3b82f6', light: '#eff6ff', text: '#1d4ed8', border: '#93c5fd' },
  { bg: '#f97316', light: '#fff7ed', text: '#c2410c', border: '#fdba74' },
  { bg: '#8b5cf6', light: '#f5f3ff', text: '#6d28d9', border: '#c4b5fd' },
  { bg: '#10b981', light: '#ecfdf5', text: '#065f46', border: '#6ee7b7' },
  { bg: '#ec4899', light: '#fdf2f8', text: '#be185d', border: '#f9a8d4' },
  { bg: '#f59e0b', light: '#fffbeb', text: '#92400e', border: '#fcd34d' },
];

const BUSINESS_CALENDAR_ID = 'business-calendar';
const BUSINESS_CALENDAR_COLOR = { bg: '#0891b2', light: '#ecfeff', text: '#155e75', border: '#67e8f9' };

function hashStringToIndex(str, max) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % max;
}

function getInitials(name = '') {
  return name.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}

// Reusable current-time indicator line with pulse dot and time label
function CurrentTimeIndicator({ topPx, showLabel = true }) {
  const now = new Date();
  const label = fmtSydneyTime(now.toISOString(), { hour: 'numeric', minute: '2-digit', hour12: false });
  return (
    <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center" style={{ top: topPx }}>
      <div className="relative -ml-1.5 flex-shrink-0">
        <div className="w-3 h-3 rounded-full bg-red-500 shadow-sm" />
        <div className="absolute inset-0 w-3 h-3 rounded-full bg-red-500 animate-ping opacity-40" />
      </div>
      <div className="flex-1 h-[2px] bg-red-500/80" />
      {showLabel && (
        <span className="text-[9px] font-mono font-semibold text-red-600 bg-red-50 border border-red-200 rounded px-1 py-0 ml-0.5 flex-shrink-0 leading-tight">
          {label}
        </span>
      )}
    </div>
  );
}

// Rich tooltip wrapper for event cards — shows full details on hover
function EventTooltipContent({ event, owners, users, userColorMap }) {
  const typeColor = getEventTypeColor(event);
  const source = getEventSource(event);
  const sourceConfig = EVENT_SOURCE_CONFIG[source];
  const startStr = event.start_time ? fmtSydneyTime(event.start_time, { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const endStr = event.end_time ? fmtSydneyTime(event.end_time, { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const ownerNames = owners
    .map(uid => users?.find(u => u.id === uid))
    .filter(Boolean)
    .map(u => u._isBusiness ? 'FlexMedia' : u.full_name || u.email);

  // Task-specific tooltip
  if (event._isTask) {
    return (
      <div className="max-w-[280px] space-y-1.5">
        <div className="flex items-start gap-2">
          <div className="w-1 h-full rounded-full flex-shrink-0 self-stretch bg-violet-500" />
          <div className="min-w-0">
            <p className="font-semibold text-sm leading-tight">{event._isCompleted ? '✓ ' : ''}{event.title?.split(' | ')[0] || 'Task'}</p>
            {event._projectTitle && (
              <p className="text-xs text-blue-300 mt-0.5 underline decoration-dotted">
                {event._projectTitle}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-0.5">
          {event._assigneeName && (
            <p className="text-xs opacity-80 flex items-center gap-1">
              {event._assigneeType === 'team' ? <Users className="h-3 w-3" /> : <Camera className="h-3 w-3" />}
              {event._assigneeName}
              {event._assigneeType === 'team' && <span className="text-[9px] px-1 rounded bg-indigo-500/30 text-indigo-200">Team</span>}
            </p>
          )}
          {event._autoAssignRole && (
            <p className="text-[10px] opacity-60">Role: {event._autoAssignRole.replace(/_/g, ' ')}</p>
          )}
          {event._estimatedMinutes > 0 && (
            <p className="text-[10px] opacity-60">Est: {event._estimatedMinutes}min</p>
          )}
          <p className="text-[10px] font-medium" style={{ color: event._isCompleted ? '#4ade80' : event._isBlocked ? '#fb923c' : '#60a5fa' }}>
            {event._statusLabel}
          </p>
        </div>
        {startStr && (
          <p className="text-xs opacity-70 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Due: {startStr}
          </p>
        )}
        <p className="text-[10px] opacity-40">Click to view project tasks</p>
      </div>
    );
  }

  return (
    <div className="max-w-[260px] space-y-1.5">
      <div className="flex items-start gap-2">
        <div className="w-1 h-full rounded-full flex-shrink-0 self-stretch" style={{ backgroundColor: typeColor.border }} />
        <div className="min-w-0">
          <p className="font-semibold text-sm leading-tight">{event.title || 'Untitled'}</p>
          {startStr && (
            <p className="text-xs opacity-80 mt-0.5 flex items-center gap-1">
              <Clock className="h-3 w-3 flex-shrink-0" />
              {startStr}{endStr ? ` - ${endStr}` : ''}
            </p>
          )}
        </div>
      </div>
      {event.location && (
        <p className="text-xs opacity-80 flex items-center gap-1">
          <MapPin className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{event.location}</span>
        </p>
      )}
      {ownerNames.length > 0 && (
        <p className="text-xs opacity-70">
          {ownerNames.join(', ')}
        </p>
      )}
      {sourceConfig?.tooltip && (
        <p className="text-[10px] opacity-50">{sourceConfig.tooltip}</p>
      )}
      {event.travel_time_minutes > 0 && (
        <p className="text-[10px] opacity-60">{event.travel_time_minutes}min travel time</p>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
function CalendarSkeleton({ view }) {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="flex items-center gap-2 text-muted-foreground mb-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span className="text-sm font-medium">Loading calendar events...</span>
      </div>
      {view === 'month' ? (
        <div className="grid grid-cols-7 gap-px w-full px-4">
          {Array.from({ length: 35 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-md" />
          ))}
        </div>
      ) : (
        <div className="flex gap-px w-full px-4">
          {Array.from({ length: view === 'week' ? 7 : 1 }).map((_, i) => (
            <div key={i} className="flex-1 space-y-1">
              {Array.from({ length: 14 }).map((_, j) => (
                <Skeleton key={j} className={cn("rounded-sm", j >= 8 && j <= 12 ? "h-10" : "h-4")} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CalendarPage() {
  const { user: permUser } = usePermissions();
  
  const [view, setViewRaw] = useState(() => {
    // Persist calendar view across navigation
    try {
      const saved = localStorage.getItem('flex-calendar-view');
      if (saved && VIEWS.includes(saved)) return saved;
    } catch { /* ignore */ }
    if (typeof window !== 'undefined' && window.innerWidth < 768) return 'day';
    return 'week';
  });
  const setView = useCallback((v) => {
    setViewRaw(v);
    try { localStorage.setItem('flex-calendar-view', v); } catch { /* ignore */ }
  }, []);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [filterType, setFilterType] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [selectedUserIds, setSelectedUserIds] = useState(["all"]);
  const [showConnections, setShowConnections] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [defaultStart, setDefaultStart] = useState(null);
  const queryClient = useQueryClient();

  const EVENT_FILTERS = [
    { id: 'shoots', label: 'Shoots', icon: Camera },
    { id: 'meetings', label: 'Meetings', icon: Users },
    { id: 'tasks', label: 'Tasks', icon: CheckSquare },
    { id: 'personal', label: 'Personal', icon: Coffee },
    { id: 'google', label: 'Google', icon: Globe },
  ];

  const toggleFilter = useCallback((id) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Countdown to next DB refresh (60s) and next Google sync (5min).
  // Combined into a single interval to halve the per-second state updates.
  const [dbCountdown, setDbCountdown] = useState(60);
  const [syncCountdown, setSyncCountdown] = useState(300);
  const countdownRef = useRef(null);

  useEffect(() => {
    countdownRef.current = setInterval(() => {
      setDbCountdown(s => s <= 1 ? 60 : s - 1);
      setSyncCountdown(s => s <= 1 ? 300 : s - 1);
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, []);

  const formatCountdown = (s) => s >= 60
    ? `${Math.floor(s / 60)}m ${s % 60}s`
    : `${s}s`;

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: currentUser } = useQuery({
    queryKey: ["current-user"],
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-for-cal"],
    queryFn: () => api.entities.User.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: connections = [] } = useQuery({
    queryKey: ["calendar-connections-all"],
    queryFn: () => api.entities.CalendarConnection.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: allAvailability = [] } = useQuery({
    queryKey: ['photographer-availability-cal'],
    queryFn: () => api.entities.PhotographerAvailability.list(),
    staleTime: 5 * 60 * 1000,
  });

  // Build user list with synthetic business calendar entry at the top
  const calendarUsers = useMemo(() => {
    const businessEntry = { id: BUSINESS_CALENDAR_ID, full_name: 'FlexMedia', email: 'info@flexmedia.sydney', _isBusiness: true };
    return [businessEntry, ...users];
  }, [users]);

  // Gap fix: Load only visible month range + max 500 events (not 5000). Gap fix: Add debouncing on sync.
  const [lastManualSync, setLastManualSync] = useState(0);
  const syncDebounceMs = 3000;
  
  const { data: rawEvents = [], isFetching: eventsFetching, isLoading: eventsLoading } = useQuery({
    queryKey: ["calendar-events-team", view, format(currentDate, 'yyyy-MM')],
    queryFn: async () => {
      // Gap fix: Fetch only visible range + 1 month buffer, max 500 events (not 5000)
      const rangeStart = subMonths(startOfDay(currentDate), 1);
      const rangeEnd = addMonths(startOfDay(currentDate), 2);
      const all = await api.entities.CalendarEvent.filter({
        start_time: {
          $gte: rangeStart.toISOString(),
          $lte: rangeEnd.toISOString(),
        }
      }, "-start_time", 500);
      return all || [];
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  // ── Tasks with due dates → virtual calendar events ──
  const queryClient2 = useQueryClient();
  const { data: tasksWithDueDates = [] } = useQuery({
    queryKey: ["calendar-tasks", format(currentDate, 'yyyy-MM')],
    queryFn: async () => {
      // Scope to visible date range (same as calendar events)
      const rangeStart = subMonths(startOfDay(currentDate), 1);
      const rangeEnd = addMonths(startOfDay(currentDate), 2);
      const [tasks, allProjects] = await Promise.all([
        api.entities.ProjectTask.filter({}, null, 2000),
        api.entities.Project.filter({}, null, 500),
      ]);
      const archivedProjectIds = new Set(allProjects.filter(p => p.is_archived || p.status === 'cancelled').map(p => p.id));
      return (tasks || []).filter(t =>
        t.due_date && !t.is_deleted && !archivedProjectIds.has(t.project_id) &&
        t.due_date >= rangeStart.toISOString() &&
        t.due_date <= rangeEnd.toISOString()
      );
    },
    staleTime: 15 * 1000, // Refresh every 15s for near-real-time
    refetchInterval: 30 * 1000, // Auto-refetch every 30s
  });

  // Real-time subscription: refetch when tasks change (create/complete/delete)
  useEffect(() => {
    const unsub = api.entities.ProjectTask.subscribe((event) => {
      queryClient2.invalidateQueries({ queryKey: ["calendar-tasks"] });
    });
    return typeof unsub === 'function' ? unsub : undefined;
  }, [queryClient2]);

  // Build project lookup for task enrichment
  const { data: allProjects = [] } = useQuery({
    queryKey: ["calendar-projects-lookup"],
    queryFn: () => api.entities.Project.filter({}, null, 500),
    staleTime: 120 * 1000,
    enabled: tasksWithDueDates.length > 0,
  });
  const projectMap = useMemo(() => new Map(allProjects.map(p => [p.id, p])), [allProjects]);

  const taskEvents = useMemo(() => {
    return tasksWithDueDates.map(task => {
      const proj = projectMap.get(task.project_id);
      const projectLabel = proj?.title || proj?.property_address || '';
      const assigneeName = task.assigned_to_name || task.assigned_to_team_name || '';
      const assigneeType = task.assigned_to_team_id ? 'team' : 'user';
      const statusLabel = task.is_completed ? 'Completed' : task.is_blocked ? 'Blocked' : 'In Progress';

      return {
        id: `task:${task.id}`,
        title: projectLabel ? `${task.title} | ${projectLabel}` : task.title,
        start_time: task.due_date,
        end_time: task.due_date,
        activity_type: 'task',
        event_source: 'flexmedia',
        _isTask: true,
        _taskId: task.id,
        _projectId: task.project_id,
        _projectTitle: projectLabel,
        _isCompleted: task.is_completed,
        _isBlocked: task.is_blocked,
        _statusLabel: statusLabel,
        _assigneeName: assigneeName,
        _assigneeType: assigneeType,
        _estimatedMinutes: task.estimated_minutes,
        _autoAssignRole: task.auto_assign_role,
        owner_user_id: task.assigned_to || task.assigned_to_team_id || null,
        location: projectLabel,
        description: `${statusLabel} · ${assigneeName || 'Unassigned'}${task.estimated_minutes ? ` · Est: ${task.estimated_minutes}min` : ''}`,
      };
    });
  }, [tasksWithDueDates, projectMap]);

  // ── User → colour map ── (hash-based for stable colours regardless of user order)
  const userIdKey = users.map(u => u.id).join(',');
  const userColorMap = useMemo(() => {
    const map = new Map();
    map.set(BUSINESS_CALENDAR_ID, BUSINESS_CALENDAR_COLOR);
    for (const user of users) {
      const idx = hashStringToIndex(user.id, PERSON_COLORS.length);
      map.set(user.id, PERSON_COLORS[idx]);
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIdKey]);

  // ── User → their calendar account emails ──────────────────────────────────
  const userAccountMap = useMemo(() => {
    const map = new Map(); // userId -> Set of account_email strings
    users.forEach(u => {
      const userConns = connections.filter(c => c.created_by === u.email);
      map.set(u.id, new Set(userConns.map(c => c.account_email)));
    });
    return map;
  }, [users, connections]);

  // ── Assign each event to its owner(s) ─────────────────────────────────────
  // Returns map of userId -> CalendarEvent[]
  const eventsByUser = useMemo(() => {
    const map = new Map();
    map.set(BUSINESS_CALENDAR_ID, []);
    users.forEach(u => map.set(u.id, []));

    for (const ev of rawEvents) {
      const owners = new Set();

      // Business calendar: info@ account or Tonomo events
      if (ev.calendar_account === 'info@flexmedia.sydney' || ev.event_source === 'tonomo') {
        owners.add(BUSINESS_CALENDAR_ID);
      }

      // Primary: owner_user_id
      if (ev.owner_user_id && map.has(ev.owner_user_id)) {
        owners.add(ev.owner_user_id);
      }

      // Secondary: calendar_account matches user's connections
      if (ev.calendar_account) {
        for (const [userId, emails] of userAccountMap.entries()) {
          if (emails.has(ev.calendar_account)) owners.add(userId);
        }
      }

      // Fallback: attendees email match
      if (owners.size === 0 && ev.attendees) {
        try {
          const atts = typeof ev.attendees === 'string' ? JSON.parse(ev.attendees) : ev.attendees;
          if (Array.isArray(atts)) {
            for (const att of atts) {
              const matched = users.find(u => u.email === att.email);
              if (matched) owners.add(matched.id);
            }
          }
        } catch { /* ignore */ }
      }

      // Last resort: if no owner found, assign to the first user so events still render
      if (owners.size === 0 && users.length > 0) {
        owners.add(users[0].id);
      }

      for (const uid of owners) {
        if (map.has(uid)) map.get(uid).push(ev);
      }
    }

    return map;
  }, [rawEvents, users, userAccountMap]);

  // Expand recurring events with max instance limit (Gap fix: prevent infinite expansion)
  const expandedEvents = useMemo(() => {
    const rangeStart = subMonths(startOfDay(currentDate), 1);
    const rangeEnd = addMonths(startOfDay(currentDate), 2);
    const MAX_RECURRING_INSTANCES = 52; // Cap recurring expansions
    const result = [];
    for (const item of rawEvents) {
      // Only expand FlexStudios-native recurring events (daily/weekly/monthly).
      // Google/Tonomo events are already expanded by their respective APIs
      // (singleEvents=true in full sync), so re-expanding them would duplicate events.
      const isFlexRecurring = item.recurrence && item.recurrence !== 'none' &&
        item.recurrence !== 'recurring' &&
        (item.event_source === 'flexmedia' || !item.event_source);
      if (isFlexRecurring) {
        try {
          const instances = expandRecurringEvent(item, rangeStart, rangeEnd);
          result.push(...instances.slice(0, MAX_RECURRING_INSTANCES));
        } catch {
          result.push(item);
        }
      } else {
        result.push(item);
      }
    }
    return result;
  }, [rawEvents, currentDate]);

  // ── Deduplication for team view ────────────────────────────────────────────
  // Returns { event, owners: userId[] }[]
  const deduplicatedEvents = useMemo(() => {
    const seen = new Map(); // google_event_id -> { event, owners }
    const result = [];

    for (const ev of expandedEvents) {
      // Find all owners of this event
      const owners = [];
      for (const [uid, evs] of eventsByUser.entries()) {
        if (evs.some(e => e.id === ev.id)) owners.push(uid);
      }

      if (ev.google_event_id) {
        if (seen.has(ev.google_event_id)) {
          // Merge owners into existing entry
          const existing = seen.get(ev.google_event_id);
          for (const uid of owners) {
            if (!existing.owners.includes(uid)) existing.owners.push(uid);
          }
        } else {
          const entry = { event: ev, owners };
          seen.set(ev.google_event_id, entry);
          result.push(entry);
        }
      } else {
        // No google_event_id — deduplicate by event.id
        const dedupKey = `local_${ev.id}`;
        if (seen.has(dedupKey)) {
          const existing = seen.get(dedupKey);
          for (const uid of owners) {
            if (!existing.owners.includes(uid)) existing.owners.push(uid);
          }
        } else {
          const entry = { event: ev, owners };
          seen.set(dedupKey, entry);
          result.push(entry);
        }
      }
    }

    // Merge task events into the deduplicated list
    for (const taskEv of taskEvents) {
      const owners = taskEv.owner_user_id ? [taskEv.owner_user_id] : [];
      result.push({ event: taskEv, owners });
    }

    return result;
  }, [expandedEvents, eventsByUser, taskEvents]);

  // ── Conflict detection: find overlapping events for the same owner ────────
  const conflictSet = useMemo(() => {
    const ids = new Set();
    // Group events by owner
    const byOwner = new Map();
    for (const { event, owners } of deduplicatedEvents) {
      if (!event.start_time || event.is_all_day) continue;
      for (const uid of owners) {
        if (!byOwner.has(uid)) byOwner.set(uid, []);
        byOwner.get(uid).push(event);
      }
    }
    // For each owner, find overlapping pairs
    for (const [, ownerEvents] of byOwner) {
      const sorted = ownerEvents
        .filter(e => e.start_time)
        .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
      for (let i = 0; i < sorted.length; i++) {
        const aStart = new Date(sorted[i].start_time);
        const aEnd = sorted[i].end_time
          ? new Date(sorted[i].end_time)
          : new Date(aStart.getTime() + 3600000);
        for (let j = i + 1; j < sorted.length; j++) {
          const bStart = new Date(sorted[j].start_time);
          if (bStart >= aEnd) break; // no more overlaps possible
          // Overlap found
          ids.add(sorted[i].id);
          ids.add(sorted[j].id);
        }
      }
    }
    return ids;
  }, [deduplicatedEvents]);

  // ── Active team members (who to show lanes for) ───────────────────────────
  const activeUsers = useMemo(() => {
    if (selectedUserIds.includes("all")) return calendarUsers;
    return calendarUsers.filter(u => selectedUserIds.includes(u.id));
  }, [calendarUsers, selectedUserIds]);

  // ── Filter events for current view ────────────────────────────────────────
  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return deduplicatedEvents.filter(({ event, owners }) => {
      if (filterType !== "all" && event.activity_type !== filterType) return false;

      if (q) {
        const inTitle    = event.title?.toLowerCase().includes(q);
        const inLocation = event.location?.toLowerCase().includes(q);
        const inDesc     = event.description?.toLowerCase().includes(q);
        if (!inTitle && !inLocation && !inDesc) return false;
      }

      // Filter chips: if any active, only show matching events. If none active, show all.
      if (activeFilters.size > 0) {
        const passesFilter = (ev) => {
          if (activeFilters.has('shoots') && (ev.activity_type === 'shoot' || ev.event_source === 'tonomo')) return true;
          if (activeFilters.has('meetings') && ev.activity_type === 'meeting') return true;
          if (activeFilters.has('tasks') && (ev.activity_type === 'task' || ev.activity_type === 'deadline' || ev._isTask)) return true;
          if (activeFilters.has('personal') && ['lunch', 'personal', 'other'].includes(ev.activity_type)) return true;
          if (activeFilters.has('google') && ev.event_source === 'google') return true;
          return false;
        };
        if (!passesFilter(event)) return false;
      }

      if (selectedUserIds.includes("all")) return true;
      // Must belong to at least one selected user
      return owners.some(uid => selectedUserIds.includes(uid));
    });
  }, [deduplicatedEvents, filterType, activeFilters, selectedUserIds, searchQuery]);

  // ── Person selector handlers ───────────────────────────────────────────────
  const handlePersonClick = useCallback((userId, evt) => {
    if (userId === "all") {
      setSelectedUserIds(["all"]);
      return;
    }
    if (evt?.metaKey || evt?.ctrlKey) {
      // Multi-select toggle
      setSelectedUserIds(prev => {
        const withoutAll = prev.filter(id => id !== "all");
        if (withoutAll.includes(userId)) {
          const next = withoutAll.filter(id => id !== userId);
          return next.length === 0 ? ["all"] : next;
        }
        return [...withoutAll, userId];
      });
    } else {
      // Single select
      setSelectedUserIds([userId]);
    }
  }, []);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const navigate = useCallback((dir) => {
    if (view === "month") setCurrentDate(d => dir > 0 ? addMonths(d, 1) : subMonths(d, 1));
    else if (view === "week") setCurrentDate(d => dir > 0 ? addWeeks(d, 1) : subWeeks(d, 1));
    else setCurrentDate(d => dir > 0 ? addDays(d, 1) : subDays(d, 1));
  }, [view]);

  const headerLabel = () => {
    if (view === "month") return format(currentDate, "MMMM yyyy");
    if (view === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "d MMM")} – ${format(end, "d MMM yyyy")}`;
    }
    return format(currentDate, "EEEE, d MMMM yyyy");
  };

  // Gap fix: Scroll to current hour on "Today" click
  // BUG FIX: Use requestAnimationFrame so the DOM has re-rendered with the new
  // date before we try to find and scroll to the hour element.
  const handleTodayClick = useCallback(() => {
    setCurrentDate(new Date());
    requestAnimationFrame(() => {
      const now = new Date();
      const hourElement = document.querySelector(`[data-hour="${now.getHours()}"]`);
      if (hourElement) {
        hourElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, []);

  // Single-click on empty cell: no action (avoids accidental dialog opens)
  const handleCellClick = useCallback((date, userId = null) => {
    // Intentionally no-op on single click to prevent accidental creation.
    // Use double-click or the "+ New" button to create events.
  }, []);

  const handleCellDoubleClick = useCallback((date, userId = null) => {
    // Double-click: open dialog pre-filled with clicked time slot
    const d = new Date(date);
    d.setSeconds(0, 0);
    setDefaultStart(d.toISOString());
    setEditingEvent(null);
    setDialogOpen(true);
  }, []);

  const handleEventClick = useCallback((e, event) => {
    e.stopPropagation();
    // Task events → navigate to project details tasks tab
    if (event._isTask && event._projectId) {
      window.location.href = `/ProjectDetails?id=${event._projectId}&tab=tasks`;
      return;
    }
    setEditingEvent(event);
    setDefaultStart(null);
    setDialogOpen(true);
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
      // Don't trigger when dialog is open
      if (dialogOpen) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          navigate(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          navigate(1);
          break;
        case 't':
        case 'T':
          e.preventDefault();
          handleTodayClick();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          setView('month');
          break;
        case 'w':
        case 'W':
          e.preventDefault();
          setView('week');
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          setView('day');
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, handleTodayClick, dialogOpen, setView]);

  // Ref for the calendar grid scroll container — used for auto-scroll to current time
  const calendarGridRef = useRef(null);

  // Auto-scroll to current time on initial load (week/day views)
  useEffect(() => {
    if (view === 'month' || eventsLoading) return;
    // Small delay to let the DOM render before scrolling
    const timer = setTimeout(() => {
      const container = calendarGridRef.current;
      if (!container) return;
      const now = new Date();
      const targetHour = Math.max(0, now.getHours() - 1); // scroll to 1hr before current
      const scrollTarget = getSlotTop(targetHour);
      container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  // Only run on initial mount and view changes, not every date nav
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, eventsLoading]);

  // Are we in lane mode?
  const isLaneMode = view !== "month" &&
    (selectedUserIds.includes("all") || selectedUserIds.length > 1);

  const laneUsers = isLaneMode ? activeUsers : [];

  // Compute event counts per filter chip for badges
  const filterCounts = useMemo(() => {
    const counts = { shoots: 0, meetings: 0, tasks: 0, personal: 0, google: 0 };
    for (const { event } of deduplicatedEvents) {
      if (event.activity_type === 'shoot' || event.event_source === 'tonomo') counts.shoots++;
      if (event.activity_type === 'meeting') counts.meetings++;
      if (event.activity_type === 'task' || event.activity_type === 'deadline' || event._isTask) counts.tasks++;
      if (['lunch', 'personal', 'other'].includes(event.activity_type)) counts.personal++;
      if (event.event_source === 'google') counts.google++;
    }
    return counts;
  }, [deduplicatedEvents]);

  return (
    <TooltipProvider delayDuration={300}>
    <div className="h-full flex flex-col bg-background">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col border-b">
        {/* Top bar */}
        <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-2 sm:py-3 flex-wrap">
          {/* Navigation */}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => navigate(-1)} className="hover:shadow-sm transition-all duration-200 h-9 w-9" title="Previous period" aria-label="Previous period">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={handleTodayClick} className="hover:shadow-sm transition-all duration-200 h-9" title="Jump to today and scroll to current hour">
              Today
            </Button>
            <Button variant="outline" size="icon" onClick={() => navigate(1)} className="hover:shadow-sm transition-all duration-200 h-9 w-9" title="Next period" aria-label="Next period">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <h1 className="text-sm sm:text-lg font-semibold min-w-0 sm:min-w-[200px] truncate flex items-center gap-2">
            {headerLabel()}
            {isToday(currentDate) && view === 'day' && (
              <span className="text-[10px] font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-full">Today</span>
            )}
          </h1>

          {/* Filter chips */}
          <div className="hidden sm:flex items-center gap-1.5">
            {EVENT_FILTERS.map(f => {
              const active = activeFilters.has(f.id);
              const Icon = f.icon;
              const count = filterCounts[f.id] || 0;
              return (
                <button
                  key={f.id}
                  onClick={() => toggleFilter(f.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200",
                    active
                      ? "bg-primary text-primary-foreground border-primary shadow-md scale-[1.02]"
                      : "bg-background text-muted-foreground border-border hover:border-primary/40 hover:bg-muted/60 hover:shadow-sm"
                  )}
                  title={`${active ? 'Hide' : 'Show'} ${f.label.toLowerCase()} (${count})`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">{f.label}</span>
                  {count > 0 && (
                    <span className={cn(
                      "min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center",
                      active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                    )}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Refresh button with rate limiting */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                // Gap fix: Add rate limiting to prevent spam syncs
                const now = Date.now();
                if (now - lastManualSync < syncDebounceMs) {
                  toast.error(`Please wait ${Math.ceil((syncDebounceMs - (now - lastManualSync)) / 1000)}s before syncing again`);
                  return;
                }
                setLastManualSync(now);
                queryClient.invalidateQueries({ queryKey: ["calendar-events-team"] });
              }}
              title="Refresh calendar events (rate-limited to 1 per 3 seconds)"
              aria-label="Refresh calendar events"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all duration-200 hover:bg-muted ${
                eventsFetching ? "text-blue-500 border-blue-200 bg-blue-50" : "text-muted-foreground border-border"
              }`}
            >
              <RefreshCw className={`h-3 w-3 ${eventsFetching ? "animate-spin" : ""}`} />
              {eventsFetching ? "Syncing…" : "Sync"}
            </button>
          </div>

          <div className="flex gap-1 ml-auto">
            {VIEWS.map(v => (
              <Button key={v} size="sm"
                variant={view === v ? "default" : "ghost"}
                onClick={() => setView(v)}
                className="capitalize transition-all duration-200 h-9"
                title={`Switch to ${v} view`}
                aria-label={`${v} view`}
              >
                {v}
              </Button>
            ))}
          </div>

          {/* Search */}
           <div className="relative hidden sm:block" title="Search highlights matching text in results">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery(''); }}
              placeholder="Search events…"
              className="h-9 pl-8 pr-8 rounded-md border bg-background text-sm w-44 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 transition-all duration-150 hover:border-primary/50"
            />
           {searchQuery && (
               <button
                 onClick={() => setSearchQuery("")}
                 className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-0.5 transition-colors duration-150"
                 title="Clear search (Esc)"
                 aria-label="Clear search"
                 >
                 <X className="h-3.5 w-3.5" />
               </button>
           )}
          </div>

          {/* Type filter */}
           <Select value={filterType} onValueChange={setFilterType}>
             <SelectTrigger className="w-24 sm:w-32 h-9 text-sm">
               <SelectValue placeholder="All types" />
             </SelectTrigger>
             <SelectContent>
               <SelectItem value="all">All types</SelectItem>
               {ACTIVITY_TYPE_LIST.map(({ key, label }) => (
                 <SelectItem key={key} value={key}>{label}</SelectItem>
               ))}
             </SelectContent>
           </Select>

           <Button size="sm" onClick={() => { 
             const now = new Date();
             setDefaultStart(now.toISOString());
             setEditingEvent(null); 
             setDialogOpen(true); 
           }} className="shadow-sm hover:shadow-md transition-all duration-200 h-9" title="Create new event" aria-label="Create new calendar event">
            <Plus className="h-4 w-4 mr-1" /> New
           </Button>

          <Button size="sm" variant="outline" onClick={() => setShowConnections(v => !v)} className="relative h-9 transition-all duration-200" aria-label="Manage calendar connections">
            <CalendarIcon className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Connections</span>
            {eventsFetching && <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse" />}
          </Button>

          {/* Keyboard shortcut hints */}
          <div className="hidden lg:flex items-center gap-1 text-[10px] text-muted-foreground/50 ml-1" title="Keyboard shortcuts: Arrow keys to navigate, T for today, M/W/D for view modes">
            <kbd className="px-1 py-0.5 rounded border bg-muted/50 font-mono">&larr;&rarr;</kbd>
            <kbd className="px-1 py-0.5 rounded border bg-muted/50 font-mono">T</kbd>
            <kbd className="px-1 py-0.5 rounded border bg-muted/50 font-mono">M</kbd>
            <kbd className="px-1 py-0.5 rounded border bg-muted/50 font-mono">W</kbd>
            <kbd className="px-1 py-0.5 rounded border bg-muted/50 font-mono">D</kbd>
          </div>
        </div>

        {/* Color legend */}
        <div className="hidden sm:flex items-center gap-3 px-4 py-1.5 text-[10px] text-muted-foreground border-t bg-muted/10">
          <span className="font-medium mr-0.5">Legend:</span>
          {[
            { label: 'Shoots', color: '#3b82f6' },
            { label: 'Meetings', color: '#10b981' },
            { label: 'Tasks', color: '#8b5cf6' },
            { label: 'Deadlines', color: '#ef4444' },
            { label: 'Personal', color: '#6b7280' },
          ].map(item => (
            <span key={item.label} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </div>

        {/* Person selector row */}
        <div className="flex items-center gap-2 px-2 sm:px-4 py-2 border-t bg-muted/20 overflow-x-auto scrollbar-none flex-nowrap sm:flex-wrap">
          <span className="text-xs text-muted-foreground font-medium mr-1">Team:</span>

          {/* All */}
          <button
            onClick={(e) => handlePersonClick("all", e)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 hover:scale-105 ${
              selectedUserIds.includes("all")
                ? "bg-foreground text-background border-foreground shadow-md"
                : "bg-background border-border text-muted-foreground hover:border-muted-foreground hover:shadow-sm"
            }`}
            title="Show all team members"
          >
            <Users className="h-3 w-3" />
            All
          </button>

          {/* Individual members (including business calendar) */}
          {calendarUsers.map(u => {
            const color = userColorMap.get(u.id);
            const isSelected = selectedUserIds.includes(u.id);
            const isBiz = u._isBusiness;
            return (
              <button
                key={u.id}
                onClick={(e) => handlePersonClick(u.id, e)}
                title={`${isSelected ? "Deselect" : "Select"} ${u.full_name} (Ctrl/Cmd+click for multi-select)`}
                aria-label={`${isSelected ? "Deselect" : "Select"} ${u.full_name}`}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 hover:scale-105 ${
                  isSelected
                    ? "border-current shadow-md"
                    : "bg-background border-border text-muted-foreground hover:border-muted-foreground hover:shadow-sm"
                }`}
                style={isSelected ? {
                  backgroundColor: color?.light,
                  color: color?.text,
                  borderColor: color?.bg,
                } : {}}
              >
                {isBiz ? (
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-white flex-shrink-0"
                    style={{ backgroundColor: color?.bg }}
                  >
                    <Building2 className="h-2.5 w-2.5" />
                  </span>
                ) : (
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0"
                    style={{ backgroundColor: color?.bg }}
                  >
                    {getInitials(u.full_name || u.email)}
                  </span>
                )}
                {u.full_name?.split(' ')[0] || u.email}
              </button>
            );
          })}

          {!selectedUserIds.includes("all") && selectedUserIds.length > 1 && (
            <span className="text-xs text-muted-foreground ml-1">
              · {selectedUserIds.length} selected · Ctrl/Cmd+click to toggle
            </span>
          )}
        </div>
      </div>

      {showConnections && (
        <div className="p-4 border-b bg-muted/30">
          <ErrorBoundary fallbackLabel="Calendar Integration" compact>
            <CalendarIntegration
              onConnectionsChange={(conns) => {
                if (conns.length > 0) queryClient.invalidateQueries({ queryKey: ["calendar-events-team"] });
              }}
            />
          </ErrorBoundary>
        </div>
      )}

      {eventsFetching && !eventsLoading && (
        <div className="h-1 w-full bg-muted overflow-hidden">
          <div className="h-full bg-primary/60 animate-pulse rounded-r-full" style={{ width: '40%', animation: 'pulse 1.5s ease-in-out infinite' }} />
        </div>
      )}

      {/* ── Calendar grid ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0" ref={calendarGridRef}>
        {eventsLoading ? (
          <CalendarSkeleton view={view} />
        ) : (
        <ErrorBoundary fallbackLabel="Calendar View">
        {view === "month" && (
          <MonthView
            currentDate={currentDate}
            events={filteredEvents}
            users={calendarUsers}
            userColorMap={userColorMap}
            isLaneMode={false}
            conflictSet={conflictSet}
            onCellClick={handleCellClick}
            onCellDoubleClick={handleCellDoubleClick}
            onEventClick={handleEventClick}
          />
        )}
        {view === "week" && (
          <TeamWeekView
            currentDate={currentDate}
            events={filteredEvents}
            users={activeUsers}
            userColorMap={userColorMap}
            isLaneMode={isLaneMode}
            allAvailability={allAvailability}
            currentUserId={currentUser?.id}
            conflictSet={conflictSet}
            onCellClick={handleCellClick}
            onCellDoubleClick={handleCellDoubleClick}
            onEventClick={handleEventClick}
          />
        )}
        {view === "day" && (
          <TeamDayView
            currentDate={currentDate}
            events={filteredEvents}
            users={activeUsers}
            userColorMap={userColorMap}
            isLaneMode={isLaneMode}
            allAvailability={allAvailability}
            currentUserId={currentUser?.id}
            conflictSet={conflictSet}
            onCellClick={handleCellClick}
            onCellDoubleClick={handleCellDoubleClick}
            onEventClick={handleEventClick}
          />
        )}
        </ErrorBoundary>
        )}
      </div>

      <EventDetailsDialog
        event={editingEvent}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        defaultStart={defaultStart}
        onSave={() => queryClient.invalidateQueries({ queryKey: ["calendar-events-team"] })}
      />
    </div>
    </TooltipProvider>
  );
}

// ── MONTH VIEW ────────────────────────────────────────────────────────────────
// Month view doesn't use lanes — shows all events with owner colour dots

function MonthView({ currentDate, events, users, userColorMap, conflictSet, onCellClick, onCellDoubleClick, onEventClick }) {
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const days = [];
  let day = gridStart;
  while (day <= gridEnd) { days.push(day); day = addDays(day, 1); }

  const eventsForDay = (d) => events.filter(({ event }) => {
    if (!event.start_time) return false;
    return isSameDay(new Date(fixTimestamp(event.start_time)), d);
  });

  return (
    <div className="h-full flex flex-col">
    <div className="grid grid-cols-7 border-b bg-muted/20">
      {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
        <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground/80">{d}</div>
      ))}
    </div>
      <div className="flex-1 grid grid-cols-7 grid-rows-[repeat(6,1fr)]">
        {days.map((d, i) => {
          const dayItems = eventsForDay(d);
          const isCurrentMonth = isSameMonth(d, currentDate);
          return (
            <div
              key={i}
              className={`border-r border-b p-0.5 sm:p-1 cursor-pointer hover:bg-muted/30 transition-all hover:shadow-inner min-h-[60px] sm:min-h-[90px] ${!isCurrentMonth ? 'bg-muted/10' : ''}`}
              onDoubleClick={() => onCellDoubleClick(d)}
              onClick={() => onCellClick(d)}
              title={`Double-click to create event on ${format(d, 'EEEE, d MMMM yyyy')}`}
            >
              <div className={`text-sm mb-1 ${!isCurrentMonth ? 'text-muted-foreground' : ''}`}>
                <span className={isToday(d) ? 'bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center mx-auto text-xs font-bold shadow-sm' : 'text-xs pl-0.5'}>
                  {format(d, 'd')}
                </span>
              </div>
              <div className="space-y-0.5">
                {dayItems.slice(0, 3).map(({ event, owners }) => (
                  <Tooltip key={event.id}>
                    <TooltipTrigger asChild>
                      <div>
                        <MonthEventPill
                          event={event}
                          owners={owners}
                          userColorMap={userColorMap}
                          users={users}
                          hasConflict={conflictSet.has(event.id)}
                          onClick={(e) => onEventClick(e, event)}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="bg-popover text-popover-foreground border shadow-lg p-2.5">
                      <EventTooltipContent event={event} owners={owners} users={users} userColorMap={userColorMap} />
                    </TooltipContent>
                  </Tooltip>
                ))}
                {dayItems.length > 3 && (
                  <div
                    className="text-xs text-muted-foreground pl-1 cursor-pointer hover:text-foreground transition-colors"
                    title={dayItems.slice(3).map(({ event }) => event.title || 'Untitled').join(', ')}
                  >+{dayItems.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthEventPill({ event, owners, userColorMap, users, onClick, title, hasConflict }) {
   const typeColor = getEventTypeColor(event);
   const source = getEventSource(event);
   const sourceConfig = EVENT_SOURCE_CONFIG[source];
   const isOverdue = !event.is_done &&
     event.end_time &&
     new Date(fixTimestamp(event.end_time)) < new Date() &&
     source === 'flexmedia';

   // BUG FIX: was using date-fns format() which uses local machine timezone, not Sydney.
   const startTime = event.start_time ? fmtSydneyTime(event.start_time, { hour: 'numeric', minute: '2-digit', hour12: false }) : '';

   return (
     <div
       className="rounded text-[11px] leading-tight px-1.5 py-0.5 cursor-pointer hover:opacity-80 hover:scale-[1.02] transition-all duration-150 flex items-center gap-1 min-w-0 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1"
       style={{
         backgroundColor: isOverdue ? '#fef2f2' : typeColor.light,
         color: isOverdue ? '#dc2626' : typeColor.text,
         borderLeft: `3px solid ${isOverdue ? '#dc2626' : typeColor.border}`
       }}
       onClick={onClick}
       onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e); } }}
       tabIndex={0}
       role="button"
       aria-label={[event.title, startTime ? `at ${startTime}` : null, isOverdue ? 'Overdue' : null].filter(Boolean).join(' - ')}
       title={title || [event.title, startTime ? `at ${startTime}` : null, isOverdue ? 'Overdue' : null, sourceConfig?.tooltip].filter(Boolean).join(' - ')}
     >
      {/* Owner dot + first name */}
      {(() => {
        const primaryUid = owners[0];
        const primaryUser = primaryUid ? users.find(u => u.id === primaryUid) : null;
        const primaryColor = primaryUid ? userColorMap.get(primaryUid) : null;
        const firstName = primaryUser?._isBusiness ? 'Flex' : (primaryUser?.full_name?.split(' ')[0] || '');
        return firstName ? (
          <span className="flex items-center gap-0.5 flex-shrink-0">
            <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: primaryColor?.bg }} />
            <span className="text-[9px] font-medium opacity-60">{firstName}</span>
          </span>
        ) : null;
      })()}
      {/* Time + truncated title */}
      <span className="truncate min-w-0">
        {startTime && <span className="font-semibold opacity-70 mr-0.5">{startTime}</span>}
        {event.is_done ? '✓ ' : ''}{event.title || 'Untitled'}
      </span>
      {hasConflict && <AlertTriangle className="h-3 w-3 text-orange-500 flex-shrink-0" title="Scheduling conflict" />}
      {event.travel_time_minutes > 0 && <span className="text-[7px] opacity-60 flex-shrink-0" title={`${event.travel_time_minutes}min travel`}>{event.travel_time_minutes}m</span>}
      {event.event_source === 'tonomo' && <span className="text-[7px] opacity-50 flex-shrink-0 ml-auto">BK</span>}
    </div>
  );
}

// ── TEAM WEEK VIEW ────────────────────────────────────────────────────────────

function TeamWeekView({ currentDate, events, users, userColorMap, isLaneMode, allAvailability, currentUserId, conflictSet, onCellClick, onCellDoubleClick, onEventClick }) {
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const hours = Array.from({ length: 24 }, (_, i) => i);

  // Current time indicator state — must be declared before any early returns
  // to satisfy React's Rules of Hooks (hooks cannot be called conditionally).
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const getUnavailableRanges = (userId, date) => {
    const dayOfWeek = date.getDay();
    const userAvail = allAvailability.find(
      a => a.user_id === userId && a.day_of_week === dayOfWeek
    );
    if (!userAvail || !userAvail.is_available) {
      return [{ start: 0, end: 24 * 60 }]; // full day shaded
    }
    const [sh, sm] = userAvail.start_time.split(':').map(Number);
    const [eh, em] = userAvail.end_time.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const ranges = [];
    if (startMin > 0) ranges.push({ start: 0, end: startMin });
    if (endMin < 24 * 60) ranges.push({ start: endMin, end: 24 * 60 });
    return ranges;
  };

  // Stable key for days array to avoid re-computing on every render
  // (days is a new array ref each render but its content only changes with currentDate)
  const weekStartKey = weekStart.getTime();

  // Compute booked hours per user per day for availability display
  const bookedHoursMap = useMemo(() => {
    const map = new Map(); // `${userId}-${dayIdx}` -> hours
    if (!isLaneMode) return map;
    const stableDays = Array.from({ length: 7 }, (_, i) => addDays(new Date(weekStartKey), i));
    stableDays.forEach((d, di) => {
      users.forEach(u => {
        const userDayEvents = events
          .filter(({ owners }) => owners.includes(u.id))
          .filter(({ event }) => event.start_time && !event.is_all_day && isSameDay(new Date(fixTimestamp(event.start_time)), d));
        let totalMin = 0;
        for (const { event } of userDayEvents) {
          const s = new Date(fixTimestamp(event.start_time));
          const e = event.end_time ? new Date(fixTimestamp(event.end_time)) : new Date(s.getTime() + 3600000);
          totalMin += Math.max(0, differenceInMinutes(e, s));
        }
        map.set(`${u.id}-${di}`, Math.round(totalMin / 60 * 10) / 10);
      });
    });
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLaneMode, events, users, weekStartKey]);

  // Tonomo-style week view: full-width day columns with color-coded events per user
  // (Not sub-lanes — that's too cramped for 7 days. Color-coding by user is clearer.)
  if (isLaneMode && users.length > 0) {
    return (
      <div className="flex h-full">
        {/* Time gutter */}
        <div className="w-14 flex-shrink-0 border-r">
          <div className="border-b" style={{ height: 44 }} />
          {hours.map(h => (
            <div key={h} style={{ height: getSlotHeight(h) }} className={cn("border-b flex items-start justify-end pr-2 pt-1", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}>
              <span className={cn("text-muted-foreground", (h < BUSINESS_START || h >= BUSINESS_END) ? "text-[9px]" : "text-xs")}>
                {h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns with color-coded events */}
        <div className="flex-1 grid overflow-y-auto" style={{ gridTemplateColumns: `repeat(7, 1fr)` }}>
          {days.map((d, di) => {
            const dayItems = events.filter(({ event }) =>
              event.start_time && !event.is_all_day && isSameDay(new Date(fixTimestamp(event.start_time)), d)
            );
            const isTodayCol = isToday(d);
            return (
              <div key={di} className="border-r relative">
                {/* Day header */}
                <div className={`border-b text-center py-1.5 sticky top-0 bg-background z-10 ${isTodayCol ? 'bg-primary/5' : ''}`} style={{ height: 44 }}>
                  <div className="text-xs text-muted-foreground">{format(d, 'EEE')}</div>
                  <div className={`text-sm font-semibold ${isTodayCol ? 'text-primary' : ''}`}>{format(d, 'd')}</div>
                </div>

                {/* Hour slots */}
                {hours.map(h => (
                  <div key={h} data-hour={h} style={{ height: getSlotHeight(h) }}
                    className={cn("border-b hover:bg-muted/10 cursor-pointer group relative", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}
                    onDoubleClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellDoubleClick(dt); }}
                    onClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellClick(dt); }}
                  >
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/30 transition-opacity pointer-events-none select-none">+</span>
                  </div>
                ))}

                {/* Working hours end boundary */}
                <div className="absolute left-0 right-0 z-15 pointer-events-none" style={{ top: 44 + minutesToPx(19 * 60) }}>
                  <div className="h-[2px] bg-red-400/40" />
                </div>

                {/* Current time indicator */}
                {isTodayCol && (() => {
                  const nowSyd = getSydneyHourMinute(now.toISOString());
                  const nowMin = nowSyd.hour * 60 + nowSyd.minute;
                  return <CurrentTimeIndicator topPx={minutesToPx(nowMin) + 44} showLabel={false} />;
                })()}

                {/* Color-coded event blocks by user */}
                {dayItems.map(({ event, owners }) => {
                  // Find the primary owner for coloring
                  const primaryOwner = owners[0] ? users.find(u => u.id === owners[0]) : users[0];
                  const ownerIdx = primaryOwner ? users.indexOf(primaryOwner) : 0;

                  // If multiple users own this event, we render it once with the primary color
                  // but show co-owner avatars
                  const start = new Date(fixTimestamp(event.start_time));
                  const end = event.end_time ? new Date(fixTimestamp(event.end_time)) : new Date(start.getTime() + 3600000);
                  // BUG FIX: use Sydney hours for grid positioning, not local machine hours
                  const startSyd = getSydneyHourMinute(event.start_time);
                  const startMin = startSyd.hour * 60 + startSyd.minute;
                  const durMin = Math.max(15, differenceInMinutes(end, start));
                  const topPx = minutesToPx(startMin) + 44;
                  const heightPx = Math.max(22, minutesToPx(startMin + durMin) - minutesToPx(startMin) - 2);

                  const userColor = primaryOwner ? userColorMap.get(primaryOwner.id) : PERSON_COLORS[0];
                  const isTonomo = event.event_source === 'tonomo' || event.tonomo_appointment_id;
                  const isExternal = event.event_source === 'google' && !isTonomo;

                  // Overlapping event offset: find concurrent events and position side-by-side
                  const concurrent = dayItems.filter(({ event: other }) => {
                    if (other.id === event.id || !other.start_time) return false;
                    const oStart = new Date(fixTimestamp(other.start_time));
                    const oEnd = other.end_time ? new Date(fixTimestamp(other.end_time)) : new Date(oStart.getTime() + 3600000);
                    return start < oEnd && end > oStart;
                  });
                  const myIdx = concurrent.filter(({ event: o }) => o.id < event.id).length;
                  const totalConcurrent = concurrent.length + 1;
                  const widthPct = totalConcurrent > 1 ? (100 / totalConcurrent) : 100;
                  const leftPct = totalConcurrent > 1 ? (myIdx * widthPct) : 0;

                  return (
                    <div
                      key={event.id}
                      className="absolute rounded-md px-1.5 py-0.5 cursor-pointer hover:brightness-110 hover:shadow-lg overflow-hidden z-10 flex flex-col transition-all duration-150 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1"
                      style={{
                        top: topPx,
                        height: heightPx,
                        left: `calc(${leftPct}% + 1px)`,
                        width: `calc(${widthPct}% - 2px)`,
                        backgroundColor: isExternal ? `${userColor?.bg}50` : userColor?.bg,
                        borderLeft: `3px solid ${userColor?.bg}`,
                        color: isExternal ? userColor?.text : '#fff',
                      }}
                      onClick={(e) => onEventClick(e, event)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEventClick(e, event); } }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${event.title || 'Untitled'}, ${fmtSydneyTime(event.start_time)} to ${fmtSydneyTime(event.end_time)}${event.location ? ', at ' + event.location : ''}`}
                      title={`${event.title}\n${fmtSydneyTime(event.start_time)} - ${fmtSydneyTime(event.end_time)}${event.location ? '\n' + event.location : ''}`}
                    >
                      {/* Owner name tag */}
                      {primaryOwner && (() => {
                        const firstName = primaryOwner._isBusiness ? 'Flex' : (primaryOwner.full_name?.split(' ')[0] || '');
                        return firstName ? <span className="text-[9px] font-medium opacity-70 leading-none">{firstName}</span> : null;
                      })()}
                      <p className="text-[11px] font-bold leading-tight truncate">{event.title || 'Untitled'}</p>
                      {heightPx > 26 && (
                        <p className="text-[10px] leading-tight" style={{ opacity: 0.75 }}>{fmtSydneyTime(event.start_time, { hour: 'numeric', minute: '2-digit', hour12: false })} - {fmtSydneyTime(event.end_time, { hour: 'numeric', minute: '2-digit', hour12: false })}</p>
                      )}
                      {heightPx > 40 && owners.length > 1 && (
                        <div className="flex -space-x-1 mt-0.5">
                          {owners.slice(0, 3).map(uid => {
                            const u = users.find(u => u.id === uid);
                            const c = userColorMap.get(uid);
                            return (
                              <span key={uid}
                                className="w-3 h-3 rounded-full border border-white/50 text-white flex items-center justify-center text-[7px] font-bold"
                                style={{ backgroundColor: c?.bg }}
                              >
                                {getInitials(u?.full_name || '?')[0]}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // STANDARD mode (single user selected)

  return (
    <div className="flex h-full">
      <div className="w-14 flex-shrink-0 border-r">
        <div className="border-b" style={{ height: 40 }} />
        {hours.map(h => (
          <div key={h} data-hour={h} style={{ height: getSlotHeight(h) }} className={cn("border-b flex items-start justify-end pr-2 pt-1", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}>
            <span className={cn("text-muted-foreground", (h < BUSINESS_START || h >= BUSINESS_END) ? "text-[9px]" : "text-xs")}>
              {h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}
            </span>
          </div>
        ))}
      </div>
      <div className="flex-1 grid overflow-y-auto" style={{ gridTemplateColumns: `repeat(7, 1fr)` }}>
        {days.map((d, di) => {
          const dayItems = events.filter(({ event }) =>
            event.start_time && !event.is_all_day && isSameDay(new Date(fixTimestamp(event.start_time)), d)
          );
          const isTodayCol = isToday(d);
          return (
            <div key={di} className="border-r relative">
              <div className={`border-b text-center py-1 sticky top-0 bg-background z-10 ${isTodayCol ? 'bg-primary/5' : ''}`} style={{ height: 40 }}>
                <div className="text-xs text-muted-foreground">{format(d, 'EEE')}</div>
                <div className={`text-sm font-medium ${isTodayCol ? 'text-primary' : ''}`}>{format(d, 'd')}</div>
              </div>
              {hours.map(h => {
                // Check if this slot has any events
                const slotHasEvent = dayItems.some(({ event }) => {
                  const s = new Date(fixTimestamp(event.start_time));
                  const e = event.end_time ? new Date(fixTimestamp(event.end_time)) : new Date(s.getTime() + 3600000);
                  const slotStart = h * 60;
                  const slotEnd = (h + 1) * 60;
                  // BUG FIX: use Sydney hours for slot overlap detection
                  const evStartSyd = getSydneyHourMinute(event.start_time);
                  const evEndSyd = event.end_time ? getSydneyHourMinute(event.end_time) : { hour: evStartSyd.hour + 1, minute: evStartSyd.minute };
                  const evStartMin = evStartSyd.hour * 60 + evStartSyd.minute;
                  // BUG FIX: Don't use `|| 24*60` — that turns midnight (00:00) into end-of-day.
                  // Instead, if end <= start (e.g. cross-midnight event), treat end as end-of-day.
                  let evEndMin = evEndSyd.hour * 60 + evEndSyd.minute;
                  if (evEndMin <= evStartMin) evEndMin = 24 * 60;
                  return evStartMin < slotEnd && evEndMin > slotStart;
                });
                return (
                  <div
                    key={h}
                    data-hour={h}
                    style={{ height: getSlotHeight(h) }}
                    className={cn("border-b hover:bg-muted/10 cursor-pointer group relative", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}
                    onDoubleClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellDoubleClick(dt); }}
                    onClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellClick(dt); }}
                  >
                    {/* Click to add hint on empty slots */}
                    {!slotHasEvent && (
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-all duration-200 pointer-events-none select-none">
                        + Double-click to add
                      </span>
                    )}
                  </div>
                );
              })}

              {/* Current time indicator */}
              {isTodayCol && (() => {
                const nowSyd = getSydneyHourMinute(now.toISOString());
                const nowMin = nowSyd.hour * 60 + nowSyd.minute;
                return <CurrentTimeIndicator topPx={minutesToPx(nowMin) + 40} showLabel={false} />;
              })()}

              {/* Duration blocks */}
              {dayItems.map(({ event, owners }) => (
                <StandardEventBlock
                  key={event.id}
                  event={event}
                  owners={owners}
                  userColorMap={userColorMap}
                  allUsers={users}
                  headerOffset={40}
                  hasConflict={conflictSet.has(event.id)}
                  onClick={(e) => onEventClick(e, event)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TEAM DAY VIEW ─────────────────────────────────────────────────────────────

function TeamDayView({ currentDate, events, users, userColorMap, isLaneMode, allAvailability, currentUserId, conflictSet, onCellClick, onCellDoubleClick, onEventClick }) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const dayLaneRef = useRef(null);

  // Auto-scroll to working hours (7am) on mount
  useEffect(() => {
    if (dayLaneRef.current) {
      const scrollTarget = getSlotTop(7); // 7am
      dayLaneRef.current.scrollTop = scrollTarget;
    }
  }, [currentDate]);

  const getUnavailableRanges = (userId, date) => {
    const dayOfWeek = date.getDay();
    const userAvail = allAvailability.find(
      a => a.user_id === userId && a.day_of_week === dayOfWeek
    );
    if (!userAvail || !userAvail.is_available) {
      return [{ start: 0, end: 24 * 60 }]; // full day shaded
    }
    const [sh, sm] = userAvail.start_time.split(':').map(Number);
    const [eh, em] = userAvail.end_time.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const ranges = [];
    if (startMin > 0) ranges.push({ start: 0, end: startMin });
    if (endMin < 24 * 60) ranges.push({ start: endMin, end: 24 * 60 });
    return ranges;
  };

  const allDayItems = events.filter(({ event }) =>
    event.start_time && event.is_all_day && isSameDay(new Date(fixTimestamp(event.start_time)), currentDate)
  );
  const timedItems = events.filter(({ event }) =>
    event.start_time && !event.is_all_day && isSameDay(new Date(fixTimestamp(event.start_time)), currentDate)
  );

  return (
    <div className="flex h-full flex-col">
      {allDayItems.length > 0 && (
        <div className="border-b bg-muted/20 p-2 space-y-1">
          <div className="text-xs font-medium text-muted-foreground mb-1">All Day</div>
          {allDayItems.map(({ event, owners }) => (
            <StandardEventBlock key={event.id} event={event} owners={owners}
              userColorMap={userColorMap} allUsers={users}
              isAllDay onClick={(e) => onEventClick(e, event)} />
          ))}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Time gutter */}
        <div className="w-14 flex-shrink-0 border-r">
          {hours.map(h => (
            <div key={h} style={{ height: getSlotHeight(h) }} className={cn("border-b flex items-start justify-end pr-2 pt-1", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}>
              <span className={cn("text-muted-foreground", (h < BUSINESS_START || h >= BUSINESS_END) ? "text-[9px]" : "text-xs")}>
                {h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}
              </span>
            </div>
          ))}
        </div>

        {isLaneMode && users.length > 1 ? (
          /* Tonomo-style lane mode: each user gets a full column */
          <div className="flex flex-1 overflow-y-auto" ref={dayLaneRef}>
            {users.map((u, uIdx) => {
              const color = userColorMap.get(u.id);
              const userItems = timedItems.filter(({ owners }) => owners.includes(u.id));
              const HEADER_H = 52;
              // Calculate booked hours
              let totalMin = 0;
              for (const { event: ev } of userItems) {
                const s = new Date(fixTimestamp(ev.start_time));
                const e = ev.end_time ? new Date(fixTimestamp(ev.end_time)) : new Date(s.getTime() + 3600000);
                totalMin += Math.max(0, differenceInMinutes(e, s));
              }
              const booked = Math.round(totalMin / 60 * 10) / 10;
              return (
                <div key={u.id} className="flex-1 border-r last:border-r-0 relative min-w-[140px]">
                  {/* Tonomo-style lane header: colored top bar + name + avatar */}
                  <div className="sticky top-0 z-20" style={{ height: HEADER_H }}>
                    <div className="h-1" style={{ backgroundColor: color?.bg }} />
                    <div className="bg-background border-b flex items-center justify-center gap-2 py-2">
                      <span className="w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center shadow-sm"
                        style={{ backgroundColor: color?.bg }}>
                        {getInitials(u.full_name || u.email)}
                      </span>
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold leading-tight">{u.full_name || u.email}</span>
                        <span className={`text-[10px] leading-tight ${booked >= 8 ? 'text-red-500 font-semibold' : 'text-muted-foreground'}`}>
                          {userItems.length} booking{userItems.length !== 1 ? 's' : ''} · {booked}h
                        </span>
                      </div>
                    </div>
                  </div>
                  {/* Hour grid slots */}
                  <div className="relative">
                    {hours.map(h => (
                      <div key={h} style={{ height: getSlotHeight(h) }}
                        className={cn("border-b hover:bg-muted/10 cursor-pointer group", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}
                        onDoubleClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellDoubleClick(dt, u.id); }}
                        onClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellClick(dt, u.id); }}
                      >
                        <span className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/30 transition-opacity pointer-events-none select-none">+</span>
                      </div>
                    ))}

                    {/* Unavailable time shading */}
                    {getUnavailableRanges(u.id, currentDate).map((range, rIdx) => {
                      const topPx = minutesToPx(range.start);
                      const heightPx = minutesToPx(range.end) - minutesToPx(range.start);
                      return (
                        <div
                          key={rIdx}
                          className="absolute left-0 right-0 pointer-events-none"
                          style={{ top: topPx, height: heightPx, background: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.03) 4px, rgba(0,0,0,0.03) 8px)' }}
                        />
                      );
                    })}

                    {/* Working hours end boundary (red line like Tonomo) */}
                    {(() => {
                      const dayOfWeek = currentDate.getDay();
                      const userAvail = allAvailability.find(a => a.user_id === u.id && a.day_of_week === dayOfWeek);
                      if (userAvail && userAvail.is_available && userAvail.end_time) {
                        const [eh, em] = userAvail.end_time.split(':').map(Number);
                        const endMin = eh * 60 + (em || 0);
                        const linePx = minutesToPx(endMin);
                        return (
                          <div className="absolute left-0 right-0 z-15 pointer-events-none" style={{ top: linePx }}>
                            <div className="h-[2px] bg-red-400/60" />
                          </div>
                        );
                      }
                      // Default: show line at 19:00 (7pm)
                      const defaultEnd = minutesToPx(19 * 60);
                      return (
                        <div className="absolute left-0 right-0 z-15 pointer-events-none" style={{ top: defaultEnd }}>
                          <div className="h-[2px] bg-red-400/40" />
                        </div>
                      );
                    })()}

                    {/* Current time indicator */}
                    {isToday(currentDate) && (() => {
                      const n = new Date();
                      const nSyd = getSydneyHourMinute(n.toISOString());
                      const nowMin = nSyd.hour * 60 + nSyd.minute;
                      return <CurrentTimeIndicator topPx={minutesToPx(nowMin)} />;
                    })()}

                    {/* Event blocks */}
                    {userItems.map(({ event, owners }) => (
                     <LaneEventBlock
                       key={event.id}
                       event={event}
                       owners={owners}
                       user={u}
                       userIdx={0}
                       totalUsers={1}
                       userColorMap={userColorMap}
                       allUsers={users}
                       currentUserId={currentUserId}
                       hasConflict={conflictSet.has(event.id)}
                       onClick={(e) => onEventClick(e, event)}
                       dayMode={true}
                     />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Single column */
          <div className="flex-1 relative overflow-y-auto">
            {hours.map(h => (
              <div key={h} style={{ height: getSlotHeight(h) }}
                className={cn("border-b hover:bg-muted/10 cursor-pointer group relative", (h < BUSINESS_START || h >= BUSINESS_END) && "bg-muted/30")}
                onDoubleClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellDoubleClick(dt); }}
                onClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellClick(dt); }}
              >
                <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-all duration-200 pointer-events-none select-none">
                  + Double-click to add event
                </span>
              </div>
            ))}
            {timedItems.map(({ event, owners }) => (
              <StandardEventBlock key={event.id} event={event} owners={owners}
                userColorMap={userColorMap} allUsers={users}
                hasConflict={conflictSet.has(event.id)}
                onClick={(e) => onEventClick(e, event)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── EVENT BLOCKS ──────────────────────────────────────────────────────────────

// Proportional duration block for standard (non-lane) views
function StandardEventBlock({ event, owners, userColorMap, allUsers, isAllDay, userColor, headerOffset = 0, hasConflict, onClick }) {
  const typeColor = getEventTypeColor(event);

  if (isAllDay) {
    return (
      <div
        className="rounded px-2 py-0.5 text-xs cursor-pointer hover:opacity-80 truncate focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1"
        style={{ backgroundColor: typeColor.light, color: typeColor.text, borderLeft: `3px solid ${typeColor.border}` }}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e); } }}
        tabIndex={0}
        role="button"
        aria-label={`${event.title} (all day)`}
      >{event.title}</div>
    );
  }

  const start = new Date(fixTimestamp(event.start_time));
  const end = event.end_time
    ? new Date(fixTimestamp(event.end_time))
    : new Date(start.getTime() + 60 * 60 * 1000);

  // BUG FIX: use Sydney hours for grid positioning, not local machine hours
  const startSyd = getSydneyHourMinute(event.start_time);
  const startMinutes = startSyd.hour * 60 + startSyd.minute;
  const durationMinutes = Math.max(15, differenceInMinutes(end, start));

  const topPx = minutesToPx(startMinutes) + headerOffset;
  const heightPx = Math.max(20, minutesToPx(startMinutes + durationMinutes) - minutesToPx(startMinutes) - 2);

  const ownerUsers = owners.map(uid => allUsers.find(u => u.id === uid)).filter(Boolean);

  return (
    <div
      className="absolute left-1 right-1 rounded-md px-1.5 py-0.5 cursor-pointer hover:opacity-90 hover:shadow-lg overflow-hidden z-10 flex flex-col transition-all duration-150 border focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1"
      style={{
        top: topPx,
        height: heightPx,
        backgroundColor: typeColor.light,
        borderLeft: `4px solid ${typeColor.border}`,
        borderColor: `${typeColor.border}40`,
        borderLeftColor: typeColor.border,
        color: typeColor.text,
      }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e); } }}
      tabIndex={0}
      role="button"
      aria-label={`${event.title}, ${fmtSydneyTime(event.start_time)} to ${fmtSydneyTime(event.end_time)}${event.location ? ', at ' + event.location : ''}`}
      title={`${event.title} (${fmtSydneyTime(event.start_time)} - ${fmtSydneyTime(event.end_time)})`}
    >
      {/* Owner name tag */}
      {ownerUsers.length > 0 && (() => {
        const prim = ownerUsers[0];
        const primColor = userColorMap.get(prim.id);
        const firstName = prim._isBusiness ? 'Flex' : (prim.full_name?.split(' ')[0] || '');
        return firstName ? (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-medium rounded px-1 py-0 w-fit mb-0.5"
            style={{ backgroundColor: `${primColor?.bg}20`, color: primColor?.text }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: primColor?.bg }} />
            {firstName}
          </span>
        ) : null;
      })()}
      <div className="flex items-center gap-1">
        <p className="text-xs font-semibold leading-tight truncate flex-1">{event.title}</p>
        {hasConflict && <AlertTriangle className="h-3 w-3 text-orange-500 flex-shrink-0" title="Scheduling conflict" />}
      </div>
      {heightPx > 30 && (
        <p className="text-[11px] opacity-70 leading-tight">{fmtSydneyTime(event.start_time, { hour: 'numeric', minute: '2-digit', hour12: false })} - {fmtSydneyTime(event.end_time)}</p>
      )}
      {heightPx > 30 && event.travel_time_minutes > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[9px] bg-blue-100 text-blue-700 rounded px-1 py-0 w-fit">
          <Clock className="h-2.5 w-2.5" />{event.travel_time_minutes}m travel
        </span>
      )}
      {heightPx > 44 && event.location && (
        <p className="text-[10px] opacity-50 leading-tight truncate">{event.location}</p>
      )}
      {heightPx > 54 && ownerUsers.length > 1 && (
        <div className="flex -space-x-1 mt-0.5">
          {ownerUsers.slice(0, 4).map(u => {
            const c = userColorMap.get(u.id);
            return (
              <span key={u.id}
                className="w-3.5 h-3.5 rounded-full border border-white text-white flex items-center justify-center text-[7px] font-bold"
                style={{ backgroundColor: c?.bg }}
              >
                {getInitials(u.full_name || '?')[0]}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Block for lane (team) view — Tonomo-style solid colored blocks
function LaneEventBlock({ event, owners, user, userIdx, totalUsers, userColorMap, allUsers, onClick, currentUserId, hasConflict, dayMode }) {
  const start = new Date(fixTimestamp(event.start_time));
  const end = event.end_time
    ? new Date(fixTimestamp(event.end_time))
    : new Date(start.getTime() + 60 * 60 * 1000);

  // BUG FIX: use Sydney hours for grid positioning, not local machine hours
  const startSyd = getSydneyHourMinute(event.start_time);
  const startMinutes = startSyd.hour * 60 + startSyd.minute;
  const durationMinutes = Math.max(15, differenceInMinutes(end, start));
  const topPx = minutesToPx(startMinutes);
  const heightPx = Math.max(24, minutesToPx(startMinutes + durationMinutes) - minutesToPx(startMinutes) - 2);

  // In day mode (full lane), use full width. In week sub-lane mode, position by user index.
  const laneWidth = dayMode ? 100 : (100 / totalUsers);
  const leftPct = dayMode ? 0 : (userIdx * laneWidth);

  const userColor = userColorMap.get(user.id);
  const ownerUsers = owners.map(uid => allUsers.find(u => u.id === uid)).filter(Boolean);

  // Privacy: show as opaque "Busy" block
  const isBusyBlock = event.connection_visibility_policy === 'show_busy_only' &&
    event.owner_user_id &&
    event.owner_user_id !== currentUserId;

  // Special Google event types
  const isOutOfOffice = event.google_event_type === 'outOfOffice';
  const isFocusTime = event.google_event_type === 'focusTime';
  const isTonomo = event.event_source === 'tonomo' || event.tonomo_appointment_id || event.link_source === 'tonomo_webhook';
  const isExternal = event.event_source === 'google' || (event.is_synced && !isTonomo);

  // Tonomo-style: solid colored blocks
  // Shoots/Tonomo: user's assigned color (solid, dark)
  // External/Google: lighter version of user's color
  // Out of office / Focus time: special patterns
  let bgColor, textColor, borderColor;
  if (isOutOfOffice) {
    bgColor = 'repeating-linear-gradient(45deg, #fef3c7, #fef3c7 4px, #fde68a 4px, #fde68a 8px)';
    textColor = '#92400e';
    borderColor = '#f59e0b';
  } else if (isFocusTime) {
    bgColor = '#dbeafe';
    textColor = '#1e40af';
    borderColor = '#3b82f6';
  } else if (isBusyBlock) {
    bgColor = '#e5e7eb';
    textColor = '#6b7280';
    borderColor = '#9ca3af';
  } else if (isExternal) {
    // External events: lighter/muted version of user color
    bgColor = userColor?.bg ? `${userColor.bg}50` : '#e5e7eb';
    textColor = userColor?.text || '#374151';
    borderColor = userColor?.bg || '#9ca3af';
  } else {
    // Shoots and FlexMedia events: solid user color (Tonomo-style)
    bgColor = userColor?.bg || '#3b82f6';
    textColor = '#ffffff';
    borderColor = userColor?.bg || '#3b82f6';
  }

  const displayTitle = isBusyBlock ? 'Busy'
    : isOutOfOffice ? 'Out of Office'
    : isFocusTime ? 'Focus Time'
    : isExternal ? (event.title || 'External')
    : event.title || 'Untitled';

  return (
    <div
      className="absolute rounded-lg px-2 py-1 cursor-pointer hover:brightness-110 hover:shadow-xl overflow-hidden z-10 flex flex-col transition-all duration-150 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1"
      style={{
        top: topPx,
        height: heightPx,
        left: dayMode ? '2px' : `calc(${leftPct}% + 1px)`,
        width: dayMode ? 'calc(100% - 4px)' : `calc(${laneWidth}% - 2px)`,
        background: bgColor,
        borderLeft: `4px solid ${borderColor}`,
        color: textColor,
      }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e); } }}
      tabIndex={0}
      role="button"
      aria-label={`${displayTitle}, ${fmtSydneyTime(event.start_time)} to ${fmtSydneyTime(event.end_time)}${event.location ? ', at ' + event.location : ''}`}
      title={`${event.title || 'Untitled'}\n${fmtSydneyTime(event.start_time)} - ${fmtSydneyTime(event.end_time)}${event.location ? '\n' + event.location : ''}`}
    >
      {/* Owner name tag */}
      {ownerUsers.length > 0 && (() => {
        const prim = ownerUsers[0];
        const firstName = prim?._isBusiness ? 'Flex' : (prim?.full_name?.split(' ')[0] || '');
        return firstName ? (
          <span className="text-[9px] font-medium opacity-70 leading-none">{firstName}</span>
        ) : null;
      })()}
      <div className="flex items-center gap-1 min-w-0">
        <p className="text-xs font-bold leading-tight truncate flex-1">{displayTitle}</p>
        {hasConflict && <AlertTriangle className="h-3 w-3 text-orange-400 flex-shrink-0" />}
        {isTonomo && <span className="text-[8px] opacity-60 flex-shrink-0 font-medium">BK</span>}
      </div>
      {heightPx > 36 && event.location && (
        <p className="text-[11px] leading-tight truncate mt-0.5" style={{ opacity: 0.85 }}>{event.location}</p>
      )}
      {heightPx > 28 && (
        <p className="text-[11px] leading-tight mt-auto" style={{ opacity: 0.75 }}>{fmtSydneyTime(event.start_time, { hour: 'numeric', minute: '2-digit', hour12: false })} - {fmtSydneyTime(event.end_time, { hour: 'numeric', minute: '2-digit', hour12: false })}</p>
      )}
      {heightPx > 28 && event.travel_time_minutes > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[8px] rounded px-0.5 py-0 w-fit" style={{ opacity: 0.7 }}>
          <Clock className="h-2 w-2" />{event.travel_time_minutes}m travel
        </span>
      )}
      {heightPx > 50 && ownerUsers.length > 1 && (
        <div className="flex -space-x-1 mt-0.5">
          {ownerUsers.map(u => {
            const c = userColorMap.get(u.id);
            return (
              <span key={u.id}
                className="w-4 h-4 rounded-full border-2 border-white/50 text-white flex items-center justify-center text-[8px] font-bold"
                style={{ backgroundColor: c?.bg }}
                title={u.full_name}
              >
                {getInitials(u.full_name || '?')[0]}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}