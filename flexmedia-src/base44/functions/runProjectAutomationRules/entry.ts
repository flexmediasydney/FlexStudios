import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const PROCESSOR_VERSION = "v1.0";
const SYDNEY_TZ = "Australia/Sydney";

function toSydneyDate(date: Date): string {
  return date.toLocaleDateString("en-AU", { timeZone: SYDNEY_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
}

function toSydneyTime(date: Date): string {
  return date.toLocaleTimeString("en-AU", { timeZone: SYDNEY_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}

function getSydneyDateStr(): string {
  return new Date().toISOString().slice(0, 10); // Use ISO date for idempotency keys
}

function fixTS(ts: string | undefined): Date | null {
  if (!ts) return null;
  try {
    const s = ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z";
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────
// ⚠️  CANONICAL SOURCE: functions/notificationService.ts
// These helpers are re-implemented here because Deno functions cannot import
// local files. If you change notification logic here, you MUST also check:
//   - functions/notificationService.ts  (canonical definitions)
//   - functions/runProjectAutomationRules.ts  (this file — keep in sync)
// NOTE: After eng-05 fix, _checkNotifPref and _isDupNotif accept pre-loaded
// cache maps to avoid per-notification table scans.
// ─────────────────────────────────────────────────────────────────────────────

const _NOTIF_ROLES: Record<string, string[]> = {
  project_owner:  ['project_owner_id'],
  photographer:   ['photographer_id', 'onsite_staff_1_id'],
  image_editor:   ['image_editor_id'],
  video_editor:   ['video_editor_id'],
  videographer:   ['videographer_id', 'onsite_staff_2_id'],
  assigned_users: ['assigned_users'],
};

async function _resolveUserIds(base44: any, roles: string[], projectId?: string): Promise<string[]> {
  const ids = new Set<string>();
  if (roles.includes('master_admin')) {
    try {
      const users = await base44.asServiceRole.entities.User.list('-created_date', 200);
      users.filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
           .forEach((u: any) => ids.add(u.id));
    } catch { /* ignore */ }
  }
  if (projectId) {
    const pRoles = roles.filter((r: string) => r !== 'master_admin');
    if (pRoles.length > 0) {
      try {
        const p = await base44.asServiceRole.entities.Project.get(projectId);
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

async function _checkNotifPref(
  base44: any,
  userId: string,
  type: string,
  category: string,
  prefsCache?: Map<string, any[]>   // optional pre-loaded cache
): Promise<boolean> {
  try {
    let userPrefs: any[];
    if (prefsCache) {
      userPrefs = prefsCache.get(userId) || [];
    } else {
      const prefs = await base44.asServiceRole.entities.NotificationPreference.list('-created_date', 500);
      userPrefs = prefs.filter((p: any) => p.user_id === userId);
    }
    const tp = userPrefs.find((p: any) => p.notification_type === type);
    if (tp !== undefined) return tp.in_app_enabled !== false;
    const cp = userPrefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (cp !== undefined) return cp.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

async function _isDupNotif(
  base44: any,
  key: string,
  userId: string,
  notifKeySet?: Set<string>   // optional pre-loaded set of "idemKey:userId"
): Promise<boolean> {
  try {
    if (notifKeySet) {
      return notifKeySet.has(`${key}:${userId}`);
    }
    const recent = await base44.asServiceRole.entities.Notification.list('-created_date', 500);
    return recent.some((n: any) => n.idempotency_key === key && n.user_id === userId);
  } catch { return false; }
}

async function _createNotif(base44: any, p: {
  userId: string; type: string; title: string; message: string;
  category: string; severity: string; ctaLabel?: string; ctaUrl?: string;
  ctaParams?: Record<string, string>; projectId?: string; projectName?: string;
  entityType?: string; entityId?: string;
  source?: string; sourceRuleId?: string; idempotencyKey?: string;
  prefsCache?: Map<string, any[]>;
  notifKeySet?: Set<string>;
}): Promise<boolean> {
  const allowed = await _checkNotifPref(base44, p.userId, p.type, p.category, p.prefsCache);
  if (!allowed) return false;
  if (p.idempotencyKey && await _isDupNotif(base44, p.idempotencyKey, p.userId, p.notifKeySet)) return false;
  await base44.asServiceRole.entities.Notification.create({
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

async function _createNotifsForRoles(base44: any, p: {
  roles: string[]; type: string; title: string; message: string;
  category: string; severity: string; ctaLabel?: string; ctaUrl?: string;
  ctaParams?: Record<string, string>; projectId?: string; projectName?: string;
  entityType?: string; entityId?: string;
  source?: string; sourceRuleId?: string; idempotencyKeySuffix?: string;
  excludeUserId?: string;
  prefsCache?: Map<string, any[]>;
  notifKeySet?: Set<string>;
}): Promise<number> {
  const userIds = await _resolveUserIds(base44, p.roles, p.projectId);
  let count = 0;
  for (const uid of userIds) {
    if (p.excludeUserId && uid === p.excludeUserId) continue;
    const iKey = p.idempotencyKeySuffix
      ? `${p.type}:${p.projectId || 'g'}:${uid}:${p.idempotencyKeySuffix}`
      : undefined;
    const ok = await _createNotif(base44, { ...p, userId: uid, idempotencyKey: iKey });
    if (ok) count++;
  }
  return count;
}

async function _writeFeedEvent(base44: any, p: {
  eventType: string;
  category: string;
  severity?: string;
  actorId?: string;
  actorName?: string;
  title: string;
  description?: string;
  projectId?: string;
  projectName?: string;
  projectAddress?: string;
  projectStage?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, any>;
  visibleToRoles?: string;
}): Promise<void> {
  try {
    await base44.asServiceRole.entities.TeamActivityFeed.create({
      event_type:        p.eventType,
      category:          p.category,
      severity:          p.severity || 'info',
      actor_id:          p.actorId   || null,
      actor_name:        p.actorName || null,
      title:             p.title,
      description:       p.description || null,
      project_id:        p.projectId   || null,
      project_name:      p.projectName || null,
      project_address:   p.projectAddress || null,
      project_stage:     p.projectStage   || null,
      entity_type:       p.entityType || null,
      entity_id:         p.entityId   || null,
      metadata:          p.metadata ? JSON.stringify(p.metadata) : null,
      visible_to_roles:  p.visibleToRoles || '',
      created_date:      new Date().toISOString(),
    });
  } catch { /* never throw — feed writes are non-critical */ }
}
// ─── END NOTIFICATION HELPERS ─────────────────────────────────────────────

// ─── PROJECT STAGE ORDER ─────────────────────────────────────────────────────
const STAGE_ORDER = [
  "pending_review", "to_be_scheduled", "scheduled", "onsite",
  "uploaded", "submitted", "in_progress", "ready_for_partial",
  "in_revision", "delivered"
];

function stageIndex(stage: string): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? 5 : i; // default to middle if unknown
}

// ─── CONDITION EVALUATOR ─────────────────────────────────────────────────────
function evaluateCondition(project: any, condition: any): boolean {
  const { field, operator, value } = condition;
  const pval = project[field];

  switch (operator) {
    case "equals": return String(pval ?? "") === String(value ?? "");
    case "not_equals": return String(pval ?? "") !== String(value ?? "");
    case "is_set": return pval !== null && pval !== undefined && pval !== "" && pval !== "[]";
    case "is_empty": return pval === null || pval === undefined || pval === "" || pval === "[]";
    case "contains": return String(pval ?? "").toLowerCase().includes(String(value ?? "").toLowerCase());
    case "greater_than": return parseFloat(pval) > parseFloat(value);
    case "less_than": return parseFloat(pval) < parseFloat(value);
    case "in_list": {
      const list = Array.isArray(value) ? value : String(value).split(",").map(s => s.trim());
      return list.includes(String(pval ?? ""));
    }
    case "not_in_list": {
      const list = Array.isArray(value) ? value : String(value).split(",").map(s => s.trim());
      return !list.includes(String(pval ?? ""));
    }
    case "stage_is_before": return stageIndex(pval) < stageIndex(value);
    case "stage_is_after": return stageIndex(pval) > stageIndex(value);
    case "date_is_today": {
      const d = fixTS(pval);
      if (!d) return false;
      const today = getSydneyDateStr();
      return d.toISOString().slice(0, 10) === today;
    }
    case "date_is_past": {
      const d = fixTS(pval);
      if (!d) return false;
      const today = getSydneyDateStr();
      return d.toISOString().slice(0, 10) < today;
    }
    case "date_within_hours": {
      const d = fixTS(pval);
      if (!d) return false;
      const hours = parseFloat(value) || 24;
      const diff = (d.getTime() - Date.now()) / (1000 * 3600);
      return diff >= 0 && diff <= hours;
    }
    case "date_older_than_days": {
      const d = fixTS(pval);
      if (!d) return false;
      const days = parseFloat(value) || 7;
      const diffDays = (Date.now() - d.getTime()) / (1000 * 3600 * 24);
      return diffDays >= days;
    }
    default: return false;
  }
}

function evaluateConditions(project: any, conditions: any[], logic: string): boolean {
  if (!conditions || conditions.length === 0) return true;
  if (logic === "OR") return conditions.some(c => evaluateCondition(project, c));
  return conditions.every(c => evaluateCondition(project, c)); // AND default
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function safeList(base44: any, entity: string, limit = 100) {
  try { return await base44.asServiceRole.entities[entity].list('-created_date', limit); }
  catch { return []; }
}

// ─── IDEMPOTENCY CHECK ────────────────────────────────────────────────────────
async function hasRecentLog(base44: any, idempotencyKey: string): Promise<boolean> {
  const recent = await safeList(base44, 'AutomationRuleLog', 500);
  return recent.some((l: any) => l.idempotency_key === idempotencyKey);
}

// ─── ACTION EXECUTOR ──────────────────────────────────────────────────────────
async function executeAction(base44: any, rule: any, project: any, dryRun: boolean): Promise<{ action_taken: string; result: string; result_detail?: string }> {
  const cfg = rule.action_config || {};

  if (dryRun || rule.dry_run_only) {
    return { action_taken: `[DRY RUN] Would execute: ${rule.action_type} → ${JSON.stringify(cfg)}`, result: "skipped_dry_run" };
  }

  try {
    switch (rule.action_type) {

      case "set_stage": {
        // Block if field is manually overridden
        const overridden: string[] = (() => {
          try { return JSON.parse(project.manually_overridden_fields || '[]'); } catch { return []; }
        })();
        if (overridden.includes('status')) {
          return { action_taken: `Blocked: status in manually_overridden_fields`, result: "skipped_overridden" };
        }
        const newStage = cfg.stage;
        if (!newStage) return { action_taken: "No stage in action_config", result: "error" };
        if (project.status === newStage) return { action_taken: `Already at stage ${newStage}`, result: "skipped_conditions" };
        await base44.asServiceRole.entities.Project.update(project.id, { status: newStage });

        // Trigger stage-change engine (notifications, activity log, deadline recalc)
        base44.asServiceRole.functions.invoke('trackProjectStageChange', {
          projectId: project.id,
          old_data: { status: project.status },
          actor_id: null,
          actor_name: 'Automation Rule',
        }).catch(() => {});

        return { action_taken: `Stage: ${project.status} → ${newStage}`, result: "executed" };
      }

      case "set_field": {
        const field = cfg.field;
        const value = cfg.value;
        if (!field) return { action_taken: "No field in action_config", result: "error" };
        const overridden: string[] = (() => {
          try { return JSON.parse(project.manually_overridden_fields || '[]'); } catch { return []; }
        })();
        if (overridden.includes(field)) {
          return { action_taken: `Blocked: ${field} in manually_overridden_fields`, result: "skipped_overridden" };
        }
        await base44.asServiceRole.entities.Project.update(project.id, { [field]: value });
        return { action_taken: `Set ${field} = ${JSON.stringify(value)}`, result: "executed" };
      }

      case "set_flag": {
        const flag = cfg.flag;
        const value = cfg.value !== undefined ? cfg.value : true;
        if (!flag) return { action_taken: "No flag in action_config", result: "error" };
        await base44.asServiceRole.entities.Project.update(project.id, { [flag]: value });
        return { action_taken: `Set flag ${flag} = ${value}`, result: "executed" };
      }

      case "notify_roles": {
        const roles: string[] = cfg.roles || ["master_admin"];
        const message: string = cfg.message || `Rule "${rule.name}" triggered`;
        const notifType: string = cfg.notification_type || "stale_project";
        const title: string = cfg.title || rule.name;
        const category: string = cfg.category || "system";
        const severity: string = cfg.severity || "info";

        // Write to ProjectActivity with automation context
         await base44.asServiceRole.entities.ProjectActivity.create({
           project_id: project.id,
           project_title: project.title || project.property_address || '',
           action: 'automation_rule_fired',
           description: message,
           actor_type: 'automation',
           actor_source: 'runProjectAutomationRules',
           user_name: 'Automation',
           user_email: 'system@flexmedia',
           automation_rule_id: rule.id,
           automation_rule_name: rule.name,
           metadata: JSON.stringify({ rule_id: rule.id, rule_name: rule.name, target_roles: roles }),
         });

        // NEW: Write real Notification records for each target user
        const idemSuffix = todayStr; // daily dedup
        const notifCount = await _createNotifsForRoles(base44, {
          roles,
          type: notifType,
          title,
          message,
          category,
          severity,
          projectId: project.id,
          projectName: project.title || project.property_address || project.id,
          entityType: 'project',
          entityId: project.id,
          ctaUrl: 'ProjectDetails',
          ctaLabel: 'View Project',
          ctaParams: { id: project.id },
          source: 'automation_rule',
          sourceRuleId: rule.id,
          idempotencyKeySuffix: idemSuffix,
          prefsCache,
          notifKeySet,
        });

        // Write to team activity feed
        await _writeFeedEvent(base44, {
          eventType:    'automation_rule_fired',
          category:     'automation',
          severity:     severity,
          title:        `⚙️ ${rule.name}`,
          description:  message,
          projectId:    project.id,
          projectName:  project.title  || null,
          projectAddress: project.property_address || null,
          projectStage: project.status || null,
          entityType:   'project',
          entityId:     project.id,
          metadata:     { rule_id: rule.id, rule_name: rule.name, rule_group: rule.rule_group, action_type: rule.action_type },
          visibleToRoles: 'master_admin',
        });

        return {
          action_taken: `Notification sent to ${notifCount} user(s): ${message}`,
          result: "executed"
        };
      }

      case "add_activity_log": {
        const message: string = cfg.message || `Automation rule "${rule.name}" fired`;
        await base44.asServiceRole.entities.ProjectActivity.create({
          project_id: project.id,
          project_title: project.title || project.property_address || '',
          action: 'automation_rule_fired',
          description: message,
          actor_type: 'automation',
          actor_source: 'runProjectAutomationRules',
          user_name: 'Automation',
          user_email: 'system@flexmedia',
          automation_rule_id: rule.id,
          automation_rule_name: rule.name,
          metadata: JSON.stringify({ rule_id: rule.id, rule_name: rule.name }),
        });
        return { action_taken: `Activity logged: ${message}`, result: "executed" };
      }

      case "noop": {
        return { action_taken: "No-op rule (monitoring only)", result: "executed" };
      }

      default:
        return { action_taken: `Unknown action_type: ${rule.action_type}`, result: "error" };
    }
  } catch (err: any) {
    return { action_taken: `Action failed`, result: "error", result_detail: err.message };
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    // Fetch all enabled rules
    const allRules = await safeList(base44, 'ProjectAutomationRule', 200);
    const enabledRules = allRules.filter((r: any) => r.is_enabled);

    if (!enabledRules.length) {
      return Response.json({ processed: 0, message: "no_enabled_rules" });
    }

    // Fetch active projects only — no need to evaluate cancelled or delivered
    // projects for most rules (they're filtered per-project below).
    // Sort by updated_date descending so most recently active projects are first.
    // Cap at 2000 — sufficient for this operation and avoids memory/timeout issues.
    const projects = await safeList(base44, 'Project', 2000);

    // Pre-load notification preferences and recent notifications ONCE.
    // These are passed into _createNotif to avoid per-notification table scans.
    let prefsCache: Map<string, any[]> = new Map();
    let notifKeySet: Set<string> = new Set();
    try {
      const allPrefs = await base44.asServiceRole.entities.NotificationPreference
        .list('-created_date', 1000);
      for (const pref of allPrefs) {
        if (!prefsCache.has(pref.user_id)) prefsCache.set(pref.user_id, []);
        prefsCache.get(pref.user_id)!.push(pref);
      }
      const recentNotifs = await base44.asServiceRole.entities.Notification
        .list('-created_date', 1000);
      for (const n of recentNotifs) {
        if (n.idempotency_key && n.user_id) {
          notifKeySet.add(`${n.idempotency_key}:${n.user_id}`);
        }
      }
    } catch { /* non-fatal — fall back to per-call fetching */ }

    const sydneyTime = toSydneyTime(new Date()); // "HH:MM"
    const todayStr = getSydneyDateStr();

    const stats = { rules_evaluated: 0, actions_taken: 0, skipped: 0, errors: 0 };

    for (const rule of enabledRules) {
      const conditions: any[] = (() => {
        try { return JSON.parse(rule.conditions_json || '[]'); } catch { return []; }
      })();
      const conditionLogic = rule.condition_logic || "AND";
      const triggerCfg = (() => {
        try { return JSON.parse(rule.trigger_config || '{}'); } catch { return {}; }
      })();

      // For schedule_daily rules: check if current time matches the rule's scheduled time (within 1 min window)
      if (rule.trigger_type === "schedule_daily") {
        const ruleTime = triggerCfg.time || "09:00"; // HH:MM
        if (sydneyTime !== ruleTime) continue; // not the right time yet
      }

      for (const project of projects) {
        // Skip inactive projects for non-financial rules.
        // Cancelled and delivered projects should not receive production/scheduling alerts.
        // Exception: schedule_daily rules may legitimately target delivered projects
        // (e.g. invoice overdue reminders) — those are allowed through.
        const INACTIVE_STAGES = ['cancelled', 'delivered'];
        const isInactive = INACTIVE_STAGES.includes(project.status);
        const isFinancialRule = rule.rule_group === 'financial' || (rule.action_type === 'send_notification' &&
          (() => { try { return JSON.parse(rule.trigger_config || '{}').notification_type?.includes('invoice'); } catch { return false; } })());

        if (isInactive && rule.trigger_type !== 'schedule_daily' && !isFinancialRule) {
          stats.skipped++;
          continue;
        }

        stats.rules_evaluated++;

        // Idempotency key
        let idemKey: string;
        if (rule.trigger_type === "schedule_daily") {
          idemKey = `${rule.id}:${project.id}:${todayStr}`;
        } else {
          const updatedAt = project.updated_date || project.created_date || todayStr;
          idemKey = `${rule.id}:${project.id}:${(updatedAt || "").slice(0, 16)}`; // minute-level granularity
        }

        // Check cooldown / idempotency
        const alreadyRan = await hasRecentLog(base44, idemKey);
        if (alreadyRan) { stats.skipped++; continue; }

        // Evaluate conditions
        const conditionsMet = evaluateConditions(project, conditions, conditionLogic);
        if (!conditionsMet) {
          stats.skipped++;
          continue;
        }

        // Execute action
         const { action_taken, result, result_detail } = await executeAction(base44, rule, project, false, todayStr);

        // Write log
        await base44.asServiceRole.entities.AutomationRuleLog.create({
          rule_id: rule.id,
          rule_name: rule.name,
          project_id: project.id,
          project_name: project.title || project.property_address || project.id,
          trigger_type: rule.trigger_type,
          action_taken,
          result,
          result_detail: result_detail || null,
          idempotency_key: idemKey,
          dry_run: rule.dry_run_only || false,
          fired_at: new Date().toISOString()
        });

        if (result === "executed") {
          stats.actions_taken++;
          // Update rule stats
          await base44.asServiceRole.entities.ProjectAutomationRule.update(rule.id, {
            last_fired_at: new Date().toISOString(),
            fire_count: (rule.fire_count || 0) + 1
          });
        } else {
          stats.skipped++;
          await base44.asServiceRole.entities.ProjectAutomationRule.update(rule.id, {
            last_skipped_at: new Date().toISOString(),
            skip_count: (rule.skip_count || 0) + 1
          });
        }
      }
    }

    return Response.json({ ...stats, processor_version: PROCESSOR_VERSION });

  } catch (err: any) {
    console.error('AutomationRuleEngine fatal:', err.message);
    return Response.json({ error: err.message }, { status: 200 });
  }
});