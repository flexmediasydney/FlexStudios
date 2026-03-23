import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fixTimestamp,
  APP_TZ,
  parseDate,
  fmtDate,
  fmtTimestampCustom,
  isOverdue,
  todaySydney,
  daysAgo,
  hoursAgo,
  minutesAgo,
  formatRelative,
  getDateRange,
  isSameDay,
  isBefore,
  isAfter,
  isBetween,
  utcToSydneyInput,
  sydneyInputToUtc,
  formatDurationCompact,
  formatDurationFull,
} from '../dateUtils';

// ─── fixTimestamp ──────────────────────────────────────────────────────────────

describe('fixTimestamp', () => {
  it('returns null/undefined/falsy values as-is', () => {
    expect(fixTimestamp(null)).toBeNull();
    expect(fixTimestamp(undefined)).toBeUndefined();
    expect(fixTimestamp('')).toBe('');
  });

  it('returns non-string values as-is', () => {
    expect(fixTimestamp(12345)).toBe(12345);
  });

  it('leaves date-only strings (<=10 chars) untouched', () => {
    expect(fixTimestamp('2026-03-10')).toBe('2026-03-10');
    expect(fixTimestamp('2026-03')).toBe('2026-03');
  });

  it('appends Z to bare timestamps without timezone info', () => {
    expect(fixTimestamp('2026-03-10T13:29:00')).toBe('2026-03-10T13:29:00Z');
    expect(fixTimestamp('2026-03-10T00:00:00.000')).toBe('2026-03-10T00:00:00.000Z');
  });

  it('does not double-append Z if already present', () => {
    expect(fixTimestamp('2026-03-10T13:29:00Z')).toBe('2026-03-10T13:29:00Z');
  });

  it('leaves strings with + offset untouched', () => {
    expect(fixTimestamp('2026-03-10T13:29:00+11:00')).toBe('2026-03-10T13:29:00+11:00');
  });

  it('leaves strings with - offset untouched', () => {
    expect(fixTimestamp('2026-03-10T13:29:00-05:00')).toBe('2026-03-10T13:29:00-05:00');
  });
});

// ─── parseDate ────────────────────────────────────────────────────────────────

describe('parseDate', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('parses a valid date-only string', () => {
    const d = parseDate('2026-03-10');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March = 2
    expect(d.getDate()).toBe(10);
  });

  it('truncates full timestamps to date-only', () => {
    const d = parseDate('2026-03-10T13:29:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2026);
  });

  it('returns Invalid Date for garbage input', () => {
    const result = parseDate('not-a-date');
    expect(result instanceof Date && isNaN(result)).toBe(true);
  });
});

// ─── fmtDate ──────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('returns dash for null', () => {
    expect(fmtDate(null)).toBe('—');
  });

  it('formats a date-only string with default pattern', () => {
    const result = fmtDate('2026-03-10');
    expect(result).toBe('10 Mar 2026');
  });

  it('formats with custom pattern', () => {
    const result = fmtDate('2026-12-25', 'yyyy/MM/dd');
    expect(result).toBe('2026/12/25');
  });

  it('returns dash for invalid date', () => {
    expect(fmtDate('not-a-date')).toBe('—');
  });
});

// ─── fmtTimestampCustom ───────────────────────────────────────────────────────

describe('fmtTimestampCustom', () => {
  it('returns dash for null/undefined', () => {
    expect(fmtTimestampCustom(null)).toBe('—');
    expect(fmtTimestampCustom(undefined)).toBe('—');
  });

  it('formats a UTC timestamp into Sydney time', () => {
    // 2026-01-15T00:00:00Z = 15 Jan 2026 11:00 AM AEDT (UTC+11 in Jan)
    const result = fmtTimestampCustom('2026-01-15T00:00:00Z', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    expect(result).toContain('Jan');
    expect(result).toContain('2026');
  });

  it('handles bare timestamps (no Z) via fixTimestamp', () => {
    const result = fmtTimestampCustom('2026-01-15T00:00:00', {
      day: 'numeric', month: 'short',
    });
    expect(result).toContain('Jan');
  });

  it('returns dash for garbage', () => {
    expect(fmtTimestampCustom('garbage')).toBe('—');
  });
});

// ─── todaySydney ──────────────────────────────────────────────────────────────

describe('todaySydney', () => {
  it('returns a string in yyyy-MM-dd format', () => {
    const result = todaySydney();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── APP_TZ ───────────────────────────────────────────────────────────────────

describe('APP_TZ', () => {
  it('is Australia/Sydney', () => {
    expect(APP_TZ).toBe('Australia/Sydney');
  });
});

// ─── daysAgo / hoursAgo / minutesAgo ──────────────────────────────────────────

describe('daysAgo', () => {
  it('returns 0 for now', () => {
    expect(daysAgo(new Date().toISOString())).toBe(0);
  });

  it('returns positive number for past dates', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(daysAgo(threeDaysAgo)).toBeGreaterThanOrEqual(2);
    expect(daysAgo(threeDaysAgo)).toBeLessThanOrEqual(4);
  });
});

describe('hoursAgo', () => {
  it('returns small number for recent timestamps', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(hoursAgo(twoHoursAgo)).toBeGreaterThanOrEqual(1);
    expect(hoursAgo(twoHoursAgo)).toBeLessThanOrEqual(3);
  });
});

describe('minutesAgo', () => {
  it('returns correct minutes', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60000).toISOString();
    expect(minutesAgo(tenMinAgo)).toBeGreaterThanOrEqual(9);
    expect(minutesAgo(tenMinAgo)).toBeLessThanOrEqual(11);
  });
});

// ─── formatRelative ──────────────────────────────────────────────────────────

describe('formatRelative', () => {
  it('returns "just now" for very recent timestamps', () => {
    expect(formatRelative(new Date().toISOString())).toBe('just now');
  });

  it('returns minutes for < 1 hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatRelative(fiveMinAgo)).toMatch(/^\d+m ago$/);
  });

  it('returns hours for < 24 hours', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    expect(formatRelative(threeHoursAgo)).toMatch(/^\d+h ago$/);
  });

  it('returns days for < 7 days', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    expect(formatRelative(twoDaysAgo)).toMatch(/^\d+d ago$/);
  });

  it('returns weeks for < 30 days', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    expect(formatRelative(twoWeeksAgo)).toMatch(/^\d+w ago$/);
  });

  it('returns months for < 365 days', () => {
    const threeMonthsAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    expect(formatRelative(threeMonthsAgo)).toMatch(/^\d+mo ago$/);
  });

  it('returns years for >= 365 days', () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 86400000).toISOString();
    expect(formatRelative(twoYearsAgo)).toMatch(/^\d+y ago$/);
  });
});

// ─── getDateRange ─────────────────────────────────────────────────────────────

describe('getDateRange', () => {
  it('returns start and end for "today"', () => {
    const range = getDateRange('today');
    expect(range).toHaveProperty('start');
    expect(range).toHaveProperty('end');
    expect(range.start).toBeInstanceOf(Date);
    expect(range.end).toBeInstanceOf(Date);
    expect(range.end.getTime()).toBeGreaterThan(range.start.getTime());
  });

  it('returns a range for "week"', () => {
    const range = getDateRange('week');
    const diffMs = range.end.getTime() - range.start.getTime();
    const diffDays = diffMs / 86400000;
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(8);
  });

  it('returns undefined for unknown type', () => {
    expect(getDateRange('decade')).toBeUndefined();
  });
});

// ─── isSameDay / isBefore / isAfter / isBetween ──────────────────────────────

describe('isSameDay', () => {
  it('returns true for same day timestamps', () => {
    // Use times that are same day in any timezone
    expect(isSameDay('2026-03-10T10:00:00Z', '2026-03-10T12:00:00Z')).toBe(true);
  });

  it('returns false for different days', () => {
    expect(isSameDay('2026-03-10T01:00:00Z', '2026-03-11T01:00:00Z')).toBe(false);
  });
});

describe('isBefore', () => {
  it('returns true when first date is earlier', () => {
    expect(isBefore('2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z')).toBe(true);
  });

  it('returns false when first date is later', () => {
    expect(isBefore('2026-03-11T00:00:00Z', '2026-03-10T00:00:00Z')).toBe(false);
  });
});

describe('isAfter', () => {
  it('returns true when first date is later', () => {
    expect(isAfter('2026-03-11T00:00:00Z', '2026-03-10T00:00:00Z')).toBe(true);
  });
});

describe('isBetween', () => {
  it('returns true when date is in range', () => {
    expect(isBetween('2026-03-10T12:00:00Z', '2026-03-10T00:00:00Z', '2026-03-10T23:59:59Z')).toBe(true);
  });

  it('returns false when date is out of range', () => {
    expect(isBetween('2026-03-09T00:00:00Z', '2026-03-10T00:00:00Z', '2026-03-10T23:59:59Z')).toBe(false);
  });

  it('returns true at boundaries (inclusive)', () => {
    expect(isBetween('2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z', '2026-03-10T23:59:59Z')).toBe(true);
  });
});

// ─── utcToSydneyInput / sydneyInputToUtc ──────────────────────────────────────

describe('utcToSydneyInput', () => {
  it('returns empty string for null', () => {
    expect(utcToSydneyInput(null)).toBe('');
    expect(utcToSydneyInput('')).toBe('');
  });

  it('returns a datetime-local formatted string', () => {
    const result = utcToSydneyInput('2026-01-15T00:00:00Z');
    // Should look like YYYY-MM-DDTHH:MM
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('sydneyInputToUtc', () => {
  it('returns null for null/empty', () => {
    expect(sydneyInputToUtc(null)).toBeNull();
    expect(sydneyInputToUtc('')).toBeNull();
  });

  it('returns a valid ISO string', () => {
    const result = sydneyInputToUtc('2026-01-15T11:00');
    expect(result).toBeTruthy();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('round-trips with utcToSydneyInput', () => {
    const original = '2026-06-15T03:30:00Z';
    const sydneyLocal = utcToSydneyInput(original);
    const backToUtc = sydneyInputToUtc(sydneyLocal);
    // Should be within 1 minute of original
    const diffMs = Math.abs(new Date(original).getTime() - new Date(backToUtc).getTime());
    expect(diffMs).toBeLessThan(60000);
  });
});

// ─── formatDurationCompact ────────────────────────────────────────────────────

describe('formatDurationCompact', () => {
  it('returns dash for null/undefined/0/negative', () => {
    expect(formatDurationCompact(null)).toBe('—');
    expect(formatDurationCompact(undefined)).toBe('—');
    expect(formatDurationCompact(0)).toBe('—');
    expect(formatDurationCompact(-5)).toBe('—');
  });

  it('formats seconds', () => {
    expect(formatDurationCompact(45)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(formatDurationCompact(120)).toBe('2m');
    expect(formatDurationCompact(300)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatDurationCompact(3660)).toBe('1h 1m');
    expect(formatDurationCompact(7200)).toBe('2h 0m');
  });

  it('formats days', () => {
    expect(formatDurationCompact(86400)).toBe('1d');
    expect(formatDurationCompact(90000)).toBe('1d 1h');
  });
});

// ─── formatDurationFull ───────────────────────────────────────────────────────

describe('formatDurationFull', () => {
  it('returns dash for null/0/negative', () => {
    expect(formatDurationFull(null)).toBe('—');
    expect(formatDurationFull(0)).toBe('—');
    expect(formatDurationFull(-1)).toBe('—');
  });

  it('formats seconds', () => {
    expect(formatDurationFull(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDurationFull(125)).toBe('2m 5s');
  });

  it('formats hours, minutes, seconds', () => {
    expect(formatDurationFull(3661)).toBe('1h 1m 1s');
  });

  it('formats days', () => {
    expect(formatDurationFull(86400)).toBe('1d');
    expect(formatDurationFull(90000)).toBe('1d 1h');
  });
});
