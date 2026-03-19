import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  // Check if already seeded
  const existing = await base44.asServiceRole.entities.ProjectAutomationRule.list('-created_date', 5);
  if (existing?.length > 0) {
    return Response.json({ message: "Already seeded, skipping", count: existing.length });
  }

  const rules = [

    // ══════════════════════════════════════════════════════════════
    // SCHEDULING GROUP
    // ══════════════════════════════════════════════════════════════
    {
      name: "S1 — Shoot Day: Move to Onsite",
      description: "Every morning at 5am, any project with shoot_date = today and status = scheduled is moved to onsite.",
      rule_group: "scheduling",
      is_enabled: true,
      is_system: true,
      priority: 10,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "05:00" }),
      conditions_json: JSON.stringify([
        { field: "shoot_date", operator: "date_is_today", value: null },
        { field: "status", operator: "equals", value: "scheduled" }
      ]),
      condition_logic: "AND",
      action_type: "set_stage",
      action_config: JSON.stringify({ stage: "onsite" }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Core daily automation. Fires once per project per day at 5am Sydney."
    },
    {
      name: "S2 — End of Shoot Day: Move to Uploaded",
      description: "At 11:45pm, any project still in onsite with shoot_date = today is moved to uploaded.",
      rule_group: "scheduling",
      is_enabled: true,
      is_system: true,
      priority: 30,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "23:45" }),
      conditions_json: JSON.stringify([
        { field: "shoot_date", operator: "date_is_today", value: null },
        { field: "status", operator: "equals", value: "onsite" }
      ]),
      condition_logic: "AND",
      action_type: "set_stage",
      action_config: JSON.stringify({ stage: "uploaded" }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "End-of-day sweep. Only fires if photographer hasn't manually moved the project."
    },
    {
      name: "S3 — Overdue Shoot Alert",
      description: "Daily at 7am: alert if a project's shoot_date has passed but it's still in 'scheduled' stage.",
      rule_group: "scheduling",
      is_enabled: true,
      is_system: true,
      priority: 5,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "07:00" }),
      conditions_json: JSON.stringify([
        { field: "shoot_date", operator: "date_is_past", value: null },
        { field: "status", operator: "equals", value: "scheduled" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "⚠️ Overdue: shoot date has passed but project is still in Scheduled stage. Please review." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Catches projects that were never progressed after their shoot date."
    },
    {
      name: "S4 — Reschedule in Advanced Stage: Notify Only",
      description: "If a project in uploaded or later receives a reschedule signal (shoot_date changes), notify the owner — never move stage backwards.",
      rule_group: "scheduling",
      is_enabled: true,
      is_system: true,
      priority: 5,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "shoot_date", operator: "is_set", value: null },
        { field: "status", operator: "stage_is_after", value: "uploaded" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "📅 Shoot date changed on a project that is already past Uploaded stage. Stage NOT moved back — please verify manually." }),
      cooldown_minutes: 60,
      dry_run_only: false,
      notes: "Guard against unwanted backwards stage movement after reschedule."
    },

    // ══════════════════════════════════════════════════════════════
    // PRODUCTION GROUP
    // ══════════════════════════════════════════════════════════════
    {
      name: "P1 — Stale Production Alert",
      description: "Daily at 9am: flag any project that has been in in_progress for more than 3 days.",
      rule_group: "production",
      is_enabled: true,
      is_system: false,
      priority: 40,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "status", operator: "equals", value: "in_progress" },
        { field: "updated_date", operator: "date_older_than_days", value: "3" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "⏰ Project has been in In Progress for 3+ days with no update. Please review production status." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Helps surface projects that have gone quiet in production."
    },
    {
      name: "P2 — Stale Submitted Alert",
      description: "Daily at 9am: flag any project stuck in submitted for more than 2 days.",
      rule_group: "production",
      is_enabled: true,
      is_system: false,
      priority: 40,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "status", operator: "equals", value: "submitted" },
        { field: "updated_date", operator: "date_older_than_days", value: "2" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "⏰ Project has been in Submitted for 2+ days. Has it been picked up for editing?" }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Catches projects sitting in the submission queue too long."
    },

    // ══════════════════════════════════════════════════════════════
    // REVISION GROUP
    // ══════════════════════════════════════════════════════════════
    {
      name: "R1 — Stale Revision Alert (48 Hours)",
      description: "Daily at 9am: notify if a project has been in in_revision for more than 2 days.",
      rule_group: "revision",
      is_enabled: true,
      is_system: false,
      priority: 50,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "status", operator: "equals", value: "in_revision" },
        { field: "updated_date", operator: "date_older_than_days", value: "2" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "🔄 Project has been in revision for 2+ days. Please check if the revision has been actioned." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Surfaces long-running revisions before they become client issues."
    },

    // ══════════════════════════════════════════════════════════════
    // TONOMO GROUP
    // ══════════════════════════════════════════════════════════════
    {
      name: "T1 — Cancellation: Flag and Alert",
      description: "When a Tonomo project enters pending_review with a cancellation reason, log a prominent alert.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: true,
      priority: 1,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "pending_review_reason", operator: "contains", value: "cancel" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "🚨 CANCELLATION received from Tonomo. This booking has been cancelled — review and update accordingly." }),
      cooldown_minutes: 60,
      dry_run_only: false,
      notes: "Ensures cancellations are never silently processed."
    },
    {
      name: "T2 — Imminent Shoot in Pending Review: Mark Urgent",
      description: "Daily at 6am: if a Tonomo project is still in pending_review with a shoot within 24 hours, mark it urgent.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: true,
      priority: 1,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "06:00" }),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "status", operator: "equals", value: "pending_review" },
        { field: "shoot_date", operator: "date_within_hours", value: "24" }
      ]),
      condition_logic: "AND",
      action_type: "set_flag",
      action_config: JSON.stringify({ flag: "urgent_review", value: true }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Prevents shoots falling through the cracks if booking approval is delayed."
    },
    {
      name: "T3 — Payment Received: Activity Log",
      description: "When tonomo_payment_status changes to paid, write an activity log entry.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: false,
      priority: 20,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "tonomo_payment_status", operator: "equals", value: "paid" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "💰 Payment received (Tonomo marked as paid)." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Financial audit trail for Tonomo payments."
    },
    {
      name: "T4 — Invoice Link Added: Activity Log",
      description: "When a Xero invoice link is populated on a project, log it.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: false,
      priority: 50,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "tonomo_invoice_link", operator: "is_set", value: null }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "📄 Xero invoice link has been set on this project." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Visibility on invoice generation timing."
    },
    {
      name: "T5 — Service Uncertainty Warning",
      description: "When service_assignment_uncertain is true on a Tonomo project, log a warning.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: true,
      priority: 30,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "service_assignment_uncertain", operator: "equals", value: "true" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "⚠️ Service assignment is uncertain for this booking (multiple photographers with ambiguous service split). Please verify task assignments manually." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Flags multi-photographer service splits that need manual review."
    },
    {
      name: "T6 — Mapping Gaps After Approval",
      description: "On every run: if a Tonomo project is past pending_review and still has mapping gaps, notify admin once.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: true,
      priority: 20,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "mapping_gaps", operator: "is_set", value: null },
        { field: "status", operator: "not_equals", value: "pending_review" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "🗺️ Project approved from pending_review but mapping gaps remain. Some Tonomo data may not have mapped correctly — check the Tonomo tab." }),
      cooldown_minutes: 60,
      dry_run_only: false,
      notes: "Ensures mapping issues are surfaced even after approval."
    },
    {
      name: "T7 — No Photographer on Scheduled Booking",
      description: "When a Tonomo project enters scheduled stage with no photographer IDs, alert admin.",
      rule_group: "tonomo",
      is_enabled: true,
      is_system: true,
      priority: 10,
      trigger_type: "always",
      trigger_config: JSON.stringify({}),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "tonomo_photographer_ids", operator: "in_list", value: ["null", "", "[]"] }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "📷 No photographer assigned on this Tonomo booking. Please check the Tonomo tab and assign a photographer." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Catches bookings that were confirmed without a photographer assignment."
    },

    // ══════════════════════════════════════════════════════════════
    // FINANCIAL GROUP
    // ══════════════════════════════════════════════════════════════
    {
      name: "F1 — Unpaid + Delivered 7+ Days: Alert",
      description: "Daily at 9am: flag any delivered Tonomo project that is still unpaid 7+ days after delivery.",
      rule_group: "financial",
      is_enabled: true,
      is_system: false,
      priority: 30,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "status", operator: "equals", value: "delivered" },
        { field: "tonomo_payment_status", operator: "not_equals", value: "paid" },
        { field: "updated_date", operator: "date_older_than_days", value: "7" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "💸 PAYMENT OUTSTANDING: Project delivered 7+ days ago and still showing unpaid in Tonomo. Please follow up." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Revenue protection — surfaces aged outstanding invoices daily."
    },
    {
      name: "F2 — Unpaid + Delivered 14+ Days: Escalate",
      description: "Daily at 9am: escalate flag on projects that are 14+ days post-delivery and still unpaid.",
      rule_group: "financial",
      is_enabled: true,
      is_system: false,
      priority: 25,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "status", operator: "equals", value: "delivered" },
        { field: "tonomo_payment_status", operator: "not_equals", value: "paid" },
        { field: "updated_date", operator: "date_older_than_days", value: "14" }
      ]),
      condition_logic: "AND",
      action_type: "set_flag",
      action_config: JSON.stringify({ flag: "urgent_review", value: true }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "14-day escalation adds urgent_review flag so it appears prominently in Bookings Engine."
    },

    // ══════════════════════════════════════════════════════════════
    // QUALITY GROUP
    // ══════════════════════════════════════════════════════════════
    {
      name: "Q1 — Stale Project Alert (7 Days No Progress)",
      description: "Daily at 9am: flag any non-delivered project that hasn't been updated in 7+ days.",
      rule_group: "quality",
      is_enabled: true,
      is_system: false,
      priority: 40,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "status", operator: "not_in_list", value: ["delivered", "pending_review", "to_be_scheduled"] },
        { field: "updated_date", operator: "date_older_than_days", value: "7" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "🕸️ Project has had no updates in 7+ days. Is it stuck?" }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Broad staleness detector across all active project stages."
    },
    {
      name: "Q2 — Pending Review Too Long (48 Hours)",
      description: "Daily at 9am: alert if a Tonomo project has been in pending_review for 48+ hours.",
      rule_group: "quality",
      is_enabled: true,
      is_system: false,
      priority: 35,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "09:00" }),
      conditions_json: JSON.stringify([
        { field: "source", operator: "equals", value: "tonomo" },
        { field: "status", operator: "equals", value: "pending_review" },
        { field: "updated_date", operator: "date_older_than_days", value: "2" }
      ]),
      condition_logic: "AND",
      action_type: "add_activity_log",
      action_config: JSON.stringify({ message: "⏳ Booking has been in Pending Review for 48+ hours. Please approve or action it." }),
      cooldown_minutes: 1440,
      dry_run_only: false,
      notes: "Prevents bookings from being stuck awaiting approval indefinitely."
    },
    {
      name: "Q3 — Monitoring: Daily Rule Engine Health Log",
      description: "Daily at 8am: write a heartbeat entry to confirm automation is running. Useful for debugging.",
      rule_group: "quality",
      is_enabled: false,
      is_system: false,
      priority: 100,
      trigger_type: "schedule_daily",
      trigger_config: JSON.stringify({ time: "08:00" }),
      conditions_json: JSON.stringify([
        { field: "status", operator: "equals", value: "delivered" }
      ]),
      condition_logic: "AND",
      action_type: "noop",
      action_config: JSON.stringify({}),
      cooldown_minutes: 1440,
      dry_run_only: true,
      notes: "Disabled by default. Enable temporarily to verify the rule engine is polling correctly."
    }
  ];

  let created = 0;
  for (const rule of rules) {
    try {
      await base44.asServiceRole.entities.ProjectAutomationRule.create({
        ...rule,
        fire_count: 0,
        skip_count: 0,
        created_date: new Date().toISOString()
      });
      created++;
    } catch (err: any) {
      console.error(`Failed to seed rule "${rule.name}":`, err.message);
    }
  }

  return Response.json({ message: `Seeded ${created} of ${rules.length} rules`, created });
});