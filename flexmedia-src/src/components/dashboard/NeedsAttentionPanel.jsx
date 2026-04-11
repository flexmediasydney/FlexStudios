import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  AlertCircle, Clock, UserX, DollarSign, Package, AlertTriangle,
  ArrowRight, CheckCircle2, Zap, Mail, Camera, Timer, Activity
} from 'lucide-react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import { differenceInDays, differenceInHours, isToday, isTomorrow, format } from 'date-fns';

const SEVERITY = {
  critical: { color: 'border-l-red-500 bg-red-50/50', badge: 'bg-red-100 text-red-700', icon: AlertCircle },
  warning: { color: 'border-l-amber-500 bg-amber-50/50', badge: 'bg-amber-100 text-amber-700', icon: AlertTriangle },
  info: { color: 'border-l-blue-500 bg-blue-50/50', badge: 'bg-blue-100 text-blue-700', icon: Activity },
};

function AttentionItem({ severity, icon: Icon, title, detail, action, actionLabel }) {
  const sev = SEVERITY[severity] || SEVERITY.info;
  return (
    <div className={cn('flex items-start gap-3 p-3 rounded-lg border-l-4 transition-colors', sev.color)}>
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', severity === 'critical' ? 'text-red-600' : severity === 'warning' ? 'text-amber-600' : 'text-blue-600')} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>
      </div>
      {action && (
        <Link to={action} className="shrink-0">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
            {actionLabel || 'View'} <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      )}
    </div>
  );
}

export function LivePulseBar({ projects, tasks, timeLogs, calendarEvents }) {
  const now = new Date();

  const stats = useMemo(() => {
    const activeShoots = (calendarEvents || []).filter(e => {
      if (!e.start_time || !e.end_time) return false;
      const start = new Date(fixTimestamp(e.start_time));
      const end = new Date(fixTimestamp(e.end_time));
      return start <= now && end >= now && (e.event_source === 'tonomo' || e.project_id);
    }).length;

    const runningTimers = (timeLogs || []).filter(l => l.is_active && l.status === 'running').length;

    const overdueTasks = (tasks || []).filter(t =>
      !t.is_completed && !t.is_deleted && t.due_date && new Date(fixTimestamp(t.due_date)) < now
    ).length;

    const todayDeliveries = (projects || []).filter(p =>
      p.delivery_date && isToday(new Date(fixTimestamp(p.delivery_date))) && p.status !== 'delivered'
    ).length;

    const pendingReview = (projects || []).filter(p => p.status === 'pending_review').length;

    return { activeShoots, runningTimers, overdueTasks, todayDeliveries, pendingReview };
  }, [projects, tasks, timeLogs, calendarEvents, now]);

  const items = [
    stats.activeShoots > 0 && { icon: Camera, label: `${stats.activeShoots} shoot${stats.activeShoots > 1 ? 's' : ''} happening now`, color: 'text-green-600' },
    stats.runningTimers > 0 && { icon: Timer, label: `${stats.runningTimers} timer${stats.runningTimers > 1 ? 's' : ''} running`, color: 'text-blue-600' },
    stats.overdueTasks > 0 && { icon: AlertCircle, label: `${stats.overdueTasks} task${stats.overdueTasks > 1 ? 's' : ''} overdue`, color: 'text-red-600' },
    stats.todayDeliveries > 0 && { icon: Package, label: `${stats.todayDeliveries} deliver${stats.todayDeliveries > 1 ? 'ies' : 'y'} due today`, color: 'text-amber-600' },
    stats.pendingReview > 0 && { icon: Clock, label: `${stats.pendingReview} pending review`, color: 'text-purple-600' },
  ].filter(Boolean);

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-muted/30 rounded-lg border border-border/50 overflow-x-auto">
      <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5 shrink-0">
          <item.icon className={cn('h-3 w-3', item.color)} />
          <span className={cn('text-xs font-medium', item.color)}>{item.label}</span>
          {i < items.length - 1 && <span className="text-border ml-2">·</span>}
        </div>
      ))}
    </div>
  );
}

export default function NeedsAttentionPanel({ projects, tasks, users }) {
  const items = useMemo(() => {
    const now = new Date();
    const attention = [];
    const activeProjects = (projects || []).filter(p => !p.is_archived);

    // 1. Projects with shoot in 48h but no photographer
    activeProjects.forEach(p => {
      if (p.status === 'delivered' || !p.shoot_date) return;
      const shoot = new Date(fixTimestamp(p.shoot_date));
      const hoursUntil = differenceInHours(shoot, now);
      if (hoursUntil > 0 && hoursUntil < 48 && !p.photographer_id) {
        attention.push({
          severity: hoursUntil < 12 ? 'critical' : 'warning',
          icon: UserX,
          title: `No photographer: ${p.title || p.property_address}`,
          detail: `Shoot ${isToday(shoot) ? 'today' : isTomorrow(shoot) ? 'tomorrow' : `in ${Math.round(hoursUntil)}h`} — assign someone now`,
          action: createPageUrl('ProjectDetails') + `?id=${p.id}`,
          actionLabel: 'Assign',
          priority: 100 - hoursUntil,
        });
      }
    });

    // 2. Projects stuck in a stage too long (>5 days in non-terminal stage)
    activeProjects.forEach(p => {
      if (['delivered', 'pending_review', 'to_be_scheduled'].includes(p.status)) return;
      if (!p.last_status_change) return;
      const daysInStage = differenceInDays(now, new Date(fixTimestamp(p.last_status_change)));
      if (daysInStage > 5) {
        attention.push({
          severity: daysInStage > 10 ? 'critical' : 'warning',
          icon: Clock,
          title: `Stuck ${daysInStage}d in ${stageLabel(p.status)}`,
          detail: `${p.title || p.property_address}${p.agency_name ? ` · ${p.agency_name}` : ''}`,
          action: createPageUrl('ProjectDetails') + `?id=${p.id}`,
          actionLabel: 'Open',
          priority: 50 + daysInStage,
        });
      }
    });

    // 3. Overdue tasks (>24h past due)
    const overdueTasks = (tasks || []).filter(t =>
      !t.is_completed && !t.is_deleted && t.due_date && differenceInHours(now, new Date(fixTimestamp(t.due_date))) > 24
    );
    if (overdueTasks.length > 0) {
      const worst = overdueTasks.sort((a, b) => new Date(fixTimestamp(a.due_date)) - new Date(fixTimestamp(b.due_date)))[0];
      const daysOverdue = differenceInDays(now, new Date(fixTimestamp(worst.due_date)));
      attention.push({
        severity: overdueTasks.length > 5 ? 'critical' : 'warning',
        icon: AlertCircle,
        title: `${overdueTasks.length} task${overdueTasks.length > 1 ? 's' : ''} overdue`,
        detail: `Worst: "${worst.title}" (${daysOverdue}d overdue)${worst.assigned_to_name ? ` — ${worst.assigned_to_name}` : ''}`,
        action: createPageUrl('Projects'),
        actionLabel: 'View all',
        priority: 40 + overdueTasks.length,
      });
    }

    // 4. Unpaid invoices >14 days after delivery
    const unpaid = activeProjects.filter(p =>
      p.status === 'delivered' && p.payment_status !== 'paid' &&
      p.tonomo_delivered_at && differenceInDays(now, new Date(fixTimestamp(p.tonomo_delivered_at))) > 14
    );
    if (unpaid.length > 0) {
      const totalOwed = unpaid.reduce((s, p) => s + (p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0), 0);
      attention.push({
        severity: unpaid.length > 3 ? 'warning' : 'info',
        icon: DollarSign,
        title: `${unpaid.length} unpaid invoice${unpaid.length > 1 ? 's' : ''} ($${Math.round(totalOwed).toLocaleString()})`,
        detail: `Oldest: ${unpaid.sort((a, b) => new Date(fixTimestamp(a.tonomo_delivered_at)) - new Date(fixTimestamp(b.tonomo_delivered_at)))[0]?.title || 'Unknown'} — ${differenceInDays(now, new Date(fixTimestamp(unpaid[0]?.tonomo_delivered_at)))}d overdue`,
        action: createPageUrl('Projects'),
        actionLabel: 'View',
        priority: 30 + unpaid.length,
      });
    }

    // 5. Pending review projects
    const pendingReview = activeProjects.filter(p => p.status === 'pending_review');
    if (pendingReview.length > 0) {
      attention.push({
        severity: pendingReview.length > 3 ? 'warning' : 'info',
        icon: Clock,
        title: `${pendingReview.length} project${pendingReview.length > 1 ? 's' : ''} pending review`,
        detail: pendingReview.slice(0, 2).map(p => p.title || p.property_address).join(', ') + (pendingReview.length > 2 ? ` +${pendingReview.length - 2} more` : ''),
        action: createPageUrl('TonomoIntegrationDashboard'),
        actionLabel: 'Review',
        priority: 25,
      });
    }

    // 6. Projects ready for delivery (in ready_for_partial or past delivery date)
    const readyForDelivery = activeProjects.filter(p =>
      p.status === 'ready_for_partial' ||
      (p.delivery_date && isToday(new Date(fixTimestamp(p.delivery_date))) && !['delivered'].includes(p.status))
    );
    if (readyForDelivery.length > 0) {
      attention.push({
        severity: 'info',
        icon: Package,
        title: `${readyForDelivery.length} project${readyForDelivery.length > 1 ? 's' : ''} ready for delivery`,
        detail: readyForDelivery.slice(0, 2).map(p => p.title || p.property_address).join(', '),
        action: createPageUrl('Projects'),
        actionLabel: 'Deliver',
        priority: 20,
      });
    }

    // 7. Upcoming shoots today/tomorrow
    const upcomingShoots = activeProjects.filter(p => {
      if (!p.shoot_date || p.status === 'delivered') return false;
      const d = new Date(fixTimestamp(p.shoot_date));
      return isToday(d) || isTomorrow(d);
    });
    if (upcomingShoots.length > 0) {
      const todayCount = upcomingShoots.filter(p => isToday(new Date(fixTimestamp(p.shoot_date)))).length;
      const tmrwCount = upcomingShoots.length - todayCount;
      attention.push({
        severity: 'info',
        icon: Camera,
        title: `${todayCount > 0 ? `${todayCount} shoot${todayCount > 1 ? 's' : ''} today` : ''}${todayCount > 0 && tmrwCount > 0 ? ', ' : ''}${tmrwCount > 0 ? `${tmrwCount} tomorrow` : ''}`,
        detail: upcomingShoots.slice(0, 3).map(p => `${p.title || p.property_address}${p.photographer_name ? ` (${p.photographer_name})` : ''}`).join(' · '),
        action: createPageUrl('Calendar'),
        actionLabel: 'Calendar',
        priority: 15,
      });
    }

    return attention.sort((a, b) => b.priority - a.priority);
  }, [projects, tasks, users]);

  if (items.length === 0) {
    return (
      <Card className="p-6 text-center border-dashed">
        <CheckCircle2 className="h-8 w-8 text-green-500/50 mx-auto mb-2" />
        <p className="text-sm font-medium text-green-700">All clear</p>
        <p className="text-xs text-muted-foreground mt-1">No items need attention right now</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-bold">Needs Attention</span>
          <Badge variant="outline" className="text-[10px] h-5">{items.length} item{items.length !== 1 ? 's' : ''}</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {items.filter(i => i.severity === 'critical').length > 0 && (
            <Badge className="text-[10px] h-5 bg-red-100 text-red-700 border border-red-200 gap-0.5">
              <AlertCircle className="h-2.5 w-2.5" />
              {items.filter(i => i.severity === 'critical').length} critical
            </Badge>
          )}
          {items.filter(i => i.severity === 'warning').length > 0 && (
            <Badge className="text-[10px] h-5 bg-amber-100 text-amber-700 border border-amber-200 gap-0.5">
              <AlertTriangle className="h-2.5 w-2.5" />
              {items.filter(i => i.severity === 'warning').length} warning
            </Badge>
          )}
          {items.filter(i => i.severity === 'info').length > 0 && (
            <Badge className="text-[10px] h-5 bg-blue-100 text-blue-700 border border-blue-200 gap-0.5">
              {items.filter(i => i.severity === 'info').length} info
            </Badge>
          )}
        </div>
      </div>
      <div className="divide-y max-h-[400px] overflow-y-auto">
        {items.map((item, i) => (
          <AttentionItem key={i} {...item} />
        ))}
      </div>
    </Card>
  );
}