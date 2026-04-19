import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, getUserFromReq, serveWithAudit } from '../_shared/supabase.ts';

// ─── Sydney timezone helpers ─────────────────────────────────────────────────

const sydneyDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' });

/** Return YYYY-MM-DD in Sydney timezone for a given Date. */
function toSydneyDate(d: Date): string {
  return sydneyDateFmt.format(d);
}

/** Return the Sydney-local month start (YYYY-MM-01) for a Date. */
function sydneyMonthStart(d: Date): string {
  const iso = toSydneyDate(d);
  return iso.slice(0, 7) + '-01';
}

/** Safe division — returns 0 when denominator is 0. */
function safePct(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 100 * 100) / 100;
}

/** Safe average — returns 0 for empty arrays. */
function safeAvg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100;
}

/** Milliseconds between two dates, floored to days. */
function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

/** Get the Monday-based week start (YYYY-MM-DD Sydney) for a date. */
function weekStart(d: Date): string {
  const sydney = new Date(toSydneyDate(d) + 'T00:00:00');
  const day = sydney.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  sydney.setDate(sydney.getDate() + diff);
  return toSydneyDate(sydney);
}

// ─── Revenue helpers ─────────────────────────────────────────────────────────

function projectRevenue(p: any): number {
  return Number(p.invoiced_amount ?? p.calculated_price ?? 0) || 0;
}

// ─── Stat computation ────────────────────────────────────────────────────────

interface StatGroup {
  stat_key: string;
  stat_value: Record<string, unknown>;
}

function computeRevenue(projects: any[], agencies: any[], now: Date): StatGroup {
  const thisMonthStart = sydneyMonthStart(now);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = sydneyMonthStart(lastMonth);

  let totalRevenue = 0;
  let mtdRevenue = 0;
  let lastMonthRevenue = 0;
  let revenueAtRisk = 0;

  const agencyMap = new Map<string, { revenue: number; count: number }>();
  const agentMap = new Map<string, { revenue: number; count: number }>();

  for (const p of projects) {
    const rev = projectRevenue(p);
    totalRevenue += rev;

    const createdDate = toSydneyDate(new Date(p.created_at));
    if (createdDate >= thisMonthStart) mtdRevenue += rev;
    if (createdDate >= lastMonthStart && createdDate < thisMonthStart) lastMonthRevenue += rev;

    // Revenue at risk: delivered, unpaid, older than 14 days
    if (p.status === 'delivered' && p.payment_status !== 'paid' && p.is_paid !== true) {
      const deliveredAgo = daysBetween(new Date(p.last_status_change || p.updated_at), now);
      if (deliveredAgo > 14) revenueAtRisk += rev;
    }

    // Agency breakdown
    if (p.agency_id) {
      const agencyName = agencies.find((a: any) => a.id === p.agency_id)?.name || 'Unknown';
      const entry = agencyMap.get(agencyName) || { revenue: 0, count: 0 };
      entry.revenue += rev;
      entry.count += 1;
      agencyMap.set(agencyName, entry);
    }

    // Agent breakdown
    if (p.agent_name) {
      const entry = agentMap.get(p.agent_name) || { revenue: 0, count: 0 };
      entry.revenue += rev;
      entry.count += 1;
      agentMap.set(p.agent_name, entry);
    }
  }

  const growthPct = lastMonthRevenue === 0 ? 0 : safePct(mtdRevenue - lastMonthRevenue, lastMonthRevenue);
  const avgProjectValue = projects.length === 0 ? 0 : Math.round((totalRevenue / projects.length) * 100) / 100;

  const byAgency = [...agencyMap.entries()]
    .map(([agency_name, v]) => ({ agency_name, revenue: v.revenue, count: v.count }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const byAgent = [...agentMap.entries()]
    .map(([agent_name, v]) => ({ agent_name, revenue: v.revenue, count: v.count }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    stat_key: 'revenue',
    stat_value: {
      total_revenue: totalRevenue,
      mtd_revenue: mtdRevenue,
      last_month_revenue: lastMonthRevenue,
      growth_pct: growthPct,
      avg_project_value: avgProjectValue,
      revenue_at_risk: revenueAtRisk,
      by_agency: byAgency,
      by_agent: byAgent,
    },
  };
}

function computePipeline(projects: any[], tasks: any[], now: Date): StatGroup {
  const stageMap = new Map<string, { count: number; revenue: number; days: number[] }>();

  for (const p of projects) {
    const stage = p.status || 'unknown';
    const entry = stageMap.get(stage) || { count: 0, revenue: 0, days: [] };
    entry.count += 1;
    entry.revenue += projectRevenue(p);
    const daysInStage = daysBetween(new Date(p.last_status_change || p.created_at), now);
    entry.days.push(daysInStage);
    stageMap.set(stage, entry);
  }

  const byStage: Record<string, { count: number; revenue: number; avg_days: number }> = {};
  const allDays: number[] = [];

  for (const [stage, entry] of stageMap) {
    const avgDays = safeAvg(entry.days);
    byStage[stage] = { count: entry.count, revenue: entry.revenue, avg_days: avgDays };
    allDays.push(...entry.days);
  }

  const overallAvgDays = safeAvg(allDays);
  const bottleneckThreshold = overallAvgDays * 1.5;
  const bottlenecks: string[] = [];

  for (const [stage, data] of Object.entries(byStage)) {
    if (data.avg_days > bottleneckThreshold && bottleneckThreshold > 0) {
      bottlenecks.push(stage);
    }
  }

  // Needs attention: overdue, stale >7d, or missing staff — with individual counts
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  let needsAttention = 0;
  let overdueProjects = 0;
  let staleProjects = 0;
  let missingPhotographer = 0;

  for (const p of projects) {
    if (p.status === 'cancelled' || p.status === 'delivered') continue;
    const isOverdue = p.delivery_date && new Date(p.delivery_date) < now;
    const isStale = new Date(p.updated_at) < sevenDaysAgo;
    const noPhotographer = !p.photographer_id;
    if (isOverdue) overdueProjects++;
    if (isStale) staleProjects++;
    if (noPhotographer) missingPhotographer++;
    if (isOverdue || isStale || noPhotographer) needsAttention++;
  }

  // Pending review
  const pendingReview = projects.filter((p: any) => p.status === 'pending_review');
  const pendingWaitHours = pendingReview.map((p: any) =>
    (now.getTime() - new Date(p.last_status_change || p.created_at).getTime()) / 3_600_000
  );

  const activeStatuses = ['to_be_scheduled', 'scheduled', 'onsite', 'uploaded', 'submitted', 'in_progress', 'ready_for_partial', 'in_revision'];

  // Pricing mismatches on active (non-terminal) projects
  const pricingMismatches = projects.filter(
    (p: any) => p.has_pricing_mismatch && !['cancelled', 'delivered'].includes(p.status)
  ).length;

  return {
    stat_key: 'pipeline',
    stat_value: {
      by_stage: byStage,
      bottlenecks,
      needs_attention: needsAttention,
      overdue_projects: overdueProjects,
      stale_projects_7d: staleProjects,
      missing_photographer: missingPhotographer,
      pending_review_count: pendingReview.length,
      pending_review_avg_wait_hours: safeAvg(pendingWaitHours),
      active_count: projects.filter((p: any) => activeStatuses.includes(p.status)).length,
      delivered_count: projects.filter((p: any) => p.status === 'delivered').length,
      cancelled_count: projects.filter((p: any) => p.status === 'cancelled').length,
      pricing_mismatches: pricingMismatches,
    },
  };
}

function computeTasks(tasks: any[]): StatGroup {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t: any) => t.is_completed).length;
  const overdueTasks = tasks.filter((t: any) => !t.is_completed && t.due_date && new Date(t.due_date) < new Date()).length;
  const completionRate = safePct(completedTasks, totalTasks);

  // Avg completion days (from created_at to completed_at)
  const completionDays = tasks
    .filter((t: any) => t.is_completed && t.completed_at)
    .map((t: any) => daysBetween(new Date(t.created_at), new Date(t.completed_at)));
  const avgCompletionDays = safeAvg(completionDays);

  // By role
  const roleMap = new Map<string, { total: number; completed: number }>();
  for (const t of tasks) {
    const role = t.auto_assign_role || 'none';
    const entry = roleMap.get(role) || { total: 0, completed: 0 };
    entry.total += 1;
    if (t.is_completed) entry.completed += 1;
    roleMap.set(role, entry);
  }

  const byRole: Record<string, { total: number; completed: number; completion_rate_pct: number }> = {};
  for (const [role, entry] of roleMap) {
    byRole[role] = {
      total: entry.total,
      completed: entry.completed,
      completion_rate_pct: safePct(entry.completed, entry.total),
    };
  }

  return {
    stat_key: 'tasks',
    stat_value: {
      total_tasks: totalTasks,
      completed_tasks: completedTasks,
      overdue_tasks: overdueTasks,
      completion_rate_pct: completionRate,
      avg_completion_days: avgCompletionDays,
      by_role: byRole,
    },
  };
}

function computeUtilization(timeLogs: any[], tasks: any[], users: any[], employeeRoles: any[], goalProjectIds: Set<string>): StatGroup {
  const now = new Date();

  // Week boundaries (Mon-Sun Sydney time)
  const sydneyDate = (d: Date): string | null => {
    try {
      if (!d || isNaN(d.getTime())) return null;
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });
      return fmt.format(d);
    } catch { return null; }
  };
  const sydneyNowStr = sydneyDate(now) || new Date().toISOString().slice(0, 10);
  const sydneyNow = new Date(sydneyNowStr + 'T00:00:00');
  const dayOfWeek = sydneyNow.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(sydneyNow); weekStart.setDate(sydneyNow.getDate() + mondayOffset);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);
  const weekStartStr = sydneyDate(weekStart);
  const weekEndStr = sydneyDate(weekEnd);

  // Hours logged THIS WEEK per user
  // FIX: Supabase returns timestamps as "2026-04-11T13:10:44.7+00:00" (with offset).
  // Only append 'Z' if the timestamp has NO timezone info at all.
  const hasTimezone = (ts: string) => /Z$|[+-]\d{2}:\d{2}$/.test(ts);
  const parseTs = (raw: string) => new Date(hasTimezone(raw) ? raw : raw + 'Z');

  const userLoggedThisWeek = new Map<string, number>();
  for (const log of timeLogs) {
    if (!log.user_id || !log.start_time) continue;
    const parsed = parseTs(String(log.start_time));
    const logDate = sydneyDate(parsed);
    if (logDate && weekStartStr && weekEndStr && logDate >= weekStartStr && logDate < weekEndStr) {
      const hrs = (log.total_seconds || 0) / 3600;
      userLoggedThisWeek.set(log.user_id, (userLoggedThisWeek.get(log.user_id) || 0) + hrs);
    }
  }

  // Goal hours THIS WEEK per user (subset of total logged)
  const userGoalHoursThisWeek = new Map<string, number>();
  for (const log of timeLogs) {
    if (!log.user_id || !log.start_time || !log.project_id) continue;
    if (!goalProjectIds.has(log.project_id)) continue;
    const parsed = parseTs(String(log.start_time));
    const logDate = sydneyDate(parsed);
    if (logDate && weekStartStr && weekEndStr && logDate >= weekStartStr && logDate < weekEndStr) {
      const hrs = (log.total_seconds || 0) / 3600;
      userGoalHoursThisWeek.set(log.user_id, (userGoalHoursThisWeek.get(log.user_id) || 0) + hrs);
    }
  }

  // Categorize tasks per user
  const userDueThisWeek = new Map<string, number>();    // hours
  const userOverdue = new Map<string, number>();         // hours
  const userOverdueCount = new Map<string, number>();    // count
  const userDueThisWeekCount = new Map<string, number>();
  const userUnscheduled = new Map<string, number>();     // hours (no due date)
  const userFuture = new Map<string, number>();          // hours (due after this week)

  for (const t of tasks) {
    if (!t.assigned_to || t.is_deleted || t.is_completed) continue;
    const hrs = (t.estimated_minutes || 0) / 60;
    if (hrs <= 0) continue;

    const rawDue = t.due_date ? new Date(t.due_date) : null;
    const dueDate = rawDue ? sydneyDate(rawDue) : null;
    const uid = t.assigned_to;

    if (!dueDate) {
      userUnscheduled.set(uid, (userUnscheduled.get(uid) || 0) + hrs);
    } else if (dueDate < weekStartStr) {
      // OVERDUE — past due, carries forward into this week's load
      userOverdue.set(uid, (userOverdue.get(uid) || 0) + hrs);
      userOverdueCount.set(uid, (userOverdueCount.get(uid) || 0) + 1);
    } else if (dueDate < weekEndStr) {
      // DUE THIS WEEK
      userDueThisWeek.set(uid, (userDueThisWeek.get(uid) || 0) + hrs);
      userDueThisWeekCount.set(uid, (userDueThisWeekCount.get(uid) || 0) + 1);
    } else {
      // FUTURE — not this week's problem
      userFuture.set(uid, (userFuture.get(uid) || 0) + hrs);
    }
  }

  // Role + user lookups
  const roleByUser = new Map<string, string>();
  for (const er of employeeRoles) roleByUser.set(er.user_id, er.role || 'unknown');
  const userMap = new Map<string, any>();
  for (const u of users) userMap.set(u.id, u);

  const r2 = (n: number) => Math.round(n * 100) / 100;

  // Build per-user stats — include ALL active users, not just those with time/tasks.
  // Users with zero load still show up as having free capacity.
  const allUserIds = new Set([
    ...userLoggedThisWeek.keys(),
    ...userDueThisWeek.keys(),
    ...userOverdue.keys(),
    ...userUnscheduled.keys(),
    ...users.filter((u: any) => u.is_active).map((u: any) => u.id),
  ]);
  const byUser: any[] = [];
  let totalCommitted = 0, totalLogged = 0, totalTarget = 0;

  for (const uid of allUserIds) {
    const user = userMap.get(uid);
    if (!user) continue;

    const logged = userLoggedThisWeek.get(uid) || 0;
    const dueThisWeek = userDueThisWeek.get(uid) || 0;
    const overdue = userOverdue.get(uid) || 0;
    const target = Number(user.weekly_target_hours) || 40;
    const unscheduled = userUnscheduled.get(uid) || 0;
    const future = userFuture.get(uid) || 0;
    // Committed = scheduled (due this week + overdue) + unscheduled active work.
    // Unscheduled tasks are work that CAN be done now but has no specific deadline —
    // they still represent real workload and must count toward utilisation.
    const committed = dueThisWeek + overdue + unscheduled;

    const loadPct = safePct(committed, target);
    const progressPct = safePct(logged, committed);
    const freeCapacity = Math.max(0, target - committed);

    totalCommitted += committed;
    totalLogged += logged;
    totalTarget += target;

    byUser.push({
      user_id: uid,
      user_name: user.full_name || 'Unknown',
      role: roleByUser.get(uid) || user.default_staff_role || 'unknown',
      team_id: user.internal_team_id || null,
      team_name: user.internal_team_name || null,
      // PRIMARY
      load_pct: loadPct,
      committed_hours: r2(committed),
      weekly_target_hours: target,
      free_capacity_hours: r2(freeCapacity),
      // SECONDARY
      progress_pct: progressPct,
      hours_logged: r2(logged),
      goal_hours_logged: r2(userGoalHoursThisWeek.get(uid) || 0),
      production_hours_logged: r2(logged - (userGoalHoursThisWeek.get(uid) || 0)),
      // BREAKDOWN
      hours_due_this_week: r2(dueThisWeek),
      hours_overdue: r2(overdue),
      overdue_task_count: userOverdueCount.get(uid) || 0,
      tasks_due_this_week_count: userDueThisWeekCount.get(uid) || 0,
      hours_unscheduled: r2(unscheduled),
      hours_future: r2(future),
      // DEPRECATED (backward compat)
      utilization_pct: progressPct,
      target_utilization_pct: safePct(logged, target),
      hours_estimated: r2(committed),
      available_capacity: r2(freeCapacity),
    });
  }

  byUser.sort((a, b) => b.load_pct - a.load_pct);

  // Team aggregation
  const teamAgg = new Map<string, any>();
  for (const u of byUser) {
    const tid = u.team_id || 'unassigned';
    const tname = u.team_name || 'Unassigned';
    if (!teamAgg.has(tid)) {
      teamAgg.set(tid, { team_id: tid, team_name: tname, committed: 0, logged: 0, target: 0, overdueCount: 0, memberCount: 0, members: [] });
    }
    const t = teamAgg.get(tid)!;
    t.committed += u.committed_hours;
    t.logged += u.hours_logged;
    t.target += u.weekly_target_hours;
    t.overdueCount += u.overdue_task_count;
    t.memberCount++;
    t.members.push({ user_name: u.user_name, load_pct: u.load_pct, progress_pct: u.progress_pct });
  }

  const byTeam = Array.from(teamAgg.values()).map(t => {
    const loadPct = safePct(t.committed, t.target);
    const progressPct = safePct(t.logged, t.committed);
    const loadWord = loadPct > 100 ? 'overloaded' : loadPct > 80 ? 'at capacity' : 'loaded';
    const progressWord = progressPct > 80 ? 'on track' : progressPct > 50 ? 'in progress' : 'behind';
    let summary = `${t.memberCount} staff, ${loadPct}% ${loadWord}, ${progressPct}% ${progressWord}`;
    if (loadPct > 100) summary += ' — needs redistribution';
    if (t.overdueCount > 0) summary += ` (${t.overdueCount} overdue)`;

    return {
      team_id: t.team_id,
      team_name: t.team_name,
      member_count: t.memberCount,
      load_pct: loadPct,
      progress_pct: progressPct,
      total_committed_hours: r2(t.committed),
      total_target_hours: r2(t.target),
      total_logged_hours: r2(t.logged),
      total_free_capacity: r2(Math.max(0, t.target - t.committed)),
      overdue_task_count: t.overdueCount,
      members: t.members,
      summary,
      // DEPRECATED
      utilization_pct: progressPct,
      target_utilization_pct: safePct(t.logged, t.target),
      hours_logged: r2(t.logged),
      hours_estimated: r2(t.committed),
      total_target_hours_legacy: r2(t.target),
      team_free_capacity: r2(Math.max(0, t.target - t.committed)),
    };
  }).sort((a, b) => b.load_pct - a.load_pct);

  const overallLoad = safePct(totalCommitted, totalTarget);
  const overallProgress = safePct(totalLogged, totalCommitted);
  const overloaded = byUser.filter(u => u.load_pct > 100);
  const underloaded = byUser.filter(u => u.load_pct < 40 && u.committed_hours > 0);

  return {
    stat_key: 'utilization',
    stat_value: {
      by_user: byUser,
      by_team: byTeam,
      overall_load_pct: overallLoad,
      overall_progress_pct: overallProgress,
      overloaded_users: overloaded,
      underloaded_users: underloaded,
      week_start: weekStartStr,
      week_end: weekEndStr,
      // DEPRECATED
      overall_utilization_pct: overallProgress,
    },
  };
}

function computeDelivery(projects: any[], revisions: any[], now: Date): StatGroup {
  const delivered = projects.filter((p: any) => p.status === 'delivered');
  const thisMonthStart = sydneyMonthStart(now);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = sydneyMonthStart(lastMonth);

  // On-time: delivered before or on delivery_date
  const withDeliveryTarget = delivered.filter((p: any) => p.delivery_date && p.last_status_change);
  const onTime = withDeliveryTarget.filter((p: any) => {
    const deliveredAt = new Date(p.last_status_change);
    const target = new Date(p.delivery_date);
    return deliveredAt <= target;
  });
  const onTimePct = safePct(onTime.length, withDeliveryTarget.length);

  // Avg turnaround: created_at → last_status_change (when delivered)
  const turnaroundDays = delivered
    .filter((p: any) => p.last_status_change)
    .map((p: any) => daysBetween(new Date(p.created_at), new Date(p.last_status_change)));
  const avgTurnaroundDays = safeAvg(turnaroundDays);

  // Delivery counts by month
  const deliveredThisMonth = delivered.filter((p: any) => {
    const d = toSydneyDate(new Date(p.last_status_change || p.updated_at));
    return d >= thisMonthStart;
  }).length;

  const deliveredLastMonth = delivered.filter((p: any) => {
    const d = toSydneyDate(new Date(p.last_status_change || p.updated_at));
    return d >= lastMonthStart && d < thisMonthStart;
  }).length;

  // Revision rate
  const totalDelivered = delivered.length;
  const totalRevisions = revisions.length;
  const revisionRate = safePct(totalRevisions, totalDelivered);

  return {
    stat_key: 'delivery',
    stat_value: {
      on_time_pct: onTimePct,
      avg_turnaround_days: avgTurnaroundDays,
      delivery_count_this_month: deliveredThisMonth,
      delivery_count_last_month: deliveredLastMonth,
      revision_rate: revisionRate,
      total_delivered: totalDelivered,
      total_revisions: totalRevisions,
    },
  };
}

function computeVelocity(projects: any[], now: Date): StatGroup {
  // Last 8 weeks of project creation and completion
  const eightWeeksAgo = new Date(now.getTime() - 8 * 7 * 86_400_000);
  const weeks = new Map<string, { created: number; completed: number }>();

  // Initialise 8 week buckets
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() - i * 7 * 86_400_000);
    const ws = weekStart(d);
    if (!weeks.has(ws)) weeks.set(ws, { created: 0, completed: 0 });
  }

  for (const p of projects) {
    const createdAt = new Date(p.created_at);
    if (createdAt >= eightWeeksAgo) {
      const ws = weekStart(createdAt);
      const entry = weeks.get(ws);
      if (entry) entry.created += 1;
    }

    if (p.status === 'delivered' && p.last_status_change) {
      const completedAt = new Date(p.last_status_change);
      if (completedAt >= eightWeeksAgo) {
        const ws = weekStart(completedAt);
        const entry = weeks.get(ws);
        if (entry) entry.completed += 1;
      }
    }
  }

  const weekly = [...weeks.entries()]
    .map(([week_start, data]) => ({ week_start, ...data }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start));

  return {
    stat_key: 'velocity',
    stat_value: { weekly },
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────

serveWithAudit('calculateDashboardStats', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Health check
  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'calculateDashboardStats' }, 200, req);
  }

  // Parse request body (for debug flags)
  const body = await req.json().catch(() => ({}));

  // ── Auth: require any authenticated user or service role ──
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401);
  }

  const start = Date.now();

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // ── Load all data in parallel (single round-trip per table) ──────────

    console.log('Loading data...');

    // IMPORTANT: use *All() variants for tables that can exceed the 25k default
    // cap (projects, tasks, time logs). Revisions/agencies/users/roles are
    // bounded in practice and fit well within the default cap, so the regular
    // list/filter with implicit 25k cap is fine there. Underlying helper now
    // paginates via .range() in 1000-row chunks — no silent truncation.
    const [projects, tasks, completedTimeLogs, activeTimeLogs, users, revisions, agencies, employeeRoles] = await Promise.all([
      entities.Project.listAll('-created_at'),
      entities.ProjectTask.filterAll({ is_deleted: false }),
      entities.TaskTimeLog.filterAll({ status: 'completed' }),
      entities.TaskTimeLog.filterAll({ is_active: true }),
      entities.User.list(),
      entities.ProjectRevision.list(),
      entities.Agency.list(),
      entities.EmployeeRole.list(),
    ]);

    // Merge completed + active timers. For active timers, compute elapsed
    // time dynamically so running timers are reflected in utilisation stats.
    const nowMs = Date.now();
    const timeLogs = [
      ...completedTimeLogs,
      ...activeTimeLogs.map((log: any) => {
        const startMs = log.start_time ? new Date(log.start_time).getTime() : nowMs;
        const elapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
        return { ...log, total_seconds: elapsedSeconds, _active: true };
      }),
    ];

    console.log(
      `Data loaded: ${projects.length} projects, ${tasks.length} tasks, ` +
      `${timeLogs.length} timeLogs (${completedTimeLogs.length} completed + ${activeTimeLogs.length} active), ` +
      `${users.length} users, ${revisions.length} revisions`
    );

    const now = new Date();

    // Split production vs goal projects — goals are excluded from revenue/pipeline/delivery/velocity
    const productionProjects = projects.filter((p: any) => p.source !== 'goal');
    const goalProjects = projects.filter((p: any) => p.source === 'goal');
    const goalProjectIds = new Set(goalProjects.map((p: any) => p.id));

    // ── Compute all stat groups ──────────────────────────────────────────

    const statGroups: StatGroup[] = [
      computeRevenue(productionProjects, agencies, now),
      computePipeline(productionProjects, tasks, now),
      computeTasks(tasks),
      computeUtilization(timeLogs, tasks, users, employeeRoles, goalProjectIds),
      computeDelivery(productionProjects, revisions, now),
      computeVelocity(productionProjects, now),
    ];

    // ── Upsert all stats ─────────────────────────────────────────────────

    const computedAt = now.toISOString();
    const upsertErrors: string[] = [];

    for (const group of statGroups) {
      const { error } = await admin.from('dashboard_stats').upsert(
        {
          stat_key: group.stat_key,
          period: 'current',
          stat_value: group.stat_value,
          computed_at: computedAt,
          updated_at: computedAt,
        },
        { onConflict: 'stat_key,period' }
      );

      if (error) {
        console.error(`Upsert failed for ${group.stat_key}:`, error.message);
        upsertErrors.push(`${group.stat_key}: ${error.message}`);
      }
    }

    const elapsed = Date.now() - start;
    console.log(`Stats computed in ${elapsed}ms`);

    if (upsertErrors.length > 0) {
      return jsonResponse(
        {
          success: false,
          computed: statGroups.length - upsertErrors.length,
          errors: upsertErrors,
          elapsed_ms: elapsed,
        },
        207,
        req,
      );
    }

    // Include debug info when requested
    const debugPayload = body?._debug ? {
      timeLogs_count: timeLogs.length,
      completedTimeLogs_count: completedTimeLogs.length,
      activeTimeLogs_count: activeTimeLogs.length,
      timeLogs_sample: timeLogs.slice(0, 5).map((l: any) => ({
        user_name: l.user_name, start_time: l.start_time, total_seconds: l.total_seconds, status: l.status, _active: l._active,
      })),
      utilization_by_user: statGroups.find(g => g.stat_key === 'utilization')?.stat_value?.by_user?.map((u: any) => ({
        user_name: u.user_name, hours_logged: u.hours_logged, load_pct: u.load_pct, progress_pct: u.progress_pct,
      })),
    } : undefined;

    return jsonResponse(
      {
        success: true,
        computed: statGroups.length,
        stat_keys: statGroups.map((g) => g.stat_key),
        elapsed_ms: elapsed,
        ...(debugPayload ? { _debug: debugPayload } : {}),
      },
      200,
      req,
    );
  } catch (error: any) {
    console.error('calculateDashboardStats error:', error);
    return errorResponse(error.message || 'Internal error', 500, req);
  }
});
