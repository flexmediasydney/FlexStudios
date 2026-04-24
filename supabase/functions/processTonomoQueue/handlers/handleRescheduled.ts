import { invokeFunction } from '../../_shared/supabase.ts';
import { ACTIVE_STAGES } from '../types.ts';
import {
  detectBookingTypes,
  assignStaffToProjectFields,
  resolveMappingsMulti,
  loadMappingTable,
  findProjectByOrderId,
  safeJsonParse,
  writeAudit,
  writeProjectActivity,
  fireRoleNotif,
  normalizeShootDate,
  hasPendingCancelForEvent,
} from '../utils.ts';

export interface HandlerContext {
  queueRowId?: string | null;
  webhookLogId?: string | null;
  eventType?: string | null;
}

export async function handleRescheduled(entities: any, orderId: string, p: any, _ctx: HandlerContext = {}) {
  const eventId = p.id;
  const startTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  const project = await findProjectByOrderId(entities, orderId);
  if (!project) {
    // STRICT: Reschedule events should only UPDATE existing projects, never create new ones.
    // If no project exists, this is an orphan event — skip it.
    await writeAudit(entities, {
      action: 'rescheduled', entity_type: 'Project', entity_id: null, operation: 'skipped',
      tonomo_order_id: orderId, tonomo_event_id: eventId,
      notes: 'Orphan event — no existing project for this order. Reschedule events do not create projects.',
    });
    return { summary: `Skipped reschedule for unknown order ${orderId} — no project exists`, skipped: true };
  }

  const overriddenFields = safeJsonParse(project.manually_overridden_fields, [] as string[]);
  const updates: Record<string, any> = {};
  const previousShootDate = project.shoot_date;

  // Backfill tonomo_appointment_ids and tonomo_event_id if missing
  if (eventId && eventId !== orderId) {
    const existingAppts = safeJsonParse(project.tonomo_appointment_ids, [] as string[]);
    if (!existingAppts.includes(eventId)) {
      updates.tonomo_appointment_ids = JSON.stringify([...existingAppts, eventId]);
    }
    if (!project.tonomo_event_id) {
      updates.tonomo_event_id = eventId;
      updates.tonomo_google_event_id = eventId;
    }
  }

  if (startTime && !overriddenFields.includes('shoot_date')) {
    const rescheduleDt = new Date(startTime);
    updates.shoot_date = rescheduleDt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    updates.shoot_time = rescheduleDt.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  // Update photographer if included in reschedule payload
  const rescheduledPhotographers = p.photographers || [];
  if (rescheduledPhotographers.length > 0) {
    updates.tonomo_photographer_ids = JSON.stringify(rescheduledPhotographers);
    const allMappings = await loadMappingTable(entities);
    const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
    const servicesB = p.order?.services || p.services || [];
    const reschServices = [...new Set([...servicesA, ...servicesB])].filter(Boolean);
    const { resolvedPhotographers, unresolvedPhotographers } = await resolveMappingsMulti(entities, { photographers: rescheduledPhotographers }, allMappings);
    if (resolvedPhotographers.length > 0) {
      const bookingTypes = detectBookingTypes(reschServices.length > 0 ? reschServices : safeJsonParse(project.tonomo_raw_services, [] as string[]));
      const staffAssignment = assignStaffToProjectFields(resolvedPhotographers, bookingTypes);
      // Build name map for denormalization
      const staffNameMap: Record<string, string> = {};
      for (const rp of resolvedPhotographers) {
        if (rp.userId && rp.name) staffNameMap[rp.userId] = rp.name;
      }
      for (const [field, userId] of Object.entries(staffAssignment)) {
        if (userId && !overriddenFields.includes(field)) {
          updates[field] = userId;
          // Denormalize name alongside ID
          const nameField = field.replace('_id', '_name');
          if (staffNameMap[userId as string]) updates[nameField] = staffNameMap[userId as string];
          // Webhook staff are always real users, not teams
          const typeField = field.replace('_id', '_type');
          updates[typeField] = 'user';
        }
      }
    }
    if (unresolvedPhotographers.length > 0) {
      updates.pre_revision_stage = project.status;
      updates.status = 'pending_review';
      updates.pending_review_type = 'staff_change';
      updates.pending_review_reason = `Photographer reassigned during reschedule but not found: ${unresolvedPhotographers.join(', ')}`;
      // Record unresolved photographers in mapping_gaps so recheckMappingGaps
      // can re-resolve them once the operator links the mapping.
      const existingGaps = safeJsonParse(project.mapping_gaps, [] as string[]);
      const newGaps = rescheduledPhotographers
        .filter((ph: any) => unresolvedPhotographers.includes(ph.name) || unresolvedPhotographers.includes(ph.id))
        .map((ph: any) => `photographer:${ph.email || ph.name || ph.id}`);
      if (newGaps.length > 0) {
        const merged = Array.from(new Set([...existingGaps, ...newGaps]));
        updates.mapping_gaps = JSON.stringify(merged);
        if (project.mapping_confidence === 'full') updates.mapping_confidence = 'partial';
      }
    }
  }

  // Capture Tonomo quoted price on reschedule events (same pattern as handleScheduled)
  const tonomoPrice = p.invoice_amount || p.order?.invoice_amount || p.totalPrice || p.order?.totalPrice || null;
  if (tonomoPrice != null) {
    updates.tonomo_quoted_price = Number(tonomoPrice);
  }

  if (startTime) {
    const hoursUntilShoot = (startTime - Date.now()) / 3600000;
    updates.urgent_review = hoursUntilShoot <= 24 && hoursUntilShoot > 0;
  }
  // Only flip to pending_review when the shoot date/time ACTUALLY changed.
  // Tonomo fires `rescheduled` for various appointment-level edits (photographer
  // swap, notes, re-confirms) even when the start_time is unchanged — without
  // this guard, every such ping pushes the project to pending_review with a
  // misleading "from 2026-04-22 to 2026-04-22" reason. See investigation on 4
  // stuck projects (18 Bilson Rd, 2/17-19 Gould St, 4 Hardy Pl, 36 Ward St).
  const normalizedPrevDate = normalizeShootDate(previousShootDate);
  const newDate = updates.shoot_date || null;
  const newTime = updates.shoot_time || null;
  const dateActuallyChanged = !!newDate && normalizedPrevDate !== newDate;
  const timeActuallyChanged = !!newTime && !!project.shoot_time && newTime !== project.shoot_time;
  if (ACTIVE_STAGES.includes(project.status) && (dateActuallyChanged || timeActuallyChanged)) {
    updates.pre_revision_stage = project.status;
    updates.status = 'pending_review';
    updates.pending_review_type = 'rescheduled';
    const fromLabel = normalizedPrevDate || previousShootDate || 'unknown';
    const toLabel = newDate || 'unknown';
    updates.pending_review_reason = `Shoot rescheduled in Tonomo from ${fromLabel} to ${toLabel} — please confirm`;
  }

  await entities.Project.update(project.id, updates);

  // Recalculate task deadlines relative to new shoot date
  if (updates.shoot_date) {
    invokeFunction('calculateProjectTaskDeadlines', {
      project_id: project.id,
      trigger_event: 'rescheduled',
    }).catch((err: any) => console.warn('Task deadline recalc after reschedule failed:', err?.message));
  }

  if (eventId && startTime) {
    try {
      const projectCalEvents = await entities.CalendarEvent.filter({ project_id: project.id }, '-start_time', 100).catch(() => []);
      const appointmentEvent = projectCalEvents.find(
        (ev: any) => ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId
      );
      if (appointmentEvent) {
        const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
        const calUpdates: Record<string, any> = {
          start_time: new Date(startTime).toISOString(),
          end_time: endTime ? new Date(endTime).toISOString() : null,
        };
        if (updates.photographer_id) calUpdates.owner_user_id = updates.photographer_id;
        if (updates.agent_id) calUpdates.agent_id = updates.agent_id;
        if (updates.agency_id) calUpdates.agency_id = updates.agency_id;
        await entities.CalendarEvent.update(appointmentEvent.id, calUpdates);
      } else {
        // Guard against the cancel-race ghost bug (see migration 094):
        // Only recreate a calendar event if this appointment is still tracked
        // on the project and the order hasn't been cancelled at the order
        // level. Prevents a 'rescheduled' payload that races against a
        // 'canceled' from resurrecting the calendar row.
        const trackedAppointmentIds = Array.isArray(project.tonomo_appointment_ids)
          ? project.tonomo_appointment_ids
          : (typeof project.tonomo_appointment_ids === 'string'
              ? (() => { try { return JSON.parse(project.tonomo_appointment_ids); } catch { return []; } })()
              : []);
        const appointmentStillTracked = trackedAppointmentIds.includes(eventId);
        const orderCancelled = (p.order?.orderStatus || p.orderStatus) === 'cancelled';
        // Cancel-race guard #2: if a 'canceled' webhook for this exact event
        // is already queued (but hasn't processed yet — FIFO by created_at
        // isn't clock-monotonic across Tonomo bursts), don't resurrect the
        // calendar event. Prior guard only covered already-processed cancels.
        const cancelPending = await hasPendingCancelForEvent(entities, orderId, eventId);

        if (appointmentStillTracked && !orderCancelled && !cancelPending) {
          const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
          await entities.CalendarEvent.create({
            title: project.title || `Shoot — ${orderId}`,
            description: `Tonomo appointment (created during reschedule) for order ${orderId}`,
            start_time: new Date(startTime).toISOString(),
            end_time: endTime ? new Date(endTime).toISOString() : null,
            location: project.property_address || '',
            google_event_id: eventId,
            tonomo_appointment_id: eventId,
            project_id: project.id,
            activity_type: 'shoot',
            is_synced: false,
            is_done: false,
            auto_linked: true,
            link_source: 'tonomo_webhook',
            link_confidence: 'exact',
            event_source: 'tonomo',
          });
        } else {
          console.log(`[rescheduled] Skipping calendar-event recreate for appointment ${eventId}: tracked=${appointmentStillTracked}, orderCancelled=${orderCancelled}, cancelPending=${cancelPending}`);
        }
      }
    } catch (calErr: any) {
      console.error('CalendarEvent reschedule update failed (non-fatal):', calErr.message);
    }
  }
  await writeAudit(entities, {
    action: 'rescheduled', entity_type: 'Project', entity_id: project.id, operation: 'updated',
    tonomo_order_id: orderId, tonomo_event_id: eventId,
    notes: `Rescheduled from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'}. Urgent: ${updates.urgent_review ?? false}`,
  });

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_rescheduled',
    description: `Shoot rescheduled in Tonomo from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'}.${updates.urgent_review ? ' Shoot is within 24 hours.' : ''}`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'rescheduled',
    metadata: { previous_date: previousShootDate, new_date: updates.shoot_date },
  });

  const reschedProjectName = project.title || project.property_address || 'Project';
  fireRoleNotif(entities, ['photographer', 'project_owner'], {
    type: 'booking_rescheduled',
    category: 'tonomo',
    severity: updates.urgent_review ? 'critical' : 'info',
    title: `Shoot rescheduled — ${reschedProjectName}`,
    message: `Rescheduled from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'}.${updates.urgent_review ? ' Within 24 hours.' : ''}`,
    projectId: project.id,
    projectName: reschedProjectName,
    ctaLabel: 'View Project',
    source: 'tonomo',
    idempotencyKey: `rescheduled:${orderId}:${updates.shoot_date}`,
  }, project).catch(() => {});

  return { summary: `Rescheduled project for order ${orderId}` };
}
