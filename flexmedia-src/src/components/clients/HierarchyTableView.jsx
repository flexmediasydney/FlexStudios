import React, { useState, useMemo, useEffect, useRef } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import {
  ChevronRight, ChevronDown, Building2, Users, User,
  MoreVertical, Settings2, RotateCcw, Check
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import ContactHealthScore from "@/components/clients/ContactHealthScore";
import { LastContactIndicator, NextFollowUpIndicator } from "@/components/clients/ContactIndicators";
import { TagList } from "@/components/clients/ContactTags";

const STORAGE_KEY = "hierarchy_table_cols_v2";

const ALL_COLUMNS = [
  { id: 'state',       label: 'State' },
  { id: 'health',      label: 'Health' },
  { id: 'last_contact',label: 'Last Contact' },
  { id: 'follow_up',   label: 'Follow-up' },
  { id: 'tags',        label: 'Tags' },
  { id: 'projects',    label: '# Projects' },
  { id: 'team_size',   label: 'Team Size' },
  { id: 'revenue',     label: 'Revenue' },
  { id: 'email',       label: 'Email' },
  { id: 'phone',       label: 'Phone' },
];

const DEFAULT_COLUMNS = ['state', 'health', 'last_contact', 'projects', 'revenue'];

const STATE_COLORS = {
  'Active':          'bg-green-100 text-green-700 border-green-200',
  'Prospecting':     'bg-orange-100 text-orange-700 border-orange-200',
  'Dormant':         'bg-gray-100 text-gray-500 border-gray-200',
  'Do Not Contact':  'bg-red-100 text-red-700 border-red-200',
};

function fmtRevenue(val) {
  if (!val) return '—';
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000)     return `$${(val / 1_000).toFixed(1)}k`;
  return `$${Math.round(val).toLocaleString()}`;
}

export default function HierarchyTableView({ agencies, teams, agents, onEdit, onDelete, onAddTeam, onAddAgent }) {
  const navigate = useNavigate();
  const [expandedAgencies, setExpandedAgencies] = useState(new Set());
  const [expandedTeams,    setExpandedTeams]    = useState(new Set());
  const [showPicker,       setShowPicker]       = useState(false);
  const [visibleColumns,   setVisibleColumns]   = useState(DEFAULT_COLUMNS);
  const pickerRef = useRef(null);

  const { data: projects = [] } = useEntityList("Project", null, 5000);

  // Close picker on outside click
  useEffect(() => {
    const handler = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setShowPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Pre-compute stats per entity
  const agencyStats = useMemo(() => {
    const map = {};
    for (const ag of agencies) {
      const ps          = projects.filter(p => p.agency_id === ag.id);
      const agTeams     = teams.filter(t => t.agency_id === ag.id);
      const directPeople= agents.filter(a => a.current_agency_id === ag.id && !a.current_team_id);
      map[ag.id] = {
        projects:  ps.length,
        teamSize:  agTeams.length + directPeople.length,
        revenue:   ps.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0),
      };
    }
    return map;
  }, [agencies, teams, agents, projects]);

  const teamStats = useMemo(() => {
    const map = {};
    for (const t of teams) {
      const tAgents = agents.filter(a => a.current_team_id === t.id);
      const ids     = new Set(tAgents.map(a => a.id));
      const ps      = projects.filter(p => ids.has(p.agent_id));
      map[t.id] = {
        projects: ps.length,
        teamSize: tAgents.length,
        revenue:  ps.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0),
      };
    }
    return map;
  }, [teams, agents, projects]);

  const agentStats = useMemo(() => {
    const map = {};
    for (const a of agents) {
      const ps = projects.filter(p => p.agent_id === a.id);
      map[a.id] = {
        projects: ps.length,
        revenue:  ps.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0),
      };
    }
    return map;
  }, [agents, projects]);

  const saveColumns = (cols) => {
    setVisibleColumns(cols);
  };

  const toggleColumn = (colId) => {
    saveColumns(
      visibleColumns.includes(colId)
        ? visibleColumns.filter(c => c !== colId)
        : [...visibleColumns, colId]
    );
  };

  const toggleAgency = (id) =>
    setExpandedAgencies(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleTeam = (id) =>
    setExpandedTeams(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const activeColumns = ALL_COLUMNS.filter(c => visibleColumns.includes(c.id));

  const renderCell = (colId, entity, type, stats) => {
    switch (colId) {
      case 'state': {
        if (type === 'team') return <span className="text-muted-foreground/50">—</span>;
        const s = entity.relationship_state;
        return s
          ? <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap", STATE_COLORS[s] || "bg-muted")}>{s}</span>
          : <span className="text-muted-foreground/50">—</span>;
      }
      case 'health': {
        if (type !== 'agent') return <span className="text-muted-foreground/50">—</span>;
        return (
          <ContactHealthScore
            agent={entity}
            projectCount={stats?.projects || 0}
            totalRevenue={stats?.revenue || 0}
            size="sm"
          />
        );
      }
      case 'last_contact': {
        if (type !== 'agent') return <span className="text-muted-foreground/50">—</span>;
        return <LastContactIndicator agent={entity} size="xs" />;
      }
      case 'follow_up': {
        if (type !== 'agent') return <span className="text-muted-foreground/50">—</span>;
        const indicator = <NextFollowUpIndicator agent={entity} size="xs" />;
        return indicator || <span className="text-muted-foreground/50">—</span>;
      }
      case 'tags': {
        if (type !== 'agent') return <span className="text-muted-foreground/50">—</span>;
        return Array.isArray(entity.tags) && entity.tags.length > 0
          ? <TagList tags={entity.tags} max={3} size="xs" />
          : <span className="text-muted-foreground/50">—</span>;
      }
      case 'projects':
        return <span className="tabular-nums">{stats?.projects ?? '—'}</span>;
      case 'team_size':
        if (type === 'agent') return <span className="text-muted-foreground/50">—</span>;
        return <span className="tabular-nums">{stats?.teamSize ?? '—'}</span>;
      case 'revenue':
        return <span className="tabular-nums font-medium">{fmtRevenue(stats?.revenue)}</span>;
      case 'email':
        return entity.email
          ? <a href={`mailto:${entity.email}`} className="text-primary hover:underline max-w-[160px] block truncate" onClick={e => e.stopPropagation()}>{entity.email}</a>
          : <span className="text-muted-foreground/50">—</span>;
      case 'phone':
        return entity.phone
          ? <span className="whitespace-nowrap">{entity.phone}</span>
          : <span className="text-muted-foreground/50">—</span>;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="flex justify-between items-center px-1">
        <span className="text-xs text-muted-foreground">{agencies.length} organisations · {teams.length} teams · {agents.length} people</span>
        <div className="relative" ref={pickerRef}>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setShowPicker(v => !v)}>
            <Settings2 className="h-3 w-3" /> Columns
          </Button>
          {showPicker && (
            <div className="absolute right-0 top-9 z-50 bg-card border rounded-xl shadow-2xl p-3 w-48">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Visible Columns</p>
              <div className="space-y-1">
                {ALL_COLUMNS.map(col => (
                  <label key={col.id} className="flex items-center gap-2 text-sm cursor-pointer py-0.5 hover:text-foreground select-none">
                    <div className={cn(
                      "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                      visibleColumns.includes(col.id) ? "bg-primary border-primary" : "border-input"
                    )}>
                      {visibleColumns.includes(col.id) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </div>
                    <input type="checkbox" className="sr-only" checked={visibleColumns.includes(col.id)} onChange={() => toggleColumn(col.id)} />
                    {col.label}
                  </label>
                ))}
              </div>
              <div className="mt-3 pt-2 border-t">
                <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => saveColumns(DEFAULT_COLUMNS)}>
                  <RotateCcw className="h-3 w-3" /> Reset defaults
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground min-w-[180px]">Name</th>
              {activeColumns.map(col => (
                <th key={col.id} className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">{col.label}</th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {agencies.map(agency => {
              const agencyTeams  = teams.filter(t => t.agency_id === agency.id);
              const agencyAgents = agents.filter(a => a.current_agency_id === agency.id && !a.current_team_id);
              const isExpanded   = expandedAgencies.has(agency.id);
              const hasChildren  = agencyTeams.length > 0 || agencyAgents.length > 0;
              const stats        = agencyStats[agency.id] || {};

              return (
                <React.Fragment key={agency.id}>
                  {/* ── Organisation row ── */}
                  <tr className="border-b hover:bg-muted/20 transition-colors group cursor-pointer" onClick={() => navigate(createPageUrl("OrgDetails") + "?id=" + agency.id)}>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); hasChildren && toggleAgency(agency.id); }}
                          className={cn("w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0", !hasChildren && "opacity-0 pointer-events-none")}
                        >
                          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </button>
                        <Building2 className="h-3 w-3 text-blue-600 shrink-0" />
                        <span className="font-semibold text-primary hover:underline">{agency.name}</span>
                      </div>
                    </td>
                    {activeColumns.map(col => (
                      <td key={col.id} className="px-3 py-1.5">{renderCell(col.id, agency, 'agency', stats)}</td>
                    ))}
                    <td className="px-1 py-1" onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" aria-label="More actions">
                            <MoreVertical className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onEdit('agency', agency)}>Edit</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onAddTeam(agency.id)}>Add Team</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onAddAgent(agency.id)}>Add Person</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onDelete('agency', agency)} className="text-destructive">Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                    </tr>

                  {/* ── Teams ── */}
                  {isExpanded && agencyTeams.map(team => {
                    const teamAgents    = agents.filter(a => a.current_team_id === team.id);
                    const isTeamExpanded= expandedTeams.has(team.id);
                    const tStats        = teamStats[team.id] || {};

                    return (
                      <React.Fragment key={team.id}>
                        <tr className="border-b hover:bg-purple-50/40 transition-colors group bg-purple-50/10">
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1.5 pl-5">
                              <button
                                onClick={() => teamAgents.length && toggleTeam(team.id)}
                                className={cn("w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0", teamAgents.length === 0 && "opacity-0 pointer-events-none")}
                              >
                                {isTeamExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              </button>
                              <Users className="h-3 w-3 text-purple-600 shrink-0" />
                              <span className="font-medium">{team.name}</span>
                            </div>
                          </td>
                          {activeColumns.map(col => (
                            <td key={col.id} className="px-3 py-1.5">{renderCell(col.id, team, 'team', tStats)}</td>
                          ))}
                          <td className="px-1 py-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100">
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => onEdit('team', team)}>Edit</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onAddAgent(agency.id, team.id)}>Add Person</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onDelete('team', team)} className="text-destructive">Delete</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>

                        {/* ── People in team ── */}
                        {isTeamExpanded && teamAgents.map(agent => {
                          const aStats = agentStats[agent.id] || {};
                          return (
                            <tr key={agent.id} className="border-b hover:bg-green-50/30 transition-colors group cursor-pointer" onClick={() => navigate(createPageUrl("PersonDetails") + "?id=" + agent.id)}>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-1.5 pl-10">
                                  <div className="w-4 shrink-0" />
                                  <User className="h-3 w-3 text-green-600 shrink-0" />
                                  <span className="hover:underline">{agent.name}</span>
                                </div>
                              </td>
                              {activeColumns.map(col => (
                                <td key={col.id} className="px-3 py-1.5">{renderCell(col.id, agent, 'agent', aStats)}</td>
                              ))}
                              <td className="px-1 py-1" onClick={e => e.stopPropagation()}>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100">
                                    <MoreVertical className="h-3 w-3" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => onEdit('agent', agent)}>Edit</DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => onDelete('agent', agent)} className="text-destructive">Delete</DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              </td>
                              </tr>
                              );
                              })}
                              </React.Fragment>
                              );
                              })}

                              {/* ── Direct people (no team) ── */}
                              {isExpanded && agencyAgents.map(agent => {
                              const aStats = agentStats[agent.id] || {};
                              return (
                              <tr key={agent.id} className="border-b hover:bg-green-50/30 transition-colors group cursor-pointer" onClick={() => navigate(createPageUrl("PersonDetails") + "?id=" + agent.id)}>
                              <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5 pl-5">
                              <div className="w-4 shrink-0" />
                              <User className="h-3 w-3 text-green-600 shrink-0" />
                              <span className="hover:underline">{agent.name}</span>
                              </div>
                              </td>
                        {activeColumns.map(col => (
                          <td key={col.id} className="px-3 py-1.5">{renderCell(col.id, agent, 'agent', aStats)}</td>
                        ))}
                        <td className="px-1 py-1" onClick={e => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100">
                                <MoreVertical className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => onEdit('agent', agent)}>Edit</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onDelete('agent', agent)} className="text-destructive">Delete</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                        </tr>
                        );
                        })}
                        </React.Fragment>
              );
            })}
          </tbody>
        </table>

        {agencies.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">No organisations to display</div>
        )}
      </div>
    </div>
  );
}