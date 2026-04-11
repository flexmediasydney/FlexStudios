import React, { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, AlertTriangle, Info } from "lucide-react";

export default function HierarchyHealthCheck({ checks, agents, teams, agencies }) {
  const healthScore = useMemo(() => {
    const warningCount = checks.filter((c) => c.type === "warning").length;
    const infoCount = checks.filter((c) => c.type === "info").length;
    const score = Math.max(0, 100 - warningCount * 20 - infoCount * 5);
    return score;
  }, [checks]);

  const getHealthBadgeColor = (score) => {
    if (score >= 90) return "bg-green-100 text-green-800 border-green-300";
    if (score >= 70) return "bg-yellow-100 text-yellow-800 border-yellow-300";
    if (score >= 50) return "bg-orange-100 text-orange-800 border-orange-300";
    return "bg-red-100 text-red-800 border-red-300";
  };

  const getIconForType = (type) => {
    switch (type) {
      case "warning":
        return <AlertTriangle className="h-5 w-5 text-orange-600" />;
      case "error":
        return <AlertCircle className="h-5 w-5 text-red-600" />;
      case "info":
        return <Info className="h-5 w-5 text-blue-600" />;
      case "success":
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Health Score Card */}
      <div className={`${getHealthBadgeColor(healthScore)} border-2 rounded-lg p-6`}>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <h3 className="text-lg font-bold mb-1">Organizational Health</h3>
            <p className="text-sm opacity-90">Overall system integrity and data consistency</p>
          </div>
          <div className="flex flex-col items-center">
            <div className="text-xs uppercase tracking-wider opacity-75 mb-0.5">Score</div>
            <div className="text-4xl font-bold">{healthScore}<span className="text-lg">%</span></div>
            <div className="text-xs opacity-75 mt-1">
              {checks.filter((c) => c.type === "warning").length} warnings &middot; {checks.filter((c) => c.type === "info").length} notices
            </div>
          </div>
        </div>
      </div>

      {/* Issues List */}
      {checks.length === 0 ? (
        <Card className="bg-green-50 border-green-200">
          <CardContent className="pt-6 pb-6 text-center">
            <div className="flex justify-center mb-3">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <p className="font-semibold text-green-900">All Systems Operational</p>
            <p className="text-sm text-green-800 mt-1">Your organization hierarchy is healthy and well-structured</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {checks.map((check, idx) => (
            <Card key={idx} className={check.type === "warning" ? "border-l-4 border-l-orange-500" : "border-l-4 border-l-blue-500"}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1">
                    {getIconForType(check.type)}
                    <div className="flex-1">
                      <CardTitle className="text-sm">{check.title}</CardTitle>
                      <p className="text-xs text-muted-foreground mt-1">{check.message}</p>
                    </div>
                  </div>
                  <Badge variant={check.type === "warning" ? "destructive" : "secondary"}>{check.type}</Badge>
                </div>
              </CardHeader>
              {(check.agents?.length > 0 || check.teams?.length > 0 || check.agencies?.length > 0) && (
                <CardContent className="text-xs">
                  {check.agents?.length > 0 && (
                    <div className="mb-3">
                      <p className="font-semibold mb-2">Affected People:</p>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {check.agents.map((agent) => (
                          <div key={agent.id} className="p-2 bg-muted rounded">
                            <p className="font-medium truncate">{agent.name}</p>
                            <p className="text-muted-foreground">{agent.email}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {check.teams?.length > 0 && (
                    <div className="mb-3">
                      <p className="font-semibold mb-2">Affected Teams:</p>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {check.teams.map((team) => (
                          <div key={team.id} className="p-2 bg-muted rounded">
                            <p className="font-medium truncate">{team.name}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {check.agencies?.length > 0 && (
                    <div>
                      <p className="font-semibold mb-2">Affected Organisations:</p>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {check.agencies.map((agency) => (
                          <div key={agency.id} className="p-2 bg-muted rounded">
                            <p className="font-medium truncate">{agency.name}</p>
                            <p className="text-muted-foreground text-xs">{agency.relationship_state}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Data Integrity Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Data Integrity Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-green-50 rounded-lg border border-green-200">
              <p className="text-xs text-muted-foreground mb-1">Total Organisations</p>
              <p className="text-2xl font-bold text-green-900">{agencies.length}</p>
            </div>
            <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-xs text-muted-foreground mb-1">Total Teams</p>
              <p className="text-2xl font-bold text-blue-900">{teams.length}</p>
            </div>
            <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
              <p className="text-xs text-muted-foreground mb-1">Total People</p>
              <p className="text-2xl font-bold text-purple-900">{agents.length}</p>
            </div>
            <div className={`p-3 rounded-lg border ${checks.length === 0 ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
              <p className="text-xs text-muted-foreground mb-1">Data Issues</p>
              <p className={`text-2xl font-bold ${checks.length === 0 ? "text-green-900" : "text-red-900"}`}>{checks.length}</p>
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-semibold text-sm mb-3">Validation Checks</h4>
            <div className="space-y-2">
              {[
                { pass: !checks.some(c => c.title?.includes("Orphaned Agents")), label: "All agent references are valid" },
                { pass: !checks.some(c => c.title?.includes("Orphaned Teams")), label: "All team references are valid" },
                { pass: true, label: "No circular relationships detected" },
                { pass: checks.length === 0, label: "Data consistency verified" },
              ].map((v, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  {v.pass
                    ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                    : <AlertTriangle className="h-4 w-4 text-orange-500" />}
                  <span className={v.pass ? "" : "text-orange-700"}>{v.label}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recommendations */}
      {checks.length > 0 && (
        <Card className="bg-amber-50 border-amber-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {checks.some((c) => c.type === "warning" && c.agents?.length > 0) && (
              <p>• Review and reassign orphaned people to valid organisations</p>
            )}
            {checks.some((c) => c.type === "warning" && c.teams?.length > 0) && (
              <p>• Delete or reassign orphaned teams to valid organisations</p>
            )}
            {checks.some((c) => c.type === "info" && c.agencies?.length > 0) && (
              <p>• Consider removing empty organisations or assigning people/teams</p>
            )}
            <p>• Run regular health checks to maintain data integrity</p>
            <p>• Keep project type assignments up-to-date with agency capabilities</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}