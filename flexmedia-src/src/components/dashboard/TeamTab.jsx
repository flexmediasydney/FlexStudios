import React from "react";
import { useActiveTimers } from "@/components/utilization/ActiveTimersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Timer, Play } from "lucide-react";

const TeamCapacityDash = React.lazy(() => import("@/components/dashboard/TeamCapacityDash"));

function ActiveTimersStrip() {
  const { activeTimers } = useActiveTimers();
  const running = (activeTimers || []).filter(t => t.status === 'running');

  if (running.length === 0) return (
    <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">No active timers</CardContent></Card>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Timer className="h-4 w-4 text-primary" />
          Active Timers
          <Badge variant="secondary">{running.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {running.map(t => (
          <div key={t.id} className="flex items-center gap-3 p-2 rounded-lg bg-muted/50">
            <Play className="h-3.5 w-3.5 text-green-500 fill-green-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{t.user_name || 'Unknown'}</p>
              <p className="text-xs text-muted-foreground truncate">{t.task_title || t.task_id}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function TeamTab() {
  return (
    <div className="space-y-6">
      <ActiveTimersStrip />
      <React.Suspense fallback={<div className="h-96 flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
        <TeamCapacityDash />
      </React.Suspense>
    </div>
  );
}
