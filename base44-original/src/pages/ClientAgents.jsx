import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useEntityList } from "@/components/hooks/useEntityData";
import {
  Plus, Search, Building, LayoutGrid, Network, Activity,
  Clock, FileText, TreePine, BarChart3, AlertTriangle, Users, User,
  Table as TableIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from '@/components/auth/PermissionGuard';

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
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TABS = [
  { id: 'hierarchy', label: 'Hierarchy', icon: Network },
  { id: 'timeline', label: 'Timeline', icon: Clock },
  { id: 'activity', label: 'Audit Log', icon: Activity },
  { id: 'statistics', label: 'Statistics', icon: BarChart3 },
  { id: 'health', label: 'Health', icon: AlertTriangle },
  { id: 'rulebook', label: 'Rulebook', icon: FileText },
];

const VIEW_MODES = [
  { id: 'tree', label: 'Tree', icon: TreePine },
  { id: 'org', label: 'Org', icon: Network },
  { id: 'grid', label: 'Grid', icon: LayoutGrid },
  { id: 'table', label: 'Table', icon: TableIcon },
];

export default function ClientAgents() {
  const { canManageContacts } = usePermissions();
  if (!canManageContacts) return <div className="p-8 text-center text-muted-foreground">Access restricted.</div>;

  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("hierarchy");
  const [viewMode, setViewMode] = useState("tree");
  const [stateFilter, setStateFilter] = useState('all');
  const [showAtRisk, setShowAtRisk] = useState(false);

  const [showAgencyForm, setShowAgencyForm] = useState(false);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [deletingItem, setDeletingItem] = useState(null);
  const [preselectedAgencyId, setPreselectedAgencyId] = useState(null);
  const [preselectedTeamId, setPreselectedTeamId] = useState(null);
  const [selectedTimelineEntity, setSelectedTimelineEntity] = useState(null);
  const [selectedTimelineType, setSelectedTimelineType] = useState(null);

  const [selectedAgentIds, setSelectedAgentIds] = useState(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  const needsExtendedData = activeTab === 'statistics' || activeTab === 'health';

  const { data: agencies = [], loading: agenciesLoading } = useEntityList("Agency", "name");
  const { data: teams = [], loading: teamsLoading } = useEntityList("Team", "name");
  const { data: agents = [], loading: agentsLoading } = useEntityList("Agent", "name");
  const { data: projectTypes = [] } = useEntityList("ProjectType", "name", needsExtendedData ? 200 : 0);
  const { data: products = [] } = useEntityList("Product", null, needsExtendedData ? 500 : 0);
  const { data: packages = [] } = useEntityList("Package", null, needsExtendedData ? 200 : 0);

  const isLoading = agenciesLoading || teamsLoading || agentsLoading;

  // When searching, filter agencies and show their complete sub-trees
  const filteredAgencies = useMemo(() => {
    if (!searchQuery) return agencies;
    const q = searchQuery.toLowerCase();
    const matchingAgentAgencyIds = new Set(
      agents.filter(a =>
        a.name?.toLowerCase().includes(q) ||
        a.email?.toLowerCase().includes(q) ||
        a.phone?.replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
        (Array.isArray(a.tags) && a.tags.some(t => t.toLowerCase().includes(q)))
      ).map(a => a.current_agency_id)
    );
    return agencies.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.email?.toLowerCase().includes(q) ||
      matchingAgentAgencyIds.has(a.id)
    );
  }, [agencies, agents, searchQuery]);

  const filteredAgencyIds = useMemo(() => new Set(filteredAgencies.map(a => a.id)), [filteredAgencies]);

  const teamsForView = useMemo(() =>
    searchQuery ? teams.filter(t => filteredAgencyIds.has(t.agency_id)) : teams,
    [teams, filteredAgencyIds, searchQuery]
  );

  const agentsForView = useMemo(() =>
    searchQuery ? agents.filter(a => filteredAgencyIds.has(a.current_agency_id)) : agents,
    [agents, filteredAgencyIds, searchQuery]
  );

  const agentsFiltered = useMemo(() => {
    let result = agentsForView;
    if (stateFilter !== 'all') {
      result = result.filter(a => a.relationship_state === stateFilter);
    }
    if (showAtRisk) {
      result = result.filter(a => a.is_at_risk === true);
    }
    return result;
  }, [agentsForView, stateFilter, showAtRisk]);

  // Health checks
  const healthChecks = useMemo(() => {
    const checks = [];
    const orphanedAgents = agents.filter(a => !agencies.find(ag => ag.id === a.current_agency_id));
    if (orphanedAgents.length > 0) {
      checks.push({ type: "warning", title: "Orphaned People", message: `${orphanedAgents.length} person(s) reference non-existent organisations`, agents: orphanedAgents });
    }
    const orphanedTeams = teams.filter(t => !agencies.find(a => a.id === t.agency_id));
    if (orphanedTeams.length > 0) {
      checks.push({ type: "warning", title: "Orphaned Teams", message: `${orphanedTeams.length} team(s) reference non-existent organisations`, teams: orphanedTeams });
    }
    const emptyAgencies = agencies.filter(a =>
      !agents.find(ag => ag.current_agency_id === a.id) && !teams.find(t => t.agency_id === a.id)
    );
    if (emptyAgencies.length > 0) {
      checks.push({ type: "info", title: "Empty Organisations", message: `${emptyAgencies.length} organisation(s) have no teams or people`, agencies: emptyAgencies });
    }
    return checks;
  }, [agencies, teams, agents]);

  const warningCount = healthChecks.filter(c => c.type === 'warning').length;

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
      const user = await base44.auth.me();
      if (deletingItem.type === 'agency') {
        const hasTeams = teams.some(t => t.agency_id === deletingItem.item.id);
        const hasAgents = agents.some(a => a.current_agency_id === deletingItem.item.id);
        if (hasTeams || hasAgents) { toast.error("Cannot delete organisation with teams or people"); setDeletingItem(null); return; }
        await base44.entities.Agency.delete(deletingItem.item.id);
        await base44.entities.AuditLog.create({ entity_type: "agency", entity_id: deletingItem.item.id, entity_name: deletingItem.item.name, action: "delete", changed_fields: [], previous_state: deletingItem.item, new_state: {}, user_name: user.full_name, user_email: user.email });
      } else if (deletingItem.type === 'team') {
        const hasAgents = agents.some(a => a.current_team_id === deletingItem.item.id);
        if (hasAgents) { toast.error("Cannot delete team with people"); setDeletingItem(null); return; }
        await base44.entities.Team.delete(deletingItem.item.id);
        await base44.entities.AuditLog.create({ entity_type: "team", entity_id: deletingItem.item.id, entity_name: deletingItem.item.name, action: "delete", changed_fields: [], previous_state: deletingItem.item, new_state: {}, user_name: user.full_name, user_email: user.email });
      } else if (deletingItem.type === 'agent') {
        // Nullify agent references on open projects before deleting
        try {
          const agentProjects = await base44.entities.Project.filter(
            { agent_id: deletingItem.item.id }, null, 500
          );
          const openProjects = agentProjects.filter(
            p => !['delivered', 'cancelled'].includes(p.status)
          );
          await Promise.all(openProjects.map(p =>
            base44.entities.Project.update(p.id, {
              agent_id: null,
              agent_name: null,
            }).catch(() => {})
          ));
        } catch { /* non-fatal */ }

        // Clean up orphaned related entities
        try {
          const [logs, matrices, events] = await Promise.all([
            base44.entities.InteractionLog.filter({ entity_id: deletingItem.item.id, entity_type: 'Agent' }, null, 500).catch(() => []),
            base44.entities.PriceMatrix.filter({ entity_type: 'agent', entity_id: deletingItem.item.id }, null, 10).catch(() => []),
            base44.entities.CalendarEvent.filter({ agent_id: deletingItem.item.id }, null, 100).catch(() => []),
          ]);
          await Promise.all([
            ...logs.map(l => base44.entities.InteractionLog.delete(l.id).catch(() => {})),
            ...matrices.map(m => base44.entities.PriceMatrix.delete(m.id).catch(() => {})),
            ...events.map(ev => base44.entities.CalendarEvent.update(ev.id, { agent_id: null }).catch(() => {})),
          ]);
        } catch { /* non-fatal */ }

        await base44.entities.Agent.delete(deletingItem.item.id);

        // Update agency agent count
        if (deletingItem.item.current_agency_id) {
          try {
            const remaining = agents.filter(a =>
              a.id !== deletingItem.item.id && a.current_agency_id === deletingItem.item.current_agency_id
            );
            await base44.entities.Agency.update(deletingItem.item.current_agency_id, {
              agent_count: remaining.length,
            });
          } catch { /* non-fatal */ }
        }

        await base44.entities.AuditLog.create({ entity_type: "agent", entity_id: deletingItem.item.id, entity_name: deletingItem.item.name, action: "delete", changed_fields: [], previous_state: deletingItem.item, new_state: {}, user_name: user.full_name, user_email: user.email });
      }
      toast.success("Deleted successfully");
    } catch (error) { toast.error(error.message || "Failed to delete"); }
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
    if (selectedAgentIds.size === agentsFiltered.length) {
      setSelectedAgentIds(new Set());
    } else {
      setSelectedAgentIds(new Set(agentsFiltered.map(a => a.id)));
    }
  };

  const clearSelection = () => setSelectedAgentIds(new Set());

  const handleBulkStateChange = async (newState) => {
    if (selectedAgentIds.size === 0) return;
    setBulkActionLoading(true);
    try {
      await Promise.all(
        Array.from(selectedAgentIds).map(id =>
          base44.entities.Agent.update(id, { relationship_state: newState })
        )
      );
      toast.success(
        `Updated ${selectedAgentIds.size} contact${selectedAgentIds.size > 1 ? 's' : ''} to ${newState}`
      );
      clearSelection();
    } catch {
      toast.error('Some updates failed — please try again');
    }
    setBulkActionLoading(false);
  };

  const hierarchyProps = {
    agencies: filteredAgencies,
    teams: teamsForView,
    agents: agentsFiltered,
    onAddTeam: handleAddTeam,
    onAddAgent: handleAddAgent,
    onEdit: handleEdit,
    onDelete: (type, item) => setDeletingItem({ type, item }),
    selectedAgentIds: viewMode === 'grid' ? selectedAgentIds : undefined,
    toggleSelectAgent: viewMode === 'grid' ? toggleSelectAgent : undefined,
    toggleSelectAll: viewMode === 'grid' ? toggleSelectAll : undefined,
    agentsFiltered: viewMode === 'grid' ? agentsFiltered : undefined,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-card/95 backdrop-blur border-b">
        <div className="px-6 pt-5 pb-0">
          {/* Title row */}
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-5 min-w-0">
              <div>
                <h1 className="text-xl font-bold tracking-tight">Contacts</h1>
                <p className="text-xs text-muted-foreground mt-0.5">Organisations · Teams · People</p>
              </div>
              {/* Stat pills */}
              <div className="hidden sm:flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-100 text-xs font-medium text-blue-700">
                  <Building className="h-3 w-3" />{agencies.length} Organisations
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-50 border border-purple-100 text-xs font-medium text-purple-700">
                  <Users className="h-3 w-3" />{teams.length} Teams
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 border border-green-100 text-xs font-medium text-green-700">
                  <User className="h-3 w-3" />{agents.length} People
                </span>
                {agents.filter(a => a.is_at_risk).length > 0 && (
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 cursor-pointer hover:bg-amber-200 transition-colors"
                    onClick={() => setShowAtRisk(true)}
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {agents.filter(a => a.is_at_risk).length} at risk
                  </span>
                )}
                {warningCount > 0 && (
                  <button onClick={() => setActiveTab('health')} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors">
                    <AlertTriangle className="h-3 w-3" />{warningCount} {warningCount === 1 ? 'Issue' : 'Issues'}
                  </button>
                )}
              </div>
            </div>
            <Button onClick={() => { setEditingItem(null); setShowAgencyForm(true); }} className="gap-2 shrink-0" size="sm">
              <Plus className="h-3.5 w-3.5" />Add Organisation
            </Button>
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-0.5 overflow-x-auto">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium transition-all whitespace-nowrap rounded-t-lg",
                  activeTab === tab.id
                    ? "text-primary bg-background border border-b-background border-border -mb-px"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
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

      {/* Content area */}
      <div className="p-6">

        {/* ── Hierarchy ── */}
        {activeTab === 'hierarchy' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Search organisations…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="pl-9 h-10" />
                </div>
                {/* View mode switcher */}
                <div className="flex items-center bg-muted rounded-lg p-1 gap-0.5">
                {VIEW_MODES.map(mode => {
                   const Icon = mode.icon;
                   return (
                     <button key={mode.id} onClick={() => setViewMode(mode.id)} title={mode.label}
                       className={cn(
                         "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                         viewMode === mode.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                       )}>
                       <Icon className="h-3.5 w-3.5" />
                       <span className="hidden md:inline">{mode.label}</span>
                     </button>
                   );
                 })}
                </div>
                </div>

                {/* Filter bar */}
                <div className="flex items-center gap-2 flex-wrap">

                {/* Relationship state filter */}
                <Select value={stateFilter} onValueChange={setStateFilter}>
                  <SelectTrigger className="h-10 w-[160px]">
                    <SelectValue placeholder="All states" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All states</SelectItem>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Prospecting">Prospecting</SelectItem>
                    <SelectItem value="Dormant">Dormant</SelectItem>
                    <SelectItem value="Do Not Contact">Do Not Contact</SelectItem>
                  </SelectContent>
                </Select>

                {/* At-risk toggle */}
                <button
                  onClick={() => setShowAtRisk(v => !v)}
                  aria-label={showAtRisk ? "Hide at-risk contacts" : "Show at-risk contacts"}
                  className={`h-10 px-3 text-sm rounded-lg border transition-all duration-200 flex items-center gap-1.5 ${
                    showAtRisk
                      ? 'bg-amber-100 text-amber-700 border-amber-300'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  At risk
                  {showAtRisk && ` (${agentsFiltered.length})`}
                </button>

                {/* Missing info warnings */}
                {(() => {
                  const noEmail = agents.filter(a => !a.email).length;
                  const noPhone = agents.filter(a => !a.phone).length;
                  if (noEmail === 0 && noPhone === 0) return null;
                  return (
                    <span className="text-xs text-muted-foreground/70 flex items-center gap-2 ml-1">
                      {noEmail > 0 && (
                        <span className="flex items-center gap-1 text-amber-600">
                          <AlertTriangle className="h-3 w-3" />
                          {noEmail} missing email
                        </span>
                      )}
                      {noPhone > 0 && (
                        <span className="flex items-center gap-1 text-amber-600">
                          {noPhone} missing phone
                        </span>
                      )}
                    </span>
                  );
                })()}

                {/* Clear filters */}
                {(stateFilter !== 'all' || showAtRisk) && (
                  <button
                    onClick={() => { setStateFilter('all'); setShowAtRisk(false); }}
                    className="h-10 px-3 text-sm text-muted-foreground hover:text-foreground transition-colors duration-150"
                    aria-label="Clear filters"
                  >
                    Clear
                  </button>
                )}

                </div>
                </div>

                {/* Bulk action bar — only in grid view */}
                {viewMode === 'grid' && selectedAgentIds.size > 0 && (
                 <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5
                                 border border-primary/20 rounded-lg">
                   <span className="text-sm font-medium text-foreground">
                     {selectedAgentIds.size} selected
                   </span>
                   <div className="flex items-center gap-1.5 flex-1 flex-wrap">
                     <span className="text-xs text-muted-foreground">Set state:</span>
                     {['Active', 'Prospecting', 'Dormant', 'Do Not Contact'].map(state => (
                       <button
                         key={state}
                         disabled={bulkActionLoading}
                         onClick={() => handleBulkStateChange(state)}
                         aria-label={`Set selected contacts to ${state}`}
                         className={`text-sm px-3 py-1.5 rounded-lg border transition-all duration-200
                           border-border text-muted-foreground ${
                             state === 'Active'
                               ? 'hover:bg-green-100 hover:border-green-300 hover:text-green-700'
                             : state === 'Dormant'
                               ? 'hover:bg-amber-100 hover:border-amber-300 hover:text-amber-700'
                             : state === 'Do Not Contact'
                               ? 'hover:bg-red-100 hover:border-red-300 hover:text-red-700'
                             : 'hover:bg-blue-100 hover:border-blue-300 hover:text-blue-700'
                           }`}
                       >
                         {state}
                       </button>
                     ))}
                   </div>
                   <button
                     onClick={clearSelection}
                     className="text-sm text-muted-foreground hover:text-foreground ml-auto transition-colors duration-150"
                     aria-label="Clear selection"
                   >
                     Clear
                   </button>
                 </div>
                )}

                {isLoading ? (
              <div className="space-y-3">
                {Array(6).fill(0).map((_, i) => (
                  <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />
                ))}
              </div>
            ) : filteredAgencies.length === 0 ? (
              <Card className="p-12 text-center border-dashed bg-muted/20">
                <Building className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                <h3 className="font-semibold mb-1">{searchQuery ? "No results" : "No organisations yet"}</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {searchQuery ? "Try a different search term." : "Add your first organisation to get started."}
                </p>
                {!searchQuery && (
                  <Button onClick={() => setShowAgencyForm(true)} size="sm" className="gap-2">
                    <Plus className="h-3.5 w-3.5" />Add Organisation
                  </Button>
                )}
              </Card>
            ) : (
              <>
                {viewMode === "tree" && <HierarchyTree {...hierarchyProps} />}
                {viewMode === "org" && <HierarchyOrgChart {...hierarchyProps} />}
                {viewMode === "grid" && <HierarchyGridView {...hierarchyProps} />}
                {viewMode === "table" && <HierarchyTableView {...hierarchyProps} />}
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

        {/* ── Activity ── */}
        {activeTab === 'activity' && <ActivityFeed />}

        {/* ── Statistics ── */}
        {activeTab === 'statistics' && (
          <HierarchyStatistics agencies={agencies} teams={teams} agents={agents} projectTypes={projectTypes} products={products} packages={packages} />
        )}

        {/* ── Health ── */}
        {activeTab === 'health' && (
          <HierarchyHealthCheck checks={healthChecks} agents={agents} teams={teams} agencies={agencies} />
        )}

        {/* ── Rulebook ── */}
        {activeTab === 'rulebook' && <ClientRulebook />}
      </div>

      {/* Forms */}
      <AgencyForm agency={editingItem && showAgencyForm ? editingItem : null} open={showAgencyForm} onClose={closeAllForms} />
      <TeamForm team={editingItem && showTeamForm ? editingItem : null} open={showTeamForm} onClose={closeAllForms} preselectedAgencyId={preselectedAgencyId} />
      <AgentForm agent={editingItem && showAgentForm ? editingItem : null} open={showAgentForm} onClose={closeAllForms} preselectedAgencyId={preselectedAgencyId} preselectedTeamId={preselectedTeamId} />
      <DeleteConfirmDialog item={deletingItem} onConfirm={handleDelete} onCancel={() => setDeletingItem(null)} />
    </div>
  );
}