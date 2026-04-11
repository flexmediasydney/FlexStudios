import React from 'react';
import { TrendingUp, AlertCircle, DollarSign } from 'lucide-react';

export default function QuickStatsBar({ projects = [], tasks = [] }) {
  const totalProjects = projects.length;
  const totalRevenue = projects.reduce((sum, p) => sum + (p.calculated_price || p.price || 0), 0);
  
  const overdueTasks = tasks.filter(t => {
    if (t.is_completed || !t.due_date) return false;
    return new Date(t.due_date) < new Date();
  }).length;

  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <div className="bg-gradient-to-br from-blue-50 to-blue-100/50 border border-blue-200/50 rounded-lg p-4 shadow-xs">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="h-4 w-4 text-blue-600" />
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Projects</span>
        </div>
        <div className="text-2xl font-bold text-blue-900 tabular-nums">{totalProjects}</div>
        <p className="text-xs text-blue-600/70 mt-1">{totalProjects === 1 ? 'project' : 'projects'} total</p>
      </div>

      <div className="bg-gradient-to-br from-green-50 to-green-100/50 border border-green-200/50 rounded-lg p-4 shadow-xs">
        <div className="flex items-center gap-2 mb-1">
          <DollarSign className="h-4 w-4 text-green-600" />
          <span className="text-xs font-semibold text-green-600 uppercase tracking-wide">Revenue</span>
        </div>
        <div className="text-2xl font-bold text-green-900 tabular-nums">
          {totalRevenue >= 1000000 
            ? `$${(totalRevenue / 1000000).toFixed(1)}M`
            : totalRevenue >= 1000
            ? `$${(totalRevenue / 1000).toFixed(1)}k`
            : `$${totalRevenue.toFixed(0)}`
          }
        </div>
        <p className="text-xs text-green-600/70 mt-1">from all projects</p>
      </div>

      <div className={`bg-gradient-to-br ${overdueTasks > 0 ? 'from-red-50 to-red-100/50 border-red-200/50' : 'from-gray-50 to-gray-100/50 border-gray-200/50'} border rounded-lg p-4 shadow-xs`}>
      <div className="flex items-center gap-2 mb-1">
        <AlertCircle className={`h-4 w-4 ${overdueTasks > 0 ? 'text-red-600' : 'text-muted-foreground'}`} />
        <span className={`text-xs font-semibold ${overdueTasks > 0 ? 'text-red-600' : 'text-muted-foreground'} uppercase tracking-wide`}>Overdue</span>
      </div>
      <div className={`text-2xl font-bold tabular-nums ${overdueTasks > 0 ? 'text-red-900' : 'text-foreground'}`}>{overdueTasks}</div>
      <p className={`text-xs ${overdueTasks > 0 ? 'text-red-600/70' : 'text-muted-foreground/70'} mt-1`}>{overdueTasks === 1 ? 'task' : 'tasks'} overdue</p>
      </div>
    </div>
  );
}