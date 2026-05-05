import { useState, useMemo } from "react";
import { useEntitiesData } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Camera, 
  Calendar, 
  DollarSign, 
  MapPin, 
  Clock,
  Filter,
  ChevronRight,
  Package
} from "lucide-react";
import { format, parseISO, isToday, isYesterday, isThisWeek, isThisMonth, isThisYear } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import ProjectStatusBadge from "@/components/dashboard/ProjectStatusBadge";

const statusColors = {
  inquiry: "bg-gray-100 border-gray-300",
  booked: "bg-blue-100 border-blue-300",
  scheduled: "bg-purple-100 border-purple-300",
  shooting: "bg-orange-100 border-orange-300",
  editing: "bg-yellow-100 border-yellow-300",
  review: "bg-cyan-100 border-cyan-300",
  delivered: "bg-green-100 border-green-300",
  completed: "bg-emerald-100 border-emerald-300"
};

function getDateLabel(date) {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  if (isThisWeek(date)) return format(date, "EEEE");
  if (isThisMonth(date)) return format(date, "MMMM d");
  if (isThisYear(date)) return format(date, "MMMM d");
  return format(date, "MMMM d, yyyy");
}

function TimelineItem({ project, isLast }) {
  const eventDate = project.shoot_date ? parseISO(project.shoot_date) : parseISO(project.created_date);
  const statusColor = statusColors[project.status] || "bg-gray-100 border-gray-300";

  return (
    <div className="relative flex gap-4 pb-8">
      {/* Timeline line */}
      {!isLast && (
        <div className="absolute left-4 top-8 bottom-0 w-px bg-border" />
      )}
      
      {/* Timeline dot */}
      <div className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 ${statusColor}`}>
        <Camera className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* Content */}
      <div className="flex-1 pt-0.5">
        <Link to={createPageUrl(`ProjectDetails?id=${project.id}`)}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-base mb-1 truncate" title={project.title}>{project.title}</h4>
                  <p className="text-sm text-muted-foreground flex items-center gap-1 mb-2">
                    <MapPin className="h-3 w-3" />
                    {project.property_address}
                  </p>
                </div>
                <ProjectStatusBadge status={project.status} />
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                {project.shoot_date && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    <span>{format(parseISO(project.shoot_date), "MMM d, yyyy")}</span>
                  </div>
                )}
                {project.shoot_time && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>{project.shoot_time}</span>
                  </div>
                )}
                {project.price && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <DollarSign className="h-4 w-4" />
                    <span className="tabular-nums">${project.price.toLocaleString()}</span>
                  </div>
                )}
                {project.services && project.services.length > 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Package className="h-4 w-4" />
                    <span>{project.services.length} services</span>
                  </div>
                )}
              </div>

              <div className="mt-3 pt-3 border-t flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Created {format(parseISO(project.created_date), "MMM d, yyyy")}
                </span>
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                  View Details
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}

function DateGroup({ date, projects }) {
  return (
    <div className="mb-6">
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur py-2 mb-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {getDateLabel(date)}
        </h3>
      </div>
      {projects.map((project, index) => (
        <TimelineItem 
          key={project.id} 
          project={project} 
          isLast={index === projects.length - 1}
        />
      ))}
    </div>
  );
}

export default function ContactTimeline({ entityType, entityId }) {
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: rtData, loading: isLoading } = useEntitiesData([
    { entityName: "Project", sortBy: "-created_date", limit: 500 },
    { entityName: "Agent" },
  ]);

  const allProjects = rtData?.Project || [];
  const agents = rtData?.Agent || [];

  const projects = useMemo(() => {
    if (!entityType || !entityId) return [];
    let filtered = allProjects;

    if (entityType === "agency") {
      filtered = allProjects.filter(p => p.agency_id === entityId);
    } else if (entityType === "agent") {
      filtered = allProjects.filter(p => p.agent_id === entityId);
    } else if (entityType === "team") {
      const teamAgentIds = new Set(agents.filter(a => a.current_team_id === entityId).map(a => a.id));
      filtered = allProjects.filter(p => teamAgentIds.has(p.agent_id));
    }

    if (statusFilter !== "all") filtered = filtered.filter(p => p.status === statusFilter);
    return filtered;
  }, [allProjects, agents, entityType, entityId, statusFilter]);

  // Group projects by date
  const groupedProjects = projects.reduce((groups, project) => {
    const date = project.shoot_date ? parseISO(project.shoot_date) : parseISO(project.created_date);
    const dateKey = format(date, "yyyy-MM-dd");
    
    if (!groups[dateKey]) {
      groups[dateKey] = {
        date,
        projects: []
      };
    }
    groups[dateKey].projects.push(project);
    return groups;
  }, {});

  const sortedGroups = Object.values(groupedProjects).sort((a, b) => b.date - a.date);

  if (!entityType || !entityId) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <Camera className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">Select an entity</h3>
          <p className="text-muted-foreground">
            Choose an agency, team, or agent to view their project timeline
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with filters */}
      <div className="flex items-center justify-between gap-4 pb-4 border-b">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Status Filter:</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="to_be_scheduled">To Be Scheduled</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="onsite">Onsite</SelectItem>
              <SelectItem value="uploaded">Uploaded</SelectItem>
              <SelectItem value="in_progress">Stills in Progress</SelectItem>
              <SelectItem value="in_production">Video in Progress</SelectItem>
              <SelectItem value="ready_for_partial">Partially Delivered</SelectItem>
              <SelectItem value="in_revision">In Revision</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Badge variant="secondary">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </Badge>
      </div>

      {/* Timeline */}
      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading timeline...</p>
          </div>
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Camera className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No projects found</h3>
            <p className="text-muted-foreground">
              {statusFilter !== "all" 
                ? "Try changing the status filter" 
                : "No projects have been created for this entity yet"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="pl-2">
          {sortedGroups.map(group => (
            <DateGroup 
              key={format(group.date, "yyyy-MM-dd")} 
              date={group.date} 
              projects={group.projects} 
            />
          ))}
        </div>
      )}
    </div>
  );
}