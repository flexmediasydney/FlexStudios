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

// The role slots we manage — canonical fields only, legacy aliases written separately
const ROLE_SLOTS = [
  { role: 'project_owner',    idField: 'project_owner_id',    nameField: 'project_owner_name',    typeField: 'project_owner_type' },
  { role: 'photographer',     idField: 'photographer_id',     nameField: 'photographer_name',     typeField: null },
  { role: 'videographer',     idField: 'videographer_id',     nameField: 'videographer_name',     typeField: null },
  { role: 'image_editor',     idField: 'image_editor_id',     nameField: 'image_editor_name',     typeField: null },
  { role: 'video_editor',     idField: 'video_editor_id',     nameField: 'video_editor_name',     typeField: null },
  { role: 'floorplan_editor', idField: 'floorplan_editor_id', nameField: 'floorplan_editor_name', typeField: null },
  { role: 'drone_editor',     idField: 'drone_editor_id',     nameField: 'drone_editor_name',     typeField: null },
];

// Map each role to its fallback tier
const ROLE_FALLBACK_TIER: Record<string, string> = {
  project_owner:    'owner',
  photographer:     'onsite',
  videographer:     'onsite',
  image_editor:     'editing',
  video_editor:     'editing',
  floorplan_editor: 'editing',
  drone_editor:     'editing',
};

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v3.0', _fn: 'applyProjectRoleDefaults', _ts: '2026-04-08' });
    }

    // ── Auth: require any authenticated user or service role ──
    const user = await getUserFromReq(req).catch(() => null);
    if (!user) {
      const authHeader = req.headers.get('authorization') || '';
      if (!authHeader.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '___')) {
        return errorResponse('Authentication required', 401);
      }
    }

    const { project_id, skip_task_generation } = body;

    if (!project_id) {
      return errorResponse('project_id required', 400);
    }

    // ── Load project
    const project = await entities.Project.get(project_id);
    if (!project) {
      return errorResponse('Project not found', 404);
    }

    // ── Load role defaults
    const defaultsList = await entities.TonomoRoleDefaults.list('-created_date', 1).catch(() => []);
    const defaults: any = defaultsList?.[0] || {};

    // ── Load all users for name denormalization
    const allUsers = await entities.User.list('-created_date', 500).catch(() => []);
    const usersById = new Map(allUsers.map((u: any) => [u.id, u]));

    // Load teams for fallback resolution and name display
    const hasFallbackTeams = defaults.owner_fallback_team_id ||
      defaults.onsite_fallback_team_id || defaults.editing_fallback_team_id ||
      defaults.photographer_fallback_team_id || defaults.videographer_fallback_team_id;

    const allTeams = hasFallbackTeams
      ? await entities.InternalTeam.list('-created_date', 100).catch(() => [])
      : [];
    const teamsById = new Map(allTeams.map((t: any) => [t.id, t]));

    const usersByTeam = new Map<string, any[]>();
    if (hasFallbackTeams) {
      allUsers.forEach((u: any) => {
        if (!u.internal_team_id) return;
        const members = usersByTeam.get(u.internal_team_id) || [];
        members.push(u);
        usersByTeam.set(u.internal_team_id, members);
      });
    }

    // Get fallback team ID for a given tier/role
    const getFallbackTeamId = (tier: string, role?: string) => {
      // Check role-specific fallback first (photographer/videographer have their own fields)
      if (role === 'photographer' && defaults.photographer_fallback_team_id) return defaults.photographer_fallback_team_id;
      if (role === 'videographer' && defaults.videographer_fallback_team_id) return defaults.videographer_fallback_team_id;
      if (tier === 'owner')   return defaults.owner_fallback_team_id   || null;
      if (tier === 'onsite')  return defaults.onsite_fallback_team_id  || null;
      if (tier === 'editing') return defaults.editing_fallback_team_id || null;
      return null;
    };

    const updates: Record<string, any> = {};
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const slot of ROLE_SLOTS) {
      const currentId = project[slot.idField];
      if (currentId) {
        // Slot already filled — ensure name and type are denormalized correctly
        const user = usersById.get(currentId);
        const resolvedName = user?.full_name || user?.email || null;
        if (slot.nameField && resolvedName && project[slot.nameField] !== resolvedName) {
          updates[slot.nameField] = resolvedName;
        }
        // Fix stale _type: if the ID resolves to a real user, ensure type='user'
        if (user) {
          const typeKey = slot.typeField || `${slot.role}_type`;
          if (project[typeKey] !== 'user') {
            updates[typeKey] = 'user';
          }
        }
        skipped.push(slot.role);
        continue;
      }

      // ── Priority 1: Individual user default ────────────────────────────
      const userDefaultField = `${slot.role}_default_user_id`;
      const userDefaultId = defaults[userDefaultField];
      if (userDefaultId) {
        updates[slot.idField] = userDefaultId;
        const defaultUser = usersById.get(userDefaultId);
        if (slot.nameField) updates[slot.nameField] = defaultUser?.full_name || '';
        if (slot.typeField) updates[slot.typeField] = 'user';
        else if (slot.role === 'project_owner') updates.project_owner_type = 'user';
        else updates[`${slot.role}_type`] = 'user';
        applied.push(slot.role);
        continue;
      }

      // ── Priority 2: Team fallback ──────────────────────────────────────
      const tier = ROLE_FALLBACK_TIER[slot.role];
      const fallbackTeamId = getFallbackTeamId(tier, slot.role);

      if (!fallbackTeamId) {
        skipped.push(slot.role);
        continue;
      }

      // Assign the fallback team to this role
      const fallbackTeam = teamsById.get(fallbackTeamId);
      updates[slot.idField] = fallbackTeamId;
      if (slot.nameField) updates[slot.nameField] = fallbackTeam?.name || 'Unassigned';
      if (slot.typeField) updates[slot.typeField] = 'team';
      // For roles without a typeField, use the corresponding _type column
      if (!slot.typeField && slot.role !== 'project_owner') {
        updates[`${slot.role}_type`] = 'team';
      }
      if (slot.role === 'project_owner') {
        updates.project_owner_type = 'team';
      }
      applied.push(slot.role);
    }

    // Sync legacy onsite_staff aliases from canonical fields
    const photographerId = project.photographer_id || updates.photographer_id || null;
    const videographerId = project.videographer_id || updates.videographer_id || null;
    if (photographerId && !project.onsite_staff_1_id) {
      updates.onsite_staff_1_id = photographerId;
    }
    if (videographerId && !project.onsite_staff_2_id) {
      updates.onsite_staff_2_id = videographerId;
    }

    if (Object.keys(updates).length > 0) {
      await entities.Project.update(project_id, updates);
    }

    // If photographer changed, update CalendarEvent owner for Tonomo-linked events
    const newPhotographerId = updates.photographer_id || updates.onsite_staff_1_id;
    if (newPhotographerId && newPhotographerId !== project.photographer_id) {
      try {
        const linkedEvents = await entities.CalendarEvent.filter({ project_id }, null, 50);
        const tonomoEvents = linkedEvents.filter((ev: any) =>
          ev.event_source === 'tonomo' || ev.tonomo_appointment_id
        );
        for (const ev of tonomoEvents) {
          await entities.CalendarEvent.update(ev.id, {
            owner_user_id: newPhotographerId,
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    // Activity log
    if (applied.length > 0 || Object.keys(updates).length > 0) {
      await entities.ProjectActivity.create({
        project_id,
        project_title: project.title || project.property_address || '',
        action: 'system_roles_applied',
        description: applied.length > 0
          ? `Role defaults applied: ${applied.join(', ')}.`
          : 'Role defaults checked — all roles already assigned.',
        actor_type: 'system',
        actor_source: 'applyProjectRoleDefaults',
        user_name: 'System',
        user_email: 'system@flexstudios.app',
        metadata: JSON.stringify({ roles_applied: applied, roles_skipped: skipped }),
      }).catch(() => {});
    }

    // Notify newly assigned users (non-blocking)
    const projectName = project.title || project.property_address || 'Project';
    const newAssignments = [
      { field: 'project_owner_id', role: 'Project Owner' },
      { field: 'photographer_id', role: 'Photographer' },
      { field: 'videographer_id', role: 'Videographer' },
    ];
    for (const a of newAssignments) {
      const userId = updates[a.field] || project[a.field];
      if (userId && typeof userId === 'string') {
        const notifType = `${a.field.replace('_id', '')}_assigned`;
        const allowed = await _canNotify(entities, userId, notifType, 'project');
        if (allowed) {
          entities.Notification.create({
            user_id: userId,
            type: notifType,
            category: 'project',
            severity: 'info',
            title: `You've been assigned as ${a.role}`,
            message: `You have been assigned as ${a.role} on ${projectName}.${
              project.shoot_date
                ? ` Shoot date: ${new Date(project.shoot_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${project.shoot_time ? ` at ${project.shoot_time}` : ''}.`
                : ''
            }`,
            project_id: project_id,
            project_name: projectName,
            cta_label: 'View Project',
            is_read: false,
            is_dismissed: false,
            source: 'role_defaults',
            idempotency_key: `${a.field}:${project_id}:${userId}`,
          }).catch(() => {});
        }
      }
    }

    // Trigger task generation
    const hasProducts = (project.products?.length > 0) || (project.packages?.length > 0);
    const shouldGenerateTasks = !skip_task_generation && hasProducts;

    const taskResults: any = { skipped: true, reason: 'no products' };

    if (shouldGenerateTasks) {
      try {
        const taskResult = await invokeFunction('syncProjectTasksFromProducts', { project_id });
        taskResults.invoked = true;
        taskResults.result = taskResult;

        // Notify on task generation success
        if (project.project_owner_id && await _canNotify(entities, project.project_owner_id, 'tasks_auto_generated', 'task')) {
          entities.Notification.create({
            user_id: project.project_owner_id,
            type: 'tasks_auto_generated',
            category: 'task',
            severity: 'info',
            title: `Tasks generated for ${projectName}`,
            message: `Task templates have been automatically applied to this project.`,
            project_id: project_id,
            project_name: projectName,
            cta_label: 'View Project',
            is_read: false,
            is_dismissed: false,
            source: 'task_generation',
            idempotency_key: `tasks_generated:${project_id}`,
          }).catch(() => {});
        }
      } catch (taskErr: any) {
        taskResults.error = taskErr.message;
        console.error('Task generation failed (non-fatal):', taskErr.message);

        // Notify admins on task generation failure
        entities.User.list('-created_date', 200)
          .then((users: any[]) => {
            const adminIds = users
              .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
              .map((u: any) => u.id);
            for (const adminId of adminIds) {
              entities.Notification.create({
                user_id: adminId,
                type: 'task_generation_failed',
                category: 'task',
                severity: 'warning',
                title: `Task generation failed — ${projectName}`,
                message: `Auto task generation failed: ${taskErr.message}. Manual task creation may be needed.`,
                project_id: project_id,
                project_name: projectName,
                cta_label: 'View Project',
                is_read: false,
                is_dismissed: false,
                source: 'task_generation',
                idempotency_key: `tasks_failed:${project_id}:${Date.now().toString().slice(0,-4)}:${adminId}`,
              }).catch(() => {});
            }
          }).catch(() => {});
      }

      // Sync onsite effort tasks
      try {
        await invokeFunction('syncOnsiteEffortTasks', { project_id });
      } catch (e: any) {
        console.error('Onsite effort sync failed (non-fatal):', e.message);
      }

      // Server-side pricing recalculation
      try {
        await invokeFunction('recalculateProjectPricingServerSide', { project_id });
      } catch (pricingErr: any) {
        console.error('Server-side pricing recalculation failed (non-fatal):', pricingErr.message);
      }
    }

    return jsonResponse({
      success: true,
      project_id,
      roles_applied: applied,
      roles_skipped: skipped,
      fields_updated: Object.keys(updates).length,
      task_generation: taskResults,
    });
  } catch (err: any) {
    console.error('applyProjectRoleDefaults error:', err.message);
    return jsonResponse({ error: err.message }, 500);
  }
});
