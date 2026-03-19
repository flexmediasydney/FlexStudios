import { useState, useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Plus, Search, Mail, Phone, Building2, ExternalLink, List, LayoutGrid } from 'lucide-react';
import { createPageUrl } from '@/utils';
import AgentForm from '@/components/clients/AgentForm';
import EntityDataTable from '@/components/common/EntityDataTable';
import { cn } from '@/lib/utils';

const STATE_STYLES = {
  'Active':         'bg-green-50 text-green-700 border-green-200',
  'Prospecting':    'bg-orange-50 text-orange-700 border-orange-200',
  'Dormant':        'bg-gray-100 text-gray-500 border-gray-200',
  'Do Not Contact': 'bg-red-50 text-red-700 border-red-200',
};

const STATUS_STYLES = {
  'New Lead': 'bg-blue-50 text-blue-600',
  'Researching': 'bg-indigo-50 text-indigo-600',
  'Attempted Contact': 'bg-amber-50 text-amber-600',
  'Discovery Call Scheduled': 'bg-purple-50 text-purple-600',
  'Proposal Sent': 'bg-cyan-50 text-cyan-600',
  'Nurturing': 'bg-teal-50 text-teal-600',
  'Qualified': 'bg-green-50 text-green-700',
  'Unqualified': 'bg-red-50 text-red-600',
  'Converted to Client': 'bg-emerald-50 text-emerald-700',
  'Lost': 'bg-gray-100 text-gray-500',
};

const FILTER_STATES = ['All', 'Active', 'Prospecting', 'Dormant', 'Do Not Contact'];

function fmtRevenue(n) {
  if (!n) return '$0';
  if (n >= 1000000) return `$${(n/1000000).toFixed(1)}m`;
  if (n >= 1000) return `$${(n/1000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

export default function People() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState('All');
  const [view, setView] = useState('table');
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);

  const { data: agents = [], loading } = useEntityList('Agent', 'name');
  const { data: projects = [] } = useEntityList('Project', null, 5000);

  const projectsByAgent = useMemo(() => {
    const m = {};
    projects.forEach(p => { if (p.agent_id) { if (!m[p.agent_id]) m[p.agent_id] = []; m[p.agent_id].push(p); } });
    return m;
  }, [projects]);

  const revenueByAgent = useMemo(() => {
    const m = {};
    projects.forEach(p => {
      if (p.agent_id) m[p.agent_id] = (m[p.agent_id] || 0) + (p.calculated_price || p.price || 0);
    });
    return m;
  }, [projects]);

  const stats = useMemo(() => ({
    total: agents.length,
    active: agents.filter(a => a.relationship_state === 'Active').length,
    prospecting: agents.filter(a => a.relationship_state === 'Prospecting').length,
    dormant: agents.filter(a => a.relationship_state === 'Dormant').length,
    dnc: agents.filter(a => a.relationship_state === 'Do Not Contact').length,
  }), [agents]);

  const filtered = useMemo(() => agents.filter(a => {
    const q = search.toLowerCase();
    const matchSearch = !search ||
      a?.name?.toLowerCase().includes(q) ||
      a?.email?.toLowerCase().includes(q) ||
      a?.current_agency_name?.toLowerCase().includes(q) ||
      a?.current_team_name?.toLowerCase().includes(q);
    const matchState = filterState === 'All' || a.relationship_state === filterState;
    return matchSearch && matchState;
  }), [agents, search, filterState]);

  const columns = [
    {
      key: 'name', label: 'Person', sortable: true,
      render: (row) => (
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span className="font-medium text-sm text-foreground hover:text-primary cursor-pointer transition-colors">{row.name}</span>
          </HoverCardTrigger>
          <HoverCardContent side="right" className="w-72 p-4" onClick={e => e.stopPropagation()}>
            <AgentHoverContent row={row} projects={projectsByAgent[row.id] || []} revenue={revenueByAgent[row.id] || 0} />
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
      key: 'current_agency_name', label: 'Organisation', sortable: true,
      render: (row) => row.current_agency_name
        ? <span className="text-xs text-muted-foreground">{row.current_agency_name}</span>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'current_team_name', label: 'Team', sortable: true, width: '130px',
      render: (row) => row.current_team_name
        ? <span className="text-xs text-muted-foreground">{row.current_team_name}</span>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'projects', label: 'Projects', sortable: true, width: '70px', align: 'center',
      sortValue: (row) => (projectsByAgent[row.id] || []).length,
      render: (row) => { const c = (projectsByAgent[row.id] || []).length; return <span className="tabular-nums text-xs font-medium">{c > 0 ? c : <span className="text-muted-foreground/30">0</span>}</span>; },
    },
    {
      key: 'revenue', label: 'Revenue', sortable: true, width: '90px', align: 'right',
      sortValue: (row) => revenueByAgent[row.id] || 0,
      render: (row) => {
        const r = revenueByAgent[row.id] || 0;
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
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={e => { e.stopPropagation(); setEditingAgent(row); setShowForm(true); }}>Edit</Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); navigate(createPageUrl('PersonDetails') + '?id=' + row.id); }}>
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
          <h1 className="text-lg font-semibold">People</h1>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{stats.total}</span> total ·
            <span className="text-green-600 font-medium ml-1">{stats.active}</span> active ·
            <span className="text-orange-500 font-medium ml-1">{stats.prospecting}</span> prospecting ·
            <span className="text-gray-400 font-medium ml-1">{stats.dormant}</span> dormant
            {stats.dnc > 0 && <><span className="text-red-500 font-medium ml-1">{stats.dnc}</span> DNC</>}
          </div>
        </div>
        <Button onClick={() => { setEditingAgent(null); setShowForm(true); }} size="sm" className="gap-1.5 h-8">
          <Plus className="h-3.5 w-3.5" />Add Person
        </Button>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0 bg-muted/20">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search people, org, team..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-7 text-xs pr-16" />
          {search && (
            <>
              <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 font-medium tabular-nums">{search.length}</span>
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded-full hover:bg-muted transition-colors" aria-label="Clear search" title="Clear search (Esc)">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </>
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
            onRowClick={row => navigate(createPageUrl('PersonDetails') + '?id=' + row.id)}
            emptyMessage={search ? 'No people match your search' : 'No people added yet'} pageSize={100} />
        ) : (
          <>
            {loading && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array(8).fill(0).map((_, i) => <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />)}
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
               <div className="relative inline-block">
                 <p className="text-5xl mb-3 opacity-20">👤</p>
                 <div className="absolute inset-0 blur-xl bg-primary/5 rounded-full" />
               </div>
               <p className="font-medium text-base">{search ? `No results for "${search}"` : 'No people found'}</p>
               {search && (
                 <Button variant="outline" size="sm" onClick={() => setSearch('')} className="mt-3">
                   Clear search
                 </Button>
               )}
              </div>
            )}
            {!loading && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filtered.map(row => (
                  <div key={row.id} className="bg-card border rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => navigate(createPageUrl('PersonDetails') + '?id=' + row.id)}>
                    <AgentHoverContent row={row} projects={projectsByAgent[row.id] || []} revenue={revenueByAgent[row.id] || 0} />
                    <div className="flex gap-2 mt-3 pt-3 border-t" onClick={e => e.stopPropagation()}>
                      <Button variant="outline" size="sm" className="flex-1 h-7 text-xs" onClick={() => { setEditingAgent(row); setShowForm(true); }}>Edit</Button>
                      <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => navigate(createPageUrl('PersonDetails') + '?id=' + row.id)}>View</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <AgentForm agent={editingAgent} open={showForm} onClose={() => { setShowForm(false); setEditingAgent(null); }} />
    </div>
  );
}

function AgentHoverContent({ row, projects, revenue }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-semibold text-sm">{row.name}</p>
        {row.title && <p className="text-xs text-muted-foreground">{row.title}</p>}
        <div className="flex flex-wrap gap-1 mt-1">
          {row.relationship_state && <Badge className={cn("text-[10px] px-1.5 py-0 border", STATE_STYLES[row.relationship_state] || 'bg-muted')}>{row.relationship_state}</Badge>}
          {row.status && row.relationship_state === 'Prospecting' && <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", STATUS_STYLES[row.status] || '')}>{row.status}</Badge>}
        </div>
      </div>
      {row.current_agency_name && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Building2 className="h-3 w-3 shrink-0" />
          {row.current_agency_name}{row.current_team_name ? ` · ${row.current_team_name}` : ''}
        </div>
      )}
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {row.email && <div className="flex items-center gap-2"><Mail className="h-3 w-3 shrink-0" />{row.email}</div>}
        {row.phone && <div className="flex items-center gap-2"><Phone className="h-3 w-3 shrink-0" />{row.phone}</div>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{projects.length}</p>
          <p className="text-[10px] text-muted-foreground">Projects</p>
        </div>
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold">{fmtRevenue(revenue)}</p>
          <p className="text-[10px] text-muted-foreground">Revenue</p>
        </div>
      </div>
      {row.media_needs?.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t pt-2">
          {row.media_needs.map(n => <span key={n} className="text-[10px] bg-muted rounded px-1.5 py-0.5">{n}</span>)}
        </div>
      )}
      {row.notes && <p className="text-xs text-muted-foreground border-t pt-2 line-clamp-2">{row.notes}</p>}
    </div>
  );
}