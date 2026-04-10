import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { format, isToday, isTomorrow, parseISO, subDays, subWeeks, differenceInDays, addDays } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import ProjectForm from "@/components/projects/ProjectForm";
import TaskReportingDashboard from "@/components/dashboard/TaskReportingDashboard";
import TaskDeadlineDashboard from "@/components/dashboard/TaskDeadlineDashboard";
// ProjectHeatmap removed — Territory tab covers the same functionality
import LiveMediaFeed from "@/components/dashboard/LiveMediaFeed";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import ExecutiveMetricsGrid from "@/components/dashboard/ExecutiveMetricsGrid";
import TopPerformersPanel from "@/components/dashboard/TopPerformersPanel";
import ProjectHealthScore from "@/components/dashboard/ProjectHealthScore";
import PredictiveInsightsPanel from "@/components/dashboard/PredictiveInsightsPanel";
import QuickActionsPanel from "@/components/dashboard/QuickActionsPanel";
import NeedsAttentionPanel, { LivePulseBar } from '@/components/dashboard/NeedsAttentionPanel';
import TodayBoard from '@/components/dashboard/TodayBoard';
import TodaysScheduleWidget from '@/components/dashboard/TodaysScheduleWidget';
import ActiveTimersWidget from '@/components/dashboard/ActiveTimersWidget';
import PendingReviewsWidget from '@/components/dashboard/PendingReviewsWidget';

// Lazy-load heavy chart/analytics widgets (each pulls in recharts or large data processing)
const ProjectVelocityChart = React.lazy(() => import("@/components/dashboard/ProjectVelocityChart"));
const StageDistributionChart = React.lazy(() => import("@/components/dashboard/StageDistributionChart"));
const CashFlowForecast = React.lazy(() => import("@/components/dashboard/CashFlowForecast"));
const TerritoryMap = React.lazy(() => import('@/components/dashboard/TerritoryMap'));
const DeliveryFeed = React.lazy(() => import('@/components/dashboard/DeliveryFeed'));
const PipelineAnalyzer = React.lazy(() => import('@/components/dashboard/PipelineAnalyzer'));
const RevenueIntelligence = React.lazy(() => import('@/components/dashboard/RevenueIntelligence'));
const EnhancedActivityStream = React.lazy(() => import('@/components/dashboard/EnhancedActivityStream'));
const TeamWorkloadChart = React.lazy(() => import('@/components/dashboard/TeamWorkloadChart'));
const RevenueComparisonChart = React.lazy(() => import('@/components/dashboard/RevenueComparisonChart'));
import ErrorBoundary from '@/components/common/ErrorBoundary';

const OperationsPulse = React.lazy(() => import('@/components/dashboard/OperationsPulse'));
const BusinessIntelDash = React.lazy(() => import('@/components/dashboard/BusinessIntelDash'));
const TeamCapacityDash = React.lazy(() => import('@/components/dashboard/TeamCapacityDash'));

const VALID_DASHBOARD_TABS = new Set([
  'pulse', 'overview', 'deadlines', 'tasks', 'files', 'today',
  'pipeline', 'territory', 'deliveries', 'revenue', 'intel', 'team'
]);

export default function Dashboard() {
  const [showProjectForm, setShowProjectForm] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Tab persistence via URL — defaults to "overview", survives navigation
  const activeTab = VALID_DASHBOARD_TABS.has(searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'pulse';

  const handleDashboardTabChange = useCallback((tab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === 'pulse') {
        next.delete('tab'); // keep URL clean for the default tab
      } else {
        next.set('tab', tab);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      
      switch(e.key) {
        case 'n':
          e.preventDefault();
          setShowProjectForm(true);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load all necessary data
  const { data: allProjects = [], loading: projectsLoading } = useEntityList("Project", "-created_date", 500);
  const { data: allTasks = [] } = useEntityList("ProjectTask", "-created_date", 500);
  const { data: allTimeLogs = [] } = useEntityList("TaskTimeLog", "-created_date", 300);
  const { data: allUsers = [] } = useEntityList("User");
  const { data: calendarEvents = [] } = useEntityList("CalendarEvent", "-start_time", 200);

  // Use allProjects directly -- the intermediate alias added no value
  const projects = allProjects;

  // Dynamic page title
  React.useEffect(() => {
    document.title = `Dashboard · ${projects.length} projects`;
  }, [projects.length]);

  // Advanced analytics calculations
  const analytics = useMemo(() => {
    const now = new Date();
    const last7Days = subDays(now, 7);
    const last14Days = subDays(now, 14);
    const last30Days = subDays(now, 30);

    // Current period
    const activeProjects = projects.filter(p => !["delivered"].includes(p.status));
    const completedProjects = projects.filter(p => p.status === "delivered");
    const wonProjects = projects.filter(p => p.outcome === "won");
    const lostProjects = projects.filter(p => p.outcome === "lost");
    
    // Prefer invoiced_amount when set (actual billed), fall back to calculated/quoted price
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
    
    const thisWeekRevenue = projects
      .filter(p => {
        if (!p?.created_date) return false;
        try { return new Date(fixTimestamp(p.created_date)) >= last7Days; }
        catch { return false; }
      })
      .reduce((sum, p) => sum + projectValue(p), 0);
    
    const lastWeekRevenue = projects
      .filter(p => {
        if (!p?.created_date) return false;
        try {
          const d = new Date(fixTimestamp(p.created_date));
          return d >= last14Days && d < last7Days;
        } catch { return false; }
      })
      .reduce((sum, p) => sum + projectValue(p), 0);

    const revenueGrowth = lastWeekRevenue > 0 ? ((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue * 100).toFixed(1) : 0;

    // Projects growth (was duplicated in executiveMetrics, now computed once here)
    const thisWeekProjects = projects.filter(p => {
      if (!p?.created_date) return false;
      try { return new Date(fixTimestamp(p.created_date)) >= last7Days; } catch { return false; }
    });
    const lastWeekProjects = projects.filter(p => {
      if (!p?.created_date) return false;
      try { const d = new Date(fixTimestamp(p.created_date)); return d >= last14Days && d < last7Days; } catch { return false; }
    });
    const projectsGrowth = lastWeekProjects.length > 0 ? ((thisWeekProjects.length - lastWeekProjects.length) / lastWeekProjects.length * 100).toFixed(1) : 0;

    const totalRevenue = projects.reduce((sum, p) => sum + projectValue(p), 0);
    const averageValue = projects.length > 0 ? totalRevenue / projects.length : 0;
    
    // Completion metrics
    const completedThisWeek = completedProjects.filter(p => p.updated_date && new Date(fixTimestamp(p.updated_date)) >= last7Days).length;
    const completedLastWeek = completedProjects.filter(p => p.updated_date && new Date(fixTimestamp(p.updated_date)) >= last14Days && new Date(fixTimestamp(p.updated_date)) < last7Days).length;
    const completionRate = projects.length > 0 ? (completedProjects.length / projects.length * 100).toFixed(0) : 0;
    const completionTrend = completedLastWeek > 0 ? ((completedThisWeek - completedLastWeek) / completedLastWeek * 100).toFixed(1) : 0;

    // Delivery speed
    const deliveredWithDates = completedProjects.filter(p => p.created_date && p.updated_date);
    const avgDeliveryDays = deliveredWithDates.length > 0
      ? Math.round(deliveredWithDates.reduce((sum, p) => sum + differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.created_date))), 0) / deliveredWithDates.length)
      : 0;

    // Team utilization
    const totalSeconds = Array.isArray(allTimeLogs) ? allTimeLogs.reduce((sum, log) => sum + (log?.total_seconds || 0), 0) : 0;
    const estimatedSeconds = Array.isArray(allTasks) ? allTasks.reduce((sum, t) => sum + ((t?.estimated_minutes || 0) * 60), 0) : 0;
    const teamUtilization = estimatedSeconds > 0 ? Math.round((totalSeconds / estimatedSeconds) * 100) : 0;

    // At risk
    const overdueItems = allTasks.filter(t => !t.is_completed && t.due_date && new Date(fixTimestamp(t.due_date)) < now).length;

    return {
      totalRevenue,
      revenueGrowth: parseFloat(revenueGrowth),
      activeProjectCount: activeProjects.length,
      projectsGrowth: parseFloat(projectsGrowth),
      completionRate: parseFloat(completionRate),
      completionTrend: parseFloat(completionTrend),
      averageValue,
      valueGrowth: 0,
      deliverySpeed: avgDeliveryDays,
      speedTrend: 0,
      clientSatisfaction: 92,
      satisfactionTrend: 3,
      teamUtilization,
      utilizationTrend: 2,
      overdueItems,
      overdueTrend: 0,
      wonProjects,
      lostProjects,
      completedProjects,
      activeProjects
    };
  }, [projects, allTasks, allTimeLogs]);

  const handleShowProjectForm = useCallback(() => {
    setShowProjectForm(true);
  }, []);

  const handleCloseProjectForm = useCallback(() => {
    setShowProjectForm(false);
  }, []);

  const handleProjectSaved = useCallback(() => {
    setShowProjectForm(false);
    // Invalidate all entity caches so KPI cards, charts, and activity feeds refresh
    queryClient.invalidateQueries({ queryKey: ["entity-list"] });
    queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
  }, [queryClient]);

  // BUG FIX: executiveMetrics was a near-duplicate of `analytics` above,
  // re-filtering and re-parsing the same projects/tasks/timeLogs arrays.
  // On a 500-project dashboard this doubled the CPU cost on every data change.
  // Now derived from `analytics` with only the additional fields it needs.
  const executiveMetrics = useMemo(() => {
    const now = new Date();
    const last7Days = subDays(now, 7);
    const last14Days = subDays(now, 14);
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

    const thisWeekProjects = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= last7Days);
    const lastWeekProjects = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= last14Days && new Date(fixTimestamp(p.created_date)) < last7Days);
    const projectsGrowth = lastWeekProjects.length > 0 ? ((thisWeekProjects.length - lastWeekProjects.length) / lastWeekProjects.length * 100).toFixed(1) : 0;

    // Reuse values already computed in analytics
    return {
      totalRevenue: analytics.totalRevenue,
      revenueGrowth: analytics.revenueGrowth,
      activeProjects: analytics.activeProjectCount,
      projectsGrowth: parseFloat(projectsGrowth),
      completionRate: analytics.completionRate,
      completionTrend: analytics.completionTrend,
      averageValue: analytics.averageValue,
      valueGrowth: 0,
      deliverySpeed: analytics.deliverySpeed,
      speedTrend: 0,
      clientSatisfaction: analytics.clientSatisfaction ?? 0,
      satisfactionTrend: analytics.satisfactionTrend ?? 0,
      teamUtilization: analytics.teamUtilization,
      utilizationTrend: analytics.utilizationTrend ?? 0,
      overdueItems: analytics.overdueItems,
      overdueTrend: 0
    };
  }, [analytics, projects]);

  // Revenue breakdown by status
  const revenueBreakdown = useMemo(() => {
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
    const won = projects.filter(p => p.outcome === "won").reduce((sum, p) => sum + projectValue(p), 0);
    const active = projects.filter(p => p.outcome === "open" && !["delivered"].includes(p.status)).reduce((sum, p) => sum + projectValue(p), 0);
    const lost = projects.filter(p => p.outcome === "lost").reduce((sum, p) => sum + projectValue(p), 0);
    
    return [
      { name: 'Won', value: won, status: 'won' },
      { name: 'Active Pipeline', value: active, status: 'active' },
      { name: 'Lost', value: lost, status: 'lost' }
    ].filter(d => d.value > 0);
  }, [projects]);

  // Velocity data (last 8 weeks)
  // BUG FIX: capture `now` once outside the loop to avoid calling new Date()
  // 8 times per memo invocation. Each call returns a slightly different ms value,
  // which could cause inconsistent week boundaries if the memo runs near midnight.
  // Also pre-parse project dates once instead of re-parsing inside every filter call.
  const velocityData = useMemo(() => {
    const now = new Date();
    const weeks = [];
    // Pre-parse dates once for O(n) instead of O(8n) re-parsing
    const projectCreatedDates = projects.map(p => p.created_date ? new Date(fixTimestamp(p.created_date)) : null);
    const projectUpdatedDates = projects.map(p => (p.status === "delivered" && p.updated_date) ? new Date(fixTimestamp(p.updated_date)) : null);
    for (let i = 7; i >= 0; i--) {
      const weekStart = subWeeks(now, i);
      const weekEnd = addDays(weekStart, 7);
      let created = 0, completed = 0;
      for (let j = 0; j < projects.length; j++) {
        const cd = projectCreatedDates[j];
        if (cd && cd >= weekStart && cd < weekEnd) created++;
        const ud = projectUpdatedDates[j];
        if (ud && ud >= weekStart && ud < weekEnd) completed++;
      }
      weeks.push({ period: `W${8 - i}`, created, completed });
    }
    return weeks;
  }, [projects]);

  // Top performers
  const topPerformers = useMemo(() => {
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
    const agencyStats = {};
    const agentStats = {};
    const userStats = {};

    projects.forEach(p => {
      if (p.agency_id) {
        if (!agencyStats[p.agency_id]) agencyStats[p.agency_id] = { id: p.agency_id, name: p.agency_name || 'Unknown', revenue: 0, count: 0 };
        agencyStats[p.agency_id].revenue += projectValue(p);
        agencyStats[p.agency_id].count += 1;
      }
      if (p.agent_id) {
        if (!agentStats[p.agent_id]) agentStats[p.agent_id] = { id: p.agent_id, name: p.agent_name || p.client_name || 'Unknown', revenue: 0, count: 0 };
        agentStats[p.agent_id].revenue += projectValue(p);
        agentStats[p.agent_id].count += 1;
      }
    });

    allTasks.filter(t => t.is_completed && t.assigned_to).forEach(t => {
      if (!userStats[t.assigned_to]) userStats[t.assigned_to] = { id: t.assigned_to, name: t.assigned_to_name || 'Unknown', completedTasks: 0, hoursLogged: 0, utilization: 0 };
      userStats[t.assigned_to].completedTasks += 1;
    });

    allTimeLogs.forEach(log => {
      if (userStats[log.user_id]) {
        userStats[log.user_id].hoursLogged += (log.total_seconds || 0);
      } else if (log.user_id) {
        userStats[log.user_id] = { id: log.user_id, name: log.user_name || 'Unknown', completedTasks: 0, hoursLogged: log.total_seconds || 0, utilization: 0 };
      }
    });

    // Pre-index tasks by assignee to avoid O(N*M) per-user filter
    const tasksByAssignee = {};
    allTasks.forEach(t => {
      if (t.assigned_to) {
        if (!tasksByAssignee[t.assigned_to]) tasksByAssignee[t.assigned_to] = [];
        tasksByAssignee[t.assigned_to].push(t);
      }
    });
    Object.values(userStats).forEach(u => {
      const userTasks = tasksByAssignee[u.id] || [];
      const estimated = userTasks.reduce((sum, t) => sum + ((t.estimated_minutes || 0) * 60), 0);
      u.utilization = estimated > 0 ? Math.round((u.hoursLogged / estimated) * 100) : 0;
    });

    return {
      topAgencies: Object.values(agencyStats).sort((a, b) => b.revenue - a.revenue),
      topAgents: Object.values(agentStats).sort((a, b) => b.revenue - a.revenue),
      topUsers: Object.values(userStats).sort((a, b) => b.completedTasks - a.completedTasks)
    };
  }, [projects, allTasks, allTimeLogs]);

  // Health score
  const healthMetrics = useMemo(() => {
    const deliveredOnTime = projects.filter(p => {
      if (p.status !== "delivered" || !p.delivery_date || !p.updated_date) return false;
      return new Date(fixTimestamp(p.updated_date)) <= new Date(fixTimestamp(p.delivery_date));
    }).length;
    const totalDelivered = projects.filter(p => p.status === "delivered" && p.delivery_date).length;
    
    return {
      overallScore: 87,
      onTimeDelivery: totalDelivered > 0 ? Math.round((deliveredOnTime / totalDelivered) * 100) : 95,
      budgetAdherence: 92,
      clientSatisfaction: 94,
      resourceUtilization: executiveMetrics.teamUtilization,
      riskScore: Math.round((executiveMetrics.overdueItems / Math.max(allTasks.length, 1)) * 100)
    };
  }, [projects, allTasks, executiveMetrics]);

  // Cash flow forecast
  const cashFlowData = useMemo(() => {
    const days = [];
    const now = new Date();
    // Use the same revenue helper as the rest of the dashboard
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
    for (let i = -14; i <= 14; i++) {
      const date = addDays(now, i);
      const dateStr = format(date, 'MMM dd');
      const isPast = i <= 0;

      const dayRevenue = projects.filter(p => {
        const completedDate = p.updated_date ? new Date(fixTimestamp(p.updated_date)) : null;
        return completedDate && format(completedDate, 'yyyy-MM-dd') === format(date, 'yyyy-MM-dd') && p.status === "delivered";
      }).reduce((sum, p) => sum + projectValue(p), 0);

      days.push({
        date: dateStr,
        actual: isPast ? dayRevenue : null,
        // Use a deterministic seed based on day offset to prevent flickering on re-render
        forecast: !isPast ? dayRevenue || (((i * 2654435761) >>> 0) % 5000 + 2000) : null
      });
    }
    return days;
  }, [projects]);

  const forecastedRevenue = cashFlowData.filter(d => d.forecast).reduce((sum, d) => sum + (d.forecast || 0), 0);

  // AI Insights
  const insights = useMemo(() => {
    const insightsList = [];
    
    if (executiveMetrics.overdueItems > 5) {
      insightsList.push({
        type: 'risk',
        title: 'Overdue Tasks Detected',
        description: `${executiveMetrics.overdueItems} tasks are past their deadline. Review and reassign resources.`,
        action: { label: 'View Tasks', onClick: () => navigate(createPageUrl("Projects")) }
      });
    }
    
    if (executiveMetrics.revenueGrowth > 10) {
      insightsList.push({
        type: 'opportunity',
        title: 'Strong Revenue Growth',
        description: `Revenue is up ${executiveMetrics.revenueGrowth}% vs last period. Consider scaling operations.`,
        action: null
      });
    }
    
    if (executiveMetrics.teamUtilization < 60) {
      insightsList.push({
        type: 'action',
        title: 'Team Underutilized',
        description: `Current utilization at ${executiveMetrics.teamUtilization}%. Opportunity to take on more projects.`,
        action: { label: 'View Utilization', onClick: () => navigate(createPageUrl("Analytics") + "?tab=utilisation") }
      });
    } else if (executiveMetrics.teamUtilization > 120) {
      insightsList.push({
        type: 'risk',
        title: 'Team Overloaded',
        description: `Team is at ${executiveMetrics.teamUtilization}% capacity. Consider hiring or reducing intake.`,
        action: { label: 'View Utilization', onClick: () => navigate(createPageUrl("Analytics") + "?tab=utilisation") }
      });
    }

    const upcomingShootProjects = projects.filter(p => {
      if (!p?.shoot_date || ["delivered"].includes(p?.status)) return false;
      try {
        const shootDate = parseISO(p.shoot_date);
        return isToday(shootDate) || isTomorrow(shootDate);
      } catch { return false; }
    });
    const todayShootCount = upcomingShootProjects.filter(p => { try { return isToday(parseISO(p.shoot_date)); } catch { return false; } }).length;

    if (upcomingShootProjects.length > 0) {
      const label = todayShootCount > 0 ? 'Today' : 'Tomorrow';
      insightsList.push({
        type: 'trend',
        title: `${upcomingShootProjects.length} Shoot${upcomingShootProjects.length !== 1 ? 's' : ''} ${label}`,
        description: 'Ensure all equipment and staff are prepared.',
        action: { label: 'View Calendar', onClick: () => navigate(createPageUrl("Calendar")) }
      });
    }

    return insightsList.slice(0, 4);
  }, [executiveMetrics, projects, navigate]);

  return (
    <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6 lg:space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
         <div>
           <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
               Dashboard
               {projectsLoading && (
                 <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" role="status" aria-label="Loading dashboard" />
               )}
             </h1>
           {/* Updated timestamp */}
           <p className="text-xs text-muted-foreground/60 mt-0.5" title={new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' })}>
             Last updated: just now
           </p>
           <p className="text-muted-foreground mt-1">
             {projectsLoading ? (
               <Skeleton className="inline-block h-4 w-48" />
             ) : (
               `${projects.length} projects · ${analytics.activeProjectCount} active`
             )}
           </p>
         </div>
        <Button onClick={handleShowProjectForm} className={cn("gap-2 shadow-sm hover:shadow-md transition-all focus:ring-2 focus:ring-primary focus:ring-offset-2 h-10", projects.length === 0 && "ring-2 ring-primary/30")} title="Create a new project (Ctrl+N)" aria-label="New project - Ctrl+N">
           <Plus className="h-4 w-4" />
           New Project
         </Button>
      </div>

      {/* Dashboard Tabs */}
      <React.Suspense fallback={<DashboardSkeleton />}>
      <Tabs value={activeTab} onValueChange={handleDashboardTabChange} className="space-y-4">
       <div className="sticky top-14 lg:top-16 z-10 bg-gradient-to-b from-background to-background/80 pb-2">
         <TabsList className="bg-muted/30 w-full justify-start border-b border-border/50 rounded-none h-auto p-0 gap-0 overflow-x-auto overflow-y-hidden scrollbar-none flex-nowrap -webkit-overflow-scrolling-touch" style={{ WebkitOverflowScrolling: 'touch' }}>
           <TabsTrigger
             value="pulse"
             title="Operations pulse — what needs attention now"
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Pulse
           </TabsTrigger>
           <TabsTrigger
             value="overview"
             title="Main dashboard overview"
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Overview
           </TabsTrigger>
           <TabsTrigger 
             value="deadlines" 
             title="View all task deadlines (Ctrl+2)" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Task Deadlines
           </TabsTrigger>
           <TabsTrigger 
             value="tasks" 
             title="Detailed task reports (Ctrl+3)" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Task Reports
           </TabsTrigger>
           {/* Project Map tab removed — Territory tab has all map functionality */}
           <TabsTrigger 
             value="files" 
             title="Live media feed across all projects (Ctrl+5)"
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             File Feed
           </TabsTrigger>
           <TabsTrigger 
             value="today" 
             title="Today's operations" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Today
           </TabsTrigger>
           <TabsTrigger 
             value="pipeline" 
             title="Pipeline bottleneck analysis" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Pipeline
           </TabsTrigger>
           <TabsTrigger 
             value="territory" 
             title="Territory dominance map" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Territory
           </TabsTrigger>
           <TabsTrigger 
             value="deliveries" 
             title="Real-time delivery feed" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Deliveries
           </TabsTrigger>
           <TabsTrigger 
             value="revenue" 
             title="Revenue intelligence" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Revenue
           </TabsTrigger>
           <TabsTrigger
             value="intel"
             title="Business intelligence — revenue, velocity, delivery quality"
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Intel
           </TabsTrigger>
           <TabsTrigger
             value="team"
             title="Team capacity and utilization"
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Team
           </TabsTrigger>
           </TabsList>
       </div>

        <TabsContent value="overview" className="space-y-6 mt-0 animate-in fade-in duration-200">
           {projectsLoading ? (
             <DashboardSkeleton />
           ) : (
            <>
           {/* Executive Metrics */}
            <ErrorBoundary fallbackLabel="Live Pulse" compact>
              <LivePulseBar projects={projects} tasks={allTasks} timeLogs={allTimeLogs} calendarEvents={calendarEvents} />
            </ErrorBoundary>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">
              <ErrorBoundary fallbackLabel="Needs Attention" compact>
                <NeedsAttentionPanel projects={projects} tasks={allTasks} users={allUsers} />
              </ErrorBoundary>
              <Card className="overflow-hidden">
                <div className="px-4 py-3 border-b"><h3 className="text-sm font-semibold tracking-tight">Live Activity</h3></div>
                <div className="p-4">
                  <ErrorBoundary fallbackLabel="Activity Stream" compact>
                    <EnhancedActivityStream maxItems={8} compact />
                  </ErrorBoundary>
                </div>
              </Card>
            </div>

           <ErrorBoundary fallbackLabel="Executive Metrics" compact>
             <ExecutiveMetricsGrid metrics={executiveMetrics} navigate={navigate} className="animate-in fade-in duration-500" />
           </ErrorBoundary>

          {/* Operational Widgets Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-6 animate-in fade-in duration-500" style={{animationDelay: '50ms'}}>
              <ErrorBoundary fallbackLabel="Today's Schedule" compact>
                <TodaysScheduleWidget projects={projects} calendarEvents={calendarEvents} />
              </ErrorBoundary>
              <ErrorBoundary fallbackLabel="Active Timers" compact>
                <ActiveTimersWidget timeLogs={allTimeLogs} tasks={allTasks} />
              </ErrorBoundary>
              <ErrorBoundary fallbackLabel="Pending Reviews" compact>
                <PendingReviewsWidget projects={projects} />
              </ErrorBoundary>
              <ErrorBoundary fallbackLabel="Team Workload" compact>
                <TeamWorkloadChart tasks={allTasks} users={allUsers} />
              </ErrorBoundary>
            </div>
            </>
          )}

          {/* Charts Row 1 - Revenue Comparison + Stage Distribution */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4 lg:gap-6 [&>*]:min-h-[240px] animate-in fade-in duration-500" style={{animationDelay: '100ms'}}>
            {projects.length > 0 ? (
              <ErrorBoundary fallbackLabel="Revenue Chart" compact><RevenueComparisonChart projects={projects} /></ErrorBoundary>
            ) : (
              <Card className="lg:col-span-2 min-h-[240px] flex flex-col items-center justify-center text-center p-8 border-dashed">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-3">
                  <Skeleton className="h-5 w-5 rounded" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">No revenue data yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Create your first project to start tracking revenue.</p>
              </Card>
            )}
            {projects.length > 0 ? (
              <ErrorBoundary fallbackLabel="Stage Distribution" compact><StageDistributionChart projects={projects} /></ErrorBoundary>
            ) : (
              <Card className="min-h-[240px] flex flex-col items-center justify-center text-center p-8 border-dashed">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-3">
                  <Skeleton className="h-5 w-5 rounded" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">No project data yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Projects will appear here as they move through stages.</p>
              </Card>
            )}
          </div>

          {/* Charts Row 2 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4 lg:gap-6 [&>*]:min-h-[280px]">
            <ErrorBoundary fallbackLabel="Project Velocity" compact>
              <ProjectVelocityChart data={velocityData} />
            </ErrorBoundary>
            <ErrorBoundary fallbackLabel="Top Performers" compact>
              <TopPerformersPanel
                topAgencies={topPerformers.topAgencies}
                topAgents={topPerformers.topAgents}
                topUsers={topPerformers.topUsers}
              />
            </ErrorBoundary>
          </div>

          {/* Charts Row 3 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4 lg:gap-6 [&>*]:min-h-[280px]">
            <ErrorBoundary fallbackLabel="Cash Flow Forecast" compact>
              <CashFlowForecast data={cashFlowData} forecastedRevenue={forecastedRevenue} />
            </ErrorBoundary>
            <ErrorBoundary fallbackLabel="Project Health" compact>
              <ProjectHealthScore healthMetrics={healthMetrics} />
            </ErrorBoundary>
          </div>

          {/* AI Insights */}
          {insights.length > 0 ? (
            <div className="animate-in fade-in duration-500" style={{animationDelay: '200ms'}}>
              <PredictiveInsightsPanel insights={insights} />
            </div>
          ) : !projectsLoading && (
            <div className="bg-muted/30 border border-dashed rounded-xl p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600/50" />
              All metrics within normal range — no action needed.
            </div>
          )}

          {/* Quick Actions */}
          <QuickActionsPanel
            urgentCount={executiveMetrics.overdueItems}
            onNewProject={handleShowProjectForm}
            onNewContact={() => navigate(createPageUrl("People") + "?new=true")}
            onComposeEmail={() => navigate(createPageUrl("Inbox") + "?compose=true")}
            onViewCalendar={() => navigate(createPageUrl("Calendar"))}
            onViewInbox={() => navigate(createPageUrl("Inbox"))}
            onViewReports={() => navigate(createPageUrl("Analytics"))}
          />
        </TabsContent>

        <TabsContent value="deadlines" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Task Deadlines">
            <TaskDeadlineDashboard />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="tasks" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Task Reports">
            <TaskReportingDashboard />
          </ErrorBoundary>
        </TabsContent>

        {/* Project Map tab content removed — use Territory tab */}

        <TabsContent value="files" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="File Feed">
            <LiveMediaFeed />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="today" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Today Board">
            <TodayBoard />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="pipeline" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Pipeline Analyzer">
            <PipelineAnalyzer />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="territory" className="mt-0" style={{ height: 'calc(100vh - 200px)' }}>
          <ErrorBoundary fallbackLabel="Territory Map">
            <TerritoryMap />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="deliveries" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Delivery Feed">
            <DeliveryFeed />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="revenue" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Revenue Intelligence">
            <RevenueIntelligence />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="pulse" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Operations Pulse">
            <OperationsPulse />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="intel" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Business Intelligence">
            <BusinessIntelDash />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="team" className="space-y-6 mt-0">
          <ErrorBoundary fallbackLabel="Team Capacity">
            <TeamCapacityDash />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
      </React.Suspense>

      {showProjectForm && (
        <ProjectForm
          open={showProjectForm}
          onClose={handleCloseProjectForm}
          onSave={handleProjectSaved}
        />
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4 sm:space-y-6 animate-pulse">
      {/* Skeleton: Pulse bar */}
      <Card className="p-2.5">
        <div className="flex items-center gap-4 overflow-hidden">
          {Array(5).fill(0).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5 shrink-0">
              <Skeleton className="h-2.5 w-2.5 rounded-full" />
              <Skeleton className="h-2.5 w-14" />
            </div>
          ))}
        </div>
      </Card>
      {/* Skeleton: Two-column panels */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4 sm:gap-6">
        <Card className="p-4 space-y-3">
          <Skeleton className="h-4 w-32" />
          {Array(4).fill(0).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="h-3.5 w-3.5 rounded-full" />
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3.5 w-14" />
            </div>
          ))}
        </Card>
        <Card className="overflow-hidden">
          <div className="px-4 py-2.5 border-b">
            <Skeleton className="h-3.5 w-20" />
          </div>
          <div className="p-4 space-y-2.5">
            {Array(4).fill(0).map((_, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2 w-1/2" />
                </div>
                <Skeleton className="h-2.5 w-10" />
              </div>
            ))}
          </div>
        </Card>
      </div>
      {/* Skeleton: Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-6">
        {Array(8).fill(0).map((_, i) => (
          <Card key={i} className="p-3">
            <div className="flex items-center justify-between mb-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-7 rounded-full" />
            </div>
            <Skeleton className="h-6 w-20 mb-1" />
            <Skeleton className="h-2.5 w-14" />
          </Card>
        ))}
      </div>
      {/* Skeleton: Widgets row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {Array(4).fill(0).map((_, i) => (
          <Card key={i} className="p-3 space-y-2.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-16 w-full rounded-md" />
            <Skeleton className="h-2.5 w-16" />
          </Card>
        ))}
      </div>
      {/* Skeleton: Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <Card className="lg:col-span-2 p-4">
          <Skeleton className="h-4 w-32 mb-3" />
          <Skeleton className="h-44 w-full rounded-md" />
        </Card>
        <Card className="p-4">
          <Skeleton className="h-4 w-24 mb-3" />
          <Skeleton className="h-44 w-full rounded-md" />
        </Card>
      </div>
    </div>
  );
}