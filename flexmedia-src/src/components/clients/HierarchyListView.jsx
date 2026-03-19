import { Building, Users, User, Edit, Trash2, MoreVertical, Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export default function HierarchyListView({ 
  agencies, 
  teams, 
  agents, 
  onEdit,
  onDelete 
}) {
  const getTeamsForAgency = (agencyId) => teams.filter(t => t.agency_id === agencyId);
  const getAgentsForAgency = (agencyId) => agents.filter(a => a.current_agency_id === agencyId && !a.current_team_id);
  const getAgentsForTeam = (teamId) => agents.filter(a => a.current_team_id === teamId);

  return (
    <div className="space-y-1">
      {agencies.map(agency => {
        const agencyTeams = getTeamsForAgency(agency.id);
        const agencyAgents = getAgentsForAgency(agency.id);

        return (
          <div key={agency.id}>
            {/* Agency Row */}
            <div className="flex items-center gap-3 p-3 hover:bg-muted/50 rounded-lg group">
              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                <Building className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{agency.name}</p>
                <p className="text-xs text-muted-foreground">
                  {agencyTeams.length} teams, {agencyAgents.length + agents.filter(a => a.current_agency_id === agency.id && a.current_team_id).length} agents
                </p>
              </div>
              <div className="flex items-center gap-2">
                {agency.email && (
                  <a href={`mailto:${agency.email}`} className="text-muted-foreground hover:text-primary">
                    <Mail className="h-4 w-4" />
                  </a>
                )}
                {agency.phone && (
                  <a href={`tel:${agency.phone}`} className="text-muted-foreground hover:text-primary">
                    <Phone className="h-4 w-4" />
                  </a>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100">
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

            {/* Teams */}
            {agencyTeams.map(team => {
              const teamAgents = getAgentsForTeam(team.id);
              
              return (
                <div key={team.id}>
                  <div className="flex items-center gap-3 p-3 pl-12 hover:bg-muted/50 rounded-lg group">
                    <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                      <Users className="h-4 w-4 text-purple-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{team.name}</p>
                      <p className="text-xs text-muted-foreground">{teamAgents.length} agents</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {team.email && (
                        <a href={`mailto:${team.email}`} className="text-muted-foreground hover:text-primary">
                          <Mail className="h-4 w-4" />
                        </a>
                      )}
                      {team.phone && (
                        <a href={`tel:${team.phone}`} className="text-muted-foreground hover:text-primary">
                          <Phone className="h-4 w-4" />
                        </a>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100">
                            <MoreVertical className="h-4 w-4" />
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
                  {teamAgents.map(agent => (
                    <div key={agent.id} className="flex items-center gap-3 p-2 pl-24 hover:bg-muted/50 rounded-lg group">
                      <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                        <User className="h-3.5 w-3.5 text-green-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{agent.name}</p>
                        {agent.email && (
                          <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {agent.email && (
                          <a href={`mailto:${agent.email}`} className="text-muted-foreground hover:text-primary">
                            <Mail className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {agent.phone && (
                          <a href={`tel:${agent.phone}`} className="text-muted-foreground hover:text-primary">
                            <Phone className="h-3.5 w-3.5" />
                          </a>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100">
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
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Direct Agency Agents */}
            {agencyAgents.map(agent => (
              <div key={agent.id} className="flex items-center gap-3 p-2 pl-12 hover:bg-muted/50 rounded-lg group">
                <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                  <User className="h-3.5 w-3.5 text-green-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agent.name}</p>
                  {agent.email && (
                    <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {agent.email && (
                    <a href={`mailto:${agent.email}`} className="text-muted-foreground hover:text-primary">
                      <Mail className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {agent.phone && (
                    <a href={`tel:${agent.phone}`} className="text-muted-foreground hover:text-primary">
                      <Phone className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100">
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
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}