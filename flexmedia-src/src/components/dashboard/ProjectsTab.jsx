import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { BarChart3, Map } from "lucide-react";
import { cn } from "@/lib/utils";

const PipelineAnalyzer = React.lazy(() => import("@/components/dashboard/PipelineAnalyzer"));
const TerritoryMap = React.lazy(() => import("@/components/dashboard/TerritoryMap"));

export default function ProjectsTab() {
  const [view, setView] = useState("pipeline"); // pipeline | territory

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={view === "pipeline" ? "default" : "outline"} size="sm" onClick={() => setView("pipeline")}>
          <BarChart3 className="h-4 w-4 mr-1.5" /> Pipeline
        </Button>
        <Button variant={view === "territory" ? "default" : "outline"} size="sm" onClick={() => setView("territory")}>
          <Map className="h-4 w-4 mr-1.5" /> Territory
        </Button>
      </div>
      <React.Suspense fallback={<div className="h-96 flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
        {view === "pipeline" ? <PipelineAnalyzer /> : <TerritoryMap />}
      </React.Suspense>
    </div>
  );
}
