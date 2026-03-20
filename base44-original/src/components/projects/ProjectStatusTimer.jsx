import { useState, useEffect } from "react";
import { Clock } from "lucide-react";

export default function ProjectStatusTimer({ lastStatusChange }) {
  const [timeText, setTimeText] = useState("");

  useEffect(() => {
    const updateTimer = () => {
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
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [lastStatusChange]);

  if (!timeText) return null;

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
      <Clock className="h-3 w-3" />
      {timeText}
    </div>
  );
}