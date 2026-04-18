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

  // Normalize tracked appointment ids (can be JSON string or array in DB)
  const rawAppts = project.tonomo_appointment_ids;
  const appointmentIds: string[] = Array.isArray(rawAppts)
    ? rawAppts
    : (typeof rawAppts === 'string'
        ? (() => { try { return JSON.parse(rawAppts) as string[]; } catch { return []; } })()
        : []);
  const cancelledEventId = p.id || p.appointment_id || null;

  // Classify: is this a full ORDER cancel, or just an APPOINTMENT cancel?
  // Tonomo sends action='canceled' for BOTH cases with the same payload shape.
  // The discriminator is p.order.orderStatus:
  //   - 'cancelled' → customer cancelled the whole order
  //   - anything else (inProgress, scheduled, etc.) → customer removed an
  //     appointment but the order/booking is still live (they'll reschedule)
  const orderStatusInPayload = (p.order?.orderStatus || p.orderStatus || '').toLowerCase();
  const isFullOrderCancel = orderStatusInPayload === 'cancelled' || orderStatusInPayload === 'canceled';

  // --- Partial cancellation (MULTIPLE appointments in order) ---
  // User removed one of N appointments. Keep the others + project status.
  if (appointmentIds.length > 1 && cancelledEventId) {
    // Remove just this appointment's calendar event
    try {
      const linkedEvents = await entities.CalendarEvent.filter({ project_id: project.id }, null, 50);
      const cancelledEvents = linkedEvents.filter((ev: any) =>
        ev.tonomo_appointment_id === cancelledEventId || ev.google_event_id === cancelledEventId
      );
      for (const ev of cancelledEvents) {
        await entities.CalendarEvent.delete(ev.id).catch(() => {});
        console.log(`[cancelled] Deleted calendar event ${ev.id} for partially-cancelled appointment ${cancelledEventId}`);
      }
    } catch (err: any) {
      console.warn(`[cancelled] Failed to clean calendar events for partial cancel:`, err?.message);
    }

    // Flag for review but DON'T change project status
    const partialUpdates: Record<string, any> = {
      pending_review_type: 'partial_cancellation',
    };

    // Remove the cancelled appointment ID from the array
    const remaining = appointmentIds.filter((id: string) => id !== cancelledEventId);
    if (remaining.length > 0) {
      partialUpdates.tonomo_appointment_ids = remaining;
    }

    await entities.Project.update(project.id, partialUpdates);

    await writeAudit(entities, {
      action: 'canceled', entity_type: 'Project', entity_id: project.id, operation: 'partial_cancel',
      tonomo_order_id: orderId,
      notes: `Partial cancellation: removed appointment ${cancelledEventId}, ${remaining.length} appointment(s) remain. Project status unchanged.`,
    });

    await writeProjectActivity(entities, {
      project_id: project.id,
      project_title: project.title || '',
      action: 'tonomo_partial_cancelled',
      description: `Single appointment ${cancelledEventId} cancelled in Tonomo. ${remaining.length} appointment(s) remain — project status unchanged.`,
      tonomo_order_id: orderId,
      tonomo_event_type: 'canceled',
    });

    const partialProjectName = project.title || project.property_address || 'Project';
    fireRoleNotif(entities, ['master_admin', 'project_owner'], {
      type: 'booking_partial_cancellation',
      category: 'tonomo',
      severity: 'warning',
      title: `Appointment cancelled — ${partialProjectName}`,
      message: `One appointment cancelled in Tonomo (${cancelledEventId}). ${remaining.length} appointment(s) remain. Order: ${orderId}.`,
      projectId: project.id,
      projectName: partialProjectName,
      ctaLabel: 'Review Booking',
      source: 'tonomo',
      idempotencyKey: `partial_cancellation:${orderId}:${cancelledEventId}`,
    }, project).catch(() => {});

    return { summary: `Partial cancellation: removed appointment ${cancelledEventId}, ${remaining.length} appointments remain` };
  }

  // --- Appointment-only cancel (1 appointment, order still active) ---
  // Customer removed the appointment from a live order (will reschedule later).
  // Keep the order/project live; just clear the calendar event + appointment
  // metadata. Common Tonomo flow: "I need to reschedule, cancel first then
  // pick a new time" → we'd be wrong to mark the project as cancelled.
  if (!isFullOrderCancel && appointmentIds.length <= 1 && cancelledEventId) {
    // Delete the calendar event
    try {
      const linkedEvents = await entities.CalendarEvent.filter({ project_id: project.id }, null, 50);
      const cancelledEvents = linkedEvents.filter((ev: any) =>
        ev.tonomo_appointment_id === cancelledEventId || ev.google_event_id === cancelledEventId
      );
      for (const ev of cancelledEvents) {
        await entities.CalendarEvent.delete(ev.id).catch(() => {});
        console.log(`[cancelled/appt-only] Deleted calendar event ${ev.id}`);
      }
    } catch (err: any) {
      console.warn(`[cancelled/appt-only] Failed to clean calendar events:`, err?.message);
    }

    // Clear appointment metadata but keep project status (booking is still live)
    const apptOnlyUpdates: Record<string, any> = {
      tonomo_appointment_ids: [],
      shoot_date: null,
      shoot_time: null,
      pending_review_type: 'appointment_cancelled',
      pending_review_reason: 'Appointment removed in Tonomo — order is still active. Awaiting reschedule.',
    };
    // If the project is currently 'scheduled' or similar, move to pending_review
    // so operators see it needs attention (new shoot date required).
    if (project.status && !['pending_review', 'delivered', 'cancelled'].includes(project.status)) {
      apptOnlyUpdates.pre_revision_stage = project.status;
      apptOnlyUpdates.status = 'pending_review';
    }
    if (project.tonomo_event_id === cancelledEventId) apptOnlyUpdates.tonomo_event_id = null;
    if (project.tonomo_google_event_id === cancelledEventId) apptOnlyUpdates.tonomo_google_event_id = null;

    await entities.Project.update(project.id, apptOnlyUpdates);

    await writeAudit(entities, {
      action: 'canceled', entity_type: 'Project', entity_id: project.id, operation: 'appointment_only_cancel',
      tonomo_order_id: orderId, tonomo_event_id: cancelledEventId,
      notes: `Appointment ${cancelledEventId} cancelled but order stays active (orderStatus=${orderStatusInPayload}). Cleared shoot_date/time + calendar event. Awaiting reschedule.`,
    });

    await writeProjectActivity(entities, {
      project_id: project.id,
      project_title: project.title || '',
      action: 'tonomo_appointment_cancelled',
      description: `Appointment removed in Tonomo (order still active). Calendar event deleted, awaiting new shoot time.`,
      tonomo_order_id: orderId,
      tonomo_event_type: 'canceled',
    });

    const apptProjectName = project.title || project.property_address || 'Project';
    fireRoleNotif(entities, ['master_admin', 'project_owner'], {
      type: 'booking_appointment_cancelled',
      category: 'tonomo',
      severity: 'warning',
      title: `Appointment removed — ${apptProjectName}`,
      message: `Customer removed the appointment but the order is still active (${orderId}). Calendar cleared; awaiting reschedule.`,
      projectId: project.id,
      projectName: apptProjectName,
      ctaLabel: 'Review Booking',
      source: 'tonomo',
      idempotencyKey: `appt_cancel:${orderId}:${cancelledEventId}`,
    }, project).catch(() => {});

    return { summary: `Appointment ${cancelledEventId} removed from order ${orderId} (order still active)` };
  }

  // --- Full order cancel: order-level cancellation, move to pending_review ---
  const updates: Record<string, any> = {
    status: 'pending_review',
    pending_review_type: 'cancellation',
    pending_review_reason: 'Cancellation received from Tonomo — confirm to mark as cancelled, or dismiss if incorrect.',
    tonomo_order_status: 'cancelled',
    tonomo_lifecycle_stage: 'cancelled',
  };
  if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;

  await entities.Project.update(project.id, updates);

  // Delete the calendar event for this cancelled appointment
  const appointmentId = p.id || p.appointment_id || null;
  if (appointmentId) {
    try {
      const linkedEvents = await entities.CalendarEvent.filter({ project_id: project.id }, null, 50);
      const cancelledEvents = linkedEvents.filter((ev: any) =>
        ev.tonomo_appointment_id === appointmentId || ev.google_event_id === appointmentId
      );
      for (const ev of cancelledEvents) {
        await entities.CalendarEvent.delete(ev.id).catch(() => {});
        console.log(`[cancelled] Deleted calendar event ${ev.id} for cancelled appointment ${appointmentId}`);
      }
    } catch (err: any) {
      console.warn(`[cancelled] Failed to clean calendar events:`, err?.message);
    }
  }

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
