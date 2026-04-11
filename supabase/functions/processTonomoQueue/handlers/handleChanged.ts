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
  resolveMappingsMulti,
  loadMappingTable,
  findProjectByOrderId,
  safeJsonParse,
  writeAudit,
  writeProjectActivity,
  fireRoleNotif,
} from '../utils.ts';

export async function handleChanged(entities: any, orderId: string, p: any) {
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
          if (agentRecord.current_agency_id) {
            updates.agency_id = agentRecord.current_agency_id;
            updates.agency_name = agentRecord.current_agency_name || null;
          }
        }
      } catch { /* non-fatal */ }
    } else if (!agentId) reviewReasons.push(`Agent reassigned to "${agent.displayName || agent.email || 'unknown'}" but not found — manual assignment required`);
  }

  // Update address if changed in Tonomo
  const changedAddress = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address;
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
        // Fallback: create calendar event if none exists for this appointment
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
  if (rawTiersChanged.length > 0 && !overriddenFields.includes('products')) {
    // Reuse allMappings loaded above instead of calling loadMappingTable again
    const { autoProducts: newProducts, autoPackages: newPackages, mappingGaps: newGaps } =
      await resolveProductsFromTiers(entities, rawTiersChanged, allMappings);

    // Compare old vs new to detect removals
    const oldProductIds = new Set((project.products || []).map((p: any) => p.product_id));
    const newProductIds = new Set(newProducts.map((p: any) => p.product_id));
    const oldPackageIds = new Set((project.packages || []).map((p: any) => p.package_id));
    const newPackageIds = new Set(newPackages.map((p: any) => p.package_id));

    const removedProducts = [...oldProductIds].filter(id => !newProductIds.has(id));
    const removedPackages = [...oldPackageIds].filter(id => !newPackageIds.has(id));

    if (removedProducts.length > 0 || removedPackages.length > 0) {
      reviewReasons.push(`${removedProducts.length} product(s) and ${removedPackages.length} package(s) removed from Tonomo order`);
      // The existing cleanupOrphanedProjectTasks call (later in the handler) will soft-delete tasks for removed products
    }

    // Also handle the case where ALL products are removed (empty tiers):
    if (newProducts.length === 0 && newPackages.length === 0 && (project.products?.length > 0 || project.packages?.length > 0)) {
      reviewReasons.push('All products/packages removed from Tonomo order — manual review required');
      updates.pending_review_type = 'products_removed';
    }

    if (newProducts.length > 0 || newPackages.length > 0 || removedProducts.length > 0 || removedPackages.length > 0) {
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

  // Capture Tonomo quoted price on change events (same pattern as handleScheduled)
  const tonomoPrice = p.totalPrice || p.order?.totalPrice || p.order?.invoice_amount || p.invoice_amount || null;
  if (tonomoPrice != null) {
    updates.tonomo_quoted_price = Number(tonomoPrice);
  }

  if (reviewReasons.length > 0) {
    if (project.status !== 'pending_review') updates.pre_revision_stage = project.status;
    updates.status = 'pending_review';
    updates.pending_review_reason = reviewReasons.join(' | ');
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
