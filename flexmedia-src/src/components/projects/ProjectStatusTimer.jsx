import React, { useState, useEffect, useCallback } from "react";
import { Clock } from "lucide-react";
import { useVisibleInterval } from "@/components/hooks/useVisibleInterval";

function ProjectStatusTimer({ lastStatusChange }) {
  const [timeText, setTimeText] = useState("");

  const updateTimer = useCallback(() => {
    if (!lastStatusChange) return;

    const now = new Date();
    const changeTime = new Date(lastStatusChange);
    const diffMs = now - changeTime;

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

    const pad = (num) => String(num).padStart(2, '0');

    if (days > 0) {
      setTimeText(`${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`);
    } else {
      setTimeText(`${pad(hours)}:${pad(minutes)}:${pad(seconds)}`);
    }
  }, [lastStatusChange]);

  // One-shot on mount / dep change so the initial value renders immediately.
  useEffect(() => { updateTimer(); }, [updateTimer]);

  // Live tick — paused when tab hidden.
  useVisibleInterval(updateTimer, 1000, { enabled: !!lastStatusChange });

  if (!timeText) return null;

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
      <Clock className="h-3 w-3" />
      {timeText}
    </div>
  );
}

export default React.memo(ProjectStatusTimer);