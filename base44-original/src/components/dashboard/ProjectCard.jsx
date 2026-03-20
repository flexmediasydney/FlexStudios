import { Card } from "@/components/ui/card";
import { MapPin, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import ProjectStatusBadge from "./ProjectStatusBadge";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { ProjectCardFields } from "@/components/projects/ProjectCardFields";
import { useCardFields } from "@/components/projects/useCardFields";

export default function ProjectCard({ project, products = [], packages = [], tasks = [], timeLogs = [] }) {
  const { canSeePricing } = usePermissions();
  const { enabledFields } = useCardFields();

  // Filter out price if no pricing access
  const visibleFields = canSeePricing
    ? enabledFields
    : enabledFields.filter(f => f !== "price");

  return (
    <Link to={createPageUrl("ProjectDetails") + `?id=${project.id}`}>
      <Card
        className="p-5 hover:shadow-xl hover:shadow-primary/10 transition-all duration-200 cursor-pointer group border-l-4 hover:border-l-primary hover:-translate-y-1 hover:scale-[1.02] active:scale-[0.98]"
        style={{ borderLeftColor: project.priority === "urgent" ? "rgb(239, 68, 68)" : "rgb(59, 130, 246)" }}
      >
        <div className="flex justify-between items-start mb-3 gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-base group-hover:text-primary transition-colors duration-200 line-clamp-1" title={project.title}>
              {project.title}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            {project.source === 'tonomo' && (
              <div className="relative group/auto">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center cursor-help ${
                  project.status === 'pending_review' 
                    ? 'bg-amber-100 text-amber-600' 
                    : 'bg-emerald-100 text-emerald-600'
                }`}>
                  <Zap className="w-3.5 h-3.5" />
                </div>
                <div className="absolute right-0 top-8 w-72 bg-gray-900 text-white text-xs rounded-lg p-3 shadow-xl z-50 hidden group-hover/auto:block">
                  <p className="font-semibold mb-1">⚡ Auto-imported from Tonomo</p>
                  {project.pending_review_reason && (
                    <p className="text-gray-300 mb-1">{project.pending_review_reason}</p>
                  )}
                  <p className="text-gray-400">
                    Confidence: <span className={
                      project.mapping_confidence === 'full' ? 'text-green-400' :
                      project.mapping_confidence === 'partial' ? 'text-amber-400' : 'text-red-400'
                    }>{project.mapping_confidence || 'unknown'}</span>
                  </p>
                  {project.tonomo_package && <p className="text-gray-400">Package: {project.tonomo_package}</p>}
                  {project.tonomo_invoice_amount && <p className="text-gray-400">Invoice: ${project.tonomo_invoice_amount}</p>}
                  <p className="text-blue-400 mt-1 cursor-pointer">View in Integration Dashboard →</p>
                </div>
              </div>
            )}
            <ProjectStatusBadge status={project.status} lastStatusChange={project.last_status_change} />
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-3">
          <MapPin className="h-3.5 w-3.5 flex-shrink-0 group-hover:text-primary transition-colors duration-200" />
          <span className="line-clamp-1" title={project.property_address}>{project.property_address}</span>
        </div>

        <ProjectCardFields
          project={project}
          enabledFields={visibleFields}
          products={products}
          packages={packages}
          tasks={tasks}
          timeLogs={timeLogs}
        />
      </Card>
    </Link>
  );
}