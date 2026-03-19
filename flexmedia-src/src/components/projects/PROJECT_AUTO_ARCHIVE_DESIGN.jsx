# Project Auto-Archive — Design & Impact Analysis

## CONCEPT

"Archived" is NOT a new pipeline stage. It's a lifecycle flag applied to projects whose entire journey is complete. The project stays `status: 'delivered'` — archive is a separate dimension.

**New fields on Project entity:**
- `is_archived` (boolean, default false)
- `archived_at` (datetime, null until archived)
- `archived_by` (string — 'auto' or user_id)

---

## ARCHIVE CRITERIA (ALL must be true)

| Condition | How to check |
|-----------|-------------|
| Status = delivered | `project.status === 'delivered'` |
| Payment = paid | `project.payment_status === 'paid'` |
| All tasks done | No ProjectTask with `project_id && !is_completed && !is_deleted` |
| No running timers | No TaskTimeLog with `project_id && is_active && status === 'running'` |
| All revisions closed | No ProjectRevision with `project_id && status NOT IN ('completed', 'cancelled')` |

**Deliberate omissions:**
- We do NOT check if media has been delivered (Dropbox status is external)
- We do NOT check outcome (won/lost) — delivered projects are always won
- We do NOT check email threads — open threads don't block archive

---

## TRIGGER POINTS — When to evaluate

| Trigger | Where | Why |
|---------|-------|-----|
| Payment marked as paid | ProjectDetails `updatePaymentMutation` | Most common final step |
| Last task completed | TaskManagement `updateMutation` | Tasks complete before payment |
| Status changed to delivered | ProjectDetails `updateStatusMutation` + `trackProjectStageChange` | Delivery is the prerequisite |
| Last revision completed/cancelled | ProjectRevisionsTab status change | Revisions can block archive |
| Timer stopped (last active timer) | TaskTimeLog update | Running timers block archive |

Each trigger calls `checkAndArchiveProject` which evaluates all 5 criteria. Only archives if ALL pass.

---

## IMPACT ANALYSIS — Every system affected

### 1. PROJECTS PAGE (src/pages/Projects.jsx)
**Impact:** Archived projects should be hidden by default but showable.
**Change:** Add `is_archived !== true` to the default filter. Add "Show archived" toggle that includes them with a visual indicator (faded card, "Archived" badge).
**Risk:** LOW — additive filter, no existing logic changes.

### 2. KANBAN BOARD (src/components/projects/KanbanBoard.jsx)
**Impact:** Archived projects must NOT appear in any Kanban column.
**Change:** Add `is_archived !== true` filter to the project list feeding the board.
**Risk:** LOW — Kanban already filters by active statuses.

### 3. DASHBOARD — Overview, Today, Pipeline, Needs Attention
**Impact:** Archived projects should be excluded from active counts and attention items, but included in revenue totals and historical analytics.
**Change:**
- Active project count: exclude archived
- Needs Attention: exclude archived (no point flagging a completed project)
- Revenue MTD/total: INCLUDE archived (delivered+paid = real revenue)
- Pipeline: exclude archived from current stage counts
- Today: exclude archived from shoots/deliveries due
**Risk:** MED — need to audit each dashboard component.

### 4. REVENUE INTELLIGENCE (RevenueIntelligence.jsx)
**Impact:** Archived projects ARE the revenue. They MUST be included.
**Change:** None — revenue calculations should count all delivered+paid projects regardless of archive state.
**Risk:** LOW — no change needed.

### 5. TERRITORY MAP (TerritoryMap.jsx)
**Impact:** Historical data. Archived projects SHOULD appear.
**Change:** None — territory shows all time history.
**Risk:** LOW — no change needed.

### 6. BUSINESS INTELLIGENCE (BusinessIntelligence.jsx)
**Impact:** Historical analytics. Archived projects SHOULD appear.
**Change:** None.
**Risk:** LOW.

### 7. EMPLOYEE UTILIZATION (EmployeeUtilization.jsx)
**Impact:** Historical effort data. Archived projects SHOULD be included.
**Change:** None — utilization already uses all TaskTimeLog data.
**Risk:** LOW.

### 8. CALENDAR (Calendar.jsx)
**Impact:** Past events for archived projects are historical. Future events shouldn't exist (project is done).
**Change:** None needed — calendar shows events by date, not project status.
**Risk:** LOW.

### 9. TONOMO PROCESSOR (processTonomoQueue.ts)
**Impact:** CRITICAL. If Tonomo sends a new appointment for an archived project (re-shoot, correction), the lifecycle reversal logic must UNARCHIVE it.
**Change:** In `handleScheduled` lifecycle reversal block, add `is_archived: false, archived_at: null` to the update.
**Risk:** MED — must not lose the archive state silently.

### 10. CLIENT/AGENT VIEWS (ClientAgents.jsx, OrgDetails.jsx, PersonDetails.jsx)
**Impact:** Agent's project history should show archived projects (they're completed work).
**Change:** None for history views. Active project counts should exclude archived.
**Risk:** LOW.

### 11. SEARCH (GlobalSearch.jsx)
**Impact:** Archived projects should be findable via search.
**Change:** None — search should return all matches.
**Risk:** LOW.

### 12. NOTIFICATIONS
**Impact:** Archive event should generate a notification.
**Change:** Fire `project_archived` notification to project owner when auto-archived.
**Risk:** LOW — additive.

### 13. ACTIVITY FEED
**Impact:** Archive event should appear in activity stream.
**Change:** Create ProjectActivity record with action `auto_archived`.
**Risk:** LOW — additive.

### 14. AUDIT LOG
**Impact:** Archive/unarchive should be logged.
**Change:** Write TonomoAuditLog (or TeamActivityFeed) entry.
**Risk:** LOW — additive.

### 15. STAGE TIMERS (trackProjectStageChange.ts)
**Impact:** The "delivered" stage timer is already stopped when status changes to delivered. Archive doesn't need to touch timers.
**Change:** None.
**Risk:** LOW.

### 16. PRICE MATRIX / PRODUCTS / PACKAGES
**Impact:** Archived projects' pricing data is historical. No changes needed.
**Change:** None.
**Risk:** LOW.

### 17. TASK DEADLINE DASHBOARD
**Impact:** Archived projects have no pending tasks. Exclude from deadline view.
**Change:** Filter `tasks where project is not archived` in TaskDeadlineDashboard.
**Risk:** LOW.

### 18. PROJECT DETAILS PAGE
**Impact:** Archived projects should be viewable but show an "Archived" banner and optionally an "Unarchive" button.
**Change:** Show banner when `is_archived === true`. Add manual unarchive button for admins.
**Risk:** LOW — additive UI only.

---

## UNARCHIVE TRIGGERS

| Trigger | Action |
|---------|--------|
| Tonomo lifecycle reversal | Auto-unarchive + move to pending_review |
| Manual admin unarchive button | Clear `is_archived`, `archived_at` |
| Payment status changed from paid to unpaid | Auto-unarchive |

---

## IMPLEMENTATION PLAN

### Phase 1: Entity schema update
Add `is_archived`, `archived_at`, `archived_by` to Project entity.

### Phase 2: Backend function
Create `functions/checkAndArchiveProject.ts` — evaluates all 5 criteria, sets `is_archived: true, archived_at: now, archived_by: 'auto'`, fires notification + activity log.

### Phase 3: Trigger wiring
In ProjectDetails.jsx — call `checkAndArchiveProject` after payment change, status change to delivered. In TaskManagement — call after task completion. In ProjectRevisionsTab — call after revision resolved.

### Phase 4: Tonomo unarchive
In processTonomoQueue.ts — add `is_archived: false` to lifecycle reversal updates.

### Phase 5: Frontend filtering
Projects page + KanbanBoard + Dashboard components — add `is_archived !== true` filter with toggle.

### Phase 6: UI polish
ProjectDetails archived banner, manual unarchive button, Projects page "Show archived" toggle with count.

---

## DEPLOYMENT SEQUENCE

1. Deploy entity schema (no breaking change — new fields default to false/null)
2. Deploy backend function
3. Deploy trigger wiring + Tonomo unarchive
4. Deploy frontend filters + UI
5. Optionally: run a one-time migration to auto-archive all projects meeting criteria

---

## ROLLBACK PLAN

If auto-archive causes issues:
1. Remove trigger calls (archive stops happening)
2. Archived projects remain viewable and functional
3. Manual unarchive button still works
4. No data loss — archive is reversible