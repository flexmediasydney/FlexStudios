import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();

    if (payload?._health_check) {
      return Response.json({ _version: 'v1.1', _fn: 'logOnsiteEffortOnUpload', _ts: '2026-03-17' });
    }

    // Support entity automation payload or direct call
    let project;
    let project_id;
    let old_status;

    if (payload.event?.entity_id) {
      project = payload.data;
      project_id = payload.event.entity_id;
      old_status = payload.old_data?.status;
    } else if (payload.project_id) {
      project_id = payload.project_id;
      project = await base44.asServiceRole.entities.Project.get(project_id);
      // Accept old_status from direct caller so the transition guard works correctly
      // even when invoked from the frontend (not via automation).
      old_status = payload.old_status ?? null;
    }

    if (!project || !project_id) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    // Guard: only process valid forward transitions to uploaded-or-later stages
    const UPLOADED_STAGES = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];
    const VALID_PRE_STAGES = ['to_be_scheduled', 'scheduled', 'onsite'];
    
    if (old_status && !VALID_PRE_STAGES.includes(old_status)) {
      // e.g. cancelled → uploaded should NOT trigger effort logging
      return Response.json({ skipped: true, reason: `Invalid transition from ${old_status} — skipping effort logging` });
    }

    const uploadedStages = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];
    const preUploadStages = ['to_be_scheduled', 'scheduled', 'onsite'];

    // If triggered via automation, only act when transitioning INTO an uploaded stage
    // (not on every subsequent update while already in an uploaded stage)
    if (old_status !== undefined && old_status !== null) {
      const wasPreUpload = preUploadStages.includes(old_status) || !uploadedStages.includes(old_status);
      const isNowUploaded = uploadedStages.includes(project.status);
      if (!wasPreUpload || !isNowUploaded) {
        return Response.json({
          message: 'No transition to uploaded stage detected',
          old_status,
          new_status: project.status,
          skipped: true
        });
      }
    } else {
      // Direct call — still check the stage is appropriate
      if (!uploadedStages.includes(project.status)) {
        return Response.json({ message: 'Project not yet at uploaded stage', status: project.status });
      }
    }

    // Find existing onsite tasks created by syncOnsiteEffortTasks
    const allTasks = await base44.asServiceRole.entities.ProjectTask.filter({ project_id }, null, 1000);
    const onsiteTasks = allTasks.filter(t =>
      (t.template_id === 'onsite:photographer' || t.template_id === 'onsite:videographer') &&
      !t.is_deleted
    );

    if (onsiteTasks.length === 0) {
      return Response.json({ message: 'No onsite tasks found to complete', completed: 0 });
    }

    // Guard: shoot_date must be present. If missing, we must NOT create a time log
    // with today's date — that would corrupt historical effort records permanently.
    if (!project.shoot_date) {
      console.warn(`logOnsiteEffortOnUpload: project ${project_id} has no shoot_date — skipping time log creation. Mark tasks with shoot_date_missing flag so the UI can surface a warning.`);
      // Mark all onsite tasks so the UI can display a clear "enter manually" warning
      for (const task of onsiteTasks) {
        if (!task.is_completed) {
          await base44.asServiceRole.entities.ProjectTask.update(task.id, {
            is_completed: true,
            is_locked: true,
            shoot_date_missing: true,
          });
        }
      }
      return Response.json({
        success: true,
        project_id,
        completed: 0,
        warning: 'shoot_date missing — time logs not created, tasks flagged for manual entry',
      });
    }

    // Parse as Sydney wall-clock time by trying AEDT (+11) then AEST (+10).
    // We verify by round-tripping through Intl to confirm the local hour matches.
    const shootStart = (() => {
      if (!project.shoot_date) return new Date().toISOString(); // unreachable after guard above
      const timeStr = project.shoot_time || '09:00';
      const naiveDateStr = `${project.shoot_date}T${timeStr}:00`;
      const targetHour = parseInt(timeStr.split(':')[0], 10);
      const tryOffset = (offset) => {
        const d = new Date(`${naiveDateStr}${offset}`);
        if (isNaN(d.getTime())) return null;
        const parts = new Intl.DateTimeFormat('en-AU', {
          timeZone: 'Australia/Sydney',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(d);
        const localHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
        return Math.abs(localHour - targetHour) <= 1 ? d.toISOString() : null;
      };
      return tryOffset('+11:00') || tryOffset('+10:00') || new Date(`${naiveDateStr}+10:00`).toISOString();
    })();

    let completed = 0;

    for (const task of onsiteTasks) {
      // Skip if already completed AND locked (fully processed)
      if (task.is_completed && task.is_locked) continue;

      const isPhotographer = task.template_id === 'onsite:photographer';
      const role = isPhotographer ? 'photographer' : 'videographer';

      // Read staff from the task itself — it was last written by syncOnsiteEffortTasks
      // and always holds the authoritative, current assignment.
      // project.onsite_staff_* can be stale if staff was swapped after pricing was saved.
      const isTeamStaff = !!task.assigned_to_team_id;
      const staffId = isTeamStaff ? task.assigned_to_team_id : task.assigned_to;
      const staffName = isTeamStaff ? task.assigned_to_team_name : task.assigned_to_name;
      const staffType = isTeamStaff ? 'team' : 'individual';
      const taskSeconds = (task.estimated_minutes || 0) * 60;

      const shootEnd = taskSeconds > 0
        ? new Date(new Date(shootStart).getTime() + taskSeconds * 1000).toISOString()
        : shootStart;

      // Mark task as completed + locked + record effort
      await base44.asServiceRole.entities.ProjectTask.update(task.id, {
        is_completed: true,
        is_locked: true,
        total_effort_logged: taskSeconds,
      });

      // Create time log only if one doesn't already exist for this task
      if (staffId && taskSeconds > 0) {
        const existingLogs = await base44.asServiceRole.entities.TaskTimeLog.filter({ task_id: task.id }, null, 10);
        if (existingLogs.length === 0) {
          await base44.asServiceRole.entities.TaskTimeLog.create({
            task_id: task.id,
            project_id,
            user_id: staffType !== 'team' ? staffId : (project.project_owner_id || staffId),
            user_name: staffName || '',
            role,
            start_time: shootStart,
            end_time: shootEnd,
            total_seconds: taskSeconds,
            paused_duration: 0,
            is_active: false,
            status: 'completed',
          });
          console.log(`Created time log for ${role}: ${taskSeconds}s`);
        } else {
          console.log(`Time log already exists for task ${task.id} (${role}), skipping`);
        }
      }

      completed++;
    }

    // Effort recalculation is intentionally NOT done here.
    // Creating the TaskTimeLog records above will trigger updateProjectEffortRealtimeRobust
    // via Base44 entity automation, which is the single authoritative effort calculator.
    // Doing it here in parallel would cause a triple-write race condition where the last
    // writer wins — possibly overwriting a more accurate value with a stale snapshot.
    if (completed > 0) {
      console.log(`logOnsiteEffortOnUpload: completed ${completed} task(s) for project ${project_id}. Effort recalc will fire via automation on TaskTimeLog changes.`);
      // Trigger reconcile to repair any stale totals from previous failed runs
      base44.asServiceRole.functions.invoke('reconcileProjectEffort', {
        project_id,
      }).catch(() => { /* best-effort */ });
    }

    // Notify project owner that onsite effort was auto-logged
    if (completed > 0 && project.project_owner_id) {
      const projectName = project.title || project.property_address || 'Project';
      await base44.asServiceRole.entities.Notification.create({
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

    return Response.json({ success: true, project_id, completed });
  } catch (error) {
    console.error('logOnsiteEffortOnUpload error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});