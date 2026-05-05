import React, { useState, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import { validateField, trimFormData, LIMITS } from "@/components/hooks/useFormValidation";
import { normalizeProjectItems } from "@/components/lib/normalizeProjectItems";
import { sydneyInputToUtc } from "@/components/utils/dateUtils";
import { announceToScreenReader } from "@/components/utils/a11yUtils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { api } from "@/api/supabaseClient";
import { retryWithBackoff } from "@/lib/networkResilience";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateProjectCaches } from "@/lib/invalidateProjectCaches";
import { Loader2, Star, Zap, Package, Box, Trash2, Edit, Plus, MapPin, AlertCircle, User, DollarSign, Info, CheckCircle } from "lucide-react";
import AddressInput from "./AddressInput";
import AgentSearchField from "./AgentSearchField";
import AddItemsDialog from "./AddItemsDialog";
import StaffAssignmentField from "./StaffAssignmentField";
import ProjectFormPricingDisplay from "./ProjectFormPricingDisplay";
import { PROJECT_STAGES } from "./projectStatuses";
import { useRoleMappings, isRoleRequiredForProject } from "@/components/hooks/useRoleMappings";
import { createNotification, createNotificationsForUsers } from "@/components/notifications/createNotification";
import RemoveItemConfirmation from "@/components/common/RemoveItemConfirmation";
import UnsavedChangesWarning from "@/components/common/UnsavedChangesWarning";
import CharacterLimitWarning from "@/components/common/CharacterLimitWarning";
import SubmitButtonGuard from "@/components/common/SubmitButtonGuard";
import RequiredFieldIndicator from "@/components/common/RequiredFieldIndicator";
import RealtimeValidationFeedback from "@/components/common/RealtimeValidationFeedback";
import { useEscapeKeyWarning, EscapeKeyWarningBanner } from "@/components/common/EscapeKeyWarning";
import NetworkErrorRetry from "@/components/common/NetworkErrorRetry";
import { toast } from "sonner";

export default function ProjectForm({ project, open, onClose, onSave }) {
  const { canSeePricing } = usePermissions();
  const { canEdit, canView } = useEntityAccess('projects');
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    title: "",
    agent_id: "",
    agency_id: "",
    property_address: "",
    status: "to_be_scheduled",
    products: [],
    packages: [],
    shoot_date: "",
    shoot_time: "",
    pricing_tier: "standard",
    notes: "",
    title_desc: "",
  });
  const [saving, setSaving] = useState(false);
  const [calculatingPrice, setCalculatingPrice] = useState(false);
  const [errors, setErrors] = useState({});
  // Ref to always have the latest agent/agency IDs for avoiding stale closure issues in async handlers
  const latestAgentRef = useRef({ agent_id: formData.agent_id, agency_id: formData.agency_id });
  useEffect(() => {
    latestAgentRef.current = { agent_id: formData.agent_id, agency_id: formData.agency_id };
  }, [formData.agent_id, formData.agency_id]);
  const [titleOverride, setTitleOverride] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [unsavedChanges, setUnsavedChanges] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(null);
  const [initialFormData, setInitialFormData] = useState(project || {});
  const [saveError, setSaveError] = useState(null);

  // Monitor escape key for unsaved changes warning
  useEscapeKeyWarning(unsavedChanges);

  // Beforeunload guard: warn when navigating away with unsaved changes
  useEffect(() => {
    if (!unsavedChanges) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [unsavedChanges]);

  const handleFieldChange = (field, value) => {
    const trimmed = typeof value === "string" ? value.slice(0, LIMITS[field] || LIMITS.short) : value;
    setFormData(prev => {
      const next = { ...prev, [field]: trimmed };
      // Auto-update title when address or title_desc changes
      if (field === 'property_address' || field === 'title_desc') {
        const addr = field === 'property_address' ? trimmed : prev.property_address;
        const desc = field === 'title_desc' ? trimmed : prev.title_desc;
        next.title = buildAutoTitle(addr, desc);
      }
      return next;
    });
    setUnsavedChanges(true);
    // Validate and clear errors in real-time
    const fieldError = validateField(field, trimmed);
    setErrors(prev => ({ ...prev, [field]: fieldError }));
  };

  const { data: allProducts = [] } = useEntityList("Product");
  const { data: allPackagesList = [] } = useEntityList("Package");
  const { data: projectTypes = [] } = useEntityList("ProjectType", "order");

  // Only show active products and packages, filtered by project type
  const activeProducts = useMemo(() => allProducts.filter(p => p.is_active !== false), [allProducts]);
  const activePackages = useMemo(() => allPackagesList.filter(p => p.is_active !== false), [allPackagesList]);

  const products = useMemo(() => {
    const typeId = formData.project_type_id;
    if (!typeId) return activeProducts;
    return activeProducts.filter(p => !p.project_type_ids?.length || p.project_type_ids.includes(typeId));
  }, [activeProducts, formData.project_type_id]);

  const packagesList = useMemo(() => {
    const typeId = formData.project_type_id;
    if (!typeId) return activePackages;
    return activePackages.filter(p => !p.project_type_ids?.length || p.project_type_ids.includes(typeId));
  }, [activePackages, formData.project_type_id]);
  const { data: agents = [] } = useEntityList("Agent");
  const { data: clients = [] } = useEntityList("Client");
  // Fetch users with controlled query with error boundary (Fix #12, #13)
  const { data: allUsers = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.filter({}, null, 100), // Reduced limit from 500 (Fix #12)
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2
  });
  const staffUsers = useMemo(() => allUsers.filter(u => u.role !== undefined), [allUsers]);
  const { data: internalTeams = [] } = useEntityList("InternalTeam");
  const { mappings: roleMappings } = useRoleMappings();
  const { data: roleDefaultsList = [] } = useEntityList("TonomoRoleDefaults");
  const roleDefaults = roleDefaultsList[0] || {};

  // Resolve default name for a role from TonomoRoleDefaults config
  const getDefaultForRole = (roleKey) => {
    const userField = `${roleKey}_default_user_id`;
    const teamFields = {
      photographer: 'photographer_fallback_team_id',
      videographer: 'videographer_fallback_team_id',
      project_owner: 'owner_fallback_team_id',
      image_editor: 'editing_fallback_team_id',
      video_editor: 'editing_fallback_team_id',
      floorplan_editor: 'editing_fallback_team_id',
      drone_editor: 'editing_fallback_team_id',
    };
    const defaultUserId = roleDefaults[userField];
    if (defaultUserId) {
      const user = staffUsers.find(u => u.id === defaultUserId);
      if (user) return { name: user.full_name, type: 'user' };
    }
    const teamField = teamFields[roleKey];
    const defaultTeamId = teamField ? roleDefaults[teamField] : null;
    if (defaultTeamId) {
      const team = internalTeams.find(t => t.id === defaultTeamId);
      if (team) return { name: team.name, type: 'team' };
    }
    return null;
  };

  // Track whether form has been initialized for this dialog session.
  // Prevents re-initialization when entity subscriptions or data loading
  // cause prop/dependency changes while the user is editing.
  const formInitializedRef = useRef(false);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    // Only initialize when dialog OPENS (transition from closed to open)
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      // Dialog closed — reset the flag so next open re-initializes
      formInitializedRef.current = false;
      return;
    }

    if (formInitializedRef.current) {
      // Already initialized this session — don't reset the form.
      // Exception: if projectTypes just loaded and we need the default type on a new project
      if (!project && !formData.project_type_id && projectTypes.length > 0) {
        const defaultType = projectTypes.find(t => t.is_default && t.is_active) || projectTypes[0] || null;
        if (defaultType) {
          setFormData(prev => ({
            ...prev,
            project_type_id: defaultType.id,
            project_type_name: defaultType.name,
          }));
        }
      }
      return;
    }

    // First initialization for this dialog session
    if (project) {
      setFormData({
        ...project,
        products: project.products || [],
        packages: project.packages || [],
        pricing_tier: project.pricing_tier || "standard",
        title_desc: project.title_desc || "",
      });
    } else {
      const defaultType = projectTypes.find(t => t.is_default && t.is_active) || projectTypes[0] || null;
      setFormData({
        title: "",
        agent_id: "",
        agent_name: "",
        agency_id: "",
        client_id: "",
        client_name: "",
        property_address: "",
        status: "to_be_scheduled",
        products: [],
        packages: [],
        shoot_date: "",
        shoot_time: "",
        pricing_tier: "standard",
        notes: "",
        title_desc: "",
        price: 0,
        calculated_price: 0,
        project_type_id: defaultType?.id || "",
        project_type_name: defaultType?.name || "",
      });
    }
    setErrors({});
    setUnsavedChanges(false);
    setSaveError(null);
    formInitializedRef.current = true;
  }, [open, project, projectTypes.length]);

  // Build title from address + optional description
  const buildAutoTitle = (address, desc) => {
    if (!address?.trim()) return '';
    // Strip state, postcode, country — keep street + suburb
    const parts = address.split(',').map(s => s.trim());
    const STATE_RE = /\b(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\b/i;
    const POSTCODE_RE = /^\d{4}$/;
    const COUNTRY_RE = /^Australia$/i;
    const stripped = [];
    for (const part of parts) {
      if (COUNTRY_RE.test(part)) continue;
      if (POSTCODE_RE.test(part)) continue;
      if (STATE_RE.test(part)) {
        const cleaned = part.replace(/\s+(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)(\s+\d{4})?$/i, '').trim();
        if (cleaned) stripped.push(cleaned);
        break;
      }
      stripped.push(part);
    }
    const base = stripped.join(', ') || address;
    return desc?.trim() ? `${base} - ${desc.trim()}` : base;
  };

  const handleAgentChange = async (agentId) => {
    if (!agentId) {
      // Clear agent selection
      setFormData(prev => ({
        ...prev,
        agent_id: "",
        agency_id: "",
        client_id: "",
        client_name: "",
      }));
      return;
    }

    const agent = agents.find(a => a.id === agentId);
    // Find matching Client record for this agent
    const existingClient = clients.find(c => c.agent_email === agent?.email || c.agent_name === agent?.name);
    let clientId = existingClient?.id;

    // If no client record exists, auto-create one
    if (!clientId && agent) {
      try {
        const newClient = await api.entities.Client.create({
          agent_name: agent.name,
          agent_email: agent.email || "",
          agency_name: agent.current_agency_name || "",
        });
        clientId = newClient.id;
      } catch (err) {
        toast.error(err?.message || "Failed to create client record");
      }
    }

    setFormData(prev => {
      const updated = {
        ...prev,
        agent_id: agentId,
        agency_id: agent?.current_agency_id || "",
        client_id: clientId || "",
        client_name: agent?.name || "",
      };
      // Recalculate with fresh agent/agency using current products/packages.
      // Catch to prevent unhandled promise rejection from async recalculate.
      if (agentId && (prev.products.length > 0 || prev.packages.length > 0)) {
        recalculatePricing(agentId, agent?.current_agency_id, prev.products, prev.packages, prev.pricing_tier)
          .catch(err => console.error('Pricing recalculation failed:', err));
      }
      return updated;
    });
  };

  // Ref to always have the latest project_type_id for async pricing calls
  const latestProjectTypeRef = useRef(formData.project_type_id);
  useEffect(() => { latestProjectTypeRef.current = formData.project_type_id; }, [formData.project_type_id]);

  const recalculatePricing = async (agentId, agencyId, prodList, pkgList, tier) => {
    if (prodList.length === 0 && pkgList.length === 0) {
      setFormData(prev => ({ ...prev, calculated_price: 0, price: 0 }));
      return;
    }

    setCalculatingPrice(true);
    try {
      const response = await api.functions.invoke('calculateProjectPricing', {
        agent_id: agentId || null,
        agency_id: agencyId || null,
        products: prodList.map(p => ({ product_id: p.product_id || p, quantity: p.quantity || 1 })),
        packages: pkgList.map(p => ({ package_id: p.package_id || p, quantity: p.quantity || 1, products: p.products || [] })),
        pricing_tier: tier,
        // Use ref to avoid stale closure — formData.project_type_id may be outdated
        project_type_id: latestProjectTypeRef.current || null
      });

      if (response.data.success) {
        setFormData(prev => ({
          ...prev,
          // Keep existing products/packages — only update price fields
          // calculateProjectPricing returns line_items, NOT products/packages
          calculated_price: response.data.calculated_price,
          price_matrix_snapshot: response.data.price_matrix_snapshot,
          price: response.data.calculated_price
        }));
      }
    } catch (error) {
      console.error('Failed to calculate pricing:', error);
    } finally {
      setCalculatingPrice(false);
    }
  };

  const handleAddProduct = async (productId, qty) => {
    const newProducts = [...formData.products, { product_id: productId, quantity: qty || 1 }];
    setFormData(prev => ({ ...prev, products: newProducts }));
    setErrors(prev => ({ ...prev, items: null }));
    const { agent_id, agency_id } = latestAgentRef.current;
    await recalculatePricing(agent_id, agency_id, newProducts, formData.packages, formData.pricing_tier);
  };

  const handleAddPackage = async (packageId, qty, productQtyOverrides = {}) => {
    const pkg = packagesList.find(p => p.id === packageId);
    if (!pkg) return;
    const packageProducts = (pkg.products || []).map(templateItem => ({
      product_id: templateItem.product_id,
      product_name: templateItem.product_name || "",
      quantity: productQtyOverrides[templateItem.product_id] ?? templateItem.quantity ?? 1,
    }));
    const packageProductIds = new Set(packageProducts.map(p => p.product_id));
    const remainingProducts = formData.products.filter(p => !packageProductIds.has(p.product_id));
    const newProducts = remainingProducts;
    const newPackages = [...formData.packages, { package_id: packageId, quantity: qty ?? 1, products: packageProducts }];
    setFormData(prev => ({ ...prev, products: newProducts, packages: newPackages }));
    setErrors(prev => ({ ...prev, items: null }));
    // Use ref to get latest agent/agency (formData in this closure may be stale)
    const { agent_id, agency_id } = latestAgentRef.current;
    await recalculatePricing(agent_id, agency_id, newProducts, newPackages, formData.pricing_tier);
  };

  const handleRemoveProduct = async (productId) => {
    setShowRemoveConfirm({ type: 'product', id: productId });
  };

  const handleConfirmRemoveProduct = async (productId) => {
    const newProducts = formData.products.filter(p => (p.product_id || p) !== productId);
    setFormData(prev => ({ ...prev, products: newProducts }));
    setUnsavedChanges(true);
    const { agent_id, agency_id } = latestAgentRef.current;
    await recalculatePricing(agent_id, agency_id, newProducts, formData.packages, formData.pricing_tier);
    setShowRemoveConfirm(null);
  };

  const handleRemovePackage = async (packageId) => {
    setShowRemoveConfirm({ type: 'package', id: packageId });
  };

  const handleConfirmRemovePackage = async (packageId) => {
    const newPackages = formData.packages.filter(p => (p.package_id || p) !== packageId);
    setFormData(prev => ({ ...prev, packages: newPackages }));
    setUnsavedChanges(true);
    const { agent_id, agency_id } = latestAgentRef.current;
    await recalculatePricing(agent_id, agency_id, formData.products, newPackages, formData.pricing_tier);
    setShowRemoveConfirm(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Race condition fix: prevent double-submit if already saving (e.g. rapid Ctrl+S)
    if (saving) return;
    const hasItems = formData.products.length > 0 || formData.packages.length > 0;
    
    const newErrors = {
      property_address: validateField("property_address", formData.property_address),
      pricing_tier: !formData.pricing_tier ? "Please select a pricing tier" : null,
      agent_id: !formData.agent_id ? "Agent is required" : null,
      project_type_id: !formData.project_type_id ? "Project type is required" : null,
      items: !hasItems ? "At least one product or package is required" : null,
      // Staff roles are OPTIONAL — applyProjectRoleDefaults auto-fills after save
    };
    setErrors(newErrors);
    const activeErrors = Object.entries(newErrors).filter(([, v]) => v);
    if (activeErrors.length > 0) {
      // Scroll to the first field with an error
      const firstErrorField = activeErrors[0][0];
      const el = document.querySelector(`[data-field="${firstErrorField}"]`) || document.querySelector(`[name="${firstErrorField}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast.error(`Please fix ${activeErrors.length} field${activeErrors.length > 1 ? 's' : ''}: ${activeErrors.map(([k]) => k.replace(/_/g, ' ')).join(', ')}`);
      announceToScreenReader(`Validation failed. ${activeErrors.length} error${activeErrors.length > 1 ? 's' : ''} found.`);
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      // Build save payload — ensure agent_name is stored for display
      const agent = agents.find(a => a.id === formData.agent_id);
      // Normalize products/packages: remove duplicates, absorb overlaps
      const normalized = normalizeProjectItems(
        formData.products || [],
        formData.packages || [],
        allProducts,
        packagesList
      );
      if (normalized.warnings.length > 0) {
        normalized.warnings.forEach(w => console.warn('Category overlap:', w.message));
      }

      const trimmed = trimFormData(formData);
      // Sanitize empty strings → null for typed columns (Supabase rejects "" for UUID, timestamp, numeric)
      for (const [key, val] of Object.entries(trimmed)) {
        if (val === '' || val === 'not_required') trimmed[key] = null;
      }
      const dataToSave = {
        ...trimmed,
        products: normalized.products,
        packages: normalized.packages,
        agent_name: agent?.name || formData.agent_name || "",
        // Keep price in sync with calculated_price
        price: formData.calculated_price || formData.price || 0,
      };

      let projectId;
      if (project?.id) {
        await retryWithBackoff(() => api.entities.Project.update(project.id, dataToSave), {
          maxRetries: 2,
          onRetry: (err, attempt) => console.warn(`Project save retry ${attempt}:`, err.message),
        });
        projectId = project.id;
      } else {
        const newProject = await retryWithBackoff(() => api.entities.Project.create(dataToSave), {
          maxRetries: 2,
          onRetry: (err, attempt) => console.warn(`Project create retry ${attempt}:`, err.message),
        });
        projectId = newProject.id;
      }

      // Fire-and-forget task sync — don't await, prevents form timeout
      if (projectId) {
      // If shoot_date or shoot_time changed on an existing project, update ALL linked CalendarEvents
      if (project?.id) {
      const shootDateChanged = formData.shoot_date !== (initialFormData.shoot_date || '');
      const shootTimeChanged = formData.shoot_time !== (initialFormData.shoot_time || '');
      if (shootDateChanged || shootTimeChanged) {
        api.entities.CalendarEvent.filter({ project_id: project.id }, null, 50)
          .then(events => {
            // FIX: Update ALL linked events, not just tonomo-sourced ones.
            // FlexMedia-created events linked to this project also need start/end time updates.
            const tonomoEvents = events.filter(ev =>
              ev.event_source === 'tonomo' || ev.tonomo_appointment_id
            );
            if (tonomoEvents.length > 0) {
              toast.info('Tonomo calendar events updated locally. Update in Tonomo for permanent changes.', { duration: 5000 });
            }
            // Google-sourced events are read-only in FlexStudios — skip them
            const updatableEvents = events.filter(ev => ev.event_source !== 'google');
            updatableEvents.forEach(ev => {
              if (!formData.shoot_date) return;
              const timeStr = formData.shoot_time || '09:00';
              const hhmm = timeStr.length <= 5 ? timeStr : timeStr.slice(0, 5);
              // BUG FIX: was parsing as local machine time via new Date(string).
              // On a UTC server, "2026-03-10T09:00:00" parses as 09:00 UTC, not 09:00 Sydney.
              // Use sydneyInputToUtc to correctly convert Sydney wall-clock to UTC.
              const utcIso = sydneyInputToUtc(`${formData.shoot_date}T${hhmm}`);
              if (!utcIso) return;
              // FIX: Also update end_time to maintain original event duration.
              // Without this, changing shoot_date leaves end_time on the old date,
              // creating an event that spans incorrectly.
              const updatePayload = { start_time: utcIso };
              if (ev.start_time && ev.end_time) {
                const durationMs = new Date(ev.end_time).getTime() - new Date(ev.start_time).getTime();
                if (durationMs > 0) {
                  updatePayload.end_time = new Date(new Date(utcIso).getTime() + durationMs).toISOString();
                }
              }
              api.entities.CalendarEvent.update(ev.id, updatePayload).catch(() => {});
            });
          })
          .catch(() => {});
      }

      // Fix 4b — update CalendarEvent locations when property address changes
      const addressChanged = formData.property_address !== (initialFormData.property_address || '');
      if (addressChanged && formData.property_address) {
        api.entities.CalendarEvent.filter({ project_id: project.id }, null, 50)
          .then(events => {
            // FIX: Update ALL linked events, not just tonomo-sourced ones.
            // FlexMedia-created events also carry location and should stay in sync.
            // Google-sourced events are read-only — skip them.
            events
              .filter(ev => ev.event_source !== 'google')
              .forEach(ev => {
                api.entities.CalendarEvent.update(ev.id, {
                  location: formData.property_address,
                }).catch(() => {});
              });
          })
          .catch(() => {});
      }

      // Fix 7a — log field changes to project activity feed
      const changedFields = [];
      const watchedFields = ['property_address', 'shoot_date', 'shoot_time',
                             'delivery_date', 'notes', 'priority', 'pricing_tier',
                             'agent_id', 'project_type_id'];
      watchedFields.forEach(field => {
        if (String(formData[field] || '') !== String(initialFormData[field] || '')) {
          changedFields.push({
            field,
            old_value: String(initialFormData[field] || ''),
            new_value: String(formData[field] || ''),
          });
        }
      });
      if (changedFields.length > 0) {
        api.functions.invoke('logProjectChange', {
          event: { type: 'update', entity_id: project.id },
          data: { ...formData, id: project.id },
          old_data: initialFormData,
        }).catch(() => {});
      }
      }

      // If notes field has content, create a system note in the notes engine
      if (formData.notes?.trim()) {
        const isNew = !project?.id;
        const notesChanged = isNew || formData.notes !== (initialFormData.notes || '');
        if (notesChanged) {
          api.entities.OrgNote.create({
            project_id: projectId,
            entity_type: 'project',
            entity_id: projectId,
            content: formData.notes.trim(),
            content_html: `<p>${formData.notes.trim().replace(/\n/g, '</p><p>')}</p>`,
            author_name: 'System',
            author_email: 'system@flexstudios.app',
            context_type: 'project',
            context_label: formData.property_address || formData.title || 'Project',
          }).catch(err => console.warn('Note creation skipped:', err?.message));
        }
      }

      // 1. Apply role defaults FIRST — fills empty staff slots from Settings config
      try {
        await api.functions.invoke('applyProjectRoleDefaults', { project_id: projectId });
      } catch (err) { console.warn('Role defaults skipped:', err?.message); }

      // 2. Sync tasks SECOND — tasks get assigned to the now-populated roles
      try {
        await api.functions.invoke('syncProjectTasksFromProducts', { project_id: projectId });
      } catch (err) { console.warn('Task sync skipped:', err?.message); }

      // 3. Onsite effort tasks (parallel, non-blocking — depends on roles being set)
      api.functions.invoke('syncOnsiteEffortTasks', { project_id: projectId })
        .catch(err => console.warn('Onsite effort sync skipped:', err?.message));

      // FIX #1: Agent/agency change triggers repricing recalculation
      if (project?.id) {
        const agentChanged = formData.agent_id !== (initialFormData.agent_id || '');
        const agencyChanged = formData.agency_id !== (initialFormData.agency_id || '');
        if (agentChanged || agencyChanged) {
          api.functions.invoke('recalculateProjectPricingServerSide', {
            project_id: projectId
          }).catch(() => {});
        }
      }

      // GAP-3: Notify photographer + owner when shoot date changes
      if (project?.id) {
        const shootDateChanged = formData.shoot_date !== (initialFormData.shoot_date || '');
        const shootTimeChanged = formData.shoot_time !== (initialFormData.shoot_time || '');
        if (shootDateChanged || shootTimeChanged) {
          const currentUser = await api.auth.me().catch(() => null);
          const staffIds = [project.photographer_id, project.onsite_staff_1_id, project.project_owner_id].filter(Boolean);
          const projectName = formData.property_address || project.title || 'Project';
          const isAdvancedStage = ['onsite', 'uploaded', 'in_progress', 'in_production', 'in_revision'].includes(project.status);

          createNotificationsForUsers(staffIds, {
            type: isAdvancedStage ? 'reschedule_advanced_stage' : 'shoot_date_changed',
            title: isAdvancedStage
              ? `Reschedule warning: ${projectName}`
              : `Shoot date changed: ${projectName}`,
            message: `Shoot date ${shootDateChanged ? 'changed to ' + formData.shoot_date : ''}${shootTimeChanged ? ' time: ' + formData.shoot_time : ''}.${isAdvancedStage ? ' Project is already in ' + project.status + ' stage!' : ''}`,
            projectId: project.id,
            projectName,
            entityType: 'project', entityId: project.id,
            ctaUrl: 'ProjectDetails', ctaParams: { id: project.id },
            sourceUserId: currentUser?.id,
            severity: isAdvancedStage ? 'warning' : 'info',
            idempotencyKey: `shoot_date:${project.id}:${formData.shoot_date}:${formData.shoot_time}`,
          }, currentUser?.id).catch(() => {});
        }
      }

      // GAP-4: Notify newly assigned staff when roles change
      if (project?.id) {
        const currentUser = await api.auth.me().catch(() => null);
        const projectName = formData.property_address || project.title || 'Project';
        const ROLE_NOTIF_MAP = {
          photographer: { field: 'photographer_id', type: 'photographer_assigned', title: 'You\'ve been assigned as photographer' },
          onsite_staff_1: { field: 'onsite_staff_1_id', type: 'photographer_assigned', title: 'You\'ve been assigned as onsite staff' },
          onsite_staff_2: { field: 'onsite_staff_2_id', type: 'project_assigned_to_you', title: 'You\'ve been assigned as videographer' },
          image_editor: { field: 'image_editor_id', type: 'project_assigned_to_you', title: 'You\'ve been assigned as image editor' },
          video_editor: { field: 'video_editor_id', type: 'project_assigned_to_you', title: 'You\'ve been assigned as video editor' },
          project_owner: { field: 'project_owner_id', type: 'project_owner_assigned', title: 'You\'ve been assigned as project owner' },
        };
        for (const [roleKey, cfg] of Object.entries(ROLE_NOTIF_MAP)) {
          const newId = formData[cfg.field];
          const oldId = initialFormData[cfg.field] || '';
          if (newId && newId !== oldId && newId !== 'not_required' && newId !== currentUser?.id) {
            createNotification({
              userId: newId,
              type: cfg.type,
              title: cfg.title,
              message: `${projectName} — you have been assigned as ${roleKey.replace(/_/g, ' ')}.`,
              projectId: project.id,
              projectName,
              entityType: 'project', entityId: project.id,
              ctaUrl: 'ProjectDetails', ctaParams: { id: project.id },
              sourceUserId: currentUser?.id,
              idempotencyKey: `role_assign:${project.id}:${roleKey}:${newId}`,
            }).catch(() => {});
          }
        }
      }

      // Task deadline calc — existing projects only (new projects get deadlines from syncProjectTasks)
      if (project?.id) {
        const shootDateChanged = formData.shoot_date !== (initialFormData.shoot_date || '');
        const shootTimeChanged = formData.shoot_time !== (initialFormData.shoot_time || '');
        if (shootDateChanged || shootTimeChanged) {
          api.functions.invoke('calculateProjectTaskDeadlines', {
            project_id: projectId,
            trigger_event: 'shoot_date_changed',
          }).catch(() => {});
        }
      }

      // Geocode — runs for BOTH new and existing projects when address is present
      if (formData.property_address) {
        const addressChanged = !project?.id ||
          formData.property_address !== (initialFormData.property_address || '');
        if (addressChanged) {
          api.functions.invoke('geocodeProject', {
            projectIds: [projectId],
          }).catch(() => {});
        }
      }

        // applyProjectRoleDefaults + syncProjectTasksFromProducts have already
        // awaited above, so server state is final by here. Invalidate scoped
        // task cache + project cache so TaskManagement / staff bar / kanban
        // pick up the new assignments without a manual refresh.
        invalidateProjectCaches(queryClient, { tasks: true, project: true });
      }

      // Fix 7 — update the baseline so subsequent edits track changes correctly
      setInitialFormData({ ...formData });

      setSaving(false);
      setUnsavedChanges(false);
       toast.success(project ? 'Project saved successfully' : 'Project created successfully');
       announceToScreenReader(project ? 'Project saved successfully' : 'Project created successfully');
       onSave({ id: projectId, isNew: !project?.id });
      } catch (err) {
       console.error('Failed to save project:', err);
       setSaving(false);
       // Extract specific field errors from Supabase constraint violations
       const msg = err?.message || '';
       let userMessage = msg;
       const fieldErrors = {};
       if (msg.includes('violates foreign key')) {
         const match = msg.match(/column "(\w+)"/);
         const field = match?.[1] || '';
         fieldErrors[field] = 'Invalid reference -- the selected item may have been deleted';
         userMessage = `Invalid reference in ${field.replace(/_/g, ' ')}`;
       } else if (msg.includes('violates not-null')) {
         const match = msg.match(/column "(\w+)"/);
         const field = match?.[1] || '';
         fieldErrors[field] = 'This field is required';
         userMessage = `Missing required field: ${field.replace(/_/g, ' ')}`;
       } else if (msg.includes('duplicate key')) {
         userMessage = 'A project with these details already exists';
       } else if (!msg || msg === 'Failed to fetch') {
         userMessage = 'Network error -- check your connection and try again';
       }
       if (Object.keys(fieldErrors).length > 0) {
         setErrors(prev => ({ ...prev, ...fieldErrors }));
       }
       setSaveError({ ...err, message: userMessage });
       toast.error(userMessage || 'Failed to save project');
       announceToScreenReader(`Save failed: ${userMessage}`);
      }
      };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0" onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Bug fix: warn before closing if there are unsaved changes
          if (unsavedChanges) {
            e.preventDefault();
            e.stopPropagation();
            if (window.confirm('You have unsaved changes. Discard and close?')) {
              onClose();
            }
          }
          // If no unsaved changes, let the Dialog's default Escape handler close it
        }
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(e); }
      }}>
        <DialogHeader className="pb-3 border-b flex-shrink-0 px-4 pt-4">
          <DialogTitle className="text-xl font-bold flex items-center justify-between">
            <span className="flex items-center gap-2">
              {project ? (
                <>
                  <Edit className="h-5 w-5 text-primary" />
                  Edit Project
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5 text-primary" />
                  New Project
                </>
              )}
            </span>
            <kbd className="text-[10px] font-normal text-muted-foreground bg-muted px-2 py-1 rounded border">Ctrl+S to save</kbd>
            {canView && !canEdit && <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground ml-2">View only</Badge>}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {project ? "Update project details and settings" : "Create a new project with services and assignments"}
          </p>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4 flex-1 overflow-y-auto px-4 pb-4">
           {/* Address */}
               <div data-field="property_address">
                 <Label className="text-sm font-medium flex items-center gap-1.5">
                   <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                   Address
                   <RequiredFieldIndicator required={true} />
                 </Label>
                 <AddressInput
                  value={formData.property_address}
                  onChange={(value) => {
                    handleFieldChange("property_address", value);
                  }}
                  placeholder="e.g., 123 Main Street, Sydney NSW 2000"
                  autoFocus
                 />
                {errors.property_address ? (
                  <RealtimeValidationFeedback 
                    isValid={false} 
                    errorMessage={errors.property_address}
                    showOnValid={false}
                  />
                ) : formData.property_address && (
                  <RealtimeValidationFeedback 
                    isValid={true}
                    showOnValid={true}
                  />
                )}
              </div>

          {/* Title desc + auto-title preview */}
          <div className="space-y-2">
            <div>
              <Label htmlFor="title_desc" className="text-sm font-medium">
                Title description
                <span className="text-xs text-muted-foreground font-normal ml-1">(optional)</span>
              </Label>
              <Input
                id="title_desc"
                placeholder="e.g. Re-shoot, Twilight, Phase 2"
                value={formData.title_desc || ""}
                onChange={(e) => handleFieldChange("title_desc", e.target.value)}
                className="h-9 focus:ring-2 focus-visible:ring-primary mt-1"
                maxLength={80}
              />
            </div>
            {formData.title && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-dashed">
                <span className="text-xs text-muted-foreground">Title preview:</span>
                <span className="text-sm font-medium truncate">{formData.title}</span>
              </div>
            )}
          </div>

          {/* --- Section: Agent & Project Type --- */}
          <div className="border-t pt-4 mt-2" />

          {/* Agent */}
          <div data-field="agent_id">
            <Label htmlFor="agent" className="flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              Agent <span className="text-destructive">*</span>
              {formData.agent_id && <CheckCircle className="h-3 w-3 text-green-600 ml-auto" title="Agent selected" />}
            </Label>
            <AgentSearchField
              agents={agents}
              value={agents.find(a => a.id === formData.agent_id) || null}
              onChange={(agent) => { handleAgentChange(agent?.id); setErrors(prev => ({ ...prev, agent_id: null })); }}
              placeholder="Search agent..."
            />
            {errors.agent_id && <p className="text-xs text-destructive mt-1.5 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{errors.agent_id}</p>}
          </div>

          {/* Project Type */}
          {projectTypes.length > 0 && (
            <div data-field="project_type_id">
              <Label className="text-sm font-medium mb-2 block">
                Project Type <span className="text-destructive">*</span>
                {project?.id && <span className="ml-2 text-xs font-normal text-muted-foreground">(locked after creation)</span>}
              </Label>
              {project?.id ? (
                // Locked — display only, cannot change after creation
                <div className="flex flex-wrap gap-2">
                  {projectTypes.filter(t => t.is_active !== false).map(type => {
                    const isSelected = formData.project_type_id === type.id;
                    if (!isSelected) return null;
                    return (
                      <span
                        key={type.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium text-white"
                        style={{ backgroundColor: type.color || "#3b82f6" }}
                      >
                        <span className="w-2 h-2 rounded-full bg-white/70" />
                        {type.name}
                      </span>
                    );
                  })}
                  {!formData.project_type_id && (
                    <span className="text-sm text-muted-foreground italic">No type set</span>
                  )}
                </div>
              ) : (
                // New project — allow selection, clears products/packages on change
                <div className="flex flex-wrap gap-2">
                  {projectTypes.filter(t => t.is_active !== false).map(type => {
                    const isSelected = formData.project_type_id === type.id;
                    return (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => {
                          setFormData(prev => ({
                            ...prev,
                            project_type_id: type.id,
                            project_type_name: type.name,
                            // Clear products/packages when switching type to avoid invalid selections
                            products: [],
                            packages: [],
                            calculated_price: 0,
                            price: 0,
                          }));
                          setErrors(prev => ({ ...prev, project_type_id: null }));
                        }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border-2 transition-all ${
                          isSelected
                            ? "text-white border-transparent"
                            : "bg-background text-muted-foreground border-border hover:border-muted-foreground/40"
                        }`}
                        style={isSelected ? { backgroundColor: type.color || "#3b82f6", borderColor: type.color || "#3b82f6" } : {}}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: isSelected ? "rgba(255,255,255,0.7)" : (type.color || "#3b82f6") }} />
                        {type.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {errors.project_type_id && <p className="text-xs text-destructive mt-2">{errors.project_type_id}</p>}
            </div>
          )}

          {/* --- Section: Schedule & Pricing --- */}
          <div className="border-t pt-4 mt-2" />

          {/* Status & Date/Time */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs font-medium">Stage</Label>
              <Select value={formData.status} onValueChange={(v) => { setFormData(prev => ({ ...prev, status: v })); setUnsavedChanges(true); }}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROJECT_STAGES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* Shoot date/time only shown when editing — added separately after project creation */}
            {project?.id && (
              <>
                <div>
                  <Label className="text-xs font-medium">Shoot Date</Label>
                  <Input type="date" className="h-9 text-sm" value={formData.shoot_date || ""} onChange={(e) => { setFormData(prev => ({ ...prev, shoot_date: e.target.value })); setUnsavedChanges(true); }} />
                </div>
                <div>
                  <Label className="text-xs font-medium">Shoot Time</Label>
                  <Input type="time" className="h-9 text-sm" value={formData.shoot_time || ""} onChange={(e) => { setFormData(prev => ({ ...prev, shoot_time: e.target.value })); setUnsavedChanges(true); }} />
                </div>
              </>
            )}
          </div>

          {/* Pricing Tier */}
          <div data-field="pricing_tier">
            <Label className="mb-2 block flex items-center gap-1.5">
              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
              Pricing Tier <span className="text-destructive">*</span>
              {canSeePricing && formData.calculated_price > 0 && (
                <span className={`ml-auto text-sm font-bold font-mono tabular-nums px-2 py-0.5 rounded-md ${calculatingPrice ? "bg-muted text-muted-foreground animate-pulse" : "bg-green-100 text-green-700 border border-green-200"}`}>
                  {calculatingPrice ? "..." : `$${Number(formData.calculated_price).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </span>
              )}
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { value: "standard", label: "Standard", desc: "Default pricing", Icon: Zap, color: "blue" },
                { value: "premium", label: "Premium", desc: "Premium rates", Icon: Star, color: "amber" }
              ].map(({ value, label, desc, Icon, color }) => {
                const isSelected = formData.pricing_tier === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={async () => {
                      // Capture before setState
                      const currentAgentId = formData.agent_id;
                      const currentAgencyId = formData.agency_id;
                      const currentProducts = formData.products;
                      const currentPackages = formData.packages;
                      setFormData(prev => ({ ...prev, pricing_tier: value }));
                      setErrors(prev => ({ ...prev, pricing_tier: null }));
                      await recalculatePricing(currentAgentId, currentAgencyId, currentProducts, currentPackages, value);
                    }}
                    disabled={calculatingPrice}
                    className={`relative flex flex-col items-start gap-1 p-4 rounded-xl border-2 text-left transition-all shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${
                      isSelected
                        ? color === "amber" ? "border-amber-500 bg-amber-50 ring-2 ring-amber-500/20 shadow-md" : "border-primary bg-primary/5 ring-2 ring-primary/20 shadow-md"
                        : "border-border bg-card hover:border-muted-foreground/50"
                    }`}
                    title={`Select ${label} pricing tier`}
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-1.5 shadow-sm ${isSelected ? (color === "amber" ? "bg-amber-500 text-white" : "bg-primary text-primary-foreground") : "bg-muted text-muted-foreground"}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className={`font-bold text-sm ${isSelected && color === "amber" ? "text-amber-700" : isSelected ? "text-primary" : ""}`}>{label}</span>
                    <span className="text-xs text-muted-foreground leading-relaxed">{desc}</span>
                    {isSelected && <span className={`absolute top-2 right-2 w-2.5 h-2.5 rounded-full shadow-sm ${color === "amber" ? "bg-amber-500" : "bg-primary"}`} />}
                  </button>
                );
              })}
            </div>
            {errors.pricing_tier && <p className="text-xs text-destructive mt-1">{errors.pricing_tier}</p>}
          </div>

          {/* Packages & Products */}
          <div data-field="items">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5 text-muted-foreground" />
                Products & Packages <span className="text-destructive">*</span>
                {canSeePricing && (formData.products.length > 0 || formData.packages.length > 0) && (() => {
                  const prodTotal = formData.products.reduce((sum, pi) => {
                    const p = products.find(x => x.id === (pi.product_id || pi));
                    return sum + ((p?.standard_price || p?.price || 0) * (pi.quantity || 1));
                  }, 0);
                  const pkgTotal = formData.packages.reduce((sum, pi) => {
                    const p = packagesList.find(x => x.id === (pi.package_id || pi));
                    return sum + (p?.standard_price || p?.price || 0) * (pi.quantity || 1);
                  }, 0);
                  const runningTotal = prodTotal + pkgTotal;
                  return runningTotal > 0 ? (
                    <span className="text-xs font-mono text-muted-foreground ml-1">
                      (base ~${Number(runningTotal).toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })})
                    </span>
                  ) : null;
                })()}
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs shadow-sm hover:shadow-md transition-shadow"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            </div>

            {formData.packages.length === 0 && formData.products.length === 0 ? (
              <div className={`text-xs py-6 text-center border-2 rounded-lg border-dashed transition-colors ${errors.items ? "border-destructive bg-destructive/5 text-destructive" : "text-muted-foreground bg-muted/20"}`}>
                <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="font-medium">{errors.items || "No products or packages added yet"}</p>
                <p className="text-[10px] mt-1 opacity-70">Click "+ Add" above to select services</p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Packages */}
                {formData.packages.map(pkgItem => {
                  const pkgId = pkgItem.package_id || pkgItem;
                  const pkg = packagesList.find(p => p.id === pkgId);
                  if (!pkg) return null;
                  return (
                    <div key={pkgId} className="border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex items-center gap-2 py-2.5 px-3 bg-gradient-to-r from-muted/40 to-muted/20">
                        <Package className="h-4 w-4 text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold" title={pkg.name}>{pkg.name}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{pkg.products?.length || 0} products included</span>
                            {canSeePricing && (pkg.standard_price || pkg.price) > 0 && (
                              <span className="text-xs font-mono text-muted-foreground">${Number(pkg.standard_price || pkg.price).toFixed(2)}</span>
                            )}
                          </div>
                        </div>
                        <button 
                          type="button" 
                          onClick={() => handleRemovePackage(pkgId)} 
                          className="text-destructive hover:text-destructive/80 p-1.5 hover:bg-destructive/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed" 
                          title="Remove package"
                          disabled={saving}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {/* Package products */}
                      {(pkgItem.products || pkg.products || []).length > 0 && (
                        <div className="border-t bg-background p-2 space-y-1">
                          {(pkgItem.products?.length ? pkgItem.products : pkg.products || []).map(pi => {
                            const prodId = pi.product_id;
                            const prodDef = allProducts.find(p => p.id === prodId);
                            const qty = pi.quantity ?? 1;
                            const isPerUnit = prodDef?.pricing_type === "per_unit";
                            return (
                              <div key={prodId} className="flex items-center gap-2 px-2 py-1 rounded bg-muted/20 text-xs">
                                <span className="flex-1 truncate">{prodDef?.name || pi.product_name || prodId}</span>
                                {isPerUnit ? (
                                  <div className="flex items-center gap-0.5 border rounded bg-background" onClick={e => e.stopPropagation()}>
                                    <button type="button" onClick={() => {
                                                 const newPkgs = formData.packages.map(p => (p.package_id || p) !== pkgId ? p : {
                                                   ...p, products: (p.products || []).map(pp => pp.product_id !== prodId ? pp : { ...pp, quantity: Math.max(prodDef?.min_quantity || 1, qty - 1) })
                                                 });
                                                 setFormData(prev => ({ ...prev, packages: newPkgs }));
                                                 const { agent_id: aid, agency_id: agid } = latestAgentRef.current;
                                                 recalculatePricing(aid, agid, formData.products, newPkgs, formData.pricing_tier);
                                               }} className="px-1.5 py-0.5 hover:bg-muted rounded-l disabled:opacity-40 disabled:cursor-not-allowed transition-opacity" disabled={qty <= (prodDef?.min_quantity || 1)}>−</button>
                                    <span className="w-5 text-center font-medium">{qty}</span>
                                    <button type="button" onClick={() => {
                                                       const newPkgs = formData.packages.map(p => (p.package_id || p) !== pkgId ? p : {
                                                         ...p, products: (p.products || []).map(pp => pp.product_id !== prodId ? pp : { ...pp, quantity: prodDef?.max_quantity && qty >= prodDef.max_quantity ? qty : qty + 1 })
                                                       });
                                                       setFormData(prev => ({ ...prev, packages: newPkgs }));
                                                       const { agent_id: aid, agency_id: agid } = latestAgentRef.current;
                                                       recalculatePricing(aid, agid, formData.products, newPkgs, formData.pricing_tier);
                                                     }} className="px-1.5 py-0.5 hover:bg-muted rounded-r disabled:opacity-40 disabled:cursor-not-allowed transition-opacity" disabled={!!(prodDef?.max_quantity && qty >= prodDef.max_quantity)}>+</button>
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">Fixed</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Standalone products */}
                {formData.products.map(prodItem => {
                  const prodId = prodItem.product_id || prodItem;
                  const prod = products.find(p => p.id === prodId);
                  if (!prod) return null;
                  const qty = prodItem.quantity || 1;
                  const isPerUnit = prod.pricing_type === "per_unit";
                  const basePrice = prod.standard_price || prod.price || 0;
                  return (
                    <div key={prodId} className="flex items-center gap-2 py-2.5 px-3 rounded-lg border shadow-sm hover:shadow-md transition-shadow bg-gradient-to-r from-background to-muted/10">
                      <Box className="h-4 w-4 text-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold" title={prod.name}>{prod.name}</p>
                        <div className="flex items-center gap-2">
                          {prod.category && <span className="text-xs text-muted-foreground capitalize">{prod.category}</span>}
                          {canSeePricing && basePrice > 0 && (
                            <span className="text-xs font-mono text-muted-foreground">${Number(basePrice).toFixed(2)}{isPerUnit ? '/ea' : ''}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isPerUnit ? (
                          <div className="flex items-center gap-0.5 border rounded bg-background shadow-sm">
                            <button type="button" onClick={() => {
                               const newProds = formData.products.map(p => (p.product_id || p) !== prodId ? p : { ...p, quantity: Math.max(prod.min_quantity || 1, qty - 1) });
                               setFormData(prev => ({ ...prev, products: newProds }));
                               const { agent_id: aid, agency_id: agid } = latestAgentRef.current;
                               recalculatePricing(aid, agid, newProds, formData.packages, formData.pricing_tier);
                             }} className="px-2 py-1 text-xs hover:bg-muted rounded-l disabled:opacity-40 disabled:cursor-not-allowed transition-opacity font-bold" disabled={qty <= (prod.min_quantity || 1)} title="Decrease quantity">−</button>
                            <span className="text-xs font-bold w-7 text-center tabular-nums border-x">{qty}</span>
                            <button type="button" onClick={() => {
                               const newProds = formData.products.map(p => (p.product_id || p) !== prodId ? p : { ...p, quantity: prod.max_quantity && qty >= prod.max_quantity ? qty : qty + 1 });
                               setFormData(prev => ({ ...prev, products: newProds }));
                               const { agent_id: aid, agency_id: agid } = latestAgentRef.current;
                               recalculatePricing(aid, agid, newProds, formData.packages, formData.pricing_tier);
                             }} className="px-2 py-1 text-xs hover:bg-muted rounded-r disabled:opacity-40 disabled:cursor-not-allowed transition-opacity font-bold" disabled={!!(prod.max_quantity && qty >= prod.max_quantity)} title="Increase quantity">+</button>
                          </div>
                        ) : (
                          <span className="text-xs bg-muted px-2 py-1 rounded font-medium">Fixed</span>
                        )}
                        <button 
                          type="button" 
                          onClick={() => handleRemoveProduct(prodId)} 
                          className="text-destructive hover:text-destructive/80 p-1.5 hover:bg-destructive/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed" 
                          title="Remove product"
                          disabled={saving}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <AddItemsDialog
            open={showAddDialog}
            onOpenChange={setShowAddDialog}
            availableProducts={products.filter(p => {
              if (p.is_active === false) return false;
              // Already added as standalone
              if (formData.products.some(fp => (fp.product_id || fp) === p.id)) return false;
              // Already included inside a selected package
              if (formData.packages.some(pkg => (pkg.products || []).some(pp => pp.product_id === p.id))) return false;
              return true;
            })}
            availablePackages={formData.packages.length > 0 ? [] : packagesList.filter(p => p.is_active !== false && !formData.packages.some(fp => (fp.package_id || fp) === p.id))}
            onAddProduct={(id, qty) => { handleAddProduct(id, qty); }}
            onAddPackage={(id, qty, overrides) => { handleAddPackage(id, qty, overrides); }}
            isLoading={calculatingPrice}
            projectTypeId={formData.project_type_id}
            currentProducts={formData.products}
            currentPackages={formData.packages}
            allProducts={allProducts}
          />

          {/* Remove confirmation dialogs */}
          {showRemoveConfirm?.type === 'product' && (
            <RemoveItemConfirmation
              open={!!showRemoveConfirm}
              itemName={products.find(p => p.id === showRemoveConfirm.id)?.name || 'Product'}
              itemType="Product"
              isLoading={calculatingPrice}
              onConfirm={() => handleConfirmRemoveProduct(showRemoveConfirm.id)}
              onCancel={() => setShowRemoveConfirm(null)}
              affectedCount={0}
            />
          )}
          {showRemoveConfirm?.type === 'package' && (
            <RemoveItemConfirmation
              open={!!showRemoveConfirm}
              itemName={packagesList.find(p => p.id === showRemoveConfirm.id)?.name || 'Package'}
              itemType="Package"
              isLoading={calculatingPrice}
              onConfirm={() => handleConfirmRemovePackage(showRemoveConfirm.id)}
              onCancel={() => setShowRemoveConfirm(null)}
              affectedCount={packagesList.find(p => p.id === showRemoveConfirm.id)?.products?.length || 0}
            />
          )}

          {/* Live pricing preview */}
          {canSeePricing && (formData.products.length > 0 || formData.packages.length > 0) && (
            <>
              {calculatingPrice && (
                <div className="flex items-center gap-2 text-xs text-primary bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 animate-pulse">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="font-medium">Calculating pricing...</span>
                </div>
              )}
            <ProjectFormPricingDisplay 
              products={formData.products}
              packages={formData.packages}
              pricingTier={formData.pricing_tier}
              calculatedPrice={formData.calculated_price || 0}
              isCalculating={calculatingPrice}
              products_data={products}
              packages_data={packagesList}
            />
            </>
          )}

          {/* --- Section: Staff & Notes --- */}
          <div className="border-t pt-4 mt-2" />

          {/* Staff Assignments — dynamic roles based on products/packages */}
          <div>
            <Label className="text-sm font-medium mb-1 block">
              Staff <span className="text-xs font-normal text-muted-foreground ml-1">(optional)</span>
            </Label>
            <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              Staff will be auto-assigned from Project Staff Defaults if left empty.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(() => {
                const userOptions = staffUsers.map(u => ({ id: u.id, label: u.full_name, type: "user" }));
                const teamOptions = internalTeams.filter(t => t.is_active !== false).map(t => ({ id: t.id, label: t.name, type: "team" }));
                const allOptions = [...userOptions, ...teamOptions];
                const hasAnyItems = formData.products.length > 0 || formData.packages.length > 0;

                return roleMappings.map((mapping) => {
                  const role = {
                    key: mapping.role,
                    label: mapping.label,
                    requiredCategories: mapping.categories,
                    legacyKey: mapping.role === "photographer" ? "onsite_staff_1" : mapping.role === "videographer" ? "onsite_staff_2" : undefined,
                  };
                  const isNeeded = hasAnyItems && isRoleRequiredForProject(mapping, formData, allProducts, allPackagesList);
                  const isDisabled = !hasAnyItems || !isNeeded;

                  const idField = `${role.key}_id`;
                  const nameField = `${role.key}_name`;
                  const typeField = `${role.key}_type`;
                  const currentId = formData[idField] || "";
                  const currentType = formData[typeField] || "user";
                  // "not_required" is a detail-page sentinel — treat as unassigned in form
                  const isNotRequired = currentId === "not_required";
                  const effectiveId = isNotRequired ? "" : currentId;
                  const selectedValue = effectiveId
                    ? allOptions.find(opt => opt.id === effectiveId && opt.type === currentType) || null
                    : null;

                  if (isDisabled) {
                    const defaultInfo = getDefaultForRole(role.key);
                    const reason = !hasAnyItems
                      ? "Add products/packages first"
                      : defaultInfo
                        ? `Will use default: ${defaultInfo.name}`
                        : "No default configured";
                    return (
                      <div key={role.key}>
                        <Label className="text-xs text-muted-foreground/60 block mb-1 line-through">{role.label}</Label>
                        <div className={`flex items-center gap-2 p-3 rounded-lg border-2 border-dashed ${defaultInfo && hasAnyItems ? 'border-muted bg-muted/10 text-muted-foreground/70' : 'border-muted bg-muted/20 text-muted-foreground/60'} text-xs h-[60px] select-none cursor-not-allowed`} title={reason}>
                          {defaultInfo && hasAnyItems ? (
                            <CheckCircle className="h-3.5 w-3.5 shrink-0 opacity-50 text-green-600" />
                          ) : (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 opacity-40" />
                          )}
                          <span>{reason}</span>
                        </div>
                      </div>
                    );
                  }

                  const defaultInfo = getDefaultForRole(role.key);
                  return (
                    <div key={role.key}>
                      <Label className="text-xs text-muted-foreground block mb-1">{role.label}</Label>
                      <StaffAssignmentField
                        label={role.label}
                        value={selectedValue}
                        onChange={(opt) => {
                          if (!opt || opt.id === '__use_default__') {
                            // "Use Default" or clear: set to empty, applyProjectRoleDefaults fills it
                            setFormData(prev => ({ ...prev, [idField]: "", [nameField]: "", [typeField]: "" }));
                          } else {
                            setFormData(prev => ({
                              ...prev,
                              [idField]: opt.id,
                              [nameField]: opt.label,
                              [typeField]: opt.type,
                            }));
                          }
                        }}
                        options={allOptions}
                        placeholder={defaultInfo ? `Default: ${defaultInfo.name}` : `Select ${role.label}...`}
                        defaultOption={defaultInfo ? {
                          id: '__use_default__',
                          label: `Use Default (${defaultInfo.name})`,
                          type: defaultInfo.type,
                        } : null}
                      />
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label className="text-sm font-medium flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
                Notes
              </span>
              <span className="text-xs text-muted-foreground font-normal tabular-nums">{(formData.notes || "").length} / {LIMITS.notes}</span>
            </Label>
            <Textarea
              value={formData.notes || ""}
              onChange={(e) => handleFieldChange("notes", e.target.value)}
              placeholder="e.g., Access code: 1234, Gate combo: #5678, Contact Jane for key"
              maxLength={LIMITS.notes}
              rows={3}
              className="resize-none text-sm transition-all focus-visible:ring-primary/50 focus:ring-2"
            />
            <p className="text-[11px] text-muted-foreground mt-1">Access codes, gate combos, contact info, or special instructions for staff.</p>
            <CharacterLimitWarning current={(formData.notes || "").length} max={LIMITS.notes} />
          </div>

          {/* Unsaved changes indicator */}
          {unsavedChanges && (
            <>
              <UnsavedChangesWarning />
              <EscapeKeyWarningBanner unsavedChanges={unsavedChanges} />
            </>
          )}

          {/* Validation error summary */}
          {Object.values(errors).some(Boolean) && !saveError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/20 text-sm">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">Please fix the following:</p>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(errors).filter(([, v]) => v).map(([field, msg]) => (
                    <li key={field} className="text-xs text-destructive/80">
                      <button type="button" className="underline hover:no-underline" onClick={() => {
                        const el = document.querySelector(`[data-field="${field}"]`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}>
                        {field.replace(/_/g, ' ')}
                      </button>: {msg}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Network error with retry */}
          {saveError && (
            <NetworkErrorRetry
              error={saveError}
              onRetry={() => {
                setSaveError(null);
                handleSubmit(new Event('submit'));
              }}
              isRetrying={saving}
            />
          )}
          
          <DialogFooter className="pt-4 border-t gap-2 flex-col sm:flex-row sticky bottom-0 bg-background pb-1">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <SubmitButtonGuard
              isLoading={saving || calculatingPrice}
              isDisabled={calculatingPrice || !canEdit}
              hasErrors={Object.values(errors).some(Boolean)}
              unsavedChanges={unsavedChanges}
              isEdit={!!project}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}