/**
 * Validates and constrains task due dates to never exceed request due date.
 * Handles edge cases: no request due date, preset deadlines, and template-generated tasks.
 */

import { calculatePresetDeadline, APP_TIMEZONE } from './deadlinePresets';

/**
 * Calculate max allowed task due date based on request due date.
 * If request has no due_date, returns null (no constraint).
 * Otherwise returns the request due_date (tasks cannot exceed it).
 */
export function getMaxTaskDueDate(requestDueDate) {
  return requestDueDate || null; // null = no constraint
}

/**
 * Clamp a task due date to not exceed request constraint.
 * If request has no due_date, task is unconstrained.
 * Returns the adjusted due_date or null if no constraint.
 */
export function clampTaskDueDate(taskDueDate, maxAllowedDate) {
  if (!maxAllowedDate) return taskDueDate; // No constraint from request
  if (!taskDueDate) return null; // Task has no due date
  
  const taskTime = new Date(taskDueDate).getTime();
  const maxTime = new Date(maxAllowedDate).getTime();
  
  return taskTime > maxTime ? maxAllowedDate : taskDueDate;
}

/**
 * Validate a task's deadline settings against request due date.
 * Returns { isValid, message, constrainedDueDate }
 */
export function validateTaskDeadline(task, requestDueDate) {
  const result = {
    isValid: true,
    message: null,
    constrainedDueDate: task.due_date
  };

  // No request due date = no constraint
  if (!requestDueDate) {
    return result;
  }

  // Task has no due date = always valid
  if (!task.due_date) {
    return result;
  }

  const taskTime = new Date(task.due_date).getTime();
  const maxTime = new Date(requestDueDate).getTime();

  if (taskTime > maxTime) {
    result.isValid = false;
    result.message = `Task due date exceeds request due date (${new Date(requestDueDate).toLocaleString()})`;
    result.constrainedDueDate = requestDueDate;
  }

  return result;
}

/**
 * Calculate task due date from preset, respecting request constraint.
 * Edge case handling:
 * - "tonight" at 11:40pm → should use request due_date if set, otherwise "tonight" (20 min deadline)
 * - Template tasks that extend past request → clamp to request due_date
 */
export function calculateConstrainedTaskDeadline(
  taskTemplate,
  triggerTime,
  requestDueDate,
  timezone = APP_TIMEZONE
) {
  const result = {
    calculated: null,
    constrained: null,
    wasConstrained: false
  };

  // No deadline type or custom with 0 hours = no auto deadline
  if (!taskTemplate?.deadline_type || taskTemplate.deadline_type === 'custom' && !taskTemplate.deadline_hours_after_trigger) {
    return result;
  }

  let calculatedDueDate = null;

  // Preset deadline
  if (taskTemplate.deadline_type === 'preset' && taskTemplate.deadline_preset) {
    calculatedDueDate = calculatePresetDeadline(taskTemplate.deadline_preset, triggerTime, timezone);
  }
  // Custom hours offset
  else if (taskTemplate.deadline_type === 'custom' && taskTemplate.deadline_hours_after_trigger) {
    const trigger = new Date(triggerTime);
    calculatedDueDate = new Date(trigger.getTime() + taskTemplate.deadline_hours_after_trigger * 3600000);
  }

  result.calculated = calculatedDueDate;

  // Apply request constraint if present
  if (calculatedDueDate && requestDueDate) {
    const taskTime = calculatedDueDate.getTime();
    const maxTime = new Date(requestDueDate).getTime();
    
    if (taskTime > maxTime) {
      result.constrained = requestDueDate;
      result.wasConstrained = true;
    } else {
      result.constrained = calculatedDueDate;
    }
  } else {
    result.constrained = calculatedDueDate;
  }

  return result;
}

/**
 * Test edge case: request raised at 11:40pm with "tonight" deadline.
 * Result: deadline is calculated as 23:59 same day (20 min away).
 * If this exceeds request constraint, it gets clamped.
 */
export function testEdgeCase_TonightAt1140PM() {
  const now = new Date('2026-03-06T23:40:00+11:00'); // 11:40 PM Sydney time
  const requestDueDate = new Date('2026-03-07T00:30:00Z'); // 11:30 PM Sydney next day
  
  const taskTemplate = {
    deadline_type: 'preset',
    deadline_preset: 'tonight'
  };

  const result = calculateConstrainedTaskDeadline(
    taskTemplate,
    now,
    requestDueDate,
    APP_TIMEZONE
  );

  return {
    trigger: now.toISOString(),
    requestDue: requestDueDate.toISOString(),
    calculatedTaskDue: result.calculated?.toISOString(),
    constrainedTaskDue: result.constrained?.toISOString(),
    wasConstrained: result.wasConstrained,
    explanation: result.wasConstrained 
      ? "Task deadline 'tonight' was after request deadline, so clamped to request deadline"
      : "Task deadline 'tonight' fits within request deadline"
  };
}