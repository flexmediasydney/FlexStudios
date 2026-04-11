import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  StickyNote, ArrowRightLeft, Play, MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PROJECT_STAGES } from "@/components/projects/projectStatuses";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ------------------------------------------------------------------ */
/*  Keyboard shortcut helper                                          */
/* ------------------------------------------------------------------ */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const modKey = isMac ? "\u2318" : "Ctrl+";

const SHORTCUTS = {
  timer:  { key: "t", label: `${modKey}Shift+T` },
  note:   { key: "n", label: `${modKey}Shift+N` },
  status: { key: "s", label: `${modKey}Shift+S` },
};

/* ------------------------------------------------------------------ */
/*  ActionButton — small reusable wrapper with tooltip                */
/* ------------------------------------------------------------------ */
function ActionButton({ onClick, icon: Icon, label, shortcut, className, disabled }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          onClick={onClick}
          disabled={disabled}
          className={cn("gap-1.5 h-8 text-xs font-medium transition-all", className)}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
        {shortcut && (
          <kbd className="ml-2 inline-flex items-center rounded bg-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-mono">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/*  QuickActionBar                                                    */
/* ------------------------------------------------------------------ */
export default function QuickActionBar({
  project,
  canEdit,
  onStartTimer,
  onAddNote,
  onChangeStatus,
}) {
  const [statusOpen, setStatusOpen] = useState(false);

  /* ---- Keyboard shortcuts ---- */
  const handleKeyDown = useCallback(
    (e) => {
      // Require Ctrl/Cmd + Shift + key
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;

      const key = e.key.toLowerCase();
      if (key === SHORTCUTS.timer.key && canEdit && onStartTimer) {
        e.preventDefault();
        onStartTimer();
      } else if (key === SHORTCUTS.note.key && onAddNote) {
        e.preventDefault();
        onAddNote();
      } else if (key === SHORTCUTS.status.key && canEdit) {
        e.preventDefault();
        setStatusOpen((prev) => !prev);
      }
    },
    [canEdit, onStartTimer, onAddNote],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!project) return null;

  /* ---- Status popover (shared between desktop button and mobile menu) ---- */
  const statusPopover = canEdit ? (
    <Popover open={statusOpen} onOpenChange={setStatusOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 text-xs font-medium border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-800 transition-all"
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Change Status</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1.5" align="start">
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-muted-foreground px-2 py-1.5">
            Move to stage:
          </p>
          {PROJECT_STAGES.map((stage) => (
            <button
              key={stage.value}
              onClick={() => {
                onChangeStatus(stage.value);
                setStatusOpen(false);
              }}
              disabled={stage.value === project.status}
              className={cn(
                "w-full text-left px-3 py-2 text-sm rounded-md transition-all duration-150",
                stage.value === project.status
                  ? "bg-primary/10 text-primary font-medium cursor-default"
                  : "hover:bg-muted text-foreground hover:pl-4",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full flex-shrink-0",
                    stage.value === project.status
                      ? "bg-primary"
                      : "bg-muted-foreground/30",
                  )}
                />
                {stage.label}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  ) : null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1.5">

        {/* ===== Utility actions ===== */}
        {canEdit && (
          <ActionButton
            onClick={onStartTimer}
            icon={Play}
            label="Start Timer"
            shortcut={SHORTCUTS.timer.label}
            className="border-green-200 text-green-700 hover:bg-green-50 hover:border-green-300 hover:text-green-800"
          />
        )}

        <ActionButton
          onClick={onAddNote}
          icon={StickyNote}
          label="Add Note"
          shortcut={SHORTCUTS.note.label}
          className="border-amber-200 text-amber-700 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-800"
        />

        {/* Separator before status group */}
        {canEdit && (
          <div className="hidden sm:block h-5 w-px bg-border mx-1" aria-hidden="true" />
        )}

        {/* ===== Status actions (desktop) ===== */}
        {statusPopover && (
          <div className="hidden sm:flex items-center">
            {statusPopover}
          </div>
        )}

        {/* ===== Mobile overflow menu ===== */}
        <div className="sm:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Actions
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {canEdit && (
                <DropdownMenuItem onClick={onStartTimer}>
                  <Play className="mr-2 h-4 w-4 text-green-600" />
                  Start Timer
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onAddNote}>
                <StickyNote className="mr-2 h-4 w-4 text-amber-600" />
                Add Note
              </DropdownMenuItem>
              {canEdit && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Change Status
                  </DropdownMenuLabel>
                  {PROJECT_STAGES.map((stage) => (
                    <DropdownMenuItem
                      key={stage.value}
                      disabled={stage.value === project.status}
                      onClick={() => onChangeStatus(stage.value)}
                    >
                      <span
                        className={cn(
                          "mr-2 h-2 w-2 rounded-full flex-shrink-0",
                          stage.value === project.status
                            ? "bg-primary"
                            : "bg-muted-foreground/30",
                        )}
                      />
                      {stage.label}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

      </div>
    </TooltipProvider>
  );
}
