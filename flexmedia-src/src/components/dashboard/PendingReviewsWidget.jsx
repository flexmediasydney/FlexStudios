import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eye, ArrowRight, Clock, AlertCircle } from "lucide-react";
import { format, differenceInHours } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function PendingReviewsWidget({ projects = [] }) {
  const navigate = useNavigate();

  const pendingReviews = useMemo(() => {
    const now = new Date();
    return projects
      .filter(p => p.status === "pending_review" || p.status === "review" || p.status === "client_review")
      .map(p => {
        const updatedAt = p.updated_date ? new Date(fixTimestamp(p.updated_date)) : null;
        const waitingHours = updatedAt ? differenceInHours(now, updatedAt) : 0;
        return {
          id: p.id,
          name: p.project_name || p.address || "Untitled Project",
          clientName: p.client_name || p.agency_name || "",
          status: p.status,
          waitingHours,
          updatedAt,
          isUrgent: waitingHours > 48,
        };
      })
      .sort((a, b) => b.waitingHours - a.waitingHours);
  }, [projects]);

  const urgentCount = pendingReviews.filter(p => p.isUrgent).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Eye className="h-4 w-4 text-amber-500" />
            Pending Reviews
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {urgentCount > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {urgentCount} overdue
              </Badge>
            )}
            {pendingReviews.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {pendingReviews.length}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {pendingReviews.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            <Eye className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No pending reviews</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pendingReviews.slice(0, 5).map(item => (
              <button
                key={item.id}
                onClick={() => navigate(createPageUrl("ProjectDetails") + `?id=${item.id}`)}
                className={`w-full flex items-start gap-3 p-2.5 rounded-lg border text-left transition-colors hover:bg-accent/50 ${
                  item.isUrgent ? "border-red-200 bg-red-50/30" : "border-border/50"
                }`}
              >
                <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                  item.isUrgent ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600"
                }`}>
                  {item.isUrgent ? <AlertCircle className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" title={item.name}>{item.name}</p>
                  <p className="text-xs text-muted-foreground truncate" title={item.clientName}>{item.clientName}</p>
                </div>
                <div className="text-right shrink-0">
                  <span className={`text-xs font-medium tabular-nums ${item.isUrgent ? "text-red-600" : "text-muted-foreground"}`}>
                    {formatWaiting(item.waitingHours)}
                  </span>
                  <p className="text-[10px] text-muted-foreground">waiting</p>
                </div>
              </button>
            ))}
            {pendingReviews.length > 5 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{pendingReviews.length - 5} more
              </p>
            )}
          </div>
        )}
        <Link to={createPageUrl("Projects") + "?status=pending_review"} className="block mt-3">
          <Button variant="ghost" size="sm" className="w-full text-xs gap-1" title="View all pending reviews">
            View All Reviews <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function formatWaiting(hours) {
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${Math.round(hours % 24)}h`;
}
