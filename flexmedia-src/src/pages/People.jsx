import { useState, useMemo, useEffect, useCallback } from 'react';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { api } from '@/api/supabaseClient';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Plus, Search, Mail, Phone, Building2, ExternalLink, List, LayoutGrid, Tag, Clock, AlertTriangle, MailX, Zap, Users, Activity, Download } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { differenceInDays } from 'date-fns';
import { toast } from 'sonner';
import AgentForm from '@/components/clients/AgentForm';
import EntityDataTable from '@/components/common/EntityDataTable';
import SmartFilterBar from '@/components/common/SmartFilterBar';
import BulkActionBar from '@/components/common/BulkActionBar';
import ContactActivityPanel from '@/components/clients/ContactActivityPanel';
import { cn } from '@/lib/utils';
import { useEntityAccess } from '@/components/auth/useEntityAccess';

const STATE_STYLES = {
  'Active':         'bg-green-50 text-green-700 border-green-200',
  'Prospecting':    'bg-orange-50 text-orange-700 border-orange-200',
  'Dormant':        'bg-muted text-muted-foreground border-border',
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
  'Lost': 'bg-muted text-muted-foreground',
};

function fmtRevenue(n) {
  if (!n) return '$0';
  if (n >= 1000000) return `$${(n/1000000).toFixed(1)}m`;
  if (n >= 1000) return `$${(n/1000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function daysSinceLabel(dateStr) {
  if (!dateStr) return { text: 'Never', color: 'text-muted-foreground/40' };
  const days = differenceInDays(new Date(), new Date(dateStr));
  if (days < 0) return { text: 'Today', color: 'text-green-600' };
  if (days === 0) return { text: 'Today', color: 'text-green-600' };
  if (days < 7) return { text: `${days}d ago`, color: 'text-green-600' };
  if (days < 30) return { text: `${days}d ago`, color: 'text-yellow-600' };
  if (days < 60) return { text: `${days}d ago`, color: 'text-orange-500' };
  return { text: `${days}d ago`, color: 'text-red-500' };
}

export default function People() {
  const { canEdit, canView } = useEntityAccess('agents');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [view, setView] = useState('table');
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const CARD_PAGE_SIZE = 60;
  const [cardLimit, setCardLimit] = useState(CARD_PAGE_SIZE);

  // Smart filter state
  const [activeFilters, setActiveFilters] = useState(new Set());
  const [tagFilter, setTagFilter] = useState(null);
  const [orgFilter, setOrgFilter] = useState(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // Activity panel
  const [activityAgent, setActivityAgent] = useState(null);

  // Open new contact form when ?new=true is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === 'true') {
      setShowForm(true);
      params.delete('new');
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  const { data: agents = [], loading } = useEntityList('Agent', 'name');
  const { data: projects = [] } = useEntityList('Project', '-created_date', 5000);
  const { data: agencies = [] } = useEntityList('Agency', 'name');

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

  // Smart filter counts
  const filterCounts = useMemo(() => ({
    idle: agents.filter(a => { const lc = a.last_contacted_at; if (!lc) return true; return differenceInDays(new Date(), new Date(lc)) > 30; }).length,
    at_risk: agents.filter(a => a.is_at_risk === true).length,
    active: agents.filter(a => a.relationship_state === 'Active').length,
    prospecting: agents.filter(a => a.relationship_state === 'Prospecting').length,
    no_email: agents.filter(a => !a.email).length,
  }), [agents]);

  // Unique tags
  const allTags = useMemo(() => {
    const s = new Set();
    agents.forEach(a => { if (Array.isArray(a.tags)) a.tags.forEach(t => s.add(t)); });
    return Array.from(s).sort();
  }, [agents]);

  // ─── Filtering pipeline ───
  // Stage 1: search
  const searchFiltered = useMemo(() => {
    if (!search) return agents;
    const q = search.toLowerCase();
    return agents.filter(a =>
      a?.name?.toLowerCase().includes(q) ||
      a?.email?.toLowerCase().includes(q) ||
      a?.current_agency_name?.toLowerCase().includes(q) ||
      a?.current_team_name?.toLowerCase().includes(q) ||
      (Array.isArray(a?.tags) && a.tags.some(t => t.toLowerCase().includes(q))) ||
      a?.notes?.toLowerCase().includes(q)
    );
  }, [agents, search]);

  // BUG FIX #8: Clear selection when search/filters change so phantom IDs
  // from a previous filter set don't linger invisibly in the selection.
  useEffect(() => { setSelectedIds(new Set()); }, [search, activeFilters, tagFilter, orgFilter]);

  // Stage 2: smart filters + tag/org dropdowns
  // State filters (active, prospecting) are OR'd together since they are mutually exclusive.
  // Behavioral filters (idle, at_risk, no_email) are AND'd as independent conditions.
  const filtered = useMemo(() => {
    let result = searchFiltered;
    if (activeFilters.has("idle")) result = result.filter(a => { const lc = a.last_contacted_at; return !lc || differenceInDays(new Date(), new Date(lc)) > 30; });
    if (activeFilters.has("at_risk")) result = result.filter(a => a.is_at_risk === true);
    if (activeFilters.has("no_email")) result = result.filter(a => !a.email);
    // OR together mutually exclusive state filters
    const stateFilters = ["active", "prospecting"].filter(f => activeFilters.has(f));
    if (stateFilters.length > 0) {
      const stateMap = { active: "Active", prospecting: "Prospecting" };
      const allowedStates = new Set(stateFilters.map(f => stateMap[f]));
      result = result.filter(a => allowedStates.has(a.relationship_state));
    }
    if (tagFilter) result = result.filter(a => Array.isArray(a.tags) && a.tags.includes(tagFilter));
    if (orgFilter) result = result.filter(a => a.current_agency_id === orgFilter);
    return result;
  }, [searchFiltered, activeFilters, tagFilter, orgFilter]);

  // ─── Selection handlers ───
  const toggleSelect = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSelectAll = () => setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(a => a.id)));
  // Page-aware select: toggle only the visible page's IDs
  const selectPage = (pageIds) => {
    setSelectedIds(prev => {
      const allSelected = pageIds.every(id => prev.has(id));
      if (allSelected) return new Set();  // deselect all
      return new Set(pageIds);
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkStateChange = async (newState) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      await Promise.all(Array.from(selectedIds).map(id => api.entities.Agent.update(id, { relationship_state: newState })));
      refetchEntityList("Agent");
      toast.success(`Updated ${selectedIds.size} contact${selectedIds.size > 1 ? 's' : ''} to ${newState}`);
    } catch {
      toast.error('Some updates failed');
    } finally {
      setBulkLoading(false);
      clearSelection();
    }
  };

  const columns = [
    {
      key: 'name', label: 'Person', sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <HoverCard openDelay={300} closeDelay={100}>
            <HoverCardTrigger asChild>
              <span className="font-medium text-sm text-foreground hover:text-primary cursor-pointer transition-colors">{row.name}</span>
            </HoverCardTrigger>
            <HoverCardContent side="right" className="w-72 p-4" onClick={e => e.stopPropagation()}>
              <AgentHoverContent row={row} projects={projectsByAgent[row.id] || []} revenue={revenueByAgent[row.id] || 0} />
            </HoverCardContent>
          </HoverCard>
          {row.needs_review && (
            <span title="Needs review — data integrity issues" className="shrink-0">
              <AlertTriangle className="h-3 w-3 text-amber-500" />
            </span>
          )}
        </div>
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
      key: 'last_contacted_at', label: 'Last Activity', sortable: true, width: '100px',
      render: (row) => {
        const { text, color } = daysSinceLabel(row.last_contacted_at);
        return <span className={cn("text-xs font-medium tabular-nums", color)}>{text}</span>;
      },
    },
    {
      key: 'email', label: 'Email', sortable: true,
      render: (row) => row.email
        ? <a href={`mailto:${row.email}`} className="text-xs text-primary hover:underline truncate max-w-[160px] block" onClick={e => e.stopPropagation()} title={row.email}>{row.email}</a>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: 'phone', label: 'Phone', width: '120px',
      render: (row) => row.phone
        ? <a href={`tel:${row.phone}`} className="text-xs tabular-nums hover:text-primary" onClick={e => e.stopPropagation()}>{row.phone}</a>
        : <span className="text-muted-foreground/30 text-xs">—</span>,
    },
    {
      key: '_actions', label: '', width: '110px', noClick: true, align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!canEdit} onClick={e => { e.stopPropagation(); setEditingAgent(row); setShowForm(true); }}>Edit</Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); setActivityAgent(row); }} aria-label="Activity panel" title="Activity panel">
            <Activity className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => { e.stopPropagation(); navigate(createPageUrl('PersonDetails') + '?id=' + row.id); }} aria-label="View person details">
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
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            People
          </h1>
          <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <span className="font-semibold text-foreground">{stats.total}</span> total ·
            <span className="text-green-600 font-medium ml-1">{stats.active}</span> active ·
            <span className="text-orange-500 font-medium ml-1">{stats.prospecting}</span> prospecting ·
            <span className="text-muted-foreground font-medium ml-1">{stats.dormant}</span> dormant
            {stats.dnc > 0 && <><span className="text-red-500 font-medium ml-1">{stats.dnc}</span> DNC</>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-8"
            title="Export filtered contacts as CSV"
            onClick={() => {
              const headers = ['Name','Email','Phone','Organisation','Team','State','Tags'];
              const rows = filtered.map(a => [
                a.name || '', a.email || '', a.phone || '',
                a.current_agency_name || '', a.current_team_name || '',
                a.relationship_state || '',
                (Array.isArray(a.tags) ? a.tags.join('; ') : ''),
              ]);
              const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = Object.assign(document.createElement('a'), { href: url, download: `contacts-${new Date().toISOString().slice(0,10)}.csv` });
              a.click();
              URL.revokeObjectURL(url);
              toast.success(`Exported ${filtered.length} contacts`);
            }}
          >
            <Download className="h-3.5 w-3.5" />Export CSV
          </Button>
          {canView && !canEdit && <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">View only</Badge>}
          <Button onClick={() => { setEditingAgent(null); setShowForm(true); }} size="sm" className="gap-1.5 h-8" disabled={!canEdit} title="Add a new contact">
            <Plus className="h-3.5 w-3.5" />Add Person
          </Button>
        </div>
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
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {filtered.length !== agents.length
            ? `Showing ${filtered.length} of ${agents.length}`
            : `${filtered.length} contacts`}
        </span>
        <div className="flex items-center border rounded-md overflow-hidden">
          <button onClick={() => setView('table')} title="Table view" aria-label="Table view" className={cn("px-2 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none", view === 'table' ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
            <List className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setView('cards')} title="Card view" aria-label="Card view" className={cn("px-2 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none", view === 'cards' ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Smart filter bar */}
      <div className="px-6 py-2.5 border-b shrink-0 bg-muted/10">
        <SmartFilterBar
          quickFilters={[
            { id: 'idle', label: 'Idle 30+d', icon: Clock, count: filterCounts.idle },
            { id: 'at_risk', label: 'At Risk', icon: AlertTriangle, count: filterCounts.at_risk },
            { id: 'active', label: 'Active', icon: Zap, count: filterCounts.active },
            { id: 'prospecting', label: 'Prospecting', icon: Users, count: filterCounts.prospecting },
            { id: 'no_email', label: 'No Email', icon: MailX, count: filterCounts.no_email },
          ]}
          activeFilters={activeFilters}
          onToggleFilter={(id) => setActiveFilters(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
          dropdownFilters={[
            { id: 'tag', label: 'Tag', icon: Tag, options: allTags.map(t => ({ value: t, label: t })), value: tagFilter, onChange: setTagFilter },
            { id: 'org', label: 'Organisation', icon: Building2, options: agencies.map(a => ({ value: a.id, label: a.name })), value: orgFilter, onChange: setOrgFilter },
          ]}
          onClearAll={() => { setActiveFilters(new Set()); setTagFilter(null); setOrgFilter(null); }}
          totalCount={agents.length}
          filteredCount={filtered.length}
        />
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Bulk action bar */}
        <BulkActionBar
          selectedCount={selectedIds.size}
          actions={[{ label: 'Set State', options: ['Active', 'Prospecting', 'Dormant', 'Do Not Contact'], onAction: handleBulkStateChange }]}
          onClear={clearSelection}
          loading={bulkLoading}
        />

        {view === 'table' ? (
          <EntityDataTable
            columns={columns}
            data={filtered}
            loading={loading}
            selectable
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onSelectPage={selectPage}
            onRowClick={row => navigate(createPageUrl('PersonDetails') + '?id=' + row.id)}
            emptyMessage={search ? 'No people match your search. Try a different term.' : 'No people added yet. Add your first contact to get started.'}
            pageSize={100}
          />
        ) : (
          <>
            {loading && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array(8).fill(0).map((_, i) => (
                  <div key={i} className="bg-card border rounded-xl p-4 space-y-3 animate-pulse">
                    <div className="space-y-2">
                      <div className="h-4 w-28 bg-muted rounded" />
                      <div className="h-3 w-20 bg-muted rounded" />
                      <div className="h-5 w-16 bg-muted rounded-full" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2"><div className="h-3 w-3 bg-muted rounded" /><div className="h-3 w-36 bg-muted rounded" /></div>
                      <div className="flex items-center gap-2"><div className="h-3 w-3 bg-muted rounded" /><div className="h-3 w-24 bg-muted rounded" /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {[0,1].map(j => <div key={j} className="rounded bg-muted/60 p-2 text-center space-y-1"><div className="h-5 w-8 bg-muted rounded mx-auto" /><div className="h-2 w-10 bg-muted rounded mx-auto" /></div>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
               <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
               <p className="font-medium text-base">{search ? `No results for "${search}"` : 'No people yet'}</p>
               <p className="text-xs mt-1 text-muted-foreground/70">
                 {search ? 'Try a different search term' : 'Add your first contact to get started'}
               </p>
               {search ? (
                 <Button variant="outline" size="sm" onClick={() => setSearch('')} className="mt-3">
                   Clear search
                 </Button>
               ) : (
                 <Button size="sm" onClick={() => { setEditingAgent(null); setShowForm(true); }} className="mt-3" disabled={!canEdit}>
                   <Plus className="h-3.5 w-3.5 mr-1.5" />Add Person
                 </Button>
               )}
              </div>
            )}
            {!loading && filtered.length > 0 && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filtered.slice(0, cardLimit).map(row => (
                    <div key={row.id} className="bg-card border rounded-xl p-4 shadow-sm hover:shadow-lg hover:border-primary/30 hover:-translate-y-0.5 transition-all duration-200 cursor-pointer"
                      onClick={() => navigate(createPageUrl('PersonDetails') + '?id=' + row.id)}>
                      <AgentHoverContent row={row} projects={projectsByAgent[row.id] || []} revenue={revenueByAgent[row.id] || 0} />
                      <div className="flex gap-2 mt-3 pt-3 border-t" onClick={e => e.stopPropagation()}>
                        <Button variant="outline" size="sm" className="flex-1 h-7 text-xs" disabled={!canEdit} onClick={() => { setEditingAgent(row); setShowForm(true); }}>Edit</Button>
                        <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => navigate(createPageUrl('PersonDetails') + '?id=' + row.id)}>View</Button>
                      </div>
                    </div>
                  ))}
                </div>
                {filtered.length > cardLimit && (
                  <div className="flex justify-center pt-4">
                    <Button variant="outline" size="sm" onClick={() => setCardLimit(prev => prev + CARD_PAGE_SIZE)}>
                      Load more ({filtered.length - cardLimit} remaining)
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <AgentForm agent={editingAgent} open={showForm} onClose={() => { setShowForm(false); setEditingAgent(null); }} />

      {activityAgent && (
        <ContactActivityPanel agent={activityAgent} onClose={() => setActivityAgent(null)} />
      )}
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
          <p className="text-lg font-bold tabular-nums">{projects.length}</p>
          <p className="text-[10px] text-muted-foreground">Projects</p>
        </div>
        <div className="rounded bg-muted/60 p-2 text-center">
          <p className="text-lg font-bold tabular-nums">{fmtRevenue(revenue)}</p>
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
