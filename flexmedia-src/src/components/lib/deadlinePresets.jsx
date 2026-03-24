/**
 * Timezone-aware deadline preset calculator — mirrors the backend engine exactly.
 * ALL deadlines are computed in Australia/Sydney local time and stored as UTC ISO strings.
 */

export const APP_TIMEZONE = 'Australia/Sydney';

export function getLocalDateComponents(utcInstant, timezone) {
  const d = new Date(utcInstant);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value ?? '0';
  const hour = parseInt(get('hour'), 10) % 24;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get('year'), 10),
    month0: parseInt(get('month'), 10) - 1,
    day: parseInt(get('day'), 10),
    hour, minute: parseInt(get('minute'), 10), second: parseInt(get('second'), 10),
    weekday0: wdMap[get('weekday')] ?? -1
  };
}

export function wallClockToUTC(year, month0, day, hours, minutes, seconds, timezone) {
  const targetLocalMs = Date.UTC(year, month0, day, hours, minutes, seconds);
  let utcMs = targetLocalMs;
  for (let i = 0; i < 5; i++) {
    const c = getLocalDateComponents(utcMs, timezone);
    const shown = Date.UTC(c.year, c.month0, c.day, c.hour, c.minute, c.second);
    const diff = shown - targetLocalMs;
    if (diff === 0) break;
    utcMs -= diff;
  }
  return new Date(utcMs);
}

function addLocalDays(year, month0, day, n) {
  const d = new Date(Date.UTC(year, month0, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() };
}

function localWeekday(year, month0, day) {
  return new Date(Date.UTC(year, month0, day, 12, 0, 0)).getUTCDay();
}

function isBusinessDay(wd) { return wd >= 1 && wd <= 5; }

function nextBusinessDay(year, month0, day, n = 1) {
  let cur = { year, month0, day }; let count = 0;
  while (count < n) {
    cur = addLocalDays(cur.year, cur.month0, cur.day, 1);
    if (isBusinessDay(localWeekday(cur.year, cur.month0, cur.day))) count++;
  }
  return cur;
}

/**
 * Calculate a deadline UTC Date from a preset name and trigger time.
 * @param {string} preset - deadline_preset enum value
 * @param {Date|string} triggerTime - UTC instant of the triggering event (default: now)
 * @param {string} timezone - IANA timezone string (default: APP_TIMEZONE)
 * @returns {Date|null}
 */
export function calculatePresetDeadline(preset, triggerTime = new Date(), timezone = APP_TIMEZONE) {
  const trigger = new Date(triggerTime);
  if (isNaN(trigger.getTime())) return null;

  const lc = getLocalDateComponents(trigger, timezone);
  const dl = (y, m0, d, h, mi, s) => wallClockToUTC(y, m0, d, h, mi, s, timezone);

  const sameDayOrNext = (h, mi, s) => {
    const c = dl(lc.year, lc.month0, lc.day, h, mi, s);
    if (trigger >= c) {
      const nx = addLocalDays(lc.year, lc.month0, lc.day, 1);
      return dl(nx.year, nx.month0, nx.day, h, mi, s);
    }
    return c;
  };

  switch (preset) {
    case 'tonight':
      return sameDayOrNext(23, 59, 59);
    case 'tomorrow_night': {
      const n = addLocalDays(lc.year, lc.month0, lc.day, 1);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    case 'tomorrow_am': {
      const n = addLocalDays(lc.year, lc.month0, lc.day, 1);
      return dl(n.year, n.month0, n.day, 11, 59, 59);
    }
    case 'tomorrow_business_am': {
      const n = nextBusinessDay(lc.year, lc.month0, lc.day, 1);
      return dl(n.year, n.month0, n.day, 11, 59, 59);
    }
    case 'in_2_nights': {
      const n = addLocalDays(lc.year, lc.month0, lc.day, 2);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    case 'in_3_nights': {
      const n = addLocalDays(lc.year, lc.month0, lc.day, 3);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    case 'in_4_nights': {
      const n = addLocalDays(lc.year, lc.month0, lc.day, 4);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    case 'next_business_night': {
      const n = nextBusinessDay(lc.year, lc.month0, lc.day, 1);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    case '2_business_nights': {
      const n = nextBusinessDay(lc.year, lc.month0, lc.day, 2);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    case '3_business_nights': {
      const n = nextBusinessDay(lc.year, lc.month0, lc.day, 3);
      return dl(n.year, n.month0, n.day, 23, 59, 59);
    }
    default:
      return null;
  }
}