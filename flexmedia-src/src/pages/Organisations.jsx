import { useState, useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Plus, Search, Building2, MapPin, Mail, Phone, ExternalLink, List, LayoutGrid } from 'lucide-react';
import { createPageUrl } from '@/utils';
import AgencyForm from '@/components/clients/AgencyForm';
import EntityDataTable from '@/components/common/EntityDataTable';
import { cn } from '@/lib/utils';

const STATE_STYLES = {
  'Active':         'bg-green-50 text-green-700 border-green-200',
  'Prospecting':    'bg-orange-50 text-orange-700 border-orange-200',
  'Dormant':        'bg-gray-100 text-gray-500 border-gray-200',
  'Do Not Contact': 'bg-red-50 text-red-700 border-red-200',
};

const FILTER_STATES = ['All', 'Active', 'Prospecting', 'Dormant', 'Do Not Contact'];

function fmtRevenue(n) {
  if (!n) return '$0';
  if (n >= 1000000) return `$${(n/1000000).toFixed(1)}m`;
  if (n >= 1000) return `$${(n/1000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

export default function Organisations() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState('All');
  const [view, setView] = useState('table');
  const [showForm, setShowForm] = useState(false);
  const [editingAgency, setEditingAgency] = useState(null);

  const { data: agencies = [], loading } = useEntityList('Agency', 'name');
  const { data: teams = [] } = useEntityList('Team', 'name');
  const { data: agents = [] } = useEntityList('Agent', 'name');
  const { data: projects = [] } = useEntityList('Project', null, 5000);

  const teamsByAgency = useMemo(() => {
    const m = {};
    teams.forEach(t => { if (!m[t.agency_id]) m[t.agency_id] = []; m[t.agency_id].push(t); });
    return m;
  }, [teams]);

  const agentsByAgency = useMemo(() => {
    const m = {};
    agents.forEach(a => { if (!m[a.current_agency_id]) m[a.current_agency_id] = []; m[a.current_agency_id].push(a); });
    return m;
  }, [agents]);

  const revenueByAgency = useMemo(() => {
    const m = {};
    projects.forEach(p => {
      if (p.agency_id) m[p.agency_id] = (m[p.agency_id] || 0) + (p.calculated_price || p.price || 0);
    });
    return m;
  }, [projects]);

  const stats = useMemo(() => ({
    total: agencies.length,
    active: agencies.filter(a => a.relationship_state === 'Active').length,
    prospecting: agencies.filter(a => a.relationship_state === 'Prospecting').length,
    dormant: agencies.filter(a => a.relationship_state === 'Dormant').length,
    dnc: agencies.filter(a => a.relationship_state === 'Do Not Contact').length,
  }), [agencies]);

  const filtered = useMemo(() => agencies.filter(a => {
    const q = search.toLowerCase();
    const matchSearch = !search || a?.name?.toLowerCase().includes(q) || a?.email?.toLowerCase().includes(q) || a?.address?.toLowerCase().includes(q);
    const matchState = filterState === 'All' || a.relationship_state === filterState;
    return matchSearch && matchState;
  }), [agencies, search, filterState]);

  const columns = [
    {
      key: 'name', label: 'Organisation', sortable: true,
      render: (row) => (
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span className="font-medium text-sm text-foreground hover:text-primary cursor-pointer transition-colors">{row.name}</span>
          </HoverCardTrigger>
          <HoverCardContent side="right" className="w-72 p-4" onClick={e => e.stopPropagation()}>
            <AgencyHoverContent row={row} teams={teamsByAgency[row.id] || []} agentCount={(agentsByAgency[row.id] || []).length} revenue={revenueByAgency[row.id] || 0} />
          </HoverCardContent>
        </HoverCard>
      ),
    },
    {
      key: 'relationship_state', label: 'State', sortable: true, width: '120px',
      render: (row) => row.relationship_state
        ? <Badge className={cn("text-[10px] font-medium px-1.5 py-0 border whitespace-nowrap", STATE_STYLES[row.relationship_state] || 'bg-muted border-transparent')}>{row.relationship_state}</Badge>
        : <span className="text-muted-foreground/40">—</span>,
    },
    {
      key: 'teams', label: 'Teams', sortable: true, width: '60px', align: 'center',
      sortValue: (row) => (teamsByAgency[row.id] || []).length,
      render: (row) => { const c = (teamsByAgency[row.id] || []).length; return <span className="tabular-nums text-xs font-medium">{c > 0 ? c : <span className="text-muted-foreground/30">0</span>}</span>; },
    },
    {
      key: 'people', label: 'People', sortable: true, width: '60px', align: 'center',
      sortValue: (row) => (agentsByAgency[row.id] || []).length,
      render: (row) => { const c = (agentsByAgency[row.id] || []).length; return <span className="tabular-nums text-xs font-medium">{c > 0 ? c : <span className="text-muted-foreground/30">0</span>}</span>; },
    },
    {
      key: 'revenue', label: 'Revenue', sortable: true, width: '90px', align: 'right',
      sortValue: (row) => revenueByAgency[row.id] || 0,
      render: (row) => {
        const r = revenueByAgency[row.id] || 0;
        return r > 0
          ? <span className="tabular-nums text-xs font-medium text-foreground">{fmtRevenue(r)}</span>
          : <span className="text-muted-foreground/30 text-xs">—</span>;
      },
    },
    {
      key: 'email', label: 'Email', sortable: true,
      render: (row) => row.email
        ? <a href={`mailto:${row.email}`} className="text-xs text-primary hover:underline truncate max-w-[180px] block" onClick={e => e.stopPropagation()}>{row.email}</a>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'phone', label: 'Phone', width: '130px',
      render: (row) => row.phone ? <span className="text-xs tabular-nums">{row.phone}</span> : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'onboarding_date', label: 'Since', sortable: true, width: '90px',
      render: (row) => row.onboarding_date
        ? <span className="text-xs text-muted-foreground tabular-nums">{new Date(row.onboarding_date).getFullYear()}</span>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: '_actions', label: '', width: '90px', noClick: true, align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={e => { e.stopPropagation(); setEditingAgency(row); setShowForm(true); }}>Edit</Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); navigate(createPageUrl('OrgDetails') + '?id=' + row.id); }}>
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
          <h1 className="text-lg font-semibold">Organisations</h1>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{stats.total}</span> total ·
            <span className="text-green-600 font-medium ml-1">{stats.active}</span> active ·
            <span className="text-orange-500 font-medium ml-1">{stats.prospecting}</span> prospecting ·
            <span className="text-gray-400 font-medium ml-1">{stats.dormant}</span> dormant
            {stats.dnc > 0 && <><span className="text-red-500 font-medium ml-1">{stats.dnc}</span> DNC</>}
          </div>
        </div>
        <Button onClick={() => { setEditingAgency(null); setShowForm(true); }} size="sm" className="gap-1.5 h-8">
          <Plus className="h-3.5 w-3.5" />Add Organisation
        </Button>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0 bg-muted/20">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search organisations..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-7 text-xs pr-7" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded-full hover:bg-muted transition-colors" aria-label="Clear search" title="Clear search">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {FILTER_STATES.map(s => (
            <button key={s} onClick={() => setFilterState(s)}
              className={cn("px-3 py-1 rounded-md text-xs font-medium transition-colors", filterState === s ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
              {s}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground ml-auto">{filtered.length} shown</span>
        <div className="flex items-center border rounded-md overflow-hidden">
          <button onClick={() => setView('table')} title="Table view" aria-label="Table view" className={cn("px-2 py-1.5 transition-colors", view === 'table' ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
            <List className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setView('cards')} title="Card view" aria-label="Card view" className={cn("px-2 py-1.5 transition-colors", view === 'cards' ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {view === 'table' ? (
          <EntityDataTable columns={columns} data={filtered} loading={loading}
            onRowClick={row => navigate(createPageUrl('OrgDetails') + '?id=' + row.id)}
            emptyMessage={search ? 'No organisations match your search' : 'No organisations yet'} pageSize={100} />
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
                <p className="font-medium">{search ? `No results for "${search}"` : 'No organisations found'}</p>
              </div>
            )}
            {!loading && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filtered.map(row => (
                  <div key={row.id} className="bg-card border rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => navigate(createPageUrl('OrgDetails') + '?id=' + row.id)}>
                    <AgencyHoverContent
                      row={row}
                      teams={teamsByAgency[row.id] || []}
                      agentCount={(agentsByAgency[row.id] || []).length}
                      revenue={revenueByAgency[row.id] || 0}
                    />
                    <div className="flex gap-2 mt-3 pt-3 border-t" onClick={e => e.stopPropagation()}>
                      <Button variant="outline" size="sm" className="flex-1 h-7 text-xs" onClick={() => { setEditingAgency(row); setShowForm(true); }}>Edit</Button>
                      <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => navigate(createPageUrl('OrgDetails') + '?id=' + row.id)}>View</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <AgencyForm agency={editingAgency} open={showForm} onClose={() => { setShowForm(false); setEditingAgency(null); }} />
    </div>
  );
}

function AgencyHoverContent({ row, teams, agentCount, revenue }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-semibold text-sm">{row.name}</p>
        {row.relationship_state && (
          <Badge className={cn("text-[10px] px-1.5 py-0 mt-1 border", STATE_STYLES[row.relationship_state] || 'bg-muted')}>{row.relationship_state}</Badge>
        )}
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {row.email && <div className="flex items-center gap-2"><Mail className="h-3 w-3 shrink-0" />{row.email}</div>}
        {row.phone && <div className="flex items-center gap-2"><Phone className="h-3 w-3 shrink-0" />{row.phone}</div>}
        {row.address && <div className="flex items-center gap-2"><MapPin className="h-3 w-3 shrink-0" />{row.address}</div>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{teams.length}</p>
          <p className="text-[10px] text-muted-foreground">Teams</p>
        </div>
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{agentCount}</p>
          <p className="text-[10px] text-muted-foreground">People</p>
        </div>
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{fmtRevenue(revenue)}</p>
          <p className="text-[10px] text-muted-foreground">Revenue</p>
        </div>
      </div>
      {row.notes && <p className="text-xs text-muted-foreground border-t pt-2 line-clamp-3">{row.notes}</p>}
    </div>
  );
}