import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, isQuietHours, getUserFromReq } from '../_shared/supabase.ts';

async function _canNotify(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    if (await isQuietHours(userId)) return false;
    const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 50);
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

/**
 * Triggered when a project moves to "uploaded" or further.
 * Finds the existing onsite tasks (created by syncOnsiteEffortTasks),
 * marks them completed + locked, and creates a completed TaskTimeLog for each.
 * Idempotent — skips tasks that are already completed.
 *
 * IMPORTANT: Only acts on status TRANSITIONS to uploaded stages, not on every update.
 * After completing tasks + creating logs, explicitly triggers effort recalculation.
 */
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const payload = await req.json();

    if (payload?._health_check) {
      return jsonResponse({ _version: 'v1.1', _fn: 'logOnsiteEffortOnUpload', _ts: '2026-03-17' });
    }

    // ── Auth: require any authenticated user or service role ──
    const user = await getUserFromReq(req).catch(() => null);
    if (!user) {
      const authHeader = req.headers.get('authorization') || '';
      if (!authHeader.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '___')) {
        return errorResponse('Authentication required', 401);
      }
    }

    // Support entity automation payload or direct call
    let project: any;
    let project_id: string;
    let old_status: string | undefined;

    if (payload.event?.entity_id) {
      project = payload.data;
      project_id = payload.event.entity_id;
      old_status = payload.old_data?.status;
    } else if (payload.project_id) {
      project_id = payload.project_id;
      project = await entities.Project.get(project_id);
      old_status = payload.old_status ?? null;
    } else {
      return errorResponse('Project not found', 404);
    }

    if (!project || !project_id) {
      return errorResponse('Project not found', 404);
    }

    // Guard: only process if project is currently at "uploaded" or further.
    // Uses ordered stage index — no hardcoded stage lists. Handles skipped stages
    // (e.g., pending_review → in_production skipping uploaded) correctly.
    const STAGE_ORDER = [
      'pending_review', 'to_be_scheduled', 'scheduled', 'onsite',
      'uploaded', 'submitted', 'in_progress', 'in_production',
      'ready_for_partial', 'in_revision', 'delivered',
    ];
    const currentIdx = STAGE_ORDER.indexOf(project.status);
    const uploadedIdx = STAGE_ORDER.indexOf('uploaded');

    if (currentIdx < uploadedIdx) {
      return jsonResponse({ message: 'Project not yet at uploaded stage', status: project.status, skipped: true });
    }

    // Find existing onsite tasks created by syncOnsiteEffortTasks
    const allTasks = await entities.ProjectTask.filter({ project_id }, null, 1000);
    const onsiteTasks = allTasks.filter((t: any) =>
      (t.template_id === 'onsite:photographer' || t.template_id === 'onsite:videographer') &&
      !t.is_deleted
    );

    if (onsiteTasks.length === 0) {
      return jsonResponse({ message: 'No onsite tasks found to complete', completed: 0 });
    }

    // Guard: shoot_date must be present
    if (!project.shoot_date) {
      console.warn(`logOnsiteEffortOnUpload: project ${project_id} has no shoot_date — skipping time log creation.`);
      for (const task of onsiteTasks) {
        if (!task.is_completed) {
          await entities.ProjectTask.update(task.id, {
            is_completed: true,
            is_locked: true,
            shoot_date_missing: true,
          });
        }
      }
      return jsonResponse({
        success: true,
        project_id,
        completed: 0,
        warning: 'shoot_date missing — time logs not created, tasks flagged for manual entry',
      });
    }

    // Parse as Sydney wall-clock time by trying AEDT (+11) then AEST (+10).
    const shootStart = (() => {
      if (!project.shoot_date) return new Date().toISOString();
      const rawTime = project.shoot_time || '09:00';
      const timeStr = /^\d{1,2}:\d{2}$/.test(rawTime) ? rawTime : '09:00';
      // shoot_date may come as "2026-04-10T00:00:00+00:00" or "2026-04-10" — extract just the date part
      const dateOnly = String(project.shoot_date).slice(0, 10);
      const naiveDateStr = `${dateOnly}T${timeStr}:00`;
      const targetHour = parseInt(timeStr.split(':')[0], 10);
      const tryOffset = (offset: string) => {
        const d = new Date(`${naiveDateStr}${offset}`);
        if (isNaN(d.getTime())) return null;
        const parts = new Intl.DateTimeFormat('en-AU', {
          timeZone: 'Australia/Sydney',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(d);
        const localHour = parseInt(parts.find((p: any) => p.type === 'hour')?.value ?? '0', 10);
        return Math.abs(localHour - targetHour) <= 1 ? d.toISOString() : null;
      };
      const aedt = tryOffset('+11:00');
      if (aedt) return aedt;
      console.warn(`[logOnsiteEffort] project ${project_id}: using AEST fallback (+10:00) — DST ambiguity`);
      return tryOffset('+10:00') || new Date(`${naiveDateStr}+10:00`).toISOString();
    })();

    let completed = 0;

    for (const task of onsiteTasks) {
      // Skip if already completed AND locked (fully processed)
      if (task.is_completed && task.is_locked) continue;

      const isPhotographer = task.template_id === 'onsite:photographer';
      const role = isPhotographer ? 'photographer' : 'videographer';

      const isTeamStaff = !!task.assigned_to_team_id;
      const staffId = isTeamStaff ? task.assigned_to_team_id : task.assigned_to;
      const staffName = isTeamStaff ? task.assigned_to_team_name : task.assigned_to_name;
      const staffType = isTeamStaff ? 'team' : 'individual';
      const taskSeconds = (task.estimated_minutes || 0) * 60;

      const shootEnd = taskSeconds > 0
        ? new Date(new Date(shootStart).getTime() + taskSeconds * 1000).toISOString()
        : shootStart;

      // Create time log FIRST — if this fails, task stays unlocked for retry
      if (taskSeconds > 0) {
        const existingLogs = await entities.TaskTimeLog.filter({ task_id: task.id }, null, 10);
        if (existingLogs.length === 0) {
          // Resolve a valid user_id: prefer task assignee, then project photographer, then project owner, then any admin
          let logUserId = staffType !== 'team' ? staffId : null;
          if (!logUserId) logUserId = project.photographer_id || project.project_owner_id || null;
          // Validate the user exists before writing
          if (logUserId) {
            const userCheck = await admin.from('users').select('id').eq('id', logUserId).maybeSingle();
            if (!userCheck?.data) logUserId = null;
          }
          // Last resort: find any admin user
          if (!logUserId) {
            const { data: admins } = await admin.from('users').select('id').in('role', ['master_admin', 'admin']).limit(1);
            logUserId = admins?.[0]?.id || null;
          }

          await entities.TaskTimeLog.create({
            task_id: task.id,
            project_id,
            user_id: logUserId,
            user_name: staffName || '',
            role,
            start_time: shootStart,
            end_time: shootEnd,
            total_seconds: taskSeconds,
            paused_duration: 0,
            is_active: false,
            status: 'completed',
            log_source: 'auto_onsite',
          });
          console.log(`Created time log for ${role}: ${taskSeconds}s`);
        } else {
          console.log(`Time log already exists for task ${task.id} (${role}), skipping`);
        }
      }

      // Mark task as completed + locked AFTER time log is created
      await entities.ProjectTask.update(task.id, {
        is_completed: true,
        is_locked: true,
        total_effort_logged: taskSeconds,
      });

      completed++;
    }

    // Effort recalculation is intentionally NOT done here.
    // Creating the TaskTimeLog records above will trigger updateProjectEffortRealtimeRobust
    // via automation, which is the single authoritative effort calculator.
    if (completed > 0) {
      console.log(`logOnsiteEffortOnUpload: completed ${completed} task(s) for project ${project_id}. Effort recalc will fire via automation on TaskTimeLog changes.`);
      // Trigger reconcile to repair any stale totals from previous failed runs
      invokeFunction('reconcileProjectEffort', { project_id }).catch(() => { /* best-effort */ });
    }

    // Notify project owner that onsite effort was auto-logged
    if (completed > 0 && project.project_owner_id) {
      const projectName = project.title || project.property_address || 'Project';
      if (await _canNotify(entities, project.project_owner_id, 'task_completed', 'task')) {
        await entities.Notification.create({
          user_id: project.project_owner_id,
          type: 'task_completed',
          category: 'task',
          severity: 'info',
          title: `Onsite effort logged — ${projectName}`,
          message: `${completed} onsite task${completed > 1 ? 's' : ''} automatically completed and effort logged on upload.`,
          project_id: project_id,
          project_name: projectName,
          cta_label: 'View Project',
          is_read: false,
          is_dismissed: false,
          source: 'logOnsiteEffortOnUpload',
          idempotency_key: `onsite_effort_logged:${project_id}:${new Date().toISOString().slice(0, 10)}`,
          created_date: new Date().toISOString(),
        }).catch(() => {});
      }
    }

    return jsonResponse({ success: true, project_id, completed });
  } catch (error: any) {
    console.error('logOnsiteEffortOnUpload error:', error);
    return errorResponse(error.message);
  }
});
