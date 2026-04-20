import React, { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, ChevronUp, MessageCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { TYPE_META, SEVERITY_META, STATUS_META } from './feedbackConstants';

function SortHeader({ column, label, sort, onSort, className }) {
  const active = sort.column === column;
  return (
    <TableHead
      onClick={() => onSort(column)}
      className={cn('cursor-pointer select-none hover:text-foreground', className)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </span>
    </TableHead>
  );
}

function relTime(v) {
  try {
    if (!v) return '—';
    return formatDistanceToNow(new Date(v), { addSuffix: true });
  } catch { return '—'; }
}

export default function FeedbackList({ items, loading, votedIds, users, onRowClick, onToggleVote }) {
  const [sort, setSort] = useState({ column: 'vote_count', dir: 'desc' });

  const userById = useMemo(() => {
    const map = {};
    (users || []).forEach(u => { if (u.id) map[u.id] = u; });
    return map;
  }, [users]);

  const sortedItems = useMemo(() => {
    const copy = [...items];
    const { column, dir } = sort;
    copy.sort((a, b) => {
      let av = a[column];
      let bv = b[column];
      if (column === 'created_at') { av = new Date(av || a.created_date || 0).getTime(); bv = new Date(bv || b.created_date || 0).getTime(); }
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [items, sort]);

  const handleSort = (col) => {
    setSort(prev => prev.column === col
      ? { column: col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { column: col, dir: col === 'title' || col === 'area' ? 'asc' : 'desc' }
    );
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  return (
    <div className="border rounded-md bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHeader column="title" label="Title" sort={sort} onSort={handleSort} />
            <SortHeader column="type" label="Type" sort={sort} onSort={handleSort} />
            <SortHeader column="severity" label="Severity" sort={sort} onSort={handleSort} />
            <SortHeader column="status" label="Status" sort={sort} onSort={handleSort} />
            <SortHeader column="vote_count" label="Votes" sort={sort} onSort={handleSort} className="text-right" />
            <SortHeader column="comment_count" label="Comments" sort={sort} onSort={handleSort} className="text-right" />
            <SortHeader column="created_by_name" label="Created by" sort={sort} onSort={handleSort} />
            <SortHeader column="created_at" label="Created" sort={sort} onSort={handleSort} />
            <TableHead>Assigned to</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedItems.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                No feedback items match your filters.
              </TableCell>
            </TableRow>
          )}
          {sortedItems.map(item => {
            const type = TYPE_META[item.type] || TYPE_META.bug;
            const sev = SEVERITY_META[item.severity] || SEVERITY_META.medium;
            const status = STATUS_META[item.status] || { label: item.status };
            const voted = votedIds.has(item.id);
            const assignedUser = item.assigned_to ? userById[item.assigned_to] : null;
            return (
              <TableRow
                key={item.id}
                className="cursor-pointer"
                onClick={() => onRowClick?.(item)}
              >
                <TableCell className="max-w-[320px]">
                  <div className="truncate font-medium text-sm" title={item.title}>{item.title}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn('text-[10px] font-medium', type.badge)}>{type.label}</Badge>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <span className={cn('w-2 h-2 rounded-full', sev.dot)} />
                    {sev.label}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-xs font-medium">{status.label}</span>
                </TableCell>
                <TableCell className="text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onToggleVote?.(item); }}
                    className={cn(
                      'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs border transition-colors',
                      voted ? 'bg-primary/10 text-primary border-primary/30' : 'border-transparent hover:bg-muted'
                    )}
                    aria-pressed={voted}
                    aria-label={voted ? 'Remove vote' : 'Upvote'}
                  >
                    <ChevronUp className="h-3 w-3" />
                    <span className="tabular-nums">{item.vote_count || 0}</span>
                  </button>
                </TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                    <MessageCircle className="h-3 w-3" />
                    <span className="tabular-nums">{item.comment_count || 0}</span>
                  </span>
                </TableCell>
                <TableCell className="text-xs">{item.created_by_name || '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{relTime(item.created_at || item.created_date)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{assignedUser?.full_name || '—'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
