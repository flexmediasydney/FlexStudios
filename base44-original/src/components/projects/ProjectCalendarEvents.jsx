import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, MapPin, Link as LinkIcon } from "lucide-react";
import { format } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";

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
        <CardContent className="p-6">
          <div className="space-y-2">
            <div className="h-4 bg-muted rounded animate-pulse" />
            <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground text-sm">
          No calendar events linked to this project.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {events.map(event => {
        const startDate = new Date(fixTimestamp(event.start_time));
        const endDate = new Date(fixTimestamp(event.end_time));
        const isUpcoming = startDate > new Date();

        return (
          <Card key={event.id} className={isUpcoming ? "" : "opacity-60"}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-medium text-sm leading-tight pr-2">{event.title}</h3>
                {isUpcoming && (
                  <Badge variant="default" className="text-xs flex-shrink-0">Upcoming</Badge>
                )}
              </div>

              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 flex-shrink-0" />
                  <span>
                    {format(startDate, "MMM d, yyyy")}
                    {format(startDate, "yyyy-MM-dd") !== format(endDate, "yyyy-MM-dd") && (
                      <>
                        {" → "}
                        {format(endDate, "MMM d, yyyy")}
                      </>
                    )}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 flex-shrink-0" />
                  <span>
                    {format(startDate, "h:mm a")} - {format(endDate, "h:mm a")}
                  </span>
                </div>

                {event.location && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 flex-shrink-0" />
                    <span>{event.location}</span>
                  </div>
                )}

                {(event.event_source || event.calendar_account) && (
                  <div className="flex items-center gap-2 text-xs">
                    <LinkIcon className="h-3 w-3 flex-shrink-0" />
                    <span>
                      {event.event_source === 'tonomo' ? 'Tonomo booking'
                        : event.event_source === 'google' ? (event.calendar_account || 'Google Calendar')
                        : event.event_source === 'flexmedia' ? 'FlexMedia activity'
                        : event.calendar_account || 'Unknown source'}
                    </span>
                    {event.is_synced && (
                      <Badge variant="outline" className="text-xs ml-auto">Synced</Badge>
                    )}
                  </div>
                )}
              </div>

              {event.description && (
                <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
                  {event.description}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}