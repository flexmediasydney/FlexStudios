import { useState, useMemo, useCallback } from "react";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CheckCircle2, Circle, XCircle, Search,
  Link2, Unlink, ChevronDown, Users, Wrench, Package, User, RefreshCw, Loader2, Workflow, Layers
} from "lucide-react";
import { relativeTime, parseTS } from "@/components/tonomo/tonomoUtils";
import { toast } from "sonner";

// Type config
const TYPE_CONFIG = {
  service:      { label: "Services",        icon: Wrench,    color: "#8b5cf6", rightEntity: "products"       },
  package:      { label: "Packages",        icon: Package,   color: "#3b82f6", rightEntity: "packages"       },
  bookingflow:  { label: "Booking Flows",   icon: Workflow,  color: "#0ea5e9", rightEntity: "bookingflows"   },
  projecttype:  { label: "Project Types",   icon: Layers,    color: "#ec4899", rightEntity: "projecttypes"   },
  photographer: { label: "People",          icon: Users,     color: "#10b981", rightEntity: "users"          },
  agent:        { label: "Contacts",        icon: User,      color: "#f59e0b", rightEntity: "agents"         },
};



// Status helpers
function getStatus(mapping, rightEntities) {
  if (!mapping.flexmedia_entity_id) return "unlinked";
  const exists = (rightEntities || []).some(e => e.id === mapping.flexmedia_entity_id);
  if (!exists) return "broken";
  if (mapping.is_confirmed) return "linked";
  return "suggested";
}

const STATUS = {
  linked:    { dot: "bg-green-500",  line: "border-green-400",  label: "Linked",     icon: CheckCircle2, iconColor: "text-green-600"  },
  suggested: { dot: "bg-blue-400",   line: "border-blue-300",   label: "Suggested",  icon: Circle,       iconColor: "text-blue-500"   },
  unlinked:  { dot: "bg-gray-300",   line: "border-dashed border-gray-300", label: "Unlinked", icon: Circle, iconColor: "text-gray-400" },
  broken:    { dot: "bg-red-500",    line: "border-red-300",    label: "Broken",     icon: XCircle,      iconColor: "text-red-500"    },
};

// Main page
export default function SettingsTonomoMappings() {
  const [activeType, setActiveType] = useState("service");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: mappings = [], isLoading, refetch } = useQuery({
    queryKey: ["tonomoMappings"],
    queryFn: () => api.entities.TonomoMappingTable.list("-last_seen_at", 1000),
    staleTime: 30_000,
    onError: (err) => toast.error('Failed to load mappings — ' + (err?.message || 'unknown error')),
  });

  const { data: products = [] } = useQuery({
    queryKey: ["products"],
    queryFn: () => api.entities.Product.filter({ is_active: true }, "-updated_date"),
    staleTime: 5 * 60_000,
  });
  const { data: packages = [] } = useQuery({
    queryKey: ["packages"],
    queryFn: () => api.entities.Package.filter({ is_active: true }, "-updated_date"),
    staleTime: 5 * 60_000,
  });
  const { data: users = [] } = useQuery({
    queryKey: ["users-for-mapping"],
    queryFn: () => api.entities.User.list("-created_date", 500),
    staleTime: 5 * 60_000,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ["agents-for-mapping"],
    queryFn: () => api.entities.Agent.list("name", 2000),
    staleTime: 5 * 60_000,
  });
  
  const { data: bookingFlows = [], refetch: refetchFlows } = useQuery({
    queryKey: ["tonomo-booking-flows"],
    queryFn: () => api.entities.TonomoBookingFlowTier.list('-last_seen_at', 100),
    staleTime: 30_000,
  });

  const { data: projectTypeMappings = [], refetch: refetchTypeMap } = useQuery({
    queryKey: ["tonomo-project-type-mappings"],
    queryFn: () => api.entities.TonomoProjectTypeMapping.list('-created_date', 50),
    staleTime: 30_000,
  });

  const { data: flexProjectTypes = [] } = useQuery({
    queryKey: ["project-types-for-mapping"],
    queryFn: () => api.entities.ProjectType.list('order', 50),
    staleTime: 5 * 60_000,
  });

  const rightEntities = { products, packages, users, agents, bookingflows: bookingFlows, projecttypes: flexProjectTypes };

  const saveMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.TonomoMappingTable.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tonomoMappings"] }),
    onError: () => toast.error("Failed to save"),
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.User.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-for-mapping"] }),
    onError: (err) => toast.error(err?.message || "Operation failed"),
  });

  // Generate virtual mappings for unmapped FlexStudios entities
  const allTabMappings = useMemo(() => {
    // Booking flows tab — driven by TonomoBookingFlowTier records directly
    if (activeType === 'bookingflow') {
      return bookingFlows.map(flow => ({
        id: flow.id,
        _isFlowRecord: true,
        tonomo_id: flow.tonomo_flow_id,
        tonomo_label: flow.tonomo_flow_name,
        tonomo_flow_type: flow.tonomo_flow_type,
        pricing_tier: flow.pricing_tier,
        last_seen_at: flow.last_seen_at,
        seen_count: flow.seen_count,
        mapping_type: 'bookingflow',
        is_confirmed: true,
        flexmedia_entity_id: null,
      }));
    }

    if (activeType === 'projecttype') {
      return projectTypeMappings.map(mapping => ({
        id: mapping.id,
        _isProjectTypeRecord: true,
        tonomo_flow_type: mapping.tonomo_flow_type,
        project_type_id: mapping.project_type_id,
        project_type_name: mapping.project_type_name,
        is_default: mapping.is_default,
        last_seen_at: mapping.last_seen_at,
        seen_count: mapping.seen_count,
        mapping_type: 'projecttype',
      }));
    }
    
    const entKey = TYPE_CONFIG[activeType]?.rightEntity;
    const ents = rightEntities[entKey] || [];
    const realMappings = mappings.filter(m => m.mapping_type === activeType);
    
    // Create a set of FlexStudios IDs that have mappings
    const mappedIds = new Set(realMappings.map(m => m.flexmedia_entity_id).filter(Boolean));
    
    // For each entity without a mapping, create a virtual mapping
    const virtualMappings = ents
      .filter(e => !mappedIds.has(e.id))
      .map(e => ({
        id: `virtual-${e.id}`,
        tonomo_id: null,
        tonomo_label: null,
        mapping_type: activeType,
        flexmedia_entity_id: e.id,
        flexmedia_label: e.full_name || e.name || e.title || "—",
        is_confirmed: false,
        auto_suggested: false,
        confidence: "none",
        is_virtual: true,
        last_seen_at: null,
        seen_count: 0,
      }));
    
    return [...realMappings, ...virtualMappings];
  }, [mappings, activeType, products, packages, users, agents, bookingFlows]);

  // Filter for current tab
  const tabMappings = useMemo(() => {
    const entKey = TYPE_CONFIG[activeType]?.rightEntity;
    const ents = rightEntities[entKey] || [];
    return allTabMappings
      .filter(m => {
        const s = getStatus(m, ents);
        if (statusFilter !== "all" && s !== statusFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          return (m.tonomo_label || "").toLowerCase().includes(q) ||
                 (m.flexmedia_label || "").toLowerCase().includes(q);
        }
        return true;
      })
      .sort((a, b) => {
        const order = { broken: 0, unlinked: 1, suggested: 2, linked: 3 };
        const entKey2 = TYPE_CONFIG[activeType]?.rightEntity;
        const e2 = rightEntities[entKey2] || [];
        return (order[getStatus(a, e2)] ?? 2) - (order[getStatus(b, e2)] ?? 2);
      });
  }, [allTabMappings, activeType, statusFilter, search, products, packages, users, agents, bookingFlows, projectTypeMappings, flexProjectTypes]);

  // Tab counts (show all entities including unmapped)
  const tabCounts = useMemo(() => {
    const counts = {};
    for (const type of Object.keys(TYPE_CONFIG)) {
      const entKey = TYPE_CONFIG[type]?.rightEntity;
      const ents = rightEntities[entKey] || [];
      if (type === 'projecttype') {
        counts[type] = projectTypeMappings.length;
      } else if (type === 'bookingflow') {
        counts[type] = bookingFlows.length;
      } else {
        const realCount = mappings.filter(m => m.mapping_type === type).length;
        counts[type] = Math.max(realCount, ents.length);
      }
    }
    return counts;
  }, [mappings, products, packages, users, agents, bookingFlows, projectTypeMappings]);

  // Summary stats for current tab
  const stats = useMemo(() => {
    const entKey = TYPE_CONFIG[activeType]?.rightEntity;
    const ents = rightEntities[entKey] || [];
    const all = mappings.filter(m => m.mapping_type === activeType);
    return {
      linked: all.filter(m => getStatus(m, ents) === "linked").length,
      suggested: all.filter(m => getStatus(m, ents) === "suggested").length,
      unlinked: all.filter(m => getStatus(m, ents) === "unlinked").length,
      broken: all.filter(m => getStatus(m, ents) === "broken").length,
      total: all.length,
    };
  }, [mappings, activeType, products, packages, users, agents, bookingFlows, projectTypeMappings]);

  const handleLink = useCallback((mapping, entityId, entityLabel, extraData = {}) => {
    saveMutation.mutate({
      id: mapping.id,
      data: { flexmedia_entity_id: entityId, flexmedia_label: entityLabel, is_confirmed: true, auto_suggested: false, confidence: "high", ...extraData }
    });
    toast.success("Linked");
  }, [saveMutation]);

  const handleUnlink = useCallback((mapping) => {
    saveMutation.mutate({
      id: mapping.id,
      data: { flexmedia_entity_id: null, flexmedia_label: null, is_confirmed: false, auto_suggested: false, confidence: "low" }
    });
    toast.success("Unlinked");
  }, [saveMutation]);

  const handleConfirm = useCallback((mapping) => {
    saveMutation.mutate({
      id: mapping.id,
      data: { is_confirmed: true, auto_suggested: false }
    });
    toast.success("Confirmed");
  }, [saveMutation]);

  const currentTypeConfig = TYPE_CONFIG[activeType];
  const TypeIcon = currentTypeConfig?.icon || Wrench;
  const entKey = currentTypeConfig?.rightEntity;
  const currentEntities = rightEntities[entKey] || [];

  return (
    <ErrorBoundary>
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tonomo Mappings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Link Tonomo entities to your FlexStudios records. Confirmed links apply automatically to every booking.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Type tabs */}
        <div className="flex gap-1">
          {Object.entries(TYPE_CONFIG).map(([type, cfg]) => {
            const Icon = cfg.icon;
            const isActive = activeType === type;
            const entKey2 = cfg.rightEntity;
            const ents2 = rightEntities[entKey2] || [];
            const brokenCount = mappings.filter(m => m.mapping_type === type && getStatus(m, ents2) === "broken").length;
            const unlinkedCount = mappings.filter(m => m.mapping_type === type && getStatus(m, ents2) === "unlinked").length;
            const attentionNeeded = brokenCount + unlinkedCount;
            return (
              <button
                key={type}
                onClick={() => setActiveType(type)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all relative ${
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {cfg.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? "bg-white/20" : "bg-muted-foreground/15"}`}>
                  {tabCounts[type] || 0}
                </span>
                {attentionNeeded > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
                    {attentionNeeded}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters + stats bar */}
      <div className="border-b px-6 py-3 flex items-center gap-4">
        {/* Stats pills */}
        <div className="flex items-center gap-3 text-xs">
          <StatusPill status="linked"    count={stats.linked}    />
          <StatusPill status="suggested" count={stats.suggested} label="Auto-suggested" />
          <StatusPill status="unlinked"  count={stats.unlinked}  label="Unlinked" />
          {stats.broken > 0 && <StatusPill status="broken" count={stats.broken} />}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="linked">Linked</SelectItem>
              <SelectItem value="suggested">Auto-suggested</SelectItem>
              <SelectItem value="unlinked">Unlinked</SelectItem>
              <SelectItem value="broken">Broken</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 pl-8 w-48 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Column headers */}
      {activeType === 'projecttype' ? (
        <div className="grid grid-cols-[1fr_28px_220px_120px] gap-0 px-6 py-2 border-b bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <div>Tonomo flow type</div>
          <div />
          <div>FlexStudios project type</div>
          <div className="text-right">Default fallback</div>
        </div>
      ) : activeType === 'bookingflow' ? (
        <div className="grid grid-cols-[1fr_120px_200px_120px] gap-0 px-6 py-2 border-b bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <div>Tonomo booking flow</div>
          <div>Type</div>
          <div>Pricing tier</div>
          <div />
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_120px_1fr_120px] gap-0 px-6 py-2 border-b bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <div>Tonomo</div>
          <div className="text-center">Status</div>
          <div>FlexStudios</div>
          <div />
        </div>
      )}

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tabMappings.length === 0 ? (
           <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
             <TypeIcon className="h-10 w-10 mb-3 opacity-20" />
             <p className="font-medium">
               {search ? "No results match your search" : `No ${currentTypeConfig?.label.toLowerCase()} mappings yet`}
             </p>
             <p className="text-sm mt-1 text-center max-w-sm">
               {!search && "Mappings are created automatically when Tonomo webhooks are processed. Fire a test booking to populate this list."}
             </p>
           </div>
         ) : (
           tabMappings.map(mapping => (
             mapping._isFlowRecord ? (
               <BookingFlowRow
                 key={mapping.id}
                 flow={mapping}
                 isSaving={saveMutation.isPending}
                 onSetTier={async (id, tier) => {
                   await api.entities.TonomoBookingFlowTier.update(id, { pricing_tier: tier });
                   refetchFlows();
                 }}
               />
             ) : mapping._isProjectTypeRecord ? (
               <ProjectTypeRow
                 key={mapping.id}
                 mapping={mapping}
                 projectTypes={flexProjectTypes}
                 isSaving={saveMutation.isPending}
                 onSetType={async (id, typeId, typeName) => {
                   await api.entities.TonomoProjectTypeMapping.update(id, {
                     project_type_id: typeId,
                     project_type_name: typeName,
                   });
                   refetchTypeMap();
                 }}
                 onToggleDefault={async (id, makeDefault) => {
                   if (makeDefault) {
                     const currentDefault = projectTypeMappings.find(m => m.is_default && m.id !== id);
                     if (currentDefault) {
                       await api.entities.TonomoProjectTypeMapping.update(
                         currentDefault.id, { is_default: false }
                       );
                     }
                   }
                   await api.entities.TonomoProjectTypeMapping.update(id, { is_default: makeDefault });
                   refetchTypeMap();
                 }}
               />
             ) : (
               <MappingRow
                 key={mapping.id}
                 mapping={mapping}
                 type={activeType}
                 entities={currentEntities}
                 users={users}
                 onLink={handleLink}
                 onUnlink={handleUnlink}
                 onConfirm={handleConfirm}
                 onUpdateUser={updateUserMutation}
                 isSaving={saveMutation.isPending}
               />
             )
           ))
         )}
      </div>
    </div>
    </ErrorBoundary>
  );
}

// Project type row
function ProjectTypeRow({ mapping, projectTypes, onSetType, onToggleDefault, isSaving }) {
  const currentType = projectTypes.find(t => t.id === mapping.project_type_id);

  return (
    <div className="grid grid-cols-[1fr_28px_220px_120px] gap-0 px-6 py-3 border-b hover:bg-muted/20 transition-colors items-center">

      {/* LEFT — Tonomo flow type */}
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ backgroundColor: '#ec489918' }}>
          <Layers className="h-3.5 w-3.5" style={{ color: '#ec4899' }} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium font-mono">
              {mapping.tonomo_flow_type || '(unknown type)'}
            </p>
            {mapping.is_default && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                Default
              </span>
            )}
          </div>
          {mapping.last_seen_at && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Last seen {relativeTime(parseTS(mapping.last_seen_at))}
              {mapping.seen_count > 1 ? ` · ${mapping.seen_count}×` : ''}
            </p>
          )}
        </div>
      </div>

      {/* Arrow */}
      <div className="flex items-center justify-center text-muted-foreground text-sm">→</div>

      {/* RIGHT — ProjectType selector */}
      <div>
        <select
          value={mapping.project_type_id || ''}
          onChange={e => {
            const typeId = e.target.value;
            const typeName = projectTypes.find(t => t.id === typeId)?.name || '';
            onSetType(mapping.id, typeId || null, typeName || null);
          }}
          disabled={isSaving}
          className="w-full border rounded-lg px-2.5 py-1.5 text-sm bg-background"
        >
          <option value="">— Not mapped —</option>
          {projectTypes.filter(t => t.is_active !== false).map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {!mapping.project_type_id && (
          <p className="text-xs text-amber-600 mt-1">⚠ Unmapped — booking type unset</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        {mapping.project_type_id && (
          <button
            onClick={() => onToggleDefault(mapping.id, !mapping.is_default)}
            disabled={isSaving}
            className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
              mapping.is_default
                ? 'bg-amber-100 text-amber-700 border-amber-300'
                : 'border-border text-muted-foreground hover:border-amber-400 hover:text-amber-600'
            }`}
            title={mapping.is_default
              ? 'This is the default fallback for unmapped flow types'
              : 'Set as default fallback'}
          >
            {mapping.is_default ? '★ Default' : '☆ Set default'}
          </button>
        )}
      </div>
    </div>
  );
}

// Booking flow row
function BookingFlowRow({ flow, onSetTier, isSaving }) {
  const tier = flow.pricing_tier;

  return (
    <div className="grid grid-cols-[1fr_120px_200px_120px] gap-0 px-6 py-3 border-b hover:bg-muted/20 transition-colors items-center">
      {/* LEFT — Flow name */}
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ backgroundColor: '#0ea5e918' }}>
          <Workflow className="h-3.5 w-3.5" style={{ color: '#0ea5e9' }} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{flow.tonomo_label || 'Unknown flow'}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {flow.tonomo_id?.slice(0, 24)}{flow.tonomo_id?.length > 24 ? '…' : ''}
          </p>
          {flow.last_seen_at && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Last seen {relativeTime(parseTS(flow.last_seen_at))}
              {flow.seen_count > 1 ? ` · ${flow.seen_count}×` : ''}
            </p>
          )}
        </div>
      </div>

      {/* Center — type badge */}
      <div className="flex items-center justify-center">
        {flow.tonomo_flow_type && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {flow.tonomo_flow_type}
          </span>
        )}
      </div>

      {/* RIGHT — pricing tier toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSetTier(flow.id, 'standard')}
          disabled={isSaving}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
            tier === 'standard'
              ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
              : 'border-border text-muted-foreground hover:border-blue-400 hover:text-blue-600'
          }`}
        >
          S Standard
        </button>
        <button
          onClick={() => onSetTier(flow.id, 'premium')}
          disabled={isSaving}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
            tier === 'premium'
              ? 'bg-purple-600 text-white border-purple-600 shadow-sm'
              : 'border-border text-muted-foreground hover:border-purple-400 hover:text-purple-600'
          }`}
        >
          P Premium
        </button>
        {!tier && (
          <span className="text-xs text-amber-600">⚠ Not set</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end">
        {!tier && (
          <span className="text-xs text-amber-600 font-medium">Needs mapping</span>
        )}
        {tier && (
          <span className="text-xs text-green-600">✓ Mapped</span>
        )}
      </div>
    </div>
  );
}

// Status pill
function StatusPill({ status, count, label }) {
  const cfg = STATUS[status];
  const Icon = cfg.icon;
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1">
      <Icon className={`h-3 w-3 ${cfg.iconColor}`} />
      <span className={cfg.iconColor}>{count}</span>
      <span className="text-muted-foreground">{label || cfg.label}</span>
    </span>
  );
}

// Single mapping row
function MappingRow({ mapping, type, entities, users, onLink, onUnlink, onConfirm, onUpdateUser, isSaving }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");

  const status = getStatus(mapping, entities);
  const cfg = STATUS[status];
  const StatusIcon = cfg.icon;

  const linkedEntity = entities.find(e => e.id === mapping.flexmedia_entity_id);
  const linkedUser = type === "photographer" ? users.find(u => u.id === mapping.flexmedia_entity_id) : null;

  const filteredEntities = useMemo(() => {
    if (!search) return entities;
    const q = search.toLowerCase();
    return entities.filter(e => {
      const name = e.full_name || e.name || "";
      const email = e.email || "";
      const category = e.category || "";
      return name.toLowerCase().includes(q) ||
             email.toLowerCase().includes(q) ||
             category.toLowerCase().includes(q);
    });
  }, [entities, search]);

  const entityName = (e) => e?.full_name || e?.name || e?.title || "—";
  const entitySub = (e) => {
    if (!e) return "";
    if (e.email) return e.email;
    if (e.category) return e.category;
    return "";
  };

  const TypeIcon = TYPE_CONFIG[type]?.icon || Wrench;
  const typeColor = TYPE_CONFIG[type]?.color || "#6b7280";

  return (
    <div className={`grid grid-cols-[1fr_120px_1fr_120px] gap-0 px-6 py-3 border-b hover:bg-muted/20 transition-colors items-center ${
      status === "broken" ? "bg-red-50/50" : ""
    }`}>
      {/* LEFT — Tonomo side */}
      <div className="flex items-start gap-2.5 min-w-0">
        <div
          className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ backgroundColor: `${typeColor}18` }}
        >
          <TypeIcon className="h-3.5 w-3.5" style={{ color: typeColor }} />
        </div>
        <div className="min-w-0">
          {mapping.tonomo_label ? (
            <>
              <p className="text-sm font-medium truncate">{mapping.tonomo_label}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">
                {mapping.tonomo_id?.slice(0, 20)}{mapping.tonomo_id?.length > 20 ? "…" : ""}
              </p>
              {mapping.last_seen_at && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Last seen {relativeTime(parseTS(mapping.last_seen_at))}
                  {mapping.seen_count > 1 ? ` · ${mapping.seen_count}×` : ""}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic">Not yet detected</p>
          )}
        </div>
      </div>

      {/* CENTER — Status connector */}
      <div className="flex flex-col items-center gap-1">
        <StatusIcon className={`h-4 w-4 ${cfg.iconColor}`} />
        <div className={`h-px w-16 border-t-2 ${cfg.line}`} />
        <span className={`text-xs font-medium ${cfg.iconColor}`}>{cfg.label}</span>
      </div>

      {/* RIGHT — FlexStudios side */}
      <div className="relative min-w-0">
        {linkedEntity ? (
          <div className="flex items-start gap-2.5">
            <div className="w-7 h-7 rounded bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{entityName(linkedEntity)}</p>
              {entitySub(linkedEntity) && (
                <p className="text-xs text-muted-foreground truncate">{entitySub(linkedEntity)}</p>
              )}
              {(type === 'service' || type === 'package') && mapping.detected_tier_hint && (
                <span className={`inline-block mt-1 text-xs px-1.5 py-0.5 rounded font-medium ${
                  mapping.detected_tier_hint === 'premium'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-blue-100 text-blue-700'
                }`}>
                  {mapping.detected_tier_hint === 'premium' ? 'P Premium' : 'S Standard'}
                  {mapping.tier_hint_override && ' (override)'}
                </span>
              )}
              {(type === 'service' || type === 'package') && !mapping.detected_tier_hint && mapping.is_confirmed && (
                <span className="inline-block mt-1 text-xs text-muted-foreground/60">
                  No (s)/(p) annotation detected
                </span>
              )}
              {/* Role derived from team membership — managed in Settings → Teams */}
              {type === "photographer" && linkedUser && linkedUser.internal_team_id && (
                <p className="text-xs text-muted-foreground mt-1">
                  Role set by team membership
                </p>
              )}
            </div>
          </div>
        ) : status === "broken" ? (
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
            <div>
              <p className="text-sm text-red-700 font-medium">Entity deleted</p>
              <p className="text-xs text-red-600">{mapping.flexmedia_label} no longer exists</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Circle className="h-4 w-4 flex-shrink-0" />
            <p className="text-sm italic">Not linked</p>
          </div>
        )}

        {/* Inline picker dropdown */}
        {pickerOpen && (
          <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-background border rounded-lg shadow-lg">
            <div className="p-2 border-b">
              <Input
                autoFocus
                placeholder="Search…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
            <div className="px-2 py-1 border-b text-xs text-muted-foreground">
              {filteredEntities.length} record{filteredEntities.length !== 1 ? "s" : ""}
              {search && ` matching "${search}"`}
            </div>
            <div className="max-h-72 overflow-y-auto">
              {filteredEntities.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No results</p>
              ) : (
                filteredEntities.map(e => (
                  <button
                    key={e.id}
                    className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors"
                    onClick={() => {
                      onLink(mapping, e.id, entityName(e));
                      setPickerOpen(false);
                      setSearch("");
                    }}
                  >
                    <p className="text-sm font-medium">{entityName(e)}</p>
                    {entitySub(e) && <p className="text-xs text-muted-foreground">{entitySub(e)}</p>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* ACTIONS */}
      <div className="flex items-center justify-end gap-1.5">
        {status === "suggested" && (
          <Button
            size="sm"
            className="h-7 text-xs px-3"
            onClick={() => onConfirm(mapping)}
            disabled={isSaving}
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Confirm
          </Button>
        )}
        {(status === "unlinked" || status === "broken" || mapping.is_virtual) && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-3"
            onClick={() => { setPickerOpen(p => !p); setSearch(""); }}
            disabled={mapping.is_virtual && !mapping.tonomo_id}
            title={mapping.is_virtual && !mapping.tonomo_id ? "Awaiting webhook" : ""}
          >
            <Link2 className="h-3 w-3 mr-1" />
            Link
            <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
        )}
        {status === "linked" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive"
            onClick={() => { setPickerOpen(p => !p); setSearch(""); }}
            title="Change linked entity"
          >
            <Link2 className="h-3 w-3 mr-1" />
            Change
          </Button>
        )}
        {(status === "linked" || status === "suggested") && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            onClick={() => onUnlink(mapping)}
            disabled={isSaving}
            title="Unlink"
          >
            <Unlink className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}