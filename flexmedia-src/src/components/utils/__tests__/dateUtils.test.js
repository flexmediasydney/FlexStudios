import { describe, it, expect } from 'vitest';
import {
  fixTimestamp,
  APP_TZ,
  parseDate,
  fmtDate,
  fmtTimestampCustom,
  isOverdue,
  todaySydney,
  formatRelative,
  isSameDay,
  utcToSydneyInput,
  sydneyInputToUtc,
  getSydneyHourMinute,
  fmtSydneyTime,
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

  it('handles compact offset formats without colon', () => {
    expect(fixTimestamp('2026-03-10T13:29:00-0800')).toBe('2026-03-10T13:29:00-0800');
    expect(fixTimestamp('2026-03-10T13:29:00+1100')).toBe('2026-03-10T13:29:00+1100');
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

// ─── isOverdue ───────────────────────────────────────────────────────────────

describe('isOverdue', () => {
  it('returns false for null/undefined', () => {
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(undefined)).toBe(false);
  });

  it('returns true for a date far in the past', () => {
    expect(isOverdue('2020-01-01')).toBe(true);
  });

  it('returns false for a date far in the future', () => {
    expect(isOverdue('2099-12-31')).toBe(false);
  });
});

// ─── formatRelative ──────────────────────────────────────────────────────────

describe('formatRelative', () => {
  it('returns dash for null/undefined', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
  });

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

// ─── isSameDay ──────────────────────────────────────────────────────────────

describe('isSameDay', () => {
  it('returns false for null inputs', () => {
    expect(isSameDay(null, '2026-03-10T10:00:00Z')).toBe(false);
    expect(isSameDay('2026-03-10T10:00:00Z', null)).toBe(false);
  });

  it('returns true for same day timestamps', () => {
    expect(isSameDay('2026-03-10T10:00:00Z', '2026-03-10T12:00:00Z')).toBe(true);
  });

  it('returns false for different days', () => {
    expect(isSameDay('2026-03-10T01:00:00Z', '2026-03-11T01:00:00Z')).toBe(false);
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

// ─── getSydneyHourMinute ──────────────────────────────────────────────────────

describe('getSydneyHourMinute', () => {
  it('returns { hour: 0, minute: 0 } for null/undefined', () => {
    expect(getSydneyHourMinute(null)).toEqual({ hour: 0, minute: 0 });
    expect(getSydneyHourMinute(undefined)).toEqual({ hour: 0, minute: 0 });
  });

  it('returns an object with hour and minute for a valid timestamp', () => {
    const result = getSydneyHourMinute('2026-01-15T00:00:00Z');
    expect(result).toHaveProperty('hour');
    expect(result).toHaveProperty('minute');
    expect(typeof result.hour).toBe('number');
    expect(typeof result.minute).toBe('number');
    expect(result.hour).toBeGreaterThanOrEqual(0);
    expect(result.hour).toBeLessThan(24);
    expect(result.minute).toBeGreaterThanOrEqual(0);
    expect(result.minute).toBeLessThan(60);
  });

  it('handles bare timestamps (no Z)', () => {
    const result = getSydneyHourMinute('2026-06-15T12:30:00');
    expect(typeof result.hour).toBe('number');
    expect(typeof result.minute).toBe('number');
  });
});

// ─── fmtSydneyTime ──────────────────────────────────────────────────────────

describe('fmtSydneyTime', () => {
  it('returns dash for null/undefined', () => {
    expect(fmtSydneyTime(null)).toBe('—');
    expect(fmtSydneyTime(undefined)).toBe('—');
  });

  it('returns a time string for a valid timestamp', () => {
    const result = fmtSydneyTime('2026-01-15T00:00:00Z');
    expect(result).toBeTruthy();
    expect(result).not.toBe('—');
  });
});
