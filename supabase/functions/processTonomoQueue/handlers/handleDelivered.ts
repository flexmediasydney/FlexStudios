import { invokeFunction } from '../../_shared/supabase.ts';
import {
  findProjectByOrderId,
  safeJsonParse,
  writeAudit,
  writeProjectActivity,
  fireRoleNotif,
} from '../utils.ts';

export async function handleDelivered(entities: any, orderId: string, p: any) {
  const project = await findProjectByOrderId(entities, orderId);
  if (!project) return { summary: `No project found for delivery ${orderId}`, skipped: true };

  const overriddenFields = safeJsonParse(project.manually_overridden_fields, [] as string[]);
  const hasDeliverables = p.deliverable_link || (p.deliverablesLinks?.length > 0);

  // Map Tonomo payment status to canonical payment_status values
  const mapTonomoPaymentStatus = (raw: string | undefined | null): string | null => {
    if (!raw) return null;
    const lower = raw.toLowerCase().trim();
    if (lower === 'paid') return 'paid';
    if (lower === 'unpaid' || lower === 'pending') return 'unpaid';
    if (lower === 'partial') return 'partial';
    return null; // unknown value — don't overwrite
  };

  const updates: Record<string, any> = {
    tonomo_order_status: 'complete',
    tonomo_payment_status: p.paymentStatus || project.tonomo_payment_status,
  };

  // Sync Tonomo payment status to main payment_status field
  const incomingPayment = p.paymentStatus || project.tonomo_payment_status;
  const mappedPayment = mapTonomoPaymentStatus(incomingPayment);
  if (mappedPayment && !overriddenFields.includes('payment_status')) {
    updates.payment_status = mappedPayment;
  }

  // Auto-resolve a narrow class of stale pending_reviews on delivery:
  // when the project is sitting in pending_review for `rescheduled` or
  // `appointment_cancelled` (both appointment-level reasons that are moot
  // once Tonomo has delivered), and pre_revision_stage is set, silently
  // clear the review and restore the prior stage. Anything else
  // (cancellation, restoration, pricing_mismatch, new_booking, tonomo_drift,
  // service_change, staff_change, products_removed) still requires human
  // review — the delivery fact doesn't dissolve those concerns.
  const APPOINTMENT_ONLY_REVIEW_TYPES = ['rescheduled', 'appointment_cancelled'];
  if (
    project.status === 'pending_review' &&
    project.pre_revision_stage &&
    project.pending_review_type &&
    APPOINTMENT_ONLY_REVIEW_TYPES.includes(project.pending_review_type)
  ) {
    updates.status = project.pre_revision_stage;
    updates.pending_review_type = null;
    updates.pending_review_reason = null;
    updates.pre_revision_stage = null;
    updates.urgent_review = false;
    console.log(`[handleDelivered] Auto-resolved stale ${project.pending_review_type} pending_review for ${orderId} → ${project.pre_revision_stage}`);
  }

  if (p.deliveredDate) updates.tonomo_delivered_at = new Date(p.deliveredDate).toISOString();
  if (p.deliverable_link) updates.tonomo_deliverable_link = p.deliverable_link;
  if (p.deliverable_path || p.order?.deliverable_path) updates.tonomo_deliverable_path = p.deliverable_path || p.order?.deliverable_path;
  if (p.deliverablesLinks?.length > 0) updates.tonomo_delivered_files = JSON.stringify(p.deliverablesLinks);
  if (p.invoice_link) updates.tonomo_invoice_link = p.invoice_link;
  if (p.invoice_amount != null && !overriddenFields.includes('tonomo_invoice_amount')) updates.tonomo_invoice_amount = p.invoice_amount ? parseFloat(p.invoice_amount) : null;

  // Auto-complete all active tasks on delivery
  const tasks = await entities.ProjectTask.filter({ project_id: project.id }, '-created_at', 500).catch(() => []);
  const autoCompletedTasks: Array<{ id: string; title: string }> = [];
  for (const task of (tasks || [])) {
    if (!task.is_completed && !task.is_deleted) {
      try {
        await entities.ProjectTask.update(task.id, {
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
        autoCompletedTasks.push({ id: task.id, title: task.title || 'Untitled task' });
      } catch (taskErr: any) {
        console.error(`Task completion failed for task ${task.id} (non-fatal):`, taskErr.message);
      }
    }
  }

  // Emit a single summary activity entry for auto-completed tasks
  if (autoCompletedTasks.length > 0) {
    await writeProjectActivity(entities, {
      project_id: project.id,
      project_title: project.title || '',
      action: 'task_auto_completed',
      description: `Auto-completed ${autoCompletedTasks.length} task${autoCompletedTasks.length === 1 ? '' : 's'} on Tonomo delivery: ${autoCompletedTasks.map(t => t.title).slice(0, 6).join(', ')}${autoCompletedTasks.length > 6 ? `, +${autoCompletedTasks.length - 6} more` : ''}`,
      tonomo_order_id: orderId,
      tonomo_event_type: 'task_auto_completed_on_delivery',
      metadata: {
        trigger: 'tonomo_delivery',
        task_count: autoCompletedTasks.length,
        tasks: autoCompletedTasks,
      },
    });
  }

  await entities.Project.update(project.id, updates);

  // Invalidate old media cache and pre-warm with fresh data
  if (updates.tonomo_deliverable_link || project.tonomo_deliverable_link) {
    try {
      await invokeFunction('getDeliveryMediaFeed', {
        action: 'invalidate_cache',
        project_id: project.id,
        share_url: updates.tonomo_deliverable_link || project.tonomo_deliverable_link,
      });
    } catch (err: any) {
      console.warn('Cache invalidation failed:', err.message);
    }
  }

  await writeAudit(entities, {
    action: 'booking_completed', entity_type: 'Project', entity_id: project.id, operation: 'updated',
    tonomo_order_id: orderId,
    notes: `Delivered: ${hasDeliverables ? 'yes' : 'NO LINKS'}. Files: ${p.deliverablesLinks?.length || 0}. Final invoice: $${p.invoice_amount ?? 'unknown'}`,
  });

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_delivered',
    description: `Delivery confirmed by Tonomo for order ${orderId}.${hasDeliverables ? ` Deliverable link received.` : ' No deliverable links — add manually.'}${p.invoice_amount ? ` Final invoice: $${p.invoice_amount}.` : ''}`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'booking_completed',
    metadata: {
      has_deliverables: hasDeliverables,
      invoice_amount: p.invoice_amount,
      payment_status: p.paymentStatus,
    },
  });

  // Project status is no longer auto-transitioned on delivery, so trackProjectStageChange
  // is intentionally not invoked here. Staff will change status manually when ready.

  // Notify staff about delivery
  const deliveryProjectName = project.title || project.property_address || 'Project';
  fireRoleNotif(entities, ['project_owner', 'photographer', 'master_admin'], {
    type: 'booking_delivered',
    category: 'tonomo',
    severity: 'info',
    title: `Delivered — ${deliveryProjectName}`,
    message: `Deliverables received from Tonomo.${p.invoice_amount ? ` Final invoice: $${p.invoice_amount}.` : ''}`,
    projectId: project.id,
    projectName: deliveryProjectName,
    ctaLabel: 'View Project',
    source: 'tonomo',
    idempotencyKey: `delivered:${orderId}`,
  }, project).catch(() => {});

  // Trigger auto-archive check (delivered + paid + tasks complete = auto-archive)
  invokeFunction('checkAndArchiveProject', {
    project_id: project.id,
    triggered_by: 'tonomo_delivery',
  }).catch(() => {});

  return { summary: `Project delivered for order ${orderId}` };
}
