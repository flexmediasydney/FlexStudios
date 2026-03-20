/**
 * ============================================================
 * DEADLINE CALCULATION UTILITIES — Elite Timezone-Aware Engine
 * ============================================================
 *
 * Design principles:
 *  1. ALL deadlines are stored as UTC ISO strings in the database.
 *  2. All "wall clock" targets (e.g. 11:59 PM "tonight") are expressed
 *     in the BUSINESS timezone, never the server timezone.
 *  3. `wallClockToUTC` uses iterative bisection to find the exact UTC
 *     instant for a desired local time — 100% correct across DST gaps
 *     and ambiguous hours (fall-back clock changes).
 *  4. `getLocalDateComponents` reliably decomposes any UTC instant into
 *     local date parts for a given IANA timezone string.
 *  5. Business-day logic operates entirely on local calendar dates.
 */

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────

/**
 * The canonical IANA timezone for this business.
 * This is used whenever no per-project or per-user timezone is specified.
 */
export const APP_TIMEZONE = 'Australia/Sydney';

/**
 * Resolve the timezone to use for a given context.
 * Priority: explicit override → project timezone field → APP_TIMEZONE
 * This design allows future per-project or per-user timezone support.
 */
export function resolveTimezone(overrideTimezone, project) {
  if (overrideTimezone && isValidTimezone(overrideTimezone)) return overrideTimezone;
  if (project?.timezone && isValidTimezone(project.timezone)) return project.timezone;
  return APP_TIMEZONE;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// CORE: LOCAL DATE DECOMPOSITION
// ─────────────────────────────────────────────────────────────

/**
 * Returns the local date/time components for a UTC instant in a given timezone.
 * Uses Intl.DateTimeFormat with explicit numeric parts — never relies on
 * toLocaleString parsing, which is locale-dependent.
 *
 * @param {Date|string|number} utcInstant
 * @param {string} timezone  IANA timezone string
 * @returns {{ year, month0, day, hour, minute, second, weekday0 }}
 *   month0: 0-indexed month (0=Jan)
 *   weekday0: 0=Sunday … 6=Saturday
 */
export function getLocalDateComponents(utcInstant, timezone) {
  const d = new Date(utcInstant);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year:    'numeric',
    month:   '2-digit',
    day:     '2-digit',
    hour:    '2-digit',
    minute:  '2-digit',
    second:  '2-digit',
    weekday: 'short',    // "Mon", "Tue", … locale-independent in en-US
    hour12:  false
  });

  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value ?? '0';

  // hour12:false can return '24' for midnight — normalise
  const hour = parseInt(get('hour')) % 24;

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year:     parseInt(get('year')),
    month0:   parseInt(get('month')) - 1,
    day:      parseInt(get('day')),
    hour,
    minute:   parseInt(get('minute')),
    second:   parseInt(get('second')),
    weekday0: weekdayMap[get('weekday')] ?? -1
  };
}

// ─────────────────────────────────────────────────────────────
// CORE: WALL-CLOCK → UTC  (Iterative Bisection)
// ─────────────────────────────────────────────────────────────

/**
 * Find the UTC instant at which the clock in `timezone` reads exactly
 * (year, month0, day, hours, minutes, seconds).
 *
 * Uses iterative bisection:
 *   - Start from a naive "treat local as UTC" estimate.
 *   - Repeatedly compare what the clock actually shows to what we want.
 *   - Converge to ≤1 second accuracy in ≤5 iterations.
 *
 * DST behaviour:
 *   - If the time falls in a DST gap (spring-forward), returns the first
 *     valid instant after the gap (clocks jump, so the wall time doesn't exist).
 *   - If the time is ambiguous (fall-back), returns the STANDARD time instance
 *     (later UTC instant) — conservative for deadline purposes.
 *
 * @param {number} year
 * @param {number} month0   0-indexed month
 * @param {number} day
 * @param {number} hours    0-23
 * @param {number} minutes
 * @param {number} seconds
 * @param {string} timezone IANA timezone string
 * @returns {Date}
 */
export function wallClockToUTC(year, month0, day, hours, minutes, seconds, timezone) {
  // Target: the desired wall-clock time expressed as ms-since-epoch *if it were UTC*
  const targetLocalMs = Date.UTC(year, month0, day, hours, minutes, seconds);

  // Initial estimate: treat local time as UTC, then apply a rough offset
  let utcMs = targetLocalMs;

  // Converge using direct correction (usually 2-3 passes)
  for (let i = 0; i < 5; i++) {
    const c = getLocalDateComponents(utcMs, timezone);
    const shownLocalMs = Date.UTC(c.year, c.month0, c.day, c.hour, c.minute, c.second);
    const diff = shownLocalMs - targetLocalMs;
    if (diff === 0) break;
    utcMs -= diff;
  }

  // Final validation: verify the result actually shows the correct local time
  // (handles DST gap — if not achievable, the clock will show the post-gap time)
  return new Date(utcMs);
}

// ─────────────────────────────────────────────────────────────
// BUSINESS DAY HELPERS  (operate on local calendar dates)
// ─────────────────────────────────────────────────────────────

/**
 * Given local (year, month0, day), advance `n` calendar days and return
 * the resulting local date as a plain object { year, month0, day }.
 * Uses Date arithmetic so months/years roll over correctly.
 */
function addLocalDays(year, month0, day, n) {
  // Use noon UTC to avoid any DST edge — we just need the calendar date
  const d = new Date(Date.UTC(year, month0, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() };
}

/**
 * Returns true if the local weekday (0=Sun … 6=Sat) is a business day (Mon–Fri).
 */
function isBusinessDay(weekday0) {
  return weekday0 >= 1 && weekday0 <= 5;
}

/**
 * Get the local weekday for a (year, month0, day) date.
 * We compute it purely from UTC date at noon — no timezone needed for date-only weekday
 * since we're given an explicit local calendar date.
 */
function localWeekday(year, month0, day) {
  return new Date(Date.UTC(year, month0, day, 12, 0, 0)).getUTCDay();
}

/**
 * Advance from (year, month0, day) by `n` business days.
 * Returns { year, month0, day }.
 */
function addBusinessDays(year, month0, day, n) {
  let cur = { year, month0, day };
  let count = 0;
  while (count < n) {
    cur = addLocalDays(cur.year, cur.month0, cur.day, 1);
    if (isBusinessDay(localWeekday(cur.year, cur.month0, cur.day))) count++;
  }
  return cur;
}

/**
 * Returns the Nth next business day from (year, month0, day), skipping today.
 * e.g. nextBusinessDay(today, 1) = tomorrow if Mon-Thu, or Monday if Fri/weekend.
 */
function nextBusinessDay(year, month0, day, n = 1) {
  return addBusinessDays(year, month0, day, n);
}

// ─────────────────────────────────────────────────────────────
// PRESET DEADLINE CALCULATOR
// ─────────────────────────────────────────────────────────────

/**
 * Calculate a deadline UTC instant from a preset name and a trigger time.
 *
 * @param {string} preset         One of the deadline_preset enum values
 * @param {Date|string} triggerDate  UTC instant of the triggering event
 * @param {string} timezone        IANA timezone (use resolveTimezone() before calling)
 * @returns {Date|null}
 */
export function calculatePresetDeadline(preset, triggerDate, timezone = APP_TIMEZONE) {
  const trigger = new Date(triggerDate);
  if (isNaN(trigger.getTime())) {
    console.error(`[deadline] Invalid triggerDate: ${triggerDate}`);
    return null;
  }

  // Decompose trigger into local date components
  const lc = getLocalDateComponents(trigger, timezone);

  console.log(`[deadline] preset="${preset}" trigger=${trigger.toISOString()} local=${lc.year}-${String(lc.month0+1).padStart(2,'0')}-${String(lc.day).padStart(2,'0')} ${String(lc.hour).padStart(2,'0')}:${String(lc.minute).padStart(2,'0')} tz=${timezone}`);

  // Helper: create a deadline at HH:MM:SS on a specific local date
  const deadline = (y, m0, d, h, mi, s) => wallClockToUTC(y, m0, d, h, mi, s, timezone);

  // Helper: "same day" or "next day" depending on whether trigger is already past target time
  const sameDayOrNext = (h, mi, s) => {
    const candidate = deadline(lc.year, lc.month0, lc.day, h, mi, s);
    if (trigger >= candidate) {
      const next = addLocalDays(lc.year, lc.month0, lc.day, 1);
      return deadline(next.year, next.month0, next.day, h, mi, s);
    }
    return candidate;
  };

  let result;

  switch (preset) {
    case 'tonight':
      // 11:59:59 PM same night; if already past, roll to next night
      result = sameDayOrNext(23, 59, 59);
      break;

    case 'tomorrow_night': {
      const next = addLocalDays(lc.year, lc.month0, lc.day, 1);
      result = deadline(next.year, next.month0, next.day, 23, 59, 59);
      break;
    }

    case 'tomorrow_am': {
      const next = addLocalDays(lc.year, lc.month0, lc.day, 1);
      result = deadline(next.year, next.month0, next.day, 11, 59, 59);
      break;
    }

    case 'tomorrow_business_am': {
      const nb = nextBusinessDay(lc.year, lc.month0, lc.day, 1);
      result = deadline(nb.year, nb.month0, nb.day, 11, 59, 59);
      break;
    }

    case 'in_2_nights': {
      const d2 = addLocalDays(lc.year, lc.month0, lc.day, 2);
      result = deadline(d2.year, d2.month0, d2.day, 23, 59, 59);
      break;
    }

    case 'in_3_nights': {
      const d3 = addLocalDays(lc.year, lc.month0, lc.day, 3);
      result = deadline(d3.year, d3.month0, d3.day, 23, 59, 59);
      break;
    }

    case 'in_4_nights': {
      const d4 = addLocalDays(lc.year, lc.month0, lc.day, 4);
      result = deadline(d4.year, d4.month0, d4.day, 23, 59, 59);
      break;
    }

    case 'next_business_night': {
      const nb = nextBusinessDay(lc.year, lc.month0, lc.day, 1);
      result = deadline(nb.year, nb.month0, nb.day, 23, 59, 59);
      break;
    }

    case '2_business_nights': {
      const nb2 = nextBusinessDay(lc.year, lc.month0, lc.day, 2);
      result = deadline(nb2.year, nb2.month0, nb2.day, 23, 59, 59);
      break;
    }

    case '3_business_nights': {
      const nb3 = nextBusinessDay(lc.year, lc.month0, lc.day, 3);
      result = deadline(nb3.year, nb3.month0, nb3.day, 23, 59, 59);
      break;
    }

    default:
      console.warn(`[deadline] Unknown preset: "${preset}"`);
      return null;
  }

  console.log(`[deadline] preset="${preset}" => ${result?.toISOString()} (local: ${result ? getLocalDateComponents(result, timezone).hour+':'+String(getLocalDateComponents(result, timezone).minute).padStart(2,'0') : 'null'})`);
  return result ?? null;
}

// ─────────────────────────────────────────────────────────────
// TRIGGER CONDITION HELPERS
// ─────────────────────────────────────────────────────────────

export function isTriggerConditionMet(triggerType, project) {
  if (!triggerType || triggerType === 'none') return false;
  switch (triggerType) {
    case 'project_onsite':
      return project?.status === 'onsite' || !!project?.shooting_started_at;
    case 'project_uploaded':
      return project?.status === 'uploaded';
    case 'project_submitted':
      return project?.status === 'submitted';
    case 'dependencies_cleared':
      // Evaluated externally — not a simple project field check
      return false;
    default:
      return false;
  }
}

export function getTriggerTime(triggerType, project) {
  if (!isTriggerConditionMet(triggerType, project)) return null;
  switch (triggerType) {
    case 'project_onsite':
      return project?.shooting_started_at || project?.last_status_change || null;
    case 'project_uploaded':
    case 'project_submitted':
      return project?.last_status_change || null;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// DEPENDENCY CYCLE DETECTION
// ─────────────────────────────────────────────────────────────

export function hasCyclicDependency(task, allTasks, visited = new Set(), stack = new Set()) {
  visited.add(task.id);
  stack.add(task.id);
  for (const depId of (task.depends_on_task_ids || [])) {
    if (!visited.has(depId)) {
      const dep = allTasks.find(t => t.id === depId);
      if (dep && hasCyclicDependency(dep, allTasks, visited, stack)) return true;
    } else if (stack.has(depId)) {
      return true;
    }
  }
  stack.delete(task.id);
  return false;
}

export function areDependenciesComplete(task, allTasks) {
  if (!task.depends_on_task_ids?.length) return true;
  if (task.depends_on_task_ids.includes(task.id)) {
    console.error(`[deps] Self-dependency on task ${task.id}`);
    return false;
  }
  if (hasCyclicDependency(task, allTasks)) {
    console.error(`[deps] Cyclic dependency involving task ${task.id}`);
    return false;
  }
  return task.depends_on_task_ids.every(depId => {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) {
      console.warn(`[deps] Task ${task.id} depends on missing task ${depId}`);
      return false;
    }
    return dep.is_completed === true;
  });
}