import React, { useState } from "react";
import { api } from "@/api/supabaseClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";

export default function AgentSearch({ onSelect }) {
  const [searchInput, setSearchInput] = useState("");
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async (value) => {
    setSearchInput(value);

    if (value.length < 2) {
      setResults([]);
      return;
    }

    setIsLoading(true);
    try {
      const agents = await api.entities.Agent.list();
      const filtered = agents
        .filter(
          (agent) =>
            agent.name.toLowerCase().includes(value.toLowerCase()) ||
            (agent.email && agent.email.toLowerCase().includes(value.toLowerCase()))
        )
        .slice(0, 10);
      setResults(filtered);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
        <Input
          placeholder="Search agents by name or email..."
          value={searchInput}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-10"
        />
        {isLoading && (
          <Loader2 className="absolute right-3 top-3 h-5 w-5 animate-spin text-slate-400" />
        )}
      </div>

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((agent) => (
            <Card
              key={agent.id}
              className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => onSelect(agent)}
            >
              <div className="font-medium text-slate-900">{agent.name}</div>
              <div className="text-sm text-slate-600">{agent.email}</div>
              {agent.current_agency_name && (
                <div className="text-xs text-slate-500">
                  {agent.current_agency_name}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {searchInput.length >= 2 && results.length === 0 && !isLoading && (
        <div className="text-center py-4 text-slate-500 text-sm">
          No agents found
        </div>
      )}
    </div>
  );
}