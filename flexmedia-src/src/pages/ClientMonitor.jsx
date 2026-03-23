import React, { useState, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Search, Plus, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import AgentSearch from "@/components/clientMonitor/AgentSearch";
import ExternalListingsForm from "@/components/clientMonitor/ExternalListingsForm";
import ListingComparison from "@/components/clientMonitor/ListingComparison";

export default function ClientMonitor() {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch projects for selected agent
  const { data: agentProjects = [], isLoading: projectsLoading } = useQuery({
    queryKey: ["agentProjects", selectedAgent?.id, refreshKey],
    queryFn: () =>
      selectedAgent
        ? api.entities.Project.filter({ agent_id: selectedAgent.id })
        : Promise.resolve([]),
    enabled: !!selectedAgent,
  });

  // Fetch external listings for selected agent
  const { data: externalListings = [] } = useQuery({
    queryKey: ["externalListings", selectedAgent?.id, refreshKey],
    queryFn: () =>
      selectedAgent
        ? api.entities.ExternalListing.filter({ agent_id: selectedAgent.id })
        : Promise.resolve([]),
    enabled: !!selectedAgent,
  });

  const handleListingAdded = () => {
    setShowForm(false);
    setRefreshKey(k => k + 1);
  };

  if (!selectedAgent) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
        <div className="max-w-2xl mx-auto">
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-slate-900 mb-2">Client Monitor</h1>
            <p className="text-slate-600">Cross-reference external listings with your internal projects</p>
          </div>

          <Card className="p-8 shadow-lg">
            <h2 className="text-xl font-semibold text-slate-900 mb-6">Select an Agent</h2>
            <AgentSearch onSelect={setSelectedAgent} />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">{selectedAgent.name}</h1>
              <p className="text-slate-600 text-sm">{selectedAgent.current_agency_name}</p>
            </div>
            <Button variant="outline" onClick={() => setSelectedAgent(null)}>
              Change Agent
            </Button>
          </div>

          {/* Portal Links */}
          <div className="flex gap-3 flex-wrap">
            {selectedAgent.domain_url ? (
              <a
                href={selectedAgent.domain_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                View on Domain
              </a>
            ) : (
              <span className="inline-flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-400 cursor-not-allowed">
                <ExternalLink className="h-4 w-4" />
                No Domain profile
              </span>
            )}
            {selectedAgent.rea_url ? (
              <a
                href={selectedAgent.rea_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                View on REA
              </a>
            ) : (
              <span className="inline-flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-400 cursor-not-allowed">
                <ExternalLink className="h-4 w-4" />
                No REA profile
              </span>
            )}
          </div>
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <Card className="p-4">
            <div className="text-sm text-slate-600 mb-1">Internal Projects</div>
            <div className="text-3xl font-bold text-slate-900">{agentProjects.length}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-slate-600 mb-1">External Listings</div>
            <div className="text-3xl font-bold text-slate-900">{externalListings.length}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-slate-600 mb-1">Matched</div>
            <div className="text-3xl font-bold text-slate-900">
              {externalListings.filter(e => e.matched_project_id).length}
            </div>
          </Card>
        </div>

        {/* Actions */}
        <div className="mb-8">
          <Button
            onClick={() => setShowForm(!showForm)}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            Add External Listing
          </Button>
        </div>

        {/* Form */}
        {showForm && (
          <Card className="p-6 mb-8">
            <ExternalListingsForm
              agent={selectedAgent}
              onSuccess={handleListingAdded}
              onCancel={() => setShowForm(false)}
            />
          </Card>
        )}

        {/* Comparison */}
        {projectsLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        ) : (
          <ListingComparison
            internalProjects={agentProjects}
            externalListings={externalListings}
            agent={selectedAgent}
            onRefresh={() => setRefreshKey(k => k + 1)}
          />
        )}
      </div>
    </div>
  );
}