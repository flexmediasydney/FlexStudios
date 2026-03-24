import { Building, Users, User, ChevronRight, ChevronDown, Plus, Edit, Trash2, MoreVertical, AlertTriangle, Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import ContactHealthScore from "@/components/clients/ContactHealthScore";
import { LastContactIndicator, NextFollowUpIndicator } from "@/components/clients/ContactIndicators";
import { TagList } from "@/components/clients/ContactTags";
import QuickLogInteraction from "@/components/clients/QuickLogInteraction";

export default function HierarchyTree({
  agencies,
  teams,
  agents,
  onAddTeam,
  onAddAgent,
  onEdit,
  onDelete,
  agentProjectCounts,
  agentRevenue,
  onOpenActivityPanel,
}) {
  const navigate = useNavigate();
  const [expandedAgencies, setExpandedAgencies] = useState(new Set());
  const [expandedTeams, setExpandedTeams] = useState(new Set());

  const toggleAgency = (agencyId) => {
    const newSet = new Set(expandedAgencies);
    if (newSet.has(agencyId)) {
      newSet.delete(agencyId);
    } else {
      newSet.add(agencyId);
    }
    setExpandedAgencies(newSet);
  };

  const toggleTeam = (teamId) => {
    const newSet = new Set(expandedTeams);
    if (newSet.has(teamId)) {
      newSet.delete(teamId);
    } else {
      newSet.add(teamId);
    }
    setExpandedTeams(newSet);
  };

  const getTeamsForAgency = (agencyId) => teams.filter(t => t.agency_id === agencyId);
  const getAgentsForAgency = (agencyId) => agents.filter(a => a.current_agency_id === agencyId && !a.current_team_id);
  const getAgentsForTeam = (teamId) => agents.filter(a => a.current_team_id === teamId);

  return (
    <div className="space-y-3">
      {agencies.map(agency => {
        const isExpanded = expandedAgencies.has(agency.id);
        const agencyTeams = getTeamsForAgency(agency.id);
        const agencyAgents = getAgentsForAgency(agency.id);

        return (
          <Card key={agency.id} className="overflow-hidden">
            {/* Agency Level */}
            <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => toggleAgency(agency.id)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                  <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
                    <Building className="h-5 w-5 text-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-lg truncate">{agency.name}</h3>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Badge variant="secondary" className="text-xs">
                        {agencyTeams.length} teams
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {agents.filter(a => a.current_agency_id === agency.id).length} people ({agencyAgents.length} direct)
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => onAddTeam(agency.id)}>
                    <Plus className="h-3.5 w-3.5 mr-1" />Team
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAddAgent(agency.id)}>
                    <Plus className="h-3.5 w-3.5 mr-1" />Person
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit('agency', agency)}>
                        <Edit className="h-4 w-4 mr-2" />Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onDelete('agency', agency)} className="text-destructive">
                        <Trash2 className="h-4 w-4 mr-2" />Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            {/* Teams and Agents */}
            {isExpanded && (
              <div className="p-4 pt-2 space-y-3">
                {/* Teams */}
                {agencyTeams.map(team => {
                  const isTeamExpanded = expandedTeams.has(team.id);
                  const teamAgents = getAgentsForTeam(team.id);

                  return (
                    <div key={team.id} className="ml-6 border-l-2 border-blue-200 pl-4">
                      <div className="flex items-center justify-between py-2 px-3 bg-purple-50 rounded-lg">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0"
                            onClick={() => toggleTeam(team.id)}
                          >
                            {isTeamExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center shrink-0">
                            <Users className="h-4 w-4 text-white" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{team.name}</p>
                            <p className="text-xs text-muted-foreground">{teamAgents.length} people</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={() => onAddAgent(agency.id, team.id)}>
                            <Plus className="h-3.5 w-3.5 mr-1" />Person
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => onEdit('team', team)}>
                                <Edit className="h-4 w-4 mr-2" />Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onDelete('team', team)} className="text-destructive">
                                <Trash2 className="h-4 w-4 mr-2" />Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      {/* Team Agents */}
                      {isTeamExpanded && teamAgents.length > 0 && (
                        <div className="mt-2 ml-6 space-y-2">
                          {teamAgents.map(agent => (
                            <AgentTreeRow
                              key={agent.id}
                              agent={agent}
                              navigate={navigate}
                              onEdit={onEdit}
                              onDelete={onDelete}
                              agentProjectCounts={agentProjectCounts}
                              agentRevenue={agentRevenue}
                              onOpenActivityPanel={onOpenActivityPanel}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Direct Agency Agents (no team) */}
                {agencyAgents.length > 0 && (
                  <div className="ml-6 space-y-2">
                    <p className="text-xs text-muted-foreground px-3">Direct People</p>
                    {agencyAgents.map(agent => (
                      <AgentTreeRow
                        key={agent.id}
                        agent={agent}
                        navigate={navigate}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        agentProjectCounts={agentProjectCounts}
                        agentRevenue={agentRevenue}
                        onOpenActivityPanel={onOpenActivityPanel}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Enhanced agent row in the tree view with health score, indicators, tags, and quick actions.
 */
function AgentTreeRow({ agent, navigate, onEdit, onDelete, agentProjectCounts, agentRevenue, onOpenActivityPanel }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between py-2 px-3 bg-white border rounded-lg",
        "hover:shadow-sm transition-shadow cursor-pointer group",
        agent.is_at_risk && "border-amber-200 bg-amber-50/20"
      )}
      onClick={() => navigate(createPageUrl('PersonDetails') + `?id=${agent.id}`)}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
          <User className="h-3.5 w-3.5 text-green-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm truncate">{agent.name}</p>
            {agent.relationship_state && (
              <span className={cn(
                "text-[9px] px-1.5 py-0 rounded font-medium border",
                agent.relationship_state === 'Active'   ? 'bg-green-100 text-green-700 border-green-200' :
                agent.relationship_state === 'Dormant'   ? 'bg-amber-100 text-amber-700 border-amber-200' :
                agent.relationship_state === 'Do Not Contact' ? 'bg-red-100 text-red-700 border-red-200' :
                'bg-blue-100 text-blue-700 border-blue-200'
              )}>
                {agent.relationship_state}
              </span>
            )}
            {agent.is_at_risk && (
              <AlertTriangle className="h-3 w-3 text-amber-500 flex-shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {agent.email && (
              <span className="text-[10px] text-muted-foreground truncate max-w-32">{agent.email}</span>
            )}
            <LastContactIndicator agent={agent} size="xs" />
            <NextFollowUpIndicator agent={agent} size="xs" />
          </div>
        </div>
      </div>

      {/* Right side: tags + health + actions */}
      <div className="flex items-center gap-2 shrink-0">
        {Array.isArray(agent.tags) && agent.tags.length > 0 && (
          <div className="hidden lg:block">
            <TagList tags={agent.tags} max={2} size="xs" />
          </div>
        )}
        <ContactHealthScore
          agent={agent}
          projectCount={agentProjectCounts?.[agent.id] || 0}
          totalRevenue={agentRevenue?.[agent.id] || 0}
          size="sm"
        />
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <QuickLogInteraction agent={agent} triggerSize="icon" />
          {onOpenActivityPanel && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={e => { e.stopPropagation(); onOpenActivityPanel(agent); }}
              title="Activity"
            >
              <Activity className="h-3 w-3" />
            </Button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => e.stopPropagation()}>
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit('agent', agent)}>
              <Edit className="h-4 w-4 mr-2" />Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDelete('agent', agent)} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
