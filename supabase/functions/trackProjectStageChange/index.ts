import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, serveWithAudit } from '../_shared/supabase.ts';
import { MAX_USERS_FETCH } from '../_shared/constants.ts';

const STAGE_LABELS: Record<string, string> = {
  'pending_review': 'Pending Review',
  'to_be_scheduled': 'To Be Scheduled',
  'scheduled': 'Scheduled',
  'onsite': 'Onsite',
  'uploaded': 'Uploaded',
  'in_progress': 'Stills in Progress',
  'in_production': 'Video in Progress',
  'in_revision': 'In Revision',
  'delivered': 'Delivered',
};

serveWithAudit('trackProjectStageChange', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const payload = await req.json().catch(() => ({} as any));

    if (payload?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'trackProjectStageChange', _ts: '2026-03-17' });
    }

    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    let project: any;
    if (payload.event?.entity_id) {
      project = payload.data;
    } else if (payload.projectId) {
      project = await entities.Project.get(payload.projectId);
    }

    if (!project?.id) {
      return errorResponse('Project not found or missing id', 404);
    }

    const oldStatus = payload.old_data?.status;
    const newStatus = project.status;
    const actorId = payload.actor_id || null;
    const actorName = payload.actor_name || 'System';

    if (!oldStatus || oldStatus === newStatus) {
      return jsonResponse({ message: 'No status change detected' });
    }

    // ── Open-revision guard (2026-04-20) ────────────────────────────────
    // Matches the DB-level trg_project_revision_guard (migration 203). Runs
    // here too so the UI gets a clean 409 with a readable message instead of
    // catching a Postgres EXCEPTION that has already aborted the transaction
    // higher up. Do NOT remove this duplicate — the DB trigger is the real
    // source of truth; this is just for UX.
    if (oldStatus === 'in_revision' && newStatus !== 'in_revision') {
      const revisions = await entities.ProjectRevision.filter({ project_id: project.id }, null, 500).catch(() => []);
      const openRevisions = revisions.filter((r: any) =>
        !['completed', 'delivered', 'cancelled', 'rejected'].includes(r.status)
      );
      if (openRevisions.length > 0) {
        return jsonResponse({
          blocked: true,
          code: 'open_revisions_exist',
          message: `Cannot move out of In Revision: ${openRevisions.length} open revision(s) still need to be closed. Mark the revision(s) as completed or cancel them first.`,
          open_revision_ids: openRevisions.map((r: any) => r.id),
        }, 409);
      }
    }

    // Timer rows are managed by the `project_stage_timer_sync` AFTER UPDATE
    // trigger on `projects` (migration source-of-truth). Doing it here too
    // raced with the trigger — the edge fn would close the trigger's freshly
    // opened timer, leading to projects with NO open timer for the current
    // stage and a frozen UI counter. This function now only fires side-effects.
    const validStages = [
      'pending_review', 'to_be_scheduled', 'scheduled', 'onsite', 'uploaded',
      'in_progress', 'in_production', 'in_revision', 'delivered',
    ];
    if (!validStages.includes(newStatus)) {
      console.error(`Invalid stage value: ${newStatus}`);
      return errorResponse(`Invalid stage: ${newStatus}`, 400);
    }

    // ─── Hard rule: cannot advance past "onsite" until at least 1 calendar event has ended ───
    const POST_ONSITE_STAGES = ['uploaded', 'in_progress', 'in_production', 'in_revision', 'delivered'];
    if (POST_ONSITE_STAGES.includes(newStatus)) {
      try {
        const calendarEvents = await entities.CalendarEvent.filter({ project_id: project.id }, null, 100);
        const nowMs = Date.now();
        const hasEndedEvent = (calendarEvents || []).some((ev: any) => {
          if (!ev.end_time) return false;
          return new Date(ev.end_time).getTime() < nowMs;
        });
        if (!hasEndedEvent) {
          console.warn(`Stage gate blocked: ${project.id} cannot move to ${newStatus} — no calendar event has ended yet`);
          return jsonResponse({
            blocked: true,
            message: 'This project cannot advance past Onsite until at least one calendar event has ended. The shoot must have occurred before post-production stages can begin.',
          }, 400);
        }
      } catch (calErr: any) {
        // Non-fatal: log but allow the transition if calendar query fails
        console.error('Calendar event check failed (allowing transition):', calErr?.message);
      }
    }

    // TeamActivityFeed entry
    try {
      const oldLabel = STAGE_LABELS[oldStatus] || oldStatus;
      const newLabel = STAGE_LABELS[newStatus] || newStatus;
      await entities.TeamActivityFeed.create({
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
    } catch (feedErr: any) {
      console.warn('Failed to create TeamActivityFeed entry:', feedErr?.message);
    }

    // ProjectActivity entry
    try {
      const oldLabel = STAGE_LABELS[oldStatus] || oldStatus;
      const newLabel = STAGE_LABELS[newStatus] || newStatus;
      await entities.ProjectActivity.create({
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
    } catch (actErr: any) {
      console.warn('Failed to write ProjectActivity:', actErr?.message);
    }

    // Fire notifications (non-blocking)
    try {
      const projectName = project.title || project.property_address || 'Project';
      const oldLabel = STAGE_LABELS[oldStatus] || oldStatus;
      const newLabel = STAGE_LABELS[newStatus] || newStatus;
      const idemSuffix = `${project.id}:${newStatus}:${new Date().toISOString().slice(0, 10)}`;

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
            const users = await entities.User.list('-created_date', MAX_USERS_FETCH);
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

      const checkNotifPref = async (userId: string, type: string, category: string): Promise<boolean> => {
        try {
          const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 100);
          const tp = prefs.find((p: any) => p.notification_type === type);
          if (tp !== undefined) return tp.in_app_enabled !== false;
          const cp = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
          if (cp !== undefined) return cp.in_app_enabled !== false;
          return true;
        } catch { return true; }
      };

      const isDupNotif = async (key: string, userId: string): Promise<boolean> => {
        try {
          const recent = await entities.Notification.filter(
            { idempotency_key: key, user_id: userId }, null, 1
          );
          return recent.length > 0;
        } catch (err: any) {
          // Fail CLOSED: on a transient query error, assume the notification
          // was already sent rather than risk duplicating it. Dropping one
          // notification is recoverable; spamming operators is not.
          console.error(`[trackProjectStageChange] notification dedup check failed for ${key}:${userId}, failing closed:`, err?.message);
          return true;
        }
      };

      const fireNotif = async (userId: string, type: string, title: string, message: string, category: string, severity: string, idempKey?: string) => {
        try {
          const allowed = await checkNotifPref(userId, type, category);
          if (!allowed) return false;
          if (idempKey && await isDupNotif(idempKey, userId)) return false;
          await entities.Notification.create({
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
            created_date: new Date().toISOString(),
          });
          return true;
        } catch (err: any) {
          console.error(`Failed to create stage-change notification (type=${type}, user=${userId}):`, err?.message);
          return false;
        }
      };

      // All assigned users -- stage changed
      const allUserIds = await resolveRoleUsers(['project_owner', 'photographer', 'videographer', 'image_editor', 'video_editor', 'assigned_users']);
      for (const userId of allUserIds) {
        if (actorId && userId === actorId) continue;
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

      // Delivered -- notify project owner specifically
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

      // Onsite -- notify photographer
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
    } catch (notifErr: any) {
      console.warn('Failed to fire stage change notifications:', notifErr?.message);
    }

    // Fire deadline recalculation (fire-and-forget)
    invokeFunction('calculateProjectTaskDeadlines', {
      project_id: project.id,
      trigger_event: `stage_change_to_${newStatus}`,
    }, 'trackProjectStageChange').catch((err: any) => {
      console.warn('calculateProjectTaskDeadlines fire-and-forget failed:', err?.message);
    });

    // Run automation rules on every stage change
    invokeFunction('runProjectAutomationRules', {
      project_id: project.id,
      trigger: 'stage_change',
      new_stage: newStatus,
      old_stage: oldStatus,
    }, 'trackProjectStageChange').catch(() => {});

    // Auto-complete onsite effort tasks when project reaches uploaded or beyond
    const STAGE_ORDER_LOG = ['pending_review','to_be_scheduled','scheduled','onsite','uploaded','in_progress','in_production','in_revision','delivered'];
    const newIdx = STAGE_ORDER_LOG.indexOf(newStatus);
    const uploadedIdx = STAGE_ORDER_LOG.indexOf('uploaded');
    if (newIdx >= uploadedIdx) {
      invokeFunction('logOnsiteEffortOnUpload', {
        project_id: project.id,
        old_status: oldStatus,
      }, 'trackProjectStageChange').catch((err: any) => {
        console.warn('logOnsiteEffortOnUpload fire-and-forget failed:', err?.message);
      });
    }

    // Update Agent + Agency denormalised stats when project closes
    if (project.agent_id && (newStatus === 'delivered' || project.outcome === 'won')) {
      try {
        const allAgentProjects = await entities.Project.filter(
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
        await entities.Agent.update(project.agent_id, {
          booking_count_12m: recent12m.length,
          average_booking_value: avgValue,
          ...(lastBookingAt ? { last_booking_at: lastBookingAt } : {}),
        });
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
          await entities.Agency.update(project.agency_id, {
            total_revenue: agencyRev,
            ...(agencyLastAt ? { last_booking_at: agencyLastAt } : {}),
          });
        }
      } catch { /* non-fatal */ }
    }

    // Mark FlexStudios CalendarEvents done when project cancelled
    if (newStatus === 'cancelled') {
      try {
        const linkedEvents = await entities.CalendarEvent.filter(
          { project_id: project.id }, null, 100
        );
        const flexMediaEvents = linkedEvents.filter(
          (ev: any) => !ev.tonomo_appointment_id && ev.event_source !== 'google'
        );
        for (const ev of flexMediaEvents) {
          await entities.CalendarEvent.update(ev.id, { is_done: true }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    // Refresh employee utilization when project closes
    if (newStatus === 'delivered' || newStatus === 'cancelled') {
      invokeFunction('calculateEmployeeUtilization', {
        trigger: 'project_closed',
        project_id: project.id,
      }, 'trackProjectStageChange').catch(() => {});
    }

    // Stop all running timers when project is cancelled or delivered
    if (newStatus === 'cancelled' || newStatus === 'delivered') {
      try {
        const activeLogs = await entities.TaskTimeLog.filter(
          { project_id: project.id, is_active: true }, null, 200
        );
        const stopNow = new Date().toISOString();
        for (const log of activeLogs) {
          let finalSeconds = log.total_seconds || 0;
          if (log.status === 'running' && log.start_time) {
            const startMs = new Date(log.start_time).getTime();
            const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
            finalSeconds = elapsedSeconds - (log.paused_duration || 0);
          }
          // For paused timers, total_seconds is already correct — don't add elapsed
          await entities.TaskTimeLog.update(log.id, {
            is_active: false,
            status: 'completed',
            end_time: stopNow,
            total_seconds: Math.max(0, finalSeconds),
          }).catch(() => {});
        }
        if (activeLogs.length > 0) {
          console.log(`[trackProjectStageChange] Stopped ${activeLogs.length} active timer(s) on ${newStatus} for project ${project.id}`);
        }
      } catch { /* non-fatal */ }
    }

    // When delivered, archive incomplete tasks so overdue notifications stop firing
    if (newStatus === 'delivered') {
      try {
        const openTasks = await entities.ProjectTask.filter(
          { project_id: project.id }, null, 500
        );
        const incomplete = openTasks.filter(
          (t: any) => !t.is_completed && !t.is_deleted && !t.is_archived
        );
        const archivedTasks: Array<{ id: string; title: string }> = [];
        for (const task of incomplete) {
          try {
            await entities.ProjectTask.update(task.id, { is_archived: true });
            archivedTasks.push({ id: task.id, title: task.title || 'Untitled task' });
          } catch { /* non-fatal */ }
        }
        if (archivedTasks.length > 0) {
          try {
            await entities.ProjectActivity.create({
              project_id: project.id,
              project_title: project.title || project.property_address || '',
              action: 'task_auto_archived',
              description: `Auto-archived ${archivedTasks.length} incomplete task${archivedTasks.length === 1 ? '' : 's'} on delivery: ${archivedTasks.slice(0, 5).map(t => t.title).join(', ')}${archivedTasks.length > 5 ? `, +${archivedTasks.length - 5} more` : ''}.`,
              actor_type: 'system',
              actor_source: 'trackProjectStageChange',
              user_name: 'System',
              user_email: 'system@flexstudios.app',
              metadata: JSON.stringify({
                trigger: 'project_delivered',
                tasks: archivedTasks,
              }),
            });
          } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
    }

    return jsonResponse({
      success: true,
      message: `Tracked stage change from ${oldStatus} to ${newStatus}`,
    });
  } catch (error: any) {
    console.error('Error tracking project stage change:', error);
    return errorResponse(error.message);
  }
});
