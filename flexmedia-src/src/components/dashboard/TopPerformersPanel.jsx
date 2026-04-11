import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Trophy, TrendingUp, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function TopPerformersPanel({ topAgencies, topAgents, topUsers }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-500" />
          Top Performers
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top Agencies */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Top Agencies
          </p>
          <div className="space-y-2">
            {topAgencies.slice(0, 3).map((agency, idx) => (
              <Link
                key={agency.id}
                to={createPageUrl("OrgDetails") + "?id=" + agency.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors group"
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  idx === 0 ? 'bg-amber-500 text-white' : idx === 1 ? 'bg-slate-400 text-white' : 'bg-orange-600 text-white'
                }`}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate group-hover:text-primary">
                    {agency.name}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    ${(agency.revenue / 1000).toFixed(1)}k • {agency.count} projects
                  </p>
                </div>
                <TrendingUp className="h-4 w-4 text-green-600 opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            ))}
          </div>
        </div>

        {/* Top Agents */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Top Agents
          </p>
          <div className="space-y-2">
            {topAgents.slice(0, 3).map((agent, idx) => (
              <Link
                key={agent.id}
                to={createPageUrl("PersonDetails") + "?id=" + agent.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors group"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs bg-primary/10 text-primary font-semibold">
                    {(agent.name || '?').split(' ').map(n => n[0]).join('').slice(0, 2) || '?'}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate group-hover:text-primary">
                    {agent.name}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    ${((agent.revenue || 0) / 1000).toFixed(1)}k • {agent.count || 0} projects
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Top Internal Team Members */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Top Team Members
          </p>
          <div className="space-y-2">
            {topUsers.slice(0, 3).map((user, idx) => (
              <div
                key={user.id}
                className="flex items-center gap-3 p-2 rounded-lg bg-muted/30"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs bg-blue-500/10 text-blue-600 font-semibold">
                    {(user.name || '?').split(' ').map(n => n[0]).join('').slice(0, 2) || '?'}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {user.name}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {user.completedTasks || 0} tasks • {((user.hoursLogged || 0) / 3600).toFixed(1)}h logged
                  </p>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {user.utilization}%
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}