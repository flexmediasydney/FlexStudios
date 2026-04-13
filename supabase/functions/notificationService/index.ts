import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, isQuietHours } from '../_shared/supabase.ts';

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION TYPE REGISTRY
// Single source of truth for all 40 notification types.
// category, severity, cta_label are defaults — callers can override.
// ═══════════════════════════════════════════════════════════════════════════
const NOTIFICATION_TYPES: Record<string, {
  category: string;
  severity: string;
  cta_label: string;
  default_roles: string[];
}> = {
  // SCHEDULING
  shoot_moved_to_onsite:        { category: 'scheduling', severity: 'info',     cta_label: 'View Project',    default_roles: ['photographer'] },
  shoot_overdue:                { category: 'scheduling', severity: 'warning',  cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  reschedule_advanced_stage:    { category: 'scheduling', severity: 'warning',  cta_label: 'View Project',    default_roles: ['project_owner'] },
  shoot_date_changed:           { category: 'scheduling', severity: 'info',     cta_label: 'View Project',    default_roles: ['photographer', 'project_owner'] },
  calendar_event_conflict:      { category: 'scheduling', severity: 'warning',  cta_label: 'View Calendar',   default_roles: ['project_owner', 'master_admin'] },
  photographer_assigned:        { category: 'scheduling', severity: 'info',     cta_label: 'View Project',    default_roles: [] },

  // PRODUCTION
  project_stage_changed:        { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: ['assigned_users'] },
  project_assigned_to_you:      { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: [] },
  project_delivered:            { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner'] },
  stale_production:             { category: 'project',    severity: 'warning',  cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  stale_submitted:              { category: 'project',    severity: 'warning',  cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  booking_approved:             { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  project_pricing_changed:      { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  all_tasks_completed:          { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  project_owner_assigned:       { category: 'project',    severity: 'info',     cta_label: 'View Project',    default_roles: [] },

  // TASKS
  task_assigned:                { category: 'task',       severity: 'info',     cta_label: 'View Task',       default_roles: [] },
  task_overdue:                 { category: 'task',       severity: 'warning',  cta_label: 'View Task',       default_roles: [] },
  task_deadline_approaching:    { category: 'task',       severity: 'info',     cta_label: 'View Task',       default_roles: [] },
  task_dependency_unblocked:    { category: 'task',       severity: 'info',     cta_label: 'View Task',       default_roles: [] },
  task_completed:               { category: 'task',       severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner'] },
  timer_running_warning:        { category: 'task',       severity: 'warning',  cta_label: 'View Task',       default_roles: [] },
  tasks_auto_generated:         { category: 'task',       severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner'] },
  task_generation_failed:       { category: 'task',       severity: 'warning',  cta_label: 'View Project',    default_roles: ['master_admin'] },

  // REVISIONS
  revision_created:             { category: 'revision',   severity: 'warning',  cta_label: 'View Revision',   default_roles: ['image_editor', 'video_editor', 'project_owner'] },
  revision_urgent:              { category: 'revision',   severity: 'critical', cta_label: 'View Revision',   default_roles: ['image_editor', 'video_editor', 'master_admin'] },
  revision_approved:            { category: 'revision',   severity: 'info',     cta_label: 'View Project',    default_roles: [] },
  revision_stale_48h:           { category: 'revision',   severity: 'warning',  cta_label: 'View Project',    default_roles: ['image_editor', 'project_owner'] },
  change_request_created:       { category: 'revision',   severity: 'warning',  cta_label: 'View Revision',   default_roles: ['project_owner', 'master_admin'] },
  revision_all_resolved:        { category: 'revision',   severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner'] },
  revision_cancelled:           { category: 'revision',   severity: 'info',     cta_label: 'View Project',    default_roles: ['image_editor', 'video_editor'] },

  // TONOMO
  booking_arrived_pending_review: { category: 'tonomo',   severity: 'info',     cta_label: 'Review Booking',  default_roles: ['master_admin'] },
  booking_cancellation:         { category: 'tonomo',     severity: 'critical', cta_label: 'Review Booking',  default_roles: ['master_admin', 'project_owner'] },
  booking_urgent_review:        { category: 'tonomo',     severity: 'critical', cta_label: 'Review Booking',  default_roles: ['master_admin'] },
  booking_payment_received:     { category: 'tonomo',     severity: 'info',     cta_label: 'View Project',    default_roles: ['master_admin'] },
  booking_service_uncertainty:  { category: 'tonomo',     severity: 'warning',  cta_label: 'Review Booking',  default_roles: ['master_admin'] },
  booking_mapping_gaps:         { category: 'tonomo',     severity: 'warning',  cta_label: 'View Project',    default_roles: ['master_admin'] },
  booking_no_photographer:      { category: 'tonomo',     severity: 'warning',  cta_label: 'Review Booking',  default_roles: ['master_admin'] },
  booking_auto_approved:        { category: 'tonomo',     severity: 'info',     cta_label: 'View Project',    default_roles: ['master_admin'] },
  booking_services_changed:     { category: 'tonomo',     severity: 'warning',  cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  booking_flow_unmapped:        { category: 'tonomo',     severity: 'warning',  cta_label: 'Map It',          default_roles: ['master_admin'] },
  booking_type_unmapped:        { category: 'tonomo',     severity: 'warning',  cta_label: 'Map It',          default_roles: ['master_admin'] },
  booking_rescheduled:          { category: 'tonomo',     severity: 'info',     cta_label: 'View Project',    default_roles: ['photographer', 'project_owner'] },

  // FINANCIAL
  invoice_overdue_7d:           { category: 'financial',  severity: 'warning',  cta_label: 'View Project',    default_roles: ['master_admin'] },
  invoice_overdue_14d:          { category: 'financial',  severity: 'critical', cta_label: 'View Project',    default_roles: ['master_admin'] },
  payment_received:             { category: 'financial',  severity: 'info',     cta_label: 'View Project',    default_roles: ['master_admin'] },
  payment_overdue_first:        { category: 'financial',  severity: 'warning',  cta_label: 'View Project',    default_roles: ['master_admin'] },

  // QUALITY / SYSTEM
  stale_project:                { category: 'system',     severity: 'warning',  cta_label: 'View Project',    default_roles: ['project_owner', 'master_admin'] },
  pending_review_stale:         { category: 'system',     severity: 'warning',  cta_label: 'Review Booking',  default_roles: ['master_admin'] },
  mapping_table_needs_update:   { category: 'system',     severity: 'warning',  cta_label: 'View Tonomo',     default_roles: ['master_admin'] },
  schema_warning:               { category: 'system',     severity: 'warning',  cta_label: 'View Diagnostics',default_roles: ['master_admin'] },
  rule_engine_error:            { category: 'system',     severity: 'critical', cta_label: 'View Automation', default_roles: ['master_admin'] },
  pricing_recalculated:         { category: 'system',     severity: 'info',     cta_label: 'View Project',    default_roles: ['project_owner'] },
  engine_error:                 { category: 'system',     severity: 'critical', cta_label: 'View Diagnostics',default_roles: ['master_admin'] },

  // EMAIL
  email_received_from_client:   { category: 'email',      severity: 'info',     cta_label: 'View Email',      default_roles: ['project_owner'] },
  email_requires_reply:         { category: 'email',      severity: 'warning',  cta_label: 'Reply',           default_roles: ['project_owner', 'master_admin'] },
  email_sync_failed:            { category: 'system',     severity: 'critical', cta_label: 'Fix Sync',        default_roles: ['master_admin'] },

  // RETENTION
  retention_red_flag:           { category: 'system',     severity: 'critical', cta_label: 'View Alerts',     default_roles: ['master_admin'] },
  retention_sweep_complete:     { category: 'system',     severity: 'info',     cta_label: 'View Summary',    default_roles: ['master_admin'] },
  retention_status_changed:     { category: 'system',     severity: 'info',     cta_label: 'View Alert',      default_roles: ['master_admin'] },
};

// ═══════════════════════════════════════════════════════════════════════════
// ROLE -> USER ID RESOLVER
// ═══════════════════════════════════════════════════════════════════════════
const ROLE_FIELD_MAP: Record<string, string[]> = {
  project_owner:  ['project_owner_id'],
  photographer:   ['photographer_id', 'onsite_staff_1_id'],
  image_editor:   ['image_editor_id'],
  video_editor:   ['video_editor_id'],
  videographer:   ['videographer_id', 'onsite_staff_2_id'],
  assigned_users: ['assigned_users'],
};

async function resolveUserIds(
  entities: any,
  roles: string[],
  projectId?: string
): Promise<string[]> {
  const userIds = new Set<string>();

  if (roles.includes('master_admin')) {
    try {
      const users = await entities.User.list('-created_date', 200);
      users
        .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
        .forEach((u: any) => userIds.add(u.id));
    } catch { /* ignore */ }
  }

  if (projectId) {
    const projectRoles = roles.filter(r => r !== 'master_admin');
    if (projectRoles.length > 0) {
      try {
        const project = await entities.Project.get(projectId);
        if (project) {
          for (const role of projectRoles) {
            const fields = ROLE_FIELD_MAP[role] || [];
            for (const field of fields) {
              const val = project[field];
              if (!val) continue;
              if (field === 'assigned_users') {
                const arr = Array.isArray(val)
                  ? val
                  : (() => { try { return JSON.parse(val); } catch { return []; } })();
                arr.forEach((id: string) => id && userIds.add(id));
              } else {
                userIds.add(val);
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return Array.from(userIds).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// PREFERENCE CHECK
// ═══════════════════════════════════════════════════════════════════════════
async function checkPreference(
  entities: any,
  userId: string,
  notificationType: string,
  category: string
): Promise<boolean> {
  try {
    const userPrefs = await entities.NotificationPreference.filter(
      { user_id: userId },
      '-created_date',
      100
    );

    const typePref = userPrefs.find((p: any) => p.notification_type === notificationType);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;

    const catPref = userPrefs.find(
      (p: any) => p.category === category && (p.notification_type === '*' || !p.notification_type)
    );
    if (catPref !== undefined) return catPref.in_app_enabled !== false;

    return true;
  } catch {
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY CHECK
// ═══════════════════════════════════════════════════════════════════════════
async function isDuplicate(entities: any, idempotencyKey: string, userId: string): Promise<boolean> {
  try {
    const userNotifs = await entities.Notification.filter(
      { user_id: userId, idempotency_key: idempotencyKey },
      '-created_date',
      5
    );
    return userNotifs.length > 0;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: CREATE NOTIFICATION FOR ONE USER
// ═══════════════════════════════════════════════════════════════════════════
async function createNotificationForUser(
  entities: any,
  params: {
    userId: string;
    type: string;
    title: string;
    message: string;
    projectId?: string;
    projectName?: string;
    entityType?: string;
    entityId?: string;
    ctaUrl?: string;
    ctaLabel?: string;
    ctaParams?: Record<string, string>;
    severity?: string;
    category?: string;
    source?: string;
    sourceRuleId?: string;
    sourceUserId?: string;
    idempotencyKey?: string;
  }
): Promise<{ created?: boolean; skipped?: boolean; reason?: string }> {
  const typeConfig = NOTIFICATION_TYPES[params.type] || {
    category: 'system', severity: 'info', cta_label: 'View', default_roles: []
  };
  const category = params.category || typeConfig.category;
  const severity = params.severity || typeConfig.severity;

  const allowed = await checkPreference(entities, params.userId, params.type, category);
  if (!allowed) return { skipped: true, reason: 'preference_disabled' };

  if (await isQuietHours(params.userId)) return { skipped: true, reason: 'quiet_hours' };

  if (params.idempotencyKey) {
    const dup = await isDuplicate(entities, params.idempotencyKey, params.userId);
    if (dup) return { skipped: true, reason: 'duplicate' };
  }

  await entities.Notification.create({
    user_id:          params.userId,
    type:             params.type,
    category,
    severity,
    title:            params.title,
    message:          params.message,
    project_id:       params.projectId   || null,
    project_name:     params.projectName || null,
    entity_type:      params.entityType  || null,
    entity_id:        params.entityId    || null,
    cta_url:          params.ctaUrl      || null,
    cta_label:        params.ctaLabel    || typeConfig.cta_label,
    cta_params:       params.ctaParams   ? JSON.stringify(params.ctaParams) : null,
    is_read:          false,
    is_dismissed:     false,
    source:           params.source      || 'system',
    source_rule_id:   params.sourceRuleId || null,
    source_user_id:   params.sourceUserId || null,
    idempotency_key:  params.idempotencyKey || null,
    created_date:     new Date().toISOString(),
  });

  return { created: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: CREATE NOTIFICATION FOR ROLES
// ═══════════════════════════════════════════════════════════════════════════
async function createNotificationsForRoles(
  entities: any,
  params: {
    roles: string[];
    type: string;
    title: string;
    message: string;
    projectId?: string;
    projectName?: string;
    entityType?: string;
    entityId?: string;
    ctaUrl?: string;
    ctaLabel?: string;
    ctaParams?: Record<string, string>;
    severity?: string;
    source?: string;
    sourceRuleId?: string;
    sourceUserId?: string;
    idempotencyKeySuffix?: string;
    excludeUserId?: string;
  }
): Promise<{ created: number; skipped: number }> {
  const userIds = await resolveUserIds(entities, params.roles, params.projectId);
  let created = 0;
  let skipped = 0;

  for (const userId of userIds) {
    if (params.excludeUserId && userId === params.excludeUserId) {
      skipped++;
      continue;
    }

    const idemKey = params.idempotencyKeySuffix
      ? `${params.type}:${params.projectId || 'global'}:${userId}:${params.idempotencyKeySuffix}`
      : undefined;

    const result = await createNotificationForUser(entities, {
      ...params,
      userId,
      idempotencyKey: idemKey,
    });

    if (result.created) created++;
    else skipped++;
  }

  return { created, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse('POST only', 405);
  }

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth check — callable by service-role (cross-function calls) or authenticated users
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json();
    const { action, ...params } = body;

    if (action === 'create') {
      const result = await createNotificationForUser(entities, params);
      return jsonResponse(result);
    }

    if (action === 'create_for_roles') {
      const result = await createNotificationsForRoles(entities, params);
      return jsonResponse(result);
    }

    if (action === 'get_type_registry') {
      return jsonResponse({ types: NOTIFICATION_TYPES });
    }

    return errorResponse(`Unknown action: ${action}`, 400);

  } catch (err: any) {
    console.error('notificationService error:', err);
    return errorResponse(err.message || 'Internal error', 500);
  }
});
