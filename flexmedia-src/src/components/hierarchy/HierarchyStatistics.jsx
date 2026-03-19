import React, { useMemo } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#06b6d4"];

export default function HierarchyStatistics({ agencies, teams, agents, projectTypes, products, packages }) {
  // Agency distribution
  const agencyDistribution = useMemo(() => {
    return agencies
      .map((a) => ({
        name: a.name,
        teams: teams.filter((t) => t.agency_id === a.id).length,
        agents: agents.filter((ag) => ag.current_agency_id === a.id).length,
      }))
      .sort((a, b) => b.agents - a.agents);
  }, [agencies, teams, agents]);

  // Team distribution
  const teamDistribution = useMemo(() => {
    return teams
      .map((t) => ({
        name: t.name,
        agents: agents.filter((a) => a.current_team_id === t.id).length,
      }))
      .sort((a, b) => b.agents - a.agents)
      .slice(0, 10);
  }, [teams, agents]);

  // Category distribution
  const categoryDistribution = useMemo(() => {
    const categories = {};
    products
      .filter((p) => p.is_active)
      .forEach((p) => {
        const cat = p.category || "other";
        categories[cat] = (categories[cat] || 0) + 1;
      });
    return Object.entries(categories).map(([name, value]) => ({ name, value }));
  }, [products]);

  // Project type adoption
  const projectTypeAdoption = useMemo(() => {
    return projectTypes
      .filter((pt) => pt.is_active)
      .map((pt) => ({
        name: pt.name,
        agencies: agencies.filter((a) => (a.default_project_type_ids || []).includes(pt.id)).length,
        products: products.filter((p) => (p.project_type_ids || []).includes(pt.id)).length,
      }));
  }, [projectTypes, agencies, products]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const totalAgents = agents.length;
    const agentsByTeam = teams.length > 0 ? totalAgents / teams.length : 0;
    const agentsByAgency = agencies.length > 0 ? totalAgents / agencies.length : 0;
    const activeProductCategories = new Set(products.filter((p) => p.is_active).map((p) => p.category)).size;

    return {
      avgAgentsPerTeam: agentsByTeam.toFixed(1),
      avgAgentsPerAgency: agentsByAgency.toFixed(1),
      productsPerCategory: (products.length / activeProductCategories || 1).toFixed(1),
      packagesPerType: packages.length > 0 ? (packages.length / projectTypes.length).toFixed(1) : 0,
    };
  }, [agents, teams, agencies, products, packages, projectTypes]);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground mb-1">Avg People/Team</p>
            <p className="text-2xl font-bold">{summaryStats.avgAgentsPerTeam}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground mb-1">Avg People/Organisation</p>
            <p className="text-2xl font-bold">{summaryStats.avgAgentsPerAgency}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground mb-1">Products/Category</p>
            <p className="text-2xl font-bold">{summaryStats.productsPerCategory}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground mb-1">Packages/Type</p>
            <p className="text-2xl font-bold">{summaryStats.packagesPerType}</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Grid */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Agency Distribution */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Agency Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={agencyDistribution}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="agents" fill="#3b82f6" name="People" />
                <Bar dataKey="teams" fill="#8b5cf6" name="Teams" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Product Category Distribution */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Product Categories</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={categoryDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name} (${value})`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {categoryDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Team Distribution */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Top Teams by People</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={teamDistribution} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={120} />
                <Tooltip />
                <Bar dataKey="agents" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Project Type Adoption */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Project Type Adoption</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={projectTypeAdoption}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="agencies" fill="#f59e0b" name="Organisations" />
                <Bar dataKey="products" fill="#ec4899" name="Products" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Agency Growth Projection */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Organization Composition</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm">Organisations</span>
                  <Badge variant="secondary">{agencies.length}</Badge>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full"
                    style={{ width: `${Math.min((agencies.length / 50) * 100, 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm">Teams</span>
                  <Badge variant="secondary">{teams.length}</Badge>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div className="bg-purple-500 h-2 rounded-full" style={{ width: `${Math.min((teams.length / 100) * 100, 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm">People</span>
                  <Badge variant="secondary">{agents.length}</Badge>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div className="bg-green-500 h-2 rounded-full" style={{ width: `${Math.min((agents.length / 500) * 100, 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm">Project Types</span>
                  <Badge variant="secondary">{projectTypes.filter((pt) => pt.is_active).length}</Badge>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-amber-500 h-2 rounded-full"
                    style={{ width: `${Math.min((projectTypes.filter((pt) => pt.is_active).length / 20) * 100, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Stats Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Quick Reference</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center p-2 bg-muted/50 rounded">
                <span className="text-sm">Total People</span>
                <span className="font-bold">{agents.length}</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-muted/50 rounded">
                <span className="text-sm">Organizational Units</span>
                <span className="font-bold">{agencies.length + teams.length}</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-muted/50 rounded">
                <span className="text-sm">Service Offerings</span>
                <span className="font-bold">{products.filter((p) => p.is_active).length}</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-muted/50 rounded">
                <span className="text-sm">Service Packages</span>
                <span className="font-bold">{packages.filter((p) => p.is_active).length}</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-muted/50 rounded">
                <span className="text-sm">Service Categories</span>
                <span className="font-bold">{new Set(products.filter((p) => p.is_active).map((p) => p.category)).size}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}