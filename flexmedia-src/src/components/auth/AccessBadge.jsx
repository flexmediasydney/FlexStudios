import { Lock, Unlock, Eye } from 'lucide-react';
import { useEntityAccess } from './useEntityAccess';

const STYLES = {
  edit: { icon: Unlock, color: 'text-green-600', bg: 'bg-green-50', label: 'Full access', tooltip: 'You can view and edit this section' },
  view: { icon: Eye, color: 'text-amber-600', bg: 'bg-amber-50', label: 'View only', tooltip: 'You can view but not make changes to this section' },
  none: { icon: Lock, color: 'text-red-600', bg: 'bg-red-50', label: 'No access', tooltip: 'You do not have permission to access this section' },
};

export default function AccessBadge({ entityType, className = '' }) {
  const { accessLevel } = useEntityAccess(entityType);
  const style = STYLES[accessLevel] || STYLES.none;
  const Icon = style.icon;

  if (accessLevel === 'edit') return null; // No badge needed for full access

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${style.bg} ${style.color} ${className}`}
      title={style.tooltip}
    >
      <Icon className="h-3 w-3" />
      {accessLevel === 'view' ? 'Read only' : 'Locked'}
    </span>
  );
}
