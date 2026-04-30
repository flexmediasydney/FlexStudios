import { api } from "@/api/supabaseClient";

/**
 * Check whether a user's NotificationPreference allows in-app delivery
 * for a given notification type / category.  Falls back to true (notify)
 * when no preference row exists or the query fails.
 */
async function canNotify(userId, type, category) {
  try {
    const prefs = await api.entities.NotificationPreference.filter(
      { user_id: userId },
      null,
      50
    );
    // 1) Exact type-level preference takes priority
    const typePref = prefs.find(p => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    // 2) Category-level wildcard preference
    const catPref = prefs.find(
      p => p.category === category && (!p.notification_type || p.notification_type === '*')
    );
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    // 3) No preference recorded — default to notify
    return true;
  } catch {
    return true; // fail-open so notifications still work if prefs query breaks
  }
}

// Mirrors NOTIFICATION_TYPES from notificationService.ts
// Keep in sync if you add new types
const TYPE_CONFIG = {
  // scheduling
  shoot_moved_to_onsite:          { category: "scheduling", severity: "info",     ctaLabel: "View Project" },
  shoot_overdue:                  { category: "scheduling", severity: "warning",  ctaLabel: "View Project" },
  reschedule_advanced_stage:      { category: "scheduling", severity: "warning",  ctaLabel: "View Project" },
  shoot_date_changed:             { category: "scheduling", severity: "info",     ctaLabel: "View Project" },
  // project
  project_stage_changed:          { category: "project",    severity: "info",     ctaLabel: "View Project" },
  project_assigned_to_you:        { category: "project",    severity: "info",     ctaLabel: "View Project" },
  project_delivered:              { category: "project",    severity: "info",     ctaLabel: "View Project" },
  project_archived:              { category: "project",    severity: "info",     ctaLabel: "View Project" },
  stale_production:               { category: "project",    severity: "warning",  ctaLabel: "View Project" },
  stale_submitted:                { category: "project",    severity: "warning",  ctaLabel: "View Project" },
  // tasks
  task_assigned:                  { category: "task",       severity: "info",     ctaLabel: "View Task" },
  task_overdue:                   { category: "task",       severity: "warning",  ctaLabel: "View Task" },
  task_deadline_approaching:      { category: "task",       severity: "info",     ctaLabel: "View Task" },
  task_dependency_unblocked:      { category: "task",       severity: "info",     ctaLabel: "View Task" },
  task_completed:                 { category: "task",       severity: "info",     ctaLabel: "View Project" },
  // revisions
  revision_created:               { category: "revision",   severity: "warning",  ctaLabel: "View Revision" },
  revision_urgent:                { category: "revision",   severity: "critical", ctaLabel: "View Revision" },
  revision_approved:              { category: "revision",   severity: "info",     ctaLabel: "View Project" },
  revision_stale_48h:             { category: "revision",   severity: "warning",  ctaLabel: "View Project" },
  change_request_created:         { category: "revision",   severity: "warning",  ctaLabel: "View Revision" },
  // tonomo
  booking_arrived_pending_review: { category: "tonomo",     severity: "info",     ctaLabel: "Review Booking" },
  booking_cancellation:           { category: "tonomo",     severity: "critical", ctaLabel: "Review Booking" },
  booking_urgent_review:          { category: "tonomo",     severity: "critical", ctaLabel: "Review Booking" },
  booking_payment_received:       { category: "tonomo",     severity: "info",     ctaLabel: "View Project" },
  booking_service_uncertainty:    { category: "tonomo",     severity: "warning",  ctaLabel: "Review Booking" },
  booking_no_photographer:        { category: "tonomo",     severity: "warning",  ctaLabel: "Review Booking" },
  booking_services_changed:       { category: "tonomo",     severity: "warning",  ctaLabel: "View Project" },
  // financial
  invoice_overdue_7d:             { category: "financial",  severity: "warning",  ctaLabel: "View Project" },
  invoice_overdue_14d:            { category: "financial",  severity: "critical", ctaLabel: "View Project" },
  payment_received:               { category: "financial",  severity: "info",     ctaLabel: "View Project" },
  // system
  stale_project:                  { category: "system",     severity: "warning",  ctaLabel: "View Project" },
  pending_review_stale:           { category: "system",     severity: "warning",  ctaLabel: "Review Booking" },
  schema_warning:                 { category: "system",     severity: "warning",  ctaLabel: "View Tonomo" },
  rule_engine_error:              { category: "system",     severity: "critical", ctaLabel: "View Automation" },
  timer_running_warning:          { category: "task",       severity: "warning",  ctaLabel: "View Task" },
  // notes
  note_mention:                   { category: "notes",      severity: "info",     ctaLabel: "View Note" },
  note_reply:                     { category: "notes",      severity: "info",     ctaLabel: "View Note" },
};

/**
 * Create a notification for a single user.
 *
 * @param {object} params
 * @param {string} params.userId           - Recipient user ID
 * @param {string} params.type             - Notification type from TYPE_CONFIG
 * @param {string} params.title            - Short headline (max 80 chars)
 * @param {string} params.message          - Detail sentence
 * @param {string} [params.projectId]      - For navigation
 * @param {string} [params.projectName]    - Denormalized for display
 * @param {string} [params.entityType]     - project | task | revision | booking
 * @param {string} [params.entityId]       - ID of triggering record
 * @param {string} [params.ctaUrl]         - Page name to navigate to
 * @param {string} [params.ctaLabel]       - CTA button text
 * @param {object} [params.ctaParams]      - e.g. { id: "project-123" }
 * @param {string} [params.sourceUserId]   - Who triggered it
 * @param {string} [params.idempotencyKey] - Prevents duplicate delivery
 * @returns {Promise<boolean>}             - true if created, false if skipped
 */
export async function createNotification(params) {
  const cfg = TYPE_CONFIG[params.type] || { category: "system", severity: "info", ctaLabel: "View" };
  try {
    // Respect per-user notification preferences before creating
    const allowed = await canNotify(params.userId, params.type, cfg.category);
    if (!allowed) return false;

    await api.entities.Notification.create({
      user_id:         params.userId,
      type:            params.type,
      category:        cfg.category,
      severity:        params.severity || cfg.severity,
      title:           params.title,
      message:         params.message || "",
      project_id:      params.projectId    || null,
      project_name:    params.projectName  || null,
      entity_type:     params.entityType   || null,
      entity_id:       params.entityId     || null,
      cta_url:         params.ctaUrl       || null,
      cta_label:       params.ctaLabel     || cfg.ctaLabel,
      cta_params:      params.ctaParams    ? JSON.stringify(params.ctaParams) : null,
      is_read:         false,
      is_dismissed:    false,
      source:          "user_action",
      source_user_id:  params.sourceUserId || null,
      idempotency_key: params.idempotencyKey || null,
      created_date:    new Date().toISOString(),
    });
    return true;
  } catch (e) {
    console.warn("[createNotification] failed silently:", e?.message);
    return false;
  }
}

/**
 * Create notifications for multiple users in one call.
 * Skips if userId === excludeUserId (don't notify the person doing the action).
 */
export async function createNotificationsForUsers(userIds, params, excludeUserId) {
  const unique = [...new Set(userIds)].filter(id => id && id !== excludeUserId);
  await Promise.allSettled(
    unique.map(userId =>
      createNotification({
        ...params,
        userId,
        idempotencyKey: params.idempotencyKey
          ? `${params.idempotencyKey}:${userId}`
          : undefined,
      })
    )
  );
}

/**
 * Write a team-visible feed event from a React component.
 * Called after any significant user action.
 */
export async function writeFeedEvent(params) {
  try {
    await api.entities.TeamActivityFeed.create({
      event_type:       params.eventType,
      category:         params.category || "project",
      severity:         params.severity || "info",
      actor_id:         params.actorId   || null,
      actor_name:       params.actorName || null,
      title:            params.title,
      description:      params.description || null,
      project_id:       params.projectId   || null,
      project_name:     params.projectName || null,
      project_address:  params.projectAddress || null,
      project_stage:    params.projectStage   || null,
      entity_type:      params.entityType || null,
      entity_id:        params.entityId   || null,
      metadata:         params.metadata ? JSON.stringify(params.metadata) : null,
      visible_to_roles: params.visibleToRoles || "",
      created_date:     new Date().toISOString(),
    });
  } catch { /* non-critical, silent */ }
}