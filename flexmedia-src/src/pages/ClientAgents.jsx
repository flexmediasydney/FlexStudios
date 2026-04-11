import React, { useState, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import {
  Plus, Search, Building, LayoutGrid, Network, Activity,
  Clock, FileText, TreePine, BarChart3, AlertTriangle, Users, User,
  Table as TableIcon, X, UserPlus, Tag, Zap, Calendar, ChevronDown
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import HierarchyTree from "@/components/clients/HierarchyTree";
import HierarchyOrgChart from "@/components/clients/HierarchyOrgChart";
import HierarchyGridView from "@/components/clients/HierarchyGridView";
import HierarchyTableView from "@/components/clients/HierarchyTableView";
import ActivityFeed from "@/components/clients/ActivityFeed";
import ContactTimeline from "@/components/clients/ContactTimeline";
import ClientRulebook from "@/components/clients/ClientRulebook";
import HierarchyStatistics from "@/components/hierarchy/HierarchyStatistics";
import HierarchyHealthCheck from "@/components/hierarchy/HierarchyHealthCheck";
import AgencyForm from "@/components/clients/AgencyForm";
import TeamForm from "@/components/clients/TeamForm";
import AgentForm from "@/components/clients/AgentForm";
import ContactActivityPanel from "@/components/clients/ContactActivityPanel";
import QuickAddContactPanel from "@/components/clients/QuickAddContactPanel";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from '@/components/auth/PermissionGuard';
import { Skeleton } from "@/components/ui/skeleton";
import { differenceInDays } from "date-fns";

// ─── Delete confirm dialog ───
function DeleteConfirmDialog({ item, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  if (!item) return null;
  const entityName = item.item?.name || '';
  const confirmed = typed.trim() === entityName;
  const handleConfirm = async () => {
    if (!confirmed) return;
    setDeleting(true);
    await onConfirm();
    setDeleting(false);
  };
  return (
    <Dialog open onOpenChange={() => onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete {item.type}?</DialogTitle>
          <DialogDescription className="pt-2 space-y-2">
            <p>This will permanently delete <strong>{entityName}</strong> and cannot be undone.</p>
            <p className="text-sm">Type <strong className="font-mono bg-muted px-1 rounded">{entityName}</strong> to confirm:</p>
          </DialogDescription>
        </DialogHeader>
        <Input autoFocus value={typed} onChange={e => setTyped(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConfirm()} placeholder={entityName} className="font-mono" />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={!confirmed || deleting}>
            {deleting ? 'Deleting\u2026' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Constants ───
const TABS = [
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'timeline', label: 'Timeline', icon: Clock },
  { id: 'activity', label: 'Audit Log', icon: Activity },
  { id: 'statistics', label: 'Statistics', icon: BarChart3 },
  { id: 'health', label: 'Health', icon: AlertTriangle },
  { id: 'rulebook', label: 'Rulebook', icon: FileText },
];

const VIEW_MODES = [
  { id: 'table', label: 'Table', icon: TableIcon },
  { id: 'grid', label: 'Cards', icon: LayoutGrid },
  { id: 'tree', label: 'Tree', icon: TreePine },
  { id: 'org', label: 'Org Chart', icon: Network },
];

const QUICK_FILTERS = [
  { id: "idle",        label: "Idle 30+ days", icon: Clock,          color: "text-amber-600 bg-amber-50 border-amber-200" },
  { id: "at_risk",     label: "At risk",       icon: AlertTriangle,  color: "text-red-600 bg-red-50 border-red-200" },
  { id: "active",      label: "Active",        icon: Zap,            color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  { id: "prospecting", label: "Prospecting",   icon: UserPlus,       color: "text-blue-600 bg-blue-50 border-blue-200" },
  { id: "no_email",    label: "Missing email",  icon: AlertTriangle,  color: "text-orange-600 bg-orange-50 border-orange-200" },
];

// ─── Main component ───
export default function ClientAgents() {
  const { canManageContacts } = usePermissions();

  // State
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("contacts");
  const [viewMode, setViewMode] = useState("table"); // Table-first like Pipedrive
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [tagFilter, setTagFilter] = useState(null);
  const [orgFilter, setOrgFilter] = useState(null);

  const [showAgencyForm, setShowAgencyForm] = useState(false);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [deletingItem, setDeletingItem] = useState(null);
  const [preselectedAgencyId, setPreselectedAgencyId] = useState(null);
  const [preselectedTeamId, setPreselectedTeamId] = useState(null);
  const [selectedTimelineEntity, setSelectedTimelineEntity] = useState(null);
  const [selectedTimelineType, setSelectedTimelineType] = useState(null);

  const [selectedAgentIds, setSelectedAgentIds] = useState(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [activityPanelAgent, setActivityPanelAgent] = useState(null);

  const needsExtendedData = activeTab === 'statistics' || activeTab === 'health';

  // Data
  const { data: agencies = [], loading: agenciesLoading } = useEntityList("Agency", "name");
  const { data: teams = [], loading: teamsLoading } = useEntityList("Team", "name");
  const { data: agents = [], loading: agentsLoading } = useEntityList("Agent", "name");
  const { data: projects = [] } = useEntityList("Project", null, 5000);
  const { data: projectTypes = [] } = useEntityList("ProjectType", "name", needsExtendedData ? 200 : 0);
  const { data: products = [] } = useEntityList("Product", null, needsExtendedData ? 500 : 0);
  const { data: packages = [] } = useEntityList("Package", null, needsExtendedData ? 200 : 0);

  const isLoading = agenciesLoading || teamsLoading || agentsLoading;

  // All unique tags for filter dropdown
  const allTags = useMemo(() => {
    const tagSet = new Set();
    agents.forEach(a => {
      if (Array.isArray(a.tags)) a.tags.forEach(t => tagSet.add(t));
    });
    return Array.from(tagSet).sort();
  }, [agents]);

  // Per-agent project counts and revenue
  const { agentProjectCounts, agentRevenue } = useMemo(() => {
    const counts = {};
    const rev = {};
    for (const p of projects) {
      if (p.agent_id) {
        counts[p.agent_id] = (counts[p.agent_id] || 0) + 1;
        rev[p.agent_id] = (rev[p.agent_id] || 0) + (p.calculated_price || p.price || 0);
      }
    }
    return { agentProjectCounts: counts, agentRevenue: rev };
  }, [projects]);

  // Summary stats
  const overdueFollowUps = useMemo(() => {
    const now = new Date();
    return agents.filter(a => a.next_follow_up_date && new Date(a.next_follow_up_date) < now).length;
  }, [agents]);

  const idleCount = useMemo(() => {
    return agents.filter(a => {
      const lc = a.last_contacted_at;
      if (!lc) return true;
      return differenceInDays(new Date(), new Date(lc)) > 30;
    }).length;
  }, [agents]);

  // ─── Filtering pipeline ───
  // Step 1: search
  const searchFiltered = useMemo(() => {
    if (!searchQuery) return agents;
    const q = searchQuery.toLowerCase();
    const qNoSpaces = q.replace(/\s/g, '');
    return agents.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.email?.toLowerCase().includes(q) ||
      a.phone?.replace(/\s/g, '').includes(qNoSpaces) ||
      a.title?.toLowerCase().includes(q) ||
      a.current_agency_name?.toLowerCase().includes(q) ||
      a.current_team_name?.toLowerCase().includes(q) ||
      (Array.isArray(a.tags) && a.tags.some(t => t.toLowerCase().includes(q))) ||
      a.notes?.toLowerCase().includes(q)
    );
  }, [agents, searchQuery]);

  // Step 2: smart filters + tag/org
  const filteredAgents = useMemo(() => {
    let result = searchFiltered;
    if (activeFilters.has("idle")) {
      result = result.filter(a => {
        const lc = a.last_contacted_at;
        if (!lc) return true;
        return differenceInDays(new Date(), new Date(lc)) > 30;
      });
    }
    if (activeFilters.has("at_risk")) result = result.filter(a => a.is_at_risk === true);
    if (activeFilters.has("no_email")) result = result.filter(a => !a.email);
    // OR together mutually exclusive state filters so "Active" + "Prospecting" returns both
    const stateFilters = ["active", "prospecting"].filter(f => activeFilters.has(f));
    if (stateFilters.length > 0) {
      const stateMap = { active: "Active", prospecting: "Prospecting" };
      const allowedStates = new Set(stateFilters.map(f => stateMap[f]));
      result = result.filter(a => allowedStates.has(a.relationship_state));
    }
    if (tagFilter) result = result.filter(a => Array.isArray(a.tags) && a.tags.includes(tagFilter));
    if (orgFilter) result = result.filter(a => a.current_agency_id === orgFilter);
    return result;
  }, [searchFiltered, activeFilters, tagFilter, orgFilter]);

  // For hierarchy views: filter agencies to match
  const filteredAgencies = useMemo(() => {
    if (viewMode === "table") return agencies;
    if (!searchQuery && activeFilters.size === 0 && !tagFilter && !orgFilter) return agencies;
    const ids = new Set(filteredAgents.map(a => a.current_agency_id));
    return agencies.filter(a => ids.has(a.id));
  }, [agencies, filteredAgents, viewMode, searchQuery, activeFilters, tagFilter, orgFilter]);

  const teamsForView = useMemo(() => {
    if (viewMode === "table") return teams;
    if (!searchQuery && activeFilters.size === 0 && !tagFilter && !orgFilter) return teams;
    // Only show teams that have matching agents OR belong to a filtered agency
    const agencyIds = new Set(filteredAgencies.map(a => a.id));
    const teamsWithMatchingAgents = new Set(filteredAgents.map(a => a.current_team_id).filter(Boolean));
    return teams.filter(t => agencyIds.has(t.agency_id) && teamsWithMatchingAgents.has(t.id));
  }, [teams, filteredAgencies, filteredAgents, viewMode, searchQuery, activeFilters, tagFilter, orgFilter]);

  // Health checks for badge count
  const warningCount = useMemo(() => {
    let count = 0;
    const agencyIds = new Set(agencies.map(a => a.id));
    if (agents.some(a => a.current_agency_id && !agencyIds.has(a.current_agency_id))) count++;
    if (teams.some(t => t.agency_id && !agencyIds.has(t.agency_id))) count++;
    return count;
  }, [agencies, teams, agents]);

  const hasActiveFilters = activeFilters.size > 0 || tagFilter || orgFilter;

  // Permission check after all hooks
  if (!canManageContacts) return <div className="p-8 text-center text-muted-foreground">Access restricted.</div>;

  // ─── Callbacks ───
  const toggleFilter = (id) => {
    setActiveFilters(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const clearAllFilters = () => {
    setActiveFilters(new Set());
    setTagFilter(null);
    setOrgFilter(null);
    setSearchQuery("");
  };

  const handleAddTeam = (agencyId) => { setPreselectedAgencyId(agencyId); setPreselectedTeamId(null); setEditingItem(null); setShowTeamForm(true); };
  const handleAddAgent = (agencyId, teamId = null) => { setPreselectedAgencyId(agencyId); setPreselectedTeamId(teamId); setEditingItem(null); setShowAgentForm(true); };
  const handleEdit = (type, item) => {
    setEditingItem(item);
    if (type === 'agency') setShowAgencyForm(true);
    if (type === 'team') setShowTeamForm(true);
    if (type === 'agent') setShowAgentForm(true);
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    try {
      const user = await api.auth.me();
      if (deletingItem.type === 'agency') {
        const hasTeams = teams.some(t => t.agency_id === deletingItem.item.id);
        const hasAgents = agents.some(a => a.current_agency_id === deletingItem.item.id);
        if (hasTeams || hasAgents) { toast.error("Cannot delete organisation with teams or people"); setDeletingItem(null); return; }
        await api.entities.Agency.delete(deletingItem.item.id);
        await api.entities.AuditLog.create({ entity_type: "agency", entity_id: deletingItem.item.id, entity_name: deletingItem.item.name, action: "delete", changed_fields: [], previous_state: deletingItem.item, new_state: {}, user_name: user.full_name, user_email: user.email });
      } else if (deletingItem.type === 'team') {
        const hasAgents = agents.some(a => a.current_team_id === deletingItem.item.id);
        if (hasAgents) { toast.error("Cannot delete team with people"); setDeletingItem(null); return; }
        await api.entities.Team.delete(deletingItem.item.id);
        await api.entities.AuditLog.create({ entity_type: "team", entity_id: deletingItem.item.id, entity_name: deletingItem.item.name, action: "delete", changed_fields: [], previous_state: deletingItem.item, new_state: {}, user_name: user.full_name, user_email: user.email });
      } else if (deletingItem.type === 'agent') {
        try {
          const agentProjects = await api.entities.Project.filter({ agent_id: deletingItem.item.id }, null, 500);
          // Clear agent reference on ALL projects (not just open ones) to prevent
          // stale agent_name on delivered/cancelled projects and broken ID references
          await Promise.all(agentProjects.map(p =>
            api.entities.Project.update(p.id, { agent_id: null, agent_name: null }).catch(() => {})
          ));
        } catch { /* non-fatal */ }

        try {
          const [logs, matrices, events] = await Promise.all([
            api.entities.InteractionLog.filter({ entity_id: deletingItem.item.id, entity_type: 'Agent' }, null, 500).catch(() => []),
            api.entities.PriceMatrix.filter({ entity_type: 'agent', entity_id: deletingItem.item.id }, null, 10).catch(() => []),
            api.entities.CalendarEvent.filter({ agent_id: deletingItem.item.id }, null, 100).catch(() => []),
          ]);
          await Promise.all([
            ...logs.map(l => api.entities.InteractionLog.delete(l.id).catch(() => {})),
            ...matrices.map(m => api.entities.PriceMatrix.delete(m.id).catch(() => {})),
            ...events.map(ev => api.entities.CalendarEvent.update(ev.id, { agent_id: null }).catch(() => {})),
          ]);
        } catch { /* non-fatal */ }

        await api.entities.Agent.delete(deletingItem.item.id);

        if (deletingItem.item.current_agency_id) {
          try {
            const remaining = agents.filter(a =>
              a.id !== deletingItem.item.id && a.current_agency_id === deletingItem.item.current_agency_id
            );
            await api.entities.Agency.update(deletingItem.item.current_agency_id, { agent_count: remaining.length });
          } catch { /* non-fatal */ }
        }

        await api.entities.AuditLog.create({ entity_type: "agent", entity_id: deletingItem.item.id, entity_name: deletingItem.item.name, action: "delete", changed_fields: [], previous_state: deletingItem.item, new_state: {}, user_name: user.full_name, user_email: user.email });
      }
      refetchEntityList("Agency");
      refetchEntityList("Team");
      refetchEntityList("Agent");
      refetchEntityList("AuditLog");
      toast.success("Contact deleted successfully");
    } catch (error) { toast.error(error.message || "Failed to delete contact. Please try again."); }
    setDeletingItem(null);
  };

  const closeAllForms = () => {
    setShowAgencyForm(false); setShowTeamForm(false); setShowAgentForm(false);
    setEditingItem(null); setPreselectedAgencyId(null); setPreselectedTeamId(null);
  };

  const toggleSelectAgent = (id) => {
    setSelectedAgentIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedAgentIds.size === filteredAgents.length) {
      setSelectedAgentIds(new Set());
    } else {
      setSelectedAgentIds(new Set(filteredAgents.map(a => a.id)));
    }
  };

  const clearSelection = () => setSelectedAgentIds(new Set());

  const handleBulkStateChange = async (newState) => {
    if (selectedAgentIds.size === 0) return;
    setBulkActionLoading(true);
    try {
      await Promise.all(
        Array.from(selectedAgentIds).map(id =>
          api.entities.Agent.update(id, { relationship_state: newState })
        )
      );
      refetchEntityList("Agent");
      toast.success(`Updated ${selectedAgentIds.size} contact${selectedAgentIds.size > 1 ? 's' : ''} to ${newState}`);
      clearSelection();
    } catch {
      toast.error('Some updates failed');
    }
    setBulkActionLoading(false);
  };

  // Props for all hierarchy/view components
  const hierarchyProps = {
    agencies: filteredAgencies,
    teams: teamsForView,
    agents: filteredAgents,
    onAddTeam: handleAddTeam,
    onAddAgent: handleAddAgent,
    onEdit: handleEdit,
    onDelete: (type, item) => setDeletingItem({ type, item }),
    selectedAgentIds,
    toggleSelectAgent,
    toggleSelectAll,
    agentsFiltered: filteredAgents,
    agentProjectCounts,
    agentRevenue,
    onOpenActivityPanel: (agent) => setActivityPanelAgent(agent),
  };

  // ─── Render ───
  return (
    <div className="min-h-screen bg-background">
      {/* ═══ Sticky header ═══ */}
      <div className="sticky top-0 z-20 bg-card/95 backdrop-blur border-b">
        <div className="px-6 pt-4 pb-0">
          {/* Title + actions */}
          <div className="flex items-center justify-between gap-4 mb-3">
            <div className="flex items-center gap-4 min-w-0">
              <h1 className="text-xl font-bold tracking-tight">Contacts</h1>
              <div className="hidden md:flex items-center gap-1.5">
                <Badge variant="secondary" className="font-normal gap-1">
                  <User className="h-3 w-3" />{agents.filter(a => a.relationship_state !== 'DNC').length}
                </Badge>
                <Badge variant="secondary" className="font-normal gap-1">
                  <Users className="h-3 w-3" />{teams.filter(t => t.is_active !== false).length}
                </Badge>
                <Badge variant="secondary" className="font-normal gap-1">
                  <Building className="h-3 w-3" />{agencies.filter(a => a.is_active !== false).length}
                </Badge>
                {idleCount > 0 && (
                  <Badge
                    variant="outline"
                    className="font-normal gap-1 text-amber-600 border-amber-200 bg-amber-50 cursor-pointer hover:bg-amber-100"
                    onClick={() => toggleFilter("idle")}
                  >
                    <Clock className="h-3 w-3" />{idleCount} idle
                  </Badge>
                )}
                {overdueFollowUps > 0 && (
                  <Badge variant="outline" className="font-normal gap-1 text-red-600 border-red-200 bg-red-50">
                    <Calendar className="h-3 w-3" />{overdueFollowUps} overdue
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => { setEditingItem(null); setShowAgencyForm(true); }} className="gap-1.5 hidden sm:flex">
                <Building className="h-3.5 w-3.5" />Add Org
              </Button>
              <Button size="sm" onClick={() => setShowQuickAdd(true)} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />Add Contact
              </Button>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-0.5 overflow-x-auto -mb-px">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all whitespace-nowrap",
                  activeTab === tab.id
                    ? "text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
                {tab.id === 'health' && warningCount > 0 && (
                  <span className="ml-0.5 w-4 h-4 flex items-center justify-center bg-amber-500 text-white text-[10px] font-bold rounded-full">
                    {warningCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ Content ═══ */}
      <div className="p-6">

        {/* ── Contacts tab ── */}
        {activeTab === 'contacts' && (
          <div className="space-y-3">
            {/* Search + Filters + View toggle */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                {/* Search */}
                <div className="relative flex-1 max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search name, email, phone, tags, notes\u2026"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="pl-9 h-9"
                    aria-label="Search contacts"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Quick filter chips */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {QUICK_FILTERS.map(f => (
                    <button
                      key={f.id}
                      onClick={() => toggleFilter(f.id)}
                      className={cn(
                        "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
                        activeFilters.has(f.id)
                          ? f.color
                          : "text-muted-foreground border-transparent hover:border-border hover:bg-muted/50"
                      )}
                    >
                      <f.icon className="h-3 w-3" />
                      {f.label}
                    </button>
                  ))}

                  {/* Tag dropdown */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className={cn(
                        "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
                        tagFilter
                          ? "text-violet-600 bg-violet-50 border-violet-200"
                          : "text-muted-foreground border-transparent hover:border-border hover:bg-muted/50"
                      )}>
                        <Tag className="h-3 w-3" />
                        {tagFilter || "Tag"}
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-44 p-1">
                      <button
                        className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted rounded-sm"
                        onClick={() => setTagFilter(null)}
                      >
                        All tags
                      </button>
                      {allTags.map(tag => (
                        <button
                          key={tag}
                          className={cn(
                            "w-full text-left px-2 py-1.5 text-xs hover:bg-muted rounded-sm",
                            tagFilter === tag && "bg-muted font-medium"
                          )}
                          onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>

                  {/* Org dropdown */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className={cn(
                        "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
                        orgFilter
                          ? "text-blue-600 bg-blue-50 border-blue-200"
                          : "text-muted-foreground border-transparent hover:border-border hover:bg-muted/50"
                      )}>
                        <Building className="h-3 w-3" />
                        {orgFilter ? (agencies.find(a => a.id === orgFilter)?.name || "Org") : "Org"}
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-52 p-1 max-h-64 overflow-y-auto">
                      <button
                        className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted rounded-sm"
                        onClick={() => setOrgFilter(null)}
                      >
                        All organisations
                      </button>
                      {agencies.map(a => (
                        <button
                          key={a.id}
                          className={cn(
                            "w-full text-left px-2 py-1.5 text-xs hover:bg-muted rounded-sm truncate",
                            orgFilter === a.id && "bg-muted font-medium"
                          )}
                          onClick={() => setOrgFilter(orgFilter === a.id ? null : a.id)}
                        >
                          {a.name}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                </div>

                {/* View mode */}
                <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5 ml-auto shrink-0">
                  {VIEW_MODES.map(mode => (
                    <button
                      key={mode.id}
                      onClick={() => setViewMode(mode.id)}
                      title={mode.label}
                      aria-label={`Switch to ${mode.label} view`}
                      aria-pressed={viewMode === mode.id}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
                        viewMode === mode.id
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <mode.icon className="h-3.5 w-3.5" />
                      <span className="hidden lg:inline">{mode.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Active filter chips (removable) */}
              {hasActiveFilters && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-muted-foreground mr-1">Filters:</span>
                  {Array.from(activeFilters).map(fId => {
                    const f = QUICK_FILTERS.find(sf => sf.id === fId);
                    if (!f) return null;
                    return (
                      <span key={fId} className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border", f.color)}>
                        {f.label}
                        <button onClick={() => toggleFilter(fId)} className="hover:opacity-70"><X className="h-3 w-3" /></button>
                      </span>
                    );
                  })}
                  {tagFilter && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border text-violet-600 bg-violet-50 border-violet-200">
                      Tag: {tagFilter}
                      <button onClick={() => setTagFilter(null)} className="hover:opacity-70"><X className="h-3 w-3" /></button>
                    </span>
                  )}
                  {orgFilter && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border text-blue-600 bg-blue-50 border-blue-200">
                      Org: {agencies.find(a => a.id === orgFilter)?.name}
                      <button onClick={() => setOrgFilter(null)} className="hover:opacity-70"><X className="h-3 w-3" /></button>
                    </span>
                  )}
                  <button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground ml-1">
                    Clear all
                  </button>
                </div>
              )}
            </div>

            {/* Bulk action bar */}
            {selectedAgentIds.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg animate-in slide-in-from-top-1 duration-200">
                <span className="text-sm font-medium">{selectedAgentIds.size} selected</span>
                <div className="flex items-center gap-1.5 flex-1 flex-wrap">
                  <span className="text-xs text-muted-foreground">Set state:</span>
                  {['Active', 'Prospecting', 'Dormant', 'Do Not Contact'].map(state => (
                    <Button key={state} variant="outline" size="sm" disabled={bulkActionLoading}
                      onClick={() => handleBulkStateChange(state)} className="h-7 text-xs">
                      {state}
                    </Button>
                  ))}
                </div>
                <button onClick={clearSelection} className="text-sm text-muted-foreground hover:text-foreground">Clear</button>
              </div>
            )}

            {/* View content */}
            {isLoading ? (
              <ContactsTableSkeleton />
            ) : agents.length === 0 ? (
              <Card className="p-16 text-center border-dashed bg-muted/10">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <Users className="h-8 w-8 text-primary/60" />
                </div>
                <h3 className="font-semibold text-lg mb-1">No contacts yet</h3>
                <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                  Add your first contact to get started.
                </p>
                <Button onClick={() => setShowQuickAdd(true)} className="gap-2">
                  <Plus className="h-4 w-4" />Add First Contact
                </Button>
              </Card>
            ) : (
              <>
                {viewMode === "table" && <HierarchyTableView {...hierarchyProps} />}
                {viewMode === "grid" && <HierarchyGridView {...hierarchyProps} />}
                {viewMode === "tree" && <HierarchyTree {...hierarchyProps} />}
                {viewMode === "org" && <HierarchyOrgChart {...hierarchyProps} />}
              </>
            )}
          </div>
        )}

        {/* ── Timeline ── */}
        {activeTab === 'timeline' && (
          <Card className="p-6">
            <div className="flex gap-3 mb-6 flex-wrap">
              <Select value={selectedTimelineType || ""} onValueChange={v => { setSelectedTimelineType(v); setSelectedTimelineEntity(null); }}>
                <SelectTrigger className="w-36"><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="agency">Organisation</SelectItem>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem value="agent">Person</SelectItem>
                </SelectContent>
              </Select>
              <Select value={selectedTimelineEntity || ""} onValueChange={setSelectedTimelineEntity} disabled={!selectedTimelineType}>
                <SelectTrigger className="flex-1 min-w-48 max-w-md">
                  <SelectValue placeholder={selectedTimelineType ? `Select ${selectedTimelineType}` : "Select type first"} />
                </SelectTrigger>
                <SelectContent>
                  {selectedTimelineType === "agency" && agencies.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  {selectedTimelineType === "team" && teams.map(t => <SelectItem key={t.id} value={t.id}>{t.name}{t.agency_name ? ` (${t.agency_name})` : ''}</SelectItem>)}
                  {selectedTimelineType === "agent" && agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}{a.current_agency_name ? ` (${a.current_agency_name})` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {!selectedTimelineEntity && (
              <div className="text-center py-10 text-muted-foreground text-sm">
                Select a type and entity above to view their timeline
              </div>
            )}
            {selectedTimelineEntity && <ContactTimeline entityType={selectedTimelineType} entityId={selectedTimelineEntity} />}
          </Card>
        )}

        {activeTab === 'activity' && <ActivityFeed />}

        {activeTab === 'statistics' && (
          <HierarchyStatistics agencies={agencies} teams={teams} agents={agents} projectTypes={projectTypes} products={products} packages={packages} />
        )}

        {activeTab === 'health' && (
          <HierarchyHealthCheck
            checks={(() => {
              const checks = [];
              // Use Sets for O(1) lookups instead of O(N) .find() per item
              const agencyIds = new Set(agencies.map(a => a.id));
              const agentAgencyIds = new Set(agents.map(a => a.current_agency_id).filter(Boolean));
              const teamAgencyIds = new Set(teams.map(t => t.agency_id).filter(Boolean));
              const orphanedAgents = agents.filter(a => a.current_agency_id && !agencyIds.has(a.current_agency_id));
              if (orphanedAgents.length > 0) checks.push({ type: "warning", title: "Orphaned People", message: `${orphanedAgents.length} person(s) reference non-existent organisations`, agents: orphanedAgents });
              const orphanedTeams = teams.filter(t => t.agency_id && !agencyIds.has(t.agency_id));
              if (orphanedTeams.length > 0) checks.push({ type: "warning", title: "Orphaned Teams", message: `${orphanedTeams.length} team(s) reference non-existent organisations`, teams: orphanedTeams });
              const emptyAgencies = agencies.filter(a => !agentAgencyIds.has(a.id) && !teamAgencyIds.has(a.id));
              if (emptyAgencies.length > 0) checks.push({ type: "info", title: "Empty Organisations", message: `${emptyAgencies.length} organisation(s) have no teams or people`, agencies: emptyAgencies });
              return checks;
            })()}
            agents={agents} teams={teams} agencies={agencies}
          />
        )}

        {activeTab === 'rulebook' && <ClientRulebook />}
      </div>

      {/* ═══ Dialogs & panels ═══ */}
      <AgencyForm agency={editingItem && showAgencyForm ? editingItem : null} open={showAgencyForm} onClose={closeAllForms} />
      <TeamForm team={editingItem && showTeamForm ? editingItem : null} open={showTeamForm} onClose={closeAllForms} preselectedAgencyId={preselectedAgencyId} />
      <AgentForm agent={editingItem && showAgentForm ? editingItem : null} open={showAgentForm} onClose={closeAllForms} preselectedAgencyId={preselectedAgencyId} preselectedTeamId={preselectedTeamId} />
      <DeleteConfirmDialog item={deletingItem} onConfirm={handleDelete} onCancel={() => setDeletingItem(null)} />

      {/* Quick-add slide-in panel */}
      <QuickAddContactPanel
        open={showQuickAdd}
        onOpenChange={setShowQuickAdd}
        agencies={agencies}
        preselectedAgencyId={preselectedAgencyId}
      />

      {/* Activity side panel */}
      {activityPanelAgent && (
        <div className="fixed inset-y-0 right-0 w-96 z-30 shadow-2xl animate-in slide-in-from-right duration-200">
          <ContactActivityPanel
            agent={activityPanelAgent}
            onClose={() => setActivityPanelAgent(null)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Skeleton ───
function ContactsTableSkeleton() {
  return (
    <div className="space-y-0 animate-in fade-in duration-300">
      <div className="border rounded-xl overflow-hidden">
        <div className="bg-muted/30 px-3 py-3 flex items-center gap-4 border-b">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
        {Array(8).fill(0).map((_, i) => (
          <div key={i} className="px-3 py-3 flex items-center gap-4 border-b">
            <Skeleton className="h-4 w-4 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
