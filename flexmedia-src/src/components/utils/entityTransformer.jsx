import { DATE_FIELD_REGISTRY } from './entityDateFields';
import { fmtDate as fmtDateOnly, fmtTimestampCustom as fmtTS, fixTimestamp, APP_TZ } from './dateUtils';

function relativeTime(utcStr) {
  if (!utcStr) return '';
  try {
    const toDay = s => new Intl.DateTimeFormat('en-AU', {
      timeZone: APP_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(fixTimestamp(s)));

    const sydDay = toDay(utcStr);
    const todayDay = toDay(new Date().toISOString());
    // BUG FIX: 86400000ms hardcoded day is wrong during DST transitions (23h or 25h days).
    // Instead, compute yesterday by formatting (today - 25h) which always crosses midnight
    // even on a 25h DST day, and then use the Intl formatter which handles DST correctly.
    const yestDay = (() => {
      // Subtract 25 hours to guarantee we land in the previous calendar day in any timezone
      const yest = new Date(Date.now() - 25 * 3600000);
      // But we need the *actual* previous calendar day in Sydney, so use Intl:
      return toDay(yest.toISOString());
    })();
    const timeStr = fmtTS(utcStr, { hour: '2-digit', minute: '2-digit', hour12: true });
    // BUG FIX: use calendar-day-based diff in Sydney TZ instead of raw ms division
    const parseSydneyDate = (s) => {
      const parts = toDay(s).split('/');
      return new Date(parts[2], parts[1] - 1, parts[0]);
    };
    const diffDays = Math.round((parseSydneyDate(new Date().toISOString()) - parseSydneyDate(utcStr)) / 86400000);

    if (sydDay === todayDay) return `Today at ${timeStr}`;
    if (sydDay === yestDay) return `Yesterday at ${timeStr}`;
    if (diffDays < 7) return `${fmtTS(utcStr, { weekday: 'long' })} at ${timeStr}`;
    return `${fmtTS(utcStr, { day: 'numeric', month: 'short', year: 'numeric' })} at ${timeStr}`;
  } catch {
    return '';
  }
}

export function decorateEntity(entityName, entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const result = { ...entity };

  for (const field of DATE_FIELD_REGISTRY.dateOnly[entityName] || []) {
    if (entity[field] !== undefined) {
      result[`_${field}_display`] = fmtDateOnly(entity[field]);
    }
  }

  for (const field of DATE_FIELD_REGISTRY.timestamp[entityName] || []) {
    if (entity[field] !== undefined) {
      const v = entity[field];
      result[`_${field}_display`] = fmtTS(v, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      result[`_${field}_display_short`] = fmtTS(v, {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      result[`_${field}_display_date`] = fmtTS(v, {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
      result[`_${field}_display_time`] = fmtTS(v, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      result[`_${field}_relative`] = relativeTime(v);
    }
  }

  return result;
}

export function decorateEntities(entityName, entities) {
  if (!Array.isArray(entities)) return entities;
  return entities.map(e => decorateEntity(entityName, e));
}