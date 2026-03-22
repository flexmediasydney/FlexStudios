import { invokeFunction } from '../../_shared/supabase.ts';
import {
  findProjectByOrderId,
  writeAudit,
  writeProjectActivity,
  fireRoleNotif,
} from '../utils.ts';

export async function handleCancelled(entities: any, orderId: string, p: any) {
  const project = await findProjectByOrderId(entities, orderId);
  if (!project) return { summary: `No project found for cancelled order ${orderId}`, skipped: true };

  const updates: Record<string, any> = {
    status: 'pending_review',
    pending_review_type: 'cancellation',
    pending_review_reason: 'Cancellation received from Tonomo — confirm to mark as cancelled, or dismiss if incorrect.',
    tonomo_order_status: 'cancelled',
    tonomo_lifecycle_stage: 'cancelled',
  };
  if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;

  await entities.Project.update(project.id, updates);

  // Stop running timers on cancellation
  invokeFunction('trackProjectStageChange', {
    project_id: project.id,
    from_stage: project.status,
    to_stage: 'pending_review',
  }).catch(() => {});

  await writeAudit(entities, {
    action: 'canceled', entity_type: 'Project', entity_id: project.id, operation: 'cancelled',
    tonomo_order_id: orderId, notes: `Moved to pending_review for cancellation confirmation. Was: ${project.status}`,
  });

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_cancelled',
    description: `Cancellation received from Tonomo for order ${orderId}. Project moved to pending review — confirm to mark as cancelled.`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'canceled',
  });

  const cancelProjectName = project.title || project.property_address || 'Project';
  fireRoleNotif(entities, ['master_admin', 'project_owner'], {
    type: 'booking_cancellation',
    category: 'tonomo',
    severity: 'critical',
    title: `Booking cancelled — ${cancelProjectName}`,
    message: `Tonomo booking has been cancelled. Order: ${orderId}.`,
    projectId: project.id,
    projectName: cancelProjectName,
    ctaLabel: 'Review Booking',
    source: 'tonomo',
    idempotencyKey: `cancellation:${orderId}`,
  }, project).catch(() => {});

  return { summary: `Project for order ${orderId} moved to pending_review (cancellation)` };
}
