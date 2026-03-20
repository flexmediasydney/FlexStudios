import React, { useState } from "react";
import { Building, Users, User, Edit, Trash2, MoreVertical, Mail, Phone, Plus, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { createPageUrl } from "@/utils";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import AgentForm from "@/components/clients/AgentForm";

const STATE_COLORS = {
  Active: 'bg-green-100 text-green-700',
  Prospecting: 'bg-blue-100 text-blue-700',
  Dormant: 'bg-amber-100 text-amber-700',
  'Do Not Contact': 'bg-red-100 text-red-700',
};

export default function Org2Hierarchy({ 
  agency,
  teams = [],
  agents = [],
  onAddTeam,
  onAddAgent,
  onEdit,
  onDelete,
  onRefresh
}) {
  const navigate = useNavigate();
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [preselectedTeamId, setPreselectedTeamId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const getTeamsForAgency = (id) => teams.filter(t => t.agency_id === id);
  const getAgentsForAgency = (id) => agents.filter(a => a.current_agency_id === id && !a.current_team_id);
  const getAgentsForTeam = (teamId) => agents.filter(a => a.current_team_id === teamId);

  const agencyTeams = getTeamsForAgency(agency.id);
  const agencyAgents = getAgentsForAgency(agency.id);

  const openAddAgent = (teamId = null) => {
    setEditingAgent(null);
    setPreselectedTeamId(teamId);
    setAgentFormOpen(true);
  };

  const openEditAgent = (agent) => {
    setEditingAgent(agent);
    setPreselectedTeamId(null);
    setAgentFormOpen(true);
  };

  const handleDeleteAgent = async (agent) => {
    if (!confirm(`Delete ${agent.name}? This cannot be undone.`)) return;
    setDeletingId(agent.id);
    try {
      await base44.entities.Agent.delete(agent.id);
      onRefresh?.();
    } finally {
      setDeletingId(null);
    }
  };

  const handleFormClose = () => {
    setAgentFormOpen(false);
    setEditingAgent(null);
    setPreselectedTeamId(null);
    onRefresh?.();
  };

  return (
    <div className="p-4 space-y-4">
      <Card className="overflow-hidden">
        {/* Agency Header */}
        <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50 pb-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
                <Building className="h-5 w-5 text-white" />
              </div>
              <div>
                <CardTitle className="text-base">{agency.name}</CardTitle>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  {agency.email && (
                    <a href={`mailto:${agency.email}`} className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1">
                      <Mail className="h-3 w-3" />
                      {agency.email}
                    </a>
                  )}
                  {agency.phone && (
                    <a href={`tel:${agency.phone}`} className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {agency.phone}
                    </a>
                  )}
                  {agency.relationship_state && (
                    <Badge className={`text-[10px] px-1.5 py-0 ${STATE_COLORS[agency.relationship_state] || 'bg-gray-100 text-gray-700'}`}>
                      {agency.relationship_state}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="outline" className="gap-1 text-xs h-7" onClick={() => openAddAgent()}>
                <Plus className="h-3 w-3" />
                Person
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-4 space-y-6">
          {/* Teams */}
          {agencyTeams.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                <Users className="h-3.5 w-3.5" />
                Teams ({agencyTeams.length})
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {agencyTeams.map(team => {
                  const teamAgents = getAgentsForTeam(team.id);
                  return (
                    <Card key={team.id} className="bg-purple-50/50 border-purple-100">
                      <CardHeader className="pb-2 pt-3 px-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-purple-500 flex items-center justify-center shrink-0">
                              <Users className="h-3.5 w-3.5 text-white" />
                            </div>
                            <div>
                              <CardTitle className="text-sm">{team.name}</CardTitle>
                              <p className="text-xs text-muted-foreground">{teamAgents.length} {teamAgents.length === 1 ? 'person' : 'people'}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              title="View team"
                              onClick={() => navigate(createPageUrl('TeamDetails') + `?id=${team.id}`)}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-primary"
                              title="Add person to team"
                              onClick={() => openAddAgent(team.id)}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0 pb-3 px-3 space-y-1.5">
                        {teamAgents.slice(0, 4).map(agent => (
                          <div
                            key={agent.id}
                            className="flex items-center gap-2 text-xs group cursor-pointer"
                            onClick={() => navigate(createPageUrl('PersonDetails') + `?id=${agent.id}`)}
                          >
                            <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                              <User className="h-3 w-3 text-green-600" />
                            </div>
                            <span className="truncate flex-1 group-hover:text-primary transition-colors">{agent.name}</span>
                            {agent.relationship_state && (
                              <span className={`text-[9px] px-1 rounded ${STATE_COLORS[agent.relationship_state] || ''}`}>
                                {agent.relationship_state === 'Active' ? '●' : agent.relationship_state === 'Dormant' ? '○' : ''}
                              </span>
                            )}
                          </div>
                        ))}
                        {teamAgents.length > 4 && (
                          <p className="text-xs text-muted-foreground pl-7">+{teamAgents.length - 4} more</p>
                        )}
                        {teamAgents.length === 0 && (
                          <p className="text-xs text-muted-foreground italic">No people yet</p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Direct Agents (no team) */}
          {agencyAgents.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                <User className="h-3.5 w-3.5" />
                Direct People ({agencyAgents.length})
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {agencyAgents.map(agent => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-2 p-2 rounded-lg border bg-card hover:bg-muted/30 transition-colors group"
                  >
                    <div
                      className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                      onClick={() => navigate(createPageUrl('PersonDetails') + `?id=${agent.id}`)}
                    >
                      <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                        <User className="h-3.5 w-3.5 text-green-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate group-hover:text-primary transition-colors">{agent.name}</p>
                        {agent.email && <p className="text-[10px] text-muted-foreground truncate">{agent.email}</p>}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <MoreVertical className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(createPageUrl('PersonDetails') + `?id=${agent.id}`)}>
                          <ExternalLink className="h-3.5 w-3.5 mr-2" />
                          View Profile
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openEditAgent(agent)}>
                          <Edit className="h-3.5 w-3.5 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => handleDeleteAgent(agent)}
                          className="text-destructive"
                          disabled={deletingId === agent.id}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          {deletingId === agent.id ? 'Deleting...' : 'Delete'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </div>
          )}

          {agencyTeams.length === 0 && agencyAgents.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-8 w-8 mx-auto opacity-30 mb-2" />
              <p className="text-sm font-medium">No people yet</p>
              <p className="text-xs mt-1 opacity-70">Add a person to get started</p>
              <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={() => openAddAgent()}>
                <Plus className="h-3.5 w-3.5" />
                Add Person
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Agent form dialog */}
      <AgentForm
        agent={editingAgent}
        open={agentFormOpen}
        onClose={handleFormClose}
        preselectedAgencyId={agency.id}
        preselectedTeamId={preselectedTeamId}
      />
    </div>
  );
}