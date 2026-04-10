import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

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

  // Needs attention: overdue, stale >7d, or missing staff
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  let needsAttention = 0;

  for (const p of projects) {
    if (p.status === 'cancelled' || p.status === 'delivered') continue;
    const isOverdue = p.delivery_date && new Date(p.delivery_date) < now;
    const isStale = new Date(p.updated_at) < sevenDaysAgo;
    const missingStaff = !p.photographer_id && !p.project_owner_id;
    if (isOverdue || isStale || missingStaff) needsAttention++;
  }

  // Pending review
  const pendingReview = projects.filter((p: any) => p.status === 'pending_review');
  const pendingWaitHours = pendingReview.map((p: any) =>
    (now.getTime() - new Date(p.last_status_change || p.created_at).getTime()) / 3_600_000
  );

  const activeStatuses = ['to_be_scheduled', 'scheduled', 'onsite', 'uploaded', 'submitted', 'in_progress', 'ready_for_partial', 'in_revision'];

  return {
    stat_key: 'pipeline',
    stat_value: {
      by_stage: byStage,
      bottlenecks,
      needs_attention: needsAttention,
      pending_review_count: pendingReview.length,
      pending_review_avg_wait_hours: safeAvg(pendingWaitHours),
      active_count: projects.filter((p: any) => activeStatuses.includes(p.status)).length,
      delivered_count: projects.filter((p: any) => p.status === 'delivered').length,
      cancelled_count: projects.filter((p: any) => p.status === 'cancelled').length,
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

function computeUtilization(timeLogs: any[], tasks: any[], users: any[], employeeRoles: any[]): StatGroup {
  // Hours logged per user
  const userHoursMap = new Map<string, number>();
  for (const log of timeLogs) {
    if (!log.user_id) continue;
    const hrs = (log.total_seconds || 0) / 3600;
    userHoursMap.set(log.user_id, (userHoursMap.get(log.user_id) || 0) + hrs);
  }

  // Hours estimated per user (from tasks assigned to them)
  const userEstimatedMap = new Map<string, number>();
  for (const t of tasks) {
    if (!t.assigned_to) continue;
    const hrs = (t.estimated_minutes || 0) / 60;
    userEstimatedMap.set(t.assigned_to, (userEstimatedMap.get(t.assigned_to) || 0) + hrs);
  }

  // Build role lookup
  const roleByUser = new Map<string, string>();
  for (const er of employeeRoles) {
    roleByUser.set(er.user_id, er.role || 'unknown');
  }

  const userMap = new Map<string, any>();
  for (const u of users) {
    userMap.set(u.id, u);
  }

  const allUserIds = new Set([...userHoursMap.keys(), ...userEstimatedMap.keys()]);
  const byUser: any[] = [];
  let totalLogged = 0;
  let totalEstimated = 0;

  for (const uid of allUserIds) {
    const logged = userHoursMap.get(uid) || 0;
    const estimated = userEstimatedMap.get(uid) || 0;
    totalLogged += logged;
    totalEstimated += estimated;

    const user = userMap.get(uid);
    byUser.push({
      user_id: uid,
      user_name: user?.full_name || 'Unknown',
      role: roleByUser.get(uid) || user?.role || 'unknown',
      hours_logged: Math.round(logged * 100) / 100,
      hours_estimated: Math.round(estimated * 100) / 100,
      utilization_pct: safePct(logged, estimated),
    });
  }

  byUser.sort((a, b) => b.hours_logged - a.hours_logged);

  const overallPct = safePct(totalLogged, totalEstimated);
  const overloaded = byUser.filter((u) => u.utilization_pct > 90);
  const underloaded = byUser.filter((u) => u.utilization_pct < 40 && u.hours_estimated > 0);

  return {
    stat_key: 'utilization',
    stat_value: {
      by_user: byUser,
      overall_utilization_pct: overallPct,
      overloaded_users: overloaded.map((u) => ({ user_id: u.user_id, user_name: u.user_name, utilization_pct: u.utilization_pct })),
      underloaded_users: underloaded.map((u) => ({ user_id: u.user_id, user_name: u.user_name, utilization_pct: u.utilization_pct })),
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

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Health check
  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'calculateDashboardStats' }, 200, req);
  }

  const start = Date.now();

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // ── Load all data in parallel (single round-trip per table) ──────────

    console.log('Loading data...');

    const [projects, tasks, timeLogs, users, revisions, agencies, employeeRoles] = await Promise.all([
      entities.Project.list('-created_at'),
      entities.ProjectTask.filter({ is_deleted: false }),
      entities.TaskTimeLog.filter({ status: 'completed' }),
      entities.User.list(),
      entities.ProjectRevision.list(),
      entities.Agency.list(),
      entities.EmployeeRole.list(),
    ]);

    console.log(
      `Data loaded: ${projects.length} projects, ${tasks.length} tasks, ` +
      `${timeLogs.length} timeLogs, ${users.length} users, ${revisions.length} revisions`
    );

    const now = new Date();

    // ── Compute all stat groups ──────────────────────────────────────────

    const statGroups: StatGroup[] = [
      computeRevenue(projects, agencies, now),
      computePipeline(projects, tasks, now),
      computeTasks(tasks),
      computeUtilization(timeLogs, tasks, users, employeeRoles),
      computeDelivery(projects, revisions, now),
      computeVelocity(projects, now),
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

    return jsonResponse(
      {
        success: true,
        computed: statGroups.length,
        stat_keys: statGroups.map((g) => g.stat_key),
        elapsed_ms: elapsed,
      },
      200,
      req,
    );
  } catch (error: any) {
    console.error('calculateDashboardStats error:', error);
    return errorResponse(error.message || 'Internal error', 500, req);
  }
});
