/**
 * useOptimisticMutations.jsx
 *
 * Pre-built optimistic update hooks for common mutations:
 *   - Project status change
 *   - Task completion toggle
 *   - Email mark-as-read / mark-as-unread
 *
 * Each hook uses React Query's optimistic update pattern:
 *   1. Cancel outgoing refetches for the target query
 *   2. Snapshot the previous data
 *   3. Optimistically update the cache
 *   4. Roll back on error
 *   5. Invalidate on settle (success or error) for consistency
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { queryKeys } from '@/components/lib/query-client';
import { toast } from 'sonner';


// ─── Project Status Change ──────────────────────────────────────────────────
// Optimistically updates the project status in the entity cache so the UI
// reflects the new stage immediately, before the server round-trip completes.

export function useOptimisticProjectStatusChange(projectId, { onMutate: externalOnMutate, onSuccess: externalOnSuccess, onError: externalOnError } = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ newStatus, updateData }) => {
      return api.entities.Project.update(projectId, updateData || { status: newStatus, last_status_change: new Date().toISOString() });
    },

    onMutate: async ({ newStatus }) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.detail(projectId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.lists() });

      // Snapshot the previous value
      const previousProject = queryClient.getQueryData(queryKeys.projects.detail(projectId));

      // Optimistically update project detail cache
      queryClient.setQueryData(queryKeys.projects.detail(projectId), (old) => {
        if (!old) return old;
        return { ...old, status: newStatus, last_status_change: new Date().toISOString() };
      });

      // Optimistically update any project list caches
      queryClient.setQueriesData({ queryKey: queryKeys.projects.lists() }, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(p => p.id === projectId ? { ...p, status: newStatus } : p);
      });

      if (externalOnMutate) externalOnMutate({ newStatus });

      return { previousProject };
    },

    onError: (err, variables, context) => {
      // Roll back to previous value on error
      if (context?.previousProject) {
        queryClient.setQueryData(queryKeys.projects.detail(projectId), context.previousProject);
      }
      toast.error(err?.message || 'Failed to update project status');
      if (externalOnError) externalOnError(err, variables, context);
    },

    onSuccess: (data, variables, context) => {
      if (externalOnSuccess) externalOnSuccess(data, variables, context);
    },

    onSettled: () => {
      // Always refetch after to ensure server state is in sync
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.pending() });
    },
  });
}


// ─── Task Completion Toggle ─────────────────────────────────────────────────
// Optimistically toggles task.is_completed in the task list cache so the
// checkbox/strike-through appears instantly.

export function useOptimisticTaskCompletion(projectId, { onSuccess: externalOnSuccess, onError: externalOnError } = {}) {
  const queryClient = useQueryClient();
  const tasksKey = queryKeys.tasks.byProject(projectId);

  return useMutation({
    mutationFn: async ({ taskId, isCompleted }) => {
      return api.entities.ProjectTask.update(taskId, { is_completed: isCompleted });
    },

    onMutate: async ({ taskId, isCompleted }) => {
      await queryClient.cancelQueries({ queryKey: tasksKey });

      const previousTasks = queryClient.getQueryData(tasksKey);

      queryClient.setQueryData(tasksKey, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(t => t.id === taskId ? { ...t, is_completed: isCompleted } : t);
      });

      return { previousTasks };
    },

    onError: (err, variables, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(tasksKey, context.previousTasks);
      }
      toast.error(err?.message || 'Failed to update task');
      if (externalOnError) externalOnError(err, variables, context);
    },

    onSuccess: (data, variables, context) => {
      toast.success(variables.isCompleted ? 'Task completed' : 'Task reopened');
      if (externalOnSuccess) externalOnSuccess(data, variables, context);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksKey });
    },
  });
}


// ─── Email Mark as Read ─────────────────────────────────────────────────────
// Optimistically marks all messages in a thread as read so the unread badge
// disappears instantly.

export function useOptimisticEmailMarkAsRead(accountId, { onSuccess: externalOnSuccess, onError: externalOnError } = {}) {
  const queryClient = useQueryClient();
  const messagesKey = queryKeys.emails.messages(accountId);

  return useMutation({
    mutationFn: async ({ threadId, emailAccountId }) => {
      return api.functions.invoke('markEmailsAsRead', {
        threadIds: [threadId],
        emailAccountId: emailAccountId || accountId,
      });
    },

    onMutate: async ({ threadId }) => {
      await queryClient.cancelQueries({ queryKey: messagesKey });

      const previousMessages = queryClient.getQueryData(messagesKey);

      // Mark all messages in this thread as read
      queryClient.setQueryData(messagesKey, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(m =>
          m.gmail_thread_id === threadId ? { ...m, is_unread: false } : m
        );
      });

      return { previousMessages };
    },

    onError: (err, variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(messagesKey, context.previousMessages);
      }
      toast.error('Failed to mark as read');
      if (externalOnError) externalOnError(err, variables, context);
    },

    onSuccess: (data, variables, context) => {
      toast.success('Marked as read');
      if (externalOnSuccess) externalOnSuccess(data, variables, context);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: messagesKey });
    },
  });
}


// ─── Email Mark as Unread ───────────────────────────────────────────────────

export function useOptimisticEmailMarkAsUnread(accountId, { onSuccess: externalOnSuccess, onError: externalOnError } = {}) {
  const queryClient = useQueryClient();
  const messagesKey = queryKeys.emails.messages(accountId);

  return useMutation({
    mutationFn: async ({ threadId, emailAccountId }) => {
      return api.functions.invoke('markEmailsAsUnread', {
        threadIds: [threadId],
        emailAccountId: emailAccountId || accountId,
      });
    },

    onMutate: async ({ threadId }) => {
      await queryClient.cancelQueries({ queryKey: messagesKey });

      const previousMessages = queryClient.getQueryData(messagesKey);

      queryClient.setQueryData(messagesKey, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map(m =>
          m.gmail_thread_id === threadId ? { ...m, is_unread: true } : m
        );
      });

      return { previousMessages };
    },

    onError: (err, variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(messagesKey, context.previousMessages);
      }
      toast.error('Failed to mark as unread');
      if (externalOnError) externalOnError(err, variables, context);
    },

    onSuccess: (data, variables, context) => {
      toast.success('Marked as unread');
      if (externalOnSuccess) externalOnSuccess(data, variables, context);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: messagesKey });
    },
  });
}
