import React, { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Network, TreePine, AlertCircle, TrendingUp } from "lucide-react";
import AdvancedHierarchyVisualization from "./AdvancedHierarchyVisualization";
import HierarchyStatistics from "./HierarchyStatistics";
import HierarchyHealthCheck from "./HierarchyHealthCheck";

export default function HierarchyVisualizationPanel({ agencies, teams, agents, projectTypes, products, packages }) {
  const [viewMode, setViewMode] = useState("hierarchy");
  const [selectedNode, setSelectedNode] = useState(null);

  // Analytics
  const stats = useMemo(() => {
    const totalAgents = agents.length;
    const totalTeams = teams.length;
    const avgAgentsPerTeam = totalTeams > 0 ? (totalAgents / totalTeams).toFixed(1) : 0;
    const agenciesWithProjects = new Set(agents.map((a) => a.current_agency_id)).size;
    const totalProjectTypes = projectTypes.filter((pt) => pt.is_active).length;
    const totalActiveProducts = products.filter((p) => p.is_active).length;
    const totalActivePackages = packages.filter((p) => p.is_active).length;

    return {
      agencies: agencies.length,
      teams: totalTeams,
      agents: totalAgents,
      avgAgentsPerTeam,
      agenciesWithAgents: agenciesWithProjects,
      projectTypes: totalProjectTypes,
      products: totalActiveProducts,
      packages: totalActivePackages,
    };
  }, [agencies, teams, agents, projectTypes, products, packages]);

  // Health checks
  const healthChecks = useMemo(() => {
    const checks = [];

    // Orphaned agents check
    const orphanedAgents = agents.filter((a) => !agencies.find((ag) => ag.id === a.current_agency_id));
    if (orphanedAgents.length > 0) {
      checks.push({
        type: "warning",
        title: "Orphaned Agents Detected",
        message: `${orphanedAgents.length} agent(s) reference non-existent agencies`,
        agents: orphanedAgents,
      });
    }

    // Orphaned teams check
    const orphanedTeams = teams.filter((t) => !agencies.find((a) => a.id === t.agency_id));
    if (orphanedTeams.length > 0) {
      checks.push({
        type: "warning",
        title: "Orphaned Teams Detected",
        message: `${orphanedTeams.length} team(s) reference non-existent agencies`,
        teams: orphanedTeams,
      });
    }

    // Empty agencies check
    const emptyAgencies = agencies.filter(
      (a) =>
        !agents.find((ag) => ag.current_agency_id === a.id) &&
        !teams.find((t) => t.agency_id === a.id)
    );
    if (emptyAgencies.length > 0) {
      checks.push({
        type: "info",
        title: "Empty Agencies",
        message: `${emptyAgencies.length} agency/agencies have no teams or agents`,
        agencies: emptyAgencies,
      });
    }

    // Unassigned project types
    const unassignedProjectTypes = projectTypes.filter(
      (pt) => !agencies.find((a) => (a.default_project_type_ids || []).includes(pt.id))
    );
    if (unassignedProjectTypes.length > 0) {
      checks.push({
        type: "info",
        title: "Unassigned Project Types",
        message: `${unassignedProjectTypes.length} project type(s) not assigned to any agency`,
      });
    }

    return checks;
  }, [agencies, teams, agents, projectTypes]);

  return (
    <div className="w-full space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Agencies</p>
            <p className="text-2xl font-bold text-blue-900">{stats.agencies}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 border-purple-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Teams</p>
            <p className="text-2xl font-bold text-purple-900">{stats.teams}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-green-50 to-green-100 border-green-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Agents</p>
            <p className="text-2xl font-bold text-green-900">{stats.agents}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-50 to-amber-100 border-amber-200" title="Average number of agents per team">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Avg per Team</p>
            <p className="text-2xl font-bold text-amber-900">{stats.avgAgentsPerTeam}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-pink-50 to-pink-100 border-pink-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Project Types</p>
            <p className="text-2xl font-bold text-pink-900">{stats.projectTypes}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-cyan-50 to-cyan-100 border-cyan-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Products</p>
            <p className="text-2xl font-bold text-cyan-900">{stats.products}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-indigo-50 to-indigo-100 border-indigo-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Packages</p>
            <p className="text-2xl font-bold text-indigo-900">{stats.packages}</p>
          </CardContent>
        </Card>
        <Card className={`bg-gradient-to-br ${healthChecks.length > 0 ? "from-red-50 to-red-100 border-red-200" : "from-gray-50 to-gray-100 border-gray-200"}`}>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">Health Issues</p>
            <p className={`text-2xl font-bold ${healthChecks.length > 0 ? "text-red-900" : "text-gray-900"}`}>
              {healthChecks.length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Visualization */}
      <Card className="border-2">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Network className="h-5 w-5" />
              Organizational Hierarchy
              <Badge variant="secondary" className="ml-1 text-xs font-normal">
                {stats.agencies + stats.teams + stats.agents} nodes
              </Badge>
            </CardTitle>
            <Tabs value={viewMode} onValueChange={setViewMode} className="w-auto">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="hierarchy" className="gap-1" title="View the organizational tree">
                  <TreePine className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Hierarchy</span>
                </TabsTrigger>
                <TabsTrigger value="stats" className="gap-1" title="View distribution and breakdown statistics">
                  <BarChart3 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Statistics</span>
                </TabsTrigger>
                <TabsTrigger value="health" className="gap-1" title={`Data health check${healthChecks.length > 0 ? ` (${healthChecks.length} issues)` : ''}`}>
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Health</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {viewMode === "hierarchy" && (
            <div className="w-full h-[600px] bg-muted/30 rounded-lg overflow-hidden border">
              <AdvancedHierarchyVisualization
                agencies={agencies}
                teams={teams}
                agents={agents}
                projectTypes={projectTypes}
                products={products}
                onNodeClick={setSelectedNode}
              />
            </div>
          )}
          {viewMode === "stats" && (
            <HierarchyStatistics agencies={agencies} teams={teams} agents={agents} projectTypes={projectTypes} products={products} packages={packages} />
          )}
          {viewMode === "health" && <HierarchyHealthCheck checks={healthChecks} agents={agents} teams={teams} agencies={agencies} />}
        </CardContent>
      </Card>

      {/* Selected Node Details */}
      {selectedNode && (
        <Card className="border-primary/50 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Selected: {selectedNode}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Click nodes in the hierarchy to view details</CardContent>
        </Card>
      )}
    </div>
  );
}