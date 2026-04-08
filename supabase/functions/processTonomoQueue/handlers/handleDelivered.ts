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

  if (!overriddenFields.includes('status')) {
    if (hasDeliverables) {
      updates.status = 'delivered';
    } else {
      if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;
      updates.status = 'pending_review';
      updates.pending_review_reason = 'Delivery event received but no deliverable links — please add manually';
    }
  }

  if (p.deliveredDate) updates.tonomo_delivered_at = new Date(p.deliveredDate).toISOString();
  if (p.deliverable_link) updates.tonomo_deliverable_link = p.deliverable_link;
  if (p.deliverable_path || p.order?.deliverable_path) updates.tonomo_deliverable_path = p.deliverable_path || p.order?.deliverable_path;
  if (p.deliverablesLinks?.length > 0) updates.tonomo_delivered_files = JSON.stringify(p.deliverablesLinks);
  if (p.invoice_link) updates.tonomo_invoice_link = p.invoice_link;
  if (p.invoice_amount != null && !overriddenFields.includes('tonomo_invoice_amount')) updates.tonomo_invoice_amount = p.invoice_amount ? parseFloat(p.invoice_amount) : null;

  // Auto-complete all active tasks on delivery
  const tasks = await entities.ProjectTask.filter({ project_id: project.id }, '-created_at', 500).catch(() => []);
  for (const task of (tasks || [])) {
    if (!task.is_completed && !task.is_deleted) {
      try {
        await entities.ProjectTask.update(task.id, {
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
      } catch (taskErr: any) {
        console.error(`Task completion failed for task ${task.id} (non-fatal):`, taskErr.message);
      }
    }
  }

  await entities.Project.update(project.id, updates);
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

  // Fire trackProjectStageChange so timers, notifications, task cleanup, and automation all run
  if (updates.status && updates.status !== project.status) {
    invokeFunction('trackProjectStageChange', {
      projectId: project.id,
      old_data: { status: project.status },
      actor_id: null,
      actor_name: 'Tonomo Delivery',
    }).catch(() => {});
  }

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
