import { parseISO, format } from 'date-fns';
import { DATE_FIELD_REGISTRY } from './entityDateFields';
import { fixTimestamp } from './dateUtils';

const APP_TZ = 'Australia/Sydney';

function fmtDateOnly(str, pattern = 'd MMM yyyy') {
  if (!str) return '—';
  try {
    return format(parseISO(String(str).substring(0, 10)), pattern);
  } catch {
    return '—';
  }
}

function fmtTS(utcStr, opts = {}) {
  if (!utcStr) return '—';
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone: APP_TZ, ...opts }).format(new Date(fixTimestamp(utcStr)));
  } catch {
    return '—';
  }
}

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
    const yestDay = toDay(new Date(Date.now() - 86400000).toISOString());
    const timeStr = fmtTS(utcStr, { hour: '2-digit', minute: '2-digit', hour12: true });
    const diffDays = Math.floor((Date.now() - new Date(fixTimestamp(utcStr)).getTime()) / 86400000);

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