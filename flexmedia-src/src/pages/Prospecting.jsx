import { useState, useMemo } from 'react';
import { useEntitiesData } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Plus, Search, Grid, List, ChevronLeft, BarChart2, Users } from 'lucide-react';
import RelationshipStateKanban from '@/components/prospecting/RelationshipStateKanban';
import ProspectingStatusKanban from '@/components/prospecting/ProspectingStatusKanban';
import AgentListView from '@/components/prospecting/AgentListView';
import AgencyListView from '@/components/prospecting/AgencyListView';
import ProspectFormDialog from '@/components/prospecting/ProspectFormDialog';
import AgencyFormDialog from '@/components/prospecting/AgencyFormDialog';
import ProspectingDashboard from '@/components/prospecting/ProspectingDashboard';
import { usePermissions } from '@/components/auth/PermissionGuard';
import { useEntityAccess } from '@/components/auth/useEntityAccess';

export default function Prospecting() {
  const { canSeeProspecting } = usePermissions();
  const { canEdit, canView } = useEntityAccess('interaction_logs');
  const [viewMode, setViewMode] = useState('kanban');
  const [searchTerm, setSearchTerm] = useState('');
  const [drillDownState, setDrillDownState] = useState(null);
  const [entityFilter, setEntityFilter] = useState('both'); // 'agent', 'agency', 'both'
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const [showNewAgencyDialog, setShowNewAgencyDialog] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);

  const { data, loading } = useEntitiesData([
    { entityName: 'Agent', sortBy: '-updated_date' },
    { entityName: 'Agency', sortBy: '-updated_date' },
    { entityName: 'InteractionLog', sortBy: '-date_time' }
  ]);

  const agents = data.Agent || [];
  const agencies = data.Agency || [];
  const interactions = data.InteractionLog || [];

  // Map interactions count by entity ID
  const interactionsByEntity = useMemo(() => {
    const map = {};
    interactions.forEach(log => {
      if (!map[log.entity_id]) map[log.entity_id] = [];
      map[log.entity_id].push(log);
    });
    return map;
  }, [interactions]);

  // Enrich agents
  const enrichedAgents = useMemo(() => {
    return agents
      .map(a => ({
        ...a,
        entity_type: 'Agent',
        interactionCount: interactionsByEntity[a.id]?.length || 0,
        lastInteraction: interactionsByEntity[a.id]?.[0]?.date_time
      }))
      .filter(a => {
        if (!searchTerm) return true;
        const term = searchTerm.toLowerCase();
        return (a.name || '').toLowerCase().includes(term) ||
          (a.email || '').toLowerCase().includes(term) ||
          (a.current_agency_name || '').toLowerCase().includes(term);
      });
  }, [agents, searchTerm, interactionsByEntity]);

  // Enrich agencies
  const enrichedAgencies = useMemo(() => {
    return agencies
      .map(agency => ({
        ...agency,
        entity_type: 'Agency',
        interactionCount: interactionsByEntity[agency.id]?.length || 0,
        lastInteraction: interactionsByEntity[agency.id]?.[0]?.date_time
      }))
      .filter(agency => {
        if (!searchTerm) return true;
        const term = searchTerm.toLowerCase();
        return (agency.name || '').toLowerCase().includes(term) ||
          (agency.email || '').toLowerCase().includes(term);
      });
  }, [agencies, searchTerm, interactionsByEntity]);

  // Filter entities based on mode
  const filteredAgents = useMemo(() => 
    entityFilter === 'agency' ? [] : enrichedAgents,
    [enrichedAgents, entityFilter]
  );

  const filteredAgencies = useMemo(() => 
    entityFilter === 'agent' ? [] : enrichedAgencies,
    [enrichedAgencies, entityFilter]
  );

  // Combine agents and agencies for main view
  const allEntities = useMemo(() => [...filteredAgents, ...filteredAgencies], [filteredAgents, filteredAgencies]);

  // Group by relationship state for main kanban
  const entitiesByRelationshipState = useMemo(() => {
    const grouped = {
      'Prospecting': [],
      'Active': [],
      'Dormant': [],
      'Do Not Contact': []
    };
    
    allEntities.forEach(entity => {
      const state = entity.relationship_state || 'Prospecting';
      if (grouped[state]) grouped[state].push(entity);
    });
    return grouped;
  }, [allEntities]);

  // For drill-down into Prospecting: group agents by detailed status
  const agentsByProspectingStatus = useMemo(() => {
    if (drillDownState !== 'Prospecting') return {};
    
    const grouped = {};
    const statuses = ['New Lead', 'Researching', 'Attempted Contact', 'Discovery Call Scheduled', 'Proposal Sent', 'Nurturing', 'Qualified', 'Unqualified', 'Converted to Client', 'Lost'];
    
    statuses.forEach(status => {
      grouped[status] = enrichedAgents
        .filter(a => a.relationship_state === 'Prospecting' && a.status === status);
    });
    return grouped;
  }, [enrichedAgents, drillDownState]);

  if (!canSeeProspecting) return <div className="p-8 text-center text-muted-foreground">Access restricted.</div>;

  if (loading) {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-background p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-6 w-40 bg-muted rounded animate-pulse" />
            <div className="h-3 w-56 bg-muted rounded animate-pulse" />
          </div>
          <div className="flex gap-2">
            <div className="h-8 w-28 bg-muted rounded animate-pulse" />
            <div className="h-8 w-28 bg-muted rounded animate-pulse" />
          </div>
        </div>
        <div className="flex gap-2">
          {[0,1,2].map(i => <div key={i} className="h-7 w-20 bg-muted rounded-full animate-pulse" />)}
        </div>
        <div className="grid grid-cols-4 gap-4 flex-1">
          {[0,1,2,3].map(i => (
            <div key={i} className="bg-card border rounded-xl p-3 space-y-3 animate-pulse">
              <div className="h-4 w-24 bg-muted rounded" />
              <div className="space-y-2">
                {[0,1,2].map(j => <div key={j} className="h-16 w-full bg-muted rounded-lg" />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Dashboard Toggle */}
        <div className="mb-4 flex justify-end">
          <Button
            onClick={() => setShowDashboard(!showDashboard)}
            variant={showDashboard ? 'default' : 'outline'}
            className="gap-2"
          >
            <BarChart2 className="h-4 w-4" />
            {showDashboard ? 'Hide' : 'Show'} Dashboard
          </Button>
        </div>

        {/* Dashboard */}
        {showDashboard && (
          <div className="mb-4">
            <ProspectingDashboard />
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col gap-3 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {drillDownState && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDrillDownState(null)}
                  className="gap-2"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
              )}
              <div>
                <h1 className="text-lg font-semibold flex items-center gap-2 select-none">
                  <Users className="h-5 w-5 text-primary" />
                  {drillDownState ? `${drillDownState} Pipeline` : 'Prospecting'}
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                  {drillDownState
                    ? 'Manage prospecting flow'
                    : `${enrichedAgents.length} people, ${enrichedAgencies.length} organisations`}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {canView && !canEdit && <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground self-center">View only</Badge>}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-8"
                onClick={() => setShowNewAgencyDialog(true)}
                disabled={!canEdit}
                title="Add a new organisation prospect"
              >
                <Plus className="h-3.5 w-3.5" />
                New Organisation
              </Button>
              <Button
                size="sm"
                className="gap-1.5 h-8"
                onClick={() => setShowNewAgentDialog(true)}
                disabled={!canEdit}
                title="Add a new contact prospect"
              >
                <Plus className="h-3.5 w-3.5" />
                New Person
              </Button>
            </div>
          </div>

          {/* Search */}
          {!drillDownState && (
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search people or organisations..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 h-7 text-xs"
              />
            </div>
          )}
        </div>

        {/* View Toggle */}
        <div className="flex gap-3 mb-4">
          <div className="flex gap-2 bg-card p-1 rounded-xl w-fit shadow-sm">
            <Button
              variant={viewMode === 'kanban' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('kanban')}
              className="gap-2 transition-colors"
            >
              <Grid className="h-4 w-4" />
              Kanban
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('list')}
              className="gap-2 transition-colors"
            >
              <List className="h-4 w-4" />
              List
            </Button>
          </div>

          <div className="flex gap-2 bg-card p-1 rounded-xl w-fit shadow-sm">
            <Button
              variant={entityFilter === 'agent' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setEntityFilter('agent')}
              className="gap-1.5 transition-colors"
            >
              People Only
              <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[9px] font-bold">{enrichedAgents.length}</Badge>
            </Button>
            <Button
              variant={entityFilter === 'agency' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setEntityFilter('agency')}
              className="gap-1.5"
            >
              Orgs Only
              <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[9px] font-bold">{enrichedAgencies.length}</Badge>
            </Button>
            <Button
              variant={entityFilter === 'both' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setEntityFilter('both')}
              className="gap-1.5"
            >
              Both
              <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[9px] font-bold">{enrichedAgents.length + enrichedAgencies.length}</Badge>
            </Button>
          </div>
        </div>

        {/* Main View: Relationship States */}
        {!drillDownState && viewMode === 'kanban' && (
          <RelationshipStateKanban 
            entitiesByState={entitiesByRelationshipState}
            onDrillDown={setDrillDownState}
          />
        )}

        {/* Main View: List */}
        {!drillDownState && viewMode === 'list' && (
          <div className="space-y-8">
            {(entityFilter === 'agent' || entityFilter === 'both') && (
              <AgentListView 
                agents={filteredAgents}
                interactions={interactionsByEntity}
              />
            )}
            {(entityFilter === 'agency' || entityFilter === 'both') && (
              <AgencyListView 
                agencies={filteredAgencies}
                interactions={interactionsByEntity}
              />
            )}
          </div>
        )}

        {/* Drill-Down: Prospecting Status Kanban */}
        {drillDownState === 'Prospecting' && viewMode === 'kanban' && (
          <ProspectingStatusKanban 
            agentsByStatus={agentsByProspectingStatus}
          />
        )}

        {/* Drill-Down: List View */}
        {drillDownState === 'Prospecting' && viewMode === 'list' && (
          <AgentListView 
            agents={enrichedAgents.filter(a => a.relationship_state === 'Prospecting')}
            interactions={interactionsByEntity}
          />
        )}

        {allEntities.length === 0 && !drillDownState && (
          <div className="text-center py-16 text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium text-base">
              {searchTerm ? `No results for "${searchTerm}"` : 'No people or organisations yet'}
            </p>
            <p className="text-xs mt-1 text-muted-foreground/70">
              {searchTerm ? 'Try adjusting your search term or clearing the filter.' : 'Add your first person or organisation to start building your pipeline.'}
            </p>
            {searchTerm ? (
              <Button variant="outline" size="sm" onClick={() => setSearchTerm('')} className="mt-3">
                Clear search
              </Button>
            ) : (
              <div className="flex gap-2 justify-center mt-3">
                <Button size="sm" onClick={() => setShowNewAgentDialog(true)} disabled={!canEdit}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Add Person
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowNewAgencyDialog(true)} disabled={!canEdit}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Add Organisation
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <ProspectFormDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
        entityType="Agent"
      />
      <AgencyFormDialog
        open={showNewAgencyDialog}
        onOpenChange={setShowNewAgencyDialog}
      />
    </div>
  );
}