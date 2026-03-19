import { useState, useMemo } from 'react';
import { useEntitiesData } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, Grid, List, ChevronLeft, BarChart2 } from 'lucide-react';
import RelationshipStateKanban from '@/components/prospecting/RelationshipStateKanban';
import ProspectingStatusKanban from '@/components/prospecting/ProspectingStatusKanban';
import AgentListView from '@/components/prospecting/AgentListView';
import AgencyListView from '@/components/prospecting/AgencyListView';
import ProspectFormDialog from '@/components/prospecting/ProspectFormDialog';
import AgencyFormDialog from '@/components/prospecting/AgencyFormDialog';
import ProspectingDashboard from '@/components/prospecting/ProspectingDashboard';
import { usePermissions } from '@/components/auth/PermissionGuard';

export default function Prospecting() {
  const { canSeeProspecting } = usePermissions();
  if (!canSeeProspecting) return <div className="p-8 text-center text-muted-foreground">Access restricted.</div>;
  
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
        return a.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          a.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (a.current_agency_name || '').toLowerCase().includes(searchTerm.toLowerCase());
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
        return agency.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (agency.email || '').toLowerCase().includes(searchTerm.toLowerCase());
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

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-3 border-primary/30 border-t-primary rounded-full mx-auto mb-4"></div>
          <p className="text-muted-foreground animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="max-w-7xl mx-auto">
        {/* Dashboard Toggle */}
        <div className="mb-8 flex justify-end">
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
          <div className="mb-8">
            <ProspectingDashboard />
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col gap-6 mb-8">
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
                <h1 className="text-4xl font-bold">
                  {drillDownState ? `${drillDownState} Pipeline` : 'Agents & Agencies'}
                </h1>
                <p className="text-muted-foreground mt-2">
                  {drillDownState ? 'Manage prospecting flow' : 'View all agents and agencies by relationship state'}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline"
                className="gap-2"
                onClick={() => setShowNewAgencyDialog(true)}
              >
                <Plus className="h-4 w-4" />
                New Agency
              </Button>
              <Button 
                className="gap-2"
                onClick={() => setShowNewAgentDialog(true)}
              >
                <Plus className="h-4 w-4" />
                New Agent
              </Button>
            </div>
          </div>

          {/* Search */}
          {!drillDownState && (
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agents or agencies..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          )}
        </div>

        {/* View Toggle */}
        <div className="flex gap-4 mb-6">
          <div className="flex gap-2 bg-card p-1 rounded-lg w-fit">
            <Button
              variant={viewMode === 'kanban' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('kanban')}
              className="gap-2"
            >
              <Grid className="h-4 w-4" />
              Kanban
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('list')}
              className="gap-2"
            >
              <List className="h-4 w-4" />
              List
            </Button>
          </div>

          <div className="flex gap-2 bg-card p-1 rounded-lg w-fit">
            <Button
              variant={entityFilter === 'agent' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setEntityFilter('agent')}
            >
              Agents Only
            </Button>
            <Button
              variant={entityFilter === 'agency' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setEntityFilter('agency')}
            >
              Agencies Only
            </Button>
            <Button
              variant={entityFilter === 'both' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setEntityFilter('both')}
            >
              Both
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
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-4">
              {searchTerm ? 'No results match your search' : 'No agents or agencies yet. Create your first one!'}
            </p>
            {!searchTerm && (
              <Button onClick={() => setShowNewAgentDialog(true)}>
                Get Started
              </Button>
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