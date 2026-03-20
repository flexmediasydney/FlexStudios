import React, { useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { Eye, Edit, Trash2, Plus } from 'lucide-react';
import { fixTimestamp, fmtDate } from '@/components/utils/dateUtils';

const ACTION_ICONS = {
  create: { icon: Plus, color: 'bg-green-100 text-green-700' },
  update: { icon: Edit, color: 'bg-blue-100 text-blue-700' },
  delete: { icon: Trash2, color: 'bg-red-100 text-red-700' },
};

const ENTITY_TYPE_LABELS = {
  agency: 'Organisation',
  agent: 'Person',
  team: 'Team',
};

export default function Org2AuditLog({ agencyId, agents = [], teams = [] }) {
  // Build sets of team and agent IDs belonging to this agency for fast lookup
  const teamIds = useMemo(() => new Set(teams.map(t => t.id)), [teams]);
  const agentIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);

  const auditLogFilter = React.useCallback(
    (e) => {
      if (e.entity_type === 'agency' && e.entity_id === agencyId) return true;
      if (e.entity_type === 'team' && teamIds.has(e.entity_id)) return true;
      if (e.entity_type === 'agent' && agentIds.has(e.entity_id)) return true;
      return false;
    },
    [agencyId, teamIds, agentIds]
  );

  const { data: auditLogs = [], loading } = useEntityList(
    'AuditLog',
    '-created_date',
    200,
    auditLogFilter
  );

  const groupedByDate = useMemo(() => {
    const groups = {};
    const sorted = [...auditLogs].sort(
      (a, b) => new Date(fixTimestamp(b.created_date)) - new Date(fixTimestamp(a.created_date))
    );
    sorted.forEach(log => {
      const date = fmtDate(log.created_date);
      if (!groups[date]) groups[date] = [];
      groups[date].push(log);
    });
    // Return entries sorted by date descending
    return Object.entries(groups).sort(
      ([a], [b]) => new Date(b.split('/').reverse().join('-')) - new Date(a.split('/').reverse().join('-'))
    );
  }, [auditLogs]);

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 pb-6 text-center">
          <div className="animate-spin h-6 w-6 border-2 border-primary/20 border-t-primary rounded-full mx-auto" />
        </CardContent>
      </Card>
    );
  }

  if (auditLogs.length === 0) {
    return (
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-6 pb-6 text-center">
          <p className="text-muted-foreground text-sm">No changes recorded yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {groupedByDate.map(([date, logs]) => (
        <div key={date}>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 py-2 bg-muted/40 rounded">
            {date}
          </div>
          <div className="space-y-2 mt-2">
            {logs.map(log => {
              const ActionIcon = ACTION_ICONS[log.action]?.icon;
              const actionColor = ACTION_ICONS[log.action]?.color || 'bg-gray-100 text-gray-700';
              const entityLabel = ENTITY_TYPE_LABELS[log.entity_type] || log.entity_type;

              return (
                <div key={log.id} className="p-3 border rounded-lg bg-card hover:bg-muted/20 transition-colors">
                  <div className="flex items-start gap-3">
                    {ActionIcon && (
                      <div className={`p-1.5 rounded-md shrink-0 ${actionColor}`}>
                        <ActionIcon className="h-3.5 w-3.5" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-xs capitalize shrink-0">
                          {log.action}
                        </Badge>
                        {log.entity_type !== 'agency' && (
                          <Badge variant="secondary" className="text-xs shrink-0">
                            {entityLabel}
                          </Badge>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(fixTimestamp(log.created_date)), { addSuffix: true })}
                        </p>
                      </div>
                      <p className="text-sm text-foreground mb-1">
                        <span className="font-medium">{log.user_name}</span>
                        {log.entity_name && log.entity_type !== 'agency' && (
                          <span className="text-muted-foreground"> · {log.entity_name}</span>
                        )}
                        {log.changed_fields?.length > 0 && (
                          <span className="text-muted-foreground">
                            {' '}updated {log.changed_fields.map(f => f.field).join(', ')}
                          </span>
                        )}
                      </p>

                      {log.changed_fields?.length > 0 && (
                        <div className="space-y-1 text-xs">
                          {log.changed_fields.slice(0, 5).map((field, idx) => (
                            <div key={idx} className="p-1.5 bg-muted/50 rounded flex items-start gap-2">
                              <span className="font-medium text-foreground shrink-0">{field.field}:</span>
                              <div className="flex items-center gap-1 flex-1 min-w-0">
                                {field.old_value && (
                                  <span className="text-red-600 line-through truncate max-w-[120px]">{field.old_value}</span>
                                )}
                                {field.old_value && field.new_value && (
                                  <span className="text-muted-foreground shrink-0">→</span>
                                )}
                                {field.new_value && (
                                  <span className="text-green-600 font-medium truncate max-w-[120px]">{field.new_value}</span>
                                )}
                              </div>
                            </div>
                          ))}
                          {log.changed_fields.length > 5 && (
                            <p className="text-[10px] text-muted-foreground pl-1">+{log.changed_fields.length - 5} more fields</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}