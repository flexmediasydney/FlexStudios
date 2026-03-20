// Calendar utilities for handling advanced event features
import { addDays, addWeeks, addMonths } from 'date-fns';

/**
 * Fix #6: Generate recurring event instances
 * Expands a recurring event into individual instances for display
 */
export function expandRecurringEvent(event, startDate, endDate) {
  if (!event) return [];
  if (!event.start_time || event.recurrence === 'none' || !event.recurrence) return [event];

  try {
    const instances = [event];
    let current = new Date(event.start_time);
    if (isNaN(current.getTime())) return [event];

    // Calculate event duration once (in ms) — avoids day-of-month arithmetic bug
    const durationMs = event.end_time
      ? new Date(event.end_time).getTime() - new Date(event.start_time).getTime()
      : 0;

    // Honour recurrence_end_date if the event has one, otherwise cap to 1 year
    const maxEndDate = addMonths(new Date(), 12);
    let effectiveEndDate = endDate < maxEndDate ? endDate : maxEndDate;
    if (event.recurrence_end_date) {
      const recEnd = new Date(event.recurrence_end_date);
      if (!isNaN(recEnd.getTime()) && recEnd < effectiveEndDate) {
        effectiveEndDate = recEnd;
      }
    }

    const maxIterations = 1000;
    let iterations = 0;

    while (current < effectiveEndDate && iterations < maxIterations) {
      iterations++;
      if (event.recurrence === 'daily') {
        current = addDays(current, 1);
      } else if (event.recurrence === 'weekly') {
        current = addWeeks(current, 1);
      } else if (event.recurrence === 'monthly') {
        current = addMonths(current, 1);
      } else {
        break;
      }
    
      if (current >= startDate) {
        instances.push({
          ...event,
          start_time: current.toISOString(),
          end_time: durationMs > 0 ? new Date(current.getTime() + durationMs).toISOString() : null,
          _recurrence_instance: true,
        });
      }
    }
    
    return instances;
  } catch {
    return [event];
  }
}

/**
 * Fix #4: Detect overlapping events for better rendering
 */
export function calculateEventPosition(event, slotEvents) {
  if (!event || !Array.isArray(slotEvents)) return { index: 0, total: 1 };
  
  const overlapping = slotEvents.filter(e => {
    if (!e?.start_time || !event?.start_time) return false;
    try {
      const eStart = new Date(e.start_time);
      const eEnd = e.end_time ? new Date(e.end_time) : new Date(eStart.getTime() + 60 * 60 * 1000);
      const eventStart = new Date(event.start_time);
      const eventEnd = event.end_time ? new Date(event.end_time) : new Date(eventStart.getTime() + 60 * 60 * 1000);
      return eStart < eventEnd && eEnd > eventStart;
    } catch {
      return false;
    }
  });
  
  const index = overlapping.findIndex(e => e?.id === event?.id);
  return { index: index >= 0 ? index : 0, total: Math.max(overlapping.length, 1) };
}

/**
 * Parse attendees JSON safely
 */
export function parseAttendees(attendeesJson) {
  if (!attendeesJson) return [];
  try {
    return JSON.parse(attendeesJson);
  } catch {
    return [];
  }
}