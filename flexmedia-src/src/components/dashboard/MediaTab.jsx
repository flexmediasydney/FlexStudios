import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Film, Package } from "lucide-react";

const LiveMediaFeed = React.lazy(() => import("@/components/dashboard/LiveMediaFeed"));
const DeliveryFeed = React.lazy(() => import("@/components/dashboard/DeliveryFeed"));

export default function MediaTab() {
  const [view, setView] = useState(() => localStorage.getItem('mediaTab_view') || 'files');
  const changeView = (v) => { setView(v); localStorage.setItem('mediaTab_view', v); };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={view === "files" ? "default" : "outline"} size="sm" aria-pressed={view === "files"} onClick={() => changeView("files")}>
          <Film className="h-4 w-4 mr-1.5" /> File Feed
        </Button>
        <Button variant={view === "deliveries" ? "default" : "outline"} size="sm" aria-pressed={view === "deliveries"} onClick={() => changeView("deliveries")}>
          <Package className="h-4 w-4 mr-1.5" /> Deliveries
        </Button>
      </div>
      <React.Suspense fallback={<div className="h-96 flex items-center justify-center" role="status" aria-label="Loading content"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /><span className="sr-only">Loading...</span></div>}>
        {view === "files" ? <LiveMediaFeed /> : <DeliveryFeed />}
      </React.Suspense>
    </div>
  );
}
