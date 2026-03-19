import { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bot, CheckCircle, AlertCircle, RefreshCw, Zap } from "lucide-react";
import { parseTS, toSydney, relativeTime } from "@/components/tonomo/tonomoUtils";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

function calcBookingHealth(project) {
  const checks = [];

  // Critical — blocks approval
  if (!project.property_address) checks.push({ label: 'No address', level: 'error' });
  if (!project.agent_id) checks.push({ label: 'No agent', level: 'error' });
  if (!project.project_type_id) checks.push({ label: 'No project type', level: 'error' });
  if ((!project.products || project.products.length === 0) &&
      (!project.packages || project.packages.length === 0)) {
    checks.push({ label: 'No products', level: 'error' });
  }
  if (!project.photographer_id && !project.onsite_staff_1_id) {
    checks.push({ label: 'No photographer', level: 'error' });
  }

  // Warnings — worth noting
  if (!project.pricing_tier) checks.push({ label: 'No pricing tier', level: 'warn' });
  if (!project.project_owner_id) checks.push({ label: 'No owner', level: 'warn' });
  if (project.mapping_confidence && project.mapping_confidence !== 'full') {
    checks.push({ label: `Mapping: ${project.mapping_confidence}`, level: 'warn' });
  }
  if (project.products_mapping_gaps) {
    try {
      const gaps = JSON.parse(project.products_mapping_gaps);
      if (gaps.length > 0) checks.push({ label: `${gaps.length} unmapped service(s)`, level: 'warn' });
    } catch {}
  }
  if (project.urgent_review) checks.push({ label: '< 24h to shoot', level: 'critical' });

  const errors = checks.filter(c => c.level === 'error' || c.level === 'critical').length;
  const warns = checks.filter(c => c.level === 'warn').length;

  let score, color, label;
  if (checks.length === 0) {
    score = 100; color = 'text-green-600'; label = 'Ready';
  } else if (errors > 0) {
    score = Math.max(10, 60 - errors * 15);
    color = 'text-red-600'; label = 'Needs attention';
  } else {
    score = Math.max(50, 90 - warns * 10);
    color = 'text-amber-600'; label = 'Review';
  }

  return { score, color, label, checks, errors, warns };
}

export default function TonomoIntegrationDashboard() {
  const { data: user } = useCurrentUser();
  const [tab, setTab] = useState("overview");
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const queryClient = useQueryClient();

  useEffect(() => {
    if (user && user.role !== "master_admin" && user.role !== "employee") {
      window.location.href = "/";
    }
  }, [user]);

  // ── Auto-processor: checks for pending items every 30s and processes them directly ──
  useEffect(() => {
    let mounted = true;
    const AUTO_PROCESS_INTERVAL = 30000; // 30 seconds
    
    const autoProcess = async () => {
      if (!mounted) return;
      try {
        const q = await base44.entities.TonomoProcessingQueue.list('-created_date', 20);
        const hasPending = q.some(item => item.status === 'pending' || item.status === 'failed');
        if (hasPending && mounted) {
          try {
            await base44.functions.invoke('processTonomoQueue', { triggered_by: 'auto' });
            queryClient.invalidateQueries();
          } catch (err) {
            console.warn('[AutoProcessor] Process failed:', err?.message);
          }
        }
      } catch (err) {
        console.warn('[AutoProcessor] Check failed:', err?.message);
      }
    };

    // Run on mount, then every 30 seconds
    autoProcess();
    const interval = setInterval(autoProcess, AUTO_PROCESS_INTERVAL);
    return () => { mounted = false; clearInterval(interval); };
  }, [queryClient]);

  const { data: pendingProjects = [] } = useQuery({
    queryKey: ['pendingReviewProjects'],
    queryFn: async () => {
      const all = await base44.entities.Project.list('-created_date', 200);
      return all.filter(p => p.source === 'tonomo' && p.status === 'pending_review')
        .sort((a, b) => {
          const ha = calcBookingHealth(a);
          const hb = calcBookingHealth(b);
          // Critical/urgent first, then errors, then warnings, then ready
          if (a.urgent_review !== b.urgent_review) return b.urgent_review ? 1 : -1;
          if (ha.errors !== hb.errors) return hb.errors - ha.errors;
          if (ha.warns !== hb.warns) return hb.warns - ha.warns;
          return 0;
        });
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    onError: () => toast.error('Failed to load pending bookings'),
  });

  const { data: auditLogs = [] } = useQuery({
    queryKey: ['tonomoRecentAudit'],
    queryFn: () => base44.entities.TonomoAuditLog.list('-processed_at', 20),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const { data: webhookLogs = [] } = useQuery({
    queryKey: ['webhookLogsToday'],
    queryFn: async () => {
      const sydneyToday = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      const logs = await base44.entities.TonomoWebhookLog.list('-received_at', 500);
      return logs.filter(l => {
        const d = parseTS(l.received_at);
        return d && d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === sydneyToday;
      });
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const { data: projectsCreatedToday = [] } = useQuery({
    queryKey: ['projectsCreatedToday'],
    queryFn: async () => {
      const sydneyToday = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      const projects = await base44.entities.Project.list('-created_date', 500);
      return projects.filter(p => {
        const d = parseTS(p.created_date);
        return p.source === 'tonomo' && d && d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === sydneyToday;
      });
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const { data: queue = [] } = useQuery({
    queryKey: ['tonomoQueue'],
    queryFn: () => base44.entities.TonomoProcessingQueue.list('-created_date', 200),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const { data: mappings = [] } = useQuery({
    queryKey: ['tonomoMappings'],
    queryFn: () => base44.entities.TonomoMappingTable.list('-last_seen_at', 500),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    onError: () => toast.error('Failed to load mappings'),
  });

  const deadLetters = useMemo(() => queue.filter(q => q.status === 'dead_letter'), [queue]);
  const mappingGaps = useMemo(() => mappings.filter(m => !m.is_confirmed).length, [mappings]);

  const stats = useMemo(() => ({
    gaps: mappingGaps,
    deadLetters: deadLetters.length,
    pending: pendingProjects.length,
  }), [mappingGaps, deadLetters.length, pendingProjects.length]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary/10">
              <Bot className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Bookings Engine</h1>
              <p className="text-sm text-muted-foreground">Tonomo integration health and mapping management</p>
            </div>
          </div>
        </div>
        <div className="text-right">
          <Button onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['pendingReviewProjects'] });
            queryClient.invalidateQueries({ queryKey: ['tonomoRecentAudit'] });
            queryClient.invalidateQueries({ queryKey: ['webhookLogsToday'] });
            queryClient.invalidateQueries({ queryKey: ['projectsCreatedToday'] });
            queryClient.invalidateQueries({ queryKey: ['tonomoQueue'] });
            queryClient.invalidateQueries({ queryKey: ['tonomoMappings'] });
            setLastRefresh(new Date());
          }} className="shadow-sm hover:shadow-md transition-all" title="Reload all integration data">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <p className="text-xs text-muted-foreground mt-1" title={lastRefresh.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}>
            Last: {relativeTime(lastRefresh)}
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
       <TabsList className="bg-muted/40">
         <TabsTrigger value="overview" className="data-[state=active]:shadow-sm">Overview</TabsTrigger>
         <TabsTrigger value="health" className="data-[state=active]:shadow-sm">Health</TabsTrigger>
         <TabsTrigger value="intelligence" className="data-[state=active]:shadow-sm">Intelligence</TabsTrigger>
         <TabsTrigger value="mappings" className="data-[state=active]:shadow-sm">
           Mappings
           {stats.gaps > 0 && <span className="ml-1.5 text-[10px] bg-amber-500 text-white px-1.5 py-0.5 rounded-full font-bold">{stats.gaps}</span>}
         </TabsTrigger>
         <TabsTrigger value="rulebook" className="data-[state=active]:shadow-sm">Rulebook</TabsTrigger>
       </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-6">
          <MissedSchedulingPanel />

          {/* Pending Review Queue */}
          <Card>
            <CardHeader>
              <CardTitle>Pending Review Queue ({pendingProjects.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingProjects.map(p => (
                <PendingReviewCard key={p.id} project={p} />
              ))}
              {pendingProjects.length === 0 && (
               <div className="text-center py-12">
                 <CheckCircle className="h-10 w-10 mx-auto mb-3 text-green-500/40" />
                 <p className="text-muted-foreground font-medium">No projects pending review</p>
                 <p className="text-xs text-muted-foreground/60 mt-1">All bookings have been processed</p>
               </div>
              )}
            </CardContent>
          </Card>

          {/* Today's Snapshot */}
          <div className="grid gap-4" style={{gridTemplateColumns: 'repeat(5, 1fr)'}}>
            <KPICard title="Webhooks Today" value={webhookLogs.length} />
            <KPICard title="Projects Created" value={projectsCreatedToday.length} />
            <KPICard title="Pending Review" value={pendingProjects.length} />
            <KPICard title="Dead Letter" value={deadLetters.length} color="text-red-600" />
            <KPICard title="Mapping Gaps" value={mappingGaps} color="text-amber-600" />
          </div>

          {/* Live Feed */}
          <Card>
            <CardHeader>
              <CardTitle>Live Integration Feed</CardTitle>
            </CardHeader>
            <CardContent>
              {auditLogs.length === 0 ? (
               <div className="py-12 text-center text-muted-foreground">
                 <div className="relative inline-block">
                   <Zap className="h-10 w-10 mx-auto mb-3 opacity-20" />
                   <div className="absolute inset-0 blur-xl bg-primary/5 rounded-full" />
                 </div>
                 <p className="text-sm font-medium">No recent activity</p>
                 <p className="text-xs mt-1 opacity-70">Integration events will appear here</p>
               </div>
              ) : (
              <div className="space-y-2">
                {auditLogs.map(log => (
                  <div key={log.id} className="flex items-center gap-3 text-sm py-2 border-b last:border-0">
                    <div className={`h-2 w-2 rounded-full ${
                      log.operation === 'created' ? 'bg-green-500' :
                      log.operation === 'failed' ? 'bg-red-500' : 'bg-blue-500'
                    }`} />
                    <Badge variant="outline">{log.entity_type}</Badge>
                    <span className="font-medium">{log.operation}</span>
                    <span className="flex-1 text-muted-foreground truncate">{log.notes}</span>
                    <span className="text-xs text-muted-foreground">{log.processed_at ? relativeTime(parseTS(log.processed_at)) : "—"}</span>
                  </div>
                ))}
              </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="health" className="space-y-4 mt-6">
          <CalendarLinkHealthPanel />
        </TabsContent>

        <TabsContent value="intelligence">
          <Card>
            <CardHeader>
              <CardTitle>Booking Intelligence</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">Intelligence dashboard coming soon</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mappings">
          <MappingsTab mappings={mappings} />
        </TabsContent>

        <TabsContent value="rulebook">
          <TonomoRulebook />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KPICard({ title, value, color = "text-primary" }) {
  return (
    <Card className="hover:shadow-lg transition-all hover:scale-105 cursor-default">
      <CardContent className="pt-6">
        <p className={`text-3xl font-bold ${color} tabular-nums`}>{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{title}</p>
      </CardContent>
    </Card>
  );
}

function PendingReviewCard({ project }) {
  const queryClient = useQueryClient();
  
  const approveMutation = useMutation({
    mutationFn: async () => {
      const reviewType = project.pending_review_type || 'new_booking';
      const newStatus =
        reviewType === 'cancellation' ? 'cancelled' :
        reviewType === 'restoration' || reviewType === 'reopened_after_delivery' ? (project.shoot_date ? 'scheduled' : 'to_be_scheduled') :
        reviewType === 'additional_appointment' ? (project.pre_revision_stage || (project.shoot_date ? 'scheduled' : 'to_be_scheduled')) :
        (project.shoot_date ? 'scheduled' : 'to_be_scheduled');
      
      await base44.entities.Project.update(project.id, {
        status: newStatus,
        pending_review_reason: null,
        pending_review_type: null,
        urgent_review: false,
        auto_approved: false
      });

      // Fire downstream automations (same as TonomoTab approve)
      if (newStatus !== 'cancelled') {
        // Role defaults + task generation + pricing recalc
        base44.functions.invoke('applyProjectRoleDefaults', {
          project_id: project.id,
        }).catch(err => console.warn('applyProjectRoleDefaults failed:', err?.message));

        // Stage tracking — notifications, timers, deadline recalc
        base44.functions.invoke('trackProjectStageChange', {
          projectId: project.id,
          old_data: { status: project.status },
          actor_id: null,
          actor_name: 'Booking Approval',
        }).catch(() => {});
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pendingReviewProjects'] }),
    onError: (err) => {
      console.error('Approval failed:', err);
      alert('Failed to approve project: ' + (err.message || 'Unknown error'));
    }
  });

  const photographers = useMemo(() => {
    try { return JSON.parse(project.tonomo_photographer_ids || '[]'); } catch { return []; }
  }, [project.tonomo_photographer_ids]);

  const services = useMemo(() => {
    try { return JSON.parse(project.tonomo_raw_services || '[]'); } catch { return []; }
  }, [project.tonomo_raw_services]);

  return (
    <Card 
      className={`border-l-4 transition-all hover:shadow-lg ${project.urgent_review ? 'border-l-red-500 animate-pulse' : 'border-l-amber-500'}`}
    >
      <CardContent className="pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-emerald-100 text-emerald-700">⚡ Tonomo</Badge>
              {project.urgent_review && <Badge className="bg-red-100 text-red-700">⚠️ URGENT</Badge>}
              {project.tonomo_order_status === 'cancelled' && <Badge className="bg-red-100 text-red-700">CANCELLATION</Badge>}
            </div>
            <Link to={createPageUrl("ProjectDetails") + `?id=${project.id}`} className="font-semibold hover:text-primary">
              {project.title}
            </Link>
            <p className="text-sm text-muted-foreground">{project.property_address}</p>
            <div className="mt-2 space-y-1 text-xs">
              <p>Photographer: {photographers[0]?.name || "Unassigned"}</p>
              <p>Agent: {project.agent_id ? "Linked" : "Not linked"}</p>
              {project.shoot_date && <p>Shoot: {new Date(project.shoot_date).toLocaleDateString()}</p>}
              <p>Services: {services.join(", ") || "None"}</p>
              {project.tonomo_invoice_amount && <p>Invoice: ${project.tonomo_invoice_amount}</p>}
              <p>
                Confidence: <Badge className={
                  project.mapping_confidence === 'full' ? 'bg-green-100 text-green-700' :
                  project.mapping_confidence === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                }>{project.mapping_confidence || 'unknown'}</Badge>
              </p>
              {project.pending_review_reason && (
                <p className="italic text-muted-foreground">{project.pending_review_reason}</p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Button size="sm" onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending} className="shadow-sm hover:shadow-md transition-shadow">
              <CheckCircle className="h-4 w-4 mr-2" />
              {approveMutation.isPending ? "Approving..." : "Approve →"}
            </Button>
            <Button size="sm" variant="outline">
              <AlertCircle className="h-4 w-4 mr-2" />
              Flag Issue
            </Button>
          </div>
          </div>

          {/* Health indicator */}
          {(() => {
          const health = calcBookingHealth(project);
          return (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
              {/* Score bar */}
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    health.errors > 0 ? 'bg-red-500' :
                    health.warns > 0 ? 'bg-amber-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${health.score}%` }}
                />
              </div>
              <span className={`text-[10px] font-medium ${health.color} flex-shrink-0`}>
                {health.label}
              </span>
              {/* Inline issue chips */}
              {health.checks.slice(0, 2).map((c, i) => (
                <span
                  key={i}
                  className={`text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 ${
                    c.level === 'critical' ? 'bg-red-100 text-red-700 border-red-200' :
                    c.level === 'error' ? 'bg-red-50 text-red-600 border-red-100' :
                    'bg-amber-50 text-amber-600 border-amber-100'
                  }`}
                >
                  {c.label}
                </span>
              ))}
              {health.checks.length > 2 && (
                <span className="text-[9px] text-muted-foreground flex-shrink-0">
                  +{health.checks.length - 2}
                </span>
              )}
            </div>
          );
          })()}
          </CardContent>
          </Card>
          );
          }

function MappingsTab({ mappings }) {
  const [typeFilter, setTypeFilter] = useState("all");
  const queryClient = useQueryClient();

  const stats = useMemo(() => {
    const confirmed = mappings.filter(m => m.is_confirmed).length;
    const autoSuggested = mappings.filter(m => m.auto_suggested && !m.is_confirmed).length;
    const unconfirmed = mappings.filter(m => !m.is_confirmed).length;
    const gaps = mappings.filter(m => !m.flexmedia_entity_id).length;
    return { total: mappings.length, confirmed, autoSuggested, unconfirmed, gaps };
  }, [mappings]);

  const byType = useMemo(() => {
    const types = {};
    mappings.forEach(m => {
      if (!types[m.mapping_type]) types[m.mapping_type] = { confirmed: 0, total: 0 };
      types[m.mapping_type].total++;
      if (m.is_confirmed) types[m.mapping_type].confirmed++;
    });
    return types;
  }, [mappings]);

  const filtered = useMemo(() => {
    if (typeFilter === "all") return mappings;
    return mappings.filter(m => m.mapping_type === typeFilter);
  }, [mappings, typeFilter]);

  const confirmMutation = useMutation({
    mutationFn: async (mappingId) => {
      return await base44.entities.TonomoMappingTable.update(mappingId, {
        is_confirmed: true,
        auto_suggested: false
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tonomoMappings'] })
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-4">
        <KPICard title="Total" value={stats.total} />
        <KPICard title="Confirmed" value={stats.confirmed} color="text-green-600" />
        <KPICard title="Auto-suggested" value={stats.autoSuggested} color="text-blue-600" />
        <KPICard title="Unconfirmed" value={stats.unconfirmed} color="text-amber-600" />
        <KPICard title="Gaps" value={stats.gaps} color="text-red-600" />
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button
          variant={typeFilter === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => setTypeFilter("all")}
          className="transition-all hover:shadow-sm"
        >
          All
        </Button>
        {Object.entries(byType).map(([type, data]) => (
          <Button
            key={type}
            variant={typeFilter === type ? "default" : "outline"}
            size="sm"
            onClick={() => setTypeFilter(type)}
            className="transition-all hover:shadow-sm"
          >
            <span className="capitalize">{type}</span>
            <span className="ml-1.5 text-[10px] opacity-70">({data.confirmed}/{data.total})</span>
          </Button>
        ))}
      </div>

      <div className="rounded-lg border bg-blue-50 border-blue-200 p-3 text-sm mb-4">
        <p className="font-medium text-blue-800 mb-1">One-time setup: confirm service mappings</p>
        <p className="text-blue-700 text-xs leading-relaxed">
          When Tonomo bookings arrive, each service (e.g. "Drone Images", "Silver Package") is
          identified by its <strong>Tonomo service ID</strong> and auto-suggested to the matching
          FlexStudios product or package by name. <strong>Confirm each row once</strong> — after that,
          products are applied automatically with the correct quantities on every new booking.
          Quantities are extracted directly from the tier name (e.g. "10 Sales Images" → qty 10).
          Unconfirmed mappings are never applied automatically.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            {filtered.map(m => (
              <div key={m.id} className={`p-3 border rounded-lg transition-all hover:shadow-md ${!m.is_confirmed ? 'bg-amber-50 hover:bg-amber-100/50' : 'hover:bg-muted/30'} ${!m.flexmedia_entity_id ? 'bg-red-50' : ''}`}>
                <div className="flex items-center gap-3">
                  <Badge>{m.mapping_type}</Badge>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{m.tonomo_label}</p>
                    <p className="text-xs text-muted-foreground font-mono">
                      {m.mapping_type === 'service' || m.mapping_type === 'package'
                        ? `ID: ${m.tonomo_id?.slice(0, 16)}...`
                        : m.tonomo_id}
                    </p>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm">{m.flexmedia_label || "Not mapped"}</p>
                  </div>
                  <Badge className={
                    m.confidence === 'high' ? 'bg-green-100 text-green-700' :
                    m.confidence === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                  }>{m.confidence}</Badge>
                  <Badge variant="outline">{m.is_confirmed ? "Confirmed" : "Auto-suggested"}</Badge>
                  <span className="text-xs text-muted-foreground">{m.last_seen_at ? relativeTime(parseTS(m.last_seen_at)) : "—"}</span>
                  {!m.is_confirmed && (
                    <Button size="sm" onClick={() => confirmMutation.mutate(m.id)} disabled={confirmMutation.isPending} className="shadow-sm hover:shadow-md transition-all">
                      {confirmMutation.isPending ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : null}
                      Confirm
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TonomoRulebook() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 pb-3">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
            <Zap className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <CardTitle>Webhook Receipt</CardTitle>
            <p className="text-sm text-muted-foreground">How incoming webhooks are captured and logged</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <RuleItem number="1" title="All webhooks return 200 OK" description="Never reject a webhook to prevent Tonomo retries" />
          <RuleItem number="2" title="Log before processing" description="Write to TonomoWebhookLog first, enqueue second — never lose data" />
          <RuleItem number="3" title="Parse errors captured" description="Invalid JSON stored in parse_error field, webhook still logged" />
          <RuleItem number="4" title="Signal extraction" description="5 boolean flags computed: has_photographer, has_services, has_address, has_agent, has_appointment_time" />
          <RuleItem number="5" title="Queue creation" description="Valid payloads enqueued to TonomoProcessingQueue with status=pending" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-3 pb-3">
          <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
            <Zap className="h-5 w-5 text-purple-600" />
          </div>
          <div>
            <CardTitle>Processing Queue</CardTitle>
            <p className="text-sm text-muted-foreground">How queued items are processed</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <RuleItem number="1" title="60-second polling" description="Scheduled function runs every 60 seconds" />
          <RuleItem number="2" title="Processing lock" description="90-second TTL lock prevents concurrent runs" />
          <RuleItem number="3" title="Batch processing" description="Process up to 5 items per run" />
          <RuleItem number="4" title="Order grouping" description="Items grouped by order_id, processed in received order" />
          <RuleItem number="5" title="Superseding logic" description="Within each order, latest event per action supersedes older ones" />
          <RuleItem number="6" title="Retry strategy" description="Failed items retried up to 3 times, then moved to dead_letter" />
          <RuleItem number="7" title="Status transitions" description="pending → processing → completed/failed/dead_letter" />
        </CardContent>
      </Card>
    </div>
  );
}

function RuleItem({ number, title, description }) {
  return (
    <div className="flex gap-3 p-2">
      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-xs font-bold">
        {number}
      </div>
      <div>
        <p className="font-semibold text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function CalendarLinkHealthPanel() {
  const { data: auditLogs = [] } = useQuery({
    queryKey: ['calendarLinkAuditFull'],
    queryFn: async () => {
      const all = await base44.entities.TonomoAuditLog.list('-processed_at', 500);
      return all.filter(l => l.entity_type === 'CalendarLink');
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const { data: autoLinkedProjects = [] } = useQuery({
    queryKey: ['autoLinkedProjects'],
    queryFn: async () => {
      const all = await base44.entities.Project.list('-created_date', 500);
      return all.filter(p => p.calendar_auto_linked);
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const stats = useMemo(() => {
    const linked = auditLogs.filter(l => l.operation === 'linked').length;
    const retro = auditLogs.filter(l => l.operation === 'retro_linked').length;
    const skipped = auditLogs.filter(l => l.operation === 'skipped_pending').length;
    const stored = auditLogs.filter(l => l.operation === 'google_event_id_stored').length;
    return { linked, retro, skipped, stored, total: auditLogs.length };
  }, [auditLogs]);

  const opColors = {
    linked: 'bg-green-100 text-green-700',
    retro_linked: 'bg-blue-100 text-blue-700',
    skipped_pending: 'bg-amber-100 text-amber-700',
    google_event_id_stored: 'bg-purple-100 text-purple-700',
    failed: 'bg-red-100 text-red-700',
  };

  const opLabels = {
    linked: 'Linked',
    retro_linked: 'Retro-linked',
    skipped_pending: 'Skipped (pending review)',
    google_event_id_stored: 'Event ID stored',
    failed: 'Failed',
  };

  return (
    <>
      {/* Stats */}
       <div className="grid gap-4" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
        <KPICard title="Auto-linked Projects" value={autoLinkedProjects.length} color="text-green-600" />
        <KPICard title="Direct Links" value={stats.linked} color="text-blue-600" />
        <KPICard title="Retro Links" value={stats.retro} color="text-purple-600" />
        <KPICard title="Deferred (pending)" value={stats.skipped} color="text-amber-600" />
      </div>

      {/* Auto-linked projects list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-linked Projects ({autoLinkedProjects.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {autoLinkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No projects auto-linked yet</p>
          ) : (
            <div className="space-y-2">
              {autoLinkedProjects.slice(0, 20).map(p => (
                <div key={p.id} className="flex items-center gap-3 text-sm py-2 border-b last:border-0">
                  <Badge className="text-xs">
                    {p.calendar_link_source === 'google_event_id_retroactive' ? 'Retro' : 'Direct'}
                  </Badge>
                  <span className="flex-1 font-medium truncate">{p.title || p.property_address}</span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {p.tonomo_google_event_id?.slice(0, 20)}...
                  </span>
                </div>
              ))}
              {autoLinkedProjects.length > 20 && (
                <p className="text-xs text-muted-foreground text-center pt-2">
                  +{autoLinkedProjects.length - 20} more
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Full audit log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calendar Link Audit Log</CardTitle>
        </CardHeader>
        <CardContent>
          {auditLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No activity recorded</p>
          ) : (
            <div className="space-y-2">
              {auditLogs.map(log => (
                <div key={log.id} className="flex items-start gap-3 text-xs py-2 border-b last:border-0">
                  <span className={`px-2 py-0.5 rounded font-medium flex-shrink-0 ${opColors[log.operation] || 'bg-muted text-muted-foreground'}`}>
                    {opLabels[log.operation] || log.operation}
                  </span>
                  <span className="flex-1 text-muted-foreground">{log.notes}</span>
                  <span className="text-muted-foreground flex-shrink-0 ml-2">
                    {log.processed_at ? relativeTime(parseTS(log.processed_at)) : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function MissedSchedulingPanel() {
  const DAYS_THRESHOLD = 3;

  const { data: allProjects = [] } = useQuery({
    queryKey: ['missed-scheduling'],
    queryFn: async () => {
      const projects = await base44.entities.Project.filter({
        status: 'to_be_scheduled'
      }, null, 200);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - DAYS_THRESHOLD);
      return projects.filter(p => {
        const created = p.created_date ? new Date(p.created_date) : null;
        return created && created < cutoff && !p.calendar_auto_linked;
      });
    },
    staleTime: 5 * 60 * 1000,
  });

  if (allProjects.length === 0) return null;

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
          <AlertCircle className="h-4 w-4" />
          {allProjects.length} project{allProjects.length > 1 ? 's' : ''} awaiting scheduling
          <span className="text-xs font-normal text-amber-700">
            — approved but no shoot scheduled for {DAYS_THRESHOLD}+ days
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {allProjects.slice(0, 5).map(p => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-amber-900 truncate">
                {p.title || p.property_address || p.tonomo_order_id || p.id}
              </span>
              <a
                href={createPageUrl('ProjectDetails') + '?id=' + p.id}
                className="text-xs text-amber-700 underline hover:no-underline flex-shrink-0"
              >
                View →
              </a>
            </div>
          ))}
          {allProjects.length > 5 && (
            <p className="text-xs text-amber-600">+{allProjects.length - 5} more</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}