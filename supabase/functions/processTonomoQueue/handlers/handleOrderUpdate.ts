import { invokeFunction, getAdminClient } from '../../_shared/supabase.ts';
import { ACTIVE_STAGES } from '../types.ts';
import {
  deduplicateProjectItems,
  resolveProductsFromTiers,
  loadMappingTable,
  findProjectByOrderId,
  safeJsonParse,
  writeAudit,
  writeProjectActivity,
} from '../utils.ts';
import { handleScheduled } from './handleScheduled.ts';

/**
 * Fallback: try to find a project by appointment ID.
 * Payment webhooks from Tonomo often send the appointment ID as orderId,
 * not the order-level ID that was stored when the project was created.
 * NOTE: tonomo_appointment_ids is a TEXT column storing a JSON array string,
 * so we use ilike for text matching (not JSONB contains).
 */
async function findProjectByAppointmentId(appointmentId: string): Promise<any> {
  if (!appointmentId) return null;
  try {
    const admin = getAdminClient();
    const { data } = await admin
      .from('projects')
      .select('*')
      .ilike('tonomo_appointment_ids', `%${appointmentId}%`)
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch (err: any) {
    console.warn(`findProjectByAppointmentId failed for ${appointmentId}:`, err?.message);
    return null;
  }
}

export async function handleOrderUpdate(entities: any, orderId: string, p: any, paymentOnly = false) {
  // Try primary lookup by order ID, then fallback to appointment ID
  let project = await findProjectByOrderId(entities, orderId);
  let matchedBy = 'order_id';

  if (!project) {
    // Fallback: the orderId might actually be an appointment ID
    project = await findProjectByAppointmentId(orderId);
    if (project) matchedBy = 'appointment_id';
  }

  if (!project) {
    // ── Payment-only events: NEVER create a project ─────────────────────
    if (paymentOnly) {
      await writeAudit(entities, {
        action: 'payment_updated', entity_type: 'Project', entity_id: null,
        operation: 'skipped', tonomo_order_id: orderId,
        notes: `Payment update for unknown order "${orderId}" — no matching project found. Skipping (payment events never create projects).`,
      });
      return { summary: `Skipped payment update — no project for ${orderId}`, skipped: true };
    }

    // GUARD: If orderId matches the event/appointment ID, refuse to create.
    const eventId = p.id;
    const isInvoiceId = eventId && (eventId === p.invoiceId || p.entityTypeName === 'OrderEntity' || p.orderId === eventId);
    if (eventId && orderId === eventId && !isInvoiceId) {
      await writeAudit(entities, {
        action: 'booking_created_or_changed', entity_type: 'Project', entity_id: null,
        operation: 'skipped', tonomo_order_id: orderId,
        notes: `orderId "${orderId}" matches event ID — refusing to create from handleOrderUpdate`,
      });
      return { summary: `Skipped — orderId ${orderId} is an event ID`, skipped: true };
    }

    // STRICT: Only create if the payload looks like a genuine new booking
    const orderName = p.order?.orderName || p.orderName || null;
    const address = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address || null;
    const hasServices = (p.order?.services_a_la_cart || p.services_a_la_cart || p.order?.services || p.services || []).length > 0;
    const hasBookingFlow = !!(p.order?.bookingFlow || p.bookingFlow);
    const hasAppointment = !!(p.when?.start_time);

    if ((!orderName && !address) || (!hasServices && !hasBookingFlow && !hasAppointment)) {
      await writeAudit(entities, {
        action: 'booking_created_or_changed', entity_type: 'Project', entity_id: null,
        operation: 'skipped', tonomo_order_id: orderId,
        notes: `Insufficient data to create project. name=${!!orderName}, address=${!!address}, services=${hasServices}, flow=${hasBookingFlow}, appointment=${hasAppointment}`,
      });
      return { summary: `Skipped order update for ${orderId} — insufficient data to create project`, skipped: true };
    }
    return handleScheduled(entities, orderId, p, 'booking_created_or_changed');
  }

  const incomingStatus = p.orderStatus || p.order?.orderStatus;
  if (project.status === 'cancelled' && incomingStatus === 'cancelled') {
    return { summary: `Skipped order update for cancelled project ${orderId}`, skipped: true };
  }

  // Lifecycle reversal: if project is cancelled/delivered but incoming status is active, route to pending_review
  const isCancelledOrDelivered = project.status === 'cancelled' || project.status === 'delivered' ||
    project.tonomo_lifecycle_stage === 'cancelled' || project.pending_review_type === 'cancellation';
  if (isCancelledOrDelivered && incomingStatus && incomingStatus !== 'cancelled' && incomingStatus !== 'complete') {
    await entities.Project.update(project.id, {
      status: 'pending_review',
      pre_revision_stage: project.status,
      pending_review_type: 'restoration',
      pending_review_reason: `Order update received for ${project.status} project — incoming status: ${incomingStatus}. Please review and re-approve.`,
      tonomo_lifecycle_stage: 'active',
    });
    await writeAudit(entities, {
      action: 'booking_created_or_changed', entity_type: 'Project', entity_id: project.id,
      operation: 'updated', tonomo_order_id: orderId,
      notes: `Lifecycle reversal in handleOrderUpdate: ${project.status} → pending_review (restoration). Incoming status: ${incomingStatus}`,
    });
    return { summary: `Project ${orderId} moved to pending_review (restoration from handleOrderUpdate)` };
  }

  const overriddenFields = safeJsonParse(project.manually_overridden_fields, [] as string[]);
  const updates: Record<string, any> = {};
  const reviewReasons: string[] = [];

  const servicesA = p.services_a_la_cart || p.order?.services_a_la_cart || [];
  const servicesB = p.services || p.order?.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);
  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || []).map((t: any) => ({ name: t.serviceName, selected: t.selected?.name }));

  if (!overriddenFields.includes('tonomo_raw_services')) {
    if (ACTIVE_STAGES.includes(project.status) && services.length > 0) {
      const prev = safeJsonParse(project.tonomo_raw_services, [] as string[]);
      const added = services.filter((s: string) => !prev.includes(s));
      const removed = prev.filter((s: string) => !services.includes(s));
      if (added.length > 0 || removed.length > 0) reviewReasons.push(`Services changed during active production${added.length ? ` — added: ${added.join(', ')}` : ''}${removed.length ? ` — removed: ${removed.join(', ')}` : ''} — please confirm billing`);
    }
    updates.tonomo_raw_services = JSON.stringify(services);
  }
  if (!overriddenFields.includes('tonomo_service_tiers')) updates.tonomo_service_tiers = JSON.stringify(tiers);

  const orderDeliverablePath = p.deliverable_path || p.order?.deliverable_path;
  if (orderDeliverablePath && !overriddenFields.includes('tonomo_deliverable_path')) {
    updates.tonomo_deliverable_path = orderDeliverablePath;
  }
  const orderDeliverableLink = p.deliverable_link || p.order?.deliverable_link;
  if (orderDeliverableLink && !overriddenFields.includes('tonomo_deliverable_link')) {
    updates.tonomo_deliverable_link = orderDeliverableLink;
  }

  const incomingStatusBCC = p.orderStatus || p.order?.orderStatus;
  if (incomingStatusBCC) {
    const wasRestored = project.tonomo_order_status === 'cancelled' && incomingStatusBCC !== 'cancelled';
    updates.tonomo_order_status = incomingStatusBCC;
    if (wasRestored) {
      reviewReasons.push('Order restored in Tonomo after cancellation — please re-confirm all details');
      updates.pending_review_type = 'restoration';
      updates.tonomo_lifecycle_stage = 'restored';
      updates.is_archived = false;
      updates.archived_at = null;
      if (project.status === 'cancelled') {
        updates.status = 'pending_review';
        updates.pre_revision_stage = 'cancelled';
        updates.pending_review_reason = 'Booking restored in Tonomo after cancellation. All details may have changed — please review and re-approve to re-enter workflow.';
      }
    }
  }

  const rawTiersBCC = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  if (rawTiersBCC.length > 0 && !overriddenFields.includes('products')) {
    const allMappingsBCC = await loadMappingTable(entities);
    const { autoProducts: newProd, autoPackages: newPkg, mappingGaps: newGapsBCC } =
      await resolveProductsFromTiers(entities, rawTiersBCC, allMappingsBCC);
    if (newProd.length > 0 || newPkg.length > 0) {
      const dedupedBCC = deduplicateProjectItems(newProd, newPkg,
        await entities.Product.list(null, 500).catch(() => []),
        await entities.Package.list(null, 200).catch(() => [])
      );
      updates.products = dedupedBCC.products;
      updates.packages = dedupedBCC.packages;
      updates.products_auto_applied = true;
      updates.products_needs_recalc = true;
      updates.products_mapping_gaps = JSON.stringify(newGapsBCC.map((g: any) => g.serviceName));
    }
  }

  if (!overriddenFields.includes('tonomo_package')) updates.tonomo_package = p.package?.name || p.order?.package?.name || project.tonomo_package;
  if (!overriddenFields.includes('tonomo_video_project')) updates.tonomo_video_project = p.videoProject ?? project.tonomo_video_project;
  if (!overriddenFields.includes('tonomo_invoice_amount')) updates.tonomo_invoice_amount = p.invoice_amount ? parseFloat(p.invoice_amount) : project.tonomo_invoice_amount;
  if (!overriddenFields.includes('tonomo_payment_status')) updates.tonomo_payment_status = p.paymentStatus || project.tonomo_payment_status;

  // Capture Tonomo quoted price on order update events (same pattern as handleScheduled)
  const tonomoPrice = p.totalPrice || p.order?.totalPrice || p.order?.invoice_amount || p.invoice_amount || null;
  if (tonomoPrice != null) {
    updates.tonomo_quoted_price = Number(tonomoPrice);
  }

  // Sync Tonomo payment status to main payment_status field
  const incomingPaymentRaw = p.paymentStatus || project.tonomo_payment_status;
  if (incomingPaymentRaw && !overriddenFields.includes('payment_status')) {
    const lower = incomingPaymentRaw.toLowerCase().trim();
    const mappedPayment = lower === 'paid' ? 'paid'
      : (lower === 'unpaid' || lower === 'pending') ? 'unpaid'
      : lower === 'partial' ? 'partial'
      : null;
    if (mappedPayment) {
      updates.payment_status = mappedPayment;
    }
  }

  const startTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  if (startTime && !overriddenFields.includes('shoot_date')) {
    updates.shoot_date = new Date(startTime).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    updates.shoot_time = new Date(startTime).toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  if (p.deliverablesLinks?.length > 0) {
    updates.tonomo_delivered_files = JSON.stringify(p.deliverablesLinks);
    if (p.deliverable_link) updates.tonomo_deliverable_link = p.deliverable_link;
  }

  if (reviewReasons.length > 0) {
    if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;
    updates.status = 'pending_review';
    updates.pending_review_reason = reviewReasons.join(' | ');
  }

  if (Object.keys(updates).length) await entities.Project.update(project.id, updates);

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

  // Sync calendar event time when shoot date changes
  if (updates.shoot_date || updates.shoot_time) {
    try {
      const calEvents = await entities.CalendarEvent.filter({ project_id: project.id }, null, 50);
      const tonomoEvent = calEvents.find((ev: any) => ev.event_source === 'tonomo' && !ev.is_done);
      if (tonomoEvent && updates.shoot_date) {
        const timeStr = updates.shoot_time || project.shoot_time || '09:00';
        // Determine correct Sydney offset: AEDT (+11) first Sun in Oct → first Sun in Apr, else AEST (+10)
        const dateStr = updates.shoot_date || project.shoot_date;
        const month = new Date(dateStr + 'T00:00:00Z').getUTCMonth(); // 0-indexed
        // Rough DST check: Oct(9)–Mar(2) = AEDT(+11), Apr(3)–Sep(8) = AEST(+10)
        const sydneyOffset = (month >= 9 || month <= 2) ? '+11:00' : '+10:00';
        const startDt = new Date(`${dateStr}T${timeStr}:00${sydneyOffset}`);
        await entities.CalendarEvent.update(tonomoEvent.id, {
          start_time: startDt.toISOString(),
        }).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }

  await writeAudit(entities, {
    action: 'booking_created_or_changed', entity_type: 'Project', entity_id: project.id,
    operation: Object.keys(updates).length ? 'updated' : 'no_changes',
    tonomo_order_id: orderId,
    notes: `Services: ${services.length}. Invoice: $${p.invoice_amount ?? 'unchanged'}. OrderStatus: ${incomingStatus || 'unchanged'}`,
  });

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_order_updated',
    description: `Order updated from Tonomo.${reviewReasons.length > 0 ? ` Review flags: ${reviewReasons.join('; ')}` : ' No review required.'} Services: ${services.length}. OrderStatus: ${incomingStatusBCC || 'unchanged'}.`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'booking_created_or_changed',
    metadata: {
      review_flags: reviewReasons,
      fields_updated: Object.keys(updates),
      services_count: services.length,
      order_status: incomingStatusBCC || null,
    },
  });

  if (updates.products || updates.packages) {
    invokeFunction('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch(() => { /* non-fatal */ });

    // Ensure pricing is recalculated when products change
    invokeFunction('recalculateProjectPricingServerSide', { project_id: project.id }).catch((err: any) => {
      console.error('Pricing recalc after order update failed (non-fatal):', err?.message);
    });
  }

  return { summary: `Order update applied for ${orderId}` };
}
