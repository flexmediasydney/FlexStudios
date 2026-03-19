import { useActiveTimers } from './ActiveTimersContext';
import { useEntityList } from '@/components/hooks/useEntityData';
import { AlertCircle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function ActiveTimersIndicator() {
  const { activeTimers } = useActiveTimers();
  const { data: tasks = [] } = useEntityList("ProjectTask");

  if (activeTimers.length === 0) return null;

  const taskMap = Object.fromEntries(tasks.map(t => [t.id, t.title]));

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="bg-red-50 border-2 border-red-400 rounded-lg p-3 shadow-lg animate-pulse">
        <div className="flex items-center gap-2 mb-2">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          <span className="font-semibold text-red-900">
            {activeTimers.length} timer{activeTimers.length !== 1 ? 's' : ''} running
          </span>
        </div>
        <div className="space-y-1">
          {activeTimers.map(timer => (
            <div key={timer.id} className="flex items-center gap-2 text-xs text-red-800 bg-red-100 px-2 py-1 rounded">
              <Clock className="h-3 w-3" />
              <span className="truncate">{taskMap[timer.task_id] || timer.task_id}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}