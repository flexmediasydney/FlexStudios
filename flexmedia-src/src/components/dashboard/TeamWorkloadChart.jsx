import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

export default function TeamWorkloadChart({ tasks = [], users = [] }) {
  const workloadData = useMemo(() => {
    const userTaskCounts = {};

    // Count incomplete tasks per assigned user
    tasks.forEach(t => {
      if (t.is_completed || !t.assigned_to) return;
      if (!userTaskCounts[t.assigned_to]) {
        const user = users.find(u => u.id === t.assigned_to);
        userTaskCounts[t.assigned_to] = {
          id: t.assigned_to,
          name: t.assigned_to_name || user?.full_name || user?.email || "Unknown",
          open: 0,
          overdue: 0,
        };
      }
      userTaskCounts[t.assigned_to].open += 1;
      if (t.due_date && new Date(t.due_date) < new Date()) {
        userTaskCounts[t.assigned_to].overdue += 1;
      }
    });

    return Object.values(userTaskCounts)
      .sort((a, b) => b.open - a.open)
      .slice(0, 8);
  }, [tasks, users]);

  const maxTasks = Math.max(...workloadData.map(d => d.open), 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-violet-500" />
            Team Workload
          </CardTitle>
          {workloadData.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {workloadData.reduce((s, d) => s + d.open, 0)} tasks
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {workloadData.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No assigned tasks</p>
          </div>
        ) : (
          <div className="space-y-3">
            {workloadData.map(member => {
              const pct = Math.round((member.open / maxTasks) * 100);
              const overduePct = member.overdue > 0 ? Math.round((member.overdue / maxTasks) * 100) : 0;
              return (
                <div key={member.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium truncate max-w-[60%]">
                      {getFirstName(member.name)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {member.overdue > 0 && (
                        <span className="text-[10px] text-red-500 font-medium">{member.overdue} overdue</span>
                      )}
                      <span className="text-xs text-muted-foreground font-mono">{member.open}</span>
                    </div>
                  </div>
                  <div className="h-5 bg-muted/50 rounded-md overflow-hidden flex">
                    {member.overdue > 0 && (
                      <div
                        className="h-full bg-red-400 transition-all duration-500 rounded-l-md"
                        style={{ width: `${overduePct}%` }}
                      />
                    )}
                    <div
                      className="h-full bg-violet-400 transition-all duration-500"
                      style={{
                        width: `${pct - overduePct}%`,
                        borderRadius: member.overdue > 0 ? '0 6px 6px 0' : '6px',
                      }}
                    />
                  </div>
                </div>
              );
            })}
            <div className="flex items-center gap-4 pt-1 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-violet-400 inline-block" /> Open
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-red-400 inline-block" /> Overdue
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function getFirstName(name) {
  if (!name) return "Unknown";
  const parts = name.split(" ");
  if (parts.length <= 1) return name;
  return `${parts[0]} ${parts[1]?.[0] || ""}.`;
}
