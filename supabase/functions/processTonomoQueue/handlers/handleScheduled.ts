import { invokeFunction } from '../../_shared/supabase.ts';
import { ACTIVE_STAGES } from '../types.ts';
import {
  trackAppointment,
  determineReviewType,
  stripAddressTail,
  extractSuburbFromAddress,
  resolveBookingFlowTier,
  resolveProjectTypeFromFlowType,
  detectBookingTypes,
  assignStaffToProjectFields,
  deduplicateProjectItems,
  resolveProductsFromTiers,
  resolveProductsFromWorkDays,
  resolveMappingsMulti,
  loadMappingTable,
  findProjectByOrderId,
  reconcileProductsPackagesAgainstLock,
  buildReviewReason,
  filterOverriddenFields,
  safeJsonParse,
  writeAudit,
  writeProjectActivity,
  fireAdminNotif,
  fireRoleNotif,
  safeList,
} from '../utils.ts';

export interface HandlerContext {
  queueRowId?: string | null;
  webhookLogId?: string | null;
  eventType?: string | null;
}

export async function handleScheduled(entities: any, orderId: string, p: any, originAction = 'scheduled', ctx: HandlerContext = {}) {
  const eventId = p.id;
  const orderName = p.order?.orderName || p.orderName || 'Unknown order';
  const address = p.address?.formatted_address || p.property_address?.formatted_address || p.location || p.order?.property_address?.formatted_address || '';
  const addressLat = p.address?.lat || p.address?.latitude || p.property_address?.lat || p.property_address?.latitude || null;
  const addressLng = p.address?.lng || p.address?.longitude || p.property_address?.lng || p.property_address?.longitude || null;
  const photographers = p.photographers || [];
  const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;
  const rawStartTime = p.when?.start_time;
  const parsedStartTime = typeof rawStartTime === 'number' ? rawStartTime * 1000
    : typeof rawStartTime === 'string' ? Number(rawStartTime) * 1000
    : null;
  const startTime = parsedStartTime && !isNaN(parsedStartTime) ? parsedStartTime : null;
  const bookingFlowObj = p.order?.bookingFlow || null;
  const flowType = bookingFlowObj?.type || null;
  const isFirstOrder = p.isFirstOrder || p.order?.isFirstOrder || false;
  const brokerageCode = p.brokerage_code || p.order?.brokerage_code || null;

  const allMappings = await loadMappingTable(entities);

  // Pre-resolve agency from brokerage code so auto-created agents get agency_id
  let preResolvedAgencyId: string | null = null;
  if (brokerageCode) {
    try {
      const agencies = await entities.Agency.filter({ brokerage_code: brokerageCode }, null, 1);
      if (agencies?.[0]?.id) preResolvedAgencyId = agencies[0].id;
    } catch { /* non-fatal */ }
  }

  const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
  const servicesB = p.order?.services || p.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

  const { agentId, resolvedPhotographers, unresolvedPhotographers, mappingConfidence, mappingGaps } =
    await resolveMappingsMulti(entities, { agent, photographers, agencyId: preResolvedAgencyId }, allMappings);

  const serviceIds = p.serviceIds || [];
  const serviceAssignmentUncertain = serviceIds.length === 0 && services.length > 0;

  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || [])
    .map((t: any) => ({ name: t.serviceName, selected: t.selected?.name }));

  const existing = await findProjectByOrderId(entities, orderId);

  // GUARD: If orderId matches the event/appointment ID (p.id), it's not a real order ID.
  // This is a defensive check — the receiver should never pass p.id as orderId anymore,
  // but if it does (e.g. from old queue items), refuse to create a new project.
  // HOWEVER: On order-level payloads, p.id is the invoiceId (same as orderId), NOT an event ID.
  // Only skip when p.id is genuinely a calendar event ID, not an invoice/order ID.
  const isInvoiceId = eventId && (eventId === p.invoiceId || p.entityTypeName === 'OrderEntity' || p.orderId === eventId);
  if (!existing && eventId && orderId === eventId && !isInvoiceId) {
    await writeAudit(entities, {
      action: originAction, entity_type: 'Project', entity_id: null,
      operation: 'skipped', tonomo_order_id: orderId,
      notes: `orderId "${orderId}" matches the appointment event ID — refusing to create project. This is an appointment-level event, not a new booking.`,
    });
    return { summary: `Skipped — orderId ${orderId} is an event ID, not an order ID`, skipped: true };
  }

  // GUARD: Only track as appointment if eventId is a real appointment ID, not an order ID.
  // When booking_created_or_changed triggers handleScheduled, p.id is the ORDER ID which
  // looks like the appointment ID but isn't. Real appointment IDs come from scheduled/changed events.
  const isRealAppointmentId = eventId && eventId !== orderId;
  const { isNew: isNewAppointment, updatedIds: allAppointmentIds } = trackAppointment(
    existing?.tonomo_appointment_ids,
    isRealAppointmentId ? eventId : null
  );
  // Only flag as additional appointment when the project ALREADY EXISTS and already has appointments
  // For brand new projects, isNewAppointment is always true (empty array → new ID), which is NOT additional
  const existingAppointmentIds = safeJsonParse(existing?.tonomo_appointment_ids, [] as string[]);
  const isAdditionalAppointment = !!existing && isNewAppointment && existingAppointmentIds.length > 0;

  const lifecycleReversalDetected =
    existing && (
      existing.status === 'cancelled' ||
      existing.status === 'delivered' ||
      existing.tonomo_lifecycle_stage === 'cancelled' ||
      existing.pending_review_type === 'cancellation'
    );

  let staffAssignment: Record<string, any> = {};
  if (resolvedPhotographers.length > 0) {
    const bookingTypes = detectBookingTypes(services);
    staffAssignment = assignStaffToProjectFields(resolvedPhotographers, bookingTypes);
  }

  const rawTiers = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  const {
    autoProducts, autoPackages, mappingGaps: productMappingGaps, allConfirmed: allProductsMapped,
  } = await resolveProductsFromTiers(entities, rawTiers, allMappings);

  // Map Tonomo workDays (weekend/day-specific fees) to surcharge products
  const workDaysArr = p.order?.workDays || p.workDays || [];
  const { autoProducts: feeProducts, mappingGaps: feeGaps } =
    await resolveProductsFromWorkDays(entities, workDaysArr, allMappings);
  if (feeProducts.length > 0) autoProducts.push(...feeProducts);
  productMappingGaps.push(...feeGaps);

  const hasAutoProducts = autoProducts.length > 0 || autoPackages.length > 0;
  const productGapNames = productMappingGaps.map((g: any) => g.serviceName);

  const _settings = await safeList(entities, 'TonomoIntegrationSettings', 1);
  const _s = _settings?.[0];
  const autoApproveEnabled = _s?.auto_approve_enabled === true;
  const autoApproveOnImminent = _s?.auto_approve_on_imminent !== false;

  const { tier: flowTier, isUnmapped: flowUnmapped } = await resolveBookingFlowTier(entities, bookingFlowObj);
  const { projectTypeId, projectTypeName, isUnmapped: typeUnmapped } =
    await resolveProjectTypeFromFlowType(entities, flowType);

  const strippedAddress = stripAddressTail(address) || address;
  const projectSuburb = extractSuburbFromAddress(address);

  const sharedData: Record<string, any> = {
    title: strippedAddress,
    property_address: address,
    property_suburb: projectSuburb || null,
    ...(addressLat && { geocoded_lat: addressLat }),
    ...(addressLng && { geocoded_lng: addressLng }),
    ...(addressLat && { geocoded_at: new Date().toISOString() }),
    source: 'tonomo',
    tonomo_order_id: orderId,
    // Only write appointment-specific IDs when the eventId is a real appointment (not an order ID)
    ...(isRealAppointmentId && { tonomo_event_id: eventId }),
    ...(isRealAppointmentId && { tonomo_google_event_id: eventId }),
    tonomo_appointment_ids: JSON.stringify(allAppointmentIds),
    tonomo_raw_services: JSON.stringify(services),
    tonomo_service_tiers: JSON.stringify(tiers),
    tonomo_package: p.order?.package?.name || p.package?.name || null,
    tonomo_video_project: p.order?.videoProject ?? p.videoProject ?? null,
    tonomo_invoice_amount: p.order?.invoice_amount ?? p.invoice_amount ?? null,
    tonomo_payment_status: p.order?.paymentStatus || p.paymentStatus || null,
    tonomo_photographer_ids: JSON.stringify(photographers),
    tonomo_booking_flow: p.order?.bookingFlow?.name || null,
    tonomo_booking_flow_id: bookingFlowObj?.id || null,
    tonomo_is_twilight: p.isTwilight || false,
    tonomo_order_status: p.order?.orderStatus || null,
    tonomo_lifecycle_stage: 'active',
    is_first_order: isFirstOrder,
    tonomo_brokerage_code: brokerageCode || null,
    mapping_confidence: mappingConfidence,
    mapping_gaps: JSON.stringify([...mappingGaps, ...productMappingGaps.map((g: any) => `service:${g.serviceId}`)]),
    service_assignment_uncertain: serviceAssignmentUncertain,
    products_mapping_gaps: JSON.stringify(productGapNames),
    products_auto_applied: hasAutoProducts,
    products_needs_recalc: hasAutoProducts,
    pricing_tier: flowTier || 'standard',
    project_type_id: projectTypeId || null,
    project_type_name: projectTypeName || null,
  };

  // Store Tonomo quoted price for mismatch detection after pricing calc
  // Prefer invoice_amount (post-discount) over totalPrice (pre-discount)
  const tonomoPrice = p.invoice_amount || p.order?.invoice_amount || p.totalPrice || p.order?.totalPrice || null;
  if (tonomoPrice != null) {
    const parsed = Number(tonomoPrice);
    if (!isNaN(parsed) && parsed > 0) sharedData.tonomo_quoted_price = parsed;
  }

  if (flowUnmapped) sharedData._flow_unmapped = true;
  if (typeUnmapped) sharedData._type_unmapped = true;

  if (p.order?.deliverable_link) sharedData.tonomo_deliverable_link = p.order.deliverable_link;
  if (p.order?.deliverable_path) sharedData.tonomo_deliverable_path = p.order.deliverable_path;
  if (agentId) {
    sharedData.agent_id = agentId;
    // Resolve agency_id from the agent record, with fallback to Tonomo brokerage_obj
    try {
      const agentRecord = await entities.Agent.get(agentId);
      let agencyIdToUse: string | null = agentRecord?.current_agency_id || null;
      if (agentRecord?.name) sharedData.agent_name = agentRecord.name;

      // Fallback: if agent has no agency yet, try to resolve from payload's brokerage_obj
      if (!agencyIdToUse) {
        const brokerage = p.listingAgents?.[0]?.brokerage_obj || p.order?.listingAgents?.[0]?.brokerage_obj;
        const brokerageName = p.listingAgents?.[0]?.brokerage || p.order?.listingAgents?.[0]?.brokerage;
        if (brokerage?.id || brokerageName) {
          const allAgencies = await entities.Agency.list('-updated_date', 500).catch(() => []);
          const normalize = (s: string) => (s || '').toLowerCase().replace(/[-_\s]+/g, ' ').trim();
          const normBrokerageName = normalize(brokerageName || '');
          const match = normBrokerageName ? allAgencies.find((a: any) => {
            const aName = normalize(a.name || '');
            return aName === normBrokerageName || aName.includes(normBrokerageName) || normBrokerageName.includes(aName);
          }) : null;
          if (match) {
            agencyIdToUse = match.id;
            // Also backfill on the agent record for future use
            if (agentRecord && !agentRecord.current_agency_id) {
              await entities.Agent.update(agentId, {
                current_agency_id: match.id,
                current_agency_name: match.name,
              }).catch(() => {});
            }
          }
        }
      }

      if (agencyIdToUse) sharedData.agency_id = agencyIdToUse;
    } catch { /* non-fatal */ }
  }

  // Set denormalized name fields from resolved staff
  const staffNameMap: Record<string, string> = {};
  for (const rp of resolvedPhotographers) {
    if (rp.userId && rp.name) staffNameMap[rp.userId] = rp.name;
  }

  for (const [field, userId] of Object.entries(staffAssignment)) {
    if (userId) {
      sharedData[field] = userId;
      // Set corresponding _name field
      const nameField = field.replace('_id', '_name');
      if (staffNameMap[userId as string]) sharedData[nameField] = staffNameMap[userId as string];
      // Webhook staff are always real users, not teams
      const typeField = field.replace('_id', '_type');
      sharedData[typeField] = 'user';
    }
  }

  const canAutoApprove =
    autoApproveEnabled &&
    mappingConfidence === 'full' &&
    productGapNames.length === 0 &&
    unresolvedPhotographers.length === 0 &&
    !sharedData._type_unmapped &&
    !sharedData._flow_unmapped &&
    !lifecycleReversalDetected &&
    !isAdditionalAppointment &&
    (autoApproveOnImminent || !sharedData.urgent_review);

  // Cache for the reconciler path (used when updating an existing project
  // that may have a lock on products/packages).
  let allProdsSchedCache: any[] | null = null;
  let allPkgsSchedCache: any[] | null = null;
  let dedupedSched: { products: any[]; packages: any[] } | null = null;

  if (hasAutoProducts) {
    const [allProdsSched, allPkgsSched] = await Promise.all([
      entities.Product.list(null, 500).catch(() => []),
      entities.Package.list(null, 200).catch(() => []),
    ]);
    allProdsSchedCache = allProdsSched;
    allPkgsSchedCache = allPkgsSched;
    const deduped = deduplicateProjectItems(autoProducts, autoPackages, allProdsSched, allPkgsSched);
    dedupedSched = deduped;
    sharedData.products = deduped.products;
    sharedData.packages = deduped.packages;
  }

  if (startTime) {
    const shootDt = new Date(startTime);
    // Use Sydney-local date to avoid off-by-one: UTC midnight != Sydney midnight
    const sydneyDateStr = shootDt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // en-CA gives YYYY-MM-DD
    const shootTimeStr = shootDt.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    sharedData.shoot_time = shootTimeStr;

    if (!existing || !isAdditionalAppointment) {
      sharedData.shoot_date = sydneyDateStr;
    } else {
      const projectEvents = (await entities.CalendarEvent.filter({ project_id: existing.id }, '-start_time', 100).catch(() => []))
        .filter((ev: any) => !ev.is_done);
      const futureTimes = [
        startTime,
        ...projectEvents
          .map((ev: any) => {
            const t = ev.start_time ? new Date(ev.start_time.endsWith('Z') ? ev.start_time : ev.start_time + 'Z').getTime() : 0;
            return t > Date.now() ? t : 0;
          })
          .filter(Boolean),
      ].filter((t: number) => t > Date.now());

      const newDate = sydneyDateStr;
      const earliest = futureTimes.length > 0
        ? new Date(Math.min(...futureTimes)).toISOString().split('T')[0]
        : newDate;
      sharedData.shoot_date = earliest;
    }
  }

  if (startTime) {
    const hoursUntilShoot = (startTime - Date.now()) / 3600000;
    if (hoursUntilShoot <= 24 && hoursUntilShoot > 0) sharedData.urgent_review = true;
  }

  // 2026-04-20: Tonomo is authoritative for products/packages — always wins.
  // Migration 209 dropped manually_locked_product_ids / manually_locked_package_ids
  // columns, and stripped 'products'/'packages' entries from
  // manually_overridden_fields. The lock-aware gate this helper used to
  // implement is unreachable: no writer puts 'products'/'packages' into
  // overrides any more, and no reader consults per-line locks. Helper kept
  // as an identity pass-through so call sites don't need restructuring.
  function applyLockAwareProductUpdate(
    _targetProject: any,
    safeData: Record<string, any>,
    _extraReviewReasons: string[],
  ) {
    return { safeData, stashActivity: null as string | null };
  }

  // ── CREATE OR UPDATE PROJECT ────────────────────────────────────────────────
  let project;
  let operation;
  let scheduledStashActivity: string | null = null;

  if (!existing) {
    const autoStatus = sharedData.shoot_date ? 'scheduled' : 'to_be_scheduled';

    const createPayload = {
      ...sharedData,
      status: canAutoApprove ? autoStatus : 'pending_review',
      pending_review_type: canAutoApprove ? null : 'new_booking',
      pending_review_reason: canAutoApprove ? null : buildReviewReason(
        mappingConfidence, mappingGaps, serviceAssignmentUncertain, unresolvedPhotographers, productGapNames,
        sharedData._flow_unmapped || false, sharedData._type_unmapped || false
      ),
      auto_approved: canAutoApprove ? true : false,
      tonomo_deliverable_link: sharedData.tonomo_deliverable_link || null,
      tonomo_deliverable_path: sharedData.tonomo_deliverable_path || null,
    };

    try {
      project = await entities.Project.create(createPayload);
      operation = 'created';
    } catch (createErr: any) {
      // Unique constraint violation (23505) on tonomo_order_id — another request created it first.
      // Re-fetch the existing project and fall through to an update instead.
      const isDuplicate = createErr?.code === '23505' ||
        createErr?.message?.includes('duplicate key') ||
        createErr?.message?.includes('unique constraint') ||
        createErr?.message?.includes('uq_projects_tonomo_order_id');
      if (!isDuplicate) throw createErr;

      console.log(`[idempotency] Duplicate tonomo_order_id=${orderId} — falling back to update`);
      const reFetched = await findProjectByOrderId(entities, orderId);
      if (!reFetched) throw new Error(`Unique constraint hit for ${orderId} but re-fetch returned null`);

      const overriddenFields = safeJsonParse(reFetched.manually_overridden_fields, [] as string[]);
      let safeData = filterOverriddenFields(sharedData, overriddenFields);
      const extraReasons: string[] = [];
      const lockAware = applyLockAwareProductUpdate(reFetched, safeData, extraReasons);
      safeData = lockAware.safeData;
      if (lockAware.stashActivity) scheduledStashActivity = lockAware.stashActivity;
      if (reFetched.status !== 'pending_review') {
        delete safeData.status;
        delete safeData.pending_review_reason;
        delete safeData.pending_review_type;
      }
      if (extraReasons.length > 0 && reFetched.status !== 'pending_review') {
        safeData.status = 'pending_review';
        safeData.pre_revision_stage = reFetched.status;
        safeData.pending_review_reason = extraReasons.join(' | ');
      }
      await entities.Project.update(reFetched.id, safeData);
      project = { ...reFetched, ...safeData };
      operation = 'updated_after_race';
    }

  } else if (lifecycleReversalDetected) {
    const reviewType = determineReviewType(existing.status, existing.tonomo_lifecycle_stage, isAdditionalAppointment, originAction);
    const reversalReason = existing.status === 'cancelled'
      ? `Booking restored in Tonomo — new appointment scheduled after cancellation. Previous status: cancelled. Please review and re-approve to re-enter workflow.`
      : `New appointment added to a delivered booking. Previous status: delivered. Please review — this may indicate a re-shoot or correction booking.`;

    const overriddenFields = safeJsonParse(existing.manually_overridden_fields, [] as string[]);
    let safeData = filterOverriddenFields(sharedData, overriddenFields);
    const extraReasons: string[] = [];
    const lockAware = applyLockAwareProductUpdate(existing, safeData, extraReasons);
    safeData = lockAware.safeData;
    if (lockAware.stashActivity) scheduledStashActivity = lockAware.stashActivity;

    await entities.Project.update(existing.id, {
      ...safeData,
      status: 'pending_review',
      pending_review_type: reviewType,
      pending_review_reason: [reversalReason, ...extraReasons].filter(Boolean).join(' | '),
      pre_revision_stage: existing.status,
      tonomo_lifecycle_stage: 'restored',
      is_archived: false,
      archived_at: null,
    });
    project = { ...existing, ...safeData };
    operation = 'lifecycle_reversal';

  } else if (isAdditionalAppointment) {
    const overriddenFields = safeJsonParse(existing.manually_overridden_fields, [] as string[]);
    let safeData = filterOverriddenFields(sharedData, overriddenFields);
    const extraReasons: string[] = [];
    const lockAware = applyLockAwareProductUpdate(existing, safeData, extraReasons);
    safeData = lockAware.safeData;
    if (lockAware.stashActivity) scheduledStashActivity = lockAware.stashActivity;

    if (ACTIVE_STAGES.includes(existing.status)) {
      safeData.status = 'pending_review';
      safeData.pending_review_type = 'additional_appointment';
      safeData.pending_review_reason = [
        `Additional appointment added to booking: ${new Date(startTime!).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short' })}${photographers[0] ? ` — ${photographers[0].name}` : ''}. Review and re-approve.`,
        ...extraReasons,
      ].filter(Boolean).join(' | ');
      safeData.pre_revision_stage = existing.status;
    } else {
      delete safeData.status;
      if (extraReasons.length > 0) {
        safeData.status = 'pending_review';
        safeData.pre_revision_stage = existing.status;
        safeData.pending_review_reason = extraReasons.join(' | ');
      }
    }

    await entities.Project.update(existing.id, safeData);
    project = { ...existing, ...safeData };
    operation = 'additional_appointment';

  } else {
    const overriddenFields = safeJsonParse(existing.manually_overridden_fields, [] as string[]);
    let safeData = filterOverriddenFields(sharedData, overriddenFields);
    const extraReasons: string[] = [];
    const lockAware = applyLockAwareProductUpdate(existing, safeData, extraReasons);
    safeData = lockAware.safeData;
    if (lockAware.stashActivity) scheduledStashActivity = lockAware.stashActivity;

    if (existing.status !== 'pending_review') {
      delete safeData.status;
      delete safeData.pending_review_reason;
      delete safeData.pending_review_type;
      if (extraReasons.length > 0) {
        safeData.status = 'pending_review';
        safeData.pre_revision_stage = existing.status;
        safeData.pending_review_reason = extraReasons.join(' | ');
      }
    } else {
      safeData.pending_review_reason = [
        buildReviewReason(
          mappingConfidence, mappingGaps, serviceAssignmentUncertain, unresolvedPhotographers, productGapNames,
          sharedData._flow_unmapped || false, sharedData._type_unmapped || false
        ),
        ...extraReasons,
      ].filter(Boolean).join(' | ');
    }

    await entities.Project.update(existing.id, safeData);
    project = { ...existing, ...safeData };
    operation = 'updated';
  }

  // ── CREATE CALENDAR EVENT FOR THIS APPOINTMENT ──────────────────────────────
  if (eventId && startTime) {
    try {
      const existingCalEvents = await entities.CalendarEvent.filter({ project_id: project.id }, '-start_time', 100).catch(() => []);
      const alreadyExists = existingCalEvents.some(
        (ev: any) => ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId
      );

      if (!alreadyExists) {
        const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
        const appointmentOwner = staffAssignment.project_owner_id || null;

        await entities.CalendarEvent.create({
          title: orderName,
          description: `Tonomo appointment for order ${orderId}`,
          start_time: new Date(startTime).toISOString(),
          end_time: endTime ? new Date(endTime).toISOString() : null,
          location: address,
          google_event_id: eventId,
          tonomo_appointment_id: eventId,
          project_id: project.id,
          agent_id: agentId || null,
          agency_id: sharedData.agency_id || null,
          owner_user_id: appointmentOwner,
          attendees: JSON.stringify(photographers.map((ph: any) => ({
            name: ph.name, email: ph.email, tonomoId: ph.id
          }))),
          activity_type: 'shoot',
          is_synced: false,
          is_done: false,
          auto_linked: true,
          link_source: 'tonomo_webhook',
          link_confidence: 'exact',
          event_source: 'tonomo',
          calendar_account: photographers[0]?.email || 'tonomo',
        });
      } else {
        const toUpdate = existingCalEvents.find(
          (ev: any) => ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId
        );
        if (toUpdate) {
          const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
          await entities.CalendarEvent.update(toUpdate.id, {
            start_time: new Date(startTime).toISOString(),
            end_time: endTime ? new Date(endTime).toISOString() : null,
            project_id: project.id,
            event_source: 'tonomo',
          });
        }
      }
    } catch (calErr: any) {
      console.error('CalendarEvent creation failed (non-fatal):', calErr.message);
    }
  }

  await writeAudit(entities, {
    action: originAction,
    entity_type: 'Project',
    entity_id: project.id,
    operation,
    tonomo_order_id: orderId,
    tonomo_event_id: eventId,
    notes: [
      `Photographers: ${photographers.map((ph: any) => ph.name).join(', ') || 'none'}`,
      `Unresolved: ${unresolvedPhotographers.join(', ') || 'none'}`,
      `Agent: ${agent?.displayName || 'none'}`,
      `Confidence: ${mappingConfidence}`,
      `Gaps: ${[...mappingGaps, ...productGapNames].join(', ') || 'none'}`,
      `Additional appointment: ${isAdditionalAppointment}`,
      `Lifecycle reversal: ${lifecycleReversalDetected}`,
      `Products applied: ${autoProducts.length} products, ${autoPackages.length} packages`,
    ].join(' | '),
  });

  if (scheduledStashActivity) {
    await writeProjectActivity(entities, {
      project_id: project.id,
      project_title: project.title || project.property_address || '',
      action: project.tonomo_pending_delta ? 'tonomo_delta_stashed' : 'tonomo_delta_auto_merged',
      description: scheduledStashActivity,
      tonomo_order_id: orderId,
      tonomo_event_type: originAction,
      metadata: {
        queue_row_id: ctx.queueRowId || null,
        webhook_log_id: ctx.webhookLogId || null,
      },
    });
    if (project.tonomo_pending_delta) {
      fireRoleNotif(entities, ['project_owner', 'master_admin'], {
        type: 'tonomo_delta_pending_review',
        category: 'tonomo',
        severity: 'warning',
        title: `Tonomo delta needs review — ${project.title || project.property_address || 'Project'}`,
        message: `Tonomo updated products/packages but the project has a manual-edit lock. Review and apply/dismiss.`,
        projectId: project.id,
        projectName: project.title || project.property_address || 'Project',
        ctaLabel: 'Review Delta',
        source: 'tonomo',
        idempotencyKey: `tonomo_delta:${orderId}:${new Date().toISOString().split('T')[0]}`,
      }, project).catch(() => {});
    }
  }

  // Structured before/after for audit trail. Only included when products or
  // packages actually changed — keeps the activity feed signal-heavy.
  // 2026-04-20: closes the Tonomo-CRUD audit gap. writeProjectActivity now
  // accepts `previous_state` + `new_state` and writes them into the jsonb
  // columns on project_activities so history is queryable, not just
  // human-readable.
  const preUpdateProducts = JSON.parse(JSON.stringify(project?.products || []));
  const preUpdatePackages = JSON.parse(JSON.stringify(project?.packages || []));
  const postUpdateProducts = dedupedSched?.products ?? sharedData?.products ?? project?.products ?? [];
  const postUpdatePackages = dedupedSched?.packages ?? sharedData?.packages ?? project?.packages ?? [];
  const itemsChanged = JSON.stringify(preUpdateProducts) !== JSON.stringify(postUpdateProducts) ||
                       JSON.stringify(preUpdatePackages) !== JSON.stringify(postUpdatePackages);

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || project.property_address || '',
    action: operation === 'created' ? 'tonomo_booking_created' : 'tonomo_booking_updated',
    description: operation === 'created'
      ? `Project created from Tonomo booking. Order: ${orderId}. Mapping confidence: ${mappingConfidence}.${isAdditionalAppointment ? ' Additional appointment added.' : ''}${lifecycleReversalDetected ? ' Lifecycle reversal detected.' : ''}`
      : `Project updated from Tonomo webhook (${originAction}). Order: ${orderId}.`,
    tonomo_order_id: orderId,
    tonomo_event_type: originAction,
    previous_state: itemsChanged ? { products: preUpdateProducts, packages: preUpdatePackages } : null,
    new_state: itemsChanged ? { products: postUpdateProducts, packages: postUpdatePackages } : null,
    changed_fields: itemsChanged ? [{
      field: 'products_and_packages',
      products_before_count: preUpdateProducts.length,
      products_after_count: (postUpdateProducts as any[]).length,
      packages_before_count: preUpdatePackages.length,
      packages_after_count: (postUpdatePackages as any[]).length,
    }] : [],
    metadata: {
      mapping_confidence: mappingConfidence,
      mapping_gaps: mappingGaps,
      unresolved_photographers: unresolvedPhotographers,
      product_gaps: productGapNames,
      is_additional_appointment: isAdditionalAppointment,
      lifecycle_reversal: lifecycleReversalDetected,
      photographer_count: photographers.length,
      resolved_photographer_count: resolvedPhotographers.length,
    },
  });

  // Always apply role defaults on new/updated projects — regardless of auto-approve status
  // Role defaults fill empty slots with configured fallback users/teams from Settings
  if (project?.id) {
    invokeFunction('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch((err: any) => {
      console.warn('applyProjectRoleDefaults failed (non-fatal):', err?.message);
    });
  }

  // If auto-approved, fire additional side effects (pricing, stage change, notifications)
  if (canAutoApprove && project?.id) {
    const autoStatus = sharedData.shoot_date ? 'scheduled' : 'to_be_scheduled';

    // Ensure pricing is calculated even if applyProjectRoleDefaults skips task generation
    if (hasAutoProducts) {
      invokeFunction('recalculateProjectPricingServerSide', { project_id: project.id }).catch((err: any) => {
        console.error('Pricing calculation after auto-approve failed (non-fatal):', err?.message);
      });
    }

    // Only fire stage change for newly created projects, not race-condition updates
    if (operation === 'created') {
      invokeFunction('trackProjectStageChange', {
        projectId: project.id,
        old_data: { status: 'pending_review' },
        actor_id: null,
        actor_name: 'Auto-Approve',
      }).catch(() => {});
    }

    const notifProjectName = sharedData.title || address;
    fireAdminNotif(entities, {
      type: 'booking_auto_approved',
      category: 'tonomo',
      severity: 'info',
      title: `Auto-approved — ${notifProjectName}`,
      message: `Full-confidence booking automatically approved and moved to ${autoStatus.replace(/_/g, ' ')}.`,
      projectId: project.id,
      projectName: notifProjectName,
      ctaLabel: 'View Project',
      source: 'auto_approve',
      idempotencyKeySuffix: `auto_approved:${orderId}`,
    }).catch(() => {});

    await writeProjectActivity(entities, {
      project_id: project.id,
      project_title: project.title || address,
      action: 'tonomo_booking_created',
      description: `Project auto-approved (full confidence mapping, all fields resolved). Status: ${autoStatus.replace(/_/g, ' ')}.`,
      tonomo_order_id: orderId,
      tonomo_event_type: 'auto_approved',
      metadata: { auto_approved: true, mapping_confidence: mappingConfidence },
    });
  }

  // Fire notifications (non-blocking)
  const notifProjectId = project.id;
  const notifProjectName = strippedAddress || address;
  if (notifProjectId) {
    const isNewBooking = !existing;
    const hasUrgent = sharedData.urgent_review;
    const hasMappingGaps = productGapNames.length > 0 || mappingGaps.length > 0;
    const noPhotographer = unresolvedPhotographers.length > 0 || !sharedData.photographer_id;

    // Only send "pending review" notification if NOT auto-approved (avoid double notification)
    if (!canAutoApprove) {
      fireAdminNotif(entities, {
        type: 'booking_arrived_pending_review',
        category: 'tonomo',
        severity: hasUrgent ? 'critical' : 'info',
        title: hasUrgent ? `Urgent booking — ${notifProjectName}` : `New booking arrived — ${notifProjectName}`,
        message: `${isNewBooking ? 'New Tonomo booking' : 'Updated booking'} is pending review.${hasUrgent ? ' Shoot is within 24 hours.' : ''}`,
        projectId: notifProjectId,
        projectName: notifProjectName,
        ctaLabel: 'Review Booking',
        source: 'tonomo',
        idempotencyKey: `booking_arrived:${orderId}:${new Date().toISOString().split('T')[0]}`,
      }).catch(() => {});
    }

    if (hasMappingGaps) {
      fireAdminNotif(entities, {
        type: 'booking_mapping_gaps',
        category: 'tonomo',
        severity: 'warning',
        title: `Mapping gaps — ${notifProjectName}`,
        message: `${productGapNames.length} unmapped service(s): ${productGapNames.slice(0,3).join(', ')}${productGapNames.length > 3 ? '...' : ''}. Products not applied.`,
        projectId: notifProjectId,
        projectName: notifProjectName,
        ctaLabel: 'Fix Mappings',
        source: 'tonomo',
        idempotencyKey: `mapping_gaps:${orderId}`,
      }).catch(() => {});
    }

    if (noPhotographer) {
      fireAdminNotif(entities, {
        type: 'booking_no_photographer',
        category: 'tonomo',
        severity: 'warning',
        title: `No photographer assigned — ${notifProjectName}`,
        message: `Booking arrived but no photographer could be resolved. Manual assignment required.`,
        projectId: notifProjectId,
        projectName: notifProjectName,
        ctaLabel: 'Assign Photographer',
        source: 'tonomo',
        idempotencyKey: `no_photographer:${orderId}`,
      }).catch(() => {});
    }

    if (sharedData._flow_unmapped) {
      fireAdminNotif(entities, {
        type: 'booking_flow_unmapped',
        category: 'tonomo',
        severity: 'warning',
        title: `New booking flow — map it to a pricing tier`,
        message: `Booking flow "${sharedData.tonomo_booking_flow || 'Unknown'}" has no pricing tier mapping. Defaulting to Standard.`,
        source: 'tonomo',
        ctaLabel: 'Map It',
        idempotencyKey: `flow_unmapped:${sharedData.tonomo_booking_flow_id || orderId}`,
      }).catch(() => {});
    }

    if (sharedData._type_unmapped) {
      fireAdminNotif(entities, {
        type: 'booking_type_unmapped',
        category: 'tonomo',
        severity: 'warning',
        title: `New booking flow type — map it to a project type`,
        message: `Flow type "${bookingFlowObj?.type || 'unknown'}" has no project type mapping. Project type unset.`,
        source: 'tonomo',
        ctaLabel: 'Map It',
        idempotencyKey: `type_unmapped:${bookingFlowObj?.type || orderId}`,
      }).catch(() => {});
    }
  }

  // Trigger role defaults for existing non-pending_review projects
  const willBePendingReview = (project.status === 'pending_review') || lifecycleReversalDetected || (isAdditionalAppointment && ACTIVE_STAGES.includes(existing?.status));
  if (!willBePendingReview && existing) {
    invokeFunction('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch((err: any) => {
      console.error('applyProjectRoleDefaults fire-and-forget failed:', err.message);
    });

    // Ensure pricing is recalculated when products were auto-applied to existing project
    if (hasAutoProducts) {
      invokeFunction('recalculateProjectPricingServerSide', { project_id: project.id }).catch((err: any) => {
        console.error('Pricing recalc for existing project failed (non-fatal):', err?.message);
      });
    }
  }

  return {
    summary: `Project ${operation} (via ${originAction}): ${orderName} | Confidence: ${mappingConfidence}${isAdditionalAppointment ? ' | ADDITIONAL APPOINTMENT' : ''}${lifecycleReversalDetected ? ' | LIFECYCLE REVERSAL' : ''}`
  };
}
