import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const MAX_STAGE_DURATION_SECONDS = 90 * 24 * 3600; // 90 days hard cap

const STAGE_LABELS = {
  'pending_review': 'Pending Review',
  'to_be_scheduled': 'To Be Scheduled',
  'scheduled': 'Scheduled',
  'onsite': 'Onsite',
  'uploaded': 'Uploaded',
  'submitted': 'Submitted',
  'in_progress': 'In Progress',
  'ready_for_partial': 'Ready for Partial',
  'in_revision': 'In Revision',
  'delivered': 'Delivered'
};

function clampDuration(entryTime, exitTime) {
  const entry = new Date(entryTime).getTime();
  const exit = new Date(exitTime).getTime();
  if (isNaN(entry) || isNaN(exit)) return 0;
  const diff = Math.floor((exit - entry) / 1000);
  if (diff < 0) return 0;
  return Math.min(diff, MAX_STAGE_DURATION_SECONDS);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();

    if (payload?._health_check) {
      return Response.json({ _version: 'v2.0', _fn: 'trackProjectStageChange', _ts: '2026-03-17' });
    }

    let project;
    if (payload.event?.entity_id) {
      project = payload.data;
    } else if (payload.projectId) {
      project = await base44.asServiceRole.entities.Project.get(payload.projectId);
    }

    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const oldStatus = payload.old_data?.status;
    const newStatus = project.status;
    const actorId = payload.actor_id || null;
    const actorName = payload.actor_name || 'System';

    if (!oldStatus || oldStatus === newStatus) {
      return Response.json({ message: 'No status change detected' }, { status: 200 });
    }

    const retryWithBackoff = async (fn, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (err.status === 429 && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
    };

    const allTimers = await retryWithBackoff(() =>
      base44.asServiceRole.entities.ProjectStageTimer
        .filter({ project_id: project.id }, null, 1000)
    );

    const allOpenTimers = allTimers.filter(t => !t.exit_time);

    const batchSize = 5;
    for (let i = 0; i < allOpenTimers.length; i += batchSize) {
      const batch = allOpenTimers.slice(i, i + batchSize);
      await Promise.all(batch.map(openTimer =>
        retryWithBackoff(() => 
          base44.asServiceRole.entities.ProjectStageTimer.update(openTimer.id, {
            exit_time: now,
            duration_seconds: clampDuration(openTimer.entry_time, now),
            is_current: false,
          })
        )
      ));
    }

    const freshTimers = await retryWithBackoff(() =>
      base44.asServiceRole.entities.ProjectStageTimer
        .filter({ project_id: project.id }, null, 1000)
    );

    const alreadyOpenForNew = freshTimers.find(t => t.stage === newStatus && !t.exit_time);
    if (alreadyOpenForNew) {
      console.log(`Open timer for ${newStatus} already exists (id=${alreadyOpenForNew.id}), skipping creation`);
      return Response.json({
        message: `Open timer for ${newStatus} already exists, skipping creation`,
        idempotent: true,
      });
    }

    // Add pending_review to valid stages
    const validStages = [
      'pending_review', 'to_be_scheduled', 'scheduled', 'onsite', 'uploaded',
      'submitted', 'in_progress', 'ready_for_partial', 'in_revision', 'delivered'
    ];
    if (!validStages.includes(newStatus)) {
      console.error(`Invalid stage value: ${newStatus}`);
      return Response.json({ error: `Invalid stage: ${newStatus}` }, { status: 400 });
    }

    const existingVisitsForNew = freshTimers.filter(t => t.stage === newStatus);
    const visitNumber = existingVisitsForNew.length + 1;

    const created = await base44.asServiceRole.entities.ProjectStageTimer.create({
      project_id: project.id,
      stage: newStatus,
      entry_time: now,
      exit_time: null,
      duration_seconds: 0,
      visit_number: visitNumber,
      is_current: true,
    });

    console.log(`Created timer for stage=${newStatus}, visit #${visitNumber}, id=${created.id}`);

    try {
      const oldLabel = STAGE_LABELS[oldStatus] || oldStatus;
      const newLabel = STAGE_LABELS[newStatus] || newStatus;
      
      await base44.asServiceRole.entities.TeamActivityFeed.create({
        event_type: 'project_stage_changed',
        category: 'project',
        severity: 'info',
        actor_id: actorId,
        actor_name: actorName,
        title: `${project.title || project.property_address} moved to ${newLabel}`,
        description: `Project stage changed from ${oldLabel} to ${newLabel}`,
        project_id: project.id,
        project_name: project.title || project.property_address,
        project_address: project.property_address,
        project_stage: newStatus,
        entity_type: 'project',
        entity_id: project.id,
        metadata: JSON.stringify({ old_stage: oldStatus, new_stage: newStatus }),
      });
      console.log(`Created TeamActivityFeed entry for project stage change`);
    } catch (feedErr) {
      console.warn('Failed to create TeamActivityFeed entry:', feedErr?.message);
    }

    // Write ProjectActivity entry
    try {
      const oldLabel = STAGE_LABELS[oldStatus] || oldStatus;
      const newLabel = STAGE_LABELS[newStatus] || newStatus;
      await base44.asServiceRole.entities.ProjectActivity.create({
        project_id: project.id,
        project_title: project.title || project.property_address || '',
        action: 'status_change',
        description: `Stage changed from ${oldLabel} → ${newLabel}.`,
        actor_type: actorId ? 'human' : 'system',
        actor_source: 'trackProjectStageChange',
        user_name: actorName,
        changed_fields: JSON.stringify([{
          field: 'status',
          old_value: oldStatus,
          new_value: newStatus,
        }]),
      });
    } catch (actErr) {
      console.warn('Failed to write ProjectActivity:', actErr?.message);
    }

    // Fire notifications (non-blocking)
    try {
      const projectName = project.title || project.property_address || 'Project';
      const oldLabel = STAGE_LABELS[oldStatus] || oldStatus;
      const newLabel = STAGE_LABELS[newStatus] || newStatus;
      const idemSuffix = `${project.id}:${oldStatus}:${newStatus}:${Date.now().toString().slice(0,-4)}`;

      // Helper to resolve user IDs from role names
      const resolveRoleUsers = async (roles: string[]) => {
        const ids = new Set<string>();
        const ROLE_FIELDS: Record<string, string[]> = {
          project_owner: ['project_owner_id'],
          photographer: ['photographer_id', 'onsite_staff_1_id'],
          videographer: ['videographer_id', 'onsite_staff_2_id'],
          image_editor: ['image_editor_id'],
          video_editor: ['video_editor_id'],
          assigned_users: ['assigned_users'],
        };

        if (roles.includes('master_admin')) {
          try {
            const users = await base44.asServiceRole.entities.User.list('-created_date', 200);
            users
              .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
              .forEach((u: any) => ids.add(u.id));
          } catch { /* ignore */ }
        }

        for (const role of roles.filter(r => r !== 'master_admin')) {
          for (const field of (ROLE_FIELDS[role] || [])) {
            const val = (project as any)[field];
            if (!val) continue;
            if (field === 'assigned_users') {
              const arr = Array.isArray(val) ? val
                : (() => { try { return JSON.parse(val); } catch { return []; } })();
              arr.forEach((id: string) => id && ids.add(id));
            } else {
              ids.add(val);
            }
          }
        }

        return Array.from(ids).filter(Boolean);
      };

      // Helper to check notification preference
      const checkNotifPref = async (userId: string, type: string, category: string): Promise<boolean> => {
        try {
          const prefs = await base44.asServiceRole.entities.NotificationPreference.list('-created_date', 500);
          const up = prefs.filter((p: any) => p.user_id === userId);
          const tp = up.find((p: any) => p.notification_type === type);
          if (tp !== undefined) return tp.in_app_enabled !== false;
          const cp = up.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
          if (cp !== undefined) return cp.in_app_enabled !== false;
          return true;
        } catch { return true; }
      };

      // Helper to check for duplicate notification
      const isDupNotif = async (key: string, userId: string): Promise<boolean> => {
        try {
          const recent = await base44.asServiceRole.entities.Notification.list('-created_date', 500);
          return recent.some((n: any) => n.idempotency_key === key && n.user_id === userId);
        } catch { return false; }
      };

      // Helper to fire a single notification
      const fireNotif = async (userId: string, type: string, title: string, message: string, category: string, severity: string, idempKey?: string) => {
        const allowed = await checkNotifPref(userId, type, category);
        if (!allowed) return false;
        if (idempKey && await isDupNotif(idempKey, userId)) return false;
        await base44.asServiceRole.entities.Notification.create({
          user_id: userId,
          type,
          category,
          severity,
          title,
          message,
          project_id: project.id,
          project_name: projectName,
          entity_type: 'project',
          entity_id: project.id,
          cta_label: 'View Project',
          is_read: false,
          is_dismissed: false,
          source: 'stage_change',
          idempotency_key: idempKey || null,
        });
        return true;
      };

      // All assigned users — stage changed
      const allUserIds = await resolveRoleUsers(['project_owner', 'photographer', 'videographer', 'image_editor', 'video_editor', 'assigned_users']);
      for (const userId of allUserIds) {
        if (actorId && userId === actorId) continue; // don't notify the person who made the change
        await fireNotif(
          userId,
          'project_stage_changed',
          `${projectName} moved to ${newLabel}`,
          `Stage changed from ${oldLabel} to ${newLabel}.`,
          'project',
          'info',
          `stage_changed:${idemSuffix}:${userId}`
        );
      }

      // Delivered — notify project owner specifically
      if (newStatus === 'delivered') {
        const deliveredUsers = await resolveRoleUsers(['project_owner', 'master_admin']);
        for (const userId of deliveredUsers) {
          await fireNotif(
            userId,
            'project_delivered',
            `${projectName} delivered`,
            `Project has been delivered and moved to the Delivered stage.`,
            'project',
            'info',
            `delivered:${project.id}:${userId}`
          );
        }
      }

      // Onsite — notify photographer
      if (newStatus === 'onsite') {
        const photoUsers = await resolveRoleUsers(['photographer']);
        for (const userId of photoUsers) {
          await fireNotif(
            userId,
            'shoot_moved_to_onsite',
            `${projectName} is now Onsite`,
            `The shoot has started. Project moved to Onsite.`,
            'scheduling',
            'info',
            `onsite:${project.id}:${userId}`
          );
        }
      }
    } catch (notifErr) {
      console.warn('Failed to fire stage change notifications:', (notifErr as any)?.message);
    }

    // Fire deadline recalculation after every stage change.
    // This unblocks tasks whose timer_trigger matches the new stage
    // (e.g. tasks waiting for 'project_onsite' unblock when status → onsite).
    // Fire-and-forget — don't block the stage change response on this.
    base44.asServiceRole.functions.invoke('calculateProjectTaskDeadlines', {
      project_id: project.id,
      trigger_event: `stage_change_to_${newStatus}`,
    }).catch((err: any) => {
      console.warn('calculateProjectTaskDeadlines fire-and-forget failed:', err?.message);
    });

    // Fix 1a — run automation rules on every stage change
    base44.asServiceRole.functions.invoke('runProjectAutomationRules', {
      project_id: project.id,
      trigger: 'stage_change',
      new_stage: newStatus,
      old_stage: oldStatus,
    }).catch(() => {});

    // Fix 2a — update Agent + Agency denormalised stats when project closes
    if (project.agent_id && (newStatus === 'delivered' || project.outcome === 'won')) {
      try {
        const allAgentProjects = await base44.asServiceRole.entities.Project.filter(
          { agent_id: project.agent_id }, null, 500
        );
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        const wonProjects = allAgentProjects.filter(
          (p: any) => p.outcome === 'won' || p.status === 'delivered'
        );
        const recent12m = wonProjects.filter((p: any) => {
          const d = p.shoot_date || p.created_date;
          return d && new Date(d) >= twelveMonthsAgo;
        });
        const totalRev = wonProjects.reduce(
          (s: number, p: any) => s + (p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0), 0
        );
        const avgValue = wonProjects.length > 0 ? Math.round(totalRev / wonProjects.length) : 0;
        const lastBookingDates = allAgentProjects
          .map((p: any) => p.shoot_date || p.created_date)
          .filter(Boolean)
          .map((d: string) => new Date(d).getTime());
        const lastBookingAt = lastBookingDates.length > 0
          ? new Date(Math.max(...lastBookingDates)).toISOString()
          : null;
        await base44.asServiceRole.entities.Agent.update(project.agent_id, {
          booking_count_12m: recent12m.length,
          average_booking_value: avgValue,
          ...(lastBookingAt ? { last_booking_at: lastBookingAt } : {}),
        }).catch(() => {});
        if (project.agency_id) {
          const agencyProjects = allAgentProjects.filter((p: any) => p.agency_id === project.agency_id);
          const agencyWon = agencyProjects.filter((p: any) => p.outcome === 'won' || p.status === 'delivered');
          const agencyRev = agencyWon.reduce(
            (s: number, p: any) => s + (p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0), 0
          );
          const agencyLastDates = agencyProjects
            .map((p: any) => p.shoot_date || p.created_date).filter(Boolean)
            .map((d: string) => new Date(d).getTime());
          const agencyLastAt = agencyLastDates.length > 0
            ? new Date(Math.max(...agencyLastDates)).toISOString() : null;
          await base44.asServiceRole.entities.Agency.update(project.agency_id, {
            total_revenue: agencyRev,
            ...(agencyLastAt ? { last_booking_at: agencyLastAt } : {}),
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    // Fix 4a — mark FlexMedia CalendarEvents done when project cancelled
    if (newStatus === 'cancelled') {
      try {
        const linkedEvents = await base44.asServiceRole.entities.CalendarEvent.filter(
          { project_id: project.id }, null, 100
        );
        const flexMediaEvents = linkedEvents.filter(
          (ev: any) => !ev.tonomo_appointment_id && ev.event_source !== 'google'
        );
        for (const ev of flexMediaEvents) {
          await base44.asServiceRole.entities.CalendarEvent.update(ev.id, {
            is_done: true,
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    // Fix 7c — refresh employee utilization when project closes
    if (newStatus === 'delivered' || newStatus === 'cancelled') {
      base44.asServiceRole.functions.invoke('calculateEmployeeUtilization', {
        trigger: 'project_closed',
        project_id: project.id,
      }).catch(() => {});
    }

    // Fix 2 — stop all running timers when project is cancelled or delivered
    if (newStatus === 'cancelled' || newStatus === 'delivered') {
      try {
        const activeLogs = await base44.asServiceRole.entities.TaskTimeLog.filter(
          { project_id: project.id, is_active: true },
          null,
          200
        );
        const now = new Date().toISOString();
        for (const log of activeLogs) {
          const startMs = log.start_time ? new Date(log.start_time).getTime() : Date.now();
          const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
          await base44.asServiceRole.entities.TaskTimeLog.update(log.id, {
            is_active: false,
            status: 'completed',
            end_time: now,
            total_seconds: (log.total_seconds || 0) + elapsedSeconds,
          }).catch(() => {});
        }
        if (activeLogs.length > 0) {
          console.log(`[trackProjectStageChange] Stopped ${activeLogs.length} active timer(s) on ${newStatus} for project ${project.id}`);
        }
      } catch { /* non-fatal */ }
    }

    // Fix 8 — when delivered, archive incomplete tasks so overdue notifications stop firing
    if (newStatus === 'delivered') {
      try {
        const openTasks = await base44.asServiceRole.entities.ProjectTask.filter(
          { project_id: project.id },
          null,
          500
        );
        const incomplete = openTasks.filter(
          (t: any) => !t.is_completed && !t.is_deleted && !t.is_archived
        );
        for (const task of incomplete) {
          await base44.asServiceRole.entities.ProjectTask.update(task.id, {
            is_archived: true,
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    return Response.json({
      success: true,
      message: `Tracked stage change from ${oldStatus} to ${newStatus}`,
      visitNumber,
      timerId: created.id,
    });
  } catch (error) {
    console.error('Error tracking project stage change:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});