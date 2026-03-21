import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { MapPin, User, Building2, DollarSign } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const statusColors = {
  inquiry: "bg-slate-100 text-slate-700",
  booked: "bg-blue-100 text-blue-700",
  scheduled: "bg-cyan-100 text-cyan-700",
  shooting: "bg-orange-100 text-orange-700",
  editing: "bg-purple-100 text-purple-700",
  review: "bg-indigo-100 text-indigo-700",
  delivered: "bg-green-100 text-green-700",
  completed: "bg-emerald-100 text-emerald-700"
};

const statusLabels = {
  inquiry: "Inquiry",
  booked: "Booked",
  scheduled: "Scheduled",
  shooting: "Shooting",
  editing: "Editing",
  review: "Review",
  delivered: "Delivered",
  completed: "Completed"
};

export default function ProjectHoverCard({ projectId, children }) {
  const { data: project, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.entities.Project.filter({ id: projectId }).then(results => results[0])
  });

  if (!project && !isLoading) {
    return children;
  }

  const calculateTotal = () => {
    let total = 0;
    if (project?.products) {
      project.products.forEach(p => {
        total += (p.quantity || 1) * (p.base_price || 0);
      });
    }
    if (project?.packages) {
      project.packages.forEach(pkg => {
        total += (pkg.quantity || 1) * (pkg.package_price || 0);
      });
    }
    return total;
  };

  const total = calculateTotal();
  const formattedTotal = new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD'
  }).format(total);

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-80 p-0 border-0 shadow-lg">
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-200">
            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">LINKED PROJECT</p>
          </div>

          {/* Content */}
          {isLoading ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : project ? (
            <div className="p-4 space-y-3">
              {/* Address */}
              <div className="flex gap-3">
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground leading-snug">
                    {project.property_address}
                  </p>
                </div>
              </div>

              {/* Price */}
              <div className="text-xl font-bold text-foreground">
                {formattedTotal}
              </div>

              {/* Agent/User */}
              {project.assigned_users?.[0] && (
                <div className="flex gap-3">
                  <User className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{project.assigned_users[0]}</p>
                  </div>
                </div>
              )}

              {/* Project Title */}
              <div className="flex gap-3">
                <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">{project.title}</p>
                </div>
              </div>

              {/* Status Badge */}
              <div className="pt-1">
                <Badge className={statusColors[project.status]}>
                  {statusLabels[project.status] || project.status}
                </Badge>
              </div>
            </div>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}