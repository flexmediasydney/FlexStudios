import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { retryWithBackoff } from '@/lib/networkResilience';
import { invalidateProjectCaches } from '@/lib/invalidateProjectCaches';
import { Button } from '@/components/ui/button';
import { Play, Pause, CheckCircle, Clock, AlertCircle, AlertTriangle, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useSmartEntityList, useSmartEntityData } from '@/components/hooks/useSmartEntityData';
import { useActiveTimers } from '@/components/utilization/ActiveTimersContext';
import ManualTimeEntryDialog from '@/components/projects/ManualTimeEntryDialog';

const INACTIVITY_TIMEOUT = 1800; // 30 minutes
const ACTIVITY_CHECK_INTERVAL = 10000; // Check every 10 seconds
const MAX_SESSION_DURATION = 28800; // 8 hours max per session
const DB_SYNC_INTERVAL = 15000; // Sync to DB every 15 seconds (reduced from 3s to lower DB load)
const LOCAL_TIMER_INTERVAL = 1000; // Update UI timer every 1 second

export default function TaskTimeLoggerRobust({ task, project, onTaskComplete, currentUser }) {
  const queryClient = useQueryClient();

  // State: separate active vs completed
  const [activeLog, setActiveLog] = useState(null);
  const [completedLog, setCompletedLog] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Guard against double-click on start/finish/resume/pause
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  // Dialog states
  const [showConfirm, setShowConfirm] = useState(false);
  const [showTakeoverConfirm, setShowTakeoverConfirm] = useState(false);
  const [showContinueConfirm, setShowContinueConfirm] = useState(false);
  const [showInactivityWarning, setShowInactivityWarning] = useState(false);
  const [showSessionExpired, setShowSessionExpired] = useState(false);
  const [showConflict, setShowConflict] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [showConcurrentWarning, setShowConcurrentWarning] = useState(false);

  const logTimerActivity = (action, description) => {
    if (!project?.id) return;
    api.entities.ProjectActivity.create({
      project_id: project.id,
      project_title: project.title || project.property_address || '',
      action,
      description,
      user_name: currentUser?.full_name || 'Unknown',
      user_email: currentUser?.email || '',
    }).catch(() => {});
  };

  // Refs for tracking - critical for persistence
  const lastActivityTime = useRef(Date.now());
  const dbSyncRef = useRef(null);
  const unsubscribeRef = useRef(null);
  const componentMountedRef = useRef(true);

  // Entity data - for conflict detection only
   const { data: timeLogs = [] } = useSmartEntityList('TaskTimeLog', null, null, (log) => log.task_id === task.id);
   const { data: currentTask } = useSmartEntityData('ProjectTask', task.id, { priority: 9 });

  // Derived UI state
  const isRunning = activeLog?.status === 'running' && activeLog?.is_active;
  const isPaused = activeLog?.status === 'paused' && activeLog?.is_active;
  const isFinished = !!completedLog && !completedLog?.is_active;

  // Calculate true elapsed time (excluding pauses)
  // When running: compute live from start_time minus all accumulated paused_duration
  // When paused/finished: use the stored total_seconds value
  const totalDisplaySeconds = isRunning && activeLog?.start_time
    ? Math.max(0, Math.floor((Date.now() - new Date(fixTimestamp(activeLog.start_time)).getTime()) / 1000) - (activeLog.paused_duration || 0))
    : (activeLog?.total_seconds || completedLog?.total_seconds || 0);

  // Detect conflicts: another user actively logging
  const conflictLog = timeLogs.find(log => 
    log.is_active && 
    (log.status === 'running' || log.status === 'paused') && 
    log.user_id !== currentUser.id &&
    log.task_id === task.id
  );
  const preAssignedUser = conflictLog ? { id: conflictLog.user_id, full_name: conflictLog.user_name } : null;
  
  const isTeamAssigned = currentTask?.assigned_to_team_id && !currentTask?.assigned_to;
  const isUnassigned = !currentTask?.assigned_to && !currentTask?.assigned_to_team_id;

  // Detect if this user already has a running timer on a different task
  const { activeTimers } = useActiveTimers();
  const hasOtherActiveTimer = activeTimers.some(
    t => t.user_id === currentUser?.id && t.task_id !== task.id && t.is_active && t.status === 'running' && t.project_id === project?.id
  );

  // CRITICAL: Initialize from DB on mount - load active log for this task
  useEffect(() => {
    if (!task?.id || !currentUser?.id) return;

    const initialize = async () => {
      componentMountedRef.current = true;
      setIsLoading(true);
      setError(null);
      
      try {
        // Fetch ALL logs for this task - order by created_date DESC for most recent
        const logs = await api.entities.TaskTimeLog.filter(
          { task_id: task.id },
          '-created_date',
          100
        );
        
        // Priority 1: Find currently ACTIVE (running/paused) log by current user on this task
        const active = logs.find(log => 
          log.task_id === task.id &&
          log.user_id === currentUser.id &&
          log.is_active === true &&
          (log.status === 'running' || log.status === 'paused')
        );

        if (active) {
          // Enforce MAX_SESSION_DURATION on reload. If a running session has accumulated
          // more than 8 hours of wall-clock time (e.g. browser closed overnight without pausing),
          // auto-finalize it at the cap rather than letting it silently accumulate phantom time.
          if (active.status === 'running' && active.start_time) {
            const wallClockSeconds = Math.floor(
              (Date.now() - new Date(fixTimestamp(active.start_time)).getTime()) / 1000
            ) - (active.paused_duration || 0);

            if (wallClockSeconds > MAX_SESSION_DURATION) {
              try {
                await api.entities.TaskTimeLog.update(active.id, {
                  end_time: new Date().toISOString(),
                  status: 'completed',
                  is_active: false,
                  total_seconds: MAX_SESSION_DURATION,
                });
                setActiveLog(null);
                setCompletedLog({ ...active, status: 'completed', is_active: false, total_seconds: MAX_SESSION_DURATION });
                setShowSessionExpired(true);
              } catch (e) {
                console.warn('Failed to auto-finalize expired session on load:', e);
                setActiveLog(active);
              }
              setIsLoading(false);
              subscribeToChanges();
              return;
            }
          }

          setActiveLog(active);
          setCompletedLog(null);
          setIsLoading(false);
          subscribeToChanges();
          return;
        }

        // Priority 2: Check for most recent completed log
        const completed = logs.find(log =>
          log.task_id === task.id &&
          log.user_id === currentUser.id &&
          log.status === 'completed' &&
          !log.is_active
        );

        setActiveLog(null);
        if (completed) {
          setCompletedLog(completed);
        }

        setIsLoading(false);
        subscribeToChanges();
      } catch (e) {
        console.error('Failed to initialize timer:', e);
        setError('Failed to load timer state');
        setIsLoading(false);
      }
    };

    const subscribeToChanges = () => {
      // Real-time subscription for this task's logs
      unsubscribeRef.current = api.entities.TaskTimeLog.subscribe((event) => {
        if (!componentMountedRef.current) return;

        // Only care about logs for THIS task and THIS user
        if (event.data?.task_id !== task.id || event.data?.user_id !== currentUser.id) return;

        if (event.type === 'create' || event.type === 'update') {
          // If it's active (running/paused), it's the current timer
          if (event.data?.is_active && (event.data?.status === 'running' || event.data?.status === 'paused')) {
            setActiveLog(event.data);
            setCompletedLog(null);
          } 
          // If it's completed, it becomes a history entry
          else if (event.data?.status === 'completed' && !event.data?.is_active) {
            setActiveLog(null);
            setCompletedLog(event.data);
          }
        } else if (event.type === 'delete') {
          // Timer was deleted
          setActiveLog(null);
          setCompletedLog(null);
        }
      });
    };

    initialize();
    
    return () => {
      componentMountedRef.current = false;
      // Final DB sync on unmount if timer is running
      if (activeLogRef.current?.status === 'running' && activeLogRef.current?.start_time) {
        const liveSeconds = Math.max(0, Math.floor((Date.now() - new Date(fixTimestamp(activeLogRef.current.start_time)).getTime()) / 1000) - (activeLogRef.current.paused_duration || 0));
        if (liveSeconds > 0) {
          api.entities.TaskTimeLog.update(activeLogRef.current.id, {
            total_seconds: liveSeconds,
          }).catch(() => {});
        }
      }
      if (unsubscribeRef.current) unsubscribeRef.current();
    };
  }, [task?.id, currentUser?.id]);

  // Keep a ref to activeLog so the interval can access latest values without stale closure
  const activeLogRef = useRef(activeLog);
  useEffect(() => { activeLogRef.current = activeLog; }, [activeLog]);

  // Local tick to drive 1-second UI re-renders when running
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Sync running timer to DB every 15 seconds.
  // Also enforces MAX_SESSION_DURATION — auto-finalizes if the session exceeds 8 hours
  // while the browser is left open, which prevents runaway timers on forgotten tabs.
  const syncFailCountRef = useRef(0);
  useEffect(() => {
    if (!isRunning || !activeLog?.id) return;
    syncFailCountRef.current = 0; // Reset on new running session

    dbSyncRef.current = setInterval(async () => {
      if (!componentMountedRef.current) return;
      const log = activeLogRef.current;
      if (!log?.id || !log?.start_time) return;

      const liveSeconds = Math.max(0, Math.floor((Date.now() - new Date(fixTimestamp(log.start_time)).getTime()) / 1000) - (log.paused_duration || 0));

      if (liveSeconds > MAX_SESSION_DURATION) {
        try {
          await api.entities.TaskTimeLog.update(log.id, {
            end_time: new Date().toISOString(),
            status: 'completed',
            is_active: false,
            total_seconds: MAX_SESSION_DURATION,
          });
          setShowSessionExpired(true);
        } catch (e) {
          console.warn('Failed to auto-finalize session at max duration:', e);
        }
        return;
      }

      try {
        await api.entities.TaskTimeLog.update(log.id, { total_seconds: liveSeconds });
        // Clear error on successful sync
        if (syncFailCountRef.current > 0) {
          syncFailCountRef.current = 0;
          setError(null);
        }
      } catch (e) {
        syncFailCountRef.current += 1;
        console.warn(`Sync failed (attempt ${syncFailCountRef.current}):`, e);
        if (syncFailCountRef.current >= 3) {
          // Auto-pause to prevent data loss on persistent sync failure
          try {
            await api.entities.TaskTimeLog.update(log.id, { status: 'paused', pause_time: new Date().toISOString() });
          } catch {}
          setError('Sync failed — timer paused to prevent data loss. Check your connection.');
        }
      }
    }, DB_SYNC_INTERVAL);

    return () => {
      if (dbSyncRef.current) clearInterval(dbSyncRef.current);
    };
  }, [isRunning, activeLog?.id]);

  // Track user activity (for inactivity detection)
  useEffect(() => {
    if (!isRunning) return;

    const handleActivity = () => {
      lastActivityTime.current = Date.now();
      setShowInactivityWarning(false);
    };
    
    document.addEventListener('mousemove', handleActivity);
    document.addEventListener('keydown', handleActivity);
    document.addEventListener('click', handleActivity);

    return () => {
      document.removeEventListener('mousemove', handleActivity);
      document.removeEventListener('keydown', handleActivity);
      document.removeEventListener('click', handleActivity);
    };
  }, [isRunning]);

  // Record activity and clear inactivity warning
  const recordActivity = useCallback(() => {
    lastActivityTime.current = Date.now();
    setShowInactivityWarning(false);
  }, []);

  const handlePause = useCallback(async () => {
    if (!activeLog?.id || isSubmitting) return;

    try {
      setIsSubmitting(true);
      setError(null);

      const now = new Date().toISOString();
      lastActivityTime.current = Date.now();

      await api.entities.TaskTimeLog.update(activeLog.id, {
        status: 'paused',
        pause_time: now,
        total_seconds: totalDisplaySeconds
      });
      // Bust both cache layers so UI updates immediately
      invalidateProjectCaches(queryClient, { timeLogs: true, effort: true });
      logTimerActivity('timer_paused', `Timer paused on "${task.title}" by ${currentUser?.full_name}`);
    } catch (err) {
      console.error('Pause timer error:', err);
      setError(err.message || 'Failed to pause timer');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeLog, totalDisplaySeconds, task.title, currentUser?.full_name, isSubmitting]);

  const handleFinish = useCallback(async () => {
    if (!activeLog?.id || isSubmitting) return;

    try {
      setIsSubmitting(true);
      setError(null);

      if (currentTask?.is_locked) {
        setError('Cannot finish timer - task is locked');
        return;
      }

      // Compute final seconds fresh to avoid stale closure / stale DB sync values.
      // When paused: recompute from (pause_time - start_time - paused_duration) instead of
      // relying on total_seconds which may be stale from the last 15s DB sync.
      const finalPausedDuration = activeLog.pause_time
        ? (activeLog.paused_duration || 0) + Math.floor((Date.now() - new Date(fixTimestamp(activeLog.pause_time)).getTime()) / 1000)
        : (activeLog.paused_duration || 0);

      let finalSeconds;
      if (activeLog.status === 'running' && activeLog.start_time) {
        finalSeconds = Math.max(0, Math.floor((Date.now() - new Date(fixTimestamp(activeLog.start_time)).getTime()) / 1000) - (activeLog.paused_duration || 0));
      } else if (activeLog.status === 'paused' && activeLog.start_time && activeLog.pause_time) {
        // Use pause_time as the effective end, minus all accumulated paused time
        finalSeconds = Math.max(0, Math.floor((new Date(fixTimestamp(activeLog.pause_time)).getTime() - new Date(fixTimestamp(activeLog.start_time)).getTime()) / 1000) - (activeLog.paused_duration || 0));
      } else {
        finalSeconds = activeLog.total_seconds || 0;
      }

      await retryWithBackoff(
        () => api.entities.TaskTimeLog.update(activeLog.id, {
          end_time: new Date().toISOString(),
          status: 'completed',
          is_active: false,
          pause_time: null,
          paused_duration: finalPausedDuration,
          total_seconds: finalSeconds
        }),
        { maxRetries: 3, onRetry: (err, attempt) => console.warn(`Timer finish retry ${attempt}:`, err.message) }
      );

      // Bust both cache layers so UI updates immediately
      invalidateProjectCaches(queryClient, { timeLogs: true, effort: true });
      logTimerActivity('timer_completed', `Timer completed on "${task.title}" — ${Math.round(finalSeconds / 60)}m by ${currentUser?.full_name}`);
      if (onTaskComplete) onTaskComplete(task.id);
    } catch (err) {
      console.error('Finish timer error:', err);
      setError(err.message || 'Failed to finish timer');
    } finally {
      setIsSubmitting(false);
    }
  }, [activeLog, currentTask, onTaskComplete, task.id, task.title, currentUser?.full_name, isSubmitting]);

  // Inactivity monitoring (check every 10 seconds)
  useEffect(() => {
    if (!isRunning || !activeLog) return;

    const inactivityInterval = setInterval(() => {
      // Don't check inactivity on paused timers — pause already stops the clock
      if (activeLogRef.current?.status === 'paused') return;

      const inactiveFor = (Date.now() - lastActivityTime.current) / 1000;

      if (inactiveFor > INACTIVITY_TIMEOUT) {
        setShowInactivityWarning(true);
        handlePause();
      }
    }, ACTIVITY_CHECK_INTERVAL);

    return () => clearInterval(inactivityInterval);
  }, [isRunning, activeLog, handlePause]);

  // Conflict detection: pause if another user starts
  useEffect(() => {
    if (isRunning && conflictLog) {
      setShowConflict(true);
      handlePause();
    }
  }, [isRunning, conflictLog?.id, handlePause]);

  // Auto-pause if task becomes unassigned while timer is running
  useEffect(() => {
    if (isRunning && isUnassigned) {
      handlePause();
      setError('Task was unassigned — timer has been paused. Reassign before resuming.');
    }
  }, [isUnassigned, isRunning, handlePause]);

  // Auto-finish if task is marked completed externally while timer is running
  useEffect(() => {
    if (isRunning && currentTask?.is_completed) {
      handleFinish();
      setError('Task was marked complete — timer has been finalized.');
    }
  }, [currentTask?.is_completed, isRunning, handleFinish]);

  // Warn on page unload if timer is active
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isRunning || isPaused) {
        e.preventDefault();
        e.returnValue = 'You have an active timer. Are you sure you want to leave?';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRunning, isPaused]);

  const formatTime = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const formatTimeHuman = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  };

  const handleStart = async () => {
    if (isSubmitting) return;
    try {
      setError(null);

      if (hasOtherActiveTimer) {
        setShowConcurrentWarning(true);
        return;
      }

      if (currentTask?.is_locked) {
        setError('This task is locked. Time logging is disabled.');
        return;
      }

      if (currentTask?.is_completed) {
        setError('This task is already completed. Re-open it before starting a timer.');
        return;
      }

      if (isUnassigned) {
        setError('This task has no assignee. Please assign a person or team before starting the timer.');
        return;
      }

      if (preAssignedUser && preAssignedUser.id !== currentUser.id) {
        setShowConfirm(true);
        return;
      }
      
      if (isTeamAssigned) {
        setShowTakeoverConfirm(true);
        return;
      }
      
      await startTimer();
    } catch (err) {
      console.error('Start timer error:', err);
      setError('Failed to start timer. Please try again.');
    }
  };

  const startTimer = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setShowConfirm(false);
    setShowTakeoverConfirm(false);

    try {
      setIsSubmitting(true);
      setError(null);
      
      // Reassign if needed
      if (isTeamAssigned) {
        const prevTeamName = task.assigned_to_team_name || 'team';
        await api.entities.ProjectTask.update(task.id, {
          assigned_to: currentUser.id,
          assigned_to_name: currentUser.full_name,
          assigned_to_team_id: null,
          assigned_to_team_name: null
        });
        // Audit log: task ownership taken over from team
        logTimerActivity(
          'task_owner_changed',
          `Task "${task.title}" taken over by ${currentUser.full_name} (previously assigned to ${prevTeamName}).`
        );
      } else if (task.assigned_to && task.assigned_to !== currentUser.id) {
        // Individual takeover (e.g., starting a timer on someone else's task)
        const prevName = task.assigned_to_name || 'another user';
        await api.entities.ProjectTask.update(task.id, {
          assigned_to: currentUser.id,
          assigned_to_name: currentUser.full_name,
        });
        logTimerActivity(
          'task_owner_changed',
          `Task "${task.title}" taken over by ${currentUser.full_name} (previously assigned to ${prevName}).`
        );
      }
      
      if (!componentMountedRef.current) return;
      
      // Create fresh timer - DB will trigger subscription update
      const log = await api.entities.TaskTimeLog.create({
        task_id: task.id,
        project_id: project.id,
        user_id: currentUser.id,
        user_email: currentUser.email,
        user_name: currentUser.full_name,
        role: task.auto_assign_role || 'admin',
        team_id: currentUser.team_id || null,
        team_name: currentUser.team_name || null,
        start_time: new Date().toISOString(),
        status: 'running',
        is_active: true,
        total_seconds: 0,
        paused_duration: 0
      });
      
      // setCurrentLog will be triggered by subscription
      lastActivityTime.current = Date.now();
      // Bust both cache layers so UI updates immediately
      invalidateProjectCaches(queryClient, { timeLogs: true, effort: true });
      logTimerActivity('timer_started', `Timer started on "${task.title}" by ${currentUser?.full_name}`);
    } catch (err) {
      console.error('Create timer error:', err);
      setError(err.message || 'Failed to create timer');
    } finally {
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  };

  const handleResume = async () => {
    if (!activeLog?.id || isSubmitting) return;

    try {
      setIsSubmitting(true);
      setError(null);

      if (isUnassigned) {
        setError('Task has no assignee. Please assign before resuming.');
        return;
      }

      // Enforce session cap on resume — prevent bypass via pause/resume cycles
      if ((activeLog.total_seconds || 0) >= MAX_SESSION_DURATION) {
        setError('Session cap reached (8 hours). Please finish this timer and start a new one.');
        return;
      }

      // Calculate pause duration and add to cumulative
      // Guard: only compute if actually paused AND pause_time exists (prevents race on rapid resume)
      const pauseDuration = activeLog.pause_time && activeLog.status === 'paused'
        ? Math.floor((Date.now() - new Date(fixTimestamp(activeLog.pause_time)).getTime()) / 1000)
        : 0;

      lastActivityTime.current = Date.now();

      // Update DB - subscription will update activeLog
      await api.entities.TaskTimeLog.update(activeLog.id, {
        status: 'running',
        pause_time: null,
        paused_duration: (activeLog.paused_duration || 0) + pauseDuration
      });
      logTimerActivity('timer_resumed', `Timer resumed on "${task.title}" by ${currentUser?.full_name}`);
    } catch (err) {
      console.error('Resume timer error:', err);
      setError(err.message || 'Failed to resume timer');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleContinueConfirmed = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setShowContinueConfirm(false);

    try {
      setIsSubmitting(true);
      setError(null);

      // Prevent continuing if another timer is already running
      if (hasOtherActiveTimer) {
        setShowConcurrentWarning(true);
        return;
      }

      // Prevent continuing if task became locked
      if (currentTask?.is_locked) {
        setError('Cannot continue - task is locked');
        return;
      }

      if (currentTask?.is_completed) {
        setError('Task is completed. Re-open it before continuing.');
        return;
      }

      if (isUnassigned) {
        setError('Task has no assignee. Please assign before continuing.');
        return;
      }
      
      // Create new timer session
      await api.entities.TaskTimeLog.create({
        task_id: task.id,
        project_id: project.id,
        user_id: currentUser.id,
        user_email: currentUser.email,
        user_name: currentUser.full_name,
        role: task.auto_assign_role || 'admin',
        team_id: currentUser.team_id || null,
        team_name: currentUser.team_name || null,
        start_time: new Date().toISOString(),
        status: 'running',
        is_active: true,
        total_seconds: 0,
        paused_duration: 0
      });
      
      lastActivityTime.current = Date.now();
      logTimerActivity('timer_continued', `New timer session started on "${task.title}" by ${currentUser?.full_name}`);
      // Subscription will update activeLog
    } catch (err) {
      console.error('Continue timer error:', err);
      setError(err.message || 'Failed to continue timer');
    } finally {
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  };

  const estimatedSeconds = (task.estimated_minutes || 0) * 60;
  const finishedSeconds = completedLog?.total_seconds || 0;
  const performanceScore = estimatedSeconds > 0 && totalDisplaySeconds > 0
    ? Math.round((totalDisplaySeconds / estimatedSeconds) * 100)
    : null;

  if (isLoading) {
    return (
      <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <Clock className="h-4 w-4 animate-spin" />
        Loading timer...
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="mb-2 p-2 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          {error}
        </div>
      )}

      {isUnassigned && (
        <div className="mb-2 p-2 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-400 flex items-center gap-2">
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          No assignee — assign a person or team to enable time logging.
        </div>
      )}

      <div className={`flex items-center gap-2 p-3 rounded-lg ${
        conflictLog ? 'bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800' : isUnassigned ? 'bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700' : 'bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800'
      }`}>
        {conflictLog && conflictLog.user_id !== currentUser.id && (
          <div className="flex items-center gap-2 text-xs text-orange-700 flex-1">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{conflictLog.user_name} is currently logging time</span>
          </div>
        )}

        {!conflictLog && (
          <>
            {isRunning && <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" /></span>}
            {isPaused && <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" /></span>}
            {!isRunning && !isPaused && <Clock className="h-4 w-4 text-blue-600 flex-shrink-0" />}
            <span className={`text-sm font-mono font-semibold ${
              isFinished ? 'text-green-700' : isRunning ? 'text-green-900' : isPaused ? 'text-amber-800' : 'text-blue-900'
            }`} title={formatTimeHuman(totalDisplaySeconds)}>
              {formatTime(totalDisplaySeconds)}
            </span>
            {totalDisplaySeconds > 0 && (
              <span className="text-[10px] text-muted-foreground font-medium">
                {formatTimeHuman(totalDisplaySeconds)}
              </span>
            )}

            {isFinished && (
              <span className="ml-1 text-xs font-semibold text-green-700 px-2 py-1 bg-green-100 rounded">
                Logged
              </span>
            )}
            
            <div className="flex items-center gap-1 ml-auto">
              {!isRunning && !isPaused && !isFinished && (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => handleStart()}
                    disabled={isSubmitting || !!conflictLog || currentTask?.is_locked || currentTask?.is_completed || isUnassigned}
                    className="gap-1"
                    title={
                      currentTask?.is_locked ? "This task is locked" :
                      currentTask?.is_completed ? "This task is completed" :
                      isUnassigned ? "Assign a person or team before starting" : ""
                    }
                  >
                    <Play className="h-3 w-3" /> Start
                  </Button>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={() => setShowManualEntry(true)} 
                    disabled={currentTask?.is_locked || currentTask?.is_completed || isUnassigned}
                    className="gap-1"
                    title={
                      currentTask?.is_locked ? "This task is locked" :
                      currentTask?.is_completed ? "This task is completed" :
                      isUnassigned ? "Assign a person or team before logging time" : "Manually log time"
                    }
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </>
              )}
              
              {isRunning && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePause}
                    disabled={isSubmitting}
                    className="gap-1"
                    title="Pause timer — time stops accumulating"
                  >
                    <Pause className="h-3 w-3" /> Pause
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleFinish}
                    disabled={isSubmitting}
                    className="gap-1"
                    title="Finish and save logged time"
                  >
                    <CheckCircle className="h-3 w-3" /> Finish
                  </Button>
                </>
              )}

              {isPaused && (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={handleResume}
                    className="gap-1"
                    disabled={isSubmitting || isUnassigned}
                    title={isUnassigned ? "Reassign task before resuming" : "Resume timer from where you left off"}
                  >
                    <Play className="h-3 w-3" /> Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleFinish}
                    disabled={isSubmitting}
                    className="gap-1"
                    title="Finish and save logged time"
                  >
                    <CheckCircle className="h-3 w-3" /> Finish
                  </Button>
                </>
              )}

              {isFinished && !currentTask?.is_locked && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowContinueConfirm(true)}
                  className="gap-1"
                  disabled={currentTask?.is_locked || isUnassigned}
                  title={isUnassigned ? "Reassign task before continuing" : "Start a new timer session (previous time is preserved)"}
                >
                  <Play className="h-3 w-3" /> Continue
                </Button>
              )}
              
              {totalDisplaySeconds > 0 && performanceScore && (
                <div className="ml-2 text-xs">
                  <span className={performanceScore >= 100 ? 'text-orange-600 font-semibold' : 'text-green-600 font-semibold'}>
                    {performanceScore}% eff.
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
         <DialogContent>
           <DialogTitle>Take Over This Task?</DialogTitle>
           <DialogDescription>
             This task is assigned to {preAssignedUser?.full_name}. Are you sure you want to take over and log time?
           </DialogDescription>
           <div className="flex gap-2 mt-4">
             <Button variant="outline" onClick={() => setShowConfirm(false)}>
               Cancel
             </Button>
             <Button onClick={startTimer} className="ml-auto">
               Take Over
             </Button>
             </div>
             </DialogContent>
             </Dialog>

             <Dialog open={showTakeoverConfirm} onOpenChange={setShowTakeoverConfirm}>
             <DialogContent>
             <DialogTitle>Take Over Team Task?</DialogTitle>
             <DialogDescription>
             This task is assigned to {currentTask?.assigned_to_team_name}. Are you sure you want to take over and reassign to yourself?
             </DialogDescription>
             <div className="flex gap-2 mt-4">
             <Button variant="outline" onClick={() => setShowTakeoverConfirm(false)}>
              Cancel
             </Button>
             <Button onClick={startTimer} className="ml-auto">
               Take Over
             </Button>
           </div>
         </DialogContent>
       </Dialog>

      <Dialog open={showContinueConfirm} onOpenChange={setShowContinueConfirm}>
        <DialogContent>
          <DialogTitle>Re-open This Task?</DialogTitle>
          <DialogDescription>
            Are you sure you want to re-open the task and continue logging time? Your previous effort of {formatTime(finishedSeconds)} will be preserved.
          </DialogDescription>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" onClick={() => setShowContinueConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={handleContinueConfirmed} className="ml-auto">
              Re-open Task
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showInactivityWarning} onOpenChange={setShowInactivityWarning}>
        <DialogContent>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-orange-600" />
            Timer Auto-Paused
          </DialogTitle>
          <DialogDescription>
            Your timer has been automatically paused due to 30 minutes of inactivity. Resume to continue, or finish to save your time.
          </DialogDescription>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" onClick={() => { recordActivity(); handleResume(); }}>
              Resume
            </Button>
            <Button variant="destructive" onClick={handleFinish} className="ml-auto">
              Finish Instead
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showConflict} onOpenChange={setShowConflict}>
        <DialogContent>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600" />
            Conflict Detected
          </DialogTitle>
          <DialogDescription>
            Another user has started logging time on this task. Your timer has been paused to prevent conflicts.
          </DialogDescription>
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setShowConflict(false)} className="ml-auto">
              Understood
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showConcurrentWarning} onOpenChange={setShowConcurrentWarning}>
        <DialogContent>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-500" />
            Timer Already Running
          </DialogTitle>
          <DialogDescription>
            You already have an active timer running on another task. Pause or finish that timer before starting a new one — concurrent timers produce inaccurate utilisation data.
          </DialogDescription>
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setShowConcurrentWarning(false)} className="ml-auto">
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ManualTimeEntryDialog 
        open={showManualEntry}
        onClose={() => setShowManualEntry(false)}
        task={task}
        project={project}
        user={currentUser}
        role={task.auto_assign_role || 'admin'}
      />
      </>
      );
      }