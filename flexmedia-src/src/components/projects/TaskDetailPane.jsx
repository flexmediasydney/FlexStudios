/**
 * Right-pane detail view for the Tasks subtab two-pane layout.
 *
 * Replaces the inline expansion that used to push the task list around when
 * a task was opened. Sits to the right of TaskListView at wide viewports
 * and stacks below at narrow ones.
 *
 * Three sections:
 *   1. Meta strip — assignee, due, effort, role (read-only summary).
 *   2. Description.
 *   3. Checklist — task.checklist (JSONB column added in migration 477).
 *      Items: { title, checked }. User can check/uncheck, add new items,
 *      remove existing ones. Writes go straight to project_tasks.checklist.
 *   4. Linked notes — org_notes filtered by linked_task_id = task.id with
 *      link_kind = 'task'. New notes can be created via the existing
 *      UnifiedNoteComposer with initialLink pre-set to this task.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckCircle2, Clock, User as UserIcon, Plus, X, Trash2,
  CalendarIcon, FileText, MessageSquare, Loader2,
} from "lucide-react";
import { ROLE_LABELS } from "./TaskManagement";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import UnifiedNoteComposer from "@/components/notes/UnifiedNoteComposer";

function formatMins(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return "0m";
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function TaskDetailPane({
  task,
  project,
  projectId,
  canEdit = true,
  currentUser,
  onClose,
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
    // task.updated_at is the canonical version key — the row's updated_at
    // is bumped on every server write, so this effect runs each time the
    // server confirms a change (and once on task switch).
  }, [task?.id, task?.updated_at]);

  // Project-scoped time logs — useEntityList shares the cache with
  // TaskListView so this isn't an extra round-trip.
  const { data: projectTimeLogs = [] } = useEntityList(
    projectId ? 'TaskTimeLog' : null,
    null,
    500,
    projectId ? { project_id: projectId } : null
  );

  // ── Linked notes (org_notes where link_kind=task & linked_task_id=task.id) ──
  // Scoped by project_id on the server-side filter for cache efficiency, then
  // narrowed client-side to the specific task — same shape NoteLinkPicker uses.
  const { data: allProjectNotes = [], isLoading: notesLoading } = useEntityList(
    task?.id ? "OrgNote" : null,
    "-created_at",
    500,
    (n) => n.link_kind === 'task'
        && n.linked_task_id === task?.id
        && !n.is_deleted
  );

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

  // ── Effort actuals — sum task-scoped time logs ──
  const actualSeconds = useMemo(() => {
    if (!task?.id) return 0;
    let total = 0;
    for (const l of projectTimeLogs) {
      if (l.task_id !== task.id) continue;
      if (l.status === 'completed' || !l.is_active) {
        total += Math.max(0, l.total_seconds || 0);
      } else if (l.status === 'running' && l.start_time) {
        total += Math.max(0, Math.floor((Date.now() - new Date(l.start_time).getTime()) / 1000) - (l.paused_duration || 0));
      } else {
        total += Math.max(0, l.total_seconds || 0);
      }
    }
    return total;
  }, [task?.id, projectTimeLogs]);

  const estimatedSeconds = (task?.estimated_minutes || 0) * 60;

  // ── Note composer modal ──
  const [composerOpen, setComposerOpen] = useState(false);

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
        {/* Meta strip */}
        <div className="grid grid-cols-2 gap-3 bg-card rounded-lg border border-border/50 p-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <UserIcon className="h-3 w-3" /> Assigned
            </div>
            <div className="text-sm">
              {task.assigned_to_team_name
                ? <span className="text-foreground">{task.assigned_to_team_name} <span className="text-muted-foreground/70 text-xs">(team)</span></span>
                : task.assigned_to_name
                  ? <span className="text-foreground">{task.assigned_to_name}</span>
                  : <span className="italic text-muted-foreground/70">Unassigned</span>
              }
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <CalendarIcon className="h-3 w-3" /> Due
            </div>
            <div className="text-sm">
              {task.due_date
                ? <span className="text-foreground">{fmtTimestampCustom(task.due_date, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                : <span className="italic text-muted-foreground/70">No due date</span>
              }
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Clock className="h-3 w-3" /> Effort
            </div>
            <div className="text-sm">
              {(actualSeconds > 0 || estimatedSeconds > 0)
                ? <>
                    <span className="text-foreground font-medium">{formatMins(actualSeconds)}</span>
                    {estimatedSeconds > 0 && (
                      <span className="text-muted-foreground"> / {formatMins(estimatedSeconds)} est.</span>
                    )}
                  </>
                : <span className="italic text-muted-foreground/70">Not tracked</span>
              }
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Role</div>
            <div className="text-sm text-foreground">
              {ROLE_LABELS[task.auto_assign_role] || (task.auto_assign_role && task.auto_assign_role !== 'none' ? task.auto_assign_role : <span className="italic text-muted-foreground/70">None</span>)}
            </div>
          </div>
        </div>

        {/* Description */}
        {task.description && (
          <div>
            <div className="text-xs font-semibold mb-2 flex items-center gap-2 text-foreground/80">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              Description
            </div>
            <div className="bg-card rounded-lg border border-border/50 p-3 text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
              {task.description}
            </div>
          </div>
        )}

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

        {/* Linked notes */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold flex items-center gap-2 text-foreground/80">
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
              Notes
              {allProjectNotes.length > 0 && (
                <span className="text-[10px] font-normal text-muted-foreground tabular-nums">
                  {allProjectNotes.length}
                </span>
              )}
            </div>
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => setComposerOpen(true)}
              >
                <Plus className="h-3 w-3" /> Note
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {notesLoading ? (
              <div className="bg-card rounded-lg border border-border/50 p-3 text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading notes…
              </div>
            ) : allProjectNotes.length === 0 ? (
              <div className="bg-card rounded-lg border border-border/50 p-3 text-xs italic text-muted-foreground/70">
                No notes linked to this task yet.
              </div>
            ) : (
              allProjectNotes.map(note => (
                <div key={note.id} className="bg-card rounded-lg border border-border/50 p-3">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1.5">
                    <span className="font-medium text-foreground/80">{note.author_name || note.author_email || 'Unknown'}</span>
                    <span>·</span>
                    <span>{fmtTimestampCustom(note.created_at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                  </div>
                  {note.content_html
                    ? <div className="text-sm text-foreground/90 prose prose-sm max-w-none [&_p]:my-1" dangerouslySetInnerHTML={{ __html: note.content_html }} />
                    : <p className="text-sm text-foreground/90 whitespace-pre-wrap">{note.content || ''}</p>
                  }
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Compose dialog */}
      {composerOpen && (
        <Dialog open={composerOpen} onOpenChange={setComposerOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>New note · {cleanTitle}</DialogTitle>
            </DialogHeader>
            <UnifiedNoteComposer
              projectId={projectId}
              currentUser={currentUser}
              contextType="project"
              contextLabel={project?.title || project?.property_address || 'Project'}
              initialLink={{ kind: 'task', id: task.id, label: cleanTitle }}
              onSave={() => setComposerOpen(false)}
              onCancel={() => setComposerOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
