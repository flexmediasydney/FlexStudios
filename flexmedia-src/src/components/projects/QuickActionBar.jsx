import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Timer, StickyNote, ArrowRightLeft, Play, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { PROJECT_STAGES, stageLabel } from "@/components/projects/projectStatuses";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export default function QuickActionBar({
  project,
  canEdit,
  onStartTimer,
  onAddNote,
  onChangeStatus,
  onOpenChat,
  isMasterAdmin,
  isEmployee,
}) {
  const [statusOpen, setStatusOpen] = useState(false);

  if (!project) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Start Timer */}
      {canEdit && (
        <Button
          size="sm"
          variant="outline"
          onClick={onStartTimer}
          className="gap-1.5 h-8 text-xs font-medium border-green-200 text-green-700 hover:bg-green-50 hover:border-green-300 hover:text-green-800 transition-all"
        >
          <Play className="h-3.5 w-3.5" />
          Start Timer
        </Button>
      )}

      {/* Add Note */}
      <Button
        size="sm"
        variant="outline"
        onClick={onAddNote}
        className="gap-1.5 h-8 text-xs font-medium border-amber-200 text-amber-700 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-800 transition-all"
      >
        <StickyNote className="h-3.5 w-3.5" />
        Add Note
      </Button>

      {/* Change Status */}
      {canEdit && (
        <Popover open={statusOpen} onOpenChange={setStatusOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 text-xs font-medium border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-800 transition-all"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              Change Status
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1.5" align="start">
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-muted-foreground px-2 py-1.5">Move to stage:</p>
              {PROJECT_STAGES.map((stage) => (
                <button
                  key={stage.value}
                  onClick={() => {
                    onChangeStatus(stage.value);
                    setStatusOpen(false);
                  }}
                  disabled={stage.value === project.status}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm rounded-md transition-colors",
                    stage.value === project.status
                      ? "bg-primary/10 text-primary font-medium cursor-default"
                      : "hover:bg-muted text-foreground"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn(
                      "h-2 w-2 rounded-full flex-shrink-0",
                      stage.value === project.status ? "bg-primary" : "bg-muted-foreground/30"
                    )} />
                    {stage.label}
                  </span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Chat */}
      {onOpenChat && (
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenChat}
          className="gap-1.5 h-8 text-xs font-medium border-purple-200 text-purple-700 hover:bg-purple-50 hover:border-purple-300 hover:text-purple-800 transition-all"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </Button>
      )}

    </div>
  );
}
