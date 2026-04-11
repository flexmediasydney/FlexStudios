import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Clock, Users, TrendingUp, CheckCircle, AlertTriangle } from 'lucide-react';

export default function EmployeeUtilizationRulebook() {
  const rules = [
    {
      title: 'Time Logging via Task Timer',
      description: 'Staff log actual time spent on tasks using the TaskTimeLogger component integrated into task details.',
      details: [
        'Timer starts with "Start" button, can be paused/resumed, and finished with "Finish" button',
        'Each time log entry records: start_time, end_time, total_seconds, user, role, and task reference',
        'Multiple time logs can be created for the same task (resume after finishing adds a new log)',
        'time logs can only be completed in "completed" status after being finished'
      ],
      icon: Clock,
      color: 'blue'
    },
    {
      title: 'Team Task Takeover',
      description: 'When a task is assigned to a team (not an individual), users can take over the task and reassign it.',
      details: [
        'If task is assigned to a team, system detects assigned_to_team_id exists but assigned_to is null',
        'Clicking "Start" on a team-assigned task shows takeover confirmation dialog',
        'Upon confirmation, task is automatically reassigned from team to current user',
        'User becomes the individual assignee, task ownership is transferred'
      ],
      icon: Users,
      color: 'purple'
    },
    {
      title: 'Effort Calculation by Role',
      description: 'Estimated effort comes from product/package templates and is broken down by role.',
      details: [
        'Each product/package has standard and premium tiers with role-specific times (photographer, videographer, image_editor, video_editor, admin)',
        'Estimated time = sum of all role times from products/packages selected on the project',
        'Estimated effort is stored in ProjectEffort entity with breakdown by role',
        'Photographers/videographers: effort = shoot package duration (onsite work)',
        'Image/video editors: effort = editing time hours from templates'
      ],
      icon: TrendingUp,
      color: 'green'
    },
    {
      title: 'Utilization Percentage Calculation',
      description: 'Measures how actual logged time compares to estimated effort for a period.',
      details: [
        'Formula: (actual_seconds / estimated_seconds) × 100',
        'Tracked per employee, per period (day/week/month)',
        'Status levels: underutilized (<80%), balanced (80-120%), overutilized (>120%)',
        'Aggregated by team for team-level insights'
      ],
      icon: CheckCircle,
      color: 'amber'
    },
    {
      title: 'Periodic Aggregation',
      description: 'Staff utilization is aggregated by configured periods.',
      details: [
        'Periods: day (calendar day), week (ISO week), month (calendar month)',
        'EmployeeUtilization records store: estimated_seconds, actual_seconds, utilization_percent, status',
        'period_date marks the start of each period',
        'Aggregation includes all time logs that fall within the period window'
      ],
      icon: Clock,
      color: 'indigo'
    },
    {
      title: 'Effort Logging on Project Upload',
      description: 'When a project moves to "uploaded" status, onsite effort is automatically logged.',
      details: [
        'Function logOnsiteEffortOnUpload is triggered automatically',
        'Logs effort for photographers and videographers based on shoot package duration',
        'Creates TaskTimeLog entries with status "completed" for onsite staff',
        'Captures the project shoot date as timestamp for effort attribution'
      ],
      icon: AlertTriangle,
      color: 'orange'
    },
    {
      title: 'Task Time Logger States',
      description: 'Timer maintains strict state transitions for reliable time tracking.',
      details: [
        'States: running (actively timing), paused (timer stopped but not ended), finished (completed log)',
        '"Finish" button stops the timer and marks time log as completed',
        '"Continue" button creates a new time log to add more time after finishing',
        'Only one log can be active (running or paused) at a time per task'
      ],
      icon: AlertCircle,
      color: 'red'
    },
    {
      title: 'Timer Defense: Global Indicator',
      description: 'Always-visible awareness of active running timers across the app.',
      details: [
        'Persistent indicator appears in bottom-right corner when any timer is running',
        'Shows total count of active timers: "2 timers running"',
        'Clicking indicator reveals which tasks/projects have running timers',
        'Animated pulse effect draws attention to active timers',
        'Real-time updates: instantly reflects new timers or completed ones'
      ],
      icon: Clock,
      color: 'red'
    },
    {
      title: 'Timer Defense: Project-Level Banner',
      description: 'Project detail page displays prominent alert when tasks have running timers.',
      details: [
        'Red-bordered banner appears at top of project details when active timers exist',
        'Lists each user/role with an active timer on the project',
        'Shows timer count per user: "John Doe: 2 timers"',
        'Banner remains visible until all timers are stopped or finished',
        'Makes it impossible to miss active tracking on current project'
      ],
      icon: AlertTriangle,
      color: 'orange'
    },
    {
      title: 'Timer Defense: 30-Minute Auto-Pause',
      description: 'Automatic inactivity detection prevents forgotten timers.',
      details: [
        'Timer monitors page activity: clicks, inputs, focus changes',
        'If no activity detected for 30 minutes, timer automatically pauses',
        'Paused state: timer frozen, log status changes to "paused", confirmation dialog surfaces',
        'Dialog message: "Timer Auto-Paused — Your timer has been automatically paused due to 30 minutes of inactivity"',
        'User must manually resume or finish — timer never silently continues',
        'Activity clock resets whenever user resumes, starts, or interacts with timer controls'
      ],
      icon: Clock,
      color: 'red'
    },
    {
      title: 'Team Assignment Detection',
      description: 'System identifies team-assigned tasks vs individual assignments.',
      details: [
        'Team assignment: assigned_to_team_id populated, assigned_to is null',
        'Individual assignment: assigned_to populated with user ID',
        'Both fields can have team_name and user_name cached for display',
        'System prevents double-assignment (either team OR individual, not both)'
      ],
      icon: Users,
      color: 'cyan'
    }
  ];

  const colorClasses = {
    blue: 'border-l-blue-300 bg-blue-50',
    purple: 'border-l-purple-300 bg-purple-50',
    green: 'border-l-green-300 bg-green-50',
    amber: 'border-l-amber-300 bg-amber-50',
    indigo: 'border-l-indigo-300 bg-indigo-50',
    orange: 'border-l-orange-300 bg-orange-50',
    red: 'border-l-red-300 bg-red-50',
    cyan: 'border-l-cyan-300 bg-cyan-50'
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Staff Utilization Rulebook</h2>
        <p className="text-muted-foreground">
          Complete reference for how time tracking, effort estimation, timer defense, and utilization calculation work.
        </p>
      </div>

      <div className="grid gap-4">
        {rules.map((rule, idx) => {
          const Icon = rule.icon;
          return (
            <Card key={idx} className={`border-l-4 ${colorClasses[rule.color]}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start gap-3">
                  <Icon className={`h-5 w-5 mt-1 flex-shrink-0 text-${rule.color}-600`} />
                  <div className="flex-1">
                    <CardTitle className="text-base">{rule.title}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">{rule.description}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="space-y-2">
                  {rule.details.map((detail, i) => (
                    <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                      <span className="text-xs mt-1 flex-shrink-0">•</span>
                      <span>{detail}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}