import { useState, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fmtDate, fixTimestamp, todaySydney } from "@/components/utils/dateUtils";
import {
  Play, CheckCircle2, Circle, Pause, SkipForward, Clock, Zap, Target,
  RefreshCw, Gift, Users, ArrowRight, RotateCcw, Trash2, ChevronRight,
  Phone, Mail, MapPin, MessageCircle, Briefcase, Presentation, Instagram,
  Linkedin, Footprints, Home,
} from "lucide-react";

// ─── Sequence Templates ──────────────────────────────────────────────────────

const SEQUENCE_TEMPLATES = [
  {
    id: "new_agent",
    name: "New Agent Onboarding",
    description: "Structured first 60 days for a new prospect",
    icon: Users,
    color: "bg-blue-50 border-blue-200 text-blue-700",
    iconBg: "bg-blue-100",
    steps: [
      { day: 0, type: "Email", action: "Send intro email with portfolio" },
      { day: 3, type: "Phone Call Out", action: "Follow-up call to introduce yourself" },
      { day: 7, type: "Drop-In Visit", action: "Drop off printed portfolio at their office" },
      { day: 14, type: "Sales Meeting", action: "Coffee meeting to understand their needs" },
      { day: 30, type: "Phone Call Out", action: "Check-in call, ask about upcoming listings" },
      { day: 60, type: "Walk-In", action: "Quarterly office visit with updated materials" },
    ],
  },
  {
    id: "quarterly_nurture",
    name: "Quarterly Nurture",
    description: "Keep warm with quarterly multi-channel touches",
    icon: RefreshCw,
    color: "bg-emerald-50 border-emerald-200 text-emerald-700",
    iconBg: "bg-emerald-100",
    steps: [
      { day: 0, type: "Email", action: "Seasonal hello + recent work showcase" },
      { day: 14, type: "LinkedIn", action: "Engage with their latest listing post" },
      { day: 30, type: "Phone Call Out", action: "Quick check-in call" },
      { day: 60, type: "Gift / Swag", action: "Send branded item or coffee voucher" },
      { day: 75, type: "Drop-In Visit", action: "Pop into their office with treats" },
    ],
  },
  {
    id: "reactivation",
    name: "Dormant Reactivation",
    description: "Re-engage agents who have gone quiet",
    icon: RotateCcw,
    color: "bg-amber-50 border-amber-200 text-amber-700",
    iconBg: "bg-amber-100",
    steps: [
      { day: 0, type: "Email", action: "Gentle reconnection email with recent work" },
      { day: 5, type: "Phone Call Out", action: "Casual call to check in" },
      { day: 14, type: "Instagram", action: "Comment on their recent property posts" },
      { day: 21, type: "Walk-In", action: "Drop by with coffee and new pricing sheet" },
      { day: 35, type: "Sales Meeting", action: "Formal meeting to discuss partnership" },
    ],
  },
  {
    id: "high_value",
    name: "High Value Pursuit",
    description: "Intensive nurturing for enterprise prospects",
    icon: Target,
    color: "bg-purple-50 border-purple-200 text-purple-700",
    iconBg: "bg-purple-100",
    steps: [
      { day: 0, type: "Email", action: "Personalized intro with case study" },
      { day: 2, type: "LinkedIn", action: "Connect and engage with their content" },
      { day: 5, type: "Phone Call Out", action: "Introduction call" },
      { day: 10, type: "Gift / Swag", action: "Send premium branded gift box" },
      { day: 14, type: "Sales Meeting", action: "In-person portfolio presentation" },
      { day: 21, type: "Pitch Meeting", action: "Formal pitch with pricing proposal" },
      { day: 28, type: "Phone Call Out", action: "Follow-up on proposal" },
      { day: 35, type: "Walk-In", action: "Drop by to address any concerns" },
      { day: 45, type: "Discovery Call", action: "Deep-dive on their specific needs" },
      { day: 60, type: "Sales Meeting", action: "Close meeting" },
    ],
  },
];

// ─── Type-to-icon mapping ────────────────────────────────────────────────────

const TYPE_ICON_MAP = {
  Email: Mail,
  "Phone Call Out": Phone,
  "Drop-In Visit": Footprints,
  "Walk-In": Home,
  "Sales Meeting": Briefcase,
  "Pitch Meeting": Presentation,
  "Discovery Call": Phone,
  "Gift / Swag": Gift,
  LinkedIn: Linkedin,
  Instagram: Instagram,
};

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * NurturingSequences - Playbook-based multi-touch nurturing engine.
 *
 * Lets users enroll an agent into a structured outreach sequence,
 * then track progress through each step with visual feedback.
 *
 * Props:
 *   agentId          - UUID of the agent
 *   agentName        - display name
 *   onLogTouchpoint  - callback(agentId, prefilledTypeId?) to open QuickLogTouchpoint
 */
export default function NurturingSequences({ agentId, agentName, onLogTouchpoint }) {
  const { data: touchpointTypes = [] } = useEntityList("TouchpointType", "sort_order");
  const { data: allTouchpoints = [] } = useEntityList("Touchpoint", "-logged_at");
  const { data: user } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });

  const [enrolling, setEnrolling] = useState(null); // sequence id being enrolled
  const [removing, setRemoving] = useState(false);

  // ── Derive agent's sequence touchpoints ──────────────────────────────────

  const sequenceTouchpoints = useMemo(() => {
    if (!agentId) return [];
    return allTouchpoints.filter(
      (t) => t.agent_id === agentId && t.notes && t.notes.startsWith("Sequence:")
    );
  }, [allTouchpoints, agentId]);

  // Detect which sequence template is active (if any)
  const activeSequence = useMemo(() => {
    if (sequenceTouchpoints.length === 0) return null;

    for (const template of SEQUENCE_TEMPLATES) {
      const marker = `Sequence: ${template.name}`;
      const matchingTps = sequenceTouchpoints.filter((t) => t.notes && t.notes.startsWith(marker));
      if (matchingTps.length > 0) {
        return {
          template,
          touchpoints: matchingTps.sort((a, b) => {
            const da = a.follow_up_date || a.created_date;
            const db = b.follow_up_date || b.created_date;
            return new Date(fixTimestamp(da)) - new Date(fixTimestamp(db));
          }),
        };
      }
    }
    return null;
  }, [sequenceTouchpoints]);

  // ── Build step progress ────────────────────────────────────────────────────

  const stepProgress = useMemo(() => {
    if (!activeSequence) return [];

    const { template, touchpoints: seqTps } = activeSequence;
    return template.steps.map((step, idx) => {
      const stepMarker = `Step ${idx + 1}`;
      const matchingTp = seqTps.find((t) => t.notes && t.notes.includes(stepMarker));
      if (!matchingTp) {
        return { ...step, idx, status: "missing", tp: null };
      }
      const isCompleted = !matchingTp.is_planned || matchingTp.completed_at;
      const isSkipped = matchingTp.outcome === "skipped";
      const isPaused = matchingTp.outcome === "paused";
      return {
        ...step,
        idx,
        status: isSkipped ? "skipped" : isPaused ? "paused" : isCompleted ? "completed" : "pending",
        tp: matchingTp,
        dueDate: matchingTp.follow_up_date,
        completedAt: matchingTp.completed_at || matchingTp.logged_at,
      };
    });
  }, [activeSequence]);

  // Find the current (first non-completed, non-skipped) step
  const currentStepIdx = useMemo(() => {
    const idx = stepProgress.findIndex((s) => s.status === "pending" || s.status === "paused");
    return idx >= 0 ? idx : stepProgress.length; // all done if -1
  }, [stepProgress]);

  const allComplete = activeSequence && currentStepIdx >= stepProgress.length;
  const isPaused = stepProgress.some((s) => s.status === "paused");

  // ── Enroll handler ─────────────────────────────────────────────────────────

  const handleEnroll = async (template) => {
    if (enrolling) return;
    setEnrolling(template.id);

    try {
      const now = Date.now();
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const dueDate = new Date(now + step.day * 86400000).toISOString().slice(0, 10);
        const typeMatch = touchpointTypes.find(
          (t) => t.name === step.type || t.name.toLowerCase() === step.type.toLowerCase()
        );

        await api.entities.Touchpoint.create({
          agent_id: agentId,
          touchpoint_type_name: step.type,
          is_planned: true,
          follow_up_date: dueDate,
          follow_up_notes: step.action,
          notes: `Sequence: ${template.name} \u2014 Step ${i + 1}`,
          touchpoint_type_id: typeMatch?.id || null,
          logged_by: user?.id,
          logged_by_name: user?.full_name || user?.email,
          logged_at: new Date().toISOString(),
        });
      }

      await refetchEntityList("Touchpoint");
      toast.success(`Enrolled ${agentName || "agent"} in ${template.name}`);
    } catch (err) {
      toast.error(err?.message || "Failed to enroll in sequence");
    } finally {
      setEnrolling(null);
    }
  };

  // ── Log current step ───────────────────────────────────────────────────────

  const handleLogStep = (stepData) => {
    if (!onLogTouchpoint || !stepData.tp) return;
    // Call parent log handler with the agent pre-selected
    onLogTouchpoint(agentId);
  };

  // ── Complete step (mark planned touchpoint as done) ────────────────────────

  const handleCompleteStep = async (stepData) => {
    if (!stepData.tp) return;
    try {
      const now = new Date().toISOString();
      await api.entities.Touchpoint.update(stepData.tp.id, {
        is_planned: false,
        completed_at: now,
        logged_at: now,
        outcome: "positive",
      });
      await refetchEntityList("Touchpoint");
      toast.success(`Step ${stepData.idx + 1} completed`);
    } catch (err) {
      toast.error(err?.message || "Failed to complete step");
    }
  };

  // ── Skip step ──────────────────────────────────────────────────────────────

  const handleSkipStep = async (stepData) => {
    if (!stepData.tp) return;
    try {
      await api.entities.Touchpoint.update(stepData.tp.id, {
        is_planned: false,
        outcome: "skipped",
        notes: stepData.tp.notes + " (Skipped)",
      });
      await refetchEntityList("Touchpoint");
      toast.success(`Step ${stepData.idx + 1} skipped`);
    } catch (err) {
      toast.error(err?.message || "Failed to skip step");
    }
  };

  // ── Pause / Resume sequence ────────────────────────────────────────────────

  const handlePauseResume = async () => {
    if (!activeSequence) return;
    const pendingSteps = stepProgress.filter((s) => s.status === "pending" || s.status === "paused");
    if (pendingSteps.length === 0) return;

    try {
      for (const step of pendingSteps) {
        if (!step.tp) continue;
        await api.entities.Touchpoint.update(step.tp.id, {
          outcome: isPaused ? null : "paused",
        });
      }
      await refetchEntityList("Touchpoint");
      toast.success(isPaused ? "Sequence resumed" : "Sequence paused");
    } catch (err) {
      toast.error(err?.message || "Failed to pause/resume");
    }
  };

  // ── Remove sequence (delete all planned sequence touchpoints) ──────────────

  const handleRemoveSequence = async () => {
    if (!activeSequence || removing) return;
    setRemoving(true);

    try {
      const planned = activeSequence.touchpoints.filter(
        (t) => t.is_planned && !t.completed_at && t.outcome !== "skipped"
      );
      for (const tp of planned) {
        await api.entities.Touchpoint.delete(tp.id);
      }
      await refetchEntityList("Touchpoint");
      toast.success("Sequence removed");
    } catch (err) {
      toast.error(err?.message || "Failed to remove sequence");
    } finally {
      setRemoving(false);
    }
  };

  // ── Render: No active sequence → show template picker ──────────────────────

  if (!activeSequence) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Nurturing Sequences</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Enroll {agentName || "this agent"} in a structured outreach playbook
            </p>
          </div>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 gap-1">
            <Zap className="h-2.5 w-2.5" />
            Playbooks
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SEQUENCE_TEMPLATES.map((template) => {
            const Icon = template.icon;
            const isEnrolling = enrolling === template.id;
            return (
              <Card
                key={template.id}
                className={cn(
                  "border transition-all hover:shadow-md cursor-pointer",
                  template.color
                )}
              >
                <CardContent className="p-3.5 space-y-2.5">
                  <div className="flex items-start gap-2.5">
                    <div className={cn(
                      "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                      template.iconBg
                    )}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold leading-tight">{template.name}</p>
                      <p className="text-[10px] opacity-75 mt-0.5 leading-snug">
                        {template.description}
                      </p>
                    </div>
                  </div>

                  {/* Step preview */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {template.steps.map((step, i) => {
                      const StepIcon = TYPE_ICON_MAP[step.type] || Circle;
                      return (
                        <div key={i} className="flex items-center gap-0.5">
                          {i > 0 && (
                            <ChevronRight className="h-2.5 w-2.5 opacity-40 shrink-0" />
                          )}
                          <div
                            className="h-5 w-5 rounded-full bg-white/60 flex items-center justify-center"
                            title={`Day ${step.day}: ${step.action}`}
                          >
                            <StepIcon className="h-2.5 w-2.5" />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between pt-0.5">
                    <div className="flex items-center gap-2 text-[10px] opacity-70">
                      <span>{template.steps.length} steps</span>
                      <span className="opacity-40">|</span>
                      <span>{template.steps[template.steps.length - 1].day} days</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2.5 gap-1 bg-white/70 hover:bg-white"
                      onClick={() => handleEnroll(template)}
                      disabled={!!enrolling}
                    >
                      {isEnrolling ? (
                        <>
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          Enrolling...
                        </>
                      ) : (
                        <>
                          <Play className="h-2.5 w-2.5" />
                          Enroll
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Render: Active sequence → show progress tracker ────────────────────────

  const { template } = activeSequence;
  const TemplateIcon = template.icon;
  const completedCount = stepProgress.filter((s) => s.status === "completed").length;
  const skippedCount = stepProgress.filter((s) => s.status === "skipped").length;
  const progressPct = Math.round(
    ((completedCount + skippedCount) / stepProgress.length) * 100
  );

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center", template.iconBg)}>
            <TemplateIcon className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{template.name}</h3>
              {isPaused && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-amber-300 bg-amber-50 text-amber-700 whitespace-nowrap">
                  Paused
                </Badge>
              )}
              {allComplete && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-green-300 bg-green-50 text-green-700 whitespace-nowrap">
                  Complete
                </Badge>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {completedCount} of {stepProgress.length} steps complete
              {skippedCount > 0 && ` (${skippedCount} skipped)`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {!allComplete && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2 gap-1"
              onClick={handlePauseResume}
              title={isPaused ? "Resume all pending steps" : "Pause remaining steps"}
            >
              {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              {isPaused ? "Resume" : "Pause"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 gap-1 text-destructive hover:text-destructive"
            onClick={handleRemoveSequence}
            disabled={removing}
            title="Remove this sequence and delete unfinished steps"
          >
            <Trash2 className="h-3 w-3" />
            {removing ? "Removing..." : "Remove"}
          </Button>
        </div>
      </div>

      {/* ── Progress bar ── */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">Progress</span>
          <span className="text-[10px] font-semibold">{progressPct}%</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              allComplete ? "bg-green-500" : "bg-blue-500"
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* ── Step tracker ── */}
      <div className="space-y-1">
        {stepProgress.map((step, idx) => {
          const StepIcon = TYPE_ICON_MAP[step.type] || Circle;
          const isCurrent = idx === currentStepIdx;
          const isCompleted = step.status === "completed";
          const isSkipped = step.status === "skipped";
          const isPausedStep = step.status === "paused";
          const isFuture = idx > currentStepIdx && !isCompleted && !isSkipped;

          return (
            <div key={idx} className="flex items-start gap-3">
              {/* ── Timeline line + dot ── */}
              <div className="flex flex-col items-center shrink-0 pt-0.5">
                <div
                  className={cn(
                    "h-7 w-7 rounded-full flex items-center justify-center transition-all",
                    isCompleted && "bg-green-500 text-white shadow-sm",
                    isSkipped && "bg-gray-200 text-gray-500",
                    isCurrent && !isPausedStep && "bg-blue-500 text-white shadow-md ring-4 ring-blue-100 animate-pulse",
                    isPausedStep && "bg-amber-400 text-white shadow-sm ring-2 ring-amber-100",
                    isFuture && "bg-muted text-muted-foreground border border-border"
                  )}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : isSkipped ? (
                    <SkipForward className="h-3 w-3" />
                  ) : isPausedStep ? (
                    <Pause className="h-3 w-3" />
                  ) : (
                    <StepIcon className="h-3 w-3" />
                  )}
                </div>
                {/* Connector line */}
                {idx < stepProgress.length - 1 && (
                  <div className={cn(
                    "w-0.5 flex-1 min-h-[16px]",
                    isCompleted || isSkipped ? "bg-green-200" : "bg-border"
                  )} />
                )}
              </div>

              {/* ── Step content ── */}
              <div className={cn(
                "flex-1 pb-3 min-w-0",
                isFuture && "opacity-50"
              )}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={cn(
                      "text-xs font-medium truncate",
                      isCompleted && "line-through text-muted-foreground",
                      isSkipped && "line-through text-muted-foreground"
                    )}>
                      {step.action}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 h-4 shrink-0 whitespace-nowrap"
                    >
                      {step.type}
                    </Badge>
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                    Day {step.day}
                  </span>
                </div>

                {/* Date info */}
                <div className="flex items-center gap-2 mt-0.5">
                  {step.dueDate && (
                    <span className={cn(
                      "text-[10px]",
                      isCompleted ? "text-green-600" : "text-muted-foreground"
                    )}>
                      {isCompleted && step.completedAt
                        ? `Done ${fmtDate(step.completedAt, "d MMM")}`
                        : `Due ${fmtDate(step.dueDate, "d MMM")}`}
                    </span>
                  )}
                  {isSkipped && (
                    <span className="text-[10px] text-muted-foreground italic">Skipped</span>
                  )}
                </div>

                {/* Current step actions */}
                {isCurrent && !isPausedStep && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <Button
                      size="sm"
                      className="h-6 text-[10px] px-2.5 gap-1"
                      onClick={() => handleCompleteStep(step)}
                      title="Mark this step as done"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Mark Done
                    </Button>
                    {onLogTouchpoint && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] px-2.5 gap-1"
                        onClick={() => handleLogStep(step)}
                        title="Log a full touchpoint with details"
                      >
                        <Zap className="h-3 w-3" />
                        Log Full Touch
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] px-2 gap-1 text-muted-foreground"
                      onClick={() => handleSkipStep(step)}
                      title="Skip this step and move to the next one"
                    >
                      <SkipForward className="h-2.5 w-2.5" />
                      Skip
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Completion state ── */}
      {allComplete && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-center">
          <CheckCircle2 className="h-5 w-5 text-green-600 mx-auto mb-1" />
          <p className="text-xs font-medium text-green-800">Sequence Complete</p>
          <p className="text-[10px] text-green-600 mt-0.5">
            All steps have been completed or skipped. You can remove this sequence to enroll in a new one.
          </p>
        </div>
      )}
    </div>
  );
}
