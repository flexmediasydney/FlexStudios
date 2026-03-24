import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, Clock, Camera, MapPin, ArrowRight } from "lucide-react";
import { format, isToday, parseISO, isBefore, isAfter } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function TodaysScheduleWidget({ projects = [], calendarEvents = [] }) {
  const schedule = useMemo(() => {
    const now = new Date();
    const items = [];

    // Shoots from projects with shoot_date today
    projects.forEach(p => {
      if (!p.shoot_date || p.status === "delivered") return;
      try {
        const shootDate = parseISO(p.shoot_date);
        if (isToday(shootDate)) {
          items.push({
            id: `project-${p.id}`,
            type: "shoot",
            title: p.project_name || p.address || "Untitled Shoot",
            time: p.shoot_time || null,
            location: p.address || p.suburb || null,
            status: p.status,
            projectId: p.id,
            sortTime: p.shoot_time ? parseTimeToMinutes(p.shoot_time) : 999,
          });
        }
      } catch { /* skip invalid dates */ }
    });

    // Calendar events for today
    calendarEvents.forEach(ev => {
      if (!ev.start_time) return;
      try {
        const startTime = new Date(fixTimestamp(ev.start_time));
        if (isToday(startTime)) {
          items.push({
            id: `event-${ev.id}`,
            type: ev.is_all_day ? "all_day" : "event",
            title: ev.title || ev.summary || "Untitled Event",
            time: ev.is_all_day ? "All day" : format(startTime, "h:mm a"),
            location: ev.location || null,
            status: isBefore(startTime, now) ? "past" : "upcoming",
            sortTime: ev.is_all_day ? -1 : startTime.getHours() * 60 + startTime.getMinutes(),
          });
        }
      } catch { /* skip */ }
    });

    items.sort((a, b) => a.sortTime - b.sortTime);
    return items;
  }, [projects, calendarEvents]);

  const upcomingCount = schedule.filter(s => s.status === "upcoming" || (s.type === "shoot" && s.status !== "delivered")).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4 text-blue-500" />
            Today's Schedule
          </CardTitle>
          {schedule.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {upcomingCount} upcoming
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {schedule.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            <Calendar className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No events scheduled for today</p>
          </div>
        ) : (
          <div className="space-y-2">
            {schedule.slice(0, 6).map(item => (
              <div
                key={item.id}
                className={`flex items-start gap-3 p-2.5 rounded-lg border transition-colors ${
                  item.status === "past" ? "bg-muted/30 border-transparent opacity-60" : "bg-background border-border/50 hover:border-border"
                }`}
              >
                <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  item.type === "shoot" ? "bg-orange-100 text-orange-600" :
                  item.type === "all_day" ? "bg-purple-100 text-purple-600" :
                  "bg-blue-100 text-blue-600"
                }`}>
                  {item.type === "shoot" ? <Camera className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.time && (
                      <span className="text-xs text-muted-foreground">{item.time}</span>
                    )}
                    {item.location && (
                      <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                        <MapPin className="h-3 w-3" />
                        {item.location}
                      </span>
                    )}
                  </div>
                </div>
                {item.type === "shoot" && (
                  <Badge variant="outline" className="text-[10px] shrink-0">Shoot</Badge>
                )}
              </div>
            ))}
            {schedule.length > 6 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{schedule.length - 6} more items
              </p>
            )}
          </div>
        )}
        <Link to={createPageUrl("Calendar")} className="block mt-3">
          <Button variant="ghost" size="sm" className="w-full text-xs gap-1">
            View Full Calendar <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 999;
  const parts = timeStr.match(/(\d+):(\d+)/);
  if (!parts) return 999;
  return parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
}
