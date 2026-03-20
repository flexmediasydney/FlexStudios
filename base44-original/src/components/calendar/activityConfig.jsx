import {
  Users, Phone, CheckSquare, AlertCircle, Mail, Coffee, Calendar
} from 'lucide-react';

export const ACTIVITY_TYPES = {
  meeting:  { label: 'Meeting',  Icon: Users,         color: '#3b82f6', bgColor: '#eff6ff' },
  call:     { label: 'Call',     Icon: Phone,         color: '#10b981', bgColor: '#f0fdf4' },
  task:     { label: 'Task',     Icon: CheckSquare,   color: '#8b5cf6', bgColor: '#f5f3ff' },
  deadline: { label: 'Deadline', Icon: AlertCircle,   color: '#ef4444', bgColor: '#fef2f2' },
  email:    { label: 'Email',    Icon: Mail,          color: '#f59e0b', bgColor: '#fffbeb' },
  lunch:    { label: 'Lunch',    Icon: Coffee,        color: '#ec4899', bgColor: '#fdf2f8' },
  other:    { label: 'Other',    Icon: Calendar,      color: '#6b7280', bgColor: '#f9fafb' },
};

export const ACTIVITY_TYPE_LIST = Object.entries(ACTIVITY_TYPES).map(([key, val]) => ({
  key,
  ...val,
}));

export function getActivityType(key) {
  return ACTIVITY_TYPES[key] || ACTIVITY_TYPES.other;
}

// ── Event source utilities ─────────────────────────────────────────────────
// Single canonical way to determine where a CalendarEvent came from.
// Uses the event_source field if set, otherwise derives from legacy fields
// for backward compatibility with events created before this change.

export function getEventSource(event) {
  if (!event) return 'flexmedia';
  if (event.event_source) return event.event_source;
  // Derive from legacy fields
  if (event.tonomo_appointment_id || event.link_source === 'tonomo_webhook') return 'tonomo';
  if (event.is_synced === true || event.calendar_account) return 'google';
  return 'flexmedia';
}

// Whether the event can be edited inside FlexMedia.
// Two conditions must both be true:
//   1. The event is a native FlexMedia event (not Tonomo or Google-synced)
//   2. The current user is the creator (created_by_user_id matches)
// currentUserId is the UUID from useCurrentUser().data.id
// If currentUserId is not provided, only the source check applies (fallback for
// components that haven't been updated yet).
export function isEventEditable(event, currentUserId) {
  if (getEventSource(event) !== 'flexmedia') return false;
  // New event being created — always editable
  if (!event?.id) return true;
  // If we have no user context yet, be conservative and allow (loading state)
  if (!currentUserId) return true;
  // Ownership check: must be the creator
  return event.created_by_user_id === currentUserId;
}

// Whether the current user can mark this event done or add an outcome note.
// Allowed for: your own flexmedia events, and Tonomo shoot events (marking attendance).
// NOT allowed for: Google-synced blockers, other users' flexmedia events.
export function canMarkDone(event, currentUserId) {
  const source = getEventSource(event);
  if (source === 'google') return false;
  if (source === 'tonomo') return true; // marking shoot attendance is always allowed
  // flexmedia: only the creator
  if (!event?.id) return true;
  if (!currentUserId) return true;
  return event.created_by_user_id === currentUserId;
}

// Whether the current user can link this event to a project or contact.
// Project linking is always permitted regardless of source or ownership —
// it's an annotation, not a modification of the event itself.
export function canLinkToProject(event) {
  return true;
}

// Whether the current user owns this event (is the creator).
export function isEventOwner(event, currentUserId) {
  if (!event?.id || !currentUserId) return false;
  return event.created_by_user_id === currentUserId;
}

// Link back to the external system for non-native events.
export function getEventExternalUrl(event) {
  const source = getEventSource(event);
  if (source === 'google') return event.google_html_link || null;
  // Tonomo: no direct order URL available yet from stored data
  return null;
}

// Visual config per source
export const EVENT_SOURCE_CONFIG = {
  tonomo: {
    label: 'Booking',
    badgeBg: '#f5f3ff',
    badgeText: '#6d28d9',
    badgeBorder: '#c4b5fd',
    icon: '📅',
    tooltip: 'Managed by Tonomo — edit in Tonomo to make changes',
  },
  google: {
    label: 'External',
    badgeBg: '#eff6ff',
    badgeText: '#1d4ed8',
    badgeBorder: '#93c5fd',
    icon: 'G',
    tooltip: 'Synced from Google Calendar — edit in Google Calendar',
  },
  flexmedia: {
    label: null, // no badge for native events
    icon: null,
    tooltip: null,
  },
};