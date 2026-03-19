import { Building, Users, User, ChevronRight, ChevronDown, Plus, Edit, Trash2, MoreVertical } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export default function HierarchyTree({ 
  agencies, 
  teams, 
  agents, 
  onAddTeam, 
  onAddAgent, 
  onEdit,
  onDelete 
}) {
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
                        {agencyAgents.length} direct people
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAddTeam(agency.id)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Team
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAddAgent(agency.id)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                      Person
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit('agency', agency)}>
                        <Edit className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => onDelete('agency', agency)}
                        className="text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
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
                            <p className="text-xs text-muted-foreground">
                             {teamAgents.length} people
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onAddAgent(agency.id, team.id)}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />
                             Person
                            </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => onEdit('team', team)}>
                                <Edit className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem 
                                onClick={() => onDelete('team', team)}
                                className="text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      {/* Team Agents */}
                      {isTeamExpanded && teamAgents.length > 0 && (
                        <div className="mt-2 ml-6 space-y-2">
                          {teamAgents.map(agent => (
                            <div 
                              key={agent.id} 
                              className="flex items-center justify-between py-2 px-3 bg-white border rounded-lg hover:shadow-sm transition-shadow"
                            >
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                                  <User className="h-3.5 w-3.5 text-green-600" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium text-sm truncate">{agent.name}</p>
                                  {agent.email && (
                                    <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                                  )}
                                </div>
                              </div>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7">
                                    <MoreVertical className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => onEdit('agent', agent)}>
                                    <Edit className="h-4 w-4 mr-2" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem 
                                    onClick={() => onDelete('agent', agent)}
                                    className="text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
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
                      <div 
                        key={agent.id} 
                        className="flex items-center justify-between py-2 px-3 bg-white border rounded-lg hover:shadow-sm transition-shadow"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                            <User className="h-3.5 w-3.5 text-green-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-sm truncate">{agent.name}</p>
                            {agent.email && (
                              <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                            )}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onEdit('agent', agent)}>
                              <Edit className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => onDelete('agent', agent)}
                              className="text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
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