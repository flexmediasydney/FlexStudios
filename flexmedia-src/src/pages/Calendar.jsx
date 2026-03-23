import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon,
  Users, User, RefreshCw, Search, AlertTriangle, Clock, X
} from "lucide-react";
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
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { usePermissions } from '@/components/auth/PermissionGuard';

// ── Constants ─────────────────────────────────────────────────────────────────
const VIEWS = ['month', 'week', 'day'];
const SLOT_HEIGHT = 56; // px per hour slot

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

function getInitials(name = '') {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}

// ── Main page ─────────────────────────────────────────────────────────────────
function CalendarSkeleton({ view }) {
  if (view === 'month') {
    return (
      <div className="grid grid-cols-7 gap-px bg-border p-4">
        {Array.from({ length: 35 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-md" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-px p-4">
      {Array.from({ length: view === 'week' ? 7 : 1 }).map((_, i) => (
        <div key={i} className="flex-1 space-y-2">
          {Array.from({ length: 12 }).map((_, j) => (
            <Skeleton key={j} className="h-8 rounded-md" />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function CalendarPage() {
  const { isContractor, user: permUser } = usePermissions();
  
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
  const [calendarMode, setCalendarMode] = useState("flex"); // 'flex' | 'team'
  const [selectedUserIds, setSelectedUserIds] = useState(["all"]);
  const [showConnections, setShowConnections] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [defaultStart, setDefaultStart] = useState(null);
  const queryClient = useQueryClient();

  // Countdown to next DB refresh (60s) and next Google sync (5min)
  // Tick every 5s to reduce unnecessary re-renders (was 1s)
  const [dbCountdown, setDbCountdown] = useState(60);
  const [syncCountdown, setSyncCountdown] = useState(300);
  const dbCountdownRef = useRef(null);
  const syncCountdownRef = useRef(null);

  useEffect(() => {
    setDbCountdown(60);
    dbCountdownRef.current = setInterval(() => {
      setDbCountdown(s => {
        if (s <= 5) { return 60; }
        return s - 5;
      });
    }, 5000);
    return () => clearInterval(dbCountdownRef.current);
  }, []);

  useEffect(() => {
    setSyncCountdown(300);
    syncCountdownRef.current = setInterval(() => {
      setSyncCountdown(s => {
        if (s <= 5) { return 300; }
        return s - 5;
      });
    }, 5000);
    return () => clearInterval(syncCountdownRef.current);
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

  // ── User → colour map ── (Gap fix: stable dep array to avoid recalc every render)
  const userIdKey = users.map(u => u.id).join(',');
  const userColorMap = useMemo(() => {
    const map = new Map();
    users.forEach((u, i) => map.set(u.id, PERSON_COLORS[i % PERSON_COLORS.length]));
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
    users.forEach(u => map.set(u.id, []));

    for (const ev of rawEvents) {
      const owners = new Set();

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

    return result;
  }, [expandedEvents, eventsByUser]);

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
    if (selectedUserIds.includes("all")) return users;
    return users.filter(u => selectedUserIds.includes(u.id));
  }, [users, selectedUserIds]);

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

      if (calendarMode === "flex") {
        // Show: Tonomo bookings, project-linked events, shoot-related Google events
        const isTonomoEvent = event.event_source === 'tonomo' ||
          event.link_source === 'tonomo_webhook' ||
          event.tonomo_appointment_id;
        const isProjectLinked = !!event.project_id || event.auto_linked;
        // Google events that are clearly shoots (synced from Tonomo via personal calendars)
        const isShootFromGoogle = event.event_source === 'google' &&
          (event.title || '').toLowerCase().includes('flex media shoot');
        if (!isTonomoEvent && !isProjectLinked && !isShootFromGoogle) {
          return false;
        }
      }

      // Contractors: hide events they don't own and aren't linked to a project
      if (isContractor && !event.project_id && event.owner_user_id && event.owner_user_id !== permUser?.id) {
        return false;
      }

      if (selectedUserIds.includes("all")) return true;
      // Must belong to at least one selected user
      return owners.some(uid => selectedUserIds.includes(uid));
    });
  }, [deduplicatedEvents, filterType, calendarMode, selectedUserIds, isContractor, permUser, searchQuery]);

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
  const handleTodayClick = useCallback(() => {
    setCurrentDate(new Date());
    const now = new Date();
    const hourElement = document.querySelector(`[data-hour="${now.getHours()}"]`);
    if (hourElement) {
      hourElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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
  }, [navigate, handleTodayClick, dialogOpen]);

  // Are we in lane mode?
  const isLaneMode = view !== "month" &&
    (selectedUserIds.includes("all") || selectedUserIds.length > 1);

  const laneUsers = isLaneMode ? activeUsers : [];

  return (
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

          <h1 className="text-sm sm:text-lg font-semibold min-w-0 sm:min-w-[200px] truncate">{headerLabel()}</h1>

          {/* Mode toggle */}
          <div className="flex gap-1 bg-muted rounded-lg p-0.5">
            <button
              onClick={() => setCalendarMode("flex")}
              className={`px-3 py-2 min-h-[44px] sm:min-h-0 sm:py-1.5 rounded-md text-xs font-medium transition-all duration-200 hover:scale-105 active:scale-95 ${
                calendarMode === "flex"
                  ? "bg-background shadow-md text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/50"
              }`}
              title="Show only project bookings and linked events"
            >
              <span className="hidden sm:inline">📅 </span>Flex
            </button>
            <button
              onClick={() => setCalendarMode("team")}
              className={`px-3 py-2 min-h-[44px] sm:min-h-0 sm:py-1.5 rounded-md text-xs font-medium transition-all duration-200 hover:scale-105 active:scale-95 ${
                calendarMode === "team"
                  ? "bg-background shadow-md text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/50"
              }`}
              title="Show all calendar events for all team members"
            >
              <Users className="h-3 w-3 inline mr-1" />
              Team
            </button>
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
                setDbCountdown(60);
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

          {/* Search with highlighting prep */}
           <div className="relative" title="Search highlights matching text in results">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery(''); }}
              placeholder="Search events (Esc to clear)…"
              className="h-9 pl-8 pr-12 rounded-md border bg-background text-sm w-full sm:w-48 min-w-0 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 transition-all duration-150 hover:border-primary/50"
            />
           {searchQuery && (
             <>
               <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 font-medium tabular-nums">{searchQuery.length}</span>
               <button
                 onClick={() => setSearchQuery("")}
                 className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1 transition-colors duration-150"
                 title="Clear search (Esc)"
                 aria-label="Clear search"
                 >
                 <X className="h-3.5 w-3.5" />
               </button>
             </>
           )}
          </div>

          {/* Type filter + timezone indicator */}
           <div className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground px-2 py-1">
             🕐 Sydney
           </div>
           <Select value={filterType} onValueChange={setFilterType}>
             <SelectTrigger className="w-24 sm:w-36 h-9 text-sm">
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

          {/* Individual members */}
          {users.map(u => {
            const color = userColorMap.get(u.id);
            const isSelected = selectedUserIds.includes(u.id);
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
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0"
                  style={{ backgroundColor: color?.bg }}
                >
                  {getInitials(u.full_name || u.email)}
                </span>
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

      {eventsFetching && !eventsLoading && <div className="h-0.5 bg-primary/20 animate-pulse w-full" />}

      {/* ── Calendar grid ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0">
        {eventsLoading ? (
          <CalendarSkeleton view={view} />
        ) : (
        <ErrorBoundary fallbackLabel="Calendar View">
        {view === "month" && (
          <MonthView
            currentDate={currentDate}
            events={filteredEvents}
            users={users}
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
                  <MonthEventPill
                    key={event.id}
                    event={event}
                    owners={owners}
                    userColorMap={userColorMap}
                    users={users}
                    hasConflict={conflictSet.has(event.id)}
                    onClick={(e) => onEventClick(e, event)}
                  />
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
       className="rounded text-[11px] leading-tight px-1.5 py-0.5 cursor-pointer hover:opacity-80 hover:scale-[1.02] transition-all duration-150 flex items-center gap-1 min-w-0"
       style={{
         backgroundColor: isOverdue ? '#fef2f2' : typeColor.light,
         color: isOverdue ? '#dc2626' : typeColor.text,
         borderLeft: `3px solid ${isOverdue ? '#dc2626' : typeColor.border}`
       }}
       onClick={onClick}
       title={title || [event.title, startTime ? `at ${startTime}` : null, isOverdue ? 'Overdue' : null, sourceConfig?.tooltip].filter(Boolean).join(' - ')}
     >
      {owners.length > 1 && (
        <div className="flex -space-x-1 flex-shrink-0">
          {owners.slice(0, 2).map(uid => {
            const u = users.find(u => u.id === uid);
            const c = userColorMap.get(uid);
            return (
              <span key={uid}
                className="w-3 h-3 rounded-full border border-white text-white flex items-center justify-center text-[7px] font-bold"
                style={{ backgroundColor: c?.bg }}
              >
                {getInitials(u?.full_name || u?.email || '?')[0]}
              </span>
            );
          })}
        </div>
      )}
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

  // Compute booked hours per user per day for availability display
  const bookedHoursMap = useMemo(() => {
    const map = new Map(); // `${userId}-${dayIdx}` -> hours
    if (!isLaneMode) return map;
    days.forEach((d, di) => {
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
  }, [isLaneMode, events, users, days]);

  // Tonomo-style week view: full-width day columns with color-coded events per user
  // (Not sub-lanes — that's too cramped for 7 days. Color-coding by user is clearer.)
  if (isLaneMode && users.length > 0) {
    return (
      <div className="flex h-full">
        {/* Time gutter */}
        <div className="w-14 flex-shrink-0 border-r">
          <div className="border-b" style={{ height: 44 }} />
          {hours.map(h => (
            <div key={h} style={{ height: SLOT_HEIGHT }} className="border-b flex items-start justify-end pr-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {h === 0 ? '' : format(new Date(new Date().setHours(h, 0)), 'h a')}
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
                  <div key={h} data-hour={h} style={{ height: SLOT_HEIGHT }}
                    className="border-b hover:bg-muted/10 cursor-pointer group relative"
                    onDoubleClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellDoubleClick(dt); }}
                    onClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellClick(dt); }}
                  >
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/30 transition-opacity pointer-events-none select-none">+</span>
                  </div>
                ))}

                {/* Working hours end boundary */}
                <div className="absolute left-0 right-0 z-15 pointer-events-none" style={{ top: 44 + (19 * SLOT_HEIGHT) }}>
                  <div className="h-[2px] bg-red-400/40" />
                </div>

                {/* Current time indicator — BUG FIX: use Sydney time for positioning */}
                {isTodayCol && (() => {
                  const nowSyd = getSydneyHourMinute(now.toISOString());
                  const nowMin = nowSyd.hour * 60 + nowSyd.minute;
                  const topPx = (nowMin / 60) * SLOT_HEIGHT + 44;
                  return (
                    <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center" style={{ top: topPx }}>
                      <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 flex-shrink-0" />
                      <div className="flex-1 h-[2px] bg-red-500" />
                    </div>
                  );
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
                  const topPx = (startMin / 60) * SLOT_HEIGHT + 44;
                  const heightPx = Math.max(22, (durMin / 60) * SLOT_HEIGHT - 2);

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
                      className="absolute rounded-md px-1.5 py-0.5 cursor-pointer hover:brightness-110 hover:shadow-lg overflow-hidden z-10 flex flex-col transition-all duration-150"
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
                      title={`${event.title}\n${fmtSydneyTime(event.start_time)} - ${fmtSydneyTime(event.end_time)}${event.location ? '\n' + event.location : ''}`}
                    >
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
          <div key={h} data-hour={h} style={{ height: SLOT_HEIGHT }} className="border-b flex items-start justify-end pr-2 pt-1">
            <span className="text-xs text-muted-foreground">
              {h === 0 ? '' : format(new Date(new Date().setHours(h, 0)), 'h a')}
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
                  const evStart = evStartSyd.hour * 60 + evStartSyd.minute;
                  const evEnd = (evEndSyd.hour * 60 + evEndSyd.minute) || 24 * 60;
                  return evStart < slotEnd && evEnd > slotStart;
                });
                return (
                  <div
                    key={h}
                    data-hour={h}
                    style={{ height: SLOT_HEIGHT }}
                    className="border-b hover:bg-muted/10 cursor-pointer group relative"
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

              {/* Current time indicator line — BUG FIX: use Sydney time */}
              {isTodayCol && (() => {
                const nowSyd = getSydneyHourMinute(now.toISOString());
                const nowMin = nowSyd.hour * 60 + nowSyd.minute;
                const topPx = (nowMin / 60) * SLOT_HEIGHT;
                return (
                  <div
                    className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                    style={{ top: topPx + 40 /* offset for header */ }}
                  >
                    <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 flex-shrink-0" />
                    <div className="flex-1 h-[2px] bg-red-500" />
                  </div>
                );
              })()}

              {/* Duration blocks */}
              {dayItems.map(({ event, owners }) => (
                <StandardEventBlock
                  key={event.id}
                  event={event}
                  owners={owners}
                  userColorMap={userColorMap}
                  allUsers={users}
                  slotHeight={SLOT_HEIGHT}
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
      const scrollTarget = 7 * SLOT_HEIGHT; // 7am
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
              userColorMap={userColorMap} allUsers={users} slotHeight={SLOT_HEIGHT}
              isAllDay onClick={(e) => onEventClick(e, event)} />
          ))}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Time gutter */}
        <div className="w-14 flex-shrink-0 border-r">
          {hours.map(h => (
            <div key={h} style={{ height: SLOT_HEIGHT }} className="border-b flex items-start justify-end pr-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {h === 0 ? '' : format(new Date(new Date().setHours(h, 0)), 'h a')}
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
                  <div className="sticky top-0 z-10" style={{ height: HEADER_H }}>
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
                      <div key={h} style={{ height: SLOT_HEIGHT }}
                        className="border-b hover:bg-muted/10 cursor-pointer group"
                        onDoubleClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellDoubleClick(dt, u.id); }}
                        onClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellClick(dt, u.id); }}
                      >
                        <span className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/30 transition-opacity pointer-events-none select-none">+</span>
                      </div>
                    ))}

                    {/* Unavailable time shading */}
                    {getUnavailableRanges(u.id, currentDate).map((range, rIdx) => {
                      const topPx = (range.start / 60) * SLOT_HEIGHT;
                      const heightPx = ((range.end - range.start) / 60) * SLOT_HEIGHT;
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
                        const linePx = (endMin / 60) * SLOT_HEIGHT;
                        return (
                          <div className="absolute left-0 right-0 z-15 pointer-events-none" style={{ top: linePx }}>
                            <div className="h-[2px] bg-red-400/60" />
                          </div>
                        );
                      }
                      // Default: show line at 19:00 (7pm)
                      const defaultEnd = (19 * 60 / 60) * SLOT_HEIGHT;
                      return (
                        <div className="absolute left-0 right-0 z-15 pointer-events-none" style={{ top: defaultEnd }}>
                          <div className="h-[2px] bg-red-400/40" />
                        </div>
                      );
                    })()}

                    {/* Current time indicator — BUG FIX: use Sydney time */}
                    {isToday(currentDate) && (() => {
                      const n = new Date();
                      const nSyd = getSydneyHourMinute(n.toISOString());
                      const nowMin = nSyd.hour * 60 + nSyd.minute;
                      const topPx = (nowMin / 60) * SLOT_HEIGHT;
                      return (
                        <div className="absolute left-0 right-0 z-20 pointer-events-none flex items-center" style={{ top: topPx }}>
                          <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1 flex-shrink-0 shadow-sm" />
                          <div className="flex-1 h-[2px] bg-red-500" />
                        </div>
                      );
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
                       slotHeight={SLOT_HEIGHT}
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
              <div key={h} style={{ height: SLOT_HEIGHT }}
                className="border-b hover:bg-muted/10 cursor-pointer group relative"
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
                userColorMap={userColorMap} allUsers={users} slotHeight={SLOT_HEIGHT}
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
function StandardEventBlock({ event, owners, userColorMap, allUsers, slotHeight, isAllDay, userColor, headerOffset = 0, hasConflict, onClick }) {
  const typeColor = getEventTypeColor(event);

  if (isAllDay) {
    return (
      <div
        className="rounded px-2 py-0.5 text-xs cursor-pointer hover:opacity-80 truncate"
        style={{ backgroundColor: typeColor.light, color: typeColor.text, borderLeft: `3px solid ${typeColor.border}` }}
        onClick={onClick}
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

  const topPx = (startMinutes / 60) * slotHeight + headerOffset;
  const heightPx = Math.max(20, (durationMinutes / 60) * slotHeight - 2);

  const ownerUsers = owners.map(uid => allUsers.find(u => u.id === uid)).filter(Boolean);

  return (
    <div
      className="absolute left-1 right-1 rounded-md px-1.5 py-0.5 cursor-pointer hover:opacity-90 hover:shadow-lg overflow-hidden z-10 flex flex-col transition-all duration-150 border"
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
      title={`${event.title} (${fmtSydneyTime(event.start_time)} - ${fmtSydneyTime(event.end_time)})`}
    >
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
function LaneEventBlock({ event, owners, user, userIdx, totalUsers, userColorMap, allUsers, slotHeight, onClick, currentUserId, hasConflict, dayMode }) {
  const start = new Date(fixTimestamp(event.start_time));
  const end = event.end_time
    ? new Date(fixTimestamp(event.end_time))
    : new Date(start.getTime() + 60 * 60 * 1000);

  // BUG FIX: use Sydney hours for grid positioning, not local machine hours
  const startSyd = getSydneyHourMinute(event.start_time);
  const startMinutes = startSyd.hour * 60 + startSyd.minute;
  const durationMinutes = Math.max(15, differenceInMinutes(end, start));
  const topPx = (startMinutes / 60) * slotHeight;
  const heightPx = Math.max(24, (durationMinutes / 60) * slotHeight - 2);

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
      className="absolute rounded-lg px-2 py-1 cursor-pointer hover:brightness-110 hover:shadow-xl overflow-hidden z-10 flex flex-col transition-all duration-150"
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
      title={`${event.title || 'Untitled'}\n${fmtSydneyTime(event.start_time)} - ${fmtSydneyTime(event.end_time)}${event.location ? '\n' + event.location : ''}`}
    >
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