import { useEntityList } from "@/components/hooks/useEntityData";

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.floor((seconds % 86400) / 3600);
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function getStatusColor(status) {
  switch (status) {
    case 'running':
      return { bg: 'bg-green-50', border: 'border-green-200', dot: 'bg-green-400', text: 'text-green-700' };
    case 'paused':
      return { bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-400', text: 'text-amber-700' };
    case 'completed':
      return { bg: 'bg-blue-50', border: 'border-blue-200', dot: 'bg-blue-400', text: 'text-blue-700' };
    default:
      return { bg: 'bg-gray-50', border: 'border-gray-200', dot: 'bg-gray-400', text: 'text-gray-700' };
  }
}

/**
 * Shared hook for loading effort logs from TaskTimeLog entity
 * Reads real-time from the same database table used by all effort components
 */
export function useEffortLogs(projectId) {
  const { data: timeLogs = [] } = useEntityList(
    "TaskTimeLog",
    "-created_date",
    1000,
    projectId ? (log) => log.project_id === projectId : null
  );

  // Group by parent session (task_id + user_id)
  const groupedLogs = timeLogs.reduce((acc, log) => {
    const key = `${log.task_id}_${log.user_id}`;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(log);
    return acc;
  }, {});

  return { timeLogs, groupedLogs };
}

export { formatDuration, getStatusColor };