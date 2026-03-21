import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

const PROCESSOR_VERSION = "v3.1";
const BATCH_SIZE = 25;
const LOCK_TTL_SECONDS = 90;

const ACTIVE_STAGES = ['scheduled', 'onsite', 'uploaded', 'submitted', 'in_revision', 'in_production'];

// Entry point
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const admin = getAdminClient();
  const entities = createEntities(admin);

  // Health check probe
  try {
    const probeBody = await req.clone().json().catch(() => null);
    if (probeBody?._health_check) {
      return jsonResponse({ _version: PROCESSOR_VERSION, _fn: 'processTonomoQueue', _ts: '2026-03-17' });
    }
  } catch { /* not a health check */ }

  const settings = await safeList(entities, 'TonomoIntegrationSettings', 1);
  const s = settings?.[0];

  const results: any = { processed: 0, failed: 0, skipped: 0 };

  try {
    await safeUpdate(entities, 'TonomoIntegrationSettings', { heartbeat_at: new Date().toISOString() });

    // Lock check — prevent concurrent runs
    if (s?.processing_lock_at) {
      const lockStr = s.processing_lock_at.replace(/Z$/, '') + 'Z';
      const lockAge = (Date.now() - new Date(lockStr).getTime()) / 1000;
      if (!isNaN(lockAge) && lockAge < LOCK_TTL_SECONDS) {
        return jsonResponse({ skipped: true, reason: 'lock_active', lock_age: lockAge });
      }
    }

    if (s?.id) {
      await entities.TonomoIntegrationSettings.update(s.id, {
        processing_lock_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        processor_version: PROCESSOR_VERSION,
      });
    }

    await recoverFailedItems(entities);

    const pendingItems = await entities.TonomoProcessingQueue.filter(
      { status: 'pending' },
      'created_at',
      BATCH_SIZE
    ) || [];

    if (!pendingItems.length) {
      await releaseLock(entities, s);
      return jsonResponse({ processed: 0, message: 'queue_empty' });
    }

    const byOrder: Record<string, any[]> = {};
    const noOrder: any[] = [];
    for (const item of pendingItems) {
      if (item.order_id) {
        if (!byOrder[item.order_id]) byOrder[item.order_id] = [];
        byOrder[item.order_id].push(item);
      } else {
        noOrder.push(item);
      }
    }

    const toProcess: any[] = [];
    for (const [, items] of Object.entries(byOrder)) {
      const sorted = items.sort((a: any, b: any) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const seen = new Map();
      const toSupersede: string[] = [];
      const CREATE_ACTIONS = new Set(['scheduled', 'booking_created_or_changed']);
      for (const item of sorted) {
        const key = CREATE_ACTIONS.has(item.action)
          ? `create:${item.order_id}`
          : `${item.action}:${item.order_id}:${item.event_id || ''}`;
        if (seen.has(key)) toSupersede.push(seen.get(key).id);
        seen.set(key, item);
      }
      if (toSupersede.length) {
        await Promise.all(toSupersede.map(id =>
          entities.TonomoProcessingQueue.update(id, { status: 'superseded' })
        ));
      }
      toProcess.push(...Array.from(seen.values()));
    }
    // Skip items with no order_id
    if (noOrder.length > 0) {
      await Promise.all(noOrder.map(item =>
        entities.TonomoProcessingQueue.update(item.id, {
          status: 'skipped',
          error_message: 'No order_id — cannot match to project',
        }).catch(() => {})
      ));
      results.skipped += noOrder.length;
    }

    for (const item of toProcess) {
      await entities.TonomoProcessingQueue.update(item.id, { status: 'processing' });

      try {
        const log = await entities.TonomoWebhookLog.get(item.webhook_log_id);
        if (!log?.raw_payload) {
          await entities.TonomoProcessingQueue.update(item.id, {
            status: 'failed',
            error_message: 'No raw_payload in log',
            last_failed_at: new Date().toISOString(),
          });
          results.failed++;
          continue;
        }

        const payload = JSON.parse(log.raw_payload);
        const result = await processItem(entities, item, payload);

        await entities.TonomoProcessingQueue.update(item.id, {
          status: 'completed',
          result_summary: result.summary,
          processed_at: new Date().toISOString(),
        });

        if (result.skipped) results.skipped++;
        else results.processed++;

      } catch (err: any) {
        const retries = (item.retry_count || 0) + 1;
        const newStatus = retries >= 3 ? 'dead_letter' : 'failed';
        await entities.TonomoProcessingQueue.update(item.id, {
          status: newStatus,
          retry_count: retries,
          error_message: err.message?.substring(0, 500),
          last_failed_at: new Date().toISOString(),
        });
        results.failed++;
        await writeAudit(entities, {
          queue_item_id: item.id,
          action: item.action,
          entity_type: 'System',
          entity_id: null,
          operation: 'failed',
          tonomo_order_id: item.order_id,
          notes: `${newStatus === 'dead_letter' ? 'DEAD LETTER after 3 retries' : 'Failed attempt ' + retries}: ${err.message?.substring(0, 300)}`,
        });
      }
    }

    await releaseLock(entities, s);
    return jsonResponse({ ...results, batch_size: toProcess.length });

  } catch (err: any) {
    await releaseLock(entities, s);
    console.error('Processor fatal error:', err.message);
    return jsonResponse({ error: err.message }, 200);
  }
});

// Retry recovery
async function recoverFailedItems(entities: any) {
  try {
    const failedItems = await entities.TonomoProcessingQueue.filter(
      { status: 'failed' },
      'last_failed_at',
      50
    ) || [];

    const now = Date.now();
    const toRecover = failedItems.filter((item: any) => {
      if ((item.retry_count || 0) >= 3) return false;
      const backoffSeconds = Math.pow(2, item.retry_count || 1) * 60;
      const lastFailed = item.last_failed_at
        ? new Date(item.last_failed_at.replace(/Z$/, '') + 'Z').getTime()
        : 0;
      return (now - lastFailed) / 1000 >= backoffSeconds;
    });

    if (toRecover.length) {
      await Promise.all(toRecover.map((item: any) =>
        entities.TonomoProcessingQueue.update(item.id, {
          status: 'pending',
          error_message: `Retrying (attempt ${(item.retry_count || 0) + 1})`,
        })
      ));
    }
  } catch (e: any) {
    console.error('recoverFailedItems error:', e.message);
  }
}

// Multi-appointment & lifecycle helpers
function trackAppointment(existingIdsJson: string | null, newEventId: string | null) {
  if (!newEventId) return { isNew: false, updatedIds: [] as string[] };
  let ids: string[] = [];
  try { ids = JSON.parse(existingIdsJson || '[]'); } catch { ids = []; }
  const isNew = !ids.includes(newEventId);
  if (isNew) ids = [...ids, newEventId];
  return { isNew, updatedIds: ids };
}

function determineReviewType(projectStatus: string, _tonomoLifecycle: string, isAdditionalAppointment: boolean, originAction: string) {
  if (projectStatus === 'cancelled') return 'restoration';
  if (projectStatus === 'delivered') return 'reopened_after_delivery';
  if (isAdditionalAppointment) return 'additional_appointment';
  if (originAction === 'rescheduled') return 'rescheduled';
  return 'new_booking';
}

function stripAddressTail(address: string): string {
  if (!address) return address;
  const parts = address.split(',').map(s => s.trim());
  const STATE_RE = /\b(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\b/i;
  const POSTCODE_RE = /^\d{4}$/;
  const COUNTRY_RE = /^Australia$/i;

  const stripped: string[] = [];
  for (const part of parts) {
    if (COUNTRY_RE.test(part)) continue;
    if (POSTCODE_RE.test(part)) continue;
    if (STATE_RE.test(part)) {
      const cleaned = part
        .replace(/\s+(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, '')
        .trim();
      if (cleaned.length > 0) stripped.push(cleaned);
      break;
    }
    stripped.push(part);
  }
  return stripped.join(', ') || address;
}

function extractSuburbFromAddress(address: string): string | null {
  if (!address) return null;
  const POSTCODE_RE = /^\d{4}$/;
  const parts = address.split(',').map((s: string) => s.trim());
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const stateMatch = part.match(/\b(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\b/i);
    if (stateMatch) {
      const cleaned = part.replace(/\s+(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, '').trim();
      if (cleaned.length > 0 && !POSTCODE_RE.test(cleaned)) return cleaned;
      break;
    }
  }
  const STATE_RE = /^(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const cleaned = part.replace(/\s+\d{4}$/, '').trim();
    if (cleaned.length > 0 && !STATE_RE.test(cleaned) && !POSTCODE_RE.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

function detectTierHint(serviceName: string): 'standard' | 'premium' | null {
  if (!serviceName) return null;
  if (/\(s\)\s*$/i.test(serviceName)) return 'standard';
  if (/\(p\)\s*$/i.test(serviceName)) return 'premium';
  return null;
}

async function resolveBookingFlowTier(
  entities: any,
  bookingFlow: { id: string; name: string; type?: string } | null
): Promise<{ tier: 'standard' | 'premium' | null; isUnmapped: boolean }> {
  if (!bookingFlow?.id) return { tier: null, isUnmapped: false };

  const existing = await entities.TonomoBookingFlowTier
    .filter({ tonomo_flow_id: bookingFlow.id }, null, 1)
    .catch(() => []);

  const record = existing?.[0];

  if (record) {
    await entities.TonomoBookingFlowTier.update(record.id, {
      tonomo_flow_name: bookingFlow.name || record.tonomo_flow_name,
      tonomo_flow_type: bookingFlow.type || record.tonomo_flow_type,
      last_seen_at: new Date().toISOString(),
      seen_count: (record.seen_count || 0) + 1,
    }).catch(() => {});
    return {
      tier: record.pricing_tier || null,
      isUnmapped: !record.pricing_tier,
    };
  }

  await entities.TonomoBookingFlowTier.create({
    tonomo_flow_id: bookingFlow.id,
    tonomo_flow_name: bookingFlow.name || 'Unknown flow',
    tonomo_flow_type: bookingFlow.type || null,
    pricing_tier: null,
    last_seen_at: new Date().toISOString(),
    seen_count: 1,
  }).catch(() => {});

  return { tier: null, isUnmapped: true };
}

async function resolveProjectTypeFromFlowType(
  entities: any,
  flowType: string | null
): Promise<{ projectTypeId: string | null; projectTypeName: string | null; isUnmapped: boolean }> {
  if (!flowType) return { projectTypeId: null, projectTypeName: null, isUnmapped: false };

  try {
    const mappings = await entities.TonomoProjectTypeMapping
      .list('-created_date', 50)
      .catch(() => []);

    const exactMatch = mappings.find((m: any) =>
      m.tonomo_flow_type?.toLowerCase() === flowType.toLowerCase()
    );
    if (exactMatch?.project_type_id) {
      entities.TonomoProjectTypeMapping.update(exactMatch.id, {
        last_seen_at: new Date().toISOString(),
        seen_count: (exactMatch.seen_count || 0) + 1,
      }).catch(() => {});
      return {
        projectTypeId: exactMatch.project_type_id,
        projectTypeName: exactMatch.project_type_name || null,
        isUnmapped: false,
      };
    }

    const defaultMapping = mappings.find((m: any) => m.is_default && m.project_type_id);
    if (defaultMapping) {
      return {
        projectTypeId: defaultMapping.project_type_id,
        projectTypeName: defaultMapping.project_type_name || null,
        isUnmapped: false,
      };
    }

    const existingUnmapped = mappings.find((m: any) =>
      m.tonomo_flow_type?.toLowerCase() === flowType.toLowerCase() && !m.project_type_id
    );
    if (!existingUnmapped) {
      entities.TonomoProjectTypeMapping.create({
        tonomo_flow_type: flowType,
        project_type_id: null,
        project_type_name: null,
        is_default: false,
        last_seen_at: new Date().toISOString(),
        seen_count: 1,
      }).catch(() => {});
    } else {
      entities.TonomoProjectTypeMapping.update(existingUnmapped.id, {
        last_seen_at: new Date().toISOString(),
        seen_count: (existingUnmapped.seen_count || 0) + 1,
      }).catch(() => {});
    }

    return { projectTypeId: null, projectTypeName: null, isUnmapped: true };
  } catch {
    return { projectTypeId: null, projectTypeName: null, isUnmapped: false };
  }
}

// Role-aware assignment
function detectBookingTypes(serviceNames: string[]) {
  const names = serviceNames.map((s) => s.toLowerCase());
  const isVideoBooking    = names.some(n => n.includes('video') || n.includes('reel') || n.includes('footage'));
  const isDroneBooking    = names.some(n => n.includes('drone'));
  const isFloorPlanBooking = names.some(n => n.includes('floor') || n.includes('floorplan'));
  const isPhotoBooking    = !isVideoBooking || names.some(n =>
    n.includes('image') || n.includes('photo') || n.includes('sales') || n.includes('rental')
  );
  return { isVideoBooking, isDroneBooking, isFloorPlanBooking, isPhotoBooking };
}

function assignStaffToProjectFields(resolvedPhotographers: any[], bookingTypes: any) {
  const fields: Record<string, any> = {
    project_owner_id:   null,
    photographer_id:    null,
    videographer_id:    null,
    onsite_staff_1_id:  null,
    onsite_staff_2_id:  null,
  };

  if (resolvedPhotographers.length === 0) return fields;

  if (resolvedPhotographers.length === 1) {
    const person = resolvedPhotographers[0];
    fields.project_owner_id = person.userId;

    if (bookingTypes.isVideoBooking && !bookingTypes.isPhotoBooking) {
      fields.videographer_id   = person.userId;
      fields.onsite_staff_2_id = person.userId;
    } else {
      fields.photographer_id   = person.userId;
      fields.onsite_staff_1_id = person.userId;
    }
    return fields;
  }

  const onsiteRoles  = ['photographer', 'videographer', 'drone_operator', 'floor_plan', null];
  const onsiteStaff  = resolvedPhotographers.filter((p: any) => onsiteRoles.includes(p.role));

  const declaredPhotographer = onsiteStaff.find((p: any) =>
    p.role === 'photographer' || p.role === 'drone_operator' || p.role === 'floor_plan'
  );
  const declaredVideographer = onsiteStaff.find((p: any) => p.role === 'videographer');
  const undeclared = onsiteStaff.filter((p: any) =>
    p !== declaredPhotographer && p !== declaredVideographer
  );

  const toAssign: any[] = [];

  if (declaredPhotographer) toAssign.push({ ...declaredPhotographer, assignedRole: 'photographer' });
  if (declaredVideographer) toAssign.push({ ...declaredVideographer, assignedRole: 'videographer' });

  for (const person of undeclared) {
    if (bookingTypes.isVideoBooking && !fields.videographer_id && !declaredVideographer) {
      toAssign.push({ ...person, assignedRole: 'videographer' });
    } else {
      toAssign.push({ ...person, assignedRole: 'photographer' });
    }
  }

  const firstOnsite = toAssign[0];
  if (firstOnsite) {
    fields.project_owner_id = firstOnsite.userId;
  }

  for (const person of toAssign) {
    if (person.assignedRole === 'photographer' && !fields.photographer_id) {
      fields.photographer_id   = person.userId;
      fields.onsite_staff_1_id = person.userId;
    } else if (person.assignedRole === 'videographer' && !fields.videographer_id) {
      fields.videographer_id   = person.userId;
      fields.onsite_staff_2_id = person.userId;
    }
  }

  return fields;
}

// Deduplicate products/packages on a project
function deduplicateProjectItems(autoProducts: any[], autoPackages: any[], _allProducts: any[], _allPackages: any[]) {
  const seenProducts = new Map<string, any>();
  for (const p of autoProducts) {
    if (!seenProducts.has(p.product_id)) {
      seenProducts.set(p.product_id, p);
    }
  }
  const seenPackages = new Map<string, any>();
  for (const p of autoPackages) {
    if (!seenPackages.has(p.package_id)) {
      seenPackages.set(p.package_id, p);
    }
  }
  return {
    products: Array.from(seenProducts.values()),
    packages: Array.from(seenPackages.values()),
  };
}

// Main router
async function processItem(entities: any, item: any, payload: any) {
  const action = item.action;
  const orderId = item.order_id || extractOrderIdFromPayload(payload);

  if (!orderId) {
    await writeAudit(entities, {
      action: item.action, entity_type: 'System', entity_id: null,
      operation: 'skipped', tonomo_order_id: null,
      notes: 'Skipped — no orderId in queue item or payload. Cannot match to project.',
    });
    return { summary: 'Skipped — no orderId', skipped: true };
  }

  const effectiveOrderStatus = payload.orderStatus || payload.order?.orderStatus;
  const isOrderCancelled =
    action === 'canceled' ||
    (action === 'changed' && effectiveOrderStatus === 'cancelled') ||
    (action === 'booking_created_or_changed' && effectiveOrderStatus === 'cancelled');

  if (action === 'scheduled') return handleScheduled(entities, orderId, payload, 'scheduled');
  if (action === 'rescheduled') return handleRescheduled(entities, orderId, payload);
  if (action === 'canceled') return handleCancelled(entities, orderId, payload);
  if (action === 'changed' && isOrderCancelled) return handleCancelled(entities, orderId, payload);
  if (action === 'changed') return handleChanged(entities, orderId, payload);
  if (action === 'booking_created_or_changed' && isOrderCancelled) return handleCancelled(entities, orderId, payload);
  if (action === 'booking_created_or_changed') return handleOrderUpdate(entities, orderId, payload);
  if (action === 'booking_completed') return handleDelivered(entities, orderId, payload);
  if (action === 'new_customer') return handleNewCustomer(entities, payload);

  return { summary: `Skipped unknown action: ${action}`, skipped: true };
}

// Handlers
async function handleScheduled(entities: any, orderId: string, p: any, originAction = 'scheduled') {
  const eventId = p.id;
  const orderName = p.order?.orderName || p.orderName || 'Unknown order';
  const address = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address || '';
  const photographers = p.photographers || [];
  const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;
  const startTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  const bookingFlowObj = p.order?.bookingFlow || null;
  const flowType = bookingFlowObj?.type || null;
  const isFirstOrder = p.isFirstOrder || p.order?.isFirstOrder || false;
  const brokerageCode = p.brokerage_code || p.order?.brokerage_code || null;

  const allMappings = await loadMappingTable(entities);

  const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
  const servicesB = p.order?.services || p.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

  const { agentId, resolvedPhotographers, unresolvedPhotographers, mappingConfidence, mappingGaps } =
    await resolveMappingsMulti(entities, { agent, photographers }, allMappings);

  const serviceIds = p.serviceIds || [];
  const serviceAssignmentUncertain = serviceIds.length === 0 && services.length > 0;

  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || [])
    .map((t: any) => ({ name: t.serviceName, selected: t.selected?.name }));

  const existing = await findProjectByOrderId(entities, orderId);

  // GUARD: If orderId matches the event/appointment ID (p.id), it's not a real order ID.
  // This is a defensive check — the receiver should never pass p.id as orderId anymore,
  // but if it does (e.g. from old queue items), refuse to create a new project.
  if (!existing && eventId && orderId === eventId) {
    await writeAudit(entities, {
      action: originAction, entity_type: 'Project', entity_id: null,
      operation: 'skipped', tonomo_order_id: orderId,
      notes: `orderId "${orderId}" matches the appointment event ID — refusing to create project. This is an appointment-level event, not a new booking.`,
    });
    return { summary: `Skipped — orderId ${orderId} is an event ID, not an order ID`, skipped: true };
  }

  const { isNew: isAdditionalAppointment, updatedIds: allAppointmentIds } = trackAppointment(
    existing?.tonomo_appointment_ids,
    eventId
  );

  const lifecycleReversalDetected =
    existing && (existing.status === 'cancelled' || existing.status === 'delivered');

  let staffAssignment: Record<string, any> = {};
  if (resolvedPhotographers.length > 0) {
    const bookingTypes = detectBookingTypes(services);
    staffAssignment = assignStaffToProjectFields(resolvedPhotographers, bookingTypes);
  }

  const rawTiers = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  const {
    autoProducts, autoPackages, mappingGaps: productMappingGaps, allConfirmed: allProductsMapped,
  } = await resolveProductsFromTiers(entities, rawTiers, allMappings);
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
    source: 'tonomo',
    tonomo_order_id: orderId,
    tonomo_event_id: eventId,
    tonomo_google_event_id: eventId,
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

  if (flowUnmapped) sharedData._flow_unmapped = true;
  if (typeUnmapped) sharedData._type_unmapped = true;

  if (p.order?.deliverable_link) sharedData.tonomo_deliverable_link = p.order.deliverable_link;
  if (p.order?.deliverable_path) sharedData.tonomo_deliverable_path = p.order.deliverable_path;
  if (agentId) sharedData.agent_id = agentId;

  for (const [field, userId] of Object.entries(staffAssignment)) {
    if (userId) sharedData[field] = userId;
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

  if (hasAutoProducts) {
    const [allProdsSched, allPkgsSched] = await Promise.all([
      entities.Product.list(null, 500).catch(() => []),
      entities.Package.list(null, 200).catch(() => []),
    ]);
    const deduped = deduplicateProjectItems(autoProducts, autoPackages, allProdsSched, allPkgsSched);
    sharedData.products = deduped.products;
    sharedData.packages = deduped.packages;
  }

  if (startTime) {
    const shootDt = new Date(startTime);
    const newDate = shootDt.toISOString().split('T')[0];
    const shootTimeStr = shootDt.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    sharedData.shoot_time = shootTimeStr;

    if (!existing || !isAdditionalAppointment) {
      sharedData.shoot_date = newDate;
    } else {
      const existingCalEvents = await entities.CalendarEvent.list('-start_time', 200).catch(() => []);
      const projectEvents = existingCalEvents.filter(
        (ev: any) => ev.project_id === existing.id && !ev.is_done
      );
      const futureTimes = [
        startTime,
        ...projectEvents
          .map((ev: any) => {
            const t = ev.start_time ? new Date(ev.start_time.endsWith('Z') ? ev.start_time : ev.start_time + 'Z').getTime() : 0;
            return t > Date.now() ? t : 0;
          })
          .filter(Boolean),
      ].filter((t: number) => t > Date.now());

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

  // ── CREATE OR UPDATE PROJECT ────────────────────────────────────────────────
  let project;
  let operation;

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

      const overriddenFields = JSON.parse(reFetched.manually_overridden_fields || '[]');
      const safeData = filterOverriddenFields(sharedData, overriddenFields);
      if (reFetched.status !== 'pending_review') {
        delete safeData.status;
        delete safeData.pending_review_reason;
        delete safeData.pending_review_type;
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

    const overriddenFields = JSON.parse(existing.manually_overridden_fields || '[]');
    const safeData = filterOverriddenFields(sharedData, overriddenFields);

    await entities.Project.update(existing.id, {
      ...safeData,
      status: 'pending_review',
      pending_review_type: reviewType,
      pending_review_reason: reversalReason,
      pre_revision_stage: existing.status,
      tonomo_lifecycle_stage: 'restored',
      is_archived: false,
      archived_at: null,
    });
    project = { ...existing, ...safeData };
    operation = 'lifecycle_reversal';

  } else if (isAdditionalAppointment) {
    const overriddenFields = JSON.parse(existing.manually_overridden_fields || '[]');
    const safeData = filterOverriddenFields(sharedData, overriddenFields);

    if (ACTIVE_STAGES.includes(existing.status)) {
      safeData.status = 'pending_review';
      safeData.pending_review_type = 'additional_appointment';
      safeData.pending_review_reason = `Additional appointment added to booking: ${new Date(startTime!).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short' })}${photographers[0] ? ` — ${photographers[0].name}` : ''}. Review and re-approve.`;
      safeData.pre_revision_stage = existing.status;
    } else {
      delete safeData.status;
    }

    await entities.Project.update(existing.id, safeData);
    project = { ...existing, ...safeData };
    operation = 'additional_appointment';

  } else {
    const overriddenFields = JSON.parse(existing.manually_overridden_fields || '[]');
    const safeData = filterOverriddenFields(sharedData, overriddenFields);

    if (existing.status !== 'pending_review') {
      delete safeData.status;
      delete safeData.pending_review_reason;
      delete safeData.pending_review_type;
    } else {
      safeData.pending_review_reason = buildReviewReason(
        mappingConfidence, mappingGaps, serviceAssignmentUncertain, unresolvedPhotographers, productGapNames,
        sharedData._flow_unmapped || false, sharedData._type_unmapped || false
      );
    }

    await entities.Project.update(existing.id, safeData);
    project = { ...existing, ...safeData };
    operation = 'updated';
  }

  // ── CREATE CALENDAR EVENT FOR THIS APPOINTMENT ──────────────────────────────
  if (eventId && startTime) {
    try {
      const existingCalEvents = await entities.CalendarEvent.list('-start_time', 200).catch(() => []);
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

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || project.property_address || '',
    action: operation === 'created' ? 'tonomo_booking_created' : 'tonomo_booking_updated',
    description: operation === 'created'
      ? `Project created from Tonomo booking. Order: ${orderId}. Mapping confidence: ${mappingConfidence}.${isAdditionalAppointment ? ' Additional appointment added.' : ''}${lifecycleReversalDetected ? ' Lifecycle reversal detected.' : ''}`
      : `Project updated from Tonomo webhook (${originAction}). Order: ${orderId}.`,
    tonomo_order_id: orderId,
    tonomo_event_type: originAction,
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

  // If auto-approved, fire role defaults + task gen + notification
  if (canAutoApprove && project?.id) {
    const autoStatus = sharedData.shoot_date ? 'scheduled' : 'to_be_scheduled';

    invokeFunction('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch((err: any) => {
      console.warn('applyProjectRoleDefaults after auto-approve failed (non-fatal):', err?.message);
    });

    invokeFunction('trackProjectStageChange', {
      projectId: project.id,
      old_data: { status: 'pending_review' },
      actor_id: null,
      actor_name: 'Auto-Approve',
    }).catch(() => {});

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
      idempotencyKey: `booking_arrived:${orderId}:${Date.now().toString().slice(0,-4)}`,
    }).catch(() => {});

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
  }

  return {
    summary: `Project ${operation} (via ${originAction}): ${orderName} | Confidence: ${mappingConfidence}${isAdditionalAppointment ? ' | ADDITIONAL APPOINTMENT' : ''}${lifecycleReversalDetected ? ' | LIFECYCLE REVERSAL' : ''}`
  };
}

async function handleRescheduled(entities: any, orderId: string, p: any) {
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

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const updates: Record<string, any> = {};
  const previousShootDate = project.shoot_date;

  if (startTime && !overriddenFields.includes('shoot_date')) {
    const rescheduleDt = new Date(startTime);
    updates.shoot_date = rescheduleDt.toISOString().split('T')[0];
    updates.shoot_time = rescheduleDt.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  if (startTime) {
    const hoursUntilShoot = (startTime - Date.now()) / 3600000;
    updates.urgent_review = hoursUntilShoot <= 24 && hoursUntilShoot > 0;
  }
  if (ACTIVE_STAGES.includes(project.status)) {
    updates.pre_revision_stage = project.status;
    updates.status = 'pending_review';
    updates.pending_review_type = 'rescheduled';
    updates.pending_review_reason = `Shoot rescheduled in Tonomo from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'} — please confirm`;
  }

  await entities.Project.update(project.id, updates);

  if (eventId && startTime) {
    try {
      const existingCalEvents = await entities.CalendarEvent.list('-start_time', 200).catch(() => []);
      const appointmentEvent = existingCalEvents.find(
        (ev: any) => (ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId) &&
                     ev.project_id === project.id
      );
      if (appointmentEvent) {
        const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
        await entities.CalendarEvent.update(appointmentEvent.id, {
          start_time: new Date(startTime).toISOString(),
          end_time: endTime ? new Date(endTime).toISOString() : null,
        });
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

async function handleChanged(entities: any, orderId: string, p: any) {
  const photographers = p.photographers || [];
  const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;
  const project = await findProjectByOrderId(entities, orderId);
  if (!project) {
    // STRICT: Change events (photographer reassignment, service updates) should only UPDATE
    // existing projects. If no project exists, this is an orphan event — skip it.
    await writeAudit(entities, {
      action: 'changed', entity_type: 'Project', entity_id: null, operation: 'skipped',
      tonomo_order_id: orderId,
      notes: `Orphan event — no existing project for this order. Change events do not create projects. Photographers: ${photographers.map((ph: any) => ph.name).join(', ') || 'none'}`,
    });
    return { summary: `Skipped change for unknown order ${orderId} — no project exists`, skipped: true };
  }

  if (project.status === 'cancelled') {
    await writeAudit(entities, { action: 'changed', entity_type: 'Project', entity_id: project.id, operation: 'skipped', tonomo_order_id: orderId, notes: 'Skipped — project already cancelled' });
    return { summary: `Skipped changed for cancelled project ${orderId}`, skipped: true };
  }

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const updates: Record<string, any> = {};
  const reviewReasons: string[] = [];
  const allMappings = await loadMappingTable(entities);

  const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
  const servicesB = p.order?.services || p.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

  if (photographers.length > 0) {
    updates.tonomo_photographer_ids = JSON.stringify(photographers);
    const { resolvedPhotographers, unresolvedPhotographers } = await resolveMappingsMulti(entities, { photographers }, allMappings);

    if (resolvedPhotographers.length > 0) {
      const bookingTypes = detectBookingTypes(services);
      const staffAssignment = assignStaffToProjectFields(resolvedPhotographers, bookingTypes);
      for (const [field, userId] of Object.entries(staffAssignment)) {
        if (userId && !overriddenFields.includes(field)) updates[field] = userId;
      }
    }
    if (unresolvedPhotographers.length > 0) {
      reviewReasons.push(`Photographer(s) reassigned but not found: ${unresolvedPhotographers.join(', ')} — manual assignment required`);
      if (project.status !== 'pending_review') updates.pending_review_type = 'staff_change';
    }
  }

  if (agent) {
    const { agentId } = await resolveMappingsMulti(entities, { agent }, allMappings);
    if (agentId && !overriddenFields.includes('agent_id')) updates.agent_id = agentId;
    else if (!agentId) reviewReasons.push(`Agent reassigned to "${agent.displayName || agent.email || 'unknown'}" but not found — manual assignment required`);
  }

  if (services.length > 0 && !overriddenFields.includes('tonomo_raw_services')) {
    if (ACTIVE_STAGES.includes(project.status)) {
      const prev = JSON.parse(project.tonomo_raw_services || '[]');
      const added = services.filter((s: string) => !prev.includes(s));
      const removed = prev.filter((s: string) => !services.includes(s));
      if (added.length > 0 || removed.length > 0) {
        reviewReasons.push(`Services changed during active production${added.length ? ` — added: ${added.join(', ')}` : ''}${removed.length ? ` — removed: ${removed.join(', ')}` : ''} — please confirm billing`);
        if (project.status !== 'pending_review') updates.pending_review_type = 'service_change';
      }
    }
    updates.tonomo_raw_services = JSON.stringify(services);
  }

  // Update CalendarEvent for this appointment
  const appointmentEventId = p.id;
  if (appointmentEventId && Object.keys(updates).length > 0) {
    try {
      const existingCalEvents = await entities.CalendarEvent.list('-start_time', 200).catch(() => []);
      const appointmentEvent = existingCalEvents.find(
        (ev: any) => (ev.google_event_id === appointmentEventId || ev.tonomo_appointment_id === appointmentEventId) &&
                     ev.project_id === project.id
      );
      if (appointmentEvent) {
        const calUpdates: Record<string, any> = {};
        if (updates.project_owner_id) calUpdates.owner_user_id = updates.project_owner_id;
        if (updates.agent_id) calUpdates.agent_id = updates.agent_id;
        if (updates.agency_id) calUpdates.agency_id = updates.agency_id;
        if (photographers.length > 0) {
          calUpdates.attendees = JSON.stringify(photographers.map((ph: any) => ({
            name: ph.name, email: ph.email, tonomoId: ph.id
          })));
        }
        calUpdates.event_source = 'tonomo';
        await entities.CalendarEvent.update(appointmentEvent.id, calUpdates);
      }
    } catch (calErr: any) {
      console.error('CalendarEvent staff update failed (non-fatal):', calErr.message);
    }
  }

  const changedDeliverablePath = p.order?.deliverable_path || p.deliverable_path;
  if (changedDeliverablePath && !overriddenFields.includes('tonomo_deliverable_path')) {
    updates.tonomo_deliverable_path = changedDeliverablePath;
  }
  const changedDeliverableLink = p.order?.deliverable_link || p.deliverable_link;
  if (changedDeliverableLink && !overriddenFields.includes('tonomo_deliverable_link')) {
    updates.tonomo_deliverable_link = changedDeliverableLink;
  }

  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || []).map((t: any) => ({ name: t.serviceName, selected: t.selected?.name }));
  if (tiers.length > 0 && !overriddenFields.includes('tonomo_service_tiers')) updates.tonomo_service_tiers = JSON.stringify(tiers);

  const changedBookingFlow = p.order?.bookingFlow || null;
  if (changedBookingFlow?.id && !overriddenFields.includes('pricing_tier')) {
    const { tier: newFlowTier } = await resolveBookingFlowTier(entities, changedBookingFlow);
    if (newFlowTier && newFlowTier !== project.pricing_tier) {
      updates.pricing_tier = newFlowTier;
      updates.tonomo_booking_flow = changedBookingFlow.name || project.tonomo_booking_flow;
      updates.tonomo_booking_flow_id = changedBookingFlow.id;
      reviewReasons.push(`Pricing tier updated to ${newFlowTier} based on booking flow "${changedBookingFlow.name}"`);
    }
  }

  const changedFlowType = changedBookingFlow?.type || null;
  if (changedFlowType && !overriddenFields.includes('project_type_id')) {
    const { projectTypeId: newTypeId, projectTypeName: newTypeName } =
      await resolveProjectTypeFromFlowType(entities, changedFlowType);
    if (newTypeId && newTypeId !== project.project_type_id) {
      updates.project_type_id = newTypeId;
      updates.project_type_name = newTypeName;
    }
  }

  const rawTiersChanged = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  if (rawTiersChanged.length > 0 && !overriddenFields.includes('products')) {
    const allMappingsForProducts = await loadMappingTable(entities);
    const { autoProducts: newProducts, autoPackages: newPackages, mappingGaps: newGaps } =
      await resolveProductsFromTiers(entities, rawTiersChanged, allMappingsForProducts);

    if (newProducts.length > 0 || newPackages.length > 0) {
      const dedupedChanged = deduplicateProjectItems(newProducts, newPackages,
        await entities.Product.list(null, 500).catch(() => []),
        await entities.Package.list(null, 200).catch(() => [])
      );
      updates.products = dedupedChanged.products;
      updates.packages = dedupedChanged.packages;
      updates.products_auto_applied = true;
      updates.products_needs_recalc = true;
      updates.products_mapping_gaps = JSON.stringify(newGaps.map((g: any) => g.serviceName));

      if (ACTIVE_STAGES.includes(project.status)) {
        const prevProducts = project.products || [];
        const qtyChanged = newProducts.some((np: any) => {
          const prev = prevProducts.find((pp: any) => pp.product_id === np.product_id);
          return prev && prev.quantity !== np.quantity;
        });
        if (qtyChanged) {
          reviewReasons.push('Product quantities changed in Tonomo — pricing recalculation required');
        }
      }
    }
  }
  if (p.order?.package?.name && !overriddenFields.includes('tonomo_package')) updates.tonomo_package = p.order.package.name;
  if (p.invoice_amount != null && !overriddenFields.includes('tonomo_invoice_amount')) updates.tonomo_invoice_amount = p.invoice_amount ? parseFloat(p.invoice_amount) : null;
  if (p.order?.orderStatus) updates.tonomo_order_status = p.order.orderStatus;

  if (reviewReasons.length > 0) {
    if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;
    updates.status = 'pending_review';
    updates.pending_review_reason = reviewReasons.join(' | ');
  }

  if (Object.keys(updates).length) await entities.Project.update(project.id, updates);

  await writeAudit(entities, {
    action: 'changed', entity_type: 'Project', entity_id: project.id,
    operation: Object.keys(updates).length ? 'updated' : 'no_changes',
    tonomo_order_id: orderId,
    notes: [`Photographers: ${photographers.map((ph: any) => ph.name).join(', ') || 'none'}`, `Agent: ${agent?.displayName || 'none'}`, `Review flags: ${reviewReasons.join('; ') || 'none'}`].join(' | '),
  });

  await writeProjectActivity(entities, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_changed',
    description: `Booking changed in Tonomo.${reviewReasons.length > 0 ? ` Review flags: ${reviewReasons.join('; ')}` : ' No review required.'}`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'changed',
    metadata: {
      review_flags: reviewReasons,
      fields_updated: Object.keys(updates),
    },
  });

  if (updates.products || updates.packages) {
    const changedProjectName = project.title || project.property_address || 'Project';
    fireRoleNotif(entities, ['project_owner', 'master_admin'], {
      type: 'booking_services_changed',
      category: 'tonomo',
      severity: 'warning',
      title: `Services changed — ${changedProjectName}`,
      message: `Tonomo order services changed. Pricing recalculation may be required.`,
      projectId: project.id,
      projectName: changedProjectName,
      ctaLabel: 'View Project',
      source: 'tonomo',
      idempotencyKey: `services_changed:${orderId}:${Date.now().toString().slice(0,-4)}`,
    }, project).catch(() => {});
  }

  if (updates.products || updates.packages) {
    invokeFunction('cleanupOrphanedProjectTasks', {
      project_id: project.id,
    }).catch(() => { /* non-fatal */ });
  }

  return { summary: `Updated project for changed order ${orderId}` };
}

async function handleCancelled(entities: any, orderId: string, p: any) {
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

async function handleOrderUpdate(entities: any, orderId: string, p: any) {
  const project = await findProjectByOrderId(entities, orderId);

  if (!project) {
    // GUARD: If orderId matches the event/appointment ID, refuse to create
    const eventId = p.id;
    if (eventId && orderId === eventId) {
      await writeAudit(entities, {
        action: 'booking_created_or_changed', entity_type: 'Project', entity_id: null,
        operation: 'skipped', tonomo_order_id: orderId,
        notes: `orderId "${orderId}" matches event ID — refusing to create from handleOrderUpdate`,
      });
      return { summary: `Skipped — orderId ${orderId} is an event ID`, skipped: true };
    }

    // STRICT: Only create a project from booking_created_or_changed if the payload has
    // sufficient data indicating this is a genuine new booking — not just a metadata update.
    const orderName = p.order?.orderName || p.orderName || null;
    const address = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address || null;
    const hasServices = (p.order?.services_a_la_cart || p.services_a_la_cart || p.order?.services || p.services || []).length > 0;
    const hasBookingFlow = !!(p.order?.bookingFlow || p.bookingFlow);
    const hasAppointment = !!(p.when?.start_time);

    // Require address/name AND at least one of: services, booking flow, or appointment time
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

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const updates: Record<string, any> = {};
  const reviewReasons: string[] = [];

  const servicesA = p.services_a_la_cart || p.order?.services_a_la_cart || [];
  const servicesB = p.services || p.order?.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);
  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || []).map((t: any) => ({ name: t.serviceName, selected: t.selected?.name }));

  if (!overriddenFields.includes('tonomo_raw_services')) {
    if (ACTIVE_STAGES.includes(project.status) && services.length > 0) {
      const prev = JSON.parse(project.tonomo_raw_services || '[]');
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

  const startTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  if (startTime && !overriddenFields.includes('shoot_date')) updates.shoot_date = new Date(startTime).toISOString().split('T')[0];
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

  await writeAudit(entities, {
    action: 'booking_created_or_changed', entity_type: 'Project', entity_id: project.id,
    operation: Object.keys(updates).length ? 'updated' : 'no_changes',
    tonomo_order_id: orderId,
    notes: `Services: ${services.length}. Invoice: $${p.invoice_amount ?? 'unchanged'}. OrderStatus: ${incomingStatus || 'unchanged'}`,
  });

  if (updates.products || updates.packages) {
    invokeFunction('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch(() => { /* non-fatal */ });
  }

  return { summary: `Order update applied for ${orderId}` };
}

async function handleDelivered(entities: any, orderId: string, p: any) {
  const project = await findProjectByOrderId(entities, orderId);
  if (!project) return { summary: `No project found for delivery ${orderId}`, skipped: true };

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const hasDeliverables = p.deliverable_link || (p.deliverablesLinks?.length > 0);

  const updates: Record<string, any> = {
    tonomo_order_status: 'complete',
    tonomo_payment_status: p.paymentStatus || project.tonomo_payment_status,
  };

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
  if (p.deliverable_path || p.order?.deliverable_path) updates.tonomo_deliverable_path = p.deliverable_path || p.order.deliverable_path;
  if (p.deliverablesLinks?.length > 0) updates.tonomo_delivered_files = JSON.stringify(p.deliverablesLinks);
  if (p.invoice_link) updates.tonomo_invoice_link = p.invoice_link;
  if (p.invoice_amount != null && !overriddenFields.includes('tonomo_invoice_amount')) updates.tonomo_invoice_amount = p.invoice_amount ? parseFloat(p.invoice_amount) : null;

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

  return { summary: `Project delivered for order ${orderId}` };
}

async function handleNewCustomer(entities: any, p: any) {
  if (!p.user?.email) return { summary: 'New customer skipped — no email', skipped: true };

  const existing = await entities.Agent.filter({ email: p.user.email }, null, 1);
  if (existing?.length > 0) return { summary: `Customer already exists: ${p.user.email}`, skipped: true };

  const agent = await entities.Agent.create({
    name: p.user.name || p.user.email,
    email: p.user.email,
    phone: p.user.phone || null,
  });

  await writeAudit(entities, {
    action: 'new_customer', entity_type: 'Agent', entity_id: agent.id, operation: 'created',
    notes: `New customer from Tonomo: ${p.user.email}`,
  });
  return { summary: `New customer created: ${p.user.email}` };
}

// Resolution helpers
async function resolveProductsFromTiers(entities: any, tiers: any[], allMappings: any[]) {
  if (!tiers || tiers.length === 0) {
    return { autoProducts: [], autoPackages: [], mappingGaps: [] as any[], allConfirmed: true };
  }

  const [allProducts, allPackages] = await Promise.all([
    entities.Product.list('-updated_date', 500).catch(() => []),
    entities.Package.list('-updated_date', 200).catch(() => []),
  ]);

  const autoProducts: any[] = [];
  const autoPackages: any[] = [];
  const mappingGaps: any[] = [];

  for (const tier of tiers) {
    const serviceId = tier.serviceId;
    const serviceName = tier.serviceName || 'Unknown service';
    const selectedTierName = tier.selected?.name || '';
    const qty = extractQtyFromTierName(selectedTierName);

    if (!serviceId) {
      mappingGaps.push({ serviceId: 'unknown', serviceName });
      continue;
    }

    const confirmedService = allMappings.find(
      (m: any) => m.tonomo_id === serviceId &&
             m.mapping_type === 'service' &&
             m.is_confirmed === true &&
             m.flexmedia_entity_id
    );

    const confirmedPackage = allMappings.find(
      (m: any) => m.tonomo_id === serviceId &&
             m.mapping_type === 'package' &&
             m.is_confirmed === true &&
             m.flexmedia_entity_id
    );

    if (confirmedService) {
      const product = allProducts.find((p: any) => p.id === confirmedService.flexmedia_entity_id);
      const finalQty = clampQty(qty, product);
      const tierHint = detectTierHint(serviceName);

      if (tierHint && !confirmedService.detected_tier_hint) {
        entities.TonomoMappingTable.update(confirmedService.id, {
          detected_tier_hint: tierHint,
        }).catch(() => {});
      }

      autoProducts.push({
        product_id: confirmedService.flexmedia_entity_id,
        quantity: finalQty,
        tier_hint: tierHint || null,
      });

    } else if (confirmedPackage) {
      autoPackages.push({
        package_id: confirmedPackage.flexmedia_entity_id,
        quantity: 1,
        products: [],
      });

    } else {
      mappingGaps.push({ serviceId, serviceName });

      const nameMatchProduct = allProducts.find(
        (p: any) => p.name?.toLowerCase() === serviceName.toLowerCase() && p.is_active
      );
      const nameMatchPackage = allPackages.find(
        (p: any) => p.name?.toLowerCase() === serviceName.toLowerCase()
      );
      const nameMatch = nameMatchProduct || nameMatchPackage;
      const entityType = nameMatchProduct ? 'Product' : nameMatchPackage ? 'Package' : 'Product';
      const mappingType = nameMatchPackage ? 'package' : 'service';

      await upsertMappingSuggestion(
        entities,
        serviceId,
        serviceName,
        mappingType,
        entityType,
        nameMatch?.id || null,
        nameMatch?.name || null,
        nameMatch ? 'high' : 'low',
        allMappings
      );
    }
  }

  const seenProducts = new Set();
  const dedupedProducts = autoProducts.filter(p => {
    if (seenProducts.has(p.product_id)) return false;
    seenProducts.add(p.product_id);
    return true;
  });

  const seenPackages = new Set();
  const dedupedPackages = autoPackages.filter(p => {
    if (seenPackages.has(p.package_id)) return false;
    seenPackages.add(p.package_id);
    return true;
  });

  return {
    autoProducts: dedupedProducts,
    autoPackages: dedupedPackages,
    mappingGaps,
    allConfirmed: mappingGaps.length === 0,
  };
}

async function resolveMappingsMulti(entities: any, { agent, photographers = [] }: any, allMappings: any[]) {
  let agentId = null;
  const resolvedPhotographers: any[] = [];
  const unresolvedPhotographers: string[] = [];
  const mappingGaps: string[] = [];
  let resolvedCount = 0;
  let totalCount = 0;

  if (agent) {
    totalCount++;
    const result = await resolveEntity(entities, agent.uid, agent.email, agent.displayName, 'agent', 'Agent', allMappings);
    if (result.entityId) { agentId = result.entityId; resolvedCount++; }
    else mappingGaps.push(`agent:${agent.email || agent.displayName || agent.uid}`);
  }

  for (const photographer of photographers) {
    totalCount++;
    const result = await resolveEntity(entities, photographer.id, photographer.email, photographer.name, 'photographer', 'User', allMappings);
    if (result.entityId) {
      const confirmedMapping = allMappings.find(
        (m: any) => m.tonomo_id === photographer.id && m.mapping_type === 'photographer' && m.is_confirmed
      );
      resolvedPhotographers.push({
        name: photographer.name,
        userId: result.entityId,
        role: confirmedMapping?.primary_role || null,
      });
      resolvedCount++;

      if (confirmedMapping) {
        try {
          await entities.TonomoMappingTable.update(confirmedMapping.id, {
            seen_count: (confirmedMapping.seen_count || 0) + 1,
            last_seen_at: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      }
    } else {
      unresolvedPhotographers.push(photographer.name || photographer.id || 'unknown');
      mappingGaps.push(`photographer:${photographer.email || photographer.name || photographer.id}`);
    }
  }

  const mappingConfidence = mappingGaps.length === 0 ? 'full' : resolvedCount > 0 ? 'partial' : totalCount > 0 ? 'none' : 'full';
  return { agentId, resolvedPhotographers, unresolvedPhotographers, mappingConfidence, mappingGaps };
}

async function resolveEntity(entities: any, tonomoUid: string, email: string, name: string, mappingType: string, entityDbName: string, allMappings: any[]) {
  if (!tonomoUid) return { entityId: null };

  const confirmed = allMappings.find((m: any) => m.tonomo_id === tonomoUid && m.mapping_type === mappingType && m.is_confirmed === true);
  if (confirmed) return { entityId: confirmed.flexmedia_entity_id };

  const nameField = entityDbName === 'User' ? 'full_name' : 'name';
  const allEntities = await entities[entityDbName].list('-created_date', 500);
  const byEmail = email ? allEntities?.filter((e: any) => e.email === email) : [];
  const byName = !byEmail?.length && name ? allEntities?.filter((e: any) => e[nameField]?.toLowerCase() === name.toLowerCase()) : [];
  const match = byEmail?.[0] || byName?.[0] || null;

  await upsertMappingSuggestion(entities, tonomoUid, name || email || tonomoUid, mappingType, entityDbName, match?.id || null, match?.[nameField] || null, match ? 'high' : 'low', allMappings);
  return { entityId: match?.id || null };
}

async function loadMappingTable(entities: any) {
  try { return await entities.TonomoMappingTable.list('-last_seen_at', 500) || []; } catch { return []; }
}

async function upsertMappingSuggestion(entities: any, tonomoId: string, tonomoLabel: string, mappingType: string, entityType: string, entityId: string | null, entityLabel: string | null, confidence: string, allMappings: any[]) {
  const existing = allMappings.filter((m: any) => m.tonomo_id === tonomoId && m.mapping_type === mappingType);
  const data = { tonomo_id: tonomoId, tonomo_label: tonomoLabel, mapping_type: mappingType, flexmedia_entity_type: entityType, flexmedia_entity_id: entityId, flexmedia_label: entityLabel, auto_suggested: true, confidence, last_seen_at: new Date().toISOString() };
  if (existing?.length > 0 && !existing[0].is_confirmed) await entities.TonomoMappingTable.update(existing[0].id, data);
  else if (!existing?.length) await entities.TonomoMappingTable.create(data);
}

async function findProjectByOrderId(entities: any, orderId: string) {
  if (!orderId) return null;
  try {
    const results = await entities.Project.filter({ tonomo_order_id: orderId }, null, 1);
    return results?.[0] || null;
  } catch { return null; }
}

function extractOrderIdFromPayload(p: any) {
  // CRITICAL: Never fall back to p.id — that's the appointment/event ID, not the order ID.
  // Using it causes duplicate projects for appointment-level events (time change, people change).
  return p.orderId || p.order?.orderId || '';
}

function extractQtyFromTierName(tierName: string) {
  const match = (tierName || '').match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

function clampQty(qty: number, product: any) {
  const min = Math.max(1, product?.min_quantity || 1);
  const max = product?.max_quantity ? parseInt(String(product.max_quantity)) : null;
  let clamped = Math.max(min, qty);
  if (max !== null) clamped = Math.min(clamped, max);
  return clamped;
}

function buildReviewReason(confidence: string, gaps: string[], serviceUncertain: boolean, unresolvedPhotographers: string[] = [], unmappedServices: string[] = [], flowUnmapped = false, typeUnmapped = false) {
  const reasons: string[] = [];
  if (confidence !== 'full') reasons.push(`Mapping confidence: ${confidence}. Gaps: ${gaps.join(', ')}`);
  if (serviceUncertain) reasons.push('Service assignment uncertain — using order-level services as fallback');
  if (unresolvedPhotographers.length > 0) reasons.push(`Unresolved photographer(s): ${unresolvedPhotographers.join(', ')} — manual assignment required`);
  if (unmappedServices.length > 0) reasons.push(`Unmapped services (products not applied): ${unmappedServices.join(', ')} — confirm in Bookings Engine > Mappings`);
  if (flowUnmapped) reasons.push('Booking flow not mapped to a pricing tier — defaulting to standard. Set it in Settings > Tonomo Mappings > Booking Flows');
  if (typeUnmapped) reasons.push('Booking flow type not mapped to a project type — project type unset. Map it in Settings > Tonomo Mappings > Project Types');
  return reasons.join(' | ') || 'Auto-imported from Tonomo';
}

function filterOverriddenFields(data: any, overriddenFields: string[]) {
  if (!overriddenFields.length) return data;
  const result = { ...data };
  for (const field of overriddenFields) delete result[field];
  return result;
}

async function writeProjectActivity(entities: any, params: any) {
  try {
    await entities.ProjectActivity.create({
      project_id: params.project_id,
      project_title: params.project_title || '',
      action: params.action,
      description: params.description,
      actor_type: 'tonomo',
      actor_source: 'processTonomoQueue',
      user_name: 'Tonomo System',
      user_email: 'system@tonomo',
      tonomo_order_id: params.tonomo_order_id || null,
      tonomo_event_type: params.tonomo_event_type || null,
      changed_fields: params.changed_fields || [],
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });
  } catch (e: any) {
    console.error('writeProjectActivity failed:', e.message);
  }
}

async function writeAudit(entities: any, params: any) {
  try {
    await entities.TonomoAuditLog.create({ ...params, processor_version: PROCESSOR_VERSION, processed_at: new Date().toISOString() });
  } catch (e: any) { console.error('Audit log write failed:', e.message); }
}

async function releaseLock(entities: any, settings: any) {
  if (settings?.id) {
    try { await entities.TonomoIntegrationSettings.update(settings.id, { processing_lock_at: null }); }
    catch { /* self-expires after TTL */ }
  }
}

async function safeList(entities: any, entity: string, limit = 10) {
  try { return await entities[entity].list('-created_date', limit); } catch { return []; }
}

async function safeUpdate(entities: any, entity: string, data: any) {
  try {
    const items = await entities[entity].list('-created_date', 1);
    if (items?.[0]?.id) await entities[entity].update(items[0].id, data);
  } catch { /* silent */ }
}

// Notification helpers
async function fireAdminNotif(entities: any, params: any) {
  try {
    const users = await entities.User.list('-created_date', 200);
    const adminIds = users
      .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
      .map((u: any) => u.id);

    for (const userId of adminIds) {
      const idemKey = params.idempotencyKey
        ? `${params.idempotencyKey}:${userId}`
        : params.idempotencyKeySuffix
        ? `${params.idempotencyKeySuffix}:${userId}`
        : null;
      await fireNotif(entities, { ...params, userId, idempotencyKey: idemKey });
    }
  } catch (e: any) {
    console.warn('fireAdminNotif error:', e.message);
  }
}

async function fireRoleNotif(entities: any, roles: string[], params: any, project: any) {
  try {
    const ROLE_FIELDS: Record<string, string[]> = {
      project_owner: ['project_owner_id'],
      photographer: ['photographer_id', 'onsite_staff_1_id'],
      videographer: ['videographer_id', 'onsite_staff_2_id'],
      image_editor: ['image_editor_id'],
      video_editor: ['video_editor_id'],
      assigned_users: ['assigned_users'],
      master_admin: [],
    };

    const ids = new Set<string>();

    // For master_admin role, look up actual admin users
    if (roles.includes('master_admin')) {
      const users = await entities.User.list('-created_date', 200);
      users
        .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
        .forEach((u: any) => ids.add(u.id));
    }

    for (const role of roles) {
      for (const field of (ROLE_FIELDS[role] || [])) {
        const val = project?.[field];
        if (!val) continue;
        if (field === 'assigned_users') {
          const arr = Array.isArray(val) ? val : (() => { try { return JSON.parse(val); } catch { return []; } })();
          arr.forEach((id: string) => id && ids.add(id));
        } else {
          ids.add(val);
        }
      }
    }

    for (const userId of Array.from(ids)) {
      const idemKey = params.idempotencyKey ? `${params.idempotencyKey}:${userId}` : null;
      await fireNotif(entities, { ...params, userId, idempotencyKey: idemKey });
    }
  } catch (e: any) {
    console.warn('fireRoleNotif error:', e.message);
  }
}

async function fireNotif(entities: any, p: any) {
  try {
    if (p.idempotencyKey) {
      const existing = await entities.Notification.filter(
        { idempotency_key: p.idempotencyKey }, null, 1
      );
      if (existing.length > 0) return;
    }

    await entities.Notification.create({
      user_id: p.userId,
      type: p.type,
      category: p.category,
      severity: p.severity,
      title: p.title,
      message: p.message,
      project_id: p.projectId || null,
      project_name: p.projectName || null,
      cta_label: p.ctaLabel || 'View',
      is_read: false,
      is_dismissed: false,
      source: p.source || 'system',
      idempotency_key: p.idempotencyKey || null,
    });
  } catch (e: any) {
    console.warn('fireNotif error:', e.message);
  }
}
