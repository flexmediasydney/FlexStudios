import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { BarChart3, TrendingUp } from "lucide-react";

const BusinessIntelDash = React.lazy(() => import("@/components/dashboard/BusinessIntelDash"));
const RevenueIntelligence = React.lazy(() => import("@/components/dashboard/RevenueIntelligence"));

export default function RevenueTab() {
  const [view, setView] = useState("overview");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={view === "overview" ? "default" : "outline"} size="sm" onClick={() => setView("overview")}>
          <BarChart3 className="h-4 w-4 mr-1.5" /> Overview
        </Button>
        <Button variant={view === "detail" ? "default" : "outline"} size="sm" onClick={() => setView("detail")}>
          <TrendingUp className="h-4 w-4 mr-1.5" /> Detail
        </Button>
      </div>
      <React.Suspense fallback={<div className="h-96 flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
        {view === "overview" ? <BusinessIntelDash /> : <RevenueIntelligence />}
      </React.Suspense>
    </div>
  );
}
