import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronUp, MessageCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { TYPE_META, SEVERITY_META } from './feedbackConstants';

/**
 * Single kanban/list card. Presentation only — voting + click are wired by the parent.
 */
function InitialBadge({ name }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  return (
    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center flex-shrink-0">
      <span className="text-[9px] font-bold text-primary">{initials}</span>
    </div>
  );
}

export default function FeedbackCard({
  item,
  voted,
  onClick,
  onToggleVote,
  isDragging,
}) {
  const type = TYPE_META[item.type] || TYPE_META.bug;
  const severity = SEVERITY_META[item.severity] || SEVERITY_META.medium;

  const createdAt = item.created_at || item.created_date;
  let relativeTime = '';
  try {
    if (createdAt) relativeTime = formatDistanceToNow(new Date(createdAt), { addSuffix: true });
  } catch { /* ignore */ }

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(item);
        }
      }}
      className={cn(
        'cursor-pointer hover:shadow-md transition-shadow duration-150 p-3 space-y-2 border bg-card',
        isDragging && 'shadow-xl ring-2 ring-primary/40'
      )}
      aria-label={`Feedback: ${item.title}`}
    >
      {/* Title + severity dot */}
      <div className="flex items-start gap-2">
        <span
          className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-1.5', severity.dot)}
          title={`Severity: ${severity.label}`}
          aria-label={`Severity: ${severity.label}`}
        />
        <h4 className="text-xs font-semibold leading-snug line-clamp-2 flex-1" title={item.title}>
          {item.title}
        </h4>
      </div>

      {/* Type + area */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 font-medium border', type.badge)}>
          {type.label}
        </Badge>
        {item.area && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
            {item.area}
          </span>
        )}
      </div>

      {/* Footer: votes + comments + author */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground pt-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleVote?.(item);
            }}
            className={cn(
              'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 transition-colors border',
              voted
                ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
                : 'border-transparent hover:bg-muted hover:text-foreground'
            )}
            title={voted ? 'Remove my vote' : 'Upvote'}
            aria-pressed={voted}
            aria-label={voted ? 'Remove vote' : 'Upvote'}
          >
            <ChevronUp className="h-3 w-3" />
            <span className="tabular-nums font-semibold">{item.vote_count || 0}</span>
          </button>
          <span className="inline-flex items-center gap-0.5">
            <MessageCircle className="h-3 w-3" />
            <span className="tabular-nums">{item.comment_count || 0}</span>
          </span>
        </div>
        <div className="flex items-center gap-1 min-w-0">
          <InitialBadge name={item.created_by_name} />
          <span className="truncate max-w-[110px]" title={item.created_by_name || item.created_by_email || 'Unknown'}>
            {item.created_by_name || 'Unknown'}
          </span>
        </div>
      </div>

      {relativeTime && (
        <div className="text-[10px] text-muted-foreground/70">{relativeTime}</div>
      )}
    </Card>
  );
}
