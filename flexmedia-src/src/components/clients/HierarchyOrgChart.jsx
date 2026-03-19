import { Building, Users, User, Plus, Edit, Trash2, MoreVertical } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export default function HierarchyOrgChart({ 
  agencies, 
  teams, 
  agents, 
  onAddTeam, 
  onAddAgent, 
  onEdit,
  onDelete 
}) {
  const getTeamsForAgency = (agencyId) => teams.filter(t => t.agency_id === agencyId);
  const getAgentsForAgency = (agencyId) => agents.filter(a => a.current_agency_id === agencyId && !a.current_team_id);
  const getAgentsForTeam = (teamId) => agents.filter(a => a.current_team_id === teamId);

  return (
    <div className="space-y-12">
      {agencies.map(agency => {
        const agencyTeams = getTeamsForAgency(agency.id);
        const agencyAgents = getAgentsForAgency(agency.id);

        return (
          <div key={agency.id} className="relative">
            {/* Agency Level */}
            <div className="flex flex-col items-center">
              <Card className="w-80 p-4 bg-gradient-to-br from-blue-50 to-indigo-100 border-2 border-blue-200 shadow-lg">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
                      <Building className="h-6 w-6 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-lg truncate">{agency.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {agencyTeams.length} teams • {agencyAgents.length} direct agents
                      </p>
                    </div>
                  </div>
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
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => onAddTeam(agency.id)} className="flex-1">
                    <Plus className="h-3 w-3 mr-1" />
                    Team
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAddAgent(agency.id)} className="flex-1">
                    <Plus className="h-3 w-3 mr-1" />
                    Agent
                  </Button>
                </div>
              </Card>

              {/* Connector line down */}
              {(agencyTeams.length > 0 || agencyAgents.length > 0) && (
                <div className="w-0.5 h-8 bg-gray-300"></div>
              )}
            </div>

            {/* Teams Level */}
            {agencyTeams.length > 0 && (
              <div className="relative">
                <div className="flex justify-center gap-8 flex-wrap">
                  {agencyTeams.map((team, index) => {
                    const teamAgents = getAgentsForTeam(team.id);
                    
                    return (
                      <div key={team.id} className="flex flex-col items-center">
                        {/* Connector line */}
                        <div className="w-0.5 h-8 bg-gray-300"></div>
                        
                        <Card className="w-64 p-3 bg-gradient-to-br from-purple-50 to-pink-100 border-2 border-purple-200 shadow-md">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <div className="w-10 h-10 rounded-lg bg-purple-600 flex items-center justify-center shrink-0">
                                <Users className="h-5 w-5 text-white" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold truncate">{team.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {teamAgents.length} agents
                                </p>
                              </div>
                            </div>
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
                          <Button 
                            size="sm" 
                            variant="outline" 
                            onClick={() => onAddAgent(agency.id, team.id)}
                            className="w-full"
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Add Person
                          </Button>
                        </Card>

                        {/* Team Agents */}
                        {teamAgents.length > 0 && (
                          <>
                            <div className="w-0.5 h-6 bg-gray-300"></div>
                            <div className="flex flex-wrap gap-3 justify-center max-w-xs">
                              {teamAgents.map(agent => (
                                <Card key={agent.id} className="w-32 p-2 bg-white hover:shadow-md transition-shadow">
                                  <div className="flex flex-col items-center text-center">
                                    <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center mb-1">
                                      <User className="h-4 w-4 text-green-600" />
                                    </div>
                                    <p className="text-xs font-medium truncate w-full">{agent.name}</p>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon" className="h-6 w-6 mt-1">
                                          <MoreVertical className="h-3 w-3" />
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
                                </Card>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Direct Agency Agents */}
            {agencyAgents.length > 0 && (
              <div className="mt-6 flex flex-wrap gap-3 justify-center">
                <div className="w-full text-center text-sm text-muted-foreground mb-2">Direct Agents</div>
                {agencyAgents.map(agent => (
                  <Card key={agent.id} className="w-32 p-2 bg-white hover:shadow-md transition-shadow">
                    <div className="flex flex-col items-center text-center">
                      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center mb-1">
                        <User className="h-4 w-4 text-green-600" />
                      </div>
                      <p className="text-xs font-medium truncate w-full">{agent.name}</p>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6 mt-1">
                            <MoreVertical className="h-3 w-3" />
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
                  </Card>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}