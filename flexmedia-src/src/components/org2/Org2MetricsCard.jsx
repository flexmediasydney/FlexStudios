import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { format, startOfMonth, endOfMonth, parseISO, differenceInDays } from 'date-fns';

export default function Org2MetricsCard({ label, icon: Icon, color, mainValue, subValue, detailsRender }) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Card className="hover:shadow-md transition-shadow cursor-pointer">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-medium">{label}</p>
                <p className="text-2xl font-bold mt-1">{mainValue}</p>
                {subValue && <p className="text-xs text-muted-foreground mt-1">{subValue}</p>}
              </div>
              <div className={`p-2 rounded-md ${color} shrink-0`}>
                <Icon className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      </HoverCardTrigger>
      <HoverCardContent className="w-[340px] max-h-[460px] overflow-y-auto" side="right" align="start">
        {detailsRender()}
      </HoverCardContent>
    </HoverCard>
  );
}

// Utility to calculate metrics - NOW ACCEPTS TASKS AND REVISIONS ARRAYS
export function calculateMetrics(projects, projectTasks = [], projectRevisions = [], taskTimeLogs = []) {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  // Paid vs Unpaid
  const paidProjects = projects.filter(p => p.payment_status === 'paid');
  const unpaidProjects = projects.filter(p => p.payment_status === 'unpaid');
  const paidRevenue = paidProjects.reduce((s, p) => s + (Number(p.calculated_price) || Number(p.price) || 0), 0);
  const unpaidRevenue = unpaidProjects.reduce((s, p) => s + (Number(p.calculated_price) || Number(p.price) || 0), 0);

  // This month — use created_date (when the project was created, not when shooting was scheduled)
  const thisMonthProjects = projects.filter(p => {
    if (!p.created_date) return false;
    try {
      const date = parseISO(p.created_date);
      return date >= monthStart && date <= monthEnd;
    } catch { return false; }
  });
  const thisMonthRevenue = thisMonthProjects.reduce((s, p) => s + (Number(p.calculated_price) || Number(p.price) || 0), 0);

  // Turnaround times (delivered projects with valid dates)
  const projectsWithBothDates = projects.filter(p => {
    if (p.status !== 'delivered' || !p.shooting_started_at || !p.delivery_date) return false;
    try { parseISO(p.shooting_started_at); parseISO(p.delivery_date); return true; } catch { return false; }
  });
  const turnaroundDays = projectsWithBothDates.map(p => {
    const shootDate = parseISO(p.shooting_started_at);
    const deliveryDate = parseISO(p.delivery_date);
    return Math.max(0, differenceInDays(deliveryDate, shootDate));
  });
  const avgTurnaround = turnaroundDays.length > 0
    ? Math.round((turnaroundDays.reduce((a, b) => a + b, 0) / turnaroundDays.length) * 10) / 10
    : 0;
  const minTurnaround = turnaroundDays.length > 0 ? Math.min(...turnaroundDays) : 0;
  const maxTurnaround = turnaroundDays.length > 0 ? Math.max(...turnaroundDays) : 0;

  // Effort aggregation: sum TaskTimeLog.total_seconds (includes manual entries)
  // falling back to task.total_effort_logged if no time logs present
  const projectIds = projects.map(p => p.id);

  // Effort from completed time logs, filtered by log date range
  const getEffortFromLogsInDateRange = (projectIdSet, startDate = null, endDate = null) => {
    const logs = taskTimeLogs.filter(l => {
      if (!projectIdSet.has(l.project_id)) return false;
      if (l.status !== 'completed') return false;
      if (startDate || endDate) {
        try {
          const logDate = l.created_date ? parseISO(l.created_date) : null;
          if (!logDate) return false;
          if (startDate && logDate < startDate) return false;
          if (endDate && logDate > endDate) return false;
        } catch { return false; }
      }
      return true;
    });
    if (logs.length > 0) {
      return logs.reduce((total, l) => total + (l.total_seconds || 0), 0);
    }
    // Fallback to task-level: filter tasks whose last update is in range, exclude running timers
    // We only use total_effort_logged when there are no time logs at all for these projects
    const hasAnyTimeLogs = taskTimeLogs.some(l => projectIdSet.has(l.project_id) && l.status === 'completed');
    if (hasAnyTimeLogs) return 0; // logs exist but none in range — don't double-count
    return projectTasks
      .filter(t => projectIdSet.has(t.project_id) && !t.is_deleted)
      .reduce((total, t) => {
        // total_effort_logged can include running timer seconds; use completed logs sum if available
        return total + (t.total_effort_logged || 0);
      }, 0);
  };

  const allProjectIds = new Set(projectIds);
  const totalEffort = getEffortFromLogsInDateRange(allProjectIds);
  
  // Week: last 7 days — filter by log created_date, not project status change
  const weekThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weekEffort = getEffortFromLogsInDateRange(allProjectIds, weekThreshold, null);
  
  // Month: current month — filter by log created_date
  const monthEffort = getEffortFromLogsInDateRange(allProjectIds, monthStart, monthEnd);

  // Revisions/Requests aggregation FROM ProjectRevision entities
  const revisionsCount = projectRevisions.length;
  const completedRevisions = projectRevisions.filter(r => r.updated_date && r.created_date);

  return {
    paidCount: paidProjects.length,
    paidRevenue,
    unpaidCount: unpaidProjects.length,
    unpaidRevenue,
    thisMonthCount: thisMonthProjects.length,
    thisMonthRevenue,
    avgTurnaround,
    minTurnaround,
    maxTurnaround,
    avgRequestTurnaround: 0,
    totalEffort,
    weekEffort,
    monthEffort,
    projectsWithRequestsCount: revisionsCount,
    projectsWithoutRequestsCount: Math.max(0, projects.length - revisionsCount),
    changeRequestsCount: 0,
    revisionsCount,
    projectsWithBothDatesCount: projectsWithBothDates.length,
    completedRevisionsCount: completedRevisions.length,
  };
}