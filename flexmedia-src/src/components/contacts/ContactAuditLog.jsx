import React, { useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { Clock, User, ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

// Human-readable field labels
const FIELD_LABELS = {
  name: 'Name', email: 'Email', phone: 'Phone', title: 'Title',
  relationship_state: 'State', status: 'Status', source: 'Source',
  current_agency_id: 'Organisation', current_agency_name: 'Organisation',
  current_team_id: 'Team', current_team_name: 'Team',
  notes: 'Notes', discovery_call_notes: 'Discovery Notes',
  contact_frequency_days: 'Contact Frequency', value_potential: 'Value Potential',
  next_follow_up_date: 'Next Follow-up', last_contacted_at: 'Last Contacted',
  address: 'Address', onboarding_date: 'Onboarding Date',
  agency_name: 'Agency Name', agency_id: 'Agency',
  is_at_risk: 'At Risk', tags: 'Tags', media_needs: 'Media Needs',
  club_flex: 'Club Flex', became_active_date: 'Became Active',
  became_dormant_date: 'Became Dormant', reason_unqualified: 'Reason Unqualified',
};

const IGNORED_FIELDS = ['id', 'created_at', 'updated_at', 'created_date', 'updated_date'];

function formatFieldValue(val) {
  if (val === null || val === undefined || val === '') return '(empty)';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (Array.isArray(val)) return val.join(', ') || '(empty)';
  if (typeof val === 'string' && val.length > 80) return val.slice(0, 80) + '...';
  return String(val);
}

function groupByDate(items) {
  const groups = {};
  for (const item of items) {
    const d = new Date(item.created_at || item.created_date);
    let label;
    if (isToday(d)) label = 'Today';
    else if (isYesterday(d)) label = 'Yesterday';
    else label = format(d, 'EEEE, d MMMM yyyy');
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }
  return Object.entries(groups);
}

export default function ContactAuditLog({ entityType, entityId }) {
  const { data: allLogs = [], loading } = useEntityList('AuditLog', '-created_date', 500);

  const logs = useMemo(() =>
    allLogs.filter(l => l.entity_type === entityType && l.entity_id === entityId)
      .sort((a, b) => new Date(b.created_at || b.created_date) - new Date(a.created_at || a.created_date)),
    [allLogs, entityType, entityId]
  );

  const grouped = useMemo(() => groupByDate(logs), [logs]);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[1,2,3].map(i => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Clock className="h-10 w-10 mb-3 opacity-30" />
        <p className="text-sm font-medium">No changes recorded yet</p>
        <p className="text-xs mt-1">Edits and updates to this contact will be logged here automatically.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6 max-w-3xl">
      {grouped.map(([dateLabel, items]) => (
        <div key={dateLabel}>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 sticky top-0 bg-background py-1">{dateLabel}</h3>
          <div className="space-y-2">
            {items.map(log => {
              const actionIcon = log.action === 'create' ? Plus : log.action === 'delete' ? Trash2 : Pencil;
              const ActionIcon = actionIcon;
              const changes = (log.changed_fields || []).filter(c => !IGNORED_FIELDS.includes(c.field));
              const time = format(new Date(log.created_at || log.created_date), 'h:mm a');

              return (
                <div key={log.id} className="flex gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
                  <div className={cn(
                    "h-8 w-8 rounded-full flex items-center justify-center shrink-0",
                    log.action === 'create' ? "bg-green-100 text-green-600" :
                    log.action === 'delete' ? "bg-red-100 text-red-600" :
                    "bg-blue-100 text-blue-600"
                  )}>
                    <ActionIcon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-foreground">{log.user_name || 'System'}</span>
                      <Badge variant="outline" className="text-[10px] h-5">
                        {log.action === 'create' ? 'Created' : log.action === 'delete' ? 'Deleted' : 'Updated'}
                      </Badge>
                      <span className="text-xs text-muted-foreground ml-auto shrink-0">{time}</span>
                    </div>
                    {changes.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {changes.map((c, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-xs">
                            <span className="font-medium text-muted-foreground shrink-0 w-28 text-right">
                              {FIELD_LABELS[c.field] || c.field}
                            </span>
                            <span className="text-red-500/70 line-through truncate max-w-[120px]" title={formatFieldValue(c.old_value)}>
                              {formatFieldValue(c.old_value)}
                            </span>
                            <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                            <span className="text-green-600 font-medium truncate max-w-[120px]" title={formatFieldValue(c.new_value)}>
                              {formatFieldValue(c.new_value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {changes.length === 0 && log.action === 'create' && (
                      <p className="text-xs text-muted-foreground mt-1">Record created</p>
                    )}
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
