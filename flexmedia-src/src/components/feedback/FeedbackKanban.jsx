import React, { useMemo, useState } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { toast } from 'sonner';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { Skeleton } from '@/components/ui/skeleton';
import FeedbackCard from './FeedbackCard';
import { STATUS_COLUMNS, columnForStatus } from './feedbackConstants';

/**
 * Kanban board for feedback items.
 * Admin/manager can drag between columns to change status (optimistic; rolls back on error).
 * Non-admins see cards but cannot drag.
 */
export default function FeedbackKanban({
  items,
  loading,
  votedIds,
  canEdit,
  onCardClick,
  onToggleVote,
}) {
  const [draggingId, setDraggingId] = useState(null);

  // Group items by kanban column (folds 'duplicate' into 'declined').
  const byColumn = useMemo(() => {
    const map = {};
    STATUS_COLUMNS.forEach(c => { map[c.id] = []; });
    items.forEach(it => {
      const col = columnForStatus(it.status);
      if (map[col]) map[col].push(it);
      else map.new.push(it); // fallback for unknown statuses
    });
    // Sort by vote_count desc, then created_at desc within each column.
    Object.values(map).forEach(arr => {
      arr.sort((a, b) => {
        const v = (b.vote_count || 0) - (a.vote_count || 0);
        if (v !== 0) return v;
        const ad = new Date(a.created_at || a.created_date || 0).getTime();
        const bd = new Date(b.created_at || b.created_date || 0).getTime();
        return bd - ad;
      });
    });
    return map;
  }, [items]);

  const onDragEnd = async (result) => {
    setDraggingId(null);
    if (!result.destination) return;
    if (!canEdit) {
      toast.error('Only admins and managers can change status.');
      return;
    }
    const itemId = result.draggableId;
    const newStatus = result.destination.droppableId;
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    // If dropped in the same column, no-op (don't overwrite a 'duplicate' status
    // just because user dropped it back in the Declined column).
    if (columnForStatus(item.status) === newStatus) return;

    // Optimistic: toast, then push update; on error we refetch to roll back.
    const updates = { status: newStatus };
    const nowIso = new Date().toISOString();
    if (newStatus === 'accepted' && !item.accepted_at) updates.accepted_at = nowIso;
    if (newStatus === 'shipped' && !item.shipped_at) updates.shipped_at = nowIso;
    if (newStatus === 'declined' && !item.declined_at) updates.declined_at = nowIso;

    try {
      await api.entities.FeedbackItem.update(itemId, updates);
      toast.success(`Moved to ${STATUS_COLUMNS.find(c => c.id === newStatus)?.label || newStatus}`);
      refetchEntityList('FeedbackItem');
    } catch (err) {
      toast.error(err?.message || 'Failed to update status');
      refetchEntityList('FeedbackItem');
    }
  };

  if (loading) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-2">
        {STATUS_COLUMNS.map(col => (
          <div key={col.id} className="flex-shrink-0 w-64">
            <div className={`${col.color} px-3 py-2 rounded-t-md`}>
              <h3 className="text-sm font-semibold">{col.label}</h3>
            </div>
            <div className="bg-muted/15 rounded-b-md p-2 space-y-2 min-h-[200px]">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <DragDropContext
      onDragStart={(s) => setDraggingId(s.draggableId)}
      onDragEnd={onDragEnd}
    >
      <div
        className="flex gap-2 overflow-x-auto pb-2"
        style={{ scrollbarWidth: 'thin', WebkitOverflowScrolling: 'touch' }}
      >
        {STATUS_COLUMNS.map(col => {
          const colItems = byColumn[col.id] || [];
          return (
            <div key={col.id} className="flex-shrink-0 w-64">
              <div className={`${col.color} px-3 py-2 rounded-t-md flex items-center justify-between`}>
                <h3 className="text-sm font-semibold truncate" title={col.label}>{col.label}</h3>
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-card/60 text-foreground font-medium tabular-nums">
                  {colItems.length}
                </span>
              </div>
              <Droppable droppableId={col.id}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`min-h-[300px] max-h-[calc(100vh-260px)] overflow-y-auto p-2 space-y-2 rounded-b-md transition-colors ${
                      snapshot.isDraggingOver ? 'bg-primary/10 ring-2 ring-primary/20' : 'bg-muted/15'
                    }`}
                  >
                    {colItems.length === 0 && (
                      <div className="text-center text-xs text-muted-foreground/60 py-6 italic">No items</div>
                    )}
                    {colItems.map((item, idx) => (
                      <Draggable
                        key={item.id}
                        draggableId={item.id}
                        index={idx}
                        isDragDisabled={!canEdit}
                      >
                        {(dragProvided, dragSnapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            {...dragProvided.dragHandleProps}
                            style={{
                              ...dragProvided.draggableProps.style,
                              cursor: canEdit ? (dragSnapshot.isDragging ? 'grabbing' : 'grab') : 'pointer',
                            }}
                          >
                            <FeedbackCard
                              item={item}
                              voted={votedIds.has(item.id)}
                              onClick={onCardClick}
                              onToggleVote={onToggleVote}
                              isDragging={dragSnapshot.isDragging || draggingId === item.id}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          );
        })}
      </div>
    </DragDropContext>
  );
}
