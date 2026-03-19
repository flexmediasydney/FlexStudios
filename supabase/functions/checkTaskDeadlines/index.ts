import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────
const _NOTIF_ROLES: Record<string, string[]> = {
  project_owner:  ['project_owner_id'],
  photographer:   ['photographer_id', 'onsite_staff_1_id'],
  image_editor:   ['image_editor_id'],
  video_editor:   ['video_editor_id'],
  videographer:   ['videographer_id', 'onsite_staff_2_id'],
  assigned_users: ['assigned_users'],
};

async function _resolveUserIds(entities: any, roles: string[], projectId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  if (roles.includes('master_admin')) {
    try {
      const users = await entities.User.list('-created_date', 200);
      users.filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
           .forEach((u: any) => ids.add(u.id));
    } catch { /* ignore */ }
  }
  if (projectId) {
    const pRoles = roles.filter((r) => r !== 'master_admin');
    if (pRoles.length > 0) {
      try {
        const p = await entities.Project.get(projectId);
        if (p) {
          for (const role of pRoles) {
            for (const field of (_NOTIF_ROLES[role] || [])) {
              const val = p[field];
              if (!val) continue;
              if (field === 'assigned_users') {
                (Array.isArray(val) ? val : (() => { try { return JSON.parse(val); } catch { return []; } })())
                  .forEach((id: string) => id && ids.add(id));
              } else { ids.add(val); }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }
  return Array.from(ids).filter(Boolean);
}

async function _checkNotifPref(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    const prefs = await entities.NotificationPreference.list('-created_date', 500);
    const up = prefs.filter((p: any) => p.user_id === userId);
    const tp = up.find((p: any) => p.notification_type === type);
    if (tp !== undefined) return tp.in_app_enabled !== false;
    const cp = up.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (cp !== undefined) return cp.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

async function _isDupNotif(entities: any, key: string, userId: string): Promise<boolean> {
  try {
    const recent = await entities.Notification.list('-created_date', 500);
    return recent.some((n: any) => n.idempotency_key === key && n.user_id === userId);
  } catch { return false; }
}

async function _createNotif(entities: any, p: any): Promise<boolean> {
  const allowed = await _checkNotifPref(entities, p.userId, p.type, p.category);
  if (!allowed) return false;
  if (p.idempotencyKey && await _isDupNotif(entities, p.idempotencyKey, p.userId)) return false;
  await entities.Notification.create({
    user_id: p.userId, type: p.type, category: p.category, severity: p.severity,
    title: p.title, message: p.message, project_id: p.projectId || null,
    project_name: p.projectName || null, entity_type: p.entityType || null,
    entity_id: p.entityId || null, cta_url: p.ctaUrl || null,
    cta_label: p.ctaLabel || 'View', cta_params: p.ctaParams ? JSON.stringify(p.ctaParams) : null,
    is_read: false, is_dismissed: false, source: p.source || 'system',
    source_rule_id: p.sourceRuleId || null, idempotency_key: p.idempotencyKey || null,
    created_date: new Date().toISOString(),
  });
  return true;
}
// ─── END NOTIFICATION HELPERS ─────────────────────────────────────────

function toSydney(date: Date): Date {
  return new Date(date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" }));
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const admin = getAdminClient();
  const entities = createEntities(admin);
  const now = toSydney(new Date());
  const todayStr = now.toISOString().slice(0, 10);
  let notified = 0;
  let activeTasks: any[] = [];

  try {
    // Check task deadlines
    const tasks = await entities.ProjectTask.list('-created_date', 2000);
    activeTasks = tasks.filter((t: any) =>
      t.assigned_to && !t.is_completed && t.due_date
    );

    for (const task of activeTasks) {
      const due = new Date(task.due_date?.endsWith("Z") ? task.due_date : task.due_date + "Z");
      const msToDue = due.getTime() - now.getTime();
      const hoursUntilDue = msToDue / (1000 * 60 * 60);

      // Overdue
      if (hoursUntilDue < 0) {
        const overdueDays = Math.floor(Math.abs(hoursUntilDue) / 24);
        const ok = await _createNotif(entities, {
          userId: task.assigned_to,
          type: "task_overdue",
          title: `Task overdue: ${task.title || "Unnamed task"}`,
          message: `This task is ${overdueDays}d overdue`,
          category: "task",
          severity: "warning",
          projectId: task.project_id,
          entityType: "task",
          entityId: task.id,
          ctaUrl: "ProjectDetails",
          ctaLabel: "View Task",
          ctaParams: { id: task.project_id },
          source: "system",
          idempotencyKey: `task_overdue:${task.id}:${todayStr}`,
        });
        if (ok) notified++;
        continue;
      }

      // Approaching (within 24 hours)
      if (hoursUntilDue <= 24) {
        const ok = await _createNotif(entities, {
          userId: task.assigned_to,
          type: "task_deadline_approaching",
          title: `Task due soon: ${task.title || "Unnamed task"}`,
          message: `Due in ${Math.round(hoursUntilDue)}h`,
          category: "task",
          severity: "info",
          projectId: task.project_id,
          entityType: "task",
          entityId: task.id,
          ctaUrl: "ProjectDetails",
          ctaLabel: "View Task",
          ctaParams: { id: task.project_id },
          source: "system",
          idempotencyKey: `task_deadline_approaching:${task.id}:${todayStr}`,
        });
        if (ok) notified++;
      }
    }

    // Check long-running timers
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    try {
      const timeLogs = await entities.TaskTimeLog.list('-created_date', 1000);
      const runningLong = timeLogs.filter((t: any) =>
        t.start_time &&
        !t.end_time &&
        t.status === 'running' &&
        new Date(t.start_time?.endsWith("Z") ? t.start_time : t.start_time + "Z") < twoHoursAgo
      );

      for (const timer of runningLong) {
        if (!timer.user_id) continue;
        const hoursRunning = Math.floor(
          (now.getTime() - new Date(timer.start_time?.endsWith("Z") ? timer.start_time : timer.start_time + "Z").getTime())
          / (1000 * 60 * 60)
        );
        const ok = await _createNotif(entities, {
          userId: timer.user_id,
          type: "timer_running_warning",
          title: `Timer has been running ${hoursRunning}h`,
          message: `Did you forget to stop your timer? It's been running since ${
            new Date(timer.start_time?.endsWith("Z") ? timer.start_time : timer.start_time + "Z")
              .toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })
          }`,
          category: "task",
          severity: "warning",
          projectId: timer.project_id || null,
          entityType: "task",
          entityId: timer.task_id || timer.id,
          source: "system",
          idempotencyKey: `timer_running_warning:${timer.id}:${todayStr}`,
        });
        if (ok) notified++;
      }
    } catch { /* Timer entity may not exist — skip silently */ }

    // ── PROJECT STALENESS AND OVERDUE CHECKS
    try {
      const allProjects = await entities.Project.list('-last_status_change', 500);

      const STALE_HOURS = 48;
      const staleThreshold = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);

      for (const project of allProjects) {
        if (!project?.id) continue;

        const projectName = project.title || project.property_address || 'Project';
        const ownerIds = [project.project_owner_id].filter(Boolean);

        // shoot_overdue: shoot date passed, project not delivered/cancelled
        if (
          project.shoot_date &&
          new Date(project.shoot_date) < now &&
          !['delivered', 'cancelled', 'pending_review'].includes(project.status)
        ) {
          const overdueDays = Math.floor(
            (now.getTime() - new Date(project.shoot_date).getTime()) / (1000 * 60 * 60 * 24)
          );
          if (overdueDays >= 1) {
            const adminIds = await _resolveUserIds(entities, ['master_admin'], null);
            const notifyIds = new Set([...ownerIds, ...adminIds]);
            for (const userId of notifyIds) {
              const ok = await _createNotif(entities, {
                userId,
                type: 'shoot_overdue',
                title: `Shoot overdue: ${projectName}`,
                message: `Shoot was ${overdueDays} day${overdueDays > 1 ? 's' : ''} ago — project is still ${project.status.replace(/_/g, ' ')}.`,
                category: 'scheduling',
                severity: 'warning',
                projectId: project.id,
                projectName,
                source: 'system',
                idempotencyKey: `shoot_overdue:${project.id}:${todayStr}`,
              });
              if (ok) notified++;
            }
          }
        }

        // stale_production: stuck in production/uploaded stages >48h
        const productionStages = ['uploaded', 'in_progress', 'ready_for_partial'];
        if (
          productionStages.includes(project.status) &&
          project.last_status_change &&
          new Date(project.last_status_change) < staleThreshold
        ) {
          const staleHours = Math.floor(
            (now.getTime() - new Date(project.last_status_change).getTime()) / (1000 * 60 * 60)
          );
          for (const userId of ownerIds) {
            const ok = await _createNotif(entities, {
              userId,
              type: 'stale_production',
              title: `Project stalled in production: ${projectName}`,
              message: `No progress in ${staleHours}h — currently ${project.status.replace(/_/g, ' ')}.`,
              category: 'project',
              severity: 'warning',
              projectId: project.id,
              projectName,
              source: 'system',
              idempotencyKey: `stale_production:${project.id}:${todayStr}`,
            });
            if (ok) notified++;
          }
        }

        // stale_submitted: stuck in submitted >48h
        if (
          project.status === 'submitted' &&
          project.last_status_change &&
          new Date(project.last_status_change) < staleThreshold
        ) {
          const staleHours = Math.floor(
            (now.getTime() - new Date(project.last_status_change).getTime()) / (1000 * 60 * 60)
          );
          const adminIds = await _resolveUserIds(entities, ['master_admin'], null);
          const notifyIds = new Set([...ownerIds, ...adminIds]);
          for (const userId of notifyIds) {
            const ok = await _createNotif(entities, {
              userId,
              type: 'stale_submitted',
              title: `Project awaiting review: ${projectName}`,
              message: `Submitted ${staleHours}h ago with no status change. Needs review.`,
              category: 'project',
              severity: 'warning',
              projectId: project.id,
              projectName,
              source: 'system',
              idempotencyKey: `stale_submitted:${project.id}:${todayStr}`,
            });
            if (ok) notified++;
          }
        }
      }
    } catch { /* non-fatal — don't break task deadline notifications */ }

    // ── INVOICE OVERDUE CHECKS
    try {
      const deliveredProjects = await entities.Project.filter({ status: 'delivered' }, null, 500);
      const unpaid = deliveredProjects.filter((p: any) =>
        p.payment_status !== 'paid' &&
        p.invoiced_amount && p.invoiced_amount > 0
      );

      for (const project of unpaid) {
        const deliveredDate = project.last_status_change
          ? new Date(project.last_status_change)
          : null;
        if (!deliveredDate) continue;

        const daysSinceDelivery = Math.floor(
          (now.getTime() - deliveredDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        const adminIds = await _resolveUserIds(entities, ['master_admin'], null);
        const ownerIds = project.project_owner_id ? [project.project_owner_id] : [];
        const notifyIds = new Set([...adminIds, ...ownerIds]);
        const projectName = project.title || project.property_address || 'Project';

        if (daysSinceDelivery >= 14) {
          for (const userId of notifyIds) {
            await _createNotif(entities, {
              userId,
              type: 'invoice_overdue_14d',
              title: `Invoice overdue 14+ days: ${projectName}`,
              message: `Delivered ${daysSinceDelivery} days ago — payment not recorded. Please follow up urgently.`,
              category: 'financial',
              severity: 'critical',
              projectId: project.id,
              projectName,
              source: 'system',
              idempotencyKey: `invoice_overdue_14d:${project.id}:${todayStr}`,
            });
          }
        } else if (daysSinceDelivery >= 7) {
          for (const userId of notifyIds) {
            await _createNotif(entities, {
              userId,
              type: 'invoice_overdue_7d',
              title: `Invoice outstanding 7+ days: ${projectName}`,
              message: `Delivered ${daysSinceDelivery} days ago — payment not yet recorded.`,
              category: 'financial',
              severity: 'warning',
              projectId: project.id,
              projectName,
              source: 'system',
              idempotencyKey: `invoice_overdue_7d:${project.id}:${todayStr}`,
            });
          }
        }
      }
    } catch { /* non-fatal */ }

    return jsonResponse({
      message: `Checked ${activeTasks.length} tasks and project staleness, notified ${notified} users`,
      timestamp: now.toISOString(),
    });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 200);
  }
});
