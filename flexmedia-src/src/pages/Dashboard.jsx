import React, { useState, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSearchParams } from "react-router-dom";
import ProjectForm from "@/components/projects/ProjectForm";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { useDashboardStats } from "@/components/hooks/useDashboardStats";
import { formatDistanceToNow } from "date-fns";
import { toast } from "@/components/ui/use-toast";

const OperationsPulse = React.lazy(() => import('@/components/dashboard/OperationsPulse'));
const ProjectsTab = React.lazy(() => import('@/components/dashboard/ProjectsTab'));
const TasksTab = React.lazy(() => import('@/components/dashboard/TasksTab'));
const MediaTab = React.lazy(() => import('@/components/dashboard/MediaTab'));
const RevenueTab = React.lazy(() => import('@/components/dashboard/RevenueTab'));
const TeamTab = React.lazy(() => import('@/components/dashboard/TeamTab'));

const VALID_DASHBOARD_TABS = new Set(['pulse', 'projects', 'tasks', 'media', 'revenue', 'team']);

export default function Dashboard() {
  const [showProjectForm, setShowProjectForm] = useState(false);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: dashStats, computed_at, isError, error: statsError } = useDashboardStats();

  // Tab persistence via URL — defaults to "pulse", survives navigation
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

  // Keyboard shortcut: Ctrl/Cmd+N opens new project form
  useEffect(() => {
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'n') {
        e.preventDefault();
        setShowProjectForm(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+1-6 switch dashboard tabs
  useEffect(() => {
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tabMap = { '1': 'pulse', '2': 'projects', '3': 'tasks', '4': 'media', '5': 'revenue', '6': 'team' };
      if (tabMap[e.key]) { e.preventDefault(); handleDashboardTabChange(tabMap[e.key]); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleDashboardTabChange]);

  // Show toast when dashboard stats fail to load
  useEffect(() => {
    if (isError && statsError) {
      toast({ title: "Stats unavailable", description: "Dashboard stats failed to load. They will retry automatically.", variant: "destructive" });
    }
  }, [isError, statsError]);

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

  // Extract badge counts from cached stats (no extra fetch)
  const overdueCount = Number(dashStats?.tasks?.overdue_tasks) || 0;

  const tabTriggerClass =
    "data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none focus:ring-2 focus:ring-primary min-w-max px-4 py-3 rounded-none border-b-2 border-transparent hover:border-muted-foreground/30";

  return (
    <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6 lg:space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <LayoutDashboard className="h-7 w-7 text-primary" />
            Dashboard
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Overview of operations, projects, and team activity</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Updated {formatDistanceToNow(new Date(computed_at || Date.now()), { addSuffix: true })}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] })} title="Refresh stats">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            onClick={handleShowProjectForm}
            className="gap-2 shadow-sm hover:shadow-md transition-all focus:ring-2 focus:ring-primary focus:ring-offset-2 h-10"
            title="Create a new project (Ctrl+N)"
            aria-label="New project - Ctrl+N"
          >
            <Plus className="h-4 w-4" />
            New Project
          </Button>
        </div>
      </div>

      {/* Dashboard Tabs */}
      <React.Suspense fallback={<DashboardSkeleton />}>
        <Tabs value={activeTab} onValueChange={handleDashboardTabChange} className="space-y-4">
          <div className="sticky top-14 lg:top-16 z-10 bg-gradient-to-b from-background to-background/80 pb-2">
            <TabsList className="bg-muted/30 w-full justify-start border-b border-border/50 rounded-none h-auto p-0 gap-0 overflow-x-auto overflow-y-hidden scrollbar-none flex-nowrap -webkit-overflow-scrolling-touch" style={{ WebkitOverflowScrolling: 'touch' }}>
              <TabsTrigger value="pulse" className={tabTriggerClass}>Pulse</TabsTrigger>
              <TabsTrigger value="projects" className={tabTriggerClass}>Projects</TabsTrigger>
              <TabsTrigger value="tasks" className={tabTriggerClass}>
                Tasks
                {overdueCount > 0 && <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1">{overdueCount}</span>}
              </TabsTrigger>
              <TabsTrigger value="media" className={tabTriggerClass}>Media</TabsTrigger>
              <TabsTrigger value="revenue" className={tabTriggerClass}>Revenue</TabsTrigger>
              <TabsTrigger value="team" className={tabTriggerClass}>Team</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="pulse" className="space-y-6 mt-0">
            <ErrorBoundary fallbackLabel="Operations Pulse">
              <OperationsPulse onTabChange={handleDashboardTabChange} />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="projects" className="space-y-6 mt-0">
            <ErrorBoundary fallbackLabel="Projects">
              <ProjectsTab />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="tasks" className="space-y-6 mt-0">
            <ErrorBoundary fallbackLabel="Tasks">
              <TasksTab />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="media" className="space-y-6 mt-0">
            <ErrorBoundary fallbackLabel="Media">
              <MediaTab />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="revenue" className="space-y-6 mt-0">
            <ErrorBoundary fallbackLabel="Revenue">
              <RevenueTab />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="team" className="space-y-6 mt-0">
            <ErrorBoundary fallbackLabel="Team">
              <TeamTab />
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
