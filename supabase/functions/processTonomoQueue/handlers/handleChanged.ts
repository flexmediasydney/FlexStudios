import { invokeFunction } from '../../_shared/supabase.ts';
import { ACTIVE_STAGES } from '../types.ts';
import {
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
  safeJsonParse,
  writeAudit,
  writeProjectActivity,
  fireRoleNotif,
} from '../utils.ts';

export interface HandlerContext {
  queueRowId?: string | null;
  webhookLogId?: string | null;
  eventType?: string | null;
}

export async function handleChanged(entities: any, orderId: string, p: any, ctx: HandlerContext = {}) {
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

  const overriddenFields = safeJsonParse(project.manually_overridden_fields, [] as string[]);
  const updates: Record<string, any> = {};
  const reviewReasons: string[] = [];
  const allMappings = await loadMappingTable(entities);

  // Track staff gaps discovered in this change event so they surface in
  // mapping_gaps — recheckMappingGaps needs them to re-resolve later.
  const changeStaffGaps: string[] = [];

  const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
  const servicesB = p.order?.services || p.services || [];
  const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

  if (photographers.length > 0) {
    updates.tonomo_photographer_ids = JSON.stringify(photographers);
    const { resolvedPhotographers, unresolvedPhotographers } = await resolveMappingsMulti(entities, { photographers }, allMappings);

    if (resolvedPhotographers.length > 0) {
      const bookingTypes = detectBookingTypes(services);
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
      reviewReasons.push(`Photographer(s) reassigned but not found: ${unresolvedPhotographers.join(', ')} — manual assignment required`);
      updates.pending_review_type = 'staff_change';
      // Record unresolved photographers as mapping_gaps so recheckMappingGaps
      // can re-resolve them once the operator links the mapping.
      for (const ph of photographers) {
        const name = ph.name || ph.email || ph.id;
        if (unresolvedPhotographers.includes(name) || unresolvedPhotographers.includes(ph.name)) {
          changeStaffGaps.push(`photographer:${ph.email || ph.name || ph.id}`);
        }
      }
    }
  }

  if (agent) {
    const { agentId } = await resolveMappingsMulti(entities, { agent }, allMappings);
    if (agentId && !overriddenFields.includes('agent_id')) {
      updates.agent_id = agentId;
      // Denormalize agent name and agency (matching handleScheduled pattern)
      try {
        const agentRecord = await entities.Agent.get(agentId);
        if (agentRecord) {
          updates.agent_name = agentRecord.name || null;
          let agencyIdToUse: string | null = agentRecord.current_agency_id || null;

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
                if (!agentRecord.current_agency_id) {
                  await entities.Agent.update(agentId, {
                    current_agency_id: match.id,
                    current_agency_name: match.name,
                  }).catch(() => {});
                }
              }
            }
          }

          if (agencyIdToUse) updates.agency_id = agencyIdToUse;
        }
      } catch { /* non-fatal */ }
    } else if (!agentId) {
      reviewReasons.push(`Agent reassigned to "${agent.displayName || agent.email || 'unknown'}" but not found — manual assignment required`);
      // Record the unresolved agent so recheckMappingGaps can re-resolve it
      // once the operator links the mapping.
      changeStaffGaps.push(`agent:${agent.email || agent.displayName || agent.uid}`);
    }
  }

  // Merge any unresolved-staff gaps into mapping_gaps. Preserve existing gaps
  // from earlier events (e.g. services) and deduplicate.
  if (changeStaffGaps.length > 0) {
    const existingGaps = safeJsonParse(project.mapping_gaps, [] as string[]);
    const merged = Array.from(new Set([...existingGaps, ...changeStaffGaps]));
    updates.mapping_gaps = JSON.stringify(merged);
    // Downgrade confidence so dashboards flag the project correctly.
    if (project.mapping_confidence === 'full') updates.mapping_confidence = 'partial';
  }

  // Update address if changed in Tonomo
  const changedAddress = p.address?.formatted_address || p.property_address?.formatted_address || p.location || p.order?.property_address?.formatted_address;
  if (changedAddress && !overriddenFields.includes('property_address')) {
    if (changedAddress !== project.property_address) {
      updates.property_address = changedAddress;
      const strippedAddr = stripAddressTail(changedAddress) || changedAddress;
      updates.title = strippedAddr;
      updates.property_suburb = extractSuburbFromAddress(changedAddress) || null;
      reviewReasons.push(`Address changed from "${project.property_address || 'unknown'}" to "${changedAddress}"`);
    }
  }

  if (services.length > 0 && !overriddenFields.includes('tonomo_raw_services')) {
    if (ACTIVE_STAGES.includes(project.status)) {
      const prev = safeJsonParse(project.tonomo_raw_services, [] as string[]);
      const added = services.filter((s: string) => !prev.includes(s));
      const removed = prev.filter((s: string) => !services.includes(s));
      if (added.length > 0 || removed.length > 0) {
        reviewReasons.push(`Services changed during active production${added.length ? ` — added: ${added.join(', ')}` : ''}${removed.length ? ` — removed: ${removed.join(', ')}` : ''} — please confirm billing`);
        updates.pending_review_type = 'service_change';
      }
    }
    updates.tonomo_raw_services = JSON.stringify(services);
  }

  // Backfill tonomo_appointment_ids and tonomo_event_id if missing
  // handleChanged receives the real appointment event ID in p.id
  const appointmentId = p.id;
  if (appointmentId && appointmentId !== orderId) {
    const existingAppts = safeJsonParse(project.tonomo_appointment_ids, [] as string[]);
    if (!existingAppts.includes(appointmentId)) {
      updates.tonomo_appointment_ids = JSON.stringify([...existingAppts, appointmentId]);
    }
    if (!project.tonomo_event_id) {
      updates.tonomo_event_id = appointmentId;
      updates.tonomo_google_event_id = appointmentId;
    }
  }

  // Update project shoot_date/shoot_time when appointment time changes
  const changedStartTime = p.when?.start_time ? p.when.start_time * 1000 : null;
  if (changedStartTime && !overriddenFields.includes('shoot_date')) {
    const dt = new Date(changedStartTime);
    updates.shoot_date = dt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    updates.shoot_time = dt.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  // Update CalendarEvent for this appointment (staff + time)
  const appointmentEventId = p.id;
  if (appointmentEventId) {
    try {
      const projectCalEvents = await entities.CalendarEvent.filter({ project_id: project.id }, '-start_time', 100).catch(() => []);
      const appointmentEvent = projectCalEvents.find(
        (ev: any) => ev.google_event_id === appointmentEventId || ev.tonomo_appointment_id === appointmentEventId
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
        // Update time if the webhook includes new start/end times
        if (changedStartTime) {
          calUpdates.start_time = new Date(changedStartTime).toISOString();
          const changedEndTime = p.when?.end_time ? p.when.end_time * 1000 : null;
          if (changedEndTime) calUpdates.end_time = new Date(changedEndTime).toISOString();
        }
        calUpdates.event_source = 'tonomo';
        if (Object.keys(calUpdates).length > 0) {
          await entities.CalendarEvent.update(appointmentEvent.id, calUpdates);
        }
      } else if (changedStartTime) {
        // Guard against the cancel-race ghost bug (see migration 094):
        // Only recreate a calendar event if this appointment is still tracked
        // on the project. If a 'canceled' webhook removed this appointment_id
        // from project.tonomo_appointment_ids, we must NOT resurrect its
        // calendar row from a stale 'changed' payload that's about to arrive
        // moments later in the queue.
        //
        // We also skip if the order itself has been cancelled at the order
        // level (orderStatus='cancelled'), even if appointment_ids weren't
        // cleared for some reason.
        const trackedAppointmentIds = Array.isArray(project.tonomo_appointment_ids)
          ? project.tonomo_appointment_ids
          : (typeof project.tonomo_appointment_ids === 'string'
              ? (() => { try { return JSON.parse(project.tonomo_appointment_ids); } catch { return []; } })()
              : []);
        const appointmentStillTracked = trackedAppointmentIds.includes(appointmentEventId);
        const orderCancelled = (p.order?.orderStatus || p.orderStatus) === 'cancelled';

        if (appointmentStillTracked && !orderCancelled) {
          const endTime = p.when?.end_time ? p.when.end_time * 1000 : null;
          await entities.CalendarEvent.create({
            title: project.title || `Shoot — ${orderId}`,
            description: `Tonomo appointment (created during change event) for order ${orderId}`,
            start_time: new Date(changedStartTime).toISOString(),
            end_time: endTime ? new Date(endTime).toISOString() : null,
            location: project.property_address || '',
            google_event_id: appointmentEventId,
            tonomo_appointment_id: appointmentEventId,
            project_id: project.id,
            owner_user_id: updates.project_owner_id || project.photographer_id || null,
            agent_id: updates.agent_id || project.agent_id || null,
            agency_id: updates.agency_id || project.agency_id || null,
            activity_type: 'shoot',
            is_synced: false,
            is_done: false,
            auto_linked: true,
            link_source: 'tonomo_webhook',
            link_confidence: 'exact',
            event_source: 'tonomo',
          });
        } else {
          console.log(`[changed] Skipping calendar-event recreate for appointment ${appointmentEventId}: tracked=${appointmentStillTracked}, orderCancelled=${orderCancelled}`);
        }
      }
    } catch (calErr: any) {
      console.error('CalendarEvent update failed (non-fatal):', calErr.message);
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
  const workDaysArrChanged = p.order?.workDays || p.workDays || [];
  let reconcileActivityDescription: string | null = null;
  if (rawTiersChanged.length > 0 || workDaysArrChanged.length > 0) {
    // Reuse allMappings loaded above instead of calling loadMappingTable again
    const { autoProducts: newProducts, autoPackages: newPackages, mappingGaps: newGaps } =
      await resolveProductsFromTiers(entities, rawTiersChanged, allMappings);

    // Also map Tonomo workDays (weekend/day-specific fees) to surcharge products
    const { autoProducts: feeProducts, mappingGaps: feeGaps } =
      await resolveProductsFromWorkDays(entities, workDaysArrChanged, allMappings);
    if (feeProducts.length > 0) newProducts.push(...feeProducts);
    newGaps.push(...feeGaps);

    const allProductsForDedup = await entities.Product.list(null, 500).catch(() => []);
    const allPackagesForDedup = await entities.Package.list(null, 200).catch(() => []);
    const deduped = deduplicateProjectItems(newProducts, newPackages, allProductsForDedup, allPackagesForDedup);

    // Capture the mapping gaps from Tonomo regardless of lock state.
    updates.products_mapping_gaps = JSON.stringify(newGaps.map((g: any) => g.serviceName));

    const reconciled = reconcileProductsPackagesAgainstLock(
      project, deduped.products, deduped.packages,
      allProductsForDedup, allPackagesForDedup,
      { queueRowId: ctx.queueRowId, webhookLogId: ctx.webhookLogId, eventType: ctx.eventType || 'changed' },
    );

    Object.assign(updates, reconciled.updates);
    if (reconciled.activityDescription) reconcileActivityDescription = reconciled.activityDescription;

    if (reconciled.decision === 'stash_for_review') {
      if (!updates.pending_review_type) updates.pending_review_type = 'tonomo_drift';
      if (reconciled.reviewReason) reviewReasons.push(reconciled.reviewReason);
    } else if (reconciled.decision === 'no_lock_apply') {
      // Legacy-style feedback when products changed without a lock
      const oldProductIds = new Set((project.products || []).map((pp: any) => pp.product_id));
      const newProductIds = new Set(deduped.products.map((pp: any) => pp.product_id));
      const removedProducts = [...oldProductIds].filter(id => !newProductIds.has(id));

      if (deduped.products.length === 0 && deduped.packages.length === 0 && (project.products?.length > 0 || project.packages?.length > 0)) {
        reviewReasons.push('All products/packages removed from Tonomo order — manual review required');
        updates.pending_review_type = 'products_removed';
      } else if (removedProducts.length > 0) {
        reviewReasons.push(`${removedProducts.length} product(s) removed from Tonomo order`);
      }

      if (ACTIVE_STAGES.includes(project.status)) {
        const prevProducts = project.products || [];
        const qtyChanged = deduped.products.some((np: any) => {
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

  // Capture Tonomo quoted price on change events (same pattern as handleScheduled)
  const tonomoPrice = p.invoice_amount || p.order?.invoice_amount || p.totalPrice || p.order?.totalPrice || null;
  if (tonomoPrice != null) {
    updates.tonomo_quoted_price = Number(tonomoPrice);
  }

  if (reviewReasons.length > 0) {
    if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;
    updates.status = 'pending_review';
    updates.pending_review_reason = reviewReasons.join(' | ');
  } else if (project.status === 'pending_review' && (updates.agent_id || (photographers.length > 0 && !updates.pending_review_type))) {
    // Clear stale agent/staff review reasons once resolution succeeds. Leaves
    // the review type intact so operators can still approve — only the message
    // is refreshed so it no longer misleads about the already-fixed gap.
    const staleReason = project.pending_review_reason || '';
    if (
      staleReason.includes('Agent reassigned') ||
      staleReason.includes('Photographer(s) reassigned')
    ) {
      updates.pending_review_reason = null;
    }
  }

  if (Object.keys(updates).length) await entities.Project.update(project.id, updates);
  // Merge updates so notifications use fresh data (e.g. new photographer_id, agent_id)
  const updatedProject = { ...project, ...updates };

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

  // Additional activity entry for the lock-aware merge / stash decision, so
  // the History tab shows exactly what happened to the products/packages.
  if (reconcileActivityDescription) {
    await writeProjectActivity(entities, {
      project_id: project.id,
      project_title: project.title || '',
      action: updates.tonomo_pending_delta ? 'tonomo_delta_stashed' : 'tonomo_delta_auto_merged',
      description: reconcileActivityDescription,
      tonomo_order_id: orderId,
      tonomo_event_type: 'changed',
      metadata: {
        queue_row_id: ctx.queueRowId || null,
        webhook_log_id: ctx.webhookLogId || null,
      },
    });
  }

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
      idempotencyKey: `services_changed:${orderId}:${new Date().toISOString().split('T')[0]}`,
    }, updatedProject).catch(() => {});
  }

  // Notify admins when a destructive delta was stashed for review
  if (updates.tonomo_pending_delta) {
    const changedProjectName = project.title || project.property_address || 'Project';
    fireRoleNotif(entities, ['project_owner', 'master_admin'], {
      type: 'tonomo_delta_pending_review',
      category: 'tonomo',
      severity: 'warning',
      title: `Tonomo delta needs review — ${changedProjectName}`,
      message: `Tonomo changed products/packages but the project has a manual-edit lock. Review and apply/dismiss.`,
      projectId: project.id,
      projectName: changedProjectName,
      ctaLabel: 'Review Delta',
      source: 'tonomo',
      idempotencyKey: `tonomo_delta:${orderId}:${new Date().toISOString().split('T')[0]}`,
    }, updatedProject).catch(() => {});
  }

  if (updates.products || updates.packages) {
    invokeFunction('cleanupOrphanedProjectTasks', {
      project_id: project.id,
    }).catch(() => { /* non-fatal */ });

    // Ensure pricing is recalculated when products change
    invokeFunction('recalculateProjectPricingServerSide', { project_id: project.id }).catch((err: any) => {
      console.error('Pricing recalc after change event failed (non-fatal):', err?.message);
    });

    // Sync quantity changes to task estimates
    invokeFunction('syncProjectTasksFromProducts', { project_id: project.id })
      .catch((err: any) => console.warn('Task sync after qty change failed:', err?.message));
  }

  return { summary: `Updated project for changed order ${orderId}` };
}
