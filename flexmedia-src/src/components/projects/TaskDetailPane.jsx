/**
 * Right-pane detail view for the Tasks subtab two-pane layout.
 *
 * Wraps the existing TaskDetailPanel (which still owns description, deadline
 * editor, manual effort logging, effort history, edit/lock/delete buttons)
 * and adds two new sections below it:
 *   1. Checklist — task.checklist (JSONB column added in migration 477).
 *      Items: { title, checked }. User can check/uncheck, add new items,
 *      remove existing ones. Writes go straight to project_tasks.checklist.
 *   2. Linked notes — UnifiedNotesPanel scoped by `taskId`. Inherits the
 *      full notes feature surface (rich composer with attachments, inline
 *      edit, replies/threads, lightbox, pin) — no hand-rolled fork.
 */
import React, { useState, useCallback, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, X, Trash2, FileText, MessageSquare, CheckCircle2 } from "lucide-react";
import TaskDetailPanel from "./TaskDetailPanel";
import UnifiedNotesPanel from "@/components/notes/UnifiedNotesPanel";

export default function TaskDetailPane({
  task,
  project,
  projectId,
  canEdit = true,
  currentUser,
  onClose,
  // Forwarded straight to TaskDetailPanel so the inline editor (effort
  // logger, deadline picker, edit/delete) stays fully wired.
  onEditTask,
  onDeleteTask,
  onUpdateDeadline,
  thresholds,
}) {
  const queryClient = useQueryClient();
  // Local mirror of task.checklist. Mutations update this state synchronously
  // for instant UI, then persist to the server. Resyncs from props whenever
  // a different task is selected or the task's updated_at advances (so
  // realtime updates from another tab still land here).
  const [localChecklist, setLocalChecklist] = useState(() =>
    Array.isArray(task?.checklist) ? task.checklist : []
  );
  useEffect(() => {
    setLocalChecklist(Array.isArray(task?.checklist) ? task.checklist : []);
    // updated_at is the canonical version key — the row's timestamp bumps
    // on every server write, so this effect runs each time the server
    // confirms a change (and once on task switch). decorateEntity may
    // expose it as `updated_date`, so we depend on both.
  }, [task?.id, task?.updated_at, task?.updated_date]);

  // ── Mutations ──
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await api.entities.ProjectTask.update(id, data);
    },
    onSuccess: (updatedRow) => {
      // useProjectTasks keys its query as `['project-tasks-scoped', projectId, sort]`.
      // Prefix-invalidate so every sort variant in the cache picks up the
      // new row. We also patch each matching cache directly with the full
      // returned row — invalidate triggers a refetch but the patch makes
      // the UI feel instant without waiting for the refetch round-trip.
      const prefix = ['project-tasks-scoped', projectId];
      if (updatedRow?.id) {
        queryClient.setQueriesData({ queryKey: prefix }, (prev) => {
          if (!Array.isArray(prev)) return prev;
          const idx = prev.findIndex(t => t?.id === updatedRow.id);
          if (idx === -1) return prev;
          const next = prev.slice();
          next[idx] = { ...prev[idx], ...updatedRow };
          return next;
        });
      }
      queryClient.invalidateQueries({ queryKey: prefix });
    },
    onError: (err) => {
      console.error('TaskDetailPane update failed:', err);
    },
  });

  const persistChecklist = useCallback((nextList) => {
    if (!task?.id) return;
    setLocalChecklist(nextList); // optimistic — instant render
    updateMutation.mutate({ id: task.id, data: { checklist: nextList } });
  }, [task?.id, updateMutation]);

  const checklist = localChecklist;

  const [newItemDraft, setNewItemDraft] = useState("");

  const toggleItem = useCallback((idx) => {
    if (!canEdit) return;
    const next = checklist.map((it, i) => i === idx ? { ...it, checked: !it.checked } : it);
    persistChecklist(next);
  }, [checklist, canEdit, persistChecklist]);

  const addItem = useCallback(() => {
    if (!canEdit) return;
    const title = newItemDraft.trim();
    if (!title) return;
    persistChecklist([...checklist, { title, checked: false }]);
    setNewItemDraft("");
  }, [canEdit, newItemDraft, checklist, persistChecklist]);

  const removeItem = useCallback((idx) => {
    if (!canEdit) return;
    persistChecklist(checklist.filter((_, i) => i !== idx));
  }, [canEdit, checklist, persistChecklist]);

  if (!task) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
        <FileText className="h-8 w-8 mb-2 opacity-30" />
        <p className="text-sm font-medium">Select a task</p>
        <p className="text-xs mt-1 opacity-70">Pick any task on the left to see its details, checklist and linked notes.</p>
      </div>
    );
  }

  const cleanTitle = (task.title || "").replace(/^\[Revision #\d+\]\s*/, "");
  const completedItems = checklist.filter(it => it?.checked).length;

  return (
    <div className="h-full flex flex-col bg-muted/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b border-border/50">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {task.is_completed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-green-700 bg-green-50 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded">
                <CheckCircle2 className="h-3 w-3" />
                Completed
              </span>
            )}
            {task.task_type && (
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {task.task_type === 'onsite' ? 'Onsite' : 'Back Office'}
              </span>
            )}
          </div>
          <h2 className="text-base font-semibold leading-tight break-words">{cleanTitle || 'Untitled task'}</h2>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 flex-shrink-0 lg:hidden"
            onClick={onClose}
            title="Close detail"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Existing TaskDetailPanel — covers meta, description, deadline
             editor, manual effort logging table (TaskTimeLoggerRobust), and
             edit/delete buttons. Keying by task.id forces a remount on task
             switch so internal effort-state doesn't leak across selections. */}
        <TaskDetailPanel
          key={task.id}
          task={task}
          canEdit={canEdit}
          onEdit={onEditTask}
          onDelete={onDeleteTask}
          onUpdateDeadline={onUpdateDeadline}
          thresholds={thresholds}
          projectId={projectId}
          project={project}
          user={currentUser}
          onClose={onClose}
        />

        {/* Checklist */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold flex items-center gap-2 text-foreground/80">
              <Checkbox checked disabled className="h-3.5 w-3.5 opacity-60 pointer-events-none" />
              Checklist
              {checklist.length > 0 && (
                <span className="text-[10px] font-normal text-muted-foreground tabular-nums">
                  {completedItems}/{checklist.length}
                </span>
              )}
            </div>
          </div>
          <div className="bg-card rounded-lg border border-border/50 divide-y divide-border/40">
            {checklist.length === 0 ? (
              <p className="px-3 py-2 text-xs italic text-muted-foreground/70">No checklist items yet.</p>
            ) : (
              checklist.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-3 py-1.5 group/item"
                >
                  <Checkbox
                    checked={!!item?.checked}
                    onCheckedChange={() => toggleItem(idx)}
                    disabled={!canEdit || updateMutation.isPending}
                    className="h-4 w-4 flex-shrink-0"
                  />
                  <span className={`flex-1 text-sm ${item?.checked ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                    {item?.title || <span className="italic text-muted-foreground/70">(empty)</span>}
                  </span>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      onClick={() => removeItem(idx)}
                      title="Remove item"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))
            )}
            {canEdit && (
              <div className="flex items-center gap-2 px-3 py-1.5">
                <Plus className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <Input
                  value={newItemDraft}
                  onChange={e => setNewItemDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addItem();
                    }
                  }}
                  placeholder="Add an item — press Enter"
                  className="h-7 text-sm border-0 shadow-none px-0 focus-visible:ring-0 bg-transparent"
                />
                {newItemDraft.trim() && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={addItem}
                    disabled={updateMutation.isPending}
                  >
                    Add
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Linked notes — full UnifiedNotesPanel scoped to this task. The
             panel ships with: rich composer (attachments, mentions, links),
             inline edit, threaded replies, lightbox, pin/unpin. We just feed
             it the project context + a `taskId` filter; the panel handles
             everything else. */}
        <div>
          <div className="flex items-center gap-2 mb-2 px-1">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground/80">Notes</span>
          </div>
          {/* The notes panel manages its own scrolling; constrain its height
               so it doesn't blow the right-pane scroller on long threads. */}
          <div className="rounded-lg border border-border/50 overflow-hidden bg-background" style={{ minHeight: '320px', maxHeight: '600px' }}>
            <UnifiedNotesPanel
              projectId={projectId}
              contextType="project"
              contextLabel={project?.title || project?.property_address || 'Project'}
              taskId={task.id}
              taskLabel={cleanTitle}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
