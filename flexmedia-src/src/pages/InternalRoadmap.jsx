import { Map } from "lucide-react";

export default function InternalRoadmap() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Map className="h-7 w-7 text-blue-500" />
          Internal Roadmap
        </h1>
        <p className="text-muted-foreground mt-2">Product development roadmap and feature tracking.</p>
      </div>

      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center mb-5">
          <Map className="h-8 w-8 text-blue-500" />
        </div>
        <h2 className="text-lg font-semibold mb-1">Coming Soon</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Track features and milestones on an interactive roadmap board. This feature is under development.
        </p>
      </div>
    </div>
  );
}