import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon,
  Users, User, RefreshCw, Search
} from "lucide-react";
import { expandRecurringEvent } from "@/components/calendar/CalendarEventUtils";
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  isSameMonth, isSameDay, isToday, differenceInMinutes, startOfDay
} from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
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
  
  const [view, setView] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) return 'day';
    return 'week';
  });
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
  const [dbCountdown, setDbCountdown] = useState(60);
  const [syncCountdown, setSyncCountdown] = useState(300);
  const dbCountdownRef = useRef(null);
  const syncCountdownRef = useRef(null);

  useEffect(() => {
    // DB countdown — resets every 60s
    setDbCountdown(60);
    dbCountdownRef.current = setInterval(() => {
      setDbCountdown(s => {
        if (s <= 1) { return 60; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(dbCountdownRef.current);
  }, []);

  useEffect(() => {
    // Google sync countdown — resets every 5 min
    setSyncCountdown(300);
    syncCountdownRef.current = setInterval(() => {
      setSyncCountdown(s => {
        if (s <= 1) { return 300; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(syncCountdownRef.current);
  }, []);

  const formatCountdown = (s) => s >= 60
    ? `${Math.floor(s / 60)}m ${s % 60}s`
    : `${s}s`;

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: currentUser } = useQuery({
    queryKey: ["current-user"],
    queryFn: () => base44.auth.me(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users-for-cal"],
    queryFn: () => base44.entities.User.list(),
    staleTime: 5 * 60 * 1000,
    onError: () => toast.error('Failed to load team members'),
  });

  const { data: connections = [] } = useQuery({
    queryKey: ["calendar-connections-all"],
    queryFn: () => base44.entities.CalendarConnection.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: allAvailability = [] } = useQuery({
    queryKey: ['photographer-availability-cal'],
    queryFn: () => base44.entities.PhotographerAvailability.list(),
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
      const all = await base44.entities.CalendarEvent.filter({
        start_time: {
          $gte: rangeStart.toISOString(),
          $lte: rangeEnd.toISOString(),
        }
      }, "-start_time", 500);
      return all || [];
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    onError: () => toast.error('Failed to load calendar events'),
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
      // FlexStudios events store recurrence as 'daily'/'weekly'/'monthly'
      // Google events (via incremental sync) may store recurrence_rule as JSON RRULE array
      const isRecurring = item.recurrence && item.recurrence !== 'none';
      if (isRecurring) {
        try {
          if (item.recurrence_rule) {
            // Google-style RRULE — parse and pass as recurrence
            const rule = JSON.parse(item.recurrence_rule);
            const instances = expandRecurringEvent({ ...item, recurrence: rule }, rangeStart, rangeEnd);
            result.push(...instances.slice(0, MAX_RECURRING_INSTANCES));
          } else {
            // FlexStudios-style — recurrence is already 'daily'/'weekly'/'monthly'
            const instances = expandRecurringEvent(item, rangeStart, rangeEnd);
            result.push(...instances.slice(0, MAX_RECURRING_INSTANCES));
          }
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
        // No google_event_id — not deduplicatable
        result.push({ event: ev, owners });
      }
    }

    return result;
  }, [expandedEvents, eventsByUser]);

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
        // Show: Tonomo bookings (any origin), project-linked events, webhook events
        const isTonomoEvent = event.event_source === 'tonomo' ||
          event.link_source === 'tonomo_webhook' ||
          event.tonomo_appointment_id;
        const isProjectLinked = !!event.project_id || event.auto_linked;
        if (!isTonomoEvent && !isProjectLinked) {
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
  }, [deduplicatedEvents, filterType, calendarMode, selectedUserIds, isContractor, permUser]);

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

  const handleCellClick = useCallback((date, userId = null) => {
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
        <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
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

          <h1 className="text-lg font-semibold min-w-[200px]">{headerLabel()}</h1>

          {/* Mode toggle */}
          <div className="flex gap-1 bg-muted rounded-lg p-0.5">
            <button
              onClick={() => setCalendarMode("flex")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 hover:scale-105 active:scale-95 ${
                calendarMode === "flex"
                  ? "bg-background shadow-md text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/50"
              }`}
              title="Show only project bookings and linked events"
            >
              📅 Flex
            </button>
            <button
              onClick={() => setCalendarMode("team")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 hover:scale-105 active:scale-95 ${
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
              className="h-9 pl-8 pr-12 rounded-md border bg-background text-sm w-48 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 transition-all duration-150 hover:border-primary/50"
            />
           {searchQuery && (
             <>
               <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 font-medium tabular-nums">{searchQuery.length}</span>
               <button
                 onClick={() => setSearchQuery("")}
                 className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded p-1 transition-colors duration-150"
                 title="Clear search (Esc)"
                 aria-label="Clear search"
                 >
                 ×
               </button>
             </>
           )}
          </div>

          {/* Type filter + timezone indicator */}
           <div className="flex items-center gap-1 text-xs text-muted-foreground px-2 py-1">
             🕐 Sydney
           </div>
           <Select value={filterType} onValueChange={setFilterType}>
             <SelectTrigger className="w-36 h-9 text-sm">
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
            <CalendarIcon className="h-4 w-4 mr-1" /> Connections
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
        <div className="flex items-center gap-2 px-4 py-2 border-t bg-muted/20 flex-wrap">
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
            onCellClick={handleCellClick}
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
            onCellClick={handleCellClick}
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
            onCellClick={handleCellClick}
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

function MonthView({ currentDate, events, users, userColorMap, onCellClick, onEventClick }) {
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
              className={`border-r border-b p-1 cursor-pointer hover:bg-muted/30 transition-all hover:shadow-inner min-h-[90px] ${!isCurrentMonth ? 'bg-muted/10' : ''}`}
              onClick={() => onCellClick(d)}
              title={`Click to create event on ${format(d, 'EEEE, d MMMM yyyy')}`}
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
                    onClick={(e) => onEventClick(e, event)}
                  />
                ))}
                {dayItems.length > 3 && (
                  <div className="text-xs text-muted-foreground pl-1">+{dayItems.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthEventPill({ event, owners, userColorMap, users, onClick, title }) {
   const typeColor = getEventTypeColor(event);
   const source = getEventSource(event);
   const sourceConfig = EVENT_SOURCE_CONFIG[source];
   const isOverdue = !event.is_done &&
     event.end_time &&
     new Date(fixTimestamp(event.end_time)) < new Date() &&
     source === 'flexmedia';

   const startTime = event.start_time ? format(new Date(fixTimestamp(event.start_time)), 'h:mm') : '';

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
      {event.event_source === 'tonomo' && <span className="text-[7px] opacity-50 flex-shrink-0 ml-auto">BK</span>}
    </div>
  );
}

// ── TEAM WEEK VIEW ────────────────────────────────────────────────────────────

function TeamWeekView({ currentDate, events, users, userColorMap, isLaneMode, allAvailability, currentUserId, onCellClick, onEventClick }) {
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const hours = Array.from({ length: 24 }, (_, i) => i);

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

  // Gap fix: Limit lane mode to 8 users max (unreadable beyond)
  const MAX_LANE_USERS = 8;
  if (isLaneMode && users.length > 0) {
    if (users.length > MAX_LANE_USERS) {
      return (
        <div className="flex items-center justify-center min-h-[200px] text-center">
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-1">Too many team members for lane view</p>
            <p className="text-xs">Select {MAX_LANE_USERS} or fewer team members to use lane mode</p>
          </div>
        </div>
      );
    }
    // LANE MODE: columns = days, sub-columns = users
    return (
      <div className="flex h-full">
        {/* Time gutter */}
        <div className="w-14 flex-shrink-0 border-r">
          <div className="border-b" style={{ height: 56 }} />
          {hours.map(h => (
            <div key={h} style={{ height: SLOT_HEIGHT }} className="border-b flex items-start justify-end pr-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {h === 0 ? '' : format(new Date().setHours(h, 0), 'h a')}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns, each split into user lanes */}
        <div className="flex-1 overflow-x-auto overflow-y-auto">
          <div className="flex" style={{ minWidth: days.length * users.length * 80 }}>
            {days.map((d, di) => (
              <div key={di} className="flex-1 border-r min-w-0">
                {/* Day header */}
                <div
                  className={`border-b text-center py-1 sticky top-0 bg-background z-10 ${isToday(d) ? 'bg-primary/5' : ''}`}
                  style={{ height: 56 }}
                >
                  <div className="text-xs text-muted-foreground">{format(d, 'EEE')}</div>
                  <div className={`text-sm font-medium ${isToday(d) ? 'text-primary' : ''}`}>{format(d, 'd MMM')}</div>
                  {/* User lane headers */}
                  <div className="flex border-t mt-0.5">
                    {users.map(u => {
                      const color = userColorMap.get(u.id);
                      return (
                        <div key={u.id} className="flex-1 flex items-center justify-center gap-1 py-0.5 border-r last:border-r-0">
                          <span
                            className="w-4 h-4 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
                            style={{ backgroundColor: color?.bg }}
                          >
                            {getInitials(u.full_name || u.email)[0]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Hour slots — split into user lanes */}
                <div className="relative">
                  {hours.map(h => (
                    <div key={h} className="flex" style={{ height: SLOT_HEIGHT }}>
                      {users.map(u => (
                        <div
                          key={u.id}
                          className="flex-1 border-r border-b last:border-r-0 hover:bg-muted/10 cursor-pointer relative group"
                          onClick={() => {
                            const dt = new Date(d);
                            dt.setHours(h, 0, 0, 0);
                            onCellClick(dt, u.id);
                          }}
                        >
                          <span className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/30 transition-all duration-200 pointer-events-none select-none">+</span>
                        </div>
                      ))}
                    </div>
                  ))}

                  {/* Unavailable time shading */}
                  {users.map((u, uIdx) => {
                    const ranges = getUnavailableRanges(u.id, d);
                    const laneWidth = 100 / users.length;
                    const leftPct = uIdx * laneWidth;
                    return ranges.map((range, rIdx) => {
                      const topPx = (range.start / 60) * SLOT_HEIGHT;
                      const heightPx = ((range.end - range.start) / 60) * SLOT_HEIGHT;
                      return (
                        <div
                          key={`${u.id}-${rIdx}`}
                          className="absolute bg-muted/30 pointer-events-none"
                          style={{
                            top: topPx,
                            height: heightPx,
                            left: `${leftPct}%`,
                            width: `${laneWidth}%`,
                          }}
                        />
                      );
                    });
                  })}

                  {/* Events rendered as positioned blocks */}
                  {users.map((u, uIdx) => {
                   const userEvents = events.filter(({ owners }) => owners.includes(u.id))
                     .filter(({ event }) => event.start_time && !event.is_all_day && isSameDay(new Date(fixTimestamp(event.start_time)), d));

                   return userEvents.map(({ event, owners }) => (
                    <LaneEventBlock
                      key={`${event.id}-${u.id}`}
                      event={event}
                      owners={owners}
                      user={u}
                      userIdx={uIdx}
                      totalUsers={users.length}
                      userColorMap={userColorMap}
                      allUsers={users}
                      slotHeight={SLOT_HEIGHT}
                      currentUserId={currentUserId}
                      onClick={(e) => onEventClick(e, event)}
                    />
                   ));
                  })}

                  {/* Current time indicator line (lane mode) */}
                  {isToday(d) && (() => {
                    const n = new Date();
                    const nowMin = n.getHours() * 60 + n.getMinutes();
                    const topPx = (nowMin / 60) * SLOT_HEIGHT;
                    return (
                      <div
                        className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                        style={{ top: topPx }}
                      >
                        <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 flex-shrink-0" />
                        <div className="flex-1 h-[2px] bg-red-500" />
                      </div>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // STANDARD mode (single user selected)
  // Current time indicator state
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-full">
      <div className="w-14 flex-shrink-0 border-r">
        <div className="border-b" style={{ height: 40 }} />
        {hours.map(h => (
          <div key={h} data-hour={h} style={{ height: SLOT_HEIGHT }} className="border-b flex items-start justify-end pr-2 pt-1">
            <span className="text-xs text-muted-foreground">
              {h === 0 ? '' : format(new Date().setHours(h, 0), 'h a')}
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
                  const evStart = s.getHours() * 60 + s.getMinutes();
                  const evEnd = e.getHours() * 60 + e.getMinutes() || 24 * 60;
                  return evStart < slotEnd && evEnd > slotStart;
                });
                return (
                  <div
                    key={h}
                    data-hour={h}
                    style={{ height: SLOT_HEIGHT }}
                    className="border-b hover:bg-muted/10 cursor-pointer group relative"
                    onClick={() => { const dt = new Date(d); dt.setHours(h,0,0,0); onCellClick(dt); }}
                  >
                    {/* Click to add hint on empty slots */}
                    {!slotHasEvent && (
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-all duration-200 pointer-events-none select-none">
                        + Click to add
                      </span>
                    )}
                  </div>
                );
              })}

              {/* Current time indicator line */}
              {isTodayCol && (() => {
                const nowMin = now.getHours() * 60 + now.getMinutes();
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

function TeamDayView({ currentDate, events, users, userColorMap, isLaneMode, allAvailability, currentUserId, onCellClick, onEventClick }) {
  const hours = Array.from({ length: 24 }, (_, i) => i);

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
                {h === 0 ? '' : format(new Date().setHours(h, 0), 'h a')}
              </span>
            </div>
          ))}
        </div>

        {isLaneMode && users.length > 1 ? (
          /* Lane mode: each user gets a column */
          <div className="flex flex-1 overflow-y-auto">
            {users.map((u, uIdx) => {
              const color = userColorMap.get(u.id);
              const userItems = timedItems.filter(({ owners }) => owners.includes(u.id));
              return (
                <div key={u.id} className="flex-1 border-r relative">
                  {/* User header */}
                  <div className="sticky top-0 bg-background border-b z-10 flex items-center justify-center gap-2 py-2">
                    <span className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center"
                      style={{ backgroundColor: color?.bg }}>
                      {getInitials(u.full_name || u.email)}
                    </span>
                    <span className="text-xs font-medium">{u.full_name?.split(' ')[0]}</span>
                  </div>
                  {hours.map(h => (
                    <div key={h} style={{ height: SLOT_HEIGHT }}
                      className="border-b hover:bg-muted/10 cursor-pointer"
                      onClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellClick(dt, u.id); }}
                    />
                  ))}

                  {/* Unavailable time shading */}
                  {getUnavailableRanges(u.id, currentDate).map((range, rIdx) => {
                    const topPx = (range.start / 60) * SLOT_HEIGHT;
                    const heightPx = ((range.end - range.start) / 60) * SLOT_HEIGHT;
                    return (
                      <div
                        key={rIdx}
                        className="absolute left-0 right-0 bg-muted/30 pointer-events-none"
                        style={{ top: topPx, height: heightPx }}
                      />
                    );
                  })}

                  {userItems.map(({ event, owners }) => (
                   <LaneEventBlock
                     key={event.id}
                     event={event}
                     owners={owners}
                     user={u}
                     userIdx={uIdx}
                     totalUsers={users.length}
                     userColorMap={userColorMap}
                     allUsers={users}
                     slotHeight={SLOT_HEIGHT}
                     currentUserId={currentUserId}
                     onClick={(e) => onEventClick(e, event)}
                   />
                  ))}
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
                onClick={() => { const dt = new Date(currentDate); dt.setHours(h,0,0,0); onCellClick(dt); }}
              >
                <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-all duration-200 pointer-events-none select-none">
                  + Click to add event
                </span>
              </div>
            ))}
            {timedItems.map(({ event, owners }) => (
              <StandardEventBlock key={event.id} event={event} owners={owners}
                userColorMap={userColorMap} allUsers={users} slotHeight={SLOT_HEIGHT}
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
function StandardEventBlock({ event, owners, userColorMap, allUsers, slotHeight, isAllDay, userColor, headerOffset = 0, onClick }) {
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

  const startMinutes = start.getHours() * 60 + start.getMinutes();
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
      title={`${event.title} (${format(start, 'h:mm a')} - ${format(end, 'h:mm a')})`}
    >
      <p className="text-xs font-semibold leading-tight truncate">{event.title}</p>
      {heightPx > 30 && (
        <p className="text-[11px] opacity-70 leading-tight">{format(start, 'h:mm')} - {format(end, 'h:mm a')}</p>
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

// Block for lane (team) view — positioned within a specific user's sub-column
function LaneEventBlock({ event, owners, user, userIdx, totalUsers, userColorMap, allUsers, slotHeight, onClick, currentUserId }) {
  const start = new Date(fixTimestamp(event.start_time));
  const end = event.end_time
    ? new Date(fixTimestamp(event.end_time))
    : new Date(start.getTime() + 60 * 60 * 1000);

  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const durationMinutes = Math.max(15, differenceInMinutes(end, start));
  const topPx = (startMinutes / 60) * slotHeight;
  const heightPx = Math.max(20, (durationMinutes / 60) * slotHeight - 2);

  // Position within the day column based on user index
  const laneWidth = 100 / totalUsers;
  const leftPct = userIdx * laneWidth;

  const typeColor = getEventTypeColor(event);
  const ownerUsers = owners.map(uid => allUsers.find(u => u.id === uid)).filter(Boolean);

  // Privacy: show as opaque "Busy" block if event belongs to another user
  // and their connection has show_busy_only policy
  const isBusyBlock = event.connection_visibility_policy === 'show_busy_only' &&
    event.owner_user_id &&
    event.owner_user_id !== currentUserId;

  // Special Google event types override colors
  const isOutOfOffice = event.google_event_type === 'outOfOffice';
  const isFocusTime = event.google_event_type === 'focusTime';

  const bgColor = isOutOfOffice
    ? 'repeating-linear-gradient(45deg, #fef3c7, #fef3c7 4px, #fde68a 4px, #fde68a 8px)'
    : isFocusTime ? '#f0f9ff'
    : typeColor.light;
  const borderColor = isOutOfOffice ? '#f59e0b' : isFocusTime ? '#0ea5e9' : typeColor.border;
  const textColor = isOutOfOffice ? '#92400e' : isFocusTime ? '#0c4a6e' : typeColor.text;

  return (
    <div
      className="absolute rounded-md px-1 py-0.5 cursor-pointer hover:opacity-90 hover:shadow-lg overflow-hidden z-10 flex flex-col transition-all duration-150 border"
      style={{
        top: topPx,
        height: heightPx,
        left: `calc(${leftPct}% + 1px)`,
        width: `calc(${laneWidth}% - 2px)`,
        backgroundColor: bgColor,
        borderLeft: `4px solid ${borderColor}`,
        borderColor: `${borderColor}40`,
        borderLeftColor: borderColor,
        color: textColor,
      }}
      onClick={onClick}
      title={`${event.title} - ${format(start, 'h:mm')} - ${format(end, 'h:mm a')}`}
    >
      <p className="text-xs font-semibold leading-tight truncate">
        {isBusyBlock ? 'Busy' :
         isOutOfOffice ? 'Out of Office' :
         isFocusTime ? 'Focus Time' :
         event.title}
      </p>
      {heightPx > 28 && (
        <p className="text-[11px] opacity-70 leading-tight">{format(start, 'h:mm')} - {format(end, 'h:mm a')}</p>
      )}
      {heightPx > 52 && event.location && (
        <p className="text-[10px] opacity-50 leading-tight truncate mt-0.5">{event.location}</p>
      )}
      {heightPx > 40 && ownerUsers.length > 1 && (
        <div className="flex -space-x-0.5 mt-0.5">
          {ownerUsers.filter(u => u.id !== user.id).slice(0, 3).map(u => {
            const c = userColorMap.get(u.id);
            return (
              <span key={u.id}
                className="w-3 h-3 rounded-full border border-white text-white flex items-center justify-center text-[7px] font-bold"
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