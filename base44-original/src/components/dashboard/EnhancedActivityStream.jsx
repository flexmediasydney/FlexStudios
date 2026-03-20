import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { CheckCircle2, AlertCircle, Zap, Clock, User, Camera, Package, ArrowRight, Loader2 } from 'lucide-react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import { formatDistanceToNow, isToday, format } from 'date-fns';

const ACTION_CONFIG = {
  status_change: { icon: Zap, color: 'text-purple-600', bg: 'bg-purple-100' },
  project_created: { icon: Camera, color: 'text-blue-600', bg: 'bg-blue-100' },
  project_delivered: { icon: Package, color: 'text-green-600', bg: 'bg-green-100' },
  task_added: { icon: CheckCircle2, color: 'text-cyan-600', bg: 'bg-cyan-100' },
  task_completed: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-100' },
  delete: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
  create: { icon: Zap, color: 'text-blue-600', bg: 'bg-blue-100' },
  default: { icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted' },
};

function getConfig(action) {
  return ACTION_CONFIG[action] || ACTION_CONFIG.default;
}

function relTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(fixTimestamp(dateStr));
    if (isToday(d)) return formatDistanceToNow(d, { addSuffix: true });
    return format(d, 'd MMM h:mm a');
  } catch { return ''; }
}

function ActivityItem({ activity }) {
  const config = getConfig(activity.action);
  const Icon = config.icon;

  return (
    <div className="flex gap-3 py-2.5 hover:bg-muted/30 rounded-lg px-2 transition-colors">
      <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5', config.bg)}>
        <Icon className={cn('h-3.5 w-3.5', config.color)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm">
          <span className="font-medium">{activity.description || activity.action}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {activity.user_name && (
            <span className="flex items-center gap-1"><User className="h-3 w-3" />{activity.user_name}</span>
          )}
          {activity.project_title && (
            <Link to={createPageUrl('ProjectDetails') + `?id=${activity.project_id}`}
              className="text-primary hover:underline truncate max-w-[200px]">
              {activity.project_title}
            </Link>
          )}
          <span className="flex items-center gap-1 shrink-0"><Clock className="h-3 w-3" />{relTime(activity.created_date)}</span>
        </div>
      </div>
    </div>
  );
}

export default function EnhancedActivityStream({ maxItems = 20, compact = false }) {
  const [liveItems, setLiveItems] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);

  // Load initial activities
  const { data: initialActivities = [], loading } = useEntityList('ProjectActivity', '-created_date', maxItems);

  useEffect(() => {
    if (!loading) setLoadingInitial(false);
  }, [loading]);

  // Subscribe for live updates
  useEffect(() => {
    const unsub = base44.entities.ProjectActivity.subscribe((event) => {
      if (event.type === 'create' && event.data) {
        setLiveItems(prev => [event.data, ...prev].slice(0, 10));
      }
    });
    return unsub;
  }, []);

  // Merge: live items first (newest), then initial, deduplicated
  const merged = useMemo(() => {
    const seenIds = new Set();
    const all = [];
    [...liveItems, ...initialActivities].forEach(item => {
      if (seenIds.has(item.id)) return;
      seenIds.add(item.id);
      all.push(item);
    });
    return all.slice(0, maxItems);
  }, [liveItems, initialActivities, maxItems]);

  if (loadingInitial) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-xs">Loading activity...</span>
      </div>
    );
  }

  if (merged.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Clock className="h-6 w-6 mx-auto mb-2 opacity-30" />
        <p className="text-xs">No recent activity</p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-0.5', compact ? 'max-h-[300px]' : 'max-h-[500px]', 'overflow-y-auto')}>
      {merged.map(activity => (
        <ActivityItem key={activity.id} activity={activity} />
      ))}
    </div>
  );
}