import React, { useMemo } from 'react';
import {
  Mail, Star, Lock, Users, Link2, Send, Inbox, Check, Archive, Trash2
} from 'lucide-react';
import { formatRelative, fixTimestamp } from '@/components/utils/dateUtils';

const ACTION_CONFIG = {
  sent: { icon: Send, color: 'text-blue-500', label: 'Email sent' },
  opened: { icon: Mail, color: 'text-purple-500', label: 'Email opened' },
  replied: { icon: Mail, color: 'text-blue-500', label: 'Email replied' },
  star_toggled: { icon: Star, color: 'text-amber-500', label: 'Email starred' },
  visibility_toggled: { icon: Users, color: 'text-green-500', label: 'Visibility changed' },
  linked: { icon: Link2, color: 'text-blue-600', label: 'Linked to project' },
  archived: { icon: Archive, color: 'text-gray-500', label: 'Email archived' },
  deleted: { icon: Trash2, color: 'text-red-500', label: 'Email deleted' },
};

/**
 * EmailActivityLog
 * 
 * Formats email activity events for display in Activity tabs.
 * Integrates email actions into the unified activity feed.
 */
export default function EmailActivityLog({
  emailActivities = [],
  entityLabel = 'Entity',
}) {
  if (emailActivities.length === 0) {
    return <p className="text-sm text-muted-foreground">No email activity yet</p>;
  }

  return (
    <div className="space-y-3">
      {emailActivities.map((activity, idx) => {
        const config = ACTION_CONFIG[activity.action] || {
          icon: Mail,
          color: 'text-gray-500',
          label: activity.action,
        };
        const Icon = config.icon;

        return (
          <div key={`${activity.action}-${idx}`} className="flex gap-3 text-sm">
            <Icon className={`h-4 w-4 ${config.color} flex-shrink-0 mt-0.5`} />
            <div className="flex-1 min-w-0">
              <p className="text-foreground font-medium">{config.label}</p>
              {activity.data?.subject && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {activity.data.subject}
                </p>
              )}
              {activity.timestamp && (
                <p className="text-xs text-muted-foreground mt-1">
                  {formatRelative(fixTimestamp(activity.timestamp))}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}