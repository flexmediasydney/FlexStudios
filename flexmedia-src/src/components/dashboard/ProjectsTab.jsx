import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { BarChart3, Map } from "lucide-react";
import { cn } from "@/lib/utils";

const PipelineAnalyzer = React.lazy(() => import("@/components/dashboard/PipelineAnalyzer"));
const TerritoryMap = React.lazy(() => import("@/components/dashboard/TerritoryMap"));

export default function ProjectsTab() {
  const [view, setView] = useState(() => localStorage.getItem('projectsTab_view') || 'pipeline');
  const changeView = (v) => { setView(v); localStorage.setItem('projectsTab_view', v); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={view === "pipeline" ? "default" : "outline"} size="sm" aria-pressed={view === "pipeline"} onClick={() => changeView("pipeline")}>
          <BarChart3 className="h-4 w-4 mr-1.5" /> Pipeline
        </Button>
        <Button variant={view === "territory" ? "default" : "outline"} size="sm" aria-pressed={view === "territory"} onClick={() => changeView("territory")}>
          <Map className="h-4 w-4 mr-1.5" /> Territory
        </Button>
      </div>
      <React.Suspense fallback={<div className="h-96 flex items-center justify-center" role="status" aria-label="Loading content"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /><span className="sr-only">Loading...</span></div>}>
        {view === "pipeline" ? <PipelineAnalyzer /> : <TerritoryMap />}
      </React.Suspense>
    </div>
  );
}
