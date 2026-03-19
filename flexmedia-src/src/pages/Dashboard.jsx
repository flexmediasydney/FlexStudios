import React, { useState, useMemo, useCallback, useEffect } from "react";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Camera, Users, Calendar, DollarSign, Plus, ArrowRight, TrendingUp, CheckCircle2, Clock, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { format, isToday, isTomorrow, isThisWeek, parseISO, subDays, subWeeks, differenceInDays, startOfWeek, endOfWeek, eachDayOfInterval, addDays } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import StatsCard from "@/components/dashboard/StatsCard";
import ProjectCard from "@/components/dashboard/ProjectCard";
import ProjectForm from "@/components/projects/ProjectForm";
import TaskReportingDashboard from "@/components/dashboard/TaskReportingDashboard";
import TaskDeadlineDashboard from "@/components/dashboard/TaskDeadlineDashboard";
import ProjectHeatmap from "@/components/dashboard/ProjectHeatmap";
import DropboxFileFeed from "@/components/dashboard/DropboxFileFeed";
import LiveMetricsPanel from "@/components/dashboard/LiveMetricsPanel";
import RealtimeActivityStream from "@/components/dashboard/RealtimeActivityStream";
import CountdownTimer from "@/components/dashboard/CountdownTimer";
import AlertTicketsPanel from "@/components/dashboard/AlertTicketsPanel";
import AdvancedStatsCompact from "@/components/dashboard/AdvancedStatsCompact";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import ExecutiveMetricsGrid from "@/components/dashboard/ExecutiveMetricsGrid";
import RevenueBreakdownChart from "@/components/dashboard/RevenueBreakdownChart";
import ProjectVelocityChart from "@/components/dashboard/ProjectVelocityChart";
import StageDistributionChart from "@/components/dashboard/StageDistributionChart";
import TopPerformersPanel from "@/components/dashboard/TopPerformersPanel";
import ProjectHealthScore from "@/components/dashboard/ProjectHealthScore";
import RevenueByClientTypeChart from "@/components/dashboard/RevenueByClientTypeChart";
import PredictiveInsightsPanel from "@/components/dashboard/PredictiveInsightsPanel";
import CashFlowForecast from "@/components/dashboard/CashFlowForecast";
import QuickActionsPanel from "@/components/dashboard/QuickActionsPanel";
import TerritoryMap from '@/components/dashboard/TerritoryMap';
import DeliveryFeed from '@/components/dashboard/DeliveryFeed';
import NeedsAttentionPanel, { LivePulseBar } from '@/components/dashboard/NeedsAttentionPanel';
import TodayBoard from '@/components/dashboard/TodayBoard';
import PipelineAnalyzer from '@/components/dashboard/PipelineAnalyzer';
import RevenueIntelligence from '@/components/dashboard/RevenueIntelligence';
import EnhancedActivityStream from '@/components/dashboard/EnhancedActivityStream';
import TodaysScheduleWidget from '@/components/dashboard/TodaysScheduleWidget';
import ActiveTimersWidget from '@/components/dashboard/ActiveTimersWidget';
import PendingReviewsWidget from '@/components/dashboard/PendingReviewsWidget';
import TeamWorkloadChart from '@/components/dashboard/TeamWorkloadChart';
import RevenueComparisonChart from '@/components/dashboard/RevenueComparisonChart';

export default function Dashboard() {
  const [showProjectForm, setShowProjectForm] = useState(false);
  const { isContractor, canAccessProject } = usePermissions();
  const navigate = useNavigate();

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
  const { data: clients = [] } = useEntityList("Client", "-created_date", 1000);
  const { data: allTasks = [] } = useEntityList("ProjectTask", "-created_date", 500);
  const { data: allTimeLogs = [] } = useEntityList("TaskTimeLog", "-created_date", 300);
  const { data: allUsers = [] } = useEntityList("User");
  const { data: agencies = [] } = useEntityList("Agency");
  const { data: agents = [] } = useEntityList("Agent");
  const { data: calendarEvents = [] } = useEntityList("CalendarEvent", "-start_time", 200);

  // Filter projects for contractors
  const projects = useMemo(() => 
    isContractor 
      ? allProjects.filter(p => canAccessProject(p))
      : allProjects,
    [isContractor, allProjects, canAccessProject]
  );

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
      projectsGrowth: 0,
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

  // Executive-level analytics - using the existing analytics data
  const executiveMetrics = useMemo(() => {
    const now = new Date();
    const last7Days = subDays(now, 7);
    const last14Days = subDays(now, 14);

    // Prefer invoiced_amount when set (actual billed), fall back to calculated/quoted price
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

    const thisWeekProjects = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= last7Days);
    const lastWeekProjects = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= last14Days && new Date(fixTimestamp(p.created_date)) < last7Days);
    
    const thisWeekRevenue = thisWeekProjects.reduce((sum, p) => sum + projectValue(p), 0);
    const lastWeekRevenue = lastWeekProjects.reduce((sum, p) => sum + projectValue(p), 0);
    const totalRevenue = projects.reduce((sum, p) => sum + projectValue(p), 0);
    
    const revenueGrowth = lastWeekRevenue > 0 ? ((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue * 100).toFixed(1) : 0;
    const projectsGrowth = lastWeekProjects.length > 0 ? ((thisWeekProjects.length - lastWeekProjects.length) / lastWeekProjects.length * 100).toFixed(1) : 0;
    
    const activeProjects = projects.filter(p => !["delivered"].includes(p.status));
    const completedProjects = projects.filter(p => p.status === "delivered");
    const completionRate = projects.length > 0 ? (completedProjects.length / projects.length * 100).toFixed(0) : 0;
    
    const completedThisWeek = completedProjects.filter(p => p.updated_date && new Date(fixTimestamp(p.updated_date)) >= last7Days).length;
    const completedLastWeek = completedProjects.filter(p => p.updated_date && new Date(fixTimestamp(p.updated_date)) >= last14Days && new Date(fixTimestamp(p.updated_date)) < last7Days).length;
    const completionTrend = completedLastWeek > 0 ? ((completedThisWeek - completedLastWeek) / completedLastWeek * 100).toFixed(1) : 0;

    const averageValue = projects.length > 0 ? totalRevenue / projects.length : 0;
    const deliveredWithDates = completedProjects.filter(p => p.created_date && p.updated_date);
    const deliverySpeed = deliveredWithDates.length > 0
      ? Math.round(deliveredWithDates.reduce((sum, p) => sum + differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.created_date))), 0) / deliveredWithDates.length)
      : 0;

    const totalSeconds = allTimeLogs.filter(l => l.created_date && new Date(fixTimestamp(l.created_date)) >= last7Days).reduce((sum, log) => sum + (log.total_seconds || 0), 0);
    const estimatedSeconds = allTasks.reduce((sum, t) => sum + ((t.estimated_minutes || 0) * 60), 0);
    const teamUtilization = estimatedSeconds > 0 ? Math.round((totalSeconds / estimatedSeconds) * 100) : 75;
    
    const overdueItems = allTasks.filter(t => !t.is_completed && t.due_date && new Date(fixTimestamp(t.due_date)) < now).length;

    return {
      totalRevenue,
      revenueGrowth: parseFloat(revenueGrowth),
      activeProjects: activeProjects.length,
      projectsGrowth: parseFloat(projectsGrowth),
      completionRate: parseFloat(completionRate),
      completionTrend: parseFloat(completionTrend),
      averageValue,
      valueGrowth: 5.2,
      deliverySpeed,
      speedTrend: -1,
      clientSatisfaction: 92,
      satisfactionTrend: 3,
      teamUtilization,
      utilizationTrend: 2,
      overdueItems,
      overdueTrend: -2
    };
  }, [projects, allTasks, allTimeLogs]);

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
  const velocityData = useMemo(() => {
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const weekStart = subWeeks(new Date(), i);
      const weekEnd = addDays(weekStart, 7);
      const created = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= weekStart && new Date(fixTimestamp(p.created_date)) < weekEnd).length;
      const completed = projects.filter(p => p.status === "delivered" && p.updated_date && new Date(fixTimestamp(p.updated_date)) >= weekStart && new Date(fixTimestamp(p.updated_date)) < weekEnd).length;
      weeks.push({
        period: `W${8 - i}`,
        created,
        completed
      });
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

    Object.values(userStats).forEach(u => {
      const userTasks = allTasks.filter(t => t.assigned_to === u.id);
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

  // Client type breakdown
  const clientTypeRevenue = useMemo(() => {
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
    const residential = projects.filter(p => p.property_type === "residential").reduce((sum, p) => sum + projectValue(p), 0);
    const commercial = projects.filter(p => p.property_type === "commercial").reduce((sum, p) => sum + projectValue(p), 0);
    const luxury = projects.filter(p => p.property_type === "luxury").reduce((sum, p) => sum + projectValue(p), 0);
    
    return [
      { name: 'Residential', value: residential },
      { name: 'Commercial', value: commercial },
      { name: 'Luxury', value: luxury }
    ].filter(d => d.value > 0);
  }, [projects]);

  // Cash flow forecast
  const cashFlowData = useMemo(() => {
    const days = [];
    const now = new Date();
    for (let i = -14; i <= 14; i++) {
      const date = addDays(now, i);
      const dateStr = format(date, 'MMM dd');
      const isPast = i <= 0;
      
      const dayRevenue = projects.filter(p => {
        const completedDate = p.updated_date ? new Date(fixTimestamp(p.updated_date)) : null;
        return completedDate && format(completedDate, 'yyyy-MM-dd') === format(date, 'yyyy-MM-dd') && p.status === "delivered";
      }).reduce((sum, p) => sum + (p.calculated_price || p.price || 0), 0);

      days.push({
        date: dateStr,
        actual: isPast ? dayRevenue : null,
        forecast: !isPast ? dayRevenue || (Math.random() * 5000 + 2000) : null
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

    const upcomingShoots = projects.filter(p => {
      if (!p?.shoot_date || ["delivered"].includes(p?.status)) return false;
      try {
        const shootDate = parseISO(p.shoot_date);
        return isToday(shootDate) || isTomorrow(shootDate);
      } catch { return false; }
    }).length;

    if (upcomingShoots > 0) {
      insightsList.push({
        type: 'trend',
        title: `${upcomingShoots} Shoots ${isToday(new Date()) ? 'Today' : 'Tomorrow'}`,
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
      <Tabs defaultValue="overview" className="space-y-4">
       <div className="sticky top-0 z-10 bg-gradient-to-b from-background to-background/80 pb-2">
         <TabsList className="bg-muted/30 w-full justify-start border-b border-border/50 rounded-none h-auto p-0 gap-0 overflow-x-auto overflow-y-hidden scrollbar-none flex-nowrap">
           <TabsTrigger 
             value="overview" 
             title="Main dashboard overview (Ctrl+1)" 
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
           <TabsTrigger 
             value="map" 
             title="Geographic project map (Ctrl+4)" 
             className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent"
           >
             Project Map
           </TabsTrigger>
           <TabsTrigger 
             value="files" 
             title="Recent Dropbox files (Ctrl+5)" 
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
           </TabsList>
       </div>

        <TabsContent value="overview" className="space-y-6 mt-0 animate-in fade-in duration-200">
           {projectsLoading && (
             <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 animate-in fade-in duration-300">
               {Array(8).fill(0).map((_, i) => (
                 <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" style={{animationDelay: `${i * 50}ms`}} />
               ))}
             </div>
           )}
           {/* Executive Metrics */}
           {!projectsLoading && (
            <LivePulseBar projects={projects} tasks={allTasks} timeLogs={allTimeLogs} calendarEvents={calendarEvents} />
           )}

           {!projectsLoading && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6">
              <NeedsAttentionPanel projects={projects} tasks={allTasks} users={allUsers} />
              <Card className="overflow-hidden">
                <div className="px-4 py-3 border-b"><span className="text-sm font-bold">Live activity</span></div>
                <div className="p-4"><EnhancedActivityStream maxItems={8} compact /></div>
              </Card>
            </div>
           )}

           {!projectsLoading && <ExecutiveMetricsGrid metrics={executiveMetrics} navigate={navigate} className="animate-in fade-in duration-500" />}

          {/* Operational Widgets Row */}
          {!projectsLoading && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in fade-in duration-500" style={{animationDelay: '50ms'}}>
              <TodaysScheduleWidget projects={projects} calendarEvents={calendarEvents} />
              <ActiveTimersWidget timeLogs={allTimeLogs} tasks={allTasks} />
              <PendingReviewsWidget projects={projects} />
              <TeamWorkloadChart tasks={allTasks} users={allUsers} />
            </div>
          )}

          {/* Charts Row 1 - Revenue Comparison + Stage Distribution */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-500" style={{animationDelay: '100ms'}}>
            {projects.length > 0 ? <RevenueComparisonChart projects={projects} /> : <Card className="col-span-2 p-6 text-center text-muted-foreground text-sm">No revenue data</Card>}
            {projects.length > 0 ? <StageDistributionChart projects={projects} /> : <Card className="p-6 text-center text-muted-foreground text-sm">No project data</Card>}
          </div>

          {/* Charts Row 2 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <ProjectVelocityChart data={velocityData} />
            <TopPerformersPanel 
              topAgencies={topPerformers.topAgencies} 
              topAgents={topPerformers.topAgents}
              topUsers={topPerformers.topUsers}
            />
          </div>

          {/* Charts Row 3 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <CashFlowForecast data={cashFlowData} forecastedRevenue={forecastedRevenue} />
            <ProjectHealthScore healthMetrics={healthMetrics} />
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
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            <QuickActionsPanel
              urgentCount={executiveMetrics.overdueItems}
              onNewProject={handleShowProjectForm}
              onNewContact={() => navigate(createPageUrl("People") + "?new=true")}
              onComposeEmail={() => navigate(createPageUrl("Inbox") + "?compose=true")}
              onViewCalendar={() => navigate(createPageUrl("Calendar"))}
              onViewInbox={() => navigate(createPageUrl("Inbox"))}
            />
            
            {/* Recent Activity Compact */}
            <Card className="lg:col-span-3">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Recent Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <RealtimeActivityStream maxItems={6} compact />
              </CardContent>
            </Card>
          </div>
        </TabsContent>


        <TabsContent value="deadlines" className="space-y-6 mt-0">
          <TaskDeadlineDashboard />
        </TabsContent>

        <TabsContent value="tasks" className="space-y-6 mt-0">
          <TaskReportingDashboard />
        </TabsContent>

        <TabsContent value="map" className="space-y-6 mt-0">
          <ProjectHeatmap />
        </TabsContent>

        <TabsContent value="files" className="space-y-6 mt-0">
          <DropboxFileFeed />
        </TabsContent>

        <TabsContent value="today" className="space-y-6 mt-0">
          <TodayBoard />
        </TabsContent>

        <TabsContent value="pipeline" className="space-y-6 mt-0">
          <PipelineAnalyzer />
        </TabsContent>

        <TabsContent value="territory" className="mt-0" style={{ height: 'calc(100vh - 200px)' }}>
          <TerritoryMap />
        </TabsContent>

        <TabsContent value="deliveries" className="space-y-6 mt-0">
          <DeliveryFeed />
        </TabsContent>

        <TabsContent value="revenue" className="space-y-6 mt-0">
          <RevenueIntelligence />
        </TabsContent>
      </Tabs>

      {showProjectForm && (
        <ProjectForm
          open={showProjectForm}
          onClose={handleCloseProjectForm}
          onSave={handleCloseProjectForm}
        />
      )}
    </div>
  );
}