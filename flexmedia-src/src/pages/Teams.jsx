import { useState, useMemo, useEffect } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, Mail, Phone, Building2, ExternalLink, List, LayoutGrid, UsersRound, UserRound } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { useNavigate } from 'react-router-dom';
import TeamForm from '@/components/clients/TeamForm';
import EntityDataTable from '@/components/common/EntityDataTable';
import SmartFilterBar from '@/components/common/SmartFilterBar';
import BulkActionBar from '@/components/common/BulkActionBar';
import { cn } from '@/lib/utils';

function fmtRevenue(n) {
  if (!n) return '$0';
  if (n >= 1000000) return `$${(n/1000000).toFixed(1)}m`;
  if (n >= 1000) return `$${(n/1000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

export default function Teams() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [view, setView] = useState('table');
  const [showForm, setShowForm] = useState(false);
  const [editingTeam, setEditingTeam] = useState(null);
  const [preselectedAgencyId, setPreselectedAgencyId] = useState(null);

  // Smart filters + agency dropdown
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [agencyFilter, setAgencyFilter] = useState(null);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const { data: teams = [], loading } = useEntityList('Team', 'name');
  const { data: agencies = [] } = useEntityList('Agency', 'name');
  const { data: agents = [] } = useEntityList('Agent', 'name');
  const { data: projects = [] } = useEntityList('Project', null, 5000);

  const agentsByTeam = useMemo(() => {
    const m = {};
    agents.forEach(a => { if (a.current_team_id) { if (!m[a.current_team_id]) m[a.current_team_id] = []; m[a.current_team_id].push(a); } });
    return m;
  }, [agents]);

  const agentCountByTeam = useMemo(() => {
    const map = {};
    agents.forEach(a => { if (a.current_team_id) { map[a.current_team_id] = (map[a.current_team_id] || 0) + 1; } });
    return map;
  }, [agents]);

  const projectsByAgent = useMemo(() => {
    const m = {};
    projects.forEach(p => { if (p.agent_id) { if (!m[p.agent_id]) m[p.agent_id] = []; m[p.agent_id].push(p); } });
    return m;
  }, [projects]);

  const revenueByTeam = useMemo(() => {
    const m = {};
    teams.forEach(team => {
      const members = agentsByTeam[team.id] || [];
      m[team.id] = members.reduce((sum, a) => {
        return sum + (projectsByAgent[a.id] || []).reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
      }, 0);
    });
    return m;
  }, [teams, agentsByTeam, projectsByAgent]);

  const filterCounts = useMemo(() => ({
    has_members: teams.filter(t => (agentCountByTeam[t.id] || 0) > 0).length,
    empty: teams.filter(t => (agentCountByTeam[t.id] || 0) === 0).length,
  }), [teams, agentCountByTeam]);

  // BUG FIX #8: Clear selection when search/filters change
  useEffect(() => { setSelectedIds(new Set()); }, [search, activeFilters, agencyFilter]);

  const filtered = useMemo(() => {
    let result = teams;

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t?.name?.toLowerCase().includes(q) ||
        t?.agency_name?.toLowerCase().includes(q) ||
        t?.email?.toLowerCase().includes(q)
      );
    }

    // Smart filters
    if (activeFilters.has('has_members')) result = result.filter(t => (agentCountByTeam[t.id] || 0) > 0);
    if (activeFilters.has('empty')) result = result.filter(t => (agentCountByTeam[t.id] || 0) === 0);

    // Agency dropdown
    if (agencyFilter) result = result.filter(t => t.agency_id === agencyFilter);

    return result;
  }, [teams, search, activeFilters, agencyFilter, agentCountByTeam]);

  // Selection handlers
  const handleToggleSelect = (id) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const handleToggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(t => t.id)));
    }
  };

  // Page-aware select: toggle only the visible page's IDs
  const handleSelectPage = (pageIds) => {
    setSelectedIds(prev => {
      const allSelected = pageIds.every(id => prev.has(id));
      if (allSelected) return new Set();
      return new Set(pageIds);
    });
  };

  const columns = [
    {
      key: 'name', label: 'Team', sortable: true,
      render: (row) => (
        <span className="font-medium text-sm text-foreground group-hover:text-primary transition-colors">{row.name}</span>
      ),
    },
    {
      key: 'agency_name', label: 'Organisation', sortable: true,
      render: (row) => row.agency_name
        ? <span className="text-xs text-muted-foreground">{row.agency_name}</span>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'people', label: 'People', sortable: true, width: '70px', align: 'center',
      sortValue: (row) => (agentsByTeam[row.id] || []).length,
      render: (row) => { const c = (agentsByTeam[row.id] || []).length; return <span className="tabular-nums text-xs font-medium">{c > 0 ? c : <span className="text-muted-foreground/30">0</span>}</span>; },
    },
    {
      key: 'revenue', label: 'Revenue', sortable: true, width: '90px', align: 'right',
      sortValue: (row) => revenueByTeam[row.id] || 0,
      render: (row) => {
        const r = revenueByTeam[row.id] || 0;
        return r > 0
          ? <span className="tabular-nums text-xs font-medium text-foreground">{fmtRevenue(r)}</span>
          : <span className="text-muted-foreground/30 text-xs">—</span>;
      },
    },
    {
      key: 'email', label: 'Email', sortable: true,
      render: (row) => row.email
        ? <a href={`mailto:${row.email}`} className="text-xs text-primary hover:underline truncate max-w-[160px] block" onClick={e => e.stopPropagation()}>{row.email}</a>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'phone', label: 'Phone', width: '120px',
      render: (row) => row.phone
        ? <a href={`tel:${row.phone}`} className="text-xs tabular-nums hover:text-primary" onClick={e => e.stopPropagation()}>{row.phone}</a>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: '_actions', label: '', width: '90px', noClick: true, align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={e => { e.stopPropagation(); setEditingTeam(row); setPreselectedAgencyId(row.agency_id); setShowForm(true); }}>Edit</Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); navigate(createPageUrl('TeamDetails') + '?id=' + row.id); }} aria-label="View team details">
            <ExternalLink className="h-3 w-3" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <div className="flex items-center gap-6">
          <h1 className="text-lg font-semibold">Teams</h1>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{teams.length}</span> total ·
            <span className="text-muted-foreground ml-1">{agencies.length} organisations</span>
          </div>
        </div>
        <Button onClick={() => { setEditingTeam(null); setPreselectedAgencyId(null); setShowForm(true); }} size="sm" className="gap-1.5 h-8">
          <Plus className="h-3.5 w-3.5" />Add Team
        </Button>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0 bg-muted/20">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search teams or organisations..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-7 text-xs pr-7" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded-full hover:bg-muted transition-colors" aria-label="Clear search" title="Clear search">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          )}
        </div>
        <span className="text-xs text-muted-foreground ml-auto">{filtered.length} shown</span>
        <div className="flex items-center border rounded-md overflow-hidden">
          <button onClick={() => setView('table')} className={cn("px-2 py-1.5 transition-colors", view === 'table' ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
            <List className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setView('cards')} className={cn("px-2 py-1.5 transition-colors", view === 'cards' ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Smart Filter Bar */}
      <div className="px-6 py-2 border-b shrink-0">
        <SmartFilterBar
          quickFilters={[
            { id: 'has_members', label: 'Has Members', icon: UsersRound, count: filterCounts.has_members },
            { id: 'empty', label: 'Empty', icon: UserRound, count: filterCounts.empty },
          ]}
          activeFilters={activeFilters}
          onToggleFilter={(id) => setActiveFilters(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
          dropdownFilters={[
            { id: 'agency', label: 'Organisation', icon: Building2, options: agencies.map(a => ({ value: a.id, label: a.name })), value: agencyFilter, onChange: setAgencyFilter },
          ]}
          onClearAll={() => { setActiveFilters(new Set()); setAgencyFilter(null); }}
          totalCount={teams.length}
          filteredCount={filtered.length}
        />
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Bulk Action Bar */}
        <BulkActionBar
          selectedCount={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          loading={bulkLoading}
          actions={[]}
        />

        {view === 'table' ? (
          <EntityDataTable columns={columns} data={filtered} loading={loading}
            onRowClick={row => navigate(createPageUrl('TeamDetails') + '?id=' + row.id)}
            emptyMessage={search ? 'No teams match your search' : 'No teams yet'} pageSize={100}
            selectable
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onSelectPage={handleSelectPage}
          />
        ) : (
          <>
            {loading && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array(8).fill(0).map((_, i) => <div key={i} className="h-48 bg-muted animate-pulse rounded-xl" />)}
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Building2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium">{search ? `No results for "${search}"` : 'No teams found'}</p>
                {search && (
                  <Button variant="outline" size="sm" onClick={() => setSearch('')} className="mt-3">
                    Clear search
                  </Button>
                )}
              </div>
            )}
            {!loading && filtered.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filtered.map(row => (
                  <div key={row.id} className="bg-card border rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => navigate(createPageUrl('TeamDetails') + '?id=' + row.id)}>
                    <TeamCardContent row={row} members={agentsByTeam[row.id] || []} revenue={revenueByTeam[row.id] || 0} projectsByAgent={projectsByAgent} />
                    <div className="flex gap-2 mt-3 pt-3 border-t" onClick={e => e.stopPropagation()}>
                      <Button variant="outline" size="sm" className="flex-1 h-7 text-xs" onClick={() => { setEditingTeam(row); setPreselectedAgencyId(row.agency_id); setShowForm(true); }}>Edit</Button>
                      <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => navigate(createPageUrl('TeamDetails') + '?id=' + row.id)}>View</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <TeamForm team={editingTeam} open={showForm}
        onClose={() => { setShowForm(false); setEditingTeam(null); setPreselectedAgencyId(null); }}
        preselectedAgencyId={preselectedAgencyId} />
    </div>
  );
}

function TeamCardContent({ row, members, revenue, projectsByAgent }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-semibold text-sm">{row.name}</p>
        {row.agency_name && (
          <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
            <Building2 className="h-3 w-3" />{row.agency_name}
          </div>
        )}
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {row.email && <div className="flex items-center gap-2"><Mail className="h-3 w-3 shrink-0" />{row.email}</div>}
        {row.phone && <div className="flex items-center gap-2"><Phone className="h-3 w-3 shrink-0" />{row.phone}</div>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{members.length}</p>
          <p className="text-[10px] text-muted-foreground">People</p>
        </div>
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{fmtRevenue(revenue)}</p>
          <p className="text-[10px] text-muted-foreground">Revenue</p>
        </div>
      </div>
      {members.length > 0 && (
        <div className="border-t pt-2">
          <p className="text-[10px] text-muted-foreground mb-1.5">Members</p>
          <div className="space-y-1">
            {members.slice(0, 5).map(a => (
              <div key={a.id} className="flex items-center justify-between text-xs">
                <span>{a.name}</span>
                <span className="text-muted-foreground">{(projectsByAgent[a.id] || []).length} projects</span>
              </div>
            ))}
            {members.length > 5 && <p className="text-[10px] text-muted-foreground">+{members.length - 5} more</p>}
          </div>
        </div>
      )}
      {row.notes && <p className="text-xs text-muted-foreground border-t pt-2 line-clamp-2">{row.notes}</p>}
    </div>
  );
}
