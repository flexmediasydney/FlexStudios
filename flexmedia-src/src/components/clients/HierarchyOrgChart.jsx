import { Building, Users, User, Plus, Edit, Trash2, MoreVertical, AlertTriangle, Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import ContactHealthScore from "@/components/clients/ContactHealthScore";
import { LastContactIndicator, NextFollowUpIndicator } from "@/components/clients/ContactIndicators";
import { TagList } from "@/components/clients/ContactTags";
import QuickLogInteraction from "@/components/clients/QuickLogInteraction";
import { cn } from "@/lib/utils";

export default function HierarchyOrgChart({
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
  const getTeamsForAgency = (agencyId) => teams.filter(t => t.agency_id === agencyId);
  const getAgentsForAgency = (agencyId) => agents.filter(a => a.current_agency_id === agencyId && !a.current_team_id);
  const getAgentsForTeam = (teamId) => agents.filter(a => a.current_team_id === teamId);

  return (
    <div className="space-y-16">
      {agencies.map(agency => {
        const agencyTeams = getTeamsForAgency(agency.id);
        const agencyAgents = getAgentsForAgency(agency.id);
        const totalAgents = agents.filter(a => a.current_agency_id === agency.id).length;
        const hasChildren = agencyTeams.length > 0 || agencyAgents.length > 0;

        return (
          <div key={agency.id} className="relative">
            {/* ─── Agency Level (Root) ─── */}
            <div className="flex flex-col items-center">
              <Card className="w-96 p-5 bg-gradient-to-br from-blue-50 via-blue-50/80 to-indigo-100
                              border-2 border-blue-200 shadow-lg hover:shadow-xl transition-shadow">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600
                                    flex items-center justify-center shrink-0 shadow-md">
                      <Building className="h-7 w-7 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-lg truncate">{agency.name}</h3>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {agencyTeams.length} team{agencyTeams.length !== 1 ? "s" : ""}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {totalAgents} people
                        </Badge>
                      </div>
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
                        <Edit className="h-4 w-4 mr-2" />Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onDelete('agency', agency)} className="text-destructive">
                        <Trash2 className="h-4 w-4 mr-2" />Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => onAddTeam(agency.id)} className="flex-1 bg-white/60">
                    <Plus className="h-3 w-3 mr-1" />Team
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAddAgent(agency.id)} className="flex-1 bg-white/60">
                    <Plus className="h-3 w-3 mr-1" />Person
                  </Button>
                </div>
              </Card>

              {/* Vertical connector from agency to children */}
              {hasChildren && (
                <div className="relative w-px h-10 bg-gradient-to-b from-blue-300 to-gray-300">
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-gray-300" />
                </div>
              )}
            </div>

            {/* ─── Horizontal branch line ─── */}
            {(agencyTeams.length > 1 || (agencyTeams.length > 0 && agencyAgents.length > 0)) && (
              <div className="flex justify-center">
                <div className="h-px bg-gray-300" style={{
                  width: `${Math.min(90, (agencyTeams.length + (agencyAgents.length > 0 ? 1 : 0)) * 20)}%`
                }} />
              </div>
            )}

            {/* Empty agency state */}
            {!hasChildren && (
              <div className="flex justify-center mt-4">
                <p className="text-sm text-muted-foreground bg-muted/30 px-4 py-2 rounded-lg border border-dashed">
                  No teams or people yet
                </p>
              </div>
            )}

            {/* ─── Teams Level ─── */}
            <div className="flex justify-center gap-10 flex-wrap mt-0">
              {agencyTeams.map(team => {
                const teamAgents = getAgentsForTeam(team.id);

                return (
                  <div key={team.id} className="flex flex-col items-center">
                    {/* Vertical connector to team */}
                    <div className="w-px h-6 bg-gray-300" />

                    <Card className="w-72 p-4 bg-gradient-to-br from-purple-50 to-pink-50
                                    border-2 border-purple-200 shadow-md hover:shadow-lg transition-shadow">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2.5 flex-1 min-w-0">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500
                                          flex items-center justify-center shrink-0 shadow-sm">
                            <Users className="h-5 w-5 text-white" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold truncate">{team.name}</p>
                            <p className="text-[11px] text-muted-foreground">{teamAgents.length} people</p>
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
                              <Edit className="h-4 w-4 mr-2" />Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onDelete('team', team)} className="text-destructive">
                              <Trash2 className="h-4 w-4 mr-2" />Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAddAgent(agency.id, team.id)}
                        className="w-full bg-white/60"
                      >
                        <Plus className="h-3 w-3 mr-1" />Add Person
                      </Button>
                    </Card>

                    {/* Team Agents */}
                    {teamAgents.length > 0 ? (
                      <>
                        <div className="relative w-px h-6 bg-gray-300">
                          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-gray-300" />
                        </div>
                        <div className="flex flex-wrap gap-3 justify-center max-w-md">
                          {teamAgents.map(agent => (
                            <AgentOrgNode
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
                      </>
                    ) : (
                      <p className="text-[11px] text-muted-foreground mt-2 text-center">No people in this team</p>
                    )}
                  </div>
                );
              })}

              {/* Direct Agency Agents (no team) */}
              {agencyAgents.length > 0 && (
                <div className="flex flex-col items-center">
                  {agencyTeams.length > 0 && <div className="w-px h-6 bg-gray-300" />}
                  <div className="text-center text-[11px] font-medium text-muted-foreground mb-3
                                  px-3 py-1 rounded-full bg-muted/50 border border-border/50">
                    Direct People ({agencyAgents.length})
                  </div>
                  <div className="flex flex-wrap gap-3 justify-center max-w-lg">
                    {agencyAgents.map(agent => (
                      <AgentOrgNode
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
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Individual agent node in the org chart — enhanced with health score,
 * last contact indicator, follow-up badge, tags, and quick actions.
 */
function AgentOrgNode({ agent, navigate, onEdit, onDelete, agentProjectCounts, agentRevenue, onOpenActivityPanel }) {
  return (
    <Card
      className={cn(
        "w-40 p-2.5 hover:shadow-lg transition-all cursor-pointer group relative",
        agent.is_at_risk
          ? "border-amber-300 bg-amber-50/30"
          : "bg-white"
      )}
      onClick={() => navigate(createPageUrl('PersonDetails') + `?id=${agent.id}`)}
    >
      <div className="flex flex-col items-center text-center">
        {/* Avatar with health ring */}
        <div className="relative mb-1.5">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-100 to-emerald-50
                          flex items-center justify-center border-2 border-green-200">
            <span className="text-xs font-bold text-green-700">
              {(agent.name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'}
            </span>
          </div>
          {/* Health score badge (top-right of avatar) */}
          <div className="absolute -top-1 -right-1">
            <ContactHealthScore
              agent={agent}
              projectCount={agentProjectCounts?.[agent.id] || 0}
              totalRevenue={agentRevenue?.[agent.id] || 0}
              size="sm"
            />
          </div>
        </div>

        {/* Name */}
        <p className="text-xs font-semibold truncate w-full leading-tight">{agent.name}</p>

        {/* State badge */}
        {agent.relationship_state && (
          <span className={cn(
            "text-[9px] px-1.5 py-0 rounded font-medium border mt-1",
            agent.relationship_state === 'Active'   ? 'bg-green-100 text-green-700 border-green-200' :
            agent.relationship_state === 'Dormant'   ? 'bg-amber-100 text-amber-700 border-amber-200' :
            agent.relationship_state === 'Do Not Contact' ? 'bg-red-100 text-red-700 border-red-200' :
            'bg-blue-100 text-blue-700 border-blue-200'
          )}>
            {agent.relationship_state}
          </span>
        )}

        {/* Contact indicators */}
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap justify-center">
          <LastContactIndicator agent={agent} size="xs" />
          <NextFollowUpIndicator agent={agent} size="xs" />
        </div>

        {/* Tags */}
        {Array.isArray(agent.tags) && agent.tags.length > 0 && (
          <div className="mt-1.5">
            <TagList tags={agent.tags} max={2} size="xs" />
          </div>
        )}

        {/* At-risk indicator */}
        {agent.is_at_risk && (
          <div className="flex items-center gap-1 mt-1 text-[9px] text-amber-600 font-medium">
            <AlertTriangle className="h-2.5 w-2.5" />
            At risk
          </div>
        )}

        {/* Quick actions (hover) */}
        <div className="flex gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
          <QuickLogInteraction agent={agent} triggerSize="icon" />
          {onOpenActivityPanel && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0"
              onClick={e => { e.stopPropagation(); onOpenActivityPanel(agent); }}
              title="Activity"
            >
              <Activity className="h-3 w-3" />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={e => e.stopPropagation()}>
                <MoreVertical className="h-3 w-3" />
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
    </Card>
  );
}
