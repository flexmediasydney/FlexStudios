import { Building, Users, User, Edit, Trash2, MoreVertical, Mail, Phone, Plus, AlertTriangle, Pencil, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { TagList } from "@/components/clients/ContactTags";
import ContactHealthScore from "@/components/clients/ContactHealthScore";
import { LastContactIndicator, NextFollowUpIndicator } from "@/components/clients/ContactIndicators";
import QuickLogInteraction from "@/components/clients/QuickLogInteraction";

export default function HierarchyGridView({
  agencies,
  teams,
  agents,
  onAddTeam,
  onAddAgent,
  onEdit,
  onDelete,
  selectedAgentIds,
  toggleSelectAgent,
  toggleSelectAll,
  agentsFiltered,
  agentProjectCounts,
  agentRevenue,
  onOpenActivityPanel,
}) {
  const navigate = useNavigate();
  const getTeamsForAgency = (agencyId) => teams.filter(t => t.agency_id === agencyId);
  const getAgentsForAgency = (agencyId) => agents.filter(a => a.current_agency_id === agencyId && !a.current_team_id);
  const getAgentsForTeam = (teamId) => agents.filter(a => a.current_team_id === teamId);

  const renderAgentCard = (agent) => (
    <div
      key={agent.id}
      className={`relative p-3 rounded-lg border transition-all cursor-pointer
        hover:shadow-md group ${
        agent.is_at_risk
          ? 'border-amber-300 bg-amber-50/30 dark:bg-amber-950/10'
          : 'border-border hover:border-border/80'
      }`}
      onClick={() => navigate(createPageUrl('PersonDetails') + `?id=${agent.id}`)}
    >
      {/* Selection checkbox */}
      {selectedAgentIds && toggleSelectAgent && (
        <input
          type="checkbox"
          checked={selectedAgentIds.has(agent.id) || false}
          onChange={e => { e.stopPropagation(); toggleSelectAgent(agent.id); }}
          onClick={e => e.stopPropagation()}
          className="absolute top-2 left-2 opacity-0 group-hover:opacity-100
                     checked:opacity-100 cursor-pointer"
        />
      )}

      {/* Header: avatar + name + badges + health score */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center
                          justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-primary">
              {(agent.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate leading-tight">{agent.name}</p>
            {agent.title && (
              <p className="text-[10px] text-muted-foreground truncate">{agent.title}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Contact Health Score */}
          <ContactHealthScore
            agent={agent}
            projectCount={agentProjectCounts?.[agent.id] || 0}
            totalRevenue={agentRevenue?.[agent.id] || 0}
            size="sm"
          />
          {agent.is_at_risk && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" title="At risk" />
          )}
          {agent.relationship_state && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${
              agent.relationship_state === 'Active'
                ? 'bg-green-100 text-green-700 border-green-200'
              : agent.relationship_state === 'Dormant'
                ? 'bg-amber-100 text-amber-700 border-amber-200'
              : agent.relationship_state === 'Do Not Contact'
                ? 'bg-red-100 text-red-700 border-red-200'
              : 'bg-blue-100 text-blue-700 border-blue-200'
            }`}>
              {agent.relationship_state}
            </span>
          )}
        </div>
      </div>

      {/* Contact details */}
      <div className="space-y-0.5 mb-2">
        {agent.email ? (
          <a
            href={`mailto:${agent.email}`}
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground
                       hover:text-primary transition-colors"
          >
            <Mail className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{agent.email}</span>
          </a>
        ) : null}
        {agent.phone ? (
          <a
            href={`tel:${agent.phone}`}
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground
                       hover:text-green-600 transition-colors"
          >
            <Phone className="h-3 w-3 flex-shrink-0" />
            <span>{agent.phone}</span>
          </a>
        ) : null}
        {!agent.email && !agent.phone && (
          <p className="text-[10px] text-amber-600 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            No contact info
          </p>
        )}
      </div>

      {/* Last Contact + Follow-up Indicators */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <LastContactIndicator agent={agent} size="xs" />
        <NextFollowUpIndicator agent={agent} size="xs" />
      </div>

      {/* Color-coded Tags */}
      {Array.isArray(agent.tags) && agent.tags.length > 0 && (
        <div className="mb-2">
          <TagList tags={agent.tags} max={3} size="xs" />
        </div>
      )}

      {/* Quick actions — appear on hover */}
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] px-2 flex-1"
          onClick={e => {
            e.stopPropagation();
            navigate(createPageUrl('Projects') + `?agent=${agent.id}`);
          }}
        >
          New project
        </Button>
        <QuickLogInteraction agent={agent} triggerSize="icon" />
        {onOpenActivityPanel && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            onClick={e => { e.stopPropagation(); onOpenActivityPanel(agent); }}
            title="Activity timeline"
          >
            <Activity className="h-3 w-3" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={e => { e.stopPropagation(); onEdit('agent', agent); }}
          title="Edit"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      {agencies.map(agency => {
        const agencyTeams = getTeamsForAgency(agency.id);
        const agencyAgents = getAgentsForAgency(agency.id);

        return (
          <Card key={agency.id} className="overflow-hidden">
            {/* Agency Header */}
            <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50 pb-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center">
                    <Building className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">{agency.name}</CardTitle>
                    <div className="flex items-center gap-3 mt-1">
                      {agency.email && (
                        <a href={`mailto:${agency.email}`} className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5" />
                          {agency.email}
                        </a>
                      )}
                      {agency.phone && (
                        <a href={`tel:${agency.phone}`} className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5" />
                          {agency.phone}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => onAddTeam(agency.id)}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Team
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAddAgent(agency.id)}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Agent
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More actions">
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
            </CardHeader>

            <CardContent className="pt-6">
              {/* Teams Grid */}
              {agencyTeams.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Teams ({agencyTeams.length})
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {agencyTeams.map(team => {
                      const teamAgents = getAgentsForTeam(team.id);

                      return (
                        <Card key={team.id} className="bg-purple-50/50 border-purple-200">
                          <CardHeader className="pb-3">
                            <div className="flex items-start justify-between">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center">
                                  <Users className="h-4 w-4 text-white" />
                                </div>
                                <div>
                                  <CardTitle className="text-sm">{team.name}</CardTitle>
                                  <p className="text-xs text-muted-foreground">{teamAgents.length} agents</p>
                                </div>
                              </div>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More actions">
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
                          </CardHeader>
                          <CardContent className="pt-0 space-y-2">
                            {teamAgents.slice(0, 3).map(agent => (
                              <div key={agent.id} className="flex items-center gap-2 text-xs">
                                <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
                                  <User className="h-3 w-3 text-green-600" />
                                </div>
                                <span className="truncate flex-1">{agent.name}</span>
                                <LastContactIndicator agent={agent} size="xs" />
                              </div>
                            ))}
                            {teamAgents.length > 3 && (
                              <p className="text-xs text-muted-foreground">+{teamAgents.length - 3} more</p>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="w-full mt-2"
                              onClick={() => onAddAgent(agency.id, team.id)}
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Add Person
                            </Button>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Direct Agents */}
              {agencyAgents.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3 px-1">
                    {selectedAgentIds && toggleSelectAll && agentsFiltered && (
                      <input
                        type="checkbox"
                        checked={selectedAgentIds.size === agentsFiltered.length && agentsFiltered.length > 0}
                        onChange={toggleSelectAll}
                        className="cursor-pointer"
                      />
                    )}
                    <h4 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                      <User className="h-4 w-4" />
                      Direct Agents ({agencyAgents.length})
                    </h4>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    {agencyAgents.map(renderAgentCard)}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
