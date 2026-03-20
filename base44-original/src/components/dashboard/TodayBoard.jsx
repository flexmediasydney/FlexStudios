import { useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  Camera, Clock, MapPin, User, Building2, Package, CheckCircle2,
  AlertCircle, ArrowRight, Sunrise, Sun, Sunset, Film, FileText
} from 'lucide-react';
import { fixTimestamp, fmtDate } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import { isToday, isTomorrow, format, differenceInHours, parseISO } from 'date-fns';

const STAGE_COLORS = { pending_review: '#f59e0b', scheduled: '#3b82f6', onsite: '#eab308', uploaded: '#f97316', in_progress: '#7c3aed', ready_for_partial: '#6366f1', in_revision: '#d97706', delivered: '#10b981' };

function getProducts(project) {
  if (!project.products || !Array.isArray(project.products)) return [];
  return project.products.map(p => p.product_name || p.name || '').filter(Boolean);
}

function ShootCard({ project, users }) {
  const photographer = users?.find(u => u.id === project.photographer_id);
  const shootTime = project.shoot_time || (project.shoot_date?.includes('T') ? format(new Date(fixTimestamp(project.shoot_date)), 'h:mm a') : null);
  const products = getProducts(project);
  const hasDrone = products.some(p => /drone|aerial/i.test(p));
  const hasVideo = products.some(p => /video|film|cinema/i.test(p));
  const hasTwilight = products.some(p => /twilight|dusk|sunset/i.test(p));
  const stageColor = STAGE_COLORS[project.status] || '#94a3b8';

  return (
    <Link to={createPageUrl('ProjectDetails') + `?id=${project.id}`} className="block">
      <div className="flex gap-4 p-4 rounded-xl border hover:shadow-md hover:border-primary/30 transition-all group bg-card">
        <div className="flex flex-col items-center gap-1 w-16 shrink-0">
          {shootTime && <div className="text-sm font-bold">{shootTime}</div>}
          <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stageColor }} />
          <div className="text-[9px] text-muted-foreground text-center">{stageLabel(project.status)}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm group-hover:text-primary transition-colors">{project.title || project.property_address}</div>
          {project.property_address && project.title && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
              <MapPin className="h-3 w-3 shrink-0" />{project.property_address}
            </div>
          )}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {photographer && (
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-[9px] font-bold text-primary">
                  {photographer.full_name?.split(' ').map(w => w[0]).join('') || '?'}
                </div>
                <span className="text-xs font-medium">{photographer.full_name}</span>
              </div>
            )}
            {!photographer && <Badge variant="destructive" className="text-[9px] h-5">No photographer</Badge>}
            {project.agency_name && (
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Building2 className="h-3 w-3" />{project.agency_name}</span>
            )}
          </div>
          {products.length > 0 && (
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {hasDrone && <Badge className="text-[9px] bg-cyan-100 text-cyan-700 border-cyan-200 gap-1">Drone</Badge>}
              {hasVideo && <Badge className="text-[9px] bg-purple-100 text-purple-700 border-purple-200 gap-1"><Film className="h-2.5 w-2.5" />Video</Badge>}
              {hasTwilight && <Badge className="text-[9px] bg-orange-100 text-orange-700 border-orange-200 gap-1"><Sunset className="h-2.5 w-2.5" />Twilight</Badge>}
              {products.filter(p => !/drone|aerial|video|film|cinema|twilight|dusk|sunset/i.test(p)).slice(0, 3).map((p, i) => (
                <Badge key={i} variant="outline" className="text-[9px] h-5">{p}</Badge>
              ))}
            </div>
          )}
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity self-center shrink-0" />
      </div>
    </Link>
  );
}

function DeliveryRow({ project }) {
  const tasksTotal = project._taskCount || 0;
  const tasksComplete = project._taskComplete || 0;
  const pct = tasksTotal > 0 ? Math.round((tasksComplete / tasksTotal) * 100) : 0;

  return (
    <Link to={createPageUrl('ProjectDetails') + `?id=${project.id}`} className="block">
      <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors">
        <Package className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{project.title || project.property_address}</div>
          <div className="text-xs text-muted-foreground">{stageLabel(project.status)}{project.agency_name ? ` · ${project.agency_name}` : ''}</div>
        </div>
        {tasksTotal > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground w-8 text-right">{pct}%</span>
          </div>
        )}
        {project.status === 'ready_for_partial' && <Badge className="text-[9px] bg-green-100 text-green-700">Ready</Badge>}
      </div>
    </Link>
  );
}

export default function TodayBoard() {
  const { data: projects = [], loading: pLoading } = useEntityList('Project', '-shoot_date', 500);
  const { data: users = [] } = useEntityList('User');
  const { data: tasks = [] } = useEntityList('ProjectTask', '-due_date', 500);
  const { data: revisions = [] } = useEntityList('ProjectRevision', '-created_date', 200);

  const now = new Date();
  const todayStr = format(now, 'EEEE d MMMM yyyy');

  // Today's shoots
  const todayShoots = useMemo(() => projects.filter(p => {
    if (!p.shoot_date || p.status === 'delivered') return false;
    return isToday(new Date(fixTimestamp(p.shoot_date)));
  }).sort((a, b) => {
    const aTime = a.shoot_time || '09:00';
    const bTime = b.shoot_time || '09:00';
    return aTime.localeCompare(bTime);
  }), [projects]);

  // Tomorrow's shoots
  const tomorrowShoots = useMemo(() => projects.filter(p => {
    if (!p.shoot_date || p.status === 'delivered') return false;
    return isTomorrow(new Date(fixTimestamp(p.shoot_date)));
  }).sort((a, b) => (a.shoot_time || '09:00').localeCompare(b.shoot_time || '09:00')), [projects]);

  // Deliveries due today
  const deliveriesDue = useMemo(() => {
    const tasksByProject = {};
    tasks.forEach(t => {
      if (!t.project_id) return;
      if (!tasksByProject[t.project_id]) tasksByProject[t.project_id] = { total: 0, complete: 0 };
      tasksByProject[t.project_id].total++;
      if (t.is_completed) tasksByProject[t.project_id].complete++;
    });

    return projects.filter(p =>
      p.delivery_date && isToday(new Date(fixTimestamp(p.delivery_date))) && p.status !== 'delivered'
    ).map(p => ({
      ...p,
      _taskCount: tasksByProject[p.id]?.total || 0,
      _taskComplete: tasksByProject[p.id]?.complete || 0,
    }));
  }, [projects, tasks]);

  // Active revisions due today
  const revisionsDue = useMemo(() => revisions.filter(r =>
    r.status && !['completed', 'cancelled'].includes(r.status) &&
    r.due_date && isToday(new Date(fixTimestamp(r.due_date)))
  ), [revisions]);

  // Overdue revisions
  const stuckRevisions = useMemo(() => revisions.filter(r =>
    r.status === 'stuck' || (r.status && !['completed', 'cancelled'].includes(r.status) &&
    r.due_date && new Date(fixTimestamp(r.due_date)) < now && !isToday(new Date(fixTimestamp(r.due_date))))
  ), [revisions]);

  // Stats
  const todayPhotoCount = new Set(todayShoots.map(p => p.photographer_id).filter(Boolean)).size;

  if (pLoading) {
    return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-32 bg-muted animate-pulse rounded-xl" />)}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">{todayStr}</h2>
          <p className="text-xs text-muted-foreground">
            {todayShoots.length} shoot{todayShoots.length !== 1 ? 's' : ''} · {deliveriesDue.length} deliver{deliveriesDue.length !== 1 ? 'ies' : 'y'} due · {todayPhotoCount} photographer{todayPhotoCount !== 1 ? 's' : ''} active
          </p>
        </div>
      </div>

      {/* Today's shoots */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sunrise className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-bold">Today's shoots</span>
          <Badge variant="outline" className="text-[10px] h-5">{todayShoots.length}</Badge>
        </div>
        {todayShoots.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground border-dashed">No shoots scheduled for today</Card>
        ) : (
          <div className="space-y-2">
            {todayShoots.map(p => <ShootCard key={p.id} project={p} users={users} />)}
          </div>
        )}
      </div>

      {/* Deliveries due */}
      {deliveriesDue.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Package className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-bold">Deliveries due today</span>
            <Badge variant="outline" className="text-[10px] h-5">{deliveriesDue.length}</Badge>
          </div>
          <Card className="divide-y">
            {deliveriesDue.map(p => <DeliveryRow key={p.id} project={p} />)}
          </Card>
        </div>
      )}

      {/* Revision deadlines */}
      {(revisionsDue.length > 0 || stuckRevisions.length > 0) && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-bold">Revisions</span>
            {stuckRevisions.length > 0 && <Badge className="text-[9px] bg-red-100 text-red-700">{stuckRevisions.length} stuck</Badge>}
          </div>
          <Card className="divide-y">
            {stuckRevisions.map(r => (
              <div key={r.id} className="flex items-center gap-3 p-3 bg-red-50/30">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{r.title}</div>
                  <div className="text-xs text-muted-foreground">Stuck{r.due_date ? ` · Due ${fmtDate(r.due_date, 'd MMM')}` : ''}</div>
                </div>
                <Badge className="text-[9px] bg-red-100 text-red-700">Stuck</Badge>
              </div>
            ))}
            {revisionsDue.map(r => (
              <div key={r.id} className="flex items-center gap-3 p-3">
                <Clock className="h-4 w-4 text-amber-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{r.title}</div>
                  <div className="text-xs text-muted-foreground">Due today{r.assigned_to_name ? ` · ${r.assigned_to_name}` : ''}</div>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* Tomorrow preview */}
      {tomorrowShoots.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sun className="h-4 w-4 text-orange-400" />
            <span className="text-sm font-bold">Tomorrow</span>
            <Badge variant="outline" className="text-[10px] h-5">{tomorrowShoots.length} shoot{tomorrowShoots.length !== 1 ? 's' : ''}</Badge>
          </div>
          <div className="space-y-2 opacity-70">
            {tomorrowShoots.slice(0, 3).map(p => <ShootCard key={p.id} project={p} users={users} />)}
            {tomorrowShoots.length > 3 && (
              <div className="text-xs text-muted-foreground text-center py-2">+{tomorrowShoots.length - 3} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}