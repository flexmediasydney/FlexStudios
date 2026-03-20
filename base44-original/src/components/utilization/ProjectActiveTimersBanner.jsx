import { useEntityList } from '@/components/hooks/useEntityData';
import { AlertTriangle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function ProjectActiveTimersBanner({ projectId }) {
  const { data: timeLogs = [] } = useEntityList('TaskTimeLog', null, null, 
    (log) => log.project_id === projectId && log.is_active && log.status === 'running'
  );

  if (timeLogs.length === 0) return null;

  // Group by user
  const byUser = {};
  timeLogs.forEach(log => {
    if (!byUser[log.user_id]) {
      byUser[log.user_id] = { name: log.user_name, count: 0, logs: [] };
    }
    byUser[log.user_id].count += 1;
    byUser[log.user_id].logs.push(log);
  });

  return (
    <div className="mb-4 p-4 bg-red-50 border-2 border-red-300 rounded-lg">
      <div className="flex items-center gap-3 mb-3">
        <AlertTriangle className="h-6 w-6 text-red-600 flex-shrink-0 animate-pulse" />
        <div>
          <h3 className="font-bold text-red-900">Active Timers Running</h3>
          <p className="text-sm text-red-800">{timeLogs.length} task{timeLogs.length !== 1 ? 's' : ''} with running timers</p>
        </div>
      </div>

      <div className="space-y-2 ml-9">
        {Object.entries(byUser).map(([userId, userData]) => (
          <div key={userId} className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-red-600 flex-shrink-0" />
            <span className="text-sm font-medium text-red-900">{userData.name}</span>
            <Badge variant="destructive" className="ml-auto">
              {userData.count} timer{userData.count !== 1 ? 's' : ''}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}