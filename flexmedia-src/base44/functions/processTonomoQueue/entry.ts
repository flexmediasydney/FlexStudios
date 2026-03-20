import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const PROCESSOR_VERSION = "v3.1";
const BATCH_SIZE = 25;
const LOCK_TTL_SECONDS = 90;

const ACTIVE_STAGES = ['scheduled', 'onsite', 'uploaded', 'submitted', 'in_revision', 'in_production'];

// Entry point: Called via fire-and-forget HTTP or manually from UI.
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  // Health check probe — return version without processing anything
  try {
    const probeBody = await req.clone().json().catch(() => null);
    if (probeBody?._health_check) {
      return Response.json({ _version: PROCESSOR_VERSION, _fn: 'processTonomoQueue', _ts: '2026-03-17' });
    }
  } catch { /* not a health check */ }

  const settings = await safeList(base44, 'TonomoIntegrationSettings', 1);
  const s = settings?.[0];

  try {
    await safeUpdate(base44, 'TonomoIntegrationSettings', { heartbeat_at: new Date().toISOString() });

    // Lock check — prevent concurrent runs
    if (s?.processing_lock_at) {
      const lockStr = s.processing_lock_at.replace(/Z$/, '') + 'Z';
      const lockAge = (Date.now() - new Date(lockStr).getTime()) / 1000;
      if (!isNaN(lockAge) && lockAge < LOCK_TTL_SECONDS) {
        return Response.json({ skipped: true, reason: 'lock_active', lock_age: lockAge });
      }
    }

    if (s?.id) {
      await base44.asServiceRole.entities.TonomoIntegrationSettings.update(s.id, {
        processing_lock_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        processor_version: PROCESSOR_VERSION,
      });
    }

    await recoverFailedItems(base44);

    const pendingItems = await base44.asServiceRole.entities.TonomoProcessingQueue.filter(
      { status: 'pending' },
      'created_at',
      BATCH_SIZE
    ) || [];

    if (!pendingItems.length) {
      await releaseLock(base44, s);
      return Response.json({ processed: 0, message: 'queue_empty' });
    }

    const byOrder = {};
    const noOrder = [];
    for (const item of pendingItems) {
      if (item.order_id) {
        if (!byOrder[item.order_id]) byOrder[item.order_id] = [];
        byOrder[item.order_id].push(item);
      } else {
        noOrder.push(item);
      }
    }

    const toProcess = [];
    for (const [, items] of Object.entries(byOrder)) {
      const sorted = items.sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const seen = new Map();
      const toSupersede = [];
      // Group create-capable actions together so only the LATEST one per order is processed
      const CREATE_ACTIONS = new Set(['scheduled', 'booking_created_or_changed']);
      for (const item of sorted) {
        // For create-capable actions, deduplicate by order_id only (not action type)
        // This prevents scheduled + booking_created_or_changed from both creating projects
        const key = CREATE_ACTIONS.has(item.action)
          ? `create:${item.order_id}`
          : `${item.action}:${item.order_id}:${item.event_id || ''}`;
        if (seen.has(key)) toSupersede.push(seen.get(key).id);
        seen.set(key, item);
      }
      if (toSupersede.length) {
        await Promise.all(toSupersede.map(id =>
          base44.asServiceRole.entities.TonomoProcessingQueue.update(id, { status: 'superseded' })
        ));
      }
      toProcess.push(...Array.from(seen.values()));
    }
    // Skip items with no order_id — they cannot be matched to a project and would create orphans
    if (noOrder.length > 0) {
      await Promise.all(noOrder.map(item =>
        base44.asServiceRole.entities.TonomoProcessingQueue.update(item.id, {
          status: 'skipped',
          error_message: 'No order_id — cannot match to project',
        }).catch(() => {})
      ));
      results.skipped += noOrder.length;
    }

    const results = { processed: 0, failed: 0, skipped: 0 };

    for (const item of toProcess) {
      await base44.asServiceRole.entities.TonomoProcessingQueue.update(item.id, { status: 'processing' });

      try {
        const log = await base44.asServiceRole.entities.TonomoWebhookLog.get(item.webhook_log_id);
        if (!log?.raw_payload) {
          await base44.asServiceRole.entities.TonomoProcessingQueue.update(item.id, {
            status: 'failed',
            error_message: 'No raw_payload in log',
            last_failed_at: new Date().toISOString(),
          });
          results.failed++;
          continue;
        }

        const payload = JSON.parse(log.raw_payload);
        const result = await processItem(base44, item, payload);

        await base44.asServiceRole.entities.TonomoProcessingQueue.update(item.id, {
          status: 'completed',
          result_summary: result.summary,
          processed_at: new Date().toISOString(),
        });

        if (result.skipped) results.skipped++;
        else results.processed++;

      } catch (err) {
        const retries = (item.retry_count || 0) + 1;
        const newStatus = retries >= 3 ? 'dead_letter' : 'failed';
        await base44.asServiceRole.entities.TonomoProcessingQueue.update(item.id, {
          status: newStatus,
          retry_count: retries,
          error_message: err.message?.substring(0, 500),
          last_failed_at: new Date().toISOString(),
        });
        results.failed++;
        await writeAudit(base44, {
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

    await releaseLock(base44, s);
    return Response.json({ ...results, batch_size: toProcess.length });

  } catch (err) {
    await releaseLock(base44, s);
    console.error('Processor fatal error:', err.message);
    return Response.json({ error: err.message }, { status: 200 });
  }
});

// Retry recovery
async function recoverFailedItems(base44) {
  try {
    const failedItems = await base44.asServiceRole.entities.TonomoProcessingQueue.filter(
      { status: 'failed' },
      'last_failed_at',
      50
    ) || [];

    const now = Date.now();
    const toRecover = failedItems.filter((item) => {
      if ((item.retry_count || 0) >= 3) return false;
      const backoffSeconds = Math.pow(2, item.retry_count || 1) * 60;
      const lastFailed = item.last_failed_at
        ? new Date(item.last_failed_at.replace(/Z$/, '') + 'Z').getTime()
        : 0;
      return (now - lastFailed) / 1000 >= backoffSeconds;
    });

    if (toRecover.length) {
      await Promise.all(toRecover.map((item) =>
        base44.asServiceRole.entities.TonomoProcessingQueue.update(item.id, {
          status: 'pending',
          error_message: `Retrying (attempt ${(item.retry_count || 0) + 1})`,
        })
      ));
    }
  } catch (e) {
    console.error('recoverFailedItems error:', e.message);
  }
}

// Multi-appointment & lifecycle helpers
// Manage the set of appointment Google Calendar event IDs for a project.
// Returns whether this is a new (additional) appointment or an update to existing.
function trackAppointment(existingIdsJson, newEventId) {
  if (!newEventId) return { isNew: false, updatedIds: [] };
  let ids = [];
  try { ids = JSON.parse(existingIdsJson || '[]'); } catch { ids = []; }
  const isNew = !ids.includes(newEventId);
  if (isNew) ids = [...ids, newEventId];
  return { isNew, updatedIds: ids };
}

// Determine the safe review type based on current project state and incoming action
function determineReviewType(projectStatus, tonomoLifecycle, isAdditionalAppointment, originAction) {
  if (projectStatus === 'cancelled') return 'restoration';
  if (projectStatus === 'delivered') return 'reopened_after_delivery';
  if (isAdditionalAppointment) return 'additional_appointment';
  if (originAction === 'rescheduled') return 'rescheduled';
  return 'new_booking';
}

// Strip state, postcode, and country from an address.
// "123 Smith St, Paddington NSW 2021, Australia" → "123 Smith St, Paddington"
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
    // Part with state code — strip the state+postcode tail, keep suburb
    if (STATE_RE.test(part)) {
      const cleaned = part
        .replace(/\s+(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, '')
        .trim();
      if (cleaned.length > 0) stripped.push(cleaned);
      break; // stop — everything after the suburb is metadata
    }
    stripped.push(part);
  }
  return stripped.join(', ') || address;
}

// Extract suburb from address (reuses same logic as ProjectWeatherCard)
function extractSuburbFromAddress(address: string): string | null {
  if (!address) return null;
  const STATE_RE = /^(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i;
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
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const cleaned = part.replace(/\s+\d{4}$/, '').trim();
    if (cleaned.length > 0 && !STATE_RE.test(cleaned) && !POSTCODE_RE.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

// Detect (s) or (p) tier annotation in a Tonomo service name
function detectTierHint(serviceName: string): 'standard' | 'premium' | null {
  if (!serviceName) return null;
  if (/\(s\)\s*$/i.test(serviceName)) return 'standard';
  if (/\(p\)\s*$/i.test(serviceName)) return 'premium';
  return null;
}

// Look up the pricing tier for a booking flow by its Tonomo ID.
// Upserts the flow record for admin visibility. Returns 'standard' | 'premium' | null.
async function resolveBookingFlowTier(
  base44: any,
  bookingFlow: { id: string; name: string; type?: string } | null
): Promise<{ tier: 'standard' | 'premium' | null; isUnmapped: boolean }> {
  if (!bookingFlow?.id) return { tier: null, isUnmapped: false };

  const existing = await base44.asServiceRole.entities.TonomoBookingFlowTier
    .filter({ tonomo_flow_id: bookingFlow.id }, null, 1)
    .catch(() => []);

  const record = existing?.[0];

  if (record) {
    // Update seen metadata
    await base44.asServiceRole.entities.TonomoBookingFlowTier.update(record.id, {
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

  // First time seeing this flow — upsert with no tier yet
  await base44.asServiceRole.entities.TonomoBookingFlowTier.create({
    tonomo_flow_id: bookingFlow.id,
    tonomo_flow_name: bookingFlow.name || 'Unknown flow',
    tonomo_flow_type: bookingFlow.type || null,
    pricing_tier: null,
    last_seen_at: new Date().toISOString(),
    seen_count: 1,
  }).catch(() => {});

  return { tier: null, isUnmapped: true };
}

// Look up the FlexMedia project type for a Tonomo booking flow type.
// e.g. bookingFlow.type = "property" → Real Estate ProjectType ID
async function resolveProjectTypeFromFlowType(
  base44: any,
  flowType: string | null
): Promise<{ projectTypeId: string | null; projectTypeName: string | null; isUnmapped: boolean }> {
  if (!flowType) return { projectTypeId: null, projectTypeName: null, isUnmapped: false };

  try {
    const mappings = await base44.asServiceRole.entities.TonomoProjectTypeMapping
      .list('-created_date', 50)
      .catch(() => []);

    // First try exact match on flow type
    const exactMatch = mappings.find((m: any) =>
      m.tonomo_flow_type?.toLowerCase() === flowType.toLowerCase()
    );
    if (exactMatch?.project_type_id) {
      // Update seen metadata
      base44.asServiceRole.entities.TonomoProjectTypeMapping.update(exactMatch.id, {
        last_seen_at: new Date().toISOString(),
        seen_count: (exactMatch.seen_count || 0) + 1,
      }).catch(() => {});
      return {
        projectTypeId: exactMatch.project_type_id,
        projectTypeName: exactMatch.project_type_name || null,
        isUnmapped: false,
      };
    }

    // Fall back to default mapping
    const defaultMapping = mappings.find((m: any) => m.is_default && m.project_type_id);
    if (defaultMapping) {
      return {
        projectTypeId: defaultMapping.project_type_id,
        projectTypeName: defaultMapping.project_type_name || null,
        isUnmapped: false,
      };
    }

    // No mapping found — upsert the flow type for admin to map
    const existingUnmapped = mappings.find((m: any) =>
      m.tonomo_flow_type?.toLowerCase() === flowType.toLowerCase() && !m.project_type_id
    );
    if (!existingUnmapped) {
      base44.asServiceRole.entities.TonomoProjectTypeMapping.create({
        tonomo_flow_type: flowType,
        project_type_id: null,
        project_type_name: null,
        is_default: false,
        last_seen_at: new Date().toISOString(),
        seen_count: 1,
      }).catch(() => {});
    } else {
      base44.asServiceRole.entities.TonomoProjectTypeMapping.update(existingUnmapped.id, {
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
// Detect what type of booking this is based on service names
function detectBookingTypes(serviceNames) {
  const names = serviceNames.map((s) => s.toLowerCase());
  const isVideoBooking    = names.some(n => n.includes('video') || n.includes('reel') || n.includes('footage'));
  const isDroneBooking    = names.some(n => n.includes('drone'));
  const isFloorPlanBooking = names.some(n => n.includes('floor') || n.includes('floorplan'));
  const isPhotoBooking    = !isVideoBooking || names.some(n =>
    n.includes('image') || n.includes('photo') || n.includes('sales') || n.includes('rental')
  );
  return { isVideoBooking, isDroneBooking, isFloorPlanBooking, isPhotoBooking };
}

// Smart staff assignment — uses booking type as the primary signal for role placement.
// Rules:
//   Single person  → role determined entirely by booking type
//   Multiple people → declared role from mapping takes priority;
//                     booking type resolves ties and handles undeclared roles
//
// Drone is always performed by a photographer — never a separate role.
// Photo+Video requires 2 people; if only 1 is assigned for both, human assigns manually.
function assignStaffToProjectFields(resolvedPhotographers, bookingTypes) {
  const fields = {
    project_owner_id:   null,
    photographer_id:    null,
    videographer_id:    null,
    // Legacy aliases — kept for backward compat with older parts of the system
    onsite_staff_1_id:  null,
    onsite_staff_2_id:  null,
  };

  if (resolvedPhotographers.length === 0) return fields;

  // ── Single person ──────────────────────────────────────────────────────────
  if (resolvedPhotographers.length === 1) {
    const person = resolvedPhotographers[0];
    fields.project_owner_id = person.userId;

    // Assign to the correct role slot based on booking type
    // Drone is a photography service → photographer slot
    if (bookingTypes.isVideoBooking && !bookingTypes.isPhotoBooking) {
      // Pure video booking → videographer
      fields.videographer_id   = person.userId;
      fields.onsite_staff_2_id = person.userId; // legacy alias
    } else {
      // Photo, drone, floor plan, or mixed → photographer
      fields.photographer_id   = person.userId;
      fields.onsite_staff_1_id = person.userId; // legacy alias
    }
    return fields;
  }

  // ── Multiple people ────────────────────────────────────────────────────────
  // Separate into onsite staff (those going to the shoot) vs others
  const onsiteRoles  = ['photographer', 'videographer', 'drone_operator', 'floor_plan', null];
  const onsiteStaff  = resolvedPhotographers.filter(p => onsiteRoles.includes(p.role));
  const nonOnsite    = resolvedPhotographers.filter(p => !onsiteRoles.includes(p.role));

  // Find explicitly declared photographers and videographers
  const declaredPhotographer = onsiteStaff.find(p =>
    p.role === 'photographer' || p.role === 'drone_operator' || p.role === 'floor_plan'
  );
  const declaredVideographer = onsiteStaff.find(p => p.role === 'videographer');
  const undeclared = onsiteStaff.filter(p =>
    p !== declaredPhotographer && p !== declaredVideographer
  );

  // Build the onsite assignment list
  const toAssign = [];

  if (declaredPhotographer) toAssign.push({ ...declaredPhotographer, assignedRole: 'photographer' });
  if (declaredVideographer) toAssign.push({ ...declaredVideographer, assignedRole: 'videographer' });

  // Undeclared people: use booking type to determine their slot
  for (const person of undeclared) {
    if (bookingTypes.isVideoBooking && !fields.videographer_id && !declaredVideographer) {
      toAssign.push({ ...person, assignedRole: 'videographer' });
    } else {
      toAssign.push({ ...person, assignedRole: 'photographer' });
    }
  }

  // Assign project_owner to first onsite person (highest priority by declaration order)
  const firstOnsite = toAssign[0];
  if (firstOnsite) {
    fields.project_owner_id = firstOnsite.userId;
  }

  // Assign specific role slots
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

// Main router
async function processItem(
  base44,
  item,
  payload
) {
  const action = item.action;
  const orderId = item.order_id || extractOrderIdFromPayload(payload);

  // Safety: never process items without an orderId — they can't be matched to a project
  if (!orderId) {
    await writeAudit(base44, {
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

  if (action === 'scheduled') return handleScheduled(base44, orderId, payload, 'scheduled');
  if (action === 'rescheduled') return handleRescheduled(base44, orderId, payload);
  if (action === 'canceled') return handleCancelled(base44, orderId, payload);
  if (action === 'changed' && isOrderCancelled) return handleCancelled(base44, orderId, payload);
  if (action === 'changed') return handleChanged(base44, orderId, payload);
  if (action === 'booking_created_or_changed' && isOrderCancelled) return handleCancelled(base44, orderId, payload);
  if (action === 'booking_created_or_changed') return handleOrderUpdate(base44, orderId, payload);
  if (action === 'booking_completed') return handleDelivered(base44, orderId, payload);
  if (action === 'new_customer') return handleNewCustomer(base44, payload);

  return { summary: `Skipped unknown action: ${action}`, skipped: true };
}

// Handlers
async function handleScheduled(base44, orderId, p, originAction = 'scheduled') {
  const eventId = p.id; // Google Calendar event ID for THIS appointment
  const orderName = p.order?.orderName || p.orderName || 'Unknown order';
  const address = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address || '';
  const photographers = p.photographers || [];
  const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;
  const startTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  const bookingFlowObj = p.order?.bookingFlow || null;
  const flowType = bookingFlowObj?.type || null;
  const isFirstOrder = p.isFirstOrder || p.order?.isFirstOrder || false;
  const brokerageCode = p.brokerage_code || p.order?.brokerage_code || null;

  const allMappings = await loadMappingTable(base44);

  const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
  const servicesB = p.order?.services || p.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

  const { agentId, resolvedPhotographers, unresolvedPhotographers, mappingConfidence, mappingGaps } =
    await resolveMappingsMulti(base44, { agent, photographers }, allMappings);

  const serviceIds = p.serviceIds || [];
  const serviceAssignmentUncertain = serviceIds.length === 0 && services.length > 0;

  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || [])
    .map((t) => ({ name: t.serviceName, selected: t.selected?.name }));

  const existing = await findProjectByOrderId(base44, orderId);

  // ── MULTI-APPOINTMENT TRACKING ──────────────────────────────────────────────
  const { isNew: isAdditionalAppointment, updatedIds: allAppointmentIds } = trackAppointment(
    existing?.tonomo_appointment_ids,
    eventId
  );

  // ── LIFECYCLE SAFETY CHECK ──────────────────────────────────────────────────
  // Never silently modify cancelled or delivered projects — always flag for review
  const lifecycleReversalDetected =
    existing && (existing.status === 'cancelled' || existing.status === 'delivered');

  // Resolve staff to project fields (role-aware)
  let staffAssignment = {};
  if (resolvedPhotographers.length > 0) {
    const bookingTypes = detectBookingTypes(services);
    staffAssignment = assignStaffToProjectFields(resolvedPhotographers, bookingTypes);
  }

  // Resolve products from tiers
  const rawTiers = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  const {
    autoProducts, autoPackages, mappingGaps: productMappingGaps, allConfirmed: allProductsMapped,
  } = await resolveProductsFromTiers(base44, rawTiers, allMappings);
  const hasAutoProducts = autoProducts.length > 0 || autoPackages.length > 0;
  const productGapNames = productMappingGaps.map((g) => g.serviceName);

  // ── AUTO-APPROVAL ELIGIBILITY ───────────────────────────────────────────────
  const _settings = await safeList(base44, 'TonomoIntegrationSettings', 1);
  const _s = _settings?.[0];
  const autoApproveEnabled = _s?.auto_approve_enabled === true;
  const autoApproveOnImminent = _s?.auto_approve_on_imminent !== false; // default true

  // Determine if this booking qualifies for auto-approval:
  // - auto_approve_enabled must be on
  // - mapping confidence must be 'full'
  // - no product mapping gaps
  // - photographer resolved
  // - project type mapped
  // - booking flow mapped (has a pricing tier)
  // - NOT a lifecycle reversal (cancellation restoration / re-delivery)
  // - NOT an additional appointment on an active project
  // - NOT urgent (< 24h to shoot) unless auto_approve_on_imminent is also on

  // ── BUILD SHARED DATA ───────────────────────────────────────────────────────
  // Resolve booking flow pricing tier
  const { tier: flowTier, isUnmapped: flowUnmapped } = await resolveBookingFlowTier(base44, bookingFlowObj);

  // Resolve project type from booking flow type
  const { projectTypeId, projectTypeName, isUnmapped: typeUnmapped } =
    await resolveProjectTypeFromFlowType(base44, flowType);

  // Build title from address (strips state/postcode/country)
  const strippedAddress = stripAddressTail(address) || address;
  const projectSuburb = extractSuburbFromAddress(address);

  const sharedData: Record<string, any> = {
    title: strippedAddress,
    property_address: address,
    property_suburb: projectSuburb || null,
    source: 'tonomo',
    tonomo_order_id: orderId,
    tonomo_event_id: eventId,
    tonomo_google_event_id: eventId, // primary appointment
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

  // Add flow unmapped flag to pending_review_reason via buildReviewReason
  if (flowUnmapped) {
    sharedData._flow_unmapped = true; // flag read by buildReviewReason below
  }

  if (typeUnmapped) {
    sharedData._type_unmapped = true;
  }

  if (p.order?.deliverable_link) sharedData.tonomo_deliverable_link = p.order.deliverable_link;
  if (p.order?.deliverable_path) sharedData.tonomo_deliverable_path = p.order.deliverable_path;
  if (agentId) sharedData.agent_id = agentId;

  // Apply role-aware staff assignment
  for (const [field, userId] of Object.entries(staffAssignment)) {
    if (userId) sharedData[field] = userId;
  }

  // Finalize canAutoApprove decision NOW that we have all the data
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

  // Apply products if confirmed mappings exist
  if (hasAutoProducts) {
    const [allProdsSched, allPkgsSched] = await Promise.all([
      base44.asServiceRole.entities.Product.list(null, 500).catch(() => []),
      base44.asServiceRole.entities.Package.list(null, 200).catch(() => []),
    ]);
    const deduped = deduplicateProjectItems(autoProducts, autoPackages, allProdsSched, allPkgsSched);
    sharedData.products = deduped.products;
    sharedData.packages = deduped.packages;
  }

  // Shoot date + time: set from appointment start time in Sydney timezone
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
      // Recalculate earliest upcoming from all appointment CalendarEvents
      const existingCalEvents = await base44.asServiceRole.entities.CalendarEvent.list('-start_time', 200)
        .catch(() => []);
      const projectEvents = existingCalEvents.filter(
        (ev) => ev.project_id === existing.id && !ev.is_done
      );
      const futureTimes = [
        startTime,
        ...projectEvents
          .map((ev) => {
            const t = ev.start_time ? new Date(ev.start_time.endsWith('Z') ? ev.start_time : ev.start_time + 'Z').getTime() : 0;
            return t > Date.now() ? t : 0;
          })
          .filter(Boolean),
      ].filter(t => t > Date.now());

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
    // NEW PROJECT
    const autoStatus = sharedData.shoot_date ? 'scheduled' : 'to_be_scheduled';

    project = await base44.asServiceRole.entities.Project.create({
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
    });
    operation = 'created';

  } else if (lifecycleReversalDetected) {
    // LIFECYCLE REVERSAL — cancelled or delivered project getting a new appointment
    const reviewType = determineReviewType(existing.status, existing.tonomo_lifecycle_stage, isAdditionalAppointment, originAction);
    const reversalReason = existing.status === 'cancelled'
      ? `Booking restored in Tonomo — new appointment scheduled after cancellation. Previous status: cancelled. Please review and re-approve to re-enter workflow.`
      : `New appointment added to a delivered booking. Previous status: delivered. Please review — this may indicate a re-shoot or correction booking.`;

    const overriddenFields = JSON.parse(existing.manually_overridden_fields || '[]');
    const safeData = filterOverriddenFields(sharedData, overriddenFields);

    await base44.asServiceRole.entities.Project.update(existing.id, {
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
    // ADDITIONAL APPOINTMENT on active project
    const overriddenFields = JSON.parse(existing.manually_overridden_fields || '[]');
    const safeData = filterOverriddenFields(sharedData, overriddenFields);

    // For additional appointments, DO flag for review (new shoot to coordinate)
    // but only if project is currently active (not already in pending_review)
    if (ACTIVE_STAGES.includes(existing.status)) {
      safeData.status = 'pending_review';
      safeData.pending_review_type = 'additional_appointment';
      safeData.pending_review_reason = `Additional appointment added to booking: ${new Date(startTime).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short' })}${photographers[0] ? ` — ${photographers[0].name}` : ''}. Review and re-approve.`;
      safeData.pre_revision_stage = existing.status;
    } else {
      // Already in pending_review — just update the data
      delete safeData.status;
    }

    await base44.asServiceRole.entities.Project.update(existing.id, safeData);
    project = { ...existing, ...safeData };
    operation = 'additional_appointment';

  } else {
    // UPDATE to existing appointment
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

    await base44.asServiceRole.entities.Project.update(existing.id, safeData);
    project = { ...existing, ...safeData };
    operation = 'updated';
  }

  // ── CREATE CALENDAR EVENT FOR THIS APPOINTMENT ──────────────────────────────
  // Each appointment gets its own CalendarEvent linked to the project.
  // Do NOT create duplicates — check by google_event_id.
  if (eventId && startTime) {
    try {
      const existingCalEvents = await base44.asServiceRole.entities.CalendarEvent.list('-start_time', 200)
        .catch(() => []);
      const alreadyExists = existingCalEvents.some(
        (ev) => ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId
      );

      if (!alreadyExists) {
        const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
        // Assign photographer to THIS specific appointment's CalendarEvent
        const appointmentOwner = staffAssignment.project_owner_id || null;

        await base44.asServiceRole.entities.CalendarEvent.create({
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
          attendees: JSON.stringify(photographers.map((ph) => ({
            name: ph.name, email: ph.email, tonomoId: ph.id
          }))),
          activity_type: 'shoot',
          is_synced: false, // Will be updated to true when Google Calendar syncs
          is_done: false,
          auto_linked: true,
          link_source: 'tonomo_webhook',
          link_confidence: 'exact',
          event_source: 'tonomo',
          calendar_account: photographers[0]?.email || 'tonomo',
        });
      } else {
        // Update existing CalendarEvent with latest time info
        const toUpdate = existingCalEvents.find(
          (ev) => ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId
        );
        if (toUpdate) {
          const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
          await base44.asServiceRole.entities.CalendarEvent.update(toUpdate.id, {
            start_time: new Date(startTime).toISOString(),
            end_time: endTime ? new Date(endTime).toISOString() : null,
            project_id: project.id,
            event_source: 'tonomo',
          });
        }
      }
    } catch (calErr) {
      console.error('CalendarEvent creation failed (non-fatal):', calErr.message);
    }
  }

  await writeAudit(base44, {
    action: originAction,
    entity_type: 'Project',
    entity_id: project.id,
    operation,
    tonomo_order_id: orderId,
    tonomo_event_id: eventId,
    notes: [
      `Photographers: ${photographers.map((ph) => ph.name).join(', ') || 'none'}`,
      `Unresolved: ${unresolvedPhotographers.join(', ') || 'none'}`,
      `Agent: ${agent?.displayName || 'none'}`,
      `Confidence: ${mappingConfidence}`,
      `Gaps: ${[...mappingGaps, ...productGapNames].join(', ') || 'none'}`,
      `Additional appointment: ${isAdditionalAppointment}`,
      `Lifecycle reversal: ${lifecycleReversalDetected}`,
      `Products applied: ${autoProducts.length} products, ${autoPackages.length} packages`,
    ].join(' | '),
  });

  await writeProjectActivity(base44, {
    project_id: project.id,
    project_title: project.title || project.property_address || '',
    action: operation === 'created' ? 'tonomo_booking_created' : 'tonomo_booking_updated',
    description: operation === 'created'
      ? `Project created from Tonomo booking. Order: ${orderId}. Mapping confidence: ${mappingConfidence}.${isAdditionalAppointment ? ' Additional appointment added.' : ''}${lifecycleReversalDetected ? ' ⚠️ Lifecycle reversal detected.' : ''}`
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

  // If auto-approved, fire role defaults + task gen immediately + notification
  if (canAutoApprove && project?.id) {
    const autoStatus = sharedData.shoot_date ? 'scheduled' : 'to_be_scheduled';

    base44.asServiceRole.functions.invoke('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch((err) => {
      console.warn('applyProjectRoleDefaults after auto-approve failed (non-fatal):', err?.message);
    });

    // Wire stage change engine so notifications and deadlines fire
    base44.asServiceRole.functions.invoke('trackProjectStageChange', {
      projectId: project.id,
      old_data: { status: 'pending_review' },
      actor_id: null,
      actor_name: 'Auto-Approve',
    }).catch(() => {});

    // Fire the booking_auto_approved notification
    const notifProjectName = sharedData.title || address;
    fireAdminNotif(base44, {
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

    // Log auto-approval in ProjectActivity
    await writeProjectActivity(base44, {
      project_id: project.id,
      project_title: project.title || address,
      action: 'tonomo_booking_created',
      description: `Project auto-approved (full confidence mapping, all fields resolved). Status: ${autoStatus.replace(/_/g, ' ')}.`,
      tonomo_order_id: orderId,
      tonomo_event_type: 'auto_approved',
      metadata: { auto_approved: true, mapping_confidence: mappingConfidence },
    });
  }

  // Fire notifications for this booking event (non-blocking)
  const notifProjectId = project.id;
  const notifProjectName = strippedAddress || address;
  if (notifProjectId) {
    const isNewBooking = !existing;
    const hasUrgent = sharedData.urgent_review;
    const hasMappingGaps = productGapNames.length > 0 || mappingGaps.length > 0;
    const noPhotographer = unresolvedPhotographers.length > 0 || !sharedData.photographer_id;

    fireAdminNotif(base44, {
      type: 'booking_arrived_pending_review',
      category: 'tonomo',
      severity: hasUrgent ? 'critical' : 'info',
      title: hasUrgent ? `⚡ Urgent booking — ${notifProjectName}` : `New booking arrived — ${notifProjectName}`,
      message: `${isNewBooking ? 'New Tonomo booking' : 'Updated booking'} is pending review.${hasUrgent ? ' Shoot is within 24 hours.' : ''}`,
      projectId: notifProjectId,
      projectName: notifProjectName,
      ctaLabel: 'Review Booking',
      source: 'tonomo',
      idempotencyKey: `booking_arrived:${orderId}:${Date.now().toString().slice(0,-4)}`,
    }).catch(() => {});

    if (hasMappingGaps) {
      fireAdminNotif(base44, {
        type: 'booking_mapping_gaps',
        category: 'tonomo',
        severity: 'warning',
        title: `Mapping gaps — ${notifProjectName}`,
        message: `${productGapNames.length} unmapped service(s): ${productGapNames.slice(0,3).join(', ')}${productGapNames.length > 3 ? '…' : ''}. Products not applied.`,
        projectId: notifProjectId,
        projectName: notifProjectName,
        ctaLabel: 'Fix Mappings',
        source: 'tonomo',
        idempotencyKey: `mapping_gaps:${orderId}`,
      }).catch(() => {});
    }

    if (noPhotographer) {
      fireAdminNotif(base44, {
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
      fireAdminNotif(base44, {
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
      fireAdminNotif(base44, {
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

  // ── Trigger role defaults + task generation ──────────────────────────────
  // NOTE: For NEW projects that are auto-approved, role defaults are already invoked above.
  // For existing projects (updates/reschedules/changes) that don't go to pending_review, fire role defaults.
  const willBePendingReview = (project.status === 'pending_review') || lifecycleReversalDetected || (isAdditionalAppointment && ACTIVE_STAGES.includes(existing?.status));
  if (!willBePendingReview && existing) {
    base44.asServiceRole.functions.invoke('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch((err) => {
      console.error('applyProjectRoleDefaults fire-and-forget failed:', err.message);
    });
  }

  return {
    summary: `Project ${operation} (via ${originAction}): ${orderName} | Confidence: ${mappingConfidence}${isAdditionalAppointment ? ' | ADDITIONAL APPOINTMENT' : ''}${lifecycleReversalDetected ? ' | LIFECYCLE REVERSAL' : ''}`
  };
}

async function handleRescheduled(base44, orderId, p) {
  const eventId = p.id;
  const startTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  const project = await findProjectByOrderId(base44, orderId);
  if (!project) return handleScheduled(base44, orderId, p, 'rescheduled');

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const updates = {};
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

  await base44.asServiceRole.entities.Project.update(project.id, updates);

  // Update the CalendarEvent for this specific appointment
  if (eventId && startTime) {
    try {
      const existingCalEvents = await base44.asServiceRole.entities.CalendarEvent.list('-start_time', 200)
        .catch(() => []);
      const appointmentEvent = existingCalEvents.find(
        (ev) => (ev.google_event_id === eventId || ev.tonomo_appointment_id === eventId) &&
                     ev.project_id === project.id
      );
      if (appointmentEvent) {
        const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
        await base44.asServiceRole.entities.CalendarEvent.update(appointmentEvent.id, {
          start_time: new Date(startTime).toISOString(),
          end_time: endTime ? new Date(endTime).toISOString() : null,
        });
      }
    } catch (calErr) {
      console.error('CalendarEvent reschedule update failed (non-fatal):', calErr.message);
    }
  }
  await writeAudit(base44, {
    action: 'rescheduled', entity_type: 'Project', entity_id: project.id, operation: 'updated',
    tonomo_order_id: orderId, tonomo_event_id: eventId,
    notes: `Rescheduled from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'}. Urgent: ${updates.urgent_review ?? false}`,
  });

  await writeProjectActivity(base44, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_rescheduled',
    description: `Shoot rescheduled in Tonomo from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'}.${updates.urgent_review ? ' ⚠️ Shoot is within 24 hours.' : ''}`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'rescheduled',
    metadata: { previous_date: previousShootDate, new_date: updates.shoot_date },
  });

  // Notify photographer + owner of reschedule
  const reschedProjectName = project.title || project.property_address || 'Project';
  fireRoleNotif(base44, ['photographer', 'project_owner'], {
    type: 'booking_rescheduled',
    category: 'tonomo',
    severity: updates.urgent_review ? 'critical' : 'info',
    title: `Shoot rescheduled — ${reschedProjectName}`,
    message: `Rescheduled from ${previousShootDate || 'unknown'} to ${updates.shoot_date || 'unknown'}.${updates.urgent_review ? ' ⚡ Within 24 hours.' : ''}`,
    projectId: project.id,
    projectName: reschedProjectName,
    ctaLabel: 'View Project',
    source: 'tonomo',
    idempotencyKey: `rescheduled:${orderId}:${updates.shoot_date}`,
  }, project).catch(() => {});

  return { summary: `Rescheduled project for order ${orderId}` };
}

async function handleChanged(base44, orderId, p) {
  const photographers = p.photographers || [];
  const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;
  const project = await findProjectByOrderId(base44, orderId);
  if (!project) return handleScheduled(base44, orderId, p, 'changed');

  if (project.status === 'cancelled') {
    await writeAudit(base44, { action: 'changed', entity_type: 'Project', entity_id: project.id, operation: 'skipped', tonomo_order_id: orderId, notes: 'Skipped — project already cancelled' });
    return { summary: `Skipped changed for cancelled project ${orderId}`, skipped: true };
  }

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const updates = {};
  const reviewReasons = [];
  const allMappings = await loadMappingTable(base44);

  const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
  const servicesB = p.order?.services || p.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

  if (photographers.length > 0) {
    updates.tonomo_photographer_ids = JSON.stringify(photographers);
    const { resolvedPhotographers, unresolvedPhotographers } = await resolveMappingsMulti(base44, { photographers }, allMappings);
    
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
    const { agentId } = await resolveMappingsMulti(base44, { agent }, allMappings);
    if (agentId && !overriddenFields.includes('agent_id')) updates.agent_id = agentId;
    else if (!agentId) reviewReasons.push(`Agent reassigned to "${agent.displayName || agent.email || 'unknown'}" but not found — manual assignment required`);
  }

  if (services.length > 0 && !overriddenFields.includes('tonomo_raw_services')) {
    if (ACTIVE_STAGES.includes(project.status)) {
      const prev = JSON.parse(project.tonomo_raw_services || '[]');
      const added = services.filter((s) => !prev.includes(s));
      const removed = prev.filter((s) => !services.includes(s));
      if (added.length > 0 || removed.length > 0) {
        reviewReasons.push(`Services changed during active production${added.length ? ` — added: ${added.join(', ')}` : ''}${removed.length ? ` — removed: ${removed.join(', ')}` : ''} — please confirm billing`);
        if (project.status !== 'pending_review') updates.pending_review_type = 'service_change';
      }
    }
    updates.tonomo_raw_services = JSON.stringify(services);
  }
  
  // Update the CalendarEvent for this appointment with new attendees
  const appointmentEventId = p.id;
  if (appointmentEventId && Object.keys(updates).length > 0) {
    try {
      const existingCalEvents = await base44.asServiceRole.entities.CalendarEvent.list('-start_time', 200)
        .catch(() => []);
      const appointmentEvent = existingCalEvents.find(
        (ev) => (ev.google_event_id === appointmentEventId || ev.tonomo_appointment_id === appointmentEventId) &&
                     ev.project_id === project.id
      );
      if (appointmentEvent) {
        const calUpdates = {};
        if (updates.project_owner_id) calUpdates.owner_user_id = updates.project_owner_id;
        if (updates.agent_id) calUpdates.agent_id = updates.agent_id;
        if (updates.agency_id) calUpdates.agency_id = updates.agency_id;
        if (photographers.length > 0) {
          calUpdates.attendees = JSON.stringify(photographers.map((ph) => ({
            name: ph.name, email: ph.email, tonomoId: ph.id
          })));
        }
        calUpdates.event_source = 'tonomo'; // ensure source is always set
        await base44.asServiceRole.entities.CalendarEvent.update(appointmentEvent.id, calUpdates);
        }
        } catch (calErr) {
        console.error('CalendarEvent staff update failed (non-fatal):', calErr.message);
        }
        }

  // Ensure Dropbox path is saved/updated if present in webhook
  const changedDeliverablePath = p.order?.deliverable_path || p.deliverable_path;
  if (changedDeliverablePath && !overriddenFields.includes('tonomo_deliverable_path')) {
    updates.tonomo_deliverable_path = changedDeliverablePath;
  }
  const changedDeliverableLink = p.order?.deliverable_link || p.deliverable_link;
  if (changedDeliverableLink && !overriddenFields.includes('tonomo_deliverable_link')) {
    updates.tonomo_deliverable_link = changedDeliverableLink;
  }

  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || []).map((t) => ({ name: t.serviceName, selected: t.selected?.name }));
  if (tiers.length > 0 && !overriddenFields.includes('tonomo_service_tiers')) updates.tonomo_service_tiers = JSON.stringify(tiers);

  // Re-evaluate pricing tier if booking flow is present
  const changedBookingFlow = p.order?.bookingFlow || null;
  if (changedBookingFlow?.id && !overriddenFields.includes('pricing_tier')) {
    const { tier: newFlowTier } = await resolveBookingFlowTier(base44, changedBookingFlow);
    if (newFlowTier && newFlowTier !== project.pricing_tier) {
      updates.pricing_tier = newFlowTier;
      updates.tonomo_booking_flow = changedBookingFlow.name || project.tonomo_booking_flow;
      updates.tonomo_booking_flow_id = changedBookingFlow.id;
      reviewReasons.push(`Pricing tier updated to ${newFlowTier} based on booking flow "${changedBookingFlow.name}"`);
    }
  }

  // Re-evaluate project type if booking flow type changed
  const changedFlowType = changedBookingFlow?.type || null;
  if (changedFlowType && !overriddenFields.includes('project_type_id')) {
    const { projectTypeId: newTypeId, projectTypeName: newTypeName } =
      await resolveProjectTypeFromFlowType(base44, changedFlowType);
    if (newTypeId && newTypeId !== project.project_type_id) {
      updates.project_type_id = newTypeId;
      updates.project_type_name = newTypeName;
    }
  }

  // Re-resolve products with updated quantities from the changed webhook
  const rawTiersChanged = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  if (rawTiersChanged.length > 0 && !overriddenFields.includes('products')) {
    const allMappingsForProducts = await loadMappingTable(base44);
    const { autoProducts: newProducts, autoPackages: newPackages, mappingGaps: newGaps } =
      await resolveProductsFromTiers(base44, rawTiersChanged, allMappingsForProducts);

    if (newProducts.length > 0 || newPackages.length > 0) {
      const dedupedChanged = deduplicateProjectItems(newProducts, newPackages,
        await base44.asServiceRole.entities.Product.list(null, 500).catch(() => []),
        await base44.asServiceRole.entities.Package.list(null, 200).catch(() => [])
      );
      updates.products = dedupedChanged.products;
      updates.packages = dedupedChanged.packages;
      updates.products_auto_applied = true;
      updates.products_needs_recalc = true;
      updates.products_mapping_gaps = JSON.stringify(newGaps.map((g) => g.serviceName));

      // Flag for review if quantities changed on an active project
      if (ACTIVE_STAGES.includes(project.status)) {
        const prevProducts = project.products || [];
        const qtyChanged = newProducts.some((np) => {
          const prev = prevProducts.find((pp) => pp.product_id === np.product_id);
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

  if (Object.keys(updates).length) await base44.asServiceRole.entities.Project.update(project.id, updates);

  await writeAudit(base44, {
    action: 'changed', entity_type: 'Project', entity_id: project.id,
    operation: Object.keys(updates).length ? 'updated' : 'no_changes',
    tonomo_order_id: orderId,
    notes: [`Photographers: ${photographers.map((ph) => ph.name).join(', ') || 'none'}`, `Agent: ${agent?.displayName || 'none'}`, `Review flags: ${reviewReasons.join('; ') || 'none'}`].join(' | '),
  });

  await writeProjectActivity(base44, {
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

  // Notify on service / product changes
  if (updates.products || updates.packages) {
    const changedProjectName = project.title || project.property_address || 'Project';
    fireRoleNotif(base44, ['project_owner', 'master_admin'], {
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

  // Products changed — trigger full engine refresh on next approval
  // The project is moving to pending_review (set above in reviewReasons).
  // On re-approval, applyProjectRoleDefaults will:
  //   1. syncProjectTasksFromProducts (creates tasks for added products)
  //   2. syncOnsiteEffortTasks (updates onsite durations)
  //   3. recalculateProjectPricingServerSide (updates price from matrix)
  //
  // Additionally: soft-delete tasks for products/packages no longer on the order.
  if (updates.products || updates.packages) {
    // Fire cleanup of tasks for removed products (non-blocking)
    base44.asServiceRole.functions.invoke('cleanupOrphanedProjectTasks', {
      project_id: project.id,
    }).catch(() => { /* non-fatal */ });

    // Note: applyProjectRoleDefaults is NOT fired here because the project
    // is moving to pending_review — task generation is gated on active status.
    // It will fire correctly from TonomoTab on re-approval.
  }

  return { summary: `Updated project for changed order ${orderId}` };
}

async function handleCancelled(base44, orderId, p) {
  const project = await findProjectByOrderId(base44, orderId);
  if (!project) return { summary: `No project found for cancelled order ${orderId}`, skipped: true };

  const updates = {
    status: 'pending_review',
    pending_review_type: 'cancellation',
    pending_review_reason: 'Cancellation received from Tonomo — confirm to mark as cancelled, or dismiss if incorrect.',
    tonomo_order_status: 'cancelled',
    tonomo_lifecycle_stage: 'cancelled',
  };
  if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;

  await base44.asServiceRole.entities.Project.update(project.id, updates);
  await writeAudit(base44, {
    action: 'canceled', entity_type: 'Project', entity_id: project.id, operation: 'cancelled',
    tonomo_order_id: orderId, notes: `Moved to pending_review for cancellation confirmation. Was: ${project.status}`,
  });

  await writeProjectActivity(base44, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_cancelled',
    description: `Cancellation received from Tonomo for order ${orderId}. Project moved to pending review — confirm to mark as cancelled.`,
    tonomo_order_id: orderId,
    tonomo_event_type: 'canceled',
  });

  // Notify on cancellation
  const cancelProjectName = project.title || project.property_address || 'Project';
  fireRoleNotif(base44, ['master_admin', 'project_owner'], {
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

async function handleOrderUpdate(base44, orderId, p) {
  const project = await findProjectByOrderId(base44, orderId);

  if (!project) {
    const orderName = p.order?.orderName || p.orderName || null;
    const address = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address || null;
    if (!orderName && !address) {
      await writeAudit(base44, { action: 'booking_created_or_changed', entity_type: 'Project', entity_id: null, operation: 'skipped', tonomo_order_id: orderId, notes: 'Payload too sparse to create project' });
      return { summary: `Skipped sparse order update for order ${orderId}`, skipped: true };
    }
    return handleScheduled(base44, orderId, p, 'booking_created_or_changed');
  }

  // Don't skip cancelled projects if the order is being restored
  const incomingStatus = p.orderStatus || p.order?.orderStatus;
  if (project.status === 'cancelled' && incomingStatus === 'cancelled') {
    return { summary: `Skipped order update for cancelled project ${orderId}`, skipped: true };
  }
  // If the order status changed away from cancelled, fall through to restoration logic below

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const updates = {};
  const reviewReasons = [];

  const servicesA = p.services_a_la_cart || p.order?.services_a_la_cart || [];
  const servicesB = p.services || p.order?.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);
  const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || []).map((t) => ({ name: t.serviceName, selected: t.selected?.name }));

  if (!overriddenFields.includes('tonomo_raw_services')) {
    if (ACTIVE_STAGES.includes(project.status) && services.length > 0) {
      const prev = JSON.parse(project.tonomo_raw_services || '[]');
      const added = services.filter((s) => !prev.includes(s));
      const removed = prev.filter((s) => !services.includes(s));
      if (added.length > 0 || removed.length > 0) reviewReasons.push(`Services changed during active production${added.length ? ` — added: ${added.join(', ')}` : ''}${removed.length ? ` — removed: ${removed.join(', ')}` : ''} — please confirm billing`);
    }
    updates.tonomo_raw_services = JSON.stringify(services);
  }
  if (!overriddenFields.includes('tonomo_service_tiers')) updates.tonomo_service_tiers = JSON.stringify(tiers);

  // Ensure Dropbox path is saved/updated
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
      // If project is currently cancelled, force it to pending_review
      if (project.status === 'cancelled') {
        updates.status = 'pending_review';
        updates.pre_revision_stage = 'cancelled';
        updates.pending_review_reason = 'Booking restored in Tonomo after cancellation. All details may have changed — please review and re-approve to re-enter workflow.';
      }
    }
  }

  // Re-resolve products with updated quantities
  const rawTiersBCC = p.order?.service_custom_tiers || p.service_custom_tiers || [];
  if (rawTiersBCC.length > 0 && !overriddenFields.includes('products')) {
    const allMappingsBCC = await loadMappingTable(base44);
    const { autoProducts: newProd, autoPackages: newPkg, mappingGaps: newGapsBCC } =
      await resolveProductsFromTiers(base44, rawTiersBCC, allMappingsBCC);
    if (newProd.length > 0 || newPkg.length > 0) {
      const dedupedBCC = deduplicateProjectItems(newProd, newPkg,
        await base44.asServiceRole.entities.Product.list(null, 500).catch(() => []),
        await base44.asServiceRole.entities.Package.list(null, 200).catch(() => [])
      );
      updates.products = dedupedBCC.products;
      updates.packages = dedupedBCC.packages;
      updates.products_auto_applied = true;
      updates.products_needs_recalc = true;
      updates.products_mapping_gaps = JSON.stringify(newGapsBCC.map((g) => g.serviceName));
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

  if (Object.keys(updates).length) await base44.asServiceRole.entities.Project.update(project.id, updates);

  await writeAudit(base44, {
    action: 'booking_created_or_changed', entity_type: 'Project', entity_id: project.id,
    operation: Object.keys(updates).length ? 'updated' : 'no_changes',
    tonomo_order_id: orderId,
    notes: `Services: ${services.length}. Invoice: $${p.invoice_amount ?? 'unchanged'}. OrderStatus: ${incomingStatus || 'unchanged'}`,
  });

  // Re-apply after product/service update
  if (updates.products || updates.packages) {
    base44.asServiceRole.functions.invoke('applyProjectRoleDefaults', {
      project_id: project.id,
    }).catch(() => { /* non-fatal */ });
  }

  return { summary: `Order update applied for ${orderId}` };
}

async function handleDelivered(base44, orderId, p) {
  const project = await findProjectByOrderId(base44, orderId);
  if (!project) return { summary: `No project found for delivery ${orderId}`, skipped: true };

  const overriddenFields = JSON.parse(project.manually_overridden_fields || '[]');
  const hasDeliverables = p.deliverable_link || (p.deliverablesLinks?.length > 0);

  const updates = {
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

  await base44.asServiceRole.entities.Project.update(project.id, updates);
  await writeAudit(base44, {
    action: 'booking_completed', entity_type: 'Project', entity_id: project.id, operation: 'updated',
    tonomo_order_id: orderId,
    notes: `Delivered: ${hasDeliverables ? 'yes' : 'NO LINKS'}. Files: ${p.deliverablesLinks?.length || 0}. Final invoice: $${p.invoice_amount ?? 'unknown'}`,
  });

  await writeProjectActivity(base44, {
    project_id: project.id,
    project_title: project.title || '',
    action: 'tonomo_delivered',
    description: `Delivery confirmed by Tonomo for order ${orderId}.${hasDeliverables ? ` Deliverable link received.` : ' ⚠️ No deliverable links — add manually.'}${p.invoice_amount ? ` Final invoice: $${p.invoice_amount}.` : ''}`,
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

async function handleNewCustomer(base44, p) {
  if (!p.user?.email) return { summary: 'New customer skipped — no email', skipped: true };

  const existing = await base44.asServiceRole.entities.Agent.filter({ email: p.user.email }, null, 1);
  if (existing?.length > 0) return { summary: `Customer already exists: ${p.user.email}`, skipped: true };

  const agent = await base44.asServiceRole.entities.Agent.create({
    name: p.user.name || p.user.email,
    email: p.user.email,
    phone: p.user.phone || null,
  });

  await writeAudit(base44, {
    action: 'new_customer', entity_type: 'Agent', entity_id: agent.id, operation: 'created',
    notes: `New customer from Tonomo: ${p.user.email}`,
  });
  return { summary: `New customer created: ${p.user.email}` };
}

// Resolution helpers
// Resolve Tonomo service_custom_tiers → FlexMedia products/packages with quantities.
// Uses serviceId as the stable mapping key (not service name).
// Only applies CONFIRMED mappings. Unconfirmed → auto-suggest + record as gap.
async function resolveProductsFromTiers(
  base44,
  tiers,
  allMappings
) {
  if (!tiers || tiers.length === 0) {
    return { autoProducts: [], autoPackages: [], mappingGaps: [], allConfirmed: true };
  }

  // Load all active products and packages once
  const [allProducts, allPackages] = await Promise.all([
    base44.asServiceRole.entities.Product.list('-updated_date', 500).catch(() => []),
    base44.asServiceRole.entities.Package.list('-updated_date', 200).catch(() => []),
  ]);

  const autoProducts = [];
  const autoPackages = [];
  const mappingGaps = [];

  for (const tier of tiers) {
    const serviceId = tier.serviceId;
    const serviceName = tier.serviceName || 'Unknown service';
    const selectedTierName = tier.selected?.name || '';
    const qty = extractQtyFromTierName(selectedTierName);

    if (!serviceId) {
      mappingGaps.push({ serviceId: 'unknown', serviceName });
      continue;
    }

    // Check for confirmed mapping (service)
    const confirmedService = allMappings.find(
      (m) => m.tonomo_id === serviceId &&
             m.mapping_type === 'service' &&
             m.is_confirmed === true &&
             m.flexmedia_entity_id
    );

    // Check for confirmed mapping (package)
    const confirmedPackage = allMappings.find(
      (m) => m.tonomo_id === serviceId &&
             m.mapping_type === 'package' &&
             m.is_confirmed === true &&
             m.flexmedia_entity_id
    );

    if (confirmedService) {
      const product = allProducts.find((p: any) => p.id === confirmedService.flexmedia_entity_id);
      const finalQty = clampQty(qty, product);
      const tierHint = detectTierHint(serviceName);

      // Store detected tier hint on the mapping record (non-blocking)
      if (tierHint && !confirmedService.detected_tier_hint) {
        base44.asServiceRole.entities.TonomoMappingTable.update(confirmedService.id, {
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
      // No confirmed mapping — auto-suggest by name match, record as gap
      mappingGaps.push({ serviceId, serviceName });

      // Try name match for auto-suggestion
      const nameMatchProduct = allProducts.find(
        (p) => p.name?.toLowerCase() === serviceName.toLowerCase() && p.is_active
      );
      const nameMatchPackage = allPackages.find(
        (p) => p.name?.toLowerCase() === serviceName.toLowerCase()
      );
      const nameMatch = nameMatchProduct || nameMatchPackage;
      const entityType = nameMatchProduct ? 'Product' : nameMatchPackage ? 'Package' : 'Product';
      const mappingType = nameMatchPackage ? 'package' : 'service';

      // Upsert mapping suggestion using serviceId as the stable key
      await upsertMappingSuggestion(
        base44,
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

  // Deduplicate (same product_id shouldn't appear twice)
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

async function resolveMappingsMulti(base44, { agent, photographers = [] }, allMappings) {
  let agentId = null;
  const resolvedPhotographers = [];
  const unresolvedPhotographers = [];
  const mappingGaps = [];
  let resolvedCount = 0;
  let totalCount = 0;

  if (agent) {
    totalCount++;
    const result = await resolveEntity(base44, agent.uid, agent.email, agent.displayName, 'agent', 'Agent', allMappings);
    if (result.entityId) { agentId = result.entityId; resolvedCount++; }
    else mappingGaps.push(`agent:${agent.email || agent.displayName || agent.uid}`);
  }

  for (const photographer of photographers) {
    totalCount++;
    const result = await resolveEntity(base44, photographer.id, photographer.email, photographer.name, 'photographer', 'User', allMappings);
    if (result.entityId) {
      // Get the confirmed mapping to read the role
      const confirmedMapping = allMappings.find(
        (m) => m.tonomo_id === photographer.id && m.mapping_type === 'photographer' && m.is_confirmed
      );
      resolvedPhotographers.push({
        name: photographer.name,
        userId: result.entityId,
        role: confirmedMapping?.primary_role || null,
      });
      resolvedCount++;

      // Update seen_count and last_seen_at on the mapping
      if (confirmedMapping) {
        try {
          await base44.asServiceRole.entities.TonomoMappingTable.update(confirmedMapping.id, {
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

async function resolveEntity(base44, tonomoUid, email, name, mappingType, entityDbName, allMappings) {
  if (!tonomoUid) return { entityId: null };

  const confirmed = allMappings.find((m) => m.tonomo_id === tonomoUid && m.mapping_type === mappingType && m.is_confirmed === true);
  if (confirmed) return { entityId: confirmed.flexmedia_entity_id };

  const nameField = entityDbName === 'User' ? 'full_name' : 'name';
  const allEntities = await base44.asServiceRole.entities[entityDbName].list('-created_date', 500);
  const byEmail = email ? allEntities?.filter((e) => e.email === email) : [];
  const byName = !byEmail?.length && name ? allEntities?.filter((e) => e[nameField]?.toLowerCase() === name.toLowerCase()) : [];
  const match = byEmail?.[0] || byName?.[0] || null;

  await upsertMappingSuggestion(base44, tonomoUid, name || email || tonomoUid, mappingType, entityDbName, match?.id || null, match?.[nameField] || null, match ? 'high' : 'low', allMappings);
  return { entityId: match?.id || null };
}

async function loadMappingTable(base44) {
  try { return await base44.asServiceRole.entities.TonomoMappingTable.list('-last_seen_at', 500) || []; } catch { return []; }
}

async function upsertMappingSuggestion(base44, tonomoId, tonomoLabel, mappingType, entityType, entityId, entityLabel, confidence, allMappings) {
  const existing = allMappings.filter((m) => m.tonomo_id === tonomoId && m.mapping_type === mappingType);
  const data = { tonomo_id: tonomoId, tonomo_label: tonomoLabel, mapping_type: mappingType, flexmedia_entity_type: entityType, flexmedia_entity_id: entityId, flexmedia_label: entityLabel, auto_suggested: true, confidence, last_seen_at: new Date().toISOString() };
  if (existing?.length > 0 && !existing[0].is_confirmed) await base44.asServiceRole.entities.TonomoMappingTable.update(existing[0].id, data);
  else if (!existing?.length) await base44.asServiceRole.entities.TonomoMappingTable.create(data);
}

async function findProjectByOrderId(base44, orderId) {
  if (!orderId) return null;
  try {
    const results = await base44.asServiceRole.entities.Project.filter({ tonomo_order_id: orderId }, null, 1);
    return results?.[0] || null;
  } catch { return null; }
}

function extractOrderIdFromPayload(p) {
  return p.orderId || p.order?.orderId || p.id || '';
}

// Utility helpers
// Extract leading integer from Tonomo tier name for quantity
// "10 Sales Images (S)" → 10
// "4 Drone Images (S)"  → 4
// "Floor & Site Plan"   → 1 (no leading number)
// "Standard Silver Package (S)" → 1
function extractQtyFromTierName(tierName) {
  const match = (tierName || '').match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

// Clamp quantity to product's min/max constraints
function clampQty(qty, product) {
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
  if (unmappedServices.length > 0) reasons.push(`Unmapped services (products not applied): ${unmappedServices.join(', ')} — confirm in Bookings Engine → Mappings`);
  if (flowUnmapped) reasons.push('Booking flow not mapped to a pricing tier — defaulting to standard. Set it in Settings → Tonomo Mappings → Booking Flows');
  if (typeUnmapped) reasons.push('Booking flow type not mapped to a project type — project type unset. Map it in Settings → Tonomo Mappings → Project Types');
  return reasons.join(' | ') || 'Auto-imported from Tonomo';
}

function filterOverriddenFields(data, overriddenFields) {
  if (!overriddenFields.length) return data;
  const result = { ...data };
  for (const field of overriddenFields) delete result[field];
  return result;
}

// Write a ProjectActivity entry that is clearly attributed to the Tonomo system.
// This surfaces in the main project activity feed with full context.
async function writeProjectActivity(
  base44,
  params
) {
  try {
    await base44.asServiceRole.entities.ProjectActivity.create({
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
  } catch (e) {
    console.error('writeProjectActivity failed:', e.message);
  }
}

async function writeAudit(base44, params) {
  try {
    await base44.asServiceRole.entities.TonomoAuditLog.create({ ...params, processor_version: PROCESSOR_VERSION, processed_at: new Date().toISOString() });
  } catch (e) { console.error('Audit log write failed:', e.message); }
}

async function releaseLock(base44, settings) {
  if (settings?.id) {
    try { await base44.asServiceRole.entities.TonomoIntegrationSettings.update(settings.id, { processing_lock_at: null }); }
    catch { /* self-expires after TTL */ }
  }
}

async function safeList(base44, entity, limit = 10) {
  try { return await base44.asServiceRole.entities[entity].list('-created_date', limit); } catch { return []; }
}

async function safeUpdate(base44, entity, data) {
  try {
    const items = await base44.asServiceRole.entities[entity].list('-created_date', 1);
    if (items?.[0]?.id) await base44.asServiceRole.entities[entity].update(items[0].id, data);
  } catch { /* silent */ }
}

// Notification helpers
async function fireAdminNotif(base44, params) {
  try {
    const users = await base44.asServiceRole.entities.User.list('-created_date', 200);
    const adminIds = users
      .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
      .map((u: any) => u.id);

    for (const userId of adminIds) {
      // Support idempotencyKeySuffix for dynamic suffix construction
      const idemKey = params.idempotencyKey 
        ? `${params.idempotencyKey}:${userId}`
        : params.idempotencyKeySuffix
        ? `${params.idempotencyKeySuffix}:${userId}`
        : null;
      await fireNotif(base44, { ...params, userId, idempotencyKey: idemKey });
    }
  } catch (e) {
    console.warn('fireAdminNotif error:', (e as any).message);
  }
}

async function fireRoleNotif(base44, roles: string[], params, project) {
  try {
    const ROLE_FIELDS: Record<string, string[]> = {
      project_owner: ['project_owner_id'],
      photographer: ['photographer_id', 'onsite_staff_1_id'],
      videographer: ['videographer_id', 'onsite_staff_2_id'],
      image_editor: ['image_editor_id'],
      video_editor: ['video_editor_id'],
      assigned_users: ['assigned_users'],
    };

    const ids = new Set<string>();
    for (const role of roles) {
      for (const field of (ROLE_FIELDS[role] || [])) {
        const val = (project as any)[field];
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
      await fireNotif(base44, { ...params, userId, idempotencyKey: idemKey });
    }
  } catch (e) {
    console.warn('fireRoleNotif error:', (e as any).message);
  }
}

async function fireNotif(base44, p) {
  try {
    // Deduplicate: skip if a notification with the same idempotency_key already exists
    if (p.idempotencyKey) {
      const existing = await base44.asServiceRole.entities.Notification.filter(
        { idempotency_key: p.idempotencyKey }, null, 1
      );
      if (existing.length > 0) return;
    }

    await base44.asServiceRole.entities.Notification.create({
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
  } catch (e) {
    console.warn('fireNotif error:', (e as any).message);
  }
}