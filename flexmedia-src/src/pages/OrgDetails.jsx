import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSmartEntityData } from "@/components/hooks/useSmartEntityData";
import { useEntityList } from "@/components/hooks/useEntityData";
import { ArrowLeft, AlertCircle, Plus, MessageSquare, Mail, Paperclip, DollarSign, Calendar, Network, Palette, Loader2 } from "lucide-react";
import BrandingPreferencesModule from "@/components/agencies/BrandingPreferencesModule";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import Org2LeftPanel from "@/components/org2/Org2LeftPanel";
import Org2Dashboard from "@/components/org2/Org2Dashboard";
import Org2Hierarchy from "@/components/org2/Org2Hierarchy";
import UnifiedNotesPanel from "@/components/notes/UnifiedNotesPanel";
import PriceMatrixSummaryTable from "@/components/priceMatrix/PriceMatrixSummaryTable";
import EntityEmailTab from "@/components/email/EntityEmailTab";
import EntityActivitiesTab from "@/components/calendar/EntityActivitiesTab";
import ContactActivityLog from "@/components/contacts/ContactActivityLog";
import ContactFiles from "@/components/contacts/ContactFiles";
import { fixTimestamp } from "@/components/utils/dateUtils";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import { usePriceGate } from '@/components/auth/RoleGate';

const STATE_BADGE = {
  Active:           "bg-green-100 text-green-800 border-green-200",
  Prospecting:      "bg-blue-100 text-blue-800 border-blue-200",
  Dormant:          "bg-amber-100 text-amber-800 border-amber-200",
  "Do Not Contact": "bg-red-100 text-red-800 border-red-200",
};

// ── Tab definitions (Pipedrive-style, matching PersonDetails) ─────────────
const TABS = [
  { id: 'notes', label: 'Notes', icon: MessageSquare },
  { id: 'emails', label: 'Email', icon: Mail },
  { id: 'files', label: 'Files', icon: Paperclip },
  { id: 'pricing', label: 'Pricing', icon: DollarSign },
  { id: 'calendar', label: 'Activities', icon: Calendar },
  { id: 'hierarchy', label: 'Hierarchy', icon: Network },
  { id: 'branding', label: 'Branding', icon: Palette },
];

function ErrorState({ navigate, title, message }) {
  return (
    <div className="p-8">
      <Button variant="ghost" className="gap-2 mb-4" onClick={() => window.history.length > 1 ? navigate(-1) : navigate(createPageUrl('Organisations'))}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Button>
      <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl p-6 flex gap-3">
        <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div>
          <h3 className="font-semibold text-red-900 dark:text-red-200">{title}</h3>
          <p className="text-red-800 dark:text-red-300 text-sm mt-1">{message}</p>
        </div>
      </div>
    </div>
  );
}

export default function OrgDetails() {
  const { canEdit, canView } = useEntityAccess('agencies');
  const { visible: showPricing } = usePriceGate();
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(window.location.search);
  const agencyId = urlParams.get("id");
  const tabsRef = useRef(null);

  // Remember last selected tab
  const [activeTab, setActiveTab] = useState(() => {
    const saved = sessionStorage.getItem(`tab-org-${agencyId}`);
    // Map old tab values to consolidated ones
    if (saved === 'activity-log' || saved === 'interactions' || saved === 'audit') return 'notes';
    return saved || 'notes';
  });
  const handleTabChange = (tab) => {
    setActiveTab(tab);
    sessionStorage.setItem(`tab-org-${agencyId}`, tab);
  };
  const { data: agency, loading, error } = useSmartEntityData("Agency", agencyId);

  const agentFilter       = useCallback(e => e.current_agency_id === agencyId, [agencyId]);
  const teamFilter        = useCallback(e => e.agency_id === agencyId, [agencyId]);
  const projectFilter     = useCallback(e => e.agency_id === agencyId, [agencyId]);
  const interactionFilter = useCallback(e => e.entity_type === "Agency" && e.entity_id === agencyId, [agencyId]);
  const noteFilter        = useCallback(e => e.agency_id === agencyId, [agencyId]);

  const { data: agents = [], loading: agentsLoading }  = useEntityList("Agent",          "name",          null, agentFilter);
  const { data: teams = [], loading: teamsLoading }    = useEntityList("Team",           "name",          null, teamFilter);
  const { data: projects = [] }     = useEntityList("Project",        "-created_date", 500,  projectFilter);
  const { data: interactions = [] } = useEntityList("InteractionLog", "-date_time",    null, interactionFilter);
  const { data: orgNotes = [] }     = useEntityList("OrgNote",        "-created_date", null, noteFilter);

  const revisionFilter = useCallback(p => {
    const projIds = new Set(projects.map(pr => pr.id));
    return projIds.has(p.project_id);
  }, [projects]);

  const projectNoteFilter = useCallback(e => {
    const relatedProjectIds = projects.map(p => p.id);
    return relatedProjectIds.includes(e.project_id);
  }, [projects]);

  const { data: revisions = [] }    = useEntityList("ProjectRevision", "-created_date", 200, projects.length > 0 ? revisionFilter : null);
  const { data: projectNotes = [] } = useEntityList("ProjectNote",    "-created_date", 200, projects.length > 0 ? projectNoteFilter : null);

  const taskFilter = useCallback(t => {
    const projIds = new Set(projects.map(pr => pr.id));
    return projIds.has(t.project_id);
  }, [projects]);

  const { data: projectTasks = [] } = useEntityList("ProjectTask", "-created_date", null, projects.length > 0 ? taskFilter : null);

  const timeLogFilter = useCallback(t => {
    const projIds = new Set(projects.map(pr => pr.id));
    return projIds.has(t.project_id);
  }, [projects]);

  const { data: taskTimeLogs = [] } = useEntityList("TaskTimeLog", "-created_date", null, projects.length > 0 ? timeLogFilter : null);

  // Pricing data (moved from Org2UnifiedTabs)
  const priceMatrixFilter = useCallback(
    e => e.entity_type === 'agency' && e.entity_id === agencyId,
    [agencyId]
  );
  const { data: priceMatrix = [] } = useEntityList('PriceMatrix', '-updated_date', null, priceMatrixFilter);
  const [pricingRequested, setPricingRequested] = useState(activeTab === 'pricing');
  useEffect(() => { if (activeTab === 'pricing') setPricingRequested(true); }, [activeTab]);
  const { data: products = [], loading: productsLoading } = useEntityList(pricingRequested ? 'Product' : null, null, 200);
  const { data: packages = [], loading: packagesLoading } = useEntityList(pricingRequested ? 'Package' : null, null, 200);
  const pricingLoading = productsLoading || packagesLoading;

  // Only count root notes (not replies) for the badge
  const rootNoteCount = useMemo(() => orgNotes?.filter(n => !n.parent_note_id).length || 0, [orgNotes]);

  // Org-level stats
  const totalOrgRev = useMemo(() => {
    const won = projects.filter(p => p.outcome === 'won');
    return won.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
  }, [projects]);

  const avgOrgBookingValue = useMemo(() => {
    const won = projects.filter(p => p.outcome === 'won');
    if (won.length === 0) return null;
    return Math.round(totalOrgRev / won.length);
  }, [projects, totalOrgRev]);

  const activeAgents  = useMemo(() => agents.filter(a => a.relationship_state === 'Active'), [agents]);
  const dormantAgents = useMemo(() => agents.filter(a => a.relationship_state === 'Dormant'), [agents]);
  const atRiskAgents  = useMemo(() => agents.filter(a => a.is_at_risk === true), [agents]);

  const revenueByAgent = useMemo(() => {
    return agents.map(agent => {
      const agentProjects = projects.filter(p => p.agent_id === agent.id && p.outcome === 'won');
      const rev = agentProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
      return { agent, rev, count: agentProjects.length };
    })
    .filter(r => r.rev > 0)
    .sort((a, b) => b.rev - a.rev);
  }, [agents, projects]);

  // Email activity tracking for Activity tab integration
  const [emailActivities, setEmailActivities] = useState([]);
  
  const handleEmailActivity = useCallback((action, data) => {
    setEmailActivities(prev => [
      {
        action,
        data,
        timestamp: new Date().toISOString(),
      },
      ...prev,
    ].slice(0, 50)); // Keep last 50 email activities
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector('[placeholder*="Search"]');
        if (searchInput) searchInput.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!agencyId) {
    navigate(createPageUrl("Organisations"));
    return null;
  }

  if (loading) {
    return (
      <div className="flex flex-col h-[calc(100vh-4rem)] lg:h-screen overflow-hidden bg-background">
        {/* Header skeleton */}
        <div className="flex items-center gap-3 px-5 py-3 border-b bg-card shrink-0 shadow-sm">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="w-px h-5 bg-border" />
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-5 w-48 rounded bg-muted animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-muted animate-pulse" />
        </div>
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Sidebar skeleton */}
          <div className="w-96 shrink-0 border-r bg-card p-4 space-y-4">
            {[1,2,3,4].map(i => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
          </div>
          {/* Main area skeleton with fade-in */}
          <div className="flex-1 p-6 space-y-4 animate-in fade-in duration-300">
            <div className="h-8 w-64 rounded bg-muted animate-pulse" />
            <div className="grid grid-cols-3 gap-4">
              {[1,2,3].map(i => <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />)}
            </div>
            <div className="h-48 rounded-xl bg-muted animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !agency) {
    return (
      <ErrorState
        navigate={navigate}
        title="Organisation Not Found"
        message="This organisation may have been deleted or you don't have access."
      />
    );
  }

  return (
    <ErrorBoundary>
    <div className="flex flex-col h-[calc(100vh-4rem)] lg:h-screen overflow-hidden bg-background">
      {/* ── Top header ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0 shadow-sm z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => window.history.length > 1 ? navigate(-1) : navigate(createPageUrl('Organisations'))}
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Initials avatar */}
        <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
          <span className="text-sm font-bold text-primary-foreground leading-none">
            {(agency.name || '?').split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase()}
          </span>
        </div>

        <div className="min-w-0">
          <h1 className="text-sm font-bold truncate leading-tight">{agency.name}</h1>
          {agency.address && <p className="text-[11px] text-muted-foreground truncate leading-tight">{agency.address}</p>}
        </div>

        <Badge className={`text-[11px] shrink-0 border font-medium px-2 py-0.5 ${STATE_BADGE[agency.relationship_state] || 'bg-muted text-muted-foreground'}`}>
          {agency.relationship_state || 'Unknown'}
        </Badge>
        {canView && !canEdit && <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">View only</Badge>}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* Stat pills */}
          <div className="flex items-center gap-1.5 px-1">
            <span className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-[11px] font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:bg-muted/80">
              <span className="font-bold text-foreground">{agents.length}</span> people
            </span>
            <button
              onClick={() => navigate(createPageUrl('Projects') + `?agency=${agencyId}`)}
              className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-[11px] font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:bg-primary/10 hover:text-primary cursor-pointer"
              title="View all projects for this organisation"
            >
              <span className="font-bold text-foreground">{projects.length}</span> projects
            </button>
            {showPricing && projects.length > 0 && (() => {
              // Only count Won + Paid revenue (not open/lost)
              const wonProjects = projects.filter(p => p.outcome === 'won');
              const rev = wonProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
              return rev > 0 ? (
                <span className="inline-flex items-center gap-1 bg-green-50 text-green-700 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-green-100" title="Revenue from Won projects">
                  ${rev >= 1000000 ? `${(rev/1000000).toFixed(1)}M` : rev >= 1000 ? `${(rev/1000).toFixed(0)}k` : Math.round(rev)}
                </span>
              ) : null;
            })()}
          </div>
          {/* Last activity */}
          {(() => {
            const recentActivity = [...projects, ...interactions, ...orgNotes, ...projectNotes].reduce((latest, item) => {
              const raw = item.created_date || item.last_status_change || item.interaction_date || item.date_time;
              const date = raw ? new Date(fixTimestamp(raw)) : new Date(0);
              return date > latest ? date : latest;
            }, new Date(0));
            if (recentActivity.getTime() === 0) return null;
            const now = new Date();
            const hoursAgo = Math.floor((now - recentActivity) / (1000 * 60 * 60));
            const daysAgo = Math.floor(hoursAgo / 24);
            let timeStr = 'just now';
            if (hoursAgo > 0) timeStr = `${hoursAgo}h ago`;
            if (daysAgo > 0) timeStr = `${daysAgo}d ago`;
            return (
              <span className="text-[11px] text-muted-foreground hidden sm:inline cursor-help" title={`Last activity: ${recentActivity.toLocaleString()}`}>
                · {timeStr}
              </span>
            );
          })()}
        </div>
      </div>

      {/* ── Two-pane layout ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left sidebar */}
        <div className="w-96 shrink-0 border-r overflow-y-auto bg-card">
          <div className="space-y-0">
            {/* Quick Actions */}
            <div className="flex gap-2 p-3 border-b">
              <Button
                size="sm"
                className="flex-1 gap-1.5 h-8 text-xs font-semibold shadow-sm transition-all duration-200 hover:shadow-md active:scale-95"
                title="Create new project (Cmd+Shift+P)"
                onClick={() => navigate(createPageUrl("Projects") + `?agency=${agencyId}`)}>
                <Plus className="h-3.5 w-3.5" />
                New Project
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 gap-1.5 h-8 text-xs transition-all duration-200 hover:bg-muted active:scale-95"
                title="Add a note (Cmd+Shift+N)"
                onClick={() => {
                  setActiveTab('notes');
                  // Give tab time to mount before scrolling the composer into view
                  setTimeout(() => {
                    const textarea = document.querySelector('[data-note-textarea]');
                    if (textarea) { textarea.scrollIntoView({ behavior: 'smooth', block: 'center' }); textarea.focus(); }
                  }, 150);
                }}>
                <MessageSquare className="h-3.5 w-3.5" />
                Add Note
              </Button>
            </div>
            <Org2LeftPanel
              agency={agency}
              agents={agents}
              teams={teams}
              projects={projects}
              totalOrgRev={showPricing ? totalOrgRev : null}
              avgOrgBookingValue={showPricing ? avgOrgBookingValue : null}
              activeAgents={activeAgents}
              dormantAgents={dormantAgents}
              atRiskAgents={atRiskAgents}
              revenueByAgent={showPricing ? revenueByAgent : []}
            />
            <div className="border-t pt-2">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-4 py-2">Analytics</div>
              <Org2Dashboard
                agency={agency}
                agents={agents}
                teams={teams}
                projects={projects}
                revisions={revisions}
                projectTasks={projectTasks}
                taskTimeLogs={taskTimeLogs}
              />
            </div>
          </div>
        </div>

        {/* ── Right main area ──────────────────────────────────────── */}
        <div ref={tabsRef} className="flex-1 overflow-hidden bg-background flex flex-col">
          {/* Pipedrive-style tab bar */}
          <div className="flex items-center gap-0 border-b px-4 shrink-0">
            {TABS.filter(tab => tab.id !== 'pricing' || showPricing).map(tab => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                  activeTab === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
                {tab.id === 'notes' && rootNoteCount > 0 && (
                  <span className="bg-primary/10 text-primary text-[10px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1">
                    {rootNoteCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {/* ── Notes tab: unified feed with history sub-filters ── */}
            {activeTab === 'notes' && (
              <div className="h-full flex flex-col overflow-hidden">
                {/* Notes composer at top */}
                <div className="border-b shrink-0">
                  <UnifiedNotesPanel
                    agencyId={agencyId}
                    contextLabel={agency?.name || ''}
                    contextType="agency"
                    relatedProjectIds={projects.map(p => p.id)}
                    relatedAgentIds={agents.map(a => a.id)}
                    showContextOnNotes={true}
                  />
                </div>

                {/* History — unified activity feed with built-in filters */}
                <div className="flex-1 overflow-y-auto">
                  <ContactActivityLog
                    entityType="agency"
                    entityId={agencyId}
                    entityLabel={agency?.name}
                    emailActivities={emailActivities}
                    showChangelog
                  />
                </div>
              </div>
            )}

            {/* ── Email tab ──────────────────────────────────────── */}
            {activeTab === 'emails' && (
              <div className="h-full overflow-hidden">
                <EntityEmailTab
                  entityType="agency"
                  entityId={agencyId}
                  entityLabel={agency?.name}
                  onEmailActivity={handleEmailActivity}
                  orgAgentIds={agents.map(a => a.id)}
                />
              </div>
            )}

            {/* ── Files tab ──────────────────────────────────────── */}
            {activeTab === 'files' && (
              <div className="h-full overflow-hidden">
                <ContactFiles
                  entityType="agency"
                  entityId={agencyId}
                  entityLabel={agency?.name}
                />
              </div>
            )}

            {/* ── Pricing tab ────────────────────────────────────── */}
            {activeTab === 'pricing' && showPricing && (
              <div className="h-full overflow-y-auto p-4">
                {!pricingRequested || pricingLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : priceMatrix.length === 0 ? (
                  <Card className="bg-muted/30 border-dashed">
                    <CardContent className="pt-6 pb-6 text-center">
                      <p className="text-muted-foreground text-sm">No pricing configured for this organisation</p>
                      <p className="text-xs text-muted-foreground mt-1">Set up pricing in Settings &rarr; Price Matrix</p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-6">
                    {priceMatrix.map(matrix => (
                      <Card key={matrix.id} className="border shadow-sm">
                        <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center justify-between">
                          <div>
                            <p className="text-xs font-semibold text-foreground">{matrix.project_type_name || 'Project Type'}</p>
                            {matrix.use_default_pricing && (
                              <p className="text-[10px] text-muted-foreground">Using default pricing</p>
                            )}
                          </div>
                        </div>
                        <CardContent className="p-0">
                          <PriceMatrixSummaryTable
                            priceMatrix={matrix}
                            products={products}
                            packages={packages}
                          />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Activities/Calendar tab ─────────────────────────── */}
            {activeTab === 'calendar' && (
              <div className="h-full overflow-hidden">
                <EntityActivitiesTab
                  entityType="agency"
                  entityId={agencyId}
                  entityLabel={agency?.name || 'Organisation'}
                />
              </div>
            )}

            {/* ── Hierarchy tab ──────────────────────────────────── */}
            {activeTab === 'hierarchy' && (
              <div className="h-full overflow-y-auto">
                {(agentsLoading || teamsLoading) ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <Org2Hierarchy
                    agency={agency}
                    teams={teams}
                    agents={agents}
                  />
                )}
              </div>
            )}

            {activeTab === 'branding' && (
              <div className="h-full overflow-y-auto p-6">
                <BrandingPreferencesModule agency={agency} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}