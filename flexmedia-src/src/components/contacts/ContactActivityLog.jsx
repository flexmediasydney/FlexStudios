import React, { useMemo, useState } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import {
  Pencil, Plus, Trash2, Phone, Mail, Users, Calendar, FileText,
  MessageSquare, ArrowRight, Filter, Clock
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

const ACTIVITY_TYPES = {
  all: { label: 'All', icon: Clock },
  changes: { label: 'Changes', icon: Pencil },
  interactions: { label: 'Interactions', icon: Phone },
  notes: { label: 'Notes', icon: FileText },
  emails: { label: 'Emails', icon: Mail },
  changelog: { label: 'Changelog', icon: FileText },
};

export default function ContactActivityLog({ entityType, entityId, entityLabel, emailActivities = [], showChangelog = false }) {
  const [filter, setFilter] = useState('all');

  // Load all data sources
  const { data: allLogs = [] } = useEntityList('AuditLog', '-created_date', 500);
  const { data: allInteractions = [] } = useEntityList('InteractionLog', '-created_date', 200);
  const { data: allNotes = [] } = useEntityList('OrgNote', '-created_date', 200);

  // Filter to this entity
  const auditLogs = useMemo(() =>
    allLogs.filter(l => l.entity_type === entityType && l.entity_id === entityId),
    [allLogs, entityType, entityId]
  );

  const interactions = useMemo(() =>
    allInteractions.filter(l => l.entity_id === entityId && l.entity_type === (entityType === 'agent' ? 'Agent' : entityType === 'agency' ? 'Agency' : 'Team')),
    [allInteractions, entityId, entityType]
  );

  const notes = useMemo(() => {
    const field = entityType === 'agent' ? 'agent_id' : entityType === 'agency' ? 'agency_id' : 'team_id';
    return allNotes.filter(n => n[field] === entityId && !n.parent_note_id); // exclude replies
  }, [allNotes, entityId, entityType]);

  // Normalize all into unified timeline items
  const timeline = useMemo(() => {
    const items = [];

    // Audit log entries
    auditLogs.forEach(log => {
      items.push({
        id: `audit-${log.id}`,
        type: 'changes',
        timestamp: log.created_at || log.created_date,
        icon: log.action === 'create' ? Plus : log.action === 'delete' ? Trash2 : Pencil,
        iconColor: log.action === 'create' ? 'bg-green-100 text-green-600' : log.action === 'delete' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600',
        actor: log.user_name || 'System',
        title: log.action === 'create' ? 'Record created' : log.action === 'delete' ? 'Record deleted' : 'Details updated',
        details: (log.changed_fields || []).filter(c => !['id','created_at','updated_at','created_date','updated_date'].includes(c.field)),
        raw: log,
      });
    });

    // Interaction logs
    interactions.forEach(log => {
      const typeIcon = log.interaction_type?.includes('Call') ? Phone :
                       log.interaction_type?.includes('Email') ? Mail :
                       log.interaction_type?.includes('Meeting') ? Users : MessageSquare;
      items.push({
        id: `interaction-${log.id}`,
        type: 'interactions',
        timestamp: log.date_time || log.created_at || log.created_date,
        icon: typeIcon,
        iconColor: log.sentiment === 'Positive' ? 'bg-green-100 text-green-600' :
                   log.sentiment === 'Negative' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600',
        actor: log.user_name || 'Unknown',
        title: log.interaction_type || 'Interaction',
        summary: log.summary,
        details: log.details ? [{ field: 'details', new_value: log.details }] : [],
        raw: log,
      });
    });

    // Notes
    notes.forEach(note => {
      items.push({
        id: `note-${note.id}`,
        type: 'notes',
        timestamp: note.created_at || note.created_date,
        icon: FileText,
        iconColor: note.is_pinned ? 'bg-yellow-100 text-yellow-600' : 'bg-purple-100 text-purple-600',
        actor: note.author_name || 'Unknown',
        title: note.is_pinned ? 'Pinned note' : 'Note added',
        summary: (note.content || '').slice(0, 150) + ((note.content || '').length > 150 ? '...' : ''),
        raw: note,
      });
    });

    // Email activities
    emailActivities.forEach((ea, i) => {
      items.push({
        id: `email-${ea.id || i}`,
        type: 'emails',
        timestamp: ea.timestamp || ea.created_at || ea.date,
        icon: Mail,
        iconColor: 'bg-sky-100 text-sky-600',
        actor: ea.actor || ea.from_name || 'Email',
        title: ea.action || ea.subject || 'Email activity',
        summary: ea.summary || ea.snippet || '',
        raw: ea,
      });
    });

    // Sort by timestamp descending
    items.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return items;
  }, [auditLogs, interactions, notes, emailActivities]);

  // Apply filter — changelog tab is handled separately via ContactAuditLog,
  // so show the changes-type items (which are audit log entries) as its timeline
  const filtered = useMemo(() => {
    if (filter === 'all') return timeline;
    if (filter === 'changelog') return timeline.filter(t => t.type === 'changes');
    return timeline.filter(t => t.type === filter);
  }, [timeline, filter]);

  // Group by date — guard against null/invalid timestamps
  const grouped = useMemo(() => {
    const groups = {};
    for (const item of filtered) {
      if (!item.timestamp) continue;
      const d = new Date(item.timestamp);
      if (isNaN(d.getTime())) continue;
      let label;
      if (isToday(d)) label = 'Today';
      else if (isYesterday(d)) label = 'Yesterday';
      else label = format(d, 'EEEE, d MMMM yyyy');
      if (!groups[label]) groups[label] = [];
      groups[label].push(item);
    }
    return Object.entries(groups);
  }, [filtered]);

  // Count by type
  const counts = useMemo(() => ({
    all: timeline.length,
    changes: timeline.filter(t => t.type === 'changes').length,
    interactions: timeline.filter(t => t.type === 'interactions').length,
    notes: timeline.filter(t => t.type === 'notes').length,
    emails: timeline.filter(t => t.type === 'emails').length,
    changelog: timeline.filter(t => t.type === 'changes').length,
  }), [timeline]);

  // Field label map for readable names
  const FIELD_LABELS = {
    name: 'Name', email: 'Email', phone: 'Phone', title: 'Title',
    relationship_state: 'State', current_agency_name: 'Organisation',
    current_team_name: 'Team', notes: 'Notes', tags: 'Tags',
    address: 'Address', value_potential: 'Value', contact_frequency_days: 'Contact Frequency',
  };

  return (
    <div className="p-4 max-w-3xl">
      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4 pb-3 border-b overflow-x-auto">
        {Object.entries(ACTIVITY_TYPES).filter(([key]) => key !== 'changelog' || showChangelog).map(([key, { label, icon: Icon }]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap",
              filter === key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
            {counts[key] > 0 && (
              <span className={cn(
                "min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-bold",
                filter === key ? "bg-primary-foreground/20" : "bg-muted"
              )}>
                {counts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Clock className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No activity yet</p>
          <p className="text-xs mt-1">Activity for {entityLabel || 'this record'} will appear here</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([dateLabel, items]) => (
            <div key={dateLabel}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 sticky top-0 bg-background py-1 z-10">
                {dateLabel}
              </h3>
              <div className="space-y-2">
                {items.map(item => {
                  const Icon = item.icon;
                  const tsDate = new Date(item.timestamp);
                  const time = isNaN(tsDate.getTime()) ? '' : format(tsDate, 'h:mm a');
                  return (
                    <div key={item.id} className="flex gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
                      <div className={cn("h-8 w-8 rounded-full flex items-center justify-center shrink-0", item.iconColor)}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-foreground">{item.actor}</span>
                          <span className="text-muted-foreground">{item.title}</span>
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">{time}</span>
                        </div>
                        {item.summary && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.summary}</p>
                        )}
                        {item.type === 'changes' && item.details?.length > 0 && (
                          <div className="mt-1.5 space-y-0.5">
                            {item.details.slice(0, 5).map((c, i) => (
                              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                                <span className="font-medium text-muted-foreground w-24 text-right shrink-0">
                                  {FIELD_LABELS[c.field] || c.field}
                                </span>
                                {c.old_value && (
                                  <>
                                    <span className="text-red-400 line-through truncate max-w-[100px]">{String(c.old_value).slice(0, 40)}</span>
                                    <ArrowRight className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                  </>
                                )}
                                <span className="text-green-600 font-medium truncate max-w-[100px]">{String(c.new_value || '(empty)').slice(0, 40)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Changelog — no separate ContactAuditLog needed; the timeline
          already shows audit/change entries when changelog filter is active */}
    </div>
  );
}
