import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapPin, CalendarDays } from "lucide-react";
import { format, isToday, isTomorrow, isYesterday } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";

function relativeDayLabel(date) {
  if (isToday(date)) return "Today";
  if (isTomorrow(date)) return "Tomorrow";
  if (isYesterday(date)) return "Yesterday";
  return null;
}

export default function ProjectCalendarEvents({ projectId }) {
  const { data: events = [], loading: isLoading } = useEntityList(
    projectId ? "CalendarEvent" : null,
    "-start_time",
    50,
    projectId ? (e) => e.project_id === projectId : null
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" /> Calendar
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          <div className="h-10 bg-muted rounded animate-pulse" />
          <div className="h-10 bg-muted rounded animate-pulse w-2/3" />
        </CardContent>
      </Card>
    );
  }

  const validEvents = events
    .map((e) => {
      if (!e.start_time) return null;
      const startDate = new Date(fixTimestamp(e.start_time));
      if (isNaN(startDate.getTime())) return null;
      const endDate = e.end_time ? new Date(fixTimestamp(e.end_time)) : null;
      const hasValidEnd = endDate && !isNaN(endDate.getTime());
      return { event: e, startDate, endDate: hasValidEnd ? endDate : null };
    })
    .filter(Boolean);

  // Sort: upcoming first (soonest), then past (most recent first)
  const now = new Date();
  validEvents.sort((a, b) => {
    const aUp = a.startDate >= now;
    const bUp = b.startDate >= now;
    if (aUp && !bUp) return -1;
    if (!aUp && bUp) return 1;
    if (aUp && bUp) return a.startDate - b.startDate; // soonest first
    return b.startDate - a.startDate; // most recent past first
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5" /> Calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {validEvents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events linked.</p>
        ) : (
          validEvents.map(({ event, startDate, endDate }) => {
            const isUpcoming = startDate >= now;
            const sameDay = endDate && format(startDate, "yyyy-MM-dd") === format(endDate, "yyyy-MM-dd");
            const dayLabel = relativeDayLabel(startDate);
            const dayNum = format(startDate, "d");
            const monthShort = format(startDate, "MMM");
            const weekdayShort = format(startDate, "EEE");
            const timeStr = `${format(startDate, "h:mma").toLowerCase()}${endDate ? ` – ${format(endDate, "h:mma").toLowerCase()}` : ""}`;

            return (
              <div
                key={event.id}
                className={`flex gap-2.5 rounded-md border p-2 ${isUpcoming ? "bg-card" : "opacity-60"}`}
              >
                {/* Date block — big, bold, easy to scan */}
                <div className={`flex flex-col items-center justify-center rounded-md px-2 py-1 min-w-[44px] ${isUpcoming ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                  <span className="text-[9px] font-semibold uppercase tracking-wider leading-none">{monthShort}</span>
                  <span className="text-lg font-bold leading-tight tabular-nums">{dayNum}</span>
                  <span className="text-[9px] uppercase tracking-wider leading-none">{weekdayShort}</span>
                </div>

                {/* Right column — title, time, location */}
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                  <div className="flex items-center gap-1 flex-wrap">
                    {dayLabel && (
                      <Badge variant={isUpcoming ? "default" : "secondary"} className="text-[9px] px-1 py-0 h-4">
                        {dayLabel}
                      </Badge>
                    )}
                    {!sameDay && endDate && (
                      <span className="text-[10px] text-muted-foreground">
                        → {format(endDate, "MMM d")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-semibold tabular-nums leading-tight">{timeStr}</p>
                  {event.title && (
                    <p className="text-[11px] text-muted-foreground truncate leading-tight" title={event.title}>
                      {event.title}
                    </p>
                  )}
                  {event.location && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <MapPin className="h-2.5 w-2.5 flex-shrink-0" />
                      <span className="truncate" title={event.location}>{event.location}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
